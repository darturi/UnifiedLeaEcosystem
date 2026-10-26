"""Export persisted Lea state without credentials.

SQLite is exported logically, never as raw pages (which can retain deleted
secrets). Git history is exported through fast-export, never as opaque objects
or packfiles. Originals are read-only; only the final, sanitized ZIP is saved.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import gzip
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import tempfile
import tomllib
from urllib.parse import quote, quote_plus
from uuid import uuid4
import zipfile


REDACTED = "[REDACTED]"
SECRET_NAME = re.compile(
    r"(?:api|access|virtual)[_-]?key|authorization|authentication|(?:^|[_-])auth(?:$|[_-])|(?:access|refresh|auth|github)[_-]?token|"
    r"password|passwd|secret|credential|private[_-]?key|token$|^cookies?$|^set-cookie$", re.I)
TOKEN = re.compile(
    r"\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|"
    r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b")
ASSIGNMENT = re.compile(
    r'''(?im)(["']?[\w.-]*(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|github[_-]?token|password|passwd|secret|credential|private[_-]?key)[\w.-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)''')
AUTH_HEADER = re.compile(r"(?i)\b(Bearer|Basic)\s+([A-Za-z0-9_+/=.-]+)")
URL_AUTH = re.compile(r"(?i)(https?://)([^\s/@]+:[^\s/@]+)@")
PRIVATE_KEY = re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----", re.S)
SKIP_DIRS = {"node_modules", ".venv", ".lake", "__pycache__", ".pytest_cache", ".sv_scratch"}
SECRET_FILES = re.compile(r"(?i)(?:^\.env(?:\..*)?$|^lea\.env$|\.(?:key|pem|p12|pfx|token)$|^\.(?:github_token|gemini_key|netrc|npmrc)$|credential|secret)")
SQLITE_HEADER = b"SQLite format 3\0"


class Redactor:
    def __init__(self):
        self.secrets: set[str] = set()

    def remember(self, value):
        if isinstance(value, str) and value and value != REDACTED:
            self.secrets.add(value)
        elif isinstance(value, (dict, list)):
            for item in value.values() if isinstance(value, dict) else value:
                self.remember(item)
        elif isinstance(value, bytes):
            self.remember(value.decode("utf-8", errors="replace"))

    def discover(self, value):
        if isinstance(value, dict):
            for key, item in value.items():
                if SECRET_NAME.search(str(key)) and not str(key).endswith(("_name", "_from")):
                    self.remember(item)
                else:
                    self.discover(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                self.discover(item)
        elif isinstance(value, str):
            try:
                parsed = json.loads(value)
            except (ValueError, RecursionError):
                parsed = None
            if isinstance(parsed, (dict, list)):
                self.discover(parsed)
            decoded = base64_text(value)
            if decoded is not None:
                self.discover(decoded)
            for match in ASSIGNMENT.finditer(value):
                raw = match[2]
                try:
                    raw = json.loads(raw)
                except ValueError:
                    raw = raw.strip("\"'")
                self.remember(raw)
            for match in AUTH_HEADER.finditer(value):
                self.remember(match[2])
            for match in URL_AUTH.finditer(value):
                self.remember(match[2])
                self.remember(match[2].split(":", 1)[1])
            self.secrets.update(TOKEN.findall(value))
        elif isinstance(value, bytes):
            collect_binary(self, value)

    def text(self, value: str) -> str:
        value = PRIVATE_KEY.sub(REDACTED, value)
        value = ASSIGNMENT.sub(lambda m: m[1] + json.dumps(REDACTED), value)
        value = AUTH_HEADER.sub(lambda m: m[1] + " " + REDACTED, value)
        value = URL_AUTH.sub(lambda m: m[1] + REDACTED + "@", value)
        value = TOKEN.sub(REDACTED, value)
        variants = set()
        for secret in self.secrets:
            variants.update((secret, quote(secret, safe=""), quote_plus(secret),
                             json.dumps(secret)[1:-1], base64.b64encode(secret.encode()).decode()))
        for secret in sorted(variants, key=len, reverse=True):
            value = value.replace(secret, REDACTED)
        return value

    def value(self, value):
        if isinstance(value, dict):
            return {self.text(str(k)): REDACTED if SECRET_NAME.search(str(k))
                    and not str(k).endswith(("_name", "_from")) else self.value(v)
                    for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.value(v) for v in value]
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except (ValueError, RecursionError):
                parsed = None
            if isinstance(parsed, (dict, list)):
                return json.dumps(self.value(parsed), ensure_ascii=False)
            decoded = base64_text(value)
            if decoded is not None:
                return base64.b64encode(self.value(decoded).encode()).decode()
            return self.text(value)
        if isinstance(value, bytes):
            return {"$base64": base64.b64encode(self.binary(value)).decode()}
        return value

    def binary(self, raw: bytes, depth=0) -> bytes:
        # Uploaded DOCX/ZIP and compressed logs must be sanitized *inside* their
        # compression too. Recursion/size limits reject unsafe archive inputs.
        if depth > 8:
            raise ValueError("Nested archive exceeds sanitization depth")
        if raw.startswith(b"%PDF-"):
            records = list(pdf_records(raw))
            if any(self.affects(record) for record in records):
                return json.dumps({"format": "lea-redacted-pdf-v1", "objects": self.value(records)}, ensure_ascii=False).encode()
            return raw
        if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
            encoding = "utf-16-le" if raw.startswith(b"\xff\xfe") else "utf-16-be"
            return raw[:2] + self.text(raw[2:].decode(encoding)).encode(encoding)
        if raw.startswith(SQLITE_HEADER):
            with sqlite3.connect(":memory:") as conn:
                conn.deserialize(raw)
                return b"".join((json.dumps(self.value(row), ensure_ascii=False, default=str) + "\n").encode()
                                for row in connection_rows(conn))
        if raw.startswith(b"PK\x03\x04"):
            output = io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
                if sum(i.file_size for i in source.infolist()) > 256 * 1024 * 1024:
                    raise ValueError("Nested archive exceeds sanitization size")
                for info in source.infolist():
                    if info.flag_bits & 1:
                        raise ValueError("Encrypted archive cannot be sanitized")
                    if SECRET_FILES.search(Path(info.filename).name):
                        continue
                    original = source.read(info)
                    clean = self.binary(original, depth + 1)
                    target.writestr(export_name(self.text(info.filename), original, clean), clean)
            return output.getvalue()
        if raw.startswith(b"\x1f\x8b"):
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as source:
                expanded = source.read(256 * 1024 * 1024 + 1)
            if len(expanded) > 256 * 1024 * 1024:
                raise ValueError("Compressed file exceeds sanitization size")
            return gzip.compress(self.binary(expanded, depth + 1), mtime=0)
        # latin-1 is a lossless byte mapping: arbitrary uploaded files are kept,
        # and literal credentials in their metadata are scrubbed as well.
        try:
            text = raw.decode("utf-8")
        except UnicodeError:
            text = None
        if text is not None:
            return self.value(text).encode()
        for secret in self.secrets:
            raw = raw.replace(secret.encode(), REDACTED.encode())
        return self.text(raw.decode("latin-1")).encode("latin-1")

    def affects(self, value):
        if isinstance(value, dict):
            return any(SECRET_NAME.search(str(k)) or self.affects(v) for k, v in value.items())
        if isinstance(value, (list, tuple)):
            return any(self.affects(v) for v in value)
        if isinstance(value, str):
            return self.value(value) != value
        if isinstance(value, bytes):
            return self.binary(value) != value
        return False


def export_name(name, original, clean):
    if original.startswith(b"%PDF-") and not clean.startswith(b"%PDF-"):
        return name + ".redacted.json"
    return name


def pdf_records(raw):
    # pdfminer is already an application dependency. Inspect decoded streams
    # and metadata, including objects compressed with Flate/ASCII85 filters.
    # A credential-bearing PDF is exported as sanitized logical objects so no
    # original compressed stream can smuggle the credential into the archive.
    from pdfminer.pdfdocument import PDFDocument
    from pdfminer.pdfparser import PDFParser
    from pdfminer.pdftypes import PDFObjRef, PDFStream
    from pdfminer.psparser import PSLiteral, PSKeyword

    def record(value):
        if isinstance(value, PDFObjRef):
            return {"$ref": value.objid}
        if isinstance(value, PDFStream):
            data = value.get_data()
            if len(data) > 256 * 1024 * 1024:
                raise ValueError("PDF stream exceeds sanitization size")
            return {"attributes": record(value.attrs), "decoded_stream": data}
        if isinstance(value, (PSLiteral, PSKeyword)):
            return value.name.decode("latin-1") if isinstance(value.name, bytes) else value.name
        if isinstance(value, dict):
            return {str(k): record(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [record(v) for v in value]
        return value

    document = PDFDocument(PDFParser(io.BytesIO(raw)))
    seen = set()
    yield {"metadata": record(document.info)}
    for xref in document.xrefs:
        for identity in xref.get_objids():
            if identity not in seen:
                seen.add(identity)
                yield {"id": identity, "object": record(document.getobj(identity))}


def base64_text(value):
    if len(value) < 12 or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", value):
        return None
    try:
        text = base64.b64decode(value, validate=True).decode()
    except (ValueError, UnicodeError):
        return None
    return text if text and all(c.isprintable() or c.isspace() for c in text) else None


def dotenv_values(file):
    values = {}
    if not file.exists():
        return values
    for line in file.read_text().splitlines():
        key, separator, value = line.strip().partition("=")
        key, value = key.strip(), value.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        if value.startswith('"') and value.endswith('"'):
            try:
                value = json.loads(value)
            except ValueError:
                value = value[1:-1]
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1]
        values[key] = value
    return values


def database_rows(file: Path):
    # A single read transaction pins one consistent SQLite snapshot, including
    # committed WAL data. No raw database/journal/free pages enter the ZIP.
    with sqlite3.connect(file.resolve().as_uri() + "?mode=ro", uri=True) as conn:
        conn.execute("begin")
        yield from connection_rows(conn)


def connection_rows(conn):
    schema = conn.execute("select type,name,tbl_name,sql from sqlite_master where sql is not null order by name").fetchall()
    yield {"format": "lea-sqlite-export-v1", "schema": schema}
    for kind, name, _, _ in schema:
        if kind != "table":
            continue
        cursor = conn.execute('select * from "' + name.replace('"', '""') + '"')
        columns = [c[0] for c in cursor.description]
        for row in cursor:
            yield {"table": name, "row": dict(zip(columns, row))}


def git_export(repo: Path):
    # fast-export exposes historical blobs even after they were deleted or
    # packed. Recompute every data length after redaction to keep it importable.
    command = ["git", "-C", str(repo), "fast-export", "--all", "--signed-tags=strip", "--tag-of-filtered-object=drop"]
    with tempfile.TemporaryFile() as errors:
        with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors) as child:
            try:
                while line := child.stdout.readline():
                    if line.startswith(b"data "):
                        size = int(line[5:])
                        data = child.stdout.read(size)
                        if len(data) != size:
                            raise ValueError("Incomplete Git export")
                        yield True, data
                    else:
                        yield False, line
                if child.wait() != 0:
                    raise ValueError("Git history export failed")
            except BaseException:
                child.kill()
                child.wait()
                raise


def locations(root: Path, env):
    root = root.resolve()
    app = root / "apps/lea-standalone" if (root / "apps/lea-standalone/adapter").is_dir() else root
    resolve = lambda value, base=root: (base / value).resolve()
    config = resolve(env.get("LEA_CONFIG_FILE", str(app / "config/lea.local.toml")))
    try:
        settings = tomllib.loads(config.read_text()) if config.exists() else {}
    except tomllib.TOMLDecodeError:
        settings = {}
    prover = resolve(env.get("LEA_ROOT") or settings.get("lea_root") or str(app / "prover"), app)
    data = resolve(env.get("LEA_SHARED_DATA_DIR", str(app / "data")))
    sources = [("data", data), ("config", config.parent), ("workspace", prover / "workspace"),
               ("overleaf-state", root / "apps/overleaf-extension/.overleaf-lean-stub")]
    return data / "shutdown-archives", sources, config, root / ".env"


def inventory(sources, output):
    files, repos, omitted, credential_sources = [], [], [], []
    for label, source in sources:
        if not source.exists():
            continue
        for directory, dirs, names in os.walk(source, followlinks=False):
            directory = Path(directory)
            relative = Path(label) / directory.relative_to(source)
            if (directory / ".git").exists() and not (directory / ".git").is_symlink():
                repos.append((directory, relative))
            for name in list(dirs):
                entry = directory / name
                if entry.is_symlink() or name in SKIP_DIRS or name == ".git" or entry.resolve() == output.resolve():
                    dirs.remove(name)
            for name in names:
                entry = directory / name
                archive_name = (relative / name).as_posix()
                if entry.is_symlink() or not stat.S_ISREG(entry.stat().st_mode):
                    omitted.append((archive_name, "symlink or special file"))
                elif SECRET_FILES.search(name) or "credential-intake" in entry.parts:
                    credential_sources.append(entry)
                    omitted.append((archive_name, "credential file"))
                elif name == ".git" or name.endswith(("-wal", "-shm", "-journal", ".lock")):
                    omitted.append((archive_name, "credential or transient file"))
                else:
                    files.append((entry, archive_name))
    return files, repos, omitted, credential_sources


def is_database(file):
    with file.open("rb") as handle:
        return handle.read(16) == SQLITE_HEADER


def collect_binary(redactor, raw, depth=0):
    if depth > 8:
        raise ValueError("Nested archive exceeds sanitization depth")
    if raw.startswith(SQLITE_HEADER):
        with sqlite3.connect(":memory:") as conn:
            conn.deserialize(raw)
            for row in connection_rows(conn):
                redactor.discover(row)
    elif raw.startswith(b"%PDF-"):
        for row in pdf_records(raw):
            redactor.discover(row)
    elif raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        redactor.discover(raw.decode("utf-16"))
    elif raw.startswith(b"PK\x03\x04"):
        with zipfile.ZipFile(io.BytesIO(raw)) as source:
            if sum(i.file_size for i in source.infolist()) > 256 * 1024 * 1024:
                raise ValueError("Nested archive exceeds sanitization size")
            for info in source.infolist():
                collect_binary(redactor, source.read(info), depth + 1)
    elif raw.startswith(b"\x1f\x8b"):
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as source:
            expanded = source.read(256 * 1024 * 1024 + 1)
        if len(expanded) > 256 * 1024 * 1024:
            raise ValueError("Compressed file exceeds sanitization size")
        collect_binary(redactor, expanded, depth + 1)
    else:
        redactor.discover(raw.decode("utf-8", errors="replace"))


def collect_file(redactor, file):
    if is_database(file):
        for row in database_rows(file):
            redactor.discover(row)
        return
    if file.suffix.lower() == ".pdf":
        collect_binary(redactor, file.read_bytes())
        return
    try:
        text = file.read_text()
    except UnicodeError:
        collect_binary(redactor, file.read_bytes())
        return
    if file.suffix == ".toml":
        try:
            redactor.discover(tomllib.loads(text))
        except tomllib.TOMLDecodeError:
            pass  # still scan historical or incomplete TOML as text
    redactor.discover(text)


def create_snapshot(root: Path, *, env=None, reason="shutdown") -> Path:
    env = dict(os.environ if env is None else env)
    output, sources, config, dot_env = locations(root, env)
    files, repos, omitted, credential_sources = inventory(sources, output)
    redactor = Redactor()
    redactor.discover(env)
    root_settings = dotenv_values(dot_env)
    redactor.discover(root_settings)
    # Scan before writing anything: a secret found in a later settings record
    # also needs to be removed from an earlier transcript or historical blob.
    for file in dict.fromkeys([config, dot_env, *credential_sources, *(f for f, _ in files)]):
        if file.is_file():
            collect_file(redactor, file)
    for file in credential_sources:
        # A .token/.key file may consist solely of an unlabeled value. Never
        # export it, and also remove copies of that value from other records.
        if file.suffix in {".token", ".key"} or file.name in {".github_token", ".gemini_key"}:
            redactor.remember(file.read_text(errors="replace").strip())
    for repo, _ in repos:
        for _, raw in git_export(repo):
            collect_binary(redactor, raw)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    created = datetime.now(timezone.utc)
    identity = created.strftime("%Y-%m-%dT%H-%M-%S.%fZ") + "-" + uuid4().hex[:12]
    destination = output / f"lea-snapshot-{identity}.zip"
    fd, temporary = tempfile.mkstemp(prefix=".snapshot-", suffix=".partial", dir=output)
    os.close(fd)
    manifest = {"format_version": 1, "created_at": created.isoformat(), "reason": reason,
                "snapshot": "full", "files": [], "omitted": omitted,
                "notes": ["Credentials are redacted; originals are never changed.",
                          "SQLite files are logical JSONL exports, without deleted pages or journals.",
                          "Git history uses sanitized fast-export streams; caches and symlinks are excluded.",
                          "Credential-bearing PDFs use redacted decoded-object JSON exports.",
                          "Browser-only state is not accessible to the stack."]}
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for file, name in files:
                name = redactor.text(name)
                if is_database(file):
                    name += ".jsonl"
                    with archive.open(name, "w") as target:
                        for row in database_rows(file):
                            target.write((json.dumps(redactor.value(row), ensure_ascii=False, default=str) + "\n").encode())
                elif file.suffix == ".toml":
                    try:
                        data = tomllib.loads(file.read_text())
                    except tomllib.TOMLDecodeError:
                        archive.writestr(name, redactor.binary(file.read_bytes()))
                    else:
                        archive.writestr(name + ".json", json.dumps(redactor.value(data), default=str, indent=2))
                        name += ".json"
                else:
                    original = file.read_bytes()
                    clean = redactor.binary(original)
                    name = export_name(name, original, clean)
                    archive.writestr(name, clean)
                manifest["files"].append(name)
            for repo, relative in repos:
                name = redactor.text((relative / "history.fast-export").as_posix())
                with archive.open(name, "w") as target:
                    for is_data, raw in git_export(repo):
                        clean = redactor.binary(raw)
                        if is_data:
                            target.write(f"data {len(clean)}\n".encode())
                        target.write(clean)
                manifest["files"].append(name)
            runtime_settings = {k: env.get(k, v) for k, v in root_settings.items()}
            runtime_settings.update({k: v for k, v in env.items()
                if k.startswith(("LEA_", "OVERLEAF_", "PORTKEY_")) or k.endswith(("_BASE_URL", "_API_BASE"))})
            archive.writestr("runtime-settings.json", json.dumps(redactor.value(runtime_settings), indent=2))
            archive.writestr("manifest.json", json.dumps(redactor.value(manifest), indent=2))
        with open(temporary, "rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        return destination
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--reason", default="shutdown")
    args = parser.parse_args()
    try:
        destination = create_snapshot(args.root, reason=args.reason)
    except Exception as error:
        # Exceptions can contain credential-bearing filenames, SQL, or Git URLs.
        print(f"[snapshot] Export failed ({type(error).__name__}); no archive was published.", flush=True)
        return 1
    print(f"[snapshot] Saved {destination.name} in the data/shutdown-archives directory.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

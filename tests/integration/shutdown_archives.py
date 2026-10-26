"""Verify real Docker shutdowns using a locally available Lea runtime image.

No image build, provider request, real user data, or Lean compilation is needed.
Run: python tests/integration/shutdown_archives.py --image <local Lea image>
"""
import argparse
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
from uuid import uuid4
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def docker(*args, timeout=60):
    return subprocess.check_output(["docker", *args], text=True, timeout=timeout, stderr=subprocess.STDOUT).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="lea-shutdown-archives-") as temp:
        home = Path(temp)
        for name in ("data", "config", "proofs", "projects", "overleaf-state"):
            (home / name).mkdir()
        (home / "prepare-mathlib.sh").write_text('#!/bin/sh\necho "PREPARATION READY"\nsleep "${LEA_TEST_PREPARE_SLEEP:-0}"\n')
        (home / "prepare-mathlib.sh").chmod(0o755)
        (home / "config/lea.local.toml").write_text('openai_api_key = "fixture-docker-credential"\nmodel = "openai/test"\n')
        (home / "proofs/Proof.lean").write_text("theorem archived : True := by trivial\n")
        with sqlite3.connect(home / "data/lea-interface.sqlite3") as conn:
            conn.execute("create table snapshot_fixture(message text)")
            conn.execute("insert into snapshot_fixture values ('first run fixture-docker-credential')")
        mounts = []
        for source, target in (
            (home / "data", "/app/data"), (home / "config", "/app/config"),
            (home / "proofs", "/app/prover/workspace/proofs"),
            (home / "projects", "/app/prover/workspace/projects"),
            (home / "overleaf-state", "/app/apps/overleaf-extension/.overleaf-lean-stub"),
        ):
            mounts += ["-v", f"{source}:{target}"]
        for source, target in (
            (ROOT / "scripts", "/app/scripts"),
            (ROOT / "packages/lea-model-catalog", "/app/packages/lea-model-catalog"),
            (ROOT / "apps/lea-standalone/docker/entrypoint.sh", "/app/entrypoint.sh"),
            (home / "prepare-mathlib.sh", "/app/prepare-mathlib.sh"),
            (ROOT / "apps/lea-standalone/adapter/app", "/app/adapter/app"),
            (ROOT / "apps/lea-standalone/adapter/migrations", "/app/adapter/migrations"),
            (ROOT / "apps/lea-standalone/adapter/run_api.py", "/app/adapter/run_api.py"),
            (ROOT / "apps/lea-standalone/prover/lea", "/app/prover/lea"),
            (ROOT / "apps/overleaf-extension/companion", "/app/apps/overleaf-extension/companion"),
            (ROOT / "apps/overleaf-extension/shared", "/app/apps/overleaf-extension/shared"),
            (ROOT / "apps/overleaf-extension/extension", "/app/apps/overleaf-extension/extension"),
        ):
            mounts += ["-v", f"{source}:{target}:ro"]
        for attempt in range(3):
            container = "lea-shutdown-archive-test-" + uuid4().hex[:12]
            try:
                docker("run", "-d", "--init", "--network", "none", "--name", container,
                       *mounts, "-e", "LEA_SHARED_DATA_DIR=/app/data", "-e", "LEA_ROOT=/app/prover",
                       "-e", f"LEA_TEST_PREPARE_SLEEP={30 if attempt == 2 else 0}",
                       "-e", "LEA_MODEL_CATALOG_OFFLINE=true", "--entrypoint", "/bin/bash", args.image, "/app/entrypoint.sh")
                deadline = time.monotonic() + 40
                while True:
                    try:
                        if attempt == 2:
                            if "PREPARATION READY" in docker("logs", container):
                                break
                            time.sleep(.1)
                            assert time.monotonic() < deadline, 'Preparation did not start'
                            continue
                        docker("exec", container, "/app/adapter/.venv/bin/python", "-c",
                               "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/api/ready',timeout=1); "
                               "urllib.request.urlopen('http://127.0.0.1:31245/health',timeout=1)")
                        break
                    except subprocess.CalledProcessError:
                        if docker("inspect", "--format", "{{.State.Running}}", container) != "true":
                            raise AssertionError("Test stack exited before becoming ready")
                        if time.monotonic() >= deadline:
                            raise AssertionError("Test stack did not start")
                        time.sleep(.2)
                if attempt != 1:
                    docker("stop", "--time", "45", container)
                else:
                    docker("kill", "--signal", "SIGINT", container)
                assert docker("wait", container) == "0", docker("logs", container)
                archives = sorted((home / "data/shutdown-archives").glob("*.zip"))
                assert len(archives) == attempt + 1
                with zipfile.ZipFile(archives[-1]) as archive:
                    assert not any("shutdown-archives/" in name for name in archive.namelist())
                    data = b"\n".join(archive.read(name) for name in archive.namelist())
                    assert b"fixture-docker-credential" not in data
                    assert b"first run" in data and b"theorem archived" in data
                    assert json.loads(archive.read("manifest.json"))["reason"] == "docker"
                (home / "data/later.log").write_text("second run")
            except BaseException:
                print(docker("logs", container))
                raise
            finally:
                docker("rm", "-f", container)
        print("Docker SIGTERM, SIGINT, and stopping during preparation: three full archives, credentials removed, previous data retained.")


if __name__ == "__main__":
    main()

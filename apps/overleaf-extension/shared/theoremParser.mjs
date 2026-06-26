import { createHash } from "node:crypto";
import {
  isValidLeanIdentifier,
  parseTargetDocument as parseTargetDocumentCore,
  parseTargets as parseTargetsCore
} from "../extension/targetParserCore.mjs";

export { isValidLeanIdentifier };

export function normalizeTargetText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

export function hashTargetText(text) {
  return createHash("sha256").update(normalizeTargetText(text)).digest("hex");
}

export function inferLeanDeclarationName(text) {
  const source = String(text || "");
  const declaration = source.match(
    /(?:^|\n)\s*(?:theorem|lemma|def|abbrev|structure|class)\s+([A-Za-z_][A-Za-z0-9_]*)(?=\s|$|[:{(])/
  );
  if (declaration && isValidLeanIdentifier(declaration[1])) {
    return declaration[1];
  }

  const named = source.match(/(?:^|\n)\s*(?:Theorem|Definition|Declaration)\s+name\s*:\s*([^\n]+)/i);
  if (named) {
    const value = named[1].trim();
    return isValidLeanIdentifier(value) ? value : "";
  }

  return "";
}

export function parseTargetDocument(source) {
  const result = parseTargetDocumentCore(source);
  return {
    targets: result.targets.map(withSourceHash),
    diagnostics: result.diagnostics
  };
}

export function parseTargets(source) {
  return parseTargetsCore(source).map(withSourceHash);
}

function withSourceHash(target) {
  return {
    ...target,
    sourceHash: hashTargetText(target.targetText)
  };
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "models.json");
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));

export const DEFAULT_LEA_MODEL = catalog.default_model;
export const LEA_MODEL_FAMILIES = Object.freeze(
  catalog.families.map((family) => Object.freeze({
    id: family.id,
    label: family.label,
    envVars: family.env_vars,
    aliases: family.aliases || []
  }))
);
export const LEA_MODEL_OPTIONS = Object.freeze(
  catalog.models.map((model) => Object.freeze({ ...model }))
);
export const LEA_MODEL_BY_VALUE = new Map(LEA_MODEL_OPTIONS.map((model) => [model.value, model]));
export const LEA_MODEL_FAMILY_BY_ID = new Map(LEA_MODEL_FAMILIES.map((family) => [family.id, family]));
export const LEA_MODEL_FAMILY_ALIASES = new Map(
  LEA_MODEL_FAMILIES.flatMap((family) => (family.aliases || []).map((alias) => [alias, family.id]))
);

export function normalizeModelFamilyId(familyId) {
  const raw = String(familyId || "").trim();
  return LEA_MODEL_FAMILY_ALIASES.get(raw) || raw;
}

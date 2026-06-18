const DEFAULT_COMPANION_URL = "http://127.0.0.1:31245";
const DEFAULT_LEA_LATEX_CONTEXT_MODE = "off";
const MODEL_FAMILY_LABELS = {
  openai: "OpenAI",
  google: "Google AI",
  anthropic: "Anthropic"
};
const DEFAULT_LEA_MODEL = "o4-mini";
const DEFAULT_MODEL_OPTIONS = [
  { value: DEFAULT_LEA_MODEL, label: DEFAULT_LEA_MODEL, family: "openai" }
];

const form = document.querySelector("#settings-form");
const companionUrlInput = document.querySelector("#companion-url");
const leaRepoPathInput = document.querySelector("#lea-repo-path");
const leaApiBaseUrlInput = document.querySelector("#lea-api-base-url");
const leaModelInput = document.querySelector("#lea-model");
const leaMaxTurnsInput = document.querySelector("#lea-max-turns");
const leaLatexContextModeInput = document.querySelector("#lea-latex-context-mode");
const providerStatusList = document.querySelector("#provider-key-status");
const providerKeyInputs = {
  openai: document.querySelector("#openai-api-key"),
  google: document.querySelector("#gemini-api-key"),
  anthropic: document.querySelector("#anthropic-api-key")
};
const loadCompanionSettingsButton = document.querySelector("#load-companion-settings");
const statusEl = document.querySelector("#status");
let latestModelOptions = DEFAULT_MODEL_OPTIONS;
let latestProviderKeys = {};

chrome.storage.sync.get(
  {
    companionUrl: DEFAULT_COMPANION_URL,
    leaRepoPath: "",
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: DEFAULT_LEA_MODEL,
    leaMaxTurns: 20,
    leaLatexContextMode: DEFAULT_LEA_LATEX_CONTEXT_MODE
  },
  (settings) => {
    companionUrlInput.value = settings.companionUrl;
    leaRepoPathInput.value = settings.leaRepoPath;
    leaApiBaseUrlInput.value = settings.leaApiBaseUrl;
    renderModelOptions(DEFAULT_MODEL_OPTIONS, settings.leaModel || DEFAULT_LEA_MODEL, latestProviderKeys);
    renderProviderKeyStatus(latestProviderKeys);
    leaMaxTurnsInput.value = settings.leaMaxTurns;
    // LaTeX context is locked to "off" until the feature is implemented.
    leaLatexContextModeInput.value = DEFAULT_LEA_LATEX_CONTEXT_MODE;
    loadCompanionSettings({ silent: true });
  }
);

loadCompanionSettingsButton.addEventListener("click", () => {
  loadCompanionSettings({ silent: false });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusEl.textContent = "Validating Lea settings...";

  const companionUrl = companionUrlInput.value.trim().replace(/\/+$/, "");
  const leaRepoPath = leaRepoPathInput.value.trim();
  const leaApiBaseUrl = leaApiBaseUrlInput.value.trim().replace(/\/+$/, "");
  const leaModel = leaModelInput.value.trim() || DEFAULT_LEA_MODEL;
  const leaMaxTurns = Number.parseInt(leaMaxTurnsInput.value, 10) || 20;
  // LaTeX context is locked to "off" until the feature is implemented; never send
  // active_file regardless of any stored value.
  const leaLatexContextMode = DEFAULT_LEA_LATEX_CONTEXT_MODE;
  const leaProviderApiKeys = collectProviderApiKeyPatch();
  try {
    const leaResponse = await fetch(`${companionUrl}/settings/lea`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leaRepoPath,
        leaApiBaseUrl,
        leaModel,
        leaMaxTurns,
        leaLatexContextMode,
        leaProviderApiKeys
      })
    });
    const leaPayload = await leaResponse.json().catch(() => ({}));
    if (!leaResponse.ok) {
      throw new Error(leaPayload.message || `Companion returned HTTP ${leaResponse.status}.`);
    }

    await chrome.storage.sync.set({
      companionUrl,
      leaRepoPath: leaPayload.leaRepoPath,
      leaApiBaseUrl: leaPayload.leaApiBaseUrl,
      leaModel: leaPayload.leaModel,
      leaMaxTurns: leaPayload.leaMaxTurns,
      leaLatexContextMode: leaPayload.leaLatexContextMode
    });
    latestProviderKeys = leaPayload.leaProviderKeys || latestProviderKeys;
    renderProviderKeyStatus(latestProviderKeys);
    clearProviderKeyInputs();
    statusEl.textContent = "Settings saved.";
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : String(error);
  }
});

async function loadCompanionSettings({ silent }) {
  const companionUrl = companionUrlInput.value.trim().replace(/\/+$/, "") || DEFAULT_COMPANION_URL;

  try {
    const response = await fetch(`${companionUrl}/settings`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }

    companionUrlInput.value = companionUrl;
    leaRepoPathInput.value = payload.leaRepoPath || leaRepoPathInput.value;
    leaApiBaseUrlInput.value = payload.leaApiBaseUrl || leaApiBaseUrlInput.value || "http://127.0.0.1:8000";
    latestModelOptions = payload.leaModelOptions || DEFAULT_MODEL_OPTIONS;
    latestProviderKeys = payload.leaProviderKeys || {};
    renderProviderKeyStatus(latestProviderKeys);
    renderModelOptions(latestModelOptions, payload.leaModel || leaModelInput.value || DEFAULT_LEA_MODEL, latestProviderKeys);
    leaMaxTurnsInput.value = payload.leaMaxTurns || leaMaxTurnsInput.value || 20;
    // LaTeX context stays locked to "off" regardless of what the companion reports.
    leaLatexContextModeInput.value = DEFAULT_LEA_LATEX_CONTEXT_MODE;

    await chrome.storage.sync.set({
      companionUrl,
      leaRepoPath: leaRepoPathInput.value,
      leaApiBaseUrl: leaApiBaseUrlInput.value,
      leaModel: leaModelInput.value,
      leaMaxTurns: Number.parseInt(leaMaxTurnsInput.value, 10) || 20,
      leaLatexContextMode: leaLatexContextModeInput.value || DEFAULT_LEA_LATEX_CONTEXT_MODE
    });

    if (!silent) {
      statusEl.textContent = "Loaded settings from companion.";
    }
  } catch (error) {
    if (!silent) {
      statusEl.textContent = error instanceof Error ? error.message : String(error);
    }
  }
}

for (const input of Object.values(providerKeyInputs)) {
  input.addEventListener("input", () => {
    renderModelOptions(latestModelOptions, leaModelInput.value || DEFAULT_LEA_MODEL, getEffectiveProviderKeyStatus());
  });
}

function renderModelOptions(options, selectedModel, providerKeys = {}) {
  leaModelInput.replaceChildren();
  const byFamily = new Map();
  for (const model of options) {
    const family = normalizeFamily(model.family || "openai");
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(model);
  }
  for (const [family, models] of byFamily) {
    const group = document.createElement("optgroup");
    group.label = MODEL_FAMILY_LABELS[family] || family;
    const familyConfigured = Boolean(providerKeys[family]?.configured);
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.value || model.id;
      option.textContent = model.tag ? `${model.label} - ${model.tag}` : model.label;
      option.disabled = !familyConfigured && option.value !== selectedModel;
      group.appendChild(option);
    }
    leaModelInput.appendChild(group);
  }
  leaModelInput.value = [...leaModelInput.options].some((option) => option.value === selectedModel)
    ? selectedModel
    : DEFAULT_LEA_MODEL;
}

function getEffectiveProviderKeyStatus() {
  const status = { ...latestProviderKeys };
  for (const [family, input] of Object.entries(providerKeyInputs)) {
    if (!input.value.trim()) continue;
    status[family] = {
      ...(status[family] || {}),
      configured: true
    };
  }
  return status;
}

function collectProviderApiKeyPatch() {
  const patch = {};
  for (const [family, input] of Object.entries(providerKeyInputs)) {
    const value = input.value.trim();
    if (value) patch[family] = value;
  }
  return patch;
}

function normalizeFamily(family) {
  return family === "gemini" ? "google" : family;
}

function clearProviderKeyInputs() {
  for (const input of Object.values(providerKeyInputs)) {
    input.value = "";
  }
}

function renderProviderKeyStatus(providerKeys = {}) {
  if (!providerStatusList) return;
  providerStatusList.replaceChildren();
  for (const [family, label] of Object.entries(MODEL_FAMILY_LABELS)) {
    const item = document.createElement("li");
    const configured = Boolean(providerKeys[family]?.configured);
    item.textContent = `${label}: ${configured ? "configured" : "missing"}`;
    item.dataset.configured = configured ? "true" : "false";
    providerStatusList.appendChild(item);
  }
}

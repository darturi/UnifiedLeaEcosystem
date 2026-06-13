const DEFAULT_COMPANION_URL = "http://127.0.0.1:31245";
const MODEL_FAMILY_LABELS = {
  openai: "OpenAI",
  gemini: "Gemini",
  anthropic: "Anthropic"
};
const DEFAULT_MODEL_OPTIONS = [
  { id: "o4-mini", label: "o4-mini", family: "openai", tag: "Current default" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", family: "openai", tag: "Fast" },
  { id: "gpt-5.4", label: "GPT-5.4", family: "openai", tag: "Balanced" },
  { id: "gpt-5.5", label: "GPT-5.5", family: "openai", tag: "Most capable" },
  { id: "gemini/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", family: "gemini", tag: "Research" },
  { id: "gemini/gemini-2.5-pro", label: "Gemini 2.5 Pro", family: "gemini", tag: "Capable" },
  { id: "gemini/gemini-2.5-flash", label: "Gemini 2.5 Flash", family: "gemini", tag: "Fast" },
  { id: "anthropic/claude-opus-4-8", label: "Claude Opus 4.8", family: "anthropic", tag: "Most capable" },
  { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", family: "anthropic", tag: "Balanced" }
];

const form = document.querySelector("#settings-form");
const companionUrlInput = document.querySelector("#companion-url");
const leaRepoPathInput = document.querySelector("#lea-repo-path");
const leaApiBaseUrlInput = document.querySelector("#lea-api-base-url");
const leaModelInput = document.querySelector("#lea-model");
const leaMaxTurnsInput = document.querySelector("#lea-max-turns");
const providerStatusList = document.querySelector("#provider-key-status");
const providerKeyInputs = {
  openai: document.querySelector("#openai-api-key"),
  gemini: document.querySelector("#gemini-api-key"),
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
    leaModel: "o4-mini",
    leaMaxTurns: 20
  },
  (settings) => {
    companionUrlInput.value = settings.companionUrl;
    leaRepoPathInput.value = settings.leaRepoPath;
    leaApiBaseUrlInput.value = settings.leaApiBaseUrl;
    renderModelOptions(DEFAULT_MODEL_OPTIONS, settings.leaModel, latestProviderKeys);
    renderProviderKeyStatus(latestProviderKeys);
    leaMaxTurnsInput.value = settings.leaMaxTurns;
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
  const leaModel = leaModelInput.value.trim() || "o4-mini";
  const leaMaxTurns = Number.parseInt(leaMaxTurnsInput.value, 10) || 20;
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
      leaMaxTurns: leaPayload.leaMaxTurns
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
    renderModelOptions(latestModelOptions, payload.leaModel || leaModelInput.value || "o4-mini", latestProviderKeys);
    leaMaxTurnsInput.value = payload.leaMaxTurns || leaMaxTurnsInput.value || 20;

    await chrome.storage.sync.set({
      companionUrl,
      leaRepoPath: leaRepoPathInput.value,
      leaApiBaseUrl: leaApiBaseUrlInput.value,
      leaModel: leaModelInput.value,
      leaMaxTurns: Number.parseInt(leaMaxTurnsInput.value, 10) || 20
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
    renderModelOptions(latestModelOptions, leaModelInput.value || "o4-mini", getEffectiveProviderKeyStatus());
  });
}

function renderModelOptions(options, selectedModel, providerKeys = {}) {
  leaModelInput.replaceChildren();
  const byFamily = new Map();
  for (const model of options) {
    const family = model.family || "openai";
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(model);
  }
  for (const [family, models] of byFamily) {
    const group = document.createElement("optgroup");
    group.label = MODEL_FAMILY_LABELS[family] || family;
    const familyConfigured = Boolean(providerKeys[family]?.configured);
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.tag ? `${model.label} - ${model.tag}` : model.label;
      option.disabled = !familyConfigured && model.id !== selectedModel;
      group.appendChild(option);
    }
    leaModelInput.appendChild(group);
  }
  leaModelInput.value = [...leaModelInput.options].some((option) => option.value === selectedModel)
    ? selectedModel
    : "o4-mini";
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

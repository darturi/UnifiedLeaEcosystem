const DEFAULT_COMPANION_URL = "http://127.0.0.1:31245";
const DEFAULT_MODEL_OPTIONS = [
  { id: "o4-mini", label: "o4-mini", tag: "Current default" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", tag: "Fast" },
  { id: "gpt-5.4", label: "GPT-5.4", tag: "Balanced" },
  { id: "gpt-5.5", label: "GPT-5.5", tag: "Most capable" }
];

const form = document.querySelector("#settings-form");
const companionUrlInput = document.querySelector("#companion-url");
const leaRepoPathInput = document.querySelector("#lea-repo-path");
const leaApiBaseUrlInput = document.querySelector("#lea-api-base-url");
const leaModelInput = document.querySelector("#lea-model");
const leaMaxTurnsInput = document.querySelector("#lea-max-turns");
const loadCompanionSettingsButton = document.querySelector("#load-companion-settings");
const statusEl = document.querySelector("#status");

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
    renderModelOptions(DEFAULT_MODEL_OPTIONS, settings.leaModel);
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

  try {
    const leaResponse = await fetch(`${companionUrl}/settings/lea`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leaRepoPath,
        leaApiBaseUrl,
        leaProvider: "openai",
        leaModel,
        leaMaxTurns
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
    renderModelOptions(payload.leaModelOptions || DEFAULT_MODEL_OPTIONS, payload.leaModel || leaModelInput.value || "o4-mini");
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

function renderModelOptions(options, selectedModel) {
  leaModelInput.replaceChildren();
  for (const model of options) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.tag ? `${model.label} - ${model.tag}` : model.label;
    leaModelInput.appendChild(option);
  }
  leaModelInput.value = [...leaModelInput.options].some((option) => option.value === selectedModel)
    ? selectedModel
    : "o4-mini";
}

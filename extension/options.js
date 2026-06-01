const DEFAULT_COMPANION_URL = "http://127.0.0.1:31245";

const form = document.querySelector("#settings-form");
const companionUrlInput = document.querySelector("#companion-url");
const workspacePathInput = document.querySelector("#workspace-path");
const leaRepoPathInput = document.querySelector("#lea-repo-path");
const leaModelInput = document.querySelector("#lea-model");
const leaMaxTurnsInput = document.querySelector("#lea-max-turns");
const loadCompanionSettingsButton = document.querySelector("#load-companion-settings");
const statusEl = document.querySelector("#status");

chrome.storage.sync.get(
  {
    companionUrl: DEFAULT_COMPANION_URL,
    workspacePath: "",
    leaRepoPath: "",
    leaModel: "o4-mini",
    leaMaxTurns: 20
  },
  (settings) => {
    companionUrlInput.value = settings.companionUrl;
    workspacePathInput.value = settings.workspacePath;
    leaRepoPathInput.value = settings.leaRepoPath;
    leaModelInput.value = settings.leaModel;
    leaMaxTurnsInput.value = settings.leaMaxTurns;
    loadCompanionSettings({ silent: true });
  }
);

loadCompanionSettingsButton.addEventListener("click", () => {
  loadCompanionSettings({ silent: false });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusEl.textContent = "Validating workspace...";

  const companionUrl = companionUrlInput.value.trim().replace(/\/+$/, "");
  const workspacePath = workspacePathInput.value.trim();
  const leaRepoPath = leaRepoPathInput.value.trim();
  const leaModel = leaModelInput.value.trim() || "o4-mini";
  const leaMaxTurns = Number.parseInt(leaMaxTurnsInput.value, 10) || 20;

  try {
    const workspaceResponse = await fetch(`${companionUrl}/settings/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath })
    });
    const workspacePayload = await workspaceResponse.json().catch(() => ({}));
    if (!workspaceResponse.ok) {
      throw new Error(workspacePayload.message || `Companion returned HTTP ${workspaceResponse.status}.`);
    }

    const leaResponse = await fetch(`${companionUrl}/settings/lea`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leaRepoPath,
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
      workspacePath: workspacePayload.workspacePath,
      leaRepoPath: leaPayload.leaRepoPath,
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
    workspacePathInput.value = payload.workspacePath || workspacePathInput.value;
    leaRepoPathInput.value = payload.leaRepoPath || leaRepoPathInput.value;
    leaModelInput.value = payload.leaModel || leaModelInput.value || "o4-mini";
    leaMaxTurnsInput.value = payload.leaMaxTurns || leaMaxTurnsInput.value || 20;

    await chrome.storage.sync.set({
      companionUrl,
      workspacePath: workspacePathInput.value,
      leaRepoPath: leaRepoPathInput.value,
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

(function () {
  const DEFAULT_COMPANION_URL = "http://127.0.0.1:31245";
  const DEFAULT_LEA_UI_BASE_URL = "http://localhost:5173";
  const DEFAULT_LEA_MODEL = "o4-mini";
  const DEFAULT_LEA_MAX_TURNS = 20;
  const DEFAULT_LEA_TEX_MIRROR_ENABLED = true;
  const LEA_UI_VIEW_STATUSES = new Set(["formalized", "disproved", "in_progress", "sorry_stub"]);
  const TEX_MIRROR_SYNC_DELAY_MS = 1500;
  const MODEL_FAMILY_LABELS = {
    openai: "OpenAI",
    google: "Google AI",
    anthropic: "Anthropic"
  };
  const DEFAULT_MODEL_OPTIONS = [
    { value: DEFAULT_LEA_MODEL, label: DEFAULT_LEA_MODEL, family: "openai" }
  ];
  let activePopover = null;
  let statusRefreshTimer = null;
  let usageRefreshTimer = null;
  let latestTheorems = [];
  let latestDiagnostics = [];
  let latestActiveTex = "";
  let latestActiveTexPath = "";
  let latestActiveTexProjectId = "";
  let lastMirrorFiles = null;
  let lastMirrorProjectId = "";
  let texMirrorActivatedProjectId = "";
  let texMirrorDirty = false;
  let texMirrorSyncedOnce = false;
  let texMirrorSyncTimer = null;
  let texMirrorSyncPromise = null;
  let latestStatuses = {};
  let badgeLayer = null;
  let settingsButton = null;
  let costCapNotice = null;
  let dismissedCostCapNoticeKeys = new Set();
  let activeCostCapNoticeKeys = new Set();
  let costCapUsageLimitReached = false;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "OL_LEAN_THEOREM_CLICK") {
      rememberTheorem(event.data.theorem);
      showTheoremPopover(event.data.clientX, event.data.clientY, event.data.theorem);
      return;
    }
    if (event.data?.type === "OL_LEAN_DIAGNOSTIC_CLICK") {
      showDiagnosticPopover(event.data.clientX, event.data.clientY, event.data.diagnostic || event.data.theorem);
      return;
    }
    if (event.data?.type === "OL_LEAN_THEOREMS_VISIBLE") {
      const nextActiveTex = typeof event.data.activeTex === "string" ? event.data.activeTex : "";
      const nextProjectId = extractOverleafProjectId();
      const activeTexChanged = nextActiveTex !== latestActiveTex || nextProjectId !== latestActiveTexProjectId;
      latestTheorems = event.data.theorems || [];
      latestDiagnostics = event.data.diagnostics || [];
      latestActiveTex = nextActiveTex;
      latestActiveTexPath = typeof event.data.activePath === "string" ? event.data.activePath : latestActiveTexPath;
      latestActiveTexProjectId = nextProjectId;
      renderStatusBadges();
      if (activeTexChanged) {
        texMirrorDirty = true;
        scheduleTexMirrorSync();
      }
      scheduleStatusRefresh();
    }
  });

  injectPageBridge();
  requestTheoremsSoon();
  renderSettingsButton();

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePopover();
  });

  document.addEventListener("click", (event) => {
    if (activePopover && !activePopover.contains(event.target)) {
      closePopover();
    }
  });

  window.addEventListener("resize", renderStatusBadges);
  window.addEventListener("scroll", () => {
    requestTheorems();
    renderStatusBadges();
  }, true);

  function renderSettingsButton() {
    if (settingsButton) return;
    settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "ol-lean-settings-trigger";
    settingsButton.setAttribute("aria-label", "Open Lea settings and usage");
    settingsButton.title = "Lea settings and usage";
    settingsButton.innerHTML = `
      <span class="ol-lean-trigger-mark">L</span>
    `;
    settingsButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showSettingsPopover();
    });
    (document.body || document.documentElement).appendChild(settingsButton);
  }

  function showTheoremPopover(clientX, clientY, theorem) {
    if (theorem?.syntax === "diagnostic") {
      showDiagnosticPopover(clientX, clientY, theorem);
      return;
    }
    closePopover();

    const popover = document.createElement("div");
    popover.className = "ol-lean-theorem-popover";
    popover.innerHTML = `
      <p class="ol-lean-popover-title">Lean formalization</p>
      <p class="ol-lean-popover-meta">Label: <strong></strong></p>
      <div class="ol-lean-popover-actions" data-role="theorem-actions"></div>
      <pre class="ol-lean-popover-lean" hidden></pre>
      <p class="ol-lean-popover-warning" hidden></p>
      <p class="ol-lean-popover-status"></p>
    `;

    popover.dataset.theoremLabel = theorem.label;
    popover.querySelector("strong").textContent = theorem.label;
    const actions = popover.querySelector("[data-role='theorem-actions']");
    const status = popover.querySelector(".ol-lean-popover-status");
    const leanStatement = popover.querySelector(".ol-lean-popover-lean");
    const stubbedWarning = popover.querySelector(".ol-lean-popover-warning");
    const statusInfo = latestStatuses[theorem.label] || {};
    const currentStatus = statusInfo.status || "unknown";
    const actionStatus = getActionStatus(statusInfo);
    renderLeanStatement(leanStatement, statusInfo.leanStatement || "");
    renderTheoremWarning(stubbedWarning, theorem, statusInfo);
    renderTheoremActions(actions, theorem, currentStatus, status, leanStatement, actionStatus, statusInfo);
    if (currentStatus === "in_progress") {
      status.textContent = inProgressMessage(latestStatuses[theorem.label]);
    } else if (isExtensionContextInvalidated()) {
      status.textContent = "Extension was reloaded. Refresh this Overleaf tab.";
    }

    document.body.appendChild(popover);
    positionPopover(popover, clientX, clientY);
    activePopover = popover;
  }

  function showDiagnosticPopover(clientX, clientY, diagnostic) {
    if (!diagnostic) return;
    closePopover();

    const popover = document.createElement("div");
    popover.className = "ol-lean-theorem-popover";
    popover.innerHTML = `
      <p class="ol-lean-popover-title">Lea marker problem</p>
      <p class="ol-lean-popover-meta">Issue: <strong></strong></p>
      <div class="ol-lean-popover-actions" data-role="theorem-actions"></div>
      <pre class="ol-lean-popover-lean" hidden></pre>
      <p class="ol-lean-popover-warning" hidden></p>
      <p class="ol-lean-popover-status"></p>
    `;

    popover.dataset.diagnosticCode = diagnostic.code || "marker_error";
    popover.querySelector("strong").textContent = diagnostic.code || "marker_error";
    const actions = popover.querySelector("[data-role='theorem-actions']");
    const status = popover.querySelector(".ol-lean-popover-status");
    status.textContent = diagnostic.message || "This Lea marker is malformed.";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", closePopover);
    actions.appendChild(closeButton);

    document.body.appendChild(popover);
    positionPopover(popover, clientX, clientY);
    activePopover = popover;
  }

  function renderTheoremActions(actions, theorem, currentStatus, status, leanStatement, actionStatus = currentStatus, statusInfo = {}) {
    actions.replaceChildren();
    const disabled = currentStatus === "in_progress" || isExtensionContextInvalidated();
    const actionSpecs = actionSpecsForStatus(actionStatus);
    for (const spec of actionSpecs) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = spec.label;
      button.dataset.role = spec.role;
      if (spec.primary) {
        button.dataset.primary = "true";
      }
      button.disabled = disabled;
      button.addEventListener("click", async () => {
        for (const actionButton of actions.querySelectorAll("button")) {
          actionButton.disabled = true;
        }
        status.textContent = spec.pendingText;
        try {
          const result = await spec.run(theorem);
          status.textContent = `${formatStatus(result.status)}${result.relativePath ? ` at ${result.relativePath}` : ""}`;
          renderLeanStatement(leanStatement, result.leanStatement || latestStatuses[theorem.label]?.leanStatement || "");
          await refreshStatusesNow();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
          if (isMaxSpendError(error)) {
            showCostCapNotice(null, { force: true, noticeKey: `error:${Date.now()}` });
          }
          const latestStatus = latestStatuses[theorem.label] || { status: currentStatus };
          renderTheoremActions(actions, theorem, latestStatus.status || currentStatus, status, leanStatement, getActionStatus(latestStatus));
        }
      });
      actions.appendChild(button);
    }

    const leaSession = getLeaSessionLink(statusInfo);
    // Only statuses that represent a real Lea run or saved proof artifact should
    // offer a route into the Lea UI. Stale session metadata must not make
    // unformalized/unknown theorems appear viewable.
    const showLeaUiButton = canViewInLeaUi(actionStatus);
    if (showLeaUiButton) {
      const leaUiLink = leaSession || getLeaUiBaseLink(statusInfo);
      const sessionButton = document.createElement("button");
      sessionButton.type = "button";
      sessionButton.textContent = "View in Lea UI";
      sessionButton.dataset.role = "open-lea-session";
      sessionButton.disabled = isExtensionContextInvalidated();
      sessionButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        status.textContent = leaUiLink.sessionId ? "Opening Lea session..." : "Opening Lea UI...";
        try {
          await openLeaSession(leaUiLink);
          status.textContent = leaUiLink.sessionId ? "Opened Lea session." : "Opened Lea UI.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      });
      actions.appendChild(sessionButton);
    }

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", closePopover);
    actions.appendChild(closeButton);
  }

  function actionSpecsForStatus(status) {
    if (status === "unformalized") {
      return [
        {
          role: "theorem-action",
          label: "Formalize",
          primary: true,
          pendingText: "Starting Lea...",
          run: formalize
        },
        {
          role: "theorem-stub-action",
          label: "Stub",
          primary: false,
          pendingText: "Creating Lean stub...",
          run: stubTheorem
        }
      ];
    }
    if (status === "sorry_stub") {
      return [{
        role: "theorem-action",
        label: "Formalize",
        primary: true,
        pendingText: "Starting Lea...",
        run: formalize
      }];
    }
    if (status === "formalized" || status === "unknown") {
      return [{
        role: "theorem-action",
        label: "Check status",
        primary: true,
        pendingText: "Checking Lea status...",
        run: refreshSingleStatus
      }];
    }
    return [{
      role: "theorem-action",
      label: buttonTextForStatus(status),
      primary: true,
      pendingText: "Starting Lea...",
      run: formalize
    }];
  }

  function showSettingsPopover() {
    closePopover();

    const popover = document.createElement("div");
    popover.className = "ol-lean-popover ol-lean-settings-popover";
    popover.innerHTML = `
      <div class="ol-lean-popover-arrow ol-lean-popover-arrow-bottom" aria-hidden="true"></div>
      <div class="ol-lean-popover-header">
        <div class="ol-lean-popover-kicker">
          <span class="ol-lean-popover-mark" aria-hidden="true">L</span>
          <span>Extension Settings</span>
        </div>
        <button type="button" class="ol-lean-icon-button" data-role="close" aria-label="Close Lea popover">x</button>
      </div>
      <div class="ol-lean-popover-body">
        <section class="ol-lean-usage-panel" aria-live="polite">
          <div class="ol-lean-usage-row" data-usage="project">
            <div class="ol-lean-usage-row-head">
              <span>This project</span>
              <strong data-field="cost">--</strong>
            </div>
            <div class="ol-lean-usage-metrics">
              <span><small>In</small><strong data-field="input">--</strong></span>
              <span><small>Out</small><strong data-field="output">--</strong></span>
            </div>
          </div>
          <div class="ol-lean-usage-separator"></div>
          <div class="ol-lean-usage-row" data-usage="allTime">
            <div class="ol-lean-usage-row-head">
              <span>All-time</span>
              <strong data-field="cost">--</strong>
            </div>
            <div class="ol-lean-usage-metrics">
              <span><small>In</small><strong data-field="input">--</strong></span>
              <span><small>Out</small><strong data-field="output">--</strong></span>
            </div>
          </div>
          <p class="ol-lean-usage-cap" data-role="cost-cap-summary" hidden></p>
        </section>
        <section class="ol-lean-provider-panel" data-role="provider-keys">
          <div class="ol-lean-provider-title">Model families</div>
          <p class="ol-lean-provider-note">Keys are saved to the root .env by the companion, not to Chrome or settings.json.</p>
          ${Object.entries(MODEL_FAMILY_LABELS).map(([family, label]) => `
            <div class="ol-lean-provider-row" data-family="${family}">
              <div class="ol-lean-provider-row-head">
                <span>${label}</span>
                <strong data-role="provider-status">Missing</strong>
              </div>
              <div class="ol-lean-provider-key-controls">
                <button type="button" class="ol-lean-provider-key-button" data-role="provider-key-toggle" data-family="${family}">Add key</button>
                <input type="password" autocomplete="off" spellcheck="false" data-role="provider-key-input" data-family="${family}" placeholder="${label} API key" hidden>
              </div>
            </div>
          `).join("")}
        </section>
        <section class="ol-lean-settings-panel">
          <label>
            <span>Model</span>
            <select data-role="model"></select>
          </label>
          <label>
            <span>Max turns</span>
            <input type="number" min="1" max="200" data-role="max-turns">
          </label>
          <label>
            <span>Cost cap (USD)</span>
            <input type="number" min="0" step="0.01" data-role="max-spend" placeholder="None">
          </label>
          <label class="ol-lean-checkbox-field">
            <input type="checkbox" data-role="tex-mirror">
            <span>Mirror Overleaf .tex into the project</span>
          </label>
          <button type="button" class="ol-lean-save-button" data-role="save-settings" disabled>Save changes</button>
        </section>
      </div>
      <p class="ol-lean-popover-status" role="status"></p>
    `;

    const closeButton = popover.querySelector("[data-role='close']");
    const status = popover.querySelector(".ol-lean-popover-status");
    const modelSelect = popover.querySelector("[data-role='model']");
    const maxTurnsInput = popover.querySelector("[data-role='max-turns']");
    const maxSpendInput = popover.querySelector("[data-role='max-spend']");
    const texMirrorInput = popover.querySelector("[data-role='tex-mirror']");
    const saveButton = popover.querySelector("[data-role='save-settings']");

    closeButton.addEventListener("click", closePopover);
    modelSelect.addEventListener("change", markSettingsDirty);
    maxTurnsInput.addEventListener("input", markSettingsDirty);
    maxSpendInput.addEventListener("input", markSettingsDirty);
    texMirrorInput.addEventListener("change", markSettingsDirty);
    for (const button of popover.querySelectorAll("[data-role='provider-key-toggle']")) {
      button.addEventListener("click", () => {
        const input = popover.querySelector(`[data-role='provider-key-input'][data-family='${button.dataset.family}']`);
        if (!input) return;
        input.hidden = false;
        input.focus();
      });
    }
    for (const input of popover.querySelectorAll("[data-role='provider-key-input']")) {
      input.addEventListener("input", () => {
        refreshModelAvailability(popover);
        markSettingsDirty();
      });
    }
    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      status.textContent = "Saving Lea settings...";
      try {
        const settings = await savePopoverSettings(popover);
        popover.dataset.savedModel = settings.leaModel;
        popover.dataset.savedMaxTurns = String(settings.leaMaxTurns);
        popover.dataset.savedMaxSpend = settings.leaMaxSpendUsd == null ? "" : String(settings.leaMaxSpendUsd);
        popover.dataset.savedTexMirror = String(settings.leaTexMirrorEnabled !== false);
        renderProviderKeys(popover, settings.leaProviderKeys || {});
        clearProviderKeyInputs(popover);
        refreshModelAvailability(popover);
        markSettingsDirty();
        scheduleTexMirrorSync();
        status.textContent = "Settings saved.";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
        markSettingsDirty();
      }
    });

    document.body.appendChild(popover);
    positionSettingsPopover(popover);
    activePopover = popover;
    positionCostCapNotice(popover);
    loadPopoverSettings(popover).catch((error) => {
      status.textContent = error instanceof Error ? error.message : String(error);
    });
    loadUsage(popover).catch((error) => {
      status.textContent = error instanceof Error ? error.message : String(error);
    });
    scheduleUsageRefresh(popover);

    function markSettingsDirty() {
      const family = getModelFamily(
        getStoredModelOptions(popover),
        modelSelect.value || popover.dataset.savedModel || DEFAULT_LEA_MODEL
      );
      const selectedFamilyConfigured = Boolean(getEffectiveProviderKeyStatus(popover)[family]?.configured);
      const dirty = modelSelect.value !== popover.dataset.savedModel ||
        String(Number.parseInt(maxTurnsInput.value, 10) || DEFAULT_LEA_MAX_TURNS) !== popover.dataset.savedMaxTurns ||
        normalizeMaxSpendInput(maxSpendInput.value) !== (popover.dataset.savedMaxSpend || "") ||
        String(texMirrorInput.checked) !== (popover.dataset.savedTexMirror || "true") ||
        hasProviderKeyInput(popover);
      saveButton.disabled = !dirty || !selectedFamilyConfigured;
    }
  }

  function closePopover() {
    clearTimeout(usageRefreshTimer);
    usageRefreshTimer = null;
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
    positionCostCapNotice();
  }

  function positionPopover(popover, clientX, clientY) {
    const rect = popover.getBoundingClientRect();
    const gap = 12;
    const left = Math.min(clientX + gap, window.innerWidth - rect.width - 12);
    const top = Math.min(clientY + gap, window.innerHeight - rect.height - 12);
    popover.style.left = `${Math.max(12, left)}px`;
    popover.style.top = `${Math.max(12, top)}px`;
  }

  function positionSettingsPopover(popover) {
    const rect = popover.getBoundingClientRect();
    const buttonRect = settingsButton?.getBoundingClientRect();
    const right = 20;
    const bottom = buttonRect ? window.innerHeight - buttonRect.top + 12 : 76;
    popover.style.left = `${Math.max(12, window.innerWidth - rect.width - right)}px`;
    popover.style.top = `${Math.max(12, window.innerHeight - rect.height - bottom)}px`;
  }

  function updatePopoverStatus(popover, theorem) {
    if (!popover || popover.dataset.theoremLabel !== theorem.label) return;
    const statusInfo = latestStatuses[theorem.label] || { status: "unknown" };
    const currentStatus = statusInfo.status || "unknown";
    const actionStatus = getActionStatus(statusInfo);
    const chip = popover.querySelector(".ol-lean-status-chip");
    const detail = popover.querySelector(".ol-lean-popover-detail");
    const actions = popover.querySelector("[data-role='theorem-actions']");
    const leanStatement = popover.querySelector(".ol-lean-popover-lean");
    const stubbedWarning = popover.querySelector(".ol-lean-popover-warning");

    if (chip) {
      chip.className = `ol-lean-status-chip ol-lean-status-chip-${currentStatus}`;
      chip.textContent = formatStatus(currentStatus);
      if (hasStubbedTheoremUses(statusInfo)) {
        chip.appendChild(createStubbedTheoremUsesMark());
      }
    }
    if (actions) {
      renderTheoremActions(actions, theorem, currentStatus, popover.querySelector(".ol-lean-popover-status"), leanStatement, actionStatus, statusInfo);
    }

    if (detail) {
      if (isExtensionContextInvalidated()) {
        detail.textContent = "Extension was reloaded. Refresh this Overleaf tab.";
      } else if (statusInfo.message) {
        detail.textContent = statusInfo.message;
      } else if (statusInfo.relativePath) {
        detail.textContent = statusInfo.relativePath;
      } else if (currentStatus === "in_progress") {
        detail.textContent = inProgressMessage(statusInfo);
      } else {
        detail.textContent = "Ready to send this theorem to Lea.";
      }
    }
    renderLeanStatement(leanStatement, statusInfo.leanStatement || "");
    renderTheoremWarning(stubbedWarning, theorem, statusInfo);
  }

  async function formalize(theorem) {
    // Flush any pending .tex mirror so the run's context is current (a no-op when
    // nothing changed since the last background sync).
    await syncTexMirrorNow({ force: true }).catch(() => {});
    const settings = await getSettings();
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/formalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        overleafProjectId: extractOverleafProjectId(),
        theoremLabel: theorem.label,
        theoremText: theorem.text,
        theoremUses: theorem.uses || [],
        theoremContext: theorem.context || "",
        sourceHash: await sha256(normalizeTheoremText(theorem.text))
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    return payload;
  }

  async function stubTheorem(theorem) {
    // Stubbing also needs the current .tex mirror because statement translation may
    // depend on local notation/definitions in the surrounding document.
    await syncTexMirrorNow({ force: true }).catch(() => {});
    const settings = await getSettings();
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/stub`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        overleafProjectId: extractOverleafProjectId(),
        theoremLabel: theorem.label,
        theoremText: theorem.text,
        theoremUses: theorem.uses || [],
        theoremContext: theorem.context || "",
        sourceHash: await sha256(normalizeTheoremText(theorem.text))
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    return payload;
  }

  async function refreshSingleStatus(theorem) {
    await refreshStatusesNow();
    return latestStatuses[theorem.label] || {
      status: "unavailable",
      relativePath: ""
    };
  }

  function scheduleStatusRefresh() {
    clearTimeout(statusRefreshTimer);
    statusRefreshTimer = setTimeout(() => {
      refreshStatusesNow().catch((error) => {
        postStatusError(error);
      });
    }, 250);
  }

  async function refreshStatusesNow() {
    if (latestTheorems.length === 0) {
      postStatuses({});
      return;
    }

    const settings = await getSettings();
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/statuses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        overleafProjectId: extractOverleafProjectId(),
        theorems: latestTheorems.map((theorem) => ({
          theoremLabel: theorem.label,
          theoremText: theorem.text
        }))
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    postStatuses(withFallbackStatuses(payload.statuses || {}));
    if (activePopover?.dataset.theoremLabel) {
      const theorem = latestTheorems.find((item) => item.label === activePopover.dataset.theoremLabel);
      if (theorem) updatePopoverStatus(activePopover, theorem);
    }
    if (Object.values(latestStatuses).some((status) => status.status === "in_progress")) {
      scheduleStatusRefresh();
    }
  }

  function scheduleTexMirrorSync() {
    clearTimeout(texMirrorSyncTimer);
    texMirrorSyncTimer = setTimeout(() => {
      syncTexMirrorNow({ force: false }).catch(() => {});
    }, TEX_MIRROR_SYNC_DELAY_MS);
  }

  // Mirror the project's .tex sources into the matching Lea project (via the
  // companion's /mirror-tex → adapter). Driven in the background as the document
  // changes; `force` flushes a pending sync before a formalize. Skips all work when
  // nothing has changed since the last successful mirror (the formalize fast path).
  //
  // Lazy project creation: a Lea project must only come into being once the user
  // actually formalizes — never from merely opening or editing an Overleaf tab. So a
  // `force` sync (the formalize flush) ACTIVATES mirroring for this project; background
  // syncs stay completely inert (no zip fetch, no /mirror-tex, no project) until then.
  async function syncTexMirrorNow({ force }) {
    clearTimeout(texMirrorSyncTimer);
    texMirrorSyncTimer = null;

    if (texMirrorSyncPromise) {
      // Coalesce with an in-flight sync; its result may already be current.
      await texMirrorSyncPromise.catch(() => {});
    }

    const projectId = latestActiveTexProjectId || extractOverleafProjectId();
    if (!projectId || projectId === "unknown") return null;

    if (force) {
      texMirrorActivatedProjectId = projectId;  // formalizing activates this project
    } else if (texMirrorActivatedProjectId !== projectId) {
      return null;  // background activity never creates/mirrors before the first formalize
    }

    // Fast path: nothing changed since the last mirror for this project.
    if (!force && !texMirrorDirty && texMirrorSyncedOnce && lastMirrorProjectId === projectId) {
      return null;
    }

    const settings = await loadCompanionSettings();
    if (settings.leaTexMirrorEnabled === false) return null;
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");

    texMirrorSyncPromise = (async () => {
      // Re-download + unzip the project only when the content may have changed (an edit
      // set the dirty flag, a new project, or no cached set yet); otherwise reuse the
      // cached .tex set so an unchanged formalize skips the expensive zip fetch.
      const needFetch = texMirrorDirty || !lastMirrorFiles || lastMirrorProjectId !== projectId;
      const files = needFetch ? await collectProjectTexFiles(projectId) : lastMirrorFiles;
      // Always POST: the adapter is authoritative and no-ops cheaply on identical
      // content, so a backend reset (or any client/server divergence) self-heals instead
      // of being masked by a stale client-side "already synced" cache.
      const response = await fetch(`${baseUrl}/mirror-tex`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overleafProjectId: projectId, files })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
      }
      lastMirrorFiles = files;
      lastMirrorProjectId = projectId;
      texMirrorSyncedOnce = true;
      texMirrorDirty = false;
      return payload;
    })().finally(() => {
      texMirrorSyncPromise = null;
    });

    return texMirrorSyncPromise;
  }

  // Download the project's source archive (authenticated, same-origin) and return
  // its .tex entries as [{ path, content }]. Overlays the live active-editor buffer
  // when its path is known, so the file being edited is current even if Overleaf's
  // saved copy lags. Unzipping uses the dependency-free reader in zipTex.mjs.
  async function collectProjectTexFiles(projectId) {
    const response = await fetch(`/project/${encodeURIComponent(projectId)}/download/zip`, {
      credentials: "same-origin"
    });
    if (!response.ok) {
      throw new Error(`Overleaf returned HTTP ${response.status} for the project download.`);
    }
    const buffer = await response.arrayBuffer();
    const { extractTexFromZip } = await import(chrome.runtime.getURL("zipTex.mjs"));
    const files = await extractTexFromZip(buffer);

    if (latestActiveTexPath && typeof latestActiveTex === "string") {
      // Override only an entry that already exists in the archive — never invent a
      // path, so a misread active-file path can't inject a spurious mirror file.
      const wanted = String(latestActiveTexPath).replace(/^\/+/, "");
      const existing = files.find((file) => file.path === wanted);
      if (existing) existing.content = latestActiveTex;
    }
    return files;
  }

  function postStatusError(error) {
    const message = normalizeErrorMessage(error);
    const statuses = {};
    for (const theorem of latestTheorems) {
      statuses[theorem.label] = {
        status: "offline",
        message
      };
    }
    postStatuses(statuses);
  }

  function postStatuses(statuses) {
    latestStatuses = statuses || {};
    const noticeKey = maxSpendNoticeKeyFromStatuses(latestStatuses);
    if (noticeKey) {
      showCostCapNotice(null, { noticeKey });
    }
    renderStatusBadges();
  }

  function withFallbackStatuses(statuses) {
    const completeStatuses = { ...statuses };
    for (const theorem of latestTheorems) {
      if (!completeStatuses[theorem.label]) {
        completeStatuses[theorem.label] = {
          status: "unavailable",
          message: "The companion did not return a status for this theorem."
        };
      }
    }
    return completeStatuses;
  }

  function renderStatusBadges() {
    if (!badgeLayer) {
      badgeLayer = document.createElement("div");
      badgeLayer.className = "ol-lean-status-layer";
      (document.body || document.documentElement).appendChild(badgeLayer);
    }

    badgeLayer.replaceChildren();
    for (const diagnostic of latestDiagnostics) {
      const coords = diagnostic.coords || { left: 24, top: 24 };
      const badge = document.createElement("button");
      badge.className = "ol-lean-status ol-lean-status-failed";
      badge.type = "button";
      badge.appendChild(document.createTextNode("fix marker"));
      badge.title = diagnostic.message || "This Lea marker is malformed.";
      badge.setAttribute("aria-label", badge.title);
      badge.style.left = `${Math.min(coords.left + 8, window.innerWidth - 140)}px`;
      badge.style.top = `${coords.top}px`;
      badge.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showDiagnosticPopover(event.clientX, event.clientY, diagnostic);
      });
      badgeLayer.appendChild(badge);
    }
    for (const theorem of latestTheorems) {
      const coords = theorem.coords || { left: 24, top: 24 };
      const statusInfo = latestStatuses[theorem.label] || { status: "unknown" };
      const status = statusInfo.status || "unknown";
      const badge = document.createElement("button");
      badge.className = `ol-lean-status ol-lean-status-${status}`;
      badge.type = "button";
      badge.appendChild(document.createTextNode(formatStatus(status)));
      if (hasStubbedTheoremUses(statusInfo)) {
        badge.appendChild(createStubbedTheoremUsesMark());
      }
      const turnProgress = getTurnProgressDisplay(statusInfo);
      if (turnProgress.text) {
        const progress = document.createElement("span");
        progress.className = `ol-lean-status-progress${turnProgress.pending ? " ol-lean-status-progress-pending" : ""}`;
        progress.textContent = turnProgress.text;
        if (turnProgress.pending) {
          progress.setAttribute("aria-hidden", "true");
        }
        badge.appendChild(progress);
      }
      const stubbedUsesLabel = hasStubbedTheoremUses(statusInfo) ? " warning: proof uses sorry-stubbed support" : "";
      const statusLabel = `${formatStatus(status)}${turnProgress.label ? ` ${turnProgress.label}` : ""}${stubbedUsesLabel}`;
      badge.title = statusInfo.message || `Lean status for ${theorem.label}: ${statusLabel}`;
      badge.setAttribute("aria-label", `Open Lea popover for ${theorem.label}. Status: ${statusLabel}.`);
      badge.style.left = `${Math.min(coords.left + 8, window.innerWidth - 140)}px`;
      badge.style.top = `${coords.top}px`;
      badge.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showTheoremPopover(event.clientX, event.clientY, theorem);
      });
      badgeLayer.appendChild(badge);
    }
  }

  function formatStatus(status) {
    switch (status) {
      case "unformalized":
        return "unformalized";
      case "in_progress":
        return "in progress";
      case "formalized":
        return "formalized";
      case "disproved":
        return "Counterexample found";
      case "sorry_stub":
        return "sorry stub";
      case "failed":
        return "failed";
      case "offline":
        return "offline";
      case "unavailable":
        return "unavailable";
      default:
        return "checking";
    }
  }

  function inProgressMessage(statusInfo) {
    const turnProgressText = formatTurnProgress(statusInfo);
    return turnProgressText
      ? `Lea proof is in progress: ${turnProgressText}.`
      : "Lea proof is in progress. Waiting for the first turn update.";
  }

  function getTurnProgressDisplay(statusInfo) {
    if (statusInfo?.status !== "in_progress") return { text: "", label: "", pending: false };
    const turnProgressText = formatTurnProgress(statusInfo);
    if (turnProgressText) return { text: turnProgressText, label: turnProgressText, pending: false };
    return { text: "...", label: "progress pending", pending: true };
  }

  function formatTurnProgress(statusInfo) {
    if (statusInfo?.status !== "in_progress") return "";
    const current = Number.parseInt(String(statusInfo.turnProgress?.current || ""), 10);
    const max = Number.parseInt(String(statusInfo.turnProgress?.max || ""), 10);
    if (!Number.isFinite(current) || current < 1 || !Number.isFinite(max) || max < 1) return "";
    return `${current}/${max}`;
  }

  function renderLeanStatement(element, statement) {
    if (!element) return;
    if (!statement) {
      element.hidden = true;
      element.textContent = "";
      return;
    }
    element.hidden = false;
    element.textContent = statement;
  }

  function renderStubbedTheoremUsesWarning(element, statusInfo) {
    if (!element) return;
    const uses = getStubbedTheoremUses(statusInfo);
    if (uses.length === 0) {
      element.hidden = true;
      element.textContent = "";
      return;
    }
    const names = uses.map((use) => use.declarationName || use.theoremLabel).filter(Boolean).join(", ");
    const plural = uses.length !== 1;
    element.hidden = false;
    element.textContent = plural
      ? `Proof uses supporting theorems ${names}, which have been sorry stubbed but not fully formalized.`
      : `Proof uses supporting theorem ${names}, which has been sorry stubbed but not fully formalized.`;
  }

  function renderTheoremWarning(element, theorem, statusInfo) {
    if (!element) return;
    const uses = getStubbedTheoremUses(statusInfo);
    if (uses.length > 0) {
      renderStubbedTheoremUsesWarning(element, statusInfo);
      return;
    }
    if (theorem?.deprecated) {
      element.hidden = false;
      element.textContent = "This legacy \\theorem[...] syntax still works temporarily, but new Overleaf documents should use % lea: comment markers.";
      return;
    }
    element.hidden = true;
    element.textContent = "";
  }

  function getStubbedTheoremUses(statusInfo) {
    return Array.isArray(statusInfo?.stubbedTheoremUses) ? statusInfo.stubbedTheoremUses : [];
  }

  function hasStubbedTheoremUses(statusInfo) {
    return statusInfo?.status === "formalized" && getStubbedTheoremUses(statusInfo).length > 0;
  }

  function createStubbedTheoremUsesMark() {
    const mark = document.createElement("span");
    mark.className = "ol-lean-stubbed-use-mark";
    mark.textContent = "!";
    mark.title = "Proof uses sorry-stubbed support";
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }

  function buttonTextForStatus(status) {
    switch (status) {
      case "in_progress":
        return "Formalizing...";
      case "formalized":
      case "disproved":
      case "unknown":
        return "Check status";
      case "sorry_stub":
      case "unformalized":
      default:
        return "Run Lea";
    }
  }

  function getActionStatus(statusInfo) {
    if (statusInfo?.status === "failed") {
      return statusInfo.effectiveStatus || "unformalized";
    }
    return statusInfo?.status || "unknown";
  }

  function canViewInLeaUi(status) {
    return LEA_UI_VIEW_STATUSES.has(status);
  }

  function getLeaSessionLink(statusInfo) {
    const sessionUrl = String(statusInfo?.leaSessionUrl || "").trim();
    const sessionId = String(statusInfo?.leaSessionId || "").trim();
    if (!sessionUrl && !sessionId) return null;
    const baseUrl = String(statusInfo?.leaUiBaseUrl || DEFAULT_LEA_UI_BASE_URL).replace(/\/+$/, "");
    return {
      sessionId,
      baseUrl,
      url: sessionUrl || buildLeaSessionUrl(baseUrl, sessionId)
    };
  }

  function getLeaUiBaseLink(statusInfo) {
    const baseUrl = String(statusInfo?.leaUiBaseUrl || DEFAULT_LEA_UI_BASE_URL).replace(/\/+$/, "");
    return { sessionId: "", baseUrl, url: baseUrl };
  }

  function buildLeaSessionUrl(baseUrl, sessionId) {
    const url = new URL(baseUrl || DEFAULT_LEA_UI_BASE_URL);
    url.searchParams.set("session", sessionId);
    return url.toString();
  }

  function openLeaSession(sessionLink) {
    if (!sessionLink?.url) {
      return Promise.reject(new Error("Lea session link is not available yet."));
    }
    return new Promise((resolve, reject) => {
      const fallback = () => {
        const opened = window.open(sessionLink.url, "_blank", "noopener");
        if (opened) resolve();
        else reject(new Error("Browser blocked the Lea session tab."));
      };
      if (!globalThis.chrome?.runtime?.sendMessage) {
        fallback();
        return;
      }
      chrome.runtime.sendMessage({
        type: "OPEN_LEA_SESSION",
        url: sessionLink.url,
        baseUrl: sessionLink.baseUrl
      }, (response) => {
        if (chrome.runtime.lastError) {
          fallback();
          return;
        }
        if (response?.ok) {
          resolve();
          return;
        }
        reject(new Error(response?.message || "Could not open Lea session."));
      });
    });
  }

  function getSettings() {
    if (isExtensionContextInvalidated()) {
      return Promise.reject(new Error("Extension was reloaded. Refresh this Overleaf tab."));
    }
    return chrome.storage.sync.get({
      companionUrl: DEFAULT_COMPANION_URL,
      leaRepoPath: "",
      leaApiBaseUrl: "http://127.0.0.1:8001",
      leaUiBaseUrl: DEFAULT_LEA_UI_BASE_URL,
      leaModel: DEFAULT_LEA_MODEL,
      leaMaxTurns: DEFAULT_LEA_MAX_TURNS,
      leaMaxSpendUsd: null,
      leaTexMirrorEnabled: DEFAULT_LEA_TEX_MIRROR_ENABLED
    });
  }

  async function loadCompanionSettings() {
    const stored = await getSettings();
    const baseUrl = String(stored.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    try {
      const response = await fetch(`${baseUrl}/settings`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
      }
      const settings = {
        companionUrl: baseUrl,
        leaRepoPath: payload.leaRepoPath || stored.leaRepoPath || "",
        leaApiBaseUrl: payload.leaApiBaseUrl || stored.leaApiBaseUrl || "http://127.0.0.1:8001",
        leaUiBaseUrl: payload.leaUiBaseUrl || stored.leaUiBaseUrl || DEFAULT_LEA_UI_BASE_URL,
        leaModel: payload.leaModel || stored.leaModel || DEFAULT_LEA_MODEL,
        leaMaxTurns: payload.leaMaxTurns || stored.leaMaxTurns || DEFAULT_LEA_MAX_TURNS,
        leaMaxSpendUsd: payload.leaMaxSpendUsd ?? stored.leaMaxSpendUsd ?? null,
        leaCurrentSpendUsd: payload.leaCurrentSpendUsd ?? 0,
        leaTexMirrorEnabled: payload.leaTexMirrorEnabled ?? stored.leaTexMirrorEnabled ?? DEFAULT_LEA_TEX_MIRROR_ENABLED,
        leaModelOptions: payload.leaModelOptions || DEFAULT_MODEL_OPTIONS,
        leaProviderKeys: payload.leaProviderKeys || {}
      };
      await chrome.storage.sync.set({
        companionUrl: settings.companionUrl,
        leaRepoPath: settings.leaRepoPath,
        leaApiBaseUrl: settings.leaApiBaseUrl,
        leaUiBaseUrl: settings.leaUiBaseUrl,
        leaModel: settings.leaModel,
        leaMaxTurns: settings.leaMaxTurns,
        leaMaxSpendUsd: settings.leaMaxSpendUsd,
        leaTexMirrorEnabled: settings.leaTexMirrorEnabled
      });
      return settings;
    } catch {
      return {
        ...stored,
        companionUrl: baseUrl,
        leaModelOptions: DEFAULT_MODEL_OPTIONS,
        leaProviderKeys: {}
      };
    }
  }

  async function loadPopoverSettings(popover) {
    const settings = await loadCompanionSettings();
    const modelSelect = popover.querySelector("[data-role='model']");
    const maxTurnsInput = popover.querySelector("[data-role='max-turns']");
    const maxSpendInput = popover.querySelector("[data-role='max-spend']");
    const texMirrorInput = popover.querySelector("[data-role='tex-mirror']");
    popover.dataset.modelOptions = JSON.stringify(settings.leaModelOptions || DEFAULT_MODEL_OPTIONS);
    renderProviderKeys(popover, settings.leaProviderKeys || {});
    renderModelOptions(
      modelSelect,
      settings.leaModelOptions || DEFAULT_MODEL_OPTIONS,
      settings.leaModel || DEFAULT_LEA_MODEL,
      getEffectiveProviderKeyStatus(popover)
    );
    maxTurnsInput.value = String(settings.leaMaxTurns || DEFAULT_LEA_MAX_TURNS);
    maxSpendInput.value = settings.leaMaxSpendUsd == null ? "" : String(settings.leaMaxSpendUsd);
    texMirrorInput.checked = settings.leaTexMirrorEnabled !== false;
    popover.dataset.savedModel = modelSelect.value;
    popover.dataset.savedMaxTurns = String(Number.parseInt(maxTurnsInput.value, 10) || DEFAULT_LEA_MAX_TURNS);
    popover.dataset.savedMaxSpend = settings.leaMaxSpendUsd == null ? "" : String(settings.leaMaxSpendUsd);
    popover.dataset.savedTexMirror = String(texMirrorInput.checked);
    popover.querySelector("[data-role='save-settings']").disabled = true;
  }

  function renderModelOptions(select, options, selectedModel, providerKeys = {}) {
    select.replaceChildren();
    const byFamily = new Map();
    for (const model of options) {
      const family = normalizeFamily(model.family || "openai");
      if (!byFamily.has(family)) {
        byFamily.set(family, []);
      }
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
      select.appendChild(group);
    }
    select.value = [...select.options].some((option) => option.value === selectedModel)
      ? selectedModel
      : DEFAULT_LEA_MODEL;
  }

  function renderProviderKeys(popover, providerKeys) {
    popover.dataset.providerKeys = JSON.stringify(providerKeys || {});
    for (const family of Object.keys(MODEL_FAMILY_LABELS)) {
      const row = popover.querySelector(`.ol-lean-provider-row[data-family='${family}']`);
      if (!row) continue;
      const configured = Boolean(providerKeys?.[family]?.configured);
      const status = row.querySelector("[data-role='provider-status']");
      const button = row.querySelector("[data-role='provider-key-toggle']");
      row.dataset.configured = configured ? "true" : "false";
      status.textContent = configured ? "Configured" : "Missing";
      if (button) button.textContent = configured ? "Replace key" : "Add key";
    }
  }

  function refreshModelAvailability(popover) {
    const modelSelect = popover.querySelector("[data-role='model']");
    const selected = modelSelect.value || popover.dataset.savedModel || DEFAULT_LEA_MODEL;
    renderModelOptions(modelSelect, getStoredModelOptions(popover), selected, getEffectiveProviderKeyStatus(popover));
  }

  function getStoredModelOptions(popover) {
    try {
      const options = JSON.parse(popover.dataset.modelOptions || "[]");
      return Array.isArray(options) && options.length > 0 ? options : DEFAULT_MODEL_OPTIONS;
    } catch {
      return DEFAULT_MODEL_OPTIONS;
    }
  }

  function getSavedProviderKeyStatus(popover) {
    try {
      return JSON.parse(popover.dataset.providerKeys || "{}") || {};
    } catch {
      return {};
    }
  }

  function getEffectiveProviderKeyStatus(popover) {
    const status = { ...getSavedProviderKeyStatus(popover) };
    for (const input of popover.querySelectorAll("[data-role='provider-key-input']")) {
      if (!input.value.trim()) continue;
      status[input.dataset.family] = {
        ...(status[input.dataset.family] || {}),
        configured: true
      };
    }
    return status;
  }

  function getModelFamily(options, modelId) {
    return normalizeFamily(options.find((model) => (model.value || model.id) === modelId)?.family || "openai");
  }

  function normalizeFamily(family) {
    return family === "gemini" ? "google" : family;
  }

  function collectProviderApiKeyPatch(popover) {
    const patch = {};
    for (const input of popover.querySelectorAll("[data-role='provider-key-input']")) {
      const value = input.value.trim();
      if (value) patch[input.dataset.family] = value;
    }
    return patch;
  }

  function hasProviderKeyInput(popover) {
    return [...popover.querySelectorAll("[data-role='provider-key-input']")]
      .some((input) => Boolean(input.value.trim()));
  }

  function clearProviderKeyInputs(popover) {
    for (const input of popover.querySelectorAll("[data-role='provider-key-input']")) {
      input.value = "";
      input.hidden = true;
    }
  }

  async function savePopoverSettings(popover) {
    const current = await loadCompanionSettings();
    const baseUrl = String(current.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    const leaModel = popover.querySelector("[data-role='model']").value || DEFAULT_LEA_MODEL;
    const leaMaxTurns = Number.parseInt(popover.querySelector("[data-role='max-turns']").value, 10) || DEFAULT_LEA_MAX_TURNS;
    const leaMaxSpendUsd = parseMaxSpendInput(popover.querySelector("[data-role='max-spend']").value);
    const leaTexMirrorEnabled = popover.querySelector("[data-role='tex-mirror']").checked;
    const response = await fetch(`${baseUrl}/settings/lea`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leaRepoPath: current.leaRepoPath,
        leaApiBaseUrl: current.leaApiBaseUrl,
        leaModel,
        leaMaxTurns,
        leaMaxSpendUsd,
        leaTexMirrorEnabled,
        leaProviderApiKeys: collectProviderApiKeyPatch(popover)
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    await chrome.storage.sync.set({
      companionUrl: baseUrl,
      leaRepoPath: payload.leaRepoPath,
      leaApiBaseUrl: payload.leaApiBaseUrl,
      leaUiBaseUrl: payload.leaUiBaseUrl || current.leaUiBaseUrl || DEFAULT_LEA_UI_BASE_URL,
      leaModel: payload.leaModel,
      leaMaxTurns: payload.leaMaxTurns,
      leaMaxSpendUsd: payload.leaMaxSpendUsd,
      leaTheoremTranslationMaxRetries: payload.leaTheoremTranslationMaxRetries,
      leaTexMirrorEnabled: payload.leaTexMirrorEnabled
    });
    return payload;
  }

  async function loadUsage(popover) {
    if (!popover?.isConnected) return;
    const settings = await getSettings();
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/usage?overleafProjectId=${encodeURIComponent(extractOverleafProjectId())}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    renderUsage(popover, "project", payload.project);
    renderUsage(popover, "allTime", payload.allTime);
    renderCostCapSummary(popover, payload);
  }

  function scheduleUsageRefresh(popover) {
    clearTimeout(usageRefreshTimer);
    usageRefreshTimer = setTimeout(async () => {
      if (!popover?.isConnected || activePopover !== popover) {
        return;
      }
      try {
        await loadUsage(popover);
      } catch (error) {
        const status = popover.querySelector(".ol-lean-popover-status");
        if (status) status.textContent = error instanceof Error ? error.message : String(error);
      }
      scheduleUsageRefresh(popover);
    }, 1000);
  }

  function renderUsage(popover, key, usage) {
    const row = popover.querySelector(`[data-usage='${key}']`);
    if (!row) return;
    row.querySelector("[data-field='cost']").textContent = formatCost(usage?.costUsd || 0);
    row.querySelector("[data-field='input']").textContent = formatTokens(usage?.inputTokens || 0);
    row.querySelector("[data-field='output']").textContent = formatTokens(usage?.outputTokens || 0);
  }

  function renderCostCapSummary(popover, payload) {
    const summary = popover.querySelector("[data-role='cost-cap-summary']");
    if (!summary) return;
    const maxSpend = payload?.leaMaxSpendUsd;
    if (maxSpend === null || maxSpend === undefined || maxSpend === "") {
      summary.hidden = true;
      summary.textContent = "";
      costCapUsageLimitReached = false;
      removeCostCapNotice();
      return;
    }
    const current = payload?.leaCurrentSpendUsd ?? payload?.allTime?.costUsd ?? 0;
    summary.hidden = false;
    summary.textContent = `Cost cap: ${formatCost(current)} / ${formatCost(maxSpend)}`;
    const reached = Boolean(payload?.leaSpendLimitReached);
    summary.dataset.reached = reached ? "true" : "false";
    if (reached) {
      showCostCapNotice(popover, {
        force: !costCapUsageLimitReached,
        noticeKey: `usage:${maxSpend}:${current}`
      });
    } else {
      removeCostCapNotice();
    }
    costCapUsageLimitReached = reached;
  }

  function showCostCapNotice(anchor = null, { force = false, noticeKey = "global" } = {}) {
    if (force) {
      dismissedCostCapNoticeKeys = new Set();
    }
    if (dismissedCostCapNoticeKeys.has(noticeKey)) return;
    activeCostCapNoticeKeys.add(noticeKey);
    if (!costCapNotice) {
      costCapNotice = document.createElement("div");
      costCapNotice.className = "ol-lean-cost-cap-notice";
      costCapNotice.setAttribute("role", "alert");
      costCapNotice.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      costCapNotice.innerHTML = `
        <div>
          <strong>Cost cap reached</strong>
          <span>Lea stopped because the configured spend limit was reached.</span>
        </div>
        <button type="button" aria-label="Dismiss cost cap notice">x</button>
      `;
      costCapNotice.querySelector("button").addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        for (const key of activeCostCapNoticeKeys) {
          dismissedCostCapNoticeKeys.add(key);
        }
        dismissedCostCapNoticeKeys.add(maxSpendNoticeKeyFromStatuses(latestStatuses));
        removeCostCapNotice();
      });
      document.body.appendChild(costCapNotice);
    }
    positionCostCapNotice(anchor);
  }

  function positionCostCapNotice(anchor = null) {
    if (!costCapNotice) return;
    const settingsPopover = activePopover?.classList?.contains("ol-lean-settings-popover")
      ? activePopover
      : null;
    const target = anchor?.isConnected
      ? anchor
      : settingsPopover?.isConnected
        ? settingsPopover
        : settingsButton?.isConnected
          ? settingsButton
          : null;
    const noticeRect = costCapNotice.getBoundingClientRect();
    const gap = 10;
    if (!target) {
      costCapNotice.dataset.position = "floating";
      costCapNotice.style.left = `${Math.max(12, window.innerWidth - noticeRect.width - 20)}px`;
      costCapNotice.style.top = `${Math.max(12, window.innerHeight - noticeRect.height - 20)}px`;
      return;
    }
    const targetRect = target.getBoundingClientRect();
    const belowTop = targetRect.bottom + gap;
    const fitsBelow = belowTop + noticeRect.height <= window.innerHeight - 12;
    const top = fitsBelow
      ? belowTop
      : Math.max(12, targetRect.top - noticeRect.height - gap);
    const left = Math.min(
      Math.max(12, targetRect.right - noticeRect.width),
      window.innerWidth - noticeRect.width - 12
    );
    costCapNotice.dataset.position = fitsBelow ? "below" : "above";
    costCapNotice.style.left = `${left}px`;
    costCapNotice.style.top = `${top}px`;
  }

  function removeCostCapNotice() {
    if (!costCapNotice) return;
    costCapNotice.remove();
    costCapNotice = null;
    activeCostCapNoticeKeys = new Set();
  }

  function isMaxSpendStatus(statusInfo) {
    return String(statusInfo?.message || "").includes("Max spend limit") ||
      String(statusInfo?.finalStatus || "").toLowerCase() === "max_spend";
  }

  function maxSpendNoticeKeyFromStatuses(statuses) {
    const parts = [];
    for (const [theoremLabel, statusInfo] of Object.entries(statuses || {})) {
      if (!isMaxSpendStatus(statusInfo)) continue;
      parts.push([
        theoremLabel,
        statusInfo.jobId || "",
        statusInfo.finishedAt || "",
        statusInfo.message || ""
      ].join(":"));
    }
    return parts.sort().join("|");
  }

  function isMaxSpendError(error) {
    return String(error instanceof Error ? error.message : error).includes("Max spend limit");
  }

  function normalizeMaxSpendInput(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    const number = Number(trimmed);
    return Number.isFinite(number) && number >= 0 ? String(number) : trimmed;
  }

  function parseMaxSpendInput(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return null;
    const number = Number(trimmed);
    if (!Number.isFinite(number) || number < 0) {
      throw new Error("Cost cap must be a non-negative dollar amount.");
    }
    return number;
  }

  function formatTokens(value) {
    const number = Number(value) || 0;
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
    return String(number);
  }

  function formatCost(value) {
    const number = Number(value) || 0;
    if (number > 0 && number < 0.01) return "<$0.01";
    return `$${number.toFixed(2)}`;
  }

  function isExtensionContextInvalidated() {
    return !globalThis.chrome?.runtime?.id;
  }

  function normalizeErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Extension context invalidated/i.test(message)) {
      return "Extension was reloaded. Refresh this Overleaf tab.";
    }
    return message;
  }

  function rememberTheorem(theorem) {
    if (!theorem?.label) return;
    const existingIndex = latestTheorems.findIndex((item) => item.label === theorem.label);
    if (existingIndex === -1) {
      latestTheorems = [...latestTheorems, theorem];
      return;
    }
    latestTheorems = latestTheorems.map((item, index) => (index === existingIndex ? theorem : item));
  }

  function extractOverleafProjectId() {
    const match = location.pathname.match(/\/project\/([^/]+)/);
    return match ? match[1] : "unknown";
  }

  function normalizeTheoremText(text) {
    return String(text).replace(/\s+/g, " ").trim();
  }

  async function sha256(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function injectPageBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("pageBridge.js");
    script.onload = () => script.remove();
    const target = document.documentElement || document.head || document.body;
    if (target) {
      target.appendChild(script);
      return;
    }
    document.addEventListener("DOMContentLoaded", () => {
      (document.documentElement || document.head || document.body).appendChild(script);
    }, { once: true });
  }

  function requestTheoremsSoon() {
    requestTheorems();
    setTimeout(requestTheorems, 300);
    setTimeout(requestTheorems, 1000);
  }

  function requestTheorems() {
    window.postMessage({ type: "OL_LEAN_REQUEST_THEOREMS" }, "*");
  }
})();

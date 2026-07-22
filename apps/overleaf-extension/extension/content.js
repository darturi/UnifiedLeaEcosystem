(function () {
  const DEFAULT_COMPANION_URL = "http://127.0.0.1:31245";
  const DEFAULT_LEA_UI_BASE_URL = "http://localhost:5173";
  // Placeholder only, used before the first successful /settings fetch; the
  // companion (backed by packages/lea-model-catalog) is authoritative and may
  // re-map it. Keep in sync with the catalog default and options.js (AUDIT L9).
  const DEFAULT_LEA_MODEL = "o4-mini";
  const DEFAULT_LEA_MAX_TURNS = 20;
  const DEFAULT_LEA_TEX_MIRROR_ENABLED = true;
  const LEA_UI_VIEW_STATUSES = new Set(["formalized", "defined", "disproved", "in_progress", "sorry_stub"]);
  const TEX_MIRROR_SYNC_DELAY_MS = 1500;
  const TEX_MIRROR_FULL_SYNC_INTERVAL_MS = 10 * 60 * 1000;
  const LEAN_PANE_REFRESH_DELAY_MS = 1500;
  const LEAN_PANE_POLL_DELAY_MS = 4000;
  const LEAN_PANE_WIDTH_STORAGE_KEY = "leanPaneWidthPx";
  const DEFAULT_LEAN_PANE_WIDTH_PX = 520;
  const MIN_LEAN_PANE_WIDTH_PX = 360;
  const LEAN_PANE_VIEWPORT_GUTTER_PX = 24;
  const LEAN_PANE_KEYBOARD_STEP_PX = 24;
  const LEAN_PANE_KEYBOARD_LARGE_STEP_PX = 80;
  // Short debounce for an edit-triggered status refresh; a much longer cadence
  // for the in-progress self-poll so an active run doesn't hammer /statuses
  // (each hit does per-target FS scans + adapter fetches) four times a second
  // (AUDIT M4).
  const STATUS_REFRESH_DEBOUNCE_MS = 250;
  const STATUS_REFRESH_IN_PROGRESS_MS = 3000;
  // Push channel (PLAN-system-hardening 3.1): while the companion's /events
  // stream is connected, the fast polls stretch to these slow reconciliation
  // cadences — pushes drive updates, polls only catch missed events. When the
  // stream drops, the schedulers fall back to the fast cadences above.
  const STATUS_REFRESH_RECONCILE_MS = 30000;
  const LEAN_PANE_POLL_RECONCILE_MS = 60000;
  const LEAN_PANE_CHAT_POLL_RECONCILE_MS = 30000;
  const REPAIR_BATCH_POLL_MS = 2000;
  const REPAIR_BATCH_POLL_RECONCILE_MS = 30000;
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
  let latestTargets = [];
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
  // When the last zip-download full sync ran (PLAN 3.2): ordinary edits ship
  // only the active buffer; the zip refresh happens on this cadence.
  let lastTexMirrorFullSyncAt = 0;
  let latestStatuses = {};
  let badgeLayer = null;
  let settingsButton = null;
  let leanPaneButton = null;
  let leanPane = null;
  let leanPaneBody = null;
  let leanPaneStatus = null;
  let leanPaneProjectTitle = null;
  let leanPaneProjectNamespace = null;
  let leanPaneWidthPx = DEFAULT_LEAN_PANE_WIDTH_PX;
  let leanPaneResizeState = null;
  let leanPaneRefreshTimer = null;
  let leanPanePollTimer = null;
  let leanPaneView = null;
  let leanPaneExpandedTreeNodeIds = new Set();
  let leanPaneTreeDefaultsKey = "";
  let leanPaneExpandedItemIds = new Set();
  let leanPaneHighlightTimer = null;
  let lastLeanPaneManifest = null;
  let lastProjectIdentity = null;
  let lastLeanPaneFiles = null;
  let lastLeanPaneProjectId = "";
  // Share panel (D34): remote + push against the adapter's project repo, via the
  // companion's /share/github passthroughs. One panel, toggled from the header.
  let leanPaneSharePanel = null;
  let leanPaneShareState = null;
  let leanPaneShareBusy = false;
  // Lean-pane chat mirror: a compact view of the same adapter session the full
  // Lea UI uses. One panel at a time; `leanPaneChatToken` invalidates stale
  // fetch/poll callbacks when the user switches items or closes the panel.
  let leanPaneChatPanel = null;
  let leanPaneChatItem = null;
  let leanPaneChatTarget = null;
  let leanPaneChatResponse = null;
  let leanPaneChatSessionId = "";
  let leanPaneChatRunId = "";
  let leanPaneChatLoading = false;
  let leanPaneChatSending = false;
  let leanPaneChatError = null;
  let leanPaneChatOptimistic = [];
  let leanPaneChatPollTimer = null;
  let leanPaneChatToken = 0;
  // Blueprint view (FEATURE-overleaf-blueprint-view): the Lean pane has two top-level
  // views over the same project — the document-driven "Items" tree (default) and the
  // read-only "Blueprint" dependency graph. `leanPaneBlueprintView` is the lazily
  // imported renderer; the graph + selection are cached so a node click re-renders
  // without a refetch. All reset on pane open/close.
  let leanPaneMainView = "items"; // "items" | "blueprint"
  let leanPaneBlueprintView = null;
  let leanPaneBlueprintToggle = null; // { items, blueprint } header buttons
  let leanPaneBlueprintGraph = null; // last fetched { nodes, edges, exists }
  let leanPaneBlueprintSelectedKey = null;
  let leanPaneBlueprintGenerateBtn = null; // the "Generate…" button, for the in-flight disable
  // Consecutive transient poll failures (AUDIT M2): a thrown fetch used to stop
  // polling entirely, freezing the panel on "Lea is working…". We now retry
  // with backoff up to this cap before giving up and surfacing the error.
  let leanPaneChatPollFailures = 0;
  const LEAN_PANE_CHAT_POLL_MAX_FAILURES = 5;
  // Manual edit (docs/FEATURE-overleaf-lean-pane-manual-edit.md): at most one
  // item's edit view is open at a time, tracked by item id the same way
  // leanPaneExpandedItemIds tracks expansion -- module state survives the
  // pane's full replaceChildren re-render.
  let leanPaneEditingItemId = "";
  let leanPaneEditDraft = "";
  let leanPaneEditPreSaveDependents = [];
  let leanPaneEditError = "";
  let leanPaneEditLastResult = null;
  // Self-repair (docs/FEATURE-overleaf-self-repair.md): the live batch (if
  // any) + the last repair dispatch error. Batch state is companion-side;
  // this holds only the latest /lean-pane/repair/status snapshot.
  let leanPaneRepairBatch = null;
  let leanPaneRepairBatchTimer = 0;
  // A repair DISPATCH failure, scoped to what was being dispatched:
  // { itemKey, message } with itemKey = the single item's target label, or
  // "batch" (PLAN-self-repair-stale-offers Fix 4 -- a global string rendered
  // under every broken item was itself a member of the stale-copy class).
  let leanPaneRepairError = null;
  // At most one item-card overflow ("More actions") menu is open at a time;
  // the same global click/Escape listeners that dismiss popovers close it.
  let activeOverflowMenu = null;
  let costCapNotice = null;
  let dismissedCostCapNoticeKeys = new Set();
  let activeCostCapNoticeKeys = new Set();
  let costCapUsageLimitReached = false;
  // Editor-hook watchdog (PLAN-system-hardening 0.4): warns when the editor is
  // visible but the page bridge never hooked Overleaf's UNSTABLE_ editor event
  // — i.e. Overleaf changed and the integration is silently dead.
  let editorHookWatchdog = null;
  let editorHookSignalSeen = false;
  let editorHookWarningBanner = null;
  // Push channel (PLAN 3.1): one EventSource on the companion's /events.
  // pushConnected is consulted by every poll scheduler when picking a delay.
  let eventsClient = null;
  let pushConnected = false;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "OL_LEAN_EDITOR_HOOKED") {
      editorHookSignalSeen = true;
      editorHookWatchdog?.editorHooked();
      return;
    }
    if (event.data?.type === "OL_LEAN_TARGET_CLICK") {
      rememberTarget(event.data.target);
      showTargetPopover(event.data.clientX, event.data.clientY, event.data.target);
      return;
    }
    if (event.data?.type === "OL_LEAN_DIAGNOSTIC_CLICK") {
      showDiagnosticPopover(event.data.clientX, event.data.clientY, event.data.diagnostic || event.data.target);
      return;
    }
    if (event.data?.type === "OL_LEAN_NAVIGATE_RESULT") {
      if (!event.data.ok && leanPaneStatus) {
        const file = event.data.sourceFile || "the source file";
        leanPaneStatus.textContent = `Couldn't open ${file} automatically. Open it in Overleaf, then click "Go to source" again.`;
      }
      return;
    }
    if (event.data?.type === "OL_LEAN_TARGETS_VISIBLE") {
      const nextActiveTex = typeof event.data.activeTex === "string" ? event.data.activeTex : "";
      const nextProjectId = extractOverleafProjectId();
      const activeTexChanged = nextActiveTex !== latestActiveTex || nextProjectId !== latestActiveTexProjectId;
      latestTargets = event.data.targets || [];
      latestDiagnostics = event.data.diagnostics || [];
      latestActiveTex = nextActiveTex;
      latestActiveTexPath = typeof event.data.activePath === "string" ? event.data.activePath : latestActiveTexPath;
      latestActiveTexProjectId = nextProjectId;
      renderStatusBadges();
      if (activeTexChanged) {
        texMirrorDirty = true;
        scheduleTexMirrorSync();
        if (leanPane) scheduleLeanPaneRefresh();
      }
      scheduleStatusRefresh();
    }
  });

  injectPageBridge();
  startEditorHookWatchdog();
  startEventsClient();
  requestTargetsSoon();
  renderSettingsButton();
  renderLeanPaneButton();
  hydrateLeanPaneWidthFromStorage();

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (activeOverflowMenu) {
      closeActiveOverflowMenu();
      return;
    }
    if (activePopover) {
      closePopover();
      return;
    }
    if (leanPane) closeLeanPane();
  });

  document.addEventListener("click", (event) => {
    if (activeOverflowMenu && !activeOverflowMenu.wrap.contains(event.target)) {
      closeActiveOverflowMenu();
    }
    if (activePopover && !activePopover.contains(event.target)) {
      closePopover();
    }
  });

  window.addEventListener("resize", () => {
    renderStatusBadges();
    clampOpenLeanPaneToViewport();
  });
  // Capture-phase scroll fires very frequently; coalesce to one update per
  // animation frame (AUDIT M4) instead of re-parsing the whole document and
  // re-laying out every badge on every scroll tick.
  let scrollRafPending = false;
  window.addEventListener("scroll", () => {
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      requestTargets();
      renderStatusBadges();
    });
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

  function renderLeanPaneButton() {
    if (leanPaneButton) return;
    leanPaneButton = document.createElement("button");
    leanPaneButton.type = "button";
    leanPaneButton.className = "ol-lean-pane-trigger";
    leanPaneButton.setAttribute("aria-label", "Open Lean project pane");
    leanPaneButton.title = "Lean project pane";
    const mark = document.createElement("span");
    mark.className = "ol-lean-trigger-mark";
    mark.textContent = "Π";
    leanPaneButton.appendChild(mark);
    leanPaneButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (leanPane) {
        closeLeanPane();
      } else {
        showLeanPane();
      }
    });
    (document.body || document.documentElement).appendChild(leanPaneButton);
  }

  function showLeanPane({ deferRefresh = false, preservePopover = false } = {}) {
    if (!preservePopover) closePopover();
    if (leanPane) return;
    // Fresh pane always opens on the Items view with no blueprint selection.
    leanPaneMainView = "items";
    leanPaneBlueprintGraph = null;
    leanPaneBlueprintSelectedKey = null;
    leanPane = document.createElement("aside");
    leanPane.className = "ol-lean-project-pane";
    leanPane.setAttribute("role", "complementary");
    leanPane.setAttribute("aria-label", "Lean project pane");
    leanPane.tabIndex = -1;
    applyLeanPaneWidth();

    const resizer = document.createElement("button");
    resizer.type = "button";
    resizer.className = "ol-lean-project-pane-resizer";
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-orientation", "vertical");
    resizer.setAttribute("aria-label", "Resize Lean pane");
    resizer.title = "Resize Lean pane";
    resizer.tabIndex = 0;
    resizer.addEventListener("pointerdown", startLeanPaneResize);
    resizer.addEventListener("mousedown", startLeanPaneResize);
    resizer.addEventListener("keydown", handleLeanPaneResizeKeydown);

    const header = document.createElement("div");
    header.className = "ol-lean-project-pane-header";
    const titleWrap = document.createElement("div");
    const paneLabel = document.createElement("span");
    paneLabel.className = "ol-lean-sr-only";
    paneLabel.textContent = "Lean pane";
    const kicker = document.createElement("p");
    kicker.className = "ol-lean-project-pane-kicker";
    kicker.textContent = "Project preview";
    const title = document.createElement("h2");
    title.textContent = "Lean pane";
    leanPaneProjectTitle = title;
    leanPaneProjectNamespace = document.createElement("p");
    leanPaneProjectNamespace.className = "ol-lean-project-pane-namespace";
    leanPaneProjectNamespace.textContent = "Lean namespace: --";
    titleWrap.appendChild(paneLabel);
    titleWrap.appendChild(kicker);
    titleWrap.appendChild(title);
    titleWrap.appendChild(leanPaneProjectNamespace);

    const controls = document.createElement("div");
    controls.className = "ol-lean-project-pane-controls";
    // Export lives inside the Share panel (one header entry for everything
    // that moves the project off this page: zip download + GitHub push).
    const shareButton = document.createElement("button");
    shareButton.type = "button";
    shareButton.className = "ol-lean-pane-action";
    shareButton.title = "Share or export the Lean project";
    shareButton.textContent = "Share";
    shareButton.addEventListener("click", () => {
      toggleSharePanel().catch(renderLeanPaneError);
    });
    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "ol-lean-pane-action";
    renameButton.title = "Edit project name";
    renameButton.textContent = "Rename";
    renameButton.addEventListener("click", () => {
      openProjectIdentityEditor({ source: "lean-pane" }).catch(renderLeanPaneError);
    });
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "ol-lean-icon-button";
    refresh.title = "Refresh Lean pane";
    refresh.setAttribute("aria-label", "Refresh Lean pane");
    refresh.textContent = "↻";
    refresh.addEventListener("click", () => {
      refreshLeanPaneNow({ forceFetch: true }).catch(renderLeanPaneError);
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ol-lean-icon-button";
    close.title = "Close Lean pane";
    close.setAttribute("aria-label", "Close Lean pane");
    close.textContent = "x";
    close.addEventListener("click", closeLeanPane);
    controls.appendChild(shareButton);
    controls.appendChild(renameButton);
    controls.appendChild(refresh);
    controls.appendChild(close);
    header.appendChild(titleWrap);
    header.appendChild(controls);

    const viewTabs = buildLeanPaneViewTabs();

    leanPaneStatus = document.createElement("p");
    leanPaneStatus.className = "ol-lean-project-pane-status";
    leanPaneBody = document.createElement("div");
    leanPaneBody.className = "ol-lean-project-pane-body";

    leanPane.appendChild(resizer);
    leanPane.appendChild(header);
    leanPane.appendChild(viewTabs);
    leanPane.appendChild(leanPaneStatus);
    leanPane.appendChild(leanPaneBody);
    document.body.appendChild(leanPane);
    leanPane.focus({ preventScroll: true });
    if (!deferRefresh) {
      refreshLeanPaneNow({ forceFetch: true }).catch(renderLeanPaneError);
    }
  }

  function closeLeanPane() {
    clearTimeout(leanPaneRefreshTimer);
    leanPaneRefreshTimer = null;
    clearTimeout(leanPanePollTimer);
    leanPanePollTimer = null;
    clearTimeout(leanPaneHighlightTimer);
    leanPaneHighlightTimer = null;
    stopLeanPaneResize({ persist: false });
    closeLeanPaneChat();
    closeActiveOverflowMenu();
    leanPaneSharePanel = null;
    leanPaneShareState = null;
    leanPaneShareBusy = false;
    if (!leanPane) return;
    leanPane.remove();
    leanPane = null;
    leanPaneBody = null;
    leanPaneStatus = null;
    leanPaneProjectTitle = null;
    leanPaneProjectNamespace = null;
    leanPaneExpandedTreeNodeIds = new Set();
    leanPaneTreeDefaultsKey = "";
    leanPaneMainView = "items";
    leanPaneBlueprintToggle = null;
    leanPaneBlueprintGraph = null;
    leanPaneBlueprintSelectedKey = null;
    leanPaneBlueprintGenerateBtn = null;
  }

  function hydrateLeanPaneWidthFromStorage() {
    if (isExtensionContextInvalidated()) return;
    chrome.storage.sync.get({ [LEAN_PANE_WIDTH_STORAGE_KEY]: DEFAULT_LEAN_PANE_WIDTH_PX })
      .then((settings) => {
        leanPaneWidthPx = clampLeanPaneWidth(settings?.[LEAN_PANE_WIDTH_STORAGE_KEY]);
        applyLeanPaneWidth();
      })
      .catch(() => {
        leanPaneWidthPx = clampLeanPaneWidth(DEFAULT_LEAN_PANE_WIDTH_PX);
        applyLeanPaneWidth();
      });
  }

  function maxLeanPaneWidthPx() {
    const viewportWidth = Number(window.innerWidth) || DEFAULT_LEAN_PANE_WIDTH_PX + LEAN_PANE_VIEWPORT_GUTTER_PX;
    return Math.max(MIN_LEAN_PANE_WIDTH_PX, viewportWidth - LEAN_PANE_VIEWPORT_GUTTER_PX);
  }

  function clampLeanPaneWidth(width) {
    const numeric = Number.parseInt(String(width), 10);
    const fallback = Number.isFinite(numeric) ? numeric : DEFAULT_LEAN_PANE_WIDTH_PX;
    return Math.min(Math.max(fallback, MIN_LEAN_PANE_WIDTH_PX), maxLeanPaneWidthPx());
  }

  function applyLeanPaneWidth(width = leanPaneWidthPx) {
    leanPaneWidthPx = clampLeanPaneWidth(width);
    if (leanPane) {
      leanPane.style.setProperty("--ol-lean-pane-width", `${leanPaneWidthPx}px`);
    }
    return leanPaneWidthPx;
  }

  function persistLeanPaneWidth() {
    if (isExtensionContextInvalidated()) return;
    chrome.storage.sync.set({ [LEAN_PANE_WIDTH_STORAGE_KEY]: leanPaneWidthPx }).catch(() => {});
  }

  function clampOpenLeanPaneToViewport() {
    const nextWidth = clampLeanPaneWidth(leanPaneWidthPx);
    if (nextWidth === leanPaneWidthPx) return;
    applyLeanPaneWidth(nextWidth);
    persistLeanPaneWidth();
  }

  function startLeanPaneResize(event) {
    if (!leanPane || leanPaneResizeState) return;
    if (event.type === "mousedown" && event.button !== undefined && event.button !== 0) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    leanPaneResizeState = {
      startClientX: Number(event.clientX) || 0,
      startWidth: leanPaneWidthPx,
      pointerId: event.pointerId,
      usingPointer: event.type === "pointerdown"
    };
    leanPane.classList.add("ol-lean-project-pane-resizing");
    document.body?.classList?.add("ol-lean-pane-resizing");
    if (leanPaneResizeState.usingPointer) {
      document.addEventListener("pointermove", handleLeanPaneResizeMove, true);
      document.addEventListener("pointerup", finishLeanPaneResize, true);
      document.addEventListener("pointercancel", cancelLeanPaneResize, true);
    } else {
      document.addEventListener("mousemove", handleLeanPaneResizeMove, true);
      document.addEventListener("mouseup", finishLeanPaneResize, true);
    }
  }

  function handleLeanPaneResizeMove(event) {
    if (!leanPaneResizeState) return;
    if (leanPaneResizeState.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== leanPaneResizeState.pointerId) return;
    event.preventDefault?.();
    const currentClientX = Number(event.clientX) || 0;
    const delta = leanPaneResizeState.startClientX - currentClientX;
    applyLeanPaneWidth(leanPaneResizeState.startWidth + delta);
  }

  function finishLeanPaneResize(event) {
    event?.preventDefault?.();
    stopLeanPaneResize({ persist: true });
  }

  function cancelLeanPaneResize(event) {
    event?.preventDefault?.();
    stopLeanPaneResize({ persist: false });
  }

  function stopLeanPaneResize({ persist }) {
    if (!leanPaneResizeState) return;
    const usingPointer = leanPaneResizeState.usingPointer;
    leanPaneResizeState = null;
    if (usingPointer) {
      document.removeEventListener?.("pointermove", handleLeanPaneResizeMove, true);
      document.removeEventListener?.("pointerup", finishLeanPaneResize, true);
      document.removeEventListener?.("pointercancel", cancelLeanPaneResize, true);
    } else {
      document.removeEventListener?.("mousemove", handleLeanPaneResizeMove, true);
      document.removeEventListener?.("mouseup", finishLeanPaneResize, true);
    }
    leanPane?.classList.remove("ol-lean-project-pane-resizing");
    document.body?.classList?.remove("ol-lean-pane-resizing");
    if (persist) persistLeanPaneWidth();
  }

  function handleLeanPaneResizeKeydown(event) {
    let nextWidth = null;
    const step = event.shiftKey ? LEAN_PANE_KEYBOARD_LARGE_STEP_PX : LEAN_PANE_KEYBOARD_STEP_PX;
    if (event.key === "ArrowLeft") nextWidth = leanPaneWidthPx + step;
    else if (event.key === "ArrowRight") nextWidth = leanPaneWidthPx - step;
    else if (event.key === "Home") nextWidth = MIN_LEAN_PANE_WIDTH_PX;
    else if (event.key === "End") nextWidth = maxLeanPaneWidthPx();
    if (nextWidth === null) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    applyLeanPaneWidth(nextWidth);
    persistLeanPaneWidth();
  }

  // ── Export & GitHub sharing (D34) ──────────────────────────────────────────
  // Both actions go through the companion (never :8001 directly): the zip is
  // streamed from GET /project-export, and the share panel drives the
  // /share/github status/remote/push passthroughs. All git/token mechanics stay
  // in the adapter.

  async function exportLeanProject(button) {
    const projectId = extractOverleafProjectId();
    const baseUrl = await chatCompanionBaseUrl();
    const view = await ensureLeanPaneView();
    if (button) button.disabled = true;
    if (leanPaneStatus) leanPaneStatus.textContent = "Preparing the project zip...";
    try {
      const response = await fetch(
        `${baseUrl}/project-export?overleafProjectId=${encodeURIComponent(projectId)}`
      );
      if (!response.ok) {
        let message = `Export failed (HTTP ${response.status}).`;
        try {
          message = (await response.json())?.message || message;
        } catch { /* keep the fallback */ }
        if (leanPaneStatus) leanPaneStatus.textContent = message;
        return;
      }
      const blob = await response.blob();
      const filename = view.filenameFromContentDisposition(
        response.headers.get("content-disposition"),
        "lean-project.zip"
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      if (leanPaneStatus) leanPaneStatus.textContent = `Downloaded ${filename}.`;
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function toggleSharePanel() {
    if (leanPaneSharePanel) {
      leanPaneSharePanel.remove();
      leanPaneSharePanel = null;
      return;
    }
    if (!leanPane) return;
    await ensureLeanPaneView();

    const panel = document.createElement("div");
    panel.className = "ol-lean-share-panel";
    panel.innerHTML = `
      <label class="ol-lean-share-remote">
        <span>GitHub remote</span>
        <input type="url" autocomplete="off" spellcheck="false" placeholder="https://github.com/you/repo" data-role="share-remote">
      </label>
      <div class="ol-lean-share-actions">
        <button type="button" class="ol-lean-provider-key-button" data-role="share-save">Save remote</button>
        <button type="button" class="ol-lean-save-button" data-role="share-push">Push to GitHub</button>
      </div>
      <div class="ol-lean-share-actions">
        <button type="button" class="ol-lean-provider-key-button" data-role="share-export" title="Download the Lean project as a zip">Download .zip</button>
      </div>
      <p class="ol-lean-share-hint" data-role="share-hint" hidden></p>
      <p class="ol-lean-share-status" role="status" data-role="share-status">Loading share status...</p>
    `;
    leanPane.insertBefore(panel, leanPaneStatus);
    leanPaneSharePanel = panel;

    const input = panel.querySelector("[data-role='share-remote']");
    input.addEventListener("input", () => renderShareControls());
    panel.querySelector("[data-role='share-save']").addEventListener("click", () => {
      saveShareRemote().catch((error) => setShareStatus(errorText(error)));
    });
    panel.querySelector("[data-role='share-push']").addEventListener("click", () => {
      pushShareRemote().catch((error) => setShareStatus(errorText(error)));
    });
    const exportButton = panel.querySelector("[data-role='share-export']");
    exportButton?.addEventListener("click", () => {
      exportLeanProject(exportButton).catch((error) => setShareStatus(errorText(error)));
    });

    try {
      await loadShareStatus();
    } catch (error) {
      setShareStatus(errorText(error));
    }
  }

  async function loadShareStatus() {
    const projectId = extractOverleafProjectId();
    const baseUrl = await chatCompanionBaseUrl();
    const response = await fetch(
      `${baseUrl}/share/github?overleafProjectId=${encodeURIComponent(projectId)}`
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.message || `Could not load share status (HTTP ${response.status}).`);
    }
    leanPaneShareState = {
      exists: Boolean(body.exists),
      remoteUrl: body.remoteUrl || null,
      tokenConfigured: Boolean(body.tokenConfigured)
    };
    const input = leanPaneSharePanel?.querySelector("[data-role='share-remote']");
    if (input) input.value = leanPaneShareState.remoteUrl || "";
    setShareStatus("");
    renderShareControls();
  }

  function renderShareControls() {
    if (!leanPaneSharePanel) return;
    const input = leanPaneSharePanel.querySelector("[data-role='share-remote']");
    const save = leanPaneSharePanel.querySelector("[data-role='share-save']");
    const push = leanPaneSharePanel.querySelector("[data-role='share-push']");
    const hint = leanPaneSharePanel.querySelector("[data-role='share-hint']");
    const controls = leanPaneView.deriveShareControls({
      exists: Boolean(leanPaneShareState?.exists),
      remoteUrl: leanPaneShareState?.remoteUrl || null,
      draftRemote: input?.value,
      tokenConfigured: Boolean(leanPaneShareState?.tokenConfigured),
      busy: leanPaneShareBusy
    });
    if (input) input.disabled = leanPaneShareBusy || !leanPaneShareState?.exists;
    if (save) save.disabled = !controls.canSave;
    if (push) {
      push.disabled = !controls.canPush;
      push.textContent = leanPaneShareBusy ? "Working..." : "Push to GitHub";
    }
    if (hint) {
      hint.textContent = controls.hint;
      hint.hidden = !controls.hint;
    }
  }

  function setShareStatus(text) {
    const status = leanPaneSharePanel?.querySelector("[data-role='share-status']");
    if (status) status.textContent = text || "";
  }

  async function saveShareRemote() {
    const input = leanPaneSharePanel?.querySelector("[data-role='share-remote']");
    const remoteUrl = String(input?.value || "").trim();
    if (!remoteUrl) return;
    const projectId = extractOverleafProjectId();
    const baseUrl = await chatCompanionBaseUrl();
    leanPaneShareBusy = true;
    renderShareControls();
    setShareStatus("Saving remote...");
    try {
      const response = await fetch(`${baseUrl}/share/github/remote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overleafProjectId: projectId, remoteUrl })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setShareStatus(body?.message || `Could not save the remote (HTTP ${response.status}).`);
        return;
      }
      leanPaneShareState = { ...leanPaneShareState, remoteUrl: body.remoteUrl || remoteUrl };
      if (input) input.value = leanPaneShareState.remoteUrl;
      setShareStatus("Remote saved.");
    } finally {
      leanPaneShareBusy = false;
      renderShareControls();
    }
  }

  async function pushShareRemote() {
    const remote = leanPaneShareState?.remoteUrl;
    if (!remote) return;
    if (!window.confirm(`Push this project to ${remote}?\n\nThis pushes the Lea project's commits to the repo's main branch.`)) {
      return;
    }
    const projectId = extractOverleafProjectId();
    const baseUrl = await chatCompanionBaseUrl();
    leanPaneShareBusy = true;
    renderShareControls();
    setShareStatus("Pushing to GitHub...");
    try {
      const response = await fetch(`${baseUrl}/share/github/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overleafProjectId: projectId })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setShareStatus(body?.message || `Push failed (HTTP ${response.status}).`);
        return;
      }
      setShareStatus(`Pushed to ${body.remoteUrl || remote}.`);
    } finally {
      leanPaneShareBusy = false;
      renderShareControls();
    }
  }

  function errorText(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // Load the pure pane helpers once. The pane is only built on user click (well
  // after startup), so a lazy import here always resolves before any render runs.
  async function ensureLeanPaneView() {
    if (leanPaneView) return leanPaneView;
    leanPaneView = await import(chrome.runtime.getURL("leanPaneView.mjs"));
    return leanPaneView;
  }

  // Lazily load the blueprint graph renderer (imports the shared, mirrored
  // blueprintLayout.mjs). Only pulled in the first time the Blueprint tab is opened.
  async function ensureBlueprintPaneView() {
    if (leanPaneBlueprintView) return leanPaneBlueprintView;
    leanPaneBlueprintView = await import(chrome.runtime.getURL("blueprintPaneView.mjs"));
    return leanPaneBlueprintView;
  }

  // The Items | Blueprint segmented control in the pane header.
  function buildLeanPaneViewTabs() {
    const tabs = document.createElement("div");
    tabs.className = "ol-lean-pane-viewtabs";
    tabs.setAttribute("role", "tablist");
    const make = (view, label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ol-lean-pane-viewtab";
      button.textContent = label;
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => {
        setLeanPaneMainView(view).catch(renderLeanPaneError);
      });
      return button;
    };
    const items = make("items", "Items");
    const blueprint = make("blueprint", "Blueprint");
    tabs.appendChild(items);
    tabs.appendChild(blueprint);
    leanPaneBlueprintToggle = { items, blueprint };
    updateLeanPaneViewTabs();
    return tabs;
  }

  function updateLeanPaneViewTabs() {
    if (!leanPaneBlueprintToggle) return;
    for (const [view, button] of Object.entries(leanPaneBlueprintToggle)) {
      const active = leanPaneMainView === view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  // Switch the pane's top-level view. Items re-renders from the cached manifest when
  // one exists (no refetch); Blueprint fetches + renders its graph.
  async function setLeanPaneMainView(view) {
    if (view === leanPaneMainView || !leanPane) return;
    leanPaneMainView = view;
    updateLeanPaneViewTabs();
    if (view === "blueprint") {
      closeLeanPaneChat();
      closeActiveOverflowMenu();
      await renderLeanPaneBlueprint({});
      return;
    }
    // Back to Items: cheap re-render from cache, else a fresh refresh.
    if (lastLeanPaneManifest) {
      renderLeanPaneManifest(lastLeanPaneManifest);
      scheduleLeanPanePollIfNeeded(lastLeanPaneManifest);
    } else {
      await refreshLeanPaneNow({ forceFetch: false });
    }
  }

  // Fetch the project's blueprint graph from the companion and render it (or the
  // appropriate empty/error state). Guards against a view switch mid-fetch.
  async function renderLeanPaneBlueprint({ background = false } = {}) {
    if (!leanPane || !leanPaneBody || !leanPaneStatus) return;
    if (leanPaneMainView !== "blueprint") return;
    await ensureBlueprintPaneView();
    if (!background) {
      leanPaneStatus.textContent = "Loading blueprint…";
      leanPaneBody.replaceChildren();
    }

    const projectId = extractOverleafProjectId();
    const settings = await getSettings();
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    try {
      const identity = await loadProjectIdentity({ baseUrl, projectId });
      lastProjectIdentity = identity;
      renderLeanPaneProjectIdentity(identity);
    } catch {}

    let payload;
    try {
      const response = await fetch(
        `${baseUrl}/project/graph?overleafProjectId=${encodeURIComponent(projectId)}`,
      );
      payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
      }
    } catch (error) {
      if (leanPaneMainView !== "blueprint" || !leanPaneBody) return;
      leanPaneStatus.textContent = "Blueprint unavailable.";
      leanPaneBody.replaceChildren(buildBlueprintToolbar(), buildBlueprintMessage(errorText(error), "error"));
      return;
    }

    if (leanPaneMainView !== "blueprint") return; // toggled away mid-fetch
    leanPaneBlueprintGraph = payload;
    renderBlueprintBody(payload);
  }

  // Render the cached graph payload into the body: no-project / empty / populated.
  // Always leads with the Refresh + Generate toolbar. Called on fetch and on every
  // node-selection change (cheap, self-contained).
  function renderBlueprintBody(payload) {
    if (!leanPaneBody || !leanPaneStatus || leanPaneMainView !== "blueprint") return;
    const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
    const edges = Array.isArray(payload?.edges) ? payload.edges : [];
    const prevScrollTop = leanPaneBody.scrollTop;
    leanPaneBody.replaceChildren(buildBlueprintToolbar());

    if (payload && payload.exists === false) {
      leanPaneStatus.textContent = "No Lea project yet.";
      leanPaneBody.appendChild(
        buildBlueprintMessage(
          "No Lea project for this document yet — formalize a theorem to start one.",
          "empty",
        ),
      );
      return;
    }
    if (nodes.length === 0) {
      leanPaneStatus.textContent = "Blueprint is empty.";
      leanPaneBody.appendChild(
        buildBlueprintMessage(
          "No blueprint nodes yet. Click “Generate from formalized theorems” above to build a starter graph from what you've formalized — or add nodes in the Lea UI.",
          "empty",
        ),
      );
      return;
    }

    leanPaneStatus.textContent = `${nodes.length} blueprint node${nodes.length === 1 ? "" : "s"}.`;
    const element = leanPaneBlueprintView.renderBlueprintView(
      { nodes, edges },
      {
        selectedKey: leanPaneBlueprintSelectedKey,
        onSelectNode: (key) => {
          leanPaneBlueprintSelectedKey = key;
          renderBlueprintBody(leanPaneBlueprintGraph);
        },
      },
    );
    leanPaneBody.appendChild(element);
    leanPaneBody.scrollTop = prevScrollTop;
  }

  // The blueprint body's action row: Refresh (re-fetch the graph) + Generate
  // (populate .lea/blueprint.md from formalized artifacts). Present in every state.
  function buildBlueprintToolbar() {
    const bar = document.createElement("div");
    bar.className = "ol-lean-blueprint-toolbar";

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "ol-lean-pane-action";
    refresh.textContent = "Refresh";
    refresh.title = "Re-fetch the blueprint graph";
    refresh.addEventListener("click", () => {
      renderLeanPaneBlueprint({}).catch(renderLeanPaneError);
    });

    const generate = document.createElement("button");
    generate.type = "button";
    generate.className = "ol-lean-pane-action is-primary";
    generate.textContent = "Generate from formalized theorems";
    generate.title = "Add a blueprint node for each formalized theorem (safe to re-run)";
    generate.addEventListener("click", () => {
      generateBlueprint().catch(renderLeanPaneError);
    });
    leanPaneBlueprintGenerateBtn = generate;

    bar.appendChild(refresh);
    bar.appendChild(generate);
    return bar;
  }

  // POST the generate request, then render the returned graph and report what changed.
  async function generateBlueprint() {
    if (!leanPane || !leanPaneBody || !leanPaneStatus || leanPaneMainView !== "blueprint") return;
    if (leanPaneBlueprintGenerateBtn) {
      leanPaneBlueprintGenerateBtn.disabled = true;
      leanPaneBlueprintGenerateBtn.textContent = "Generating…";
    }
    leanPaneStatus.textContent = "Generating blueprint from formalized theorems…";

    const projectId = extractOverleafProjectId();
    const settings = await getSettings();
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    let payload;
    try {
      const response = await fetch(`${baseUrl}/project/blueprint/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overleafProjectId: projectId }),
      });
      payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
      }
    } catch (error) {
      if (leanPaneMainView !== "blueprint" || !leanPaneBody) return;
      leanPaneStatus.textContent = "Blueprint unavailable.";
      leanPaneBody.replaceChildren(buildBlueprintToolbar(), buildBlueprintMessage(errorText(error), "error"));
      return;
    }

    if (leanPaneMainView !== "blueprint") return;
    leanPaneBlueprintGraph = payload;
    leanPaneBlueprintSelectedKey = null;
    renderBlueprintBody(payload); // rebuilds the toolbar (button re-enabled) + graph

    // Overlay a result message over the node count renderBlueprintBody just set.
    if (payload.exists === false) {
      leanPaneStatus.textContent = "No Lea project for this document yet.";
    } else if (payload.added > 0) {
      leanPaneStatus.textContent = `Added ${payload.added} node${payload.added === 1 ? "" : "s"} from formalized theorems.`;
    } else if (Array.isArray(payload.nodes) && payload.nodes.length > 0) {
      leanPaneStatus.textContent = "Blueprint already covers your formalized theorems.";
    } else {
      leanPaneStatus.textContent = "No formalized theorems to generate from yet.";
    }
  }

  // A centered message block for the blueprint's empty / error states.
  function buildBlueprintMessage(text, kind) {
    const wrap = document.createElement("div");
    wrap.className = `ol-lean-blueprint-message${kind ? ` is-${kind}` : ""}`;
    const line = document.createElement("p");
    line.textContent = text;
    wrap.appendChild(line);
    return wrap;
  }

  // Edits to the open document re-render the pane from the cached file set with the
  // live buffer overlaid — a cheap, no-blink background refresh (no project download).
  function scheduleLeanPaneRefresh() {
    clearTimeout(leanPaneRefreshTimer);
    leanPaneRefreshTimer = setTimeout(() => {
      refreshLeanPaneNow({ background: true }).catch(renderLeanPaneError);
    }, LEAN_PANE_REFRESH_DELAY_MS);
  }

  // `forceFetch` re-downloads the project archive; `background` skips the blanking
  // "Loading…" state and preserves scroll, for edit-driven and poll refreshes.
  async function refreshLeanPaneNow({ forceFetch = false, background = false } = {}) {
    if (!leanPane || !leanPaneBody || !leanPaneStatus) return;
    clearTimeout(leanPaneRefreshTimer);
    leanPaneRefreshTimer = null;
    clearTimeout(leanPanePollTimer);
    leanPanePollTimer = null;
    // Blueprint view has its own (Items-independent) fetch + render — no file
    // archive, manifest, or in-progress poll. The header refresh button and the
    // edit-driven background refresh both land here.
    if (leanPaneMainView === "blueprint") {
      await renderLeanPaneBlueprint({ background });
      return;
    }
    await ensureLeanPaneView();
    if (!background) {
      leanPaneStatus.textContent = "Loading project inventory...";
      leanPaneBody.replaceChildren();
    }

    const projectId = extractOverleafProjectId();
    const files = await getLeanPaneProjectFiles({ projectId, forceFetch });
    const settings = await getSettings();
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    try {
      const identity = await loadProjectIdentity({ baseUrl, projectId });
      lastProjectIdentity = identity;
      renderLeanPaneProjectIdentity(identity);
    } catch {}
    const response = await fetch(`${baseUrl}/lean-pane/manifest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        overleafProjectId: projectId,
        activePath: latestActiveTexPath || "",
        files
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    renderLeanPaneManifest(payload);
    scheduleLeanPanePollIfNeeded(payload);
  }

  // Keep refreshing while any item is still being formalized; stop once it settles.
  function scheduleLeanPanePollIfNeeded(manifest) {
    if (!leanPane || !leanPaneView?.hasInProgressItems(manifest?.items)) return;
    clearTimeout(leanPanePollTimer);
    leanPanePollTimer = setTimeout(() => {
      refreshLeanPaneNow({ background: true }).catch(renderLeanPaneError);
    }, pushConnected ? LEAN_PANE_POLL_RECONCILE_MS : LEAN_PANE_POLL_DELAY_MS);
  }

  async function getLeanPaneProjectFiles({ projectId, forceFetch }) {
    if (!projectId || projectId === "unknown") {
      return latestActiveTexPath && typeof latestActiveTex === "string"
        ? [{ path: latestActiveTexPath, content: latestActiveTex }]
        : [];
    }
    const needFetch = leanPaneView.shouldRefetchLeanPaneFiles({
      forceFetch,
      lastFiles: lastLeanPaneFiles,
      lastProjectId: lastLeanPaneProjectId,
      projectId
    });
    let files;
    if (needFetch) {
      files = await collectProjectTexFiles(projectId);
    } else {
      files = lastLeanPaneFiles.map((file) => ({ ...file }));
      leanPaneView.overlayActiveTex(files, latestActiveTexPath, latestActiveTex);
    }
    lastLeanPaneFiles = files.map((file) => ({ ...file }));
    lastLeanPaneProjectId = projectId;
    return files;
  }

  function renderLeanPaneManifest(manifest) {
    if (!leanPaneBody || !leanPaneStatus) return;
    const prevScrollTop = leanPaneBody.scrollTop;
    const items = Array.isArray(manifest?.items) ? manifest.items : [];
    const tree = leanPaneView.buildLeanPaneTree(items);
    const fileCount = tree.files.length;
    lastLeanPaneManifest = manifest || null;
    prepareLeanPaneTreeExpansion(manifest, tree);
    leanPaneBody.replaceChildren();
    leanPaneStatus.textContent = items.length
      ? `${items.length} labeled item${items.length === 1 ? "" : "s"} across ${fileCount} .tex file${fileCount === 1 ? "" : "s"}.`
      : "No labeled theorem, lemma, proposition, corollary, or definition environments found.";

    if (Array.isArray(manifest?.diagnostics) && manifest.diagnostics.length > 0) {
      const diagnostics = document.createElement("div");
      diagnostics.className = "ol-lean-project-pane-diagnostics";
      for (const diagnostic of manifest.diagnostics.slice(0, 4)) {
        const line = document.createElement("p");
        line.textContent = diagnostic.message || diagnostic.code || "Lean pane diagnostic";
        diagnostics.appendChild(line);
      }
      leanPaneBody.appendChild(diagnostics);
    }

    const repairBatchPanel = renderLeanPaneRepairBatchPanel();
    if (repairBatchPanel) leanPaneBody.appendChild(repairBatchPanel);

    const batchActions = renderLeanPaneBatchActions(items);
    if (batchActions) leanPaneBody.appendChild(batchActions);

    if (items.length > 0) {
      const treeElement = document.createElement("div");
      treeElement.className = "ol-lean-project-tree";
      for (const node of tree.children) {
        treeElement.appendChild(renderLeanPaneTreeNode(node, 0, manifest));
      }
      leanPaneBody.appendChild(treeElement);
    }

    leanPaneBody.scrollTop = prevScrollTop;
  }

  function renderLeanPaneProjectIdentity(identity) {
    if (!leanPaneProjectTitle || !leanPaneProjectNamespace) return;
    const fallback = guessProjectName(lastLeanPaneFiles || []);
    leanPaneProjectTitle.textContent = identity?.projectName || fallback;
    leanPaneProjectNamespace.textContent = `Lean namespace: ${identity?.namespace || "--"}`;
  }

  async function loadProjectIdentity({ baseUrl, projectId }) {
    const response = await fetch(`${baseUrl}/project/identity?overleafProjectId=${encodeURIComponent(projectId)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    return payload.identity || null;
  }

  async function previewProjectIdentity({ baseUrl, projectId, projectName, namespace = "", excludeProjectId = "" }) {
    const response = await fetch(`${baseUrl}/project/identity/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overleafProjectId: projectId, projectName, namespace, excludeProjectId })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    return payload;
  }

  async function saveProjectIdentity({ baseUrl, projectId, projectName, mode, namespace = "", expectedNamespace = "", createIfMissing = false }) {
    const response = await fetch(`${baseUrl}/project/identity`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overleafProjectId: projectId, projectName, mode, namespace, expectedNamespace, createIfMissing })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    return payload;
  }

  function guessProjectName(files = []) {
    for (const file of files || []) {
      const match = String(file?.content || "").match(/\\title\s*\{([^}]*)\}/);
      if (match?.[1]?.trim()) return match[1].trim();
    }
    const title = String(document.title || "").replace(/\s*-\s*Overleaf\s*$/i, "").trim();
    return title || "Overleaf Project";
  }

  function renderProjectIdentityFeedback({ source = "lean-pane", popover = null, message = "", kind = "info" } = {}) {
    const text = String(message || "");
    if (source === "lean-pane" && leanPaneStatus) {
      leanPaneStatus.textContent = text;
    }
    const projectMessage = popover?.querySelector("[data-role='project-message']");
    if (projectMessage) {
      projectMessage.textContent = text;
      projectMessage.dataset.kind = text ? kind : "";
    }
  }

  async function openProjectIdentityEditor({ source = "lean-pane", popover = null } = {}) {
    const settings = await getSettings();
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    const projectId = extractOverleafProjectId();
    const identity = lastProjectIdentity || await loadProjectIdentity({ baseUrl, projectId });
    const projectName = window.prompt("Project name", identity?.projectName || guessProjectName(lastLeanPaneFiles || []));
    if (projectName === null) {
      renderProjectIdentityFeedback({ source, popover });
      return false;
    }
    const trimmed = projectName.trim();
    if (!trimmed) {
      renderProjectIdentityFeedback({ source, popover, message: "Project name is required.", kind: "error" });
      return false;
    }
    let preview;
    try {
      preview = await previewProjectIdentity({
        baseUrl,
        projectId,
        projectName: trimmed,
        excludeProjectId: identity?.projectId || ""
      });
    } catch (error) {
      renderProjectIdentityFeedback({ source, popover, message: normalizeErrorMessage(error), kind: "error" });
      return false;
    }
    if (preview.available === false) {
      renderProjectIdentityFeedback({
        source,
        popover,
        message: `That namespace is already in use. Try ${preview.suggestions?.[0] || "another name"}.`,
        kind: "error"
      });
      return false;
    }
    const existingWithProofs = Boolean(identity?.exists && identity?.hasRecordedProofs);
    const migrate = !existingWithProofs && preview.namespace !== identity?.namespace
      ? true
      : window.confirm(`Change Lean namespace to ${preview.namespace}? Choose Cancel to rename the display name only.`);
    const mode = migrate ? "rename-namespace" : "display-only";
    let result;
    try {
      result = await saveProjectIdentity({
        baseUrl,
        projectId,
        projectName: trimmed,
        mode,
        namespace: migrate ? preview.namespace : "",
        expectedNamespace: identity?.namespace || "",
        createIfMissing: true
      });
    } catch (error) {
      renderProjectIdentityFeedback({ source, popover, message: normalizeErrorMessage(error), kind: "error" });
      return false;
    }
    lastProjectIdentity = result.identity || null;
    renderLeanPaneProjectIdentity(lastProjectIdentity);
    if (popover) renderProjectSettingsSection(popover, lastProjectIdentity);
    const savedNamespace = result.identity?.namespace || identity?.namespace || preview.namespace || "";
    renderProjectIdentityFeedback({
      source,
      popover,
      message: mode === "display-only" && savedNamespace
        ? `Project name saved. Lean files still use namespace ${savedNamespace}.`
        : "Project name and Lean namespace saved.",
      kind: "success"
    });
    return true;
  }

  function prepareLeanPaneTreeExpansion(manifest, tree) {
    const key = [
      itemsProjectId(manifest?.items || [])
    ].join(":");
    if (key !== leanPaneTreeDefaultsKey) {
      leanPaneExpandedTreeNodeIds = new Set();
      leanPaneTreeDefaultsKey = key;
    }

    const liveIds = new Set();
    collectLeanPaneTreeNodeIds(tree.children, liveIds);
    for (const id of [...leanPaneExpandedTreeNodeIds]) {
      if (!liveIds.has(id)) leanPaneExpandedTreeNodeIds.delete(id);
    }
  }

  function itemsProjectId(items) {
    const item = Array.isArray(items) ? items.find((candidate) => candidate?.overleafProjectId) : null;
    return item?.overleafProjectId || extractOverleafProjectId() || "unknown";
  }

  function collectLeanPaneTreeNodeIds(nodes, ids) {
    for (const node of nodes || []) {
      ids.add(node.id);
      if (node.type === "folder") collectLeanPaneTreeNodeIds(node.children, ids);
    }
  }

  function renderLeanPaneTreeNode(node, depth, manifest) {
    const expanded = leanPaneExpandedTreeNodeIds.has(node.id);
    const section = document.createElement("section");
    section.className = `ol-lean-project-tree-node ol-lean-project-tree-node-${node.type}`;
    section.dataset.treeNodeId = node.id;

    const row = document.createElement("button");
    row.type = "button";
    row.className = `ol-lean-project-tree-row ol-lean-project-tree-row-${node.type}`;
    row.style.setProperty("--ol-tree-depth", String(depth));
    row.setAttribute("aria-expanded", String(expanded));
    row.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${node.type === "folder" ? "folder" : "file"} ${node.path || node.name}`);
    row.addEventListener("click", () => {
      toggleLeanPaneTreeNode(node.id);
      section.replaceWith(renderLeanPaneTreeNode(node, depth, manifest));
    });

    const disclosure = document.createElement("span");
    disclosure.className = "ol-lean-project-tree-disclosure";
    disclosure.textContent = expanded ? "▾" : "▸";
    row.appendChild(disclosure);

    const name = document.createElement("span");
    name.className = "ol-lean-project-tree-name";
    name.textContent = node.type === "folder" ? `${node.name}/` : node.name;
    row.appendChild(name);

    const count = document.createElement("span");
    count.className = "ol-lean-project-tree-count";
    count.textContent = `${node.itemCount} item${node.itemCount === 1 ? "" : "s"}`;
    row.appendChild(count);

    if (node.type === "file") {
      row.appendChild(renderLeanPaneFileProgress(node));
    } else {
      const chip = document.createElement("span");
      chip.className = `ol-lean-project-status ol-lean-project-tree-status ol-lean-project-status-${node.status || "unknown"}`;
      chip.textContent = leanPaneView.formatPaneStatus(node.status || "unknown");
      row.appendChild(chip);
    }
    section.appendChild(row);

    if (expanded) {
      const children = document.createElement("div");
      children.className = "ol-lean-project-tree-children";
      if (node.type === "folder") {
        for (const child of node.children) {
          children.appendChild(renderLeanPaneTreeNode(child, depth + 1, manifest));
        }
      } else {
        children.className = "ol-lean-project-tree-items";
        for (const item of node.items) {
          children.appendChild(renderLeanPaneItem(item));
        }
      }
      section.appendChild(children);
    }
    return section;
  }

  function renderLeanPaneFileProgress(node) {
    const summary = node.progress || leanPaneView.summarizePaneProgress(node.items || []);
    const progress = document.createElement("span");
    progress.className = `ol-lean-project-progress${summary.inProgress > 0 ? " ol-lean-project-progress-in-progress" : ""}`;
    progress.setAttribute("role", "img");
    progress.setAttribute("aria-label", leanPaneView.formatPaneProgressLabel(node.path || node.name, summary));

    for (const segment of leanPaneView.paneProgressSegments(summary)) {
      const element = document.createElement("span");
      element.className = `ol-lean-project-progress-segment ol-lean-project-progress-segment-${segment.id}`;
      element.style.setProperty("width", `${segment.percent}%`);
      element.dataset.bucket = segment.id;
      element.dataset.count = String(segment.count);
      element.dataset.percent = String(segment.percent);
      element.title = segment.title;
      progress.appendChild(element);
    }
    return progress;
  }

  function toggleLeanPaneTreeNode(id) {
    if (leanPaneExpandedTreeNodeIds.has(id)) {
      leanPaneExpandedTreeNodeIds.delete(id);
    } else {
      leanPaneExpandedTreeNodeIds.add(id);
    }
  }

  function renderLeanPaneItem(item) {
    const expanded = leanPaneExpandedItemIds.has(item.id);
    const card = document.createElement("section");
    card.className = `ol-lean-project-item ol-lean-project-item-${item.status || "unknown"}`;
    card.dataset.itemId = item.id || "";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "ol-lean-project-item-header";
    header.setAttribute("aria-expanded", String(expanded));
    header.addEventListener("click", () => {
      if (leanPaneExpandedItemIds.has(item.id)) {
        leanPaneExpandedItemIds.delete(item.id);
      } else {
        leanPaneExpandedItemIds.add(item.id);
      }
      card.replaceWith(renderLeanPaneItem(item));
    });

    const text = document.createElement("span");
    text.className = "ol-lean-project-item-title";
    renderLeanPaneTitle(text, item);
    const meta = document.createElement("span");
    meta.className = "ol-lean-project-item-meta";
    meta.textContent = item.label;
    const chip = document.createElement("span");
    chip.className = `ol-lean-project-status ol-lean-project-status-${item.status || "unknown"}`;
    chip.textContent = leanPaneView.formatPaneStatus(item.status || "unknown");
    header.appendChild(text);
    header.appendChild(meta);
    header.appendChild(chip);
    // Same amber "!" the document overlay's badge shows for a proof whose
    // imports are currently sorry-stubbed -- the pane item and the doc badge
    // describe the same status object and must agree.
    if (getStubbedTheoremUses(item).length > 0) {
      header.appendChild(createStubbedTheoremUsesMark());
    }
    card.appendChild(header);

    const natural = document.createElement("p");
    natural.className = "ol-lean-project-natural";
    renderLeanPaneLatex(natural, item.naturalLanguageLatex || item.naturalLanguageRendered || "");
    card.appendChild(natural);

    if (getStubbedTheoremUses(item).length > 0) {
      const stubbedWarning = document.createElement("p");
      stubbedWarning.className = "ol-lean-project-impact-note";
      renderStubbedTheoremUsesWarning(stubbedWarning, item);
      card.appendChild(stubbedWarning);
    }

    if (item.leanStub) {
      card.appendChild(renderLeanCodeBlock("ol-lean-project-code", item.leanStub, "Copy stub"));
    } else {
      const missing = document.createElement("p");
      missing.className = "ol-lean-project-missing";
      missing.textContent = "No Lean stub has been generated yet.";
      card.appendChild(missing);
    }

    if (expanded) {
      card.appendChild(renderLeanPaneItemDetail(item));
    }
    return card;
  }

  function renderLeanPaneItemDetail(item) {
    const detail = document.createElement("div");
    detail.className = "ol-lean-project-detail";
    const meta = document.createElement("p");
    meta.textContent = [
      item.sourceFile,
      item.sourceStartLine ? `lines ${item.sourceStartLine}-${item.sourceEndLine || item.sourceStartLine}` : "",
      item.leanDeclarationName ? `Lean: ${item.leanDeclarationName}` : "",
      item.leanArtifactPath ? `Artifact: ${item.leanArtifactPath}` : ""
    ].filter(Boolean).join(" · ");
    detail.appendChild(meta);

    const editing = leanPaneEditingItemId === item.id;

    // One row, three visual weights (leanPaneView.paneItemActions): a single
    // status-derived primary, an icon rail for navigation, and an overflow
    // menu for the rare alternatives. Copy lives on the code blocks instead.
    const { primary, rail, overflow } = leanPaneView.paneItemActions(item, { editing });
    const actions = document.createElement("div");
    actions.className = "ol-lean-project-detail-actions";
    if (primary) actions.appendChild(renderPaneItemPrimaryAction(item, primary));
    const railElement = document.createElement("div");
    railElement.className = "ol-lean-icon-rail";
    for (const action of rail) {
      railElement.appendChild(renderPaneItemIconAction(item, action));
    }
    if (overflow.length > 0) {
      railElement.appendChild(renderPaneOverflowMenu(item, overflow));
    }
    actions.appendChild(railElement);
    detail.appendChild(actions);

    if (item.breakage) {
      detail.appendChild(renderLeanPaneBreakage(item));
    }
    if (item.repairNeedsReview) {
      const review = document.createElement("p");
      review.className = "ol-lean-project-repair-review";
      review.textContent = "A repair for this item compiles, but its declaration header changed -- review that the statement still matches the source.";
      detail.appendChild(review);
    }

    if (editing) {
      detail.appendChild(renderLeanPaneEditControls(item));
    } else if (item.leanArtifactContent) {
      detail.appendChild(
        renderLeanCodeBlock("ol-lean-project-artifact", item.leanArtifactContent, "Copy artifact")
      );
    } else {
      const empty = document.createElement("p");
      empty.className = "ol-lean-project-missing";
      empty.textContent = "No generated Lean artifact is available for this item.";
      detail.appendChild(empty);
    }

    if (!editing && leanPaneEditLastResult && leanPaneEditLastResult.itemId === item.id) {
      const summary = renderLeanPaneEditImpactSummary(leanPaneEditLastResult, item);
      if (summary) detail.appendChild(summary);
    }
    return detail;
  }

  // --- Self-repair actions (docs/FEATURE-overleaf-self-repair.md, Phase 5) ---

  function renderRepairButton(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ol-lean-secondary-button ol-lean-item-primary-action ol-lean-repair-button";
    button.textContent = "Repair with Lea";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const projectId = itemsProjectId(lastLeanPaneManifest?.items || []);
      const target = leanPaneView.paneItemToEditTarget(item, projectId);
      requestRepair({
        overleafProjectId: projectId,
        items: [{ targetKind: target.targetKind, targetLabel: target.targetLabel }]
      });
    });
    return button;
  }

  // The chip-adjacent breakage explanation + repair lifecycle line.
  function renderLeanPaneBreakage(item) {
    const container = document.createElement("div");
    container.className = "ol-lean-project-breakage";
    const attribution = document.createElement("p");
    attribution.textContent = leanPaneView.formatBreakageAttribution(item.breakage);
    container.appendChild(attribution);
    const repair = item.breakage.repair;
    if (repair?.state === "running") {
      const line = document.createElement("p");
      line.className = "ol-lean-project-breakage-running";
      line.textContent = "A repair run is in progress for this item...";
      container.appendChild(line);
    } else if (repair?.state === "failed") {
      const line = document.createElement("p");
      line.className = "ol-lean-project-breakage-failed";
      line.textContent = `Repair failed: ${repair.failureReason || "the repaired file still does not compile."}`;
      container.appendChild(line);
    }
    const itemKey = item.leanDeclarationName || item.label || "";
    if (leanPaneRepairError && leanPaneRepairError.itemKey === itemKey) {
      const line = document.createElement("p");
      line.className = "ol-lean-project-breakage-failed";
      line.textContent = leanPaneRepairError.message;
      container.appendChild(line);
    }
    return container;
  }

  // Dispatch: a single item goes through /lean-pane/repair/start; several go
  // through the topologically ordered batch (/lean-pane/repair/all).
  async function requestRepair({ overleafProjectId, items }) {
    leanPaneRepairError = null;
    const errorKey = items.length === 1 ? items[0].targetLabel : "batch";
    try {
      const baseUrl = await chatCompanionBaseUrl();
      if (items.length === 1) {
        const response = await fetch(`${baseUrl}/lean-pane/repair/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overleafProjectId, ...items[0] })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.message || `Companion returned HTTP ${response.status}.`);
      } else {
        const response = await fetch(`${baseUrl}/lean-pane/repair/all`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overleafProjectId, items })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.message || `Companion returned HTTP ${response.status}.`);
        leanPaneRepairBatch = payload;
        startRepairBatchPolling();
      }
    } catch (error) {
      leanPaneRepairError = { itemKey: errorKey, message: normalizeErrorMessage(error) };
    }
    renderLeanPaneManifest(lastLeanPaneManifest);
    scheduleLeanPaneRefresh();
  }

  function startRepairBatchPolling({ immediate = false } = {}) {
    if (leanPaneRepairBatchTimer) clearTimeout(leanPaneRepairBatchTimer);
    const delayMs = immediate
      ? 0
      : (pushConnected ? REPAIR_BATCH_POLL_RECONCILE_MS : REPAIR_BATCH_POLL_MS);
    leanPaneRepairBatchTimer = setTimeout(async () => {
      leanPaneRepairBatchTimer = 0;
      const batchId = leanPaneRepairBatch?.batchId;
      if (!batchId) return;
      // (delay above: instant when a push event announced a change, slow
      // reconciliation while the stream is up, fast poll when it's down)
      try {
        const baseUrl = await chatCompanionBaseUrl();
        const response = await fetch(`${baseUrl}/lean-pane/repair/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchId })
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok) leanPaneRepairBatch = payload;
      } catch {
        // transient; keep the last snapshot and try again
      }
      renderLeanPaneManifest(lastLeanPaneManifest);
      scheduleLeanPaneRefresh();
      if (leanPaneRepairBatch && !leanPaneRepairBatch.done && !leanPaneRepairBatch.pausedOn) {
        startRepairBatchPolling();
      }
    }, delayMs);
  }

  async function continueRepairBatch() {
    const batchId = leanPaneRepairBatch?.batchId;
    if (!batchId) return;
    try {
      const baseUrl = await chatCompanionBaseUrl();
      const response = await fetch(`${baseUrl}/lean-pane/repair/all/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId })
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) leanPaneRepairBatch = payload;
      startRepairBatchPolling();
    } catch (error) {
      leanPaneRepairError = { itemKey: "batch", message: normalizeErrorMessage(error) };
    }
    renderLeanPaneManifest(lastLeanPaneManifest);
  }

  // Stop a running batch: the companion halts further items and interrupts the
  // one mid-run. The snapshot comes back `stopping` (then `canceled` once it
  // settles); keep polling so the panel reflects the final stopped state.
  async function cancelRepairBatch() {
    const batchId = leanPaneRepairBatch?.batchId;
    if (!batchId) return;
    try {
      const baseUrl = await chatCompanionBaseUrl();
      const response = await fetch(`${baseUrl}/lean-pane/repair/all/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId })
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) leanPaneRepairBatch = payload;
      startRepairBatchPolling({ immediate: true });
    } catch (error) {
      leanPaneRepairError = { itemKey: "batch", message: normalizeErrorMessage(error) };
    }
    renderLeanPaneManifest(lastLeanPaneManifest);
  }

  // Project-level "Stub all" / "Formalize all" launchers, above the item tree.
  // Only one batch surface exists at a time: while a batch panel is showing
  // (running, paused, or awaiting dismiss) the launchers stay hidden so a
  // second batch can't clobber the first. Each button is present only when it
  // has eligible work (un-stubbed theorems / not-yet-proven items).
  function renderLeanPaneBatchActions(items) {
    if (leanPaneRepairBatch) return null;
    const stubbable = leanPaneView.stubbableItems(items);
    const formalizable = leanPaneView.formalizableItems(items);
    if (stubbable.length === 0 && formalizable.length === 0) return null;
    const row = document.createElement("div");
    row.className = "ol-lean-project-batch-actions";
    if (stubbable.length > 0) {
      const stubAll = document.createElement("button");
      stubAll.type = "button";
      stubAll.className = "ol-lean-secondary-button ol-lean-stub-all-button";
      stubAll.textContent = `Stub all (${stubbable.length})`;
      stubAll.title = "Generate a Lean sorry-stub for every un-stubbed theorem in the project.";
      stubAll.addEventListener("click", () => { stubAllTheorems(); });
      row.appendChild(stubAll);
    }
    if (formalizable.length > 0) {
      const formalizeAll = document.createElement("button");
      formalizeAll.type = "button";
      formalizeAll.className = "ol-lean-primary-button ol-lean-formalize-all-button";
      formalizeAll.textContent = `Formalize all (${formalizable.length})`;
      formalizeAll.title = "Run Lea to formalize every theorem and definition that has no verified proof yet.";
      formalizeAll.addEventListener("click", () => { formalizeAllItems(); });
      row.appendChild(formalizeAll);
    }
    return row;
  }

  // Live batch progress at the top of the pane: one line per item
  // (formatRepairOutcome), plus continue/dismiss controls when the batch
  // paused on a failure or the spend cap.
  function renderLeanPaneRepairBatchPanel() {
    const batch = leanPaneRepairBatch;
    if (!batch || !Array.isArray(batch.items) || batch.items.length === 0) return null;
    const operation = batch.operation || "repair";
    const noun = operation === "stub" ? "Stub" : operation === "formalize" ? "Formalize" : "Repair";
    const doneVerb = operation === "stub" ? "stubbed" : operation === "formalize" ? "formalized" : "repaired";
    const doneStates = operation === "stub"
      ? ["stubbed"]
      : operation === "formalize"
        ? ["formalized", "disproved"]
        : ["repaired", "needs_review"];
    const runningVerb = operation === "stub" ? "Stubbing" : operation === "formalize" ? "Formalizing" : "Repairing";
    const panel = document.createElement("div");
    panel.className = "ol-lean-project-repair-batch";
    const heading = document.createElement("p");
    const doneCount = batch.items.filter((entry) => doneStates.includes(entry.state)).length;
    heading.textContent = batch.canceled
      ? `${noun} all stopped: ${doneCount}/${batch.items.length} ${doneVerb} before stopping.`
      : batch.stopping
        ? "Stopping..."
        : batch.done
          ? `${noun} all finished: ${doneCount}/${batch.items.length} ${doneVerb}.`
          : batch.pausedOn
            ? batch.pausedOn.reason === "max_spend"
              ? `${noun} all paused: the max spend limit was reached.`
              : `${noun} all paused: ${batch.pausedOn.targetLabel || "an item"} failed.`
            : `${runningVerb} ${batch.items.length} item${batch.items.length === 1 ? "" : "s"}...`;
    panel.appendChild(heading);
    for (const entry of batch.items) {
      const line = document.createElement("p");
      line.className = "ol-lean-project-repair-batch-item";
      line.textContent = leanPaneView.formatRepairOutcome(entry, operation);
      panel.appendChild(line);
    }
    if (leanPaneRepairError && leanPaneRepairError.itemKey === "batch") {
      const line = document.createElement("p");
      line.className = "ol-lean-project-breakage-failed";
      line.textContent = leanPaneRepairError.message;
      panel.appendChild(line);
    }
    const controls = document.createElement("div");
    controls.className = "ol-lean-project-detail-actions";
    // Stop is available while the batch is actively working (not paused, not
    // finished, not already stopping): it halts further items and interrupts
    // the one mid-run.
    if (!batch.done && !batch.pausedOn && !batch.stopping) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "ol-lean-secondary-button ol-lean-stop-batch-button";
      stop.textContent = "Stop";
      stop.addEventListener("click", () => { cancelRepairBatch(); });
      controls.appendChild(stop);
    }
    if (batch.pausedOn) {
      const cont = document.createElement("button");
      cont.type = "button";
      cont.className = "ol-lean-primary-button";
      cont.textContent = "Continue remaining";
      cont.addEventListener("click", () => { continueRepairBatch(); });
      controls.appendChild(cont);
    }
    if (batch.done || batch.pausedOn) {
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "ol-lean-secondary-button";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => {
        leanPaneRepairBatch = null;
        renderLeanPaneManifest(lastLeanPaneManifest);
      });
      controls.appendChild(dismiss);
    }
    if (controls.children.length > 0) panel.appendChild(controls);
    return panel;
  }

  // Open the inline edit view for an item: shows the current artifact
  // immediately (no network round trip needed to start typing), then
  // best-effort refreshes the draft + pre-save dependents preview from
  // /lean-pane/edit/start. A network failure here still leaves editing usable
  // -- the preview is a nicety, not a precondition (feature spec: v1 does not
  // block editing on the impact preview being available).
  async function openLeanPaneEdit(item) {
    leanPaneEditingItemId = item.id;
    leanPaneEditDraft = item.leanArtifactContent || "";
    leanPaneEditPreSaveDependents = [];
    leanPaneEditError = "";
    leanPaneEditLastResult = null;
    renderLeanPaneManifest(lastLeanPaneManifest);
    try {
      const projectId = itemsProjectId(lastLeanPaneManifest?.items || []);
      const target = leanPaneView.paneItemToEditTarget(item, projectId);
      const baseUrl = await chatCompanionBaseUrl();
      const response = await fetch(`${baseUrl}/lean-pane/edit/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target)
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload?.ok && leanPaneEditingItemId === item.id) {
        leanPaneEditDraft = typeof payload.content === "string" ? payload.content : leanPaneEditDraft;
        leanPaneEditPreSaveDependents = Array.isArray(payload.dependents) ? payload.dependents : [];
        renderLeanPaneManifest(lastLeanPaneManifest);
      }
    } catch {
      // Best-effort only -- see doc comment above.
    }
  }

  function closeLeanPaneEdit() {
    leanPaneEditingItemId = "";
    leanPaneEditDraft = "";
    leanPaneEditPreSaveDependents = [];
    leanPaneEditError = "";
    renderLeanPaneManifest(lastLeanPaneManifest);
  }

  function renderLeanPaneEditControls(item) {
    const container = document.createElement("div");
    container.className = "ol-lean-project-edit";

    if (leanPaneEditPreSaveDependents.length > 0) {
      const note = document.createElement("p");
      note.className = "ol-lean-project-impact-note";
      note.textContent = leanPaneView.formatDependentsImpact(leanPaneEditPreSaveDependents);
      container.appendChild(note);
    }

    // Overlay editor: the textarea stays the real input, but its text is
    // transparent (caret excepted); the visible text is the same regex-highlighted
    // rendering the read view uses (renderLeanPaneCode), in a backdrop layer kept
    // in sync on input/scroll. Both layers share identical font/padding/wrapping
    // so the glyphs line up exactly.
    const editor = document.createElement("div");
    editor.className = "ol-lean-project-edit-editor";

    const highlightLayer = document.createElement("pre");
    highlightLayer.className = "ol-lean-project-edit-highlight";
    highlightLayer.setAttribute("aria-hidden", "true");
    editor.appendChild(highlightLayer);

    const textarea = document.createElement("textarea");
    textarea.className = "ol-lean-project-edit-textarea";
    textarea.value = leanPaneEditDraft;
    textarea.spellcheck = false;
    textarea.setAttribute("aria-label", `Edit Lean source for ${item.leanDeclarationName || item.label || "this item"}`);
    textarea.addEventListener("input", () => {
      leanPaneEditDraft = textarea.value;
      renderLeanPaneCode(highlightLayer, textarea.value);
      highlightLayer.scrollTop = textarea.scrollTop;
    });
    textarea.addEventListener("scroll", () => {
      highlightLayer.scrollTop = textarea.scrollTop;
      highlightLayer.scrollLeft = textarea.scrollLeft;
    });
    editor.appendChild(textarea);
    renderLeanPaneCode(highlightLayer, leanPaneEditDraft);
    container.appendChild(editor);

    const errorLine = document.createElement("p");
    errorLine.className = "ol-lean-project-edit-error";
    errorLine.hidden = !leanPaneEditError;
    errorLine.textContent = leanPaneEditError || "";
    container.appendChild(errorLine);

    const actions = document.createElement("div");
    actions.className = "ol-lean-project-detail-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "ol-lean-secondary-button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeLeanPaneEdit();
    });

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "ol-lean-secondary-button ol-lean-edit-save-button";
    saveButton.textContent = "Save";
    saveButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const content = textarea.value;
      saveButton.disabled = true;
      cancelButton.disabled = true;
      textarea.disabled = true;
      saveButton.textContent = "Saving…";
      errorLine.hidden = true;
      try {
        const projectId = itemsProjectId(lastLeanPaneManifest?.items || []);
        const target = leanPaneView.paneItemToEditTarget(item, projectId);
        const baseUrl = await chatCompanionBaseUrl();
        const response = await fetch(`${baseUrl}/lean-pane/edit/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...target, content })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.message || `Save failed (HTTP ${response.status}).`);
        }
        leanPaneEditingItemId = "";
        leanPaneEditError = "";
        leanPaneEditLastResult = { itemId: item.id, ...payload };
        // No agent run is started by a save (feature spec acceptance criterion
        // 9); this refresh just picks up the new check verdicts -- the edited
        // item's own status plus any cascade-checked dependents -- through the
        // pane's normal manifest path rather than a bespoke cross-item update.
        await refreshLeanPaneNow({ background: true });
      } catch (error) {
        leanPaneEditError = normalizeErrorMessage(error);
        saveButton.disabled = false;
        cancelButton.disabled = false;
        textarea.disabled = false;
        saveButton.textContent = "Save";
        errorLine.hidden = false;
        errorLine.textContent = leanPaneEditError;
      }
    });

    actions.appendChild(saveButton);
    actions.appendChild(cancelButton);
    container.appendChild(actions);
    return container;
  }

  // Post-save summary shown under an item right after a successful save (until
  // the item is re-expanded/re-edited or the pane state key changes).
  // The edited item's OWN outcome is deliberately not repeated here: it now
  // drives the item's status chip and `message` directly (getTheoremStatus's
  // lastEditCheckStatus override, docs/FEATURE-overleaf-lean-pane-manual-edit.md),
  // the same place any other failed item's reason already shows. Repeating it
  // here in small print was the original, confusing version of this note --
  // this summary is now scoped to what the chip *can't* show on its own: a
  // one-time confirmation of what a save actually did across OTHER items.
  // Returns null when there's nothing worth a separate note for.
  function renderLeanPaneEditImpactSummary(result, item = null) {
    if (result.unchanged) {
      const container = document.createElement("div");
      container.className = "ol-lean-project-impact-note";
      container.textContent = "No changes to save.";
      return container;
    }
    // The save response is a HISTORICAL snapshot; the pane re-renders this
    // summary on every manifest refresh, so reconcile it against the live
    // per-item truth each time -- a dependent fixed through any other path
    // (per-item repair, manual edit, chat) drops out of the counts and the
    // offer on the next refresh (PLAN-self-repair-stale-offers Fix 1).
    const dependents = leanPaneView.reconcileDependentsImpact(
      result.dependentsImpact || [],
      lastLeanPaneManifest?.items || []
    );
    if (dependents.length === 0) return null;

    const container = document.createElement("div");
    container.className = "ol-lean-project-impact-note";
    const heading = document.createElement("p");
    const stillBroken = leanPaneView.stillBrokenDependents(dependents);
    const stillBrokenSet = new Set(stillBroken);
    const repairingCount = dependents.filter((d) => d.nowRepairing && (d.brokenByUpstream || d.busy || d.status === "unknown")).length;
    const fixedCount = dependents.filter(
      (d) => d.sinceFixed && (d.brokenByUpstream || d.busy || d.status === "unknown")
    ).length;
    const busyCount = dependents.filter(
      (d) => d.busy && !d.sinceFixed && !d.nowRepairing && !stillBrokenSet.has(d)
    ).length;
    const okCount = dependents.length - stillBroken.length - repairingCount - fixedCount - busyCount;
    if (stillBroken.length + repairingCount + busyCount === 0 && fixedCount > 0) {
      heading.textContent = `${dependents.length} downstream item${dependents.length === 1 ? " was" : "s were"} affected by this edit -- all since fixed or re-verified.`;
    } else {
      const parts = [];
      if (stillBroken.length > 0) parts.push(`${stillBroken.length} broken`);
      if (repairingCount > 0) parts.push(`${repairingCount} repairing`);
      if (fixedCount > 0) parts.push(`${fixedCount} since fixed`);
      if (busyCount > 0) parts.push(`${busyCount} not yet re-checked`);
      if (okCount > 0) parts.push(`${okCount} still valid`);
      heading.textContent = `${dependents.length} downstream item${dependents.length === 1 ? "" : "s"} affected: ${parts.join(", ")}.`;
    }
    container.appendChild(heading);
    for (const dependent of dependents) {
      const p = document.createElement("p");
      p.textContent = leanPaneView.formatDependentOutcome(dependent);
      container.appendChild(p);
    }
    // Self-repair: offer one action for the whole CURRENTLY-broken set
    // (feature spec Part 2) -- never for snapshot-broken items that live
    // truth says are fixed or already being repaired. Suppressed when the
    // edit broke the edited item ITSELF -- its own repair offer (on the
    // item) is the right entry point until it compiles again.
    const broken = stillBroken;
    const ownBroken = String(result.ownResult?.checkStatus || "").toLowerCase() === "error";
    if (broken.length > 0 && !ownBroken) {
      const actions = document.createElement("div");
      actions.className = "ol-lean-project-detail-actions";
      const repairAll = document.createElement("button");
      repairAll.type = "button";
      repairAll.className = "ol-lean-primary-button ol-lean-repair-all-button";
      repairAll.textContent = `Repair all (${broken.length})`;
      repairAll.addEventListener("click", () => {
        const projectId = itemsProjectId(lastLeanPaneManifest?.items || []);
        requestRepair({
          overleafProjectId: projectId,
          items: broken.map((d) => ({ targetKind: "theorem", targetLabel: d.targetLabel }))
        });
      });
      actions.appendChild(repairAll);
      container.appendChild(actions);
    }
    return container;
  }

  function renderLeanPaneTitle(element, item) {
    element.replaceChildren();
    element.appendChild(document.createTextNode(`${leanPaneView.capitalize(item.kind)}: `));
    const title = item.title || item.leanDeclarationName || item.label || "";
    if (item.title) {
      renderLeanPaneLatex(element, title, { append: true });
    } else {
      element.appendChild(document.createTextNode(title));
    }
  }

  function renderLeanPaneLatex(element, source, { append = false } = {}) {
    if (!append) element.replaceChildren();
    const segments = leanPaneView.parsePaneLatex(source || "");
    if (segments.length === 0) {
      element.appendChild(document.createTextNode(source || ""));
      return;
    }

    for (const segment of segments) {
      if (segment.type !== "math") {
        element.appendChild(document.createTextNode(segment.text));
        continue;
      }
      const math = document.createElement("span");
      math.className = segment.display
        ? "ol-lean-project-math ol-lean-project-math-display"
        : "ol-lean-project-math";
      const parts = leanPaneView.formatLiteMath(segment.text);
      if (parts.length === 0) {
        math.textContent = segment.text;
      } else {
        for (const part of parts) {
          if (part.type === "sup" || part.type === "sub") {
            const script = document.createElement("span");
            script.className = `ol-lean-project-math-script ol-lean-project-math-${part.type}`;
            script.textContent = part.text;
            math.appendChild(script);
          } else {
            math.appendChild(document.createTextNode(part.text));
          }
        }
      }
      element.appendChild(math);
    }
  }

  function renderLeanPaneCode(element, code) {
    element.replaceChildren();
    const lines = String(code || "").split("\n");
    lines.forEach((line, lineIndex) => {
      const row = document.createElement("span");
      row.className = "ol-lean-project-code-line";
      for (const token of leanPaneView.highlightLeanLine(line)) {
        const span = document.createElement("span");
        if (token.cls) span.className = `ol-lean-project-lean-${token.cls}`;
        span.textContent = token.text;
        row.appendChild(span);
      }
      if (line === "") row.appendChild(document.createTextNode(" "));
      element.appendChild(row);
      if (lineIndex < lines.length - 1) {
        element.appendChild(document.createTextNode("\n"));
      }
    });
  }

  // Item 11: jump the Overleaf editor to this item's source block. The actual
  // scroll/select happens in pageBridge (page world) which owns the CodeMirror view.
  function goToPaneItemSource(item) {
    if (leanPaneStatus) {
      leanPaneStatus.textContent = item.sourceFile
        ? `Opening ${item.sourceFile}...`
        : "Opening source...";
    }
    window.postMessage({
      type: "OL_LEAN_NAVIGATE",
      sourceFile: item.sourceFile || "",
      from: item.sourceStartOffset,
      to: item.sourceEndOffset,
      line: item.sourceStartLine,
      // Text anchors let pageBridge locate the block even when byte offsets have
      // drifted (edits) or the file path can't be matched exactly.
      leanLabel: item.label || item.leanDeclarationName || "",
      latexLabel: item.latexLabel || ""
    }, "*");
  }

  // Item 12: start a formalization run for this item, reusing the same /formalize
  // path the in-document badge uses, then refresh so the pane reflects in-progress
  // (polling, from item 4, takes over until it settles).
  function renderFormalizeButton(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ol-lean-secondary-button ol-lean-item-primary-action ol-lean-formalize-button";
    button.textContent = item.status === "missing-stub" ? "Formalize" : "Re-formalize";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      button.textContent = "Starting…";
      try {
        await formalize(leanPaneView.paneItemToFormalizeTarget(item));
        await refreshLeanPaneNow({ background: true });
      } catch (error) {
        button.disabled = false;
        button.textContent = "Retry formalize";
        if (leanPaneStatus) leanPaneStatus.textContent = normalizeErrorMessage(error);
      }
    });
    return button;
  }

  // --- Item action row (leanPaneView.paneItemActions) ------------------------
  // One primary text button, an icon rail, and an overflow menu per item card.

  const PANE_ICON_SVG_ATTRS = 'viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const PANE_ICON_SVG = {
    "go-to-source": `<svg ${PANE_ICON_SVG_ATTRS}><circle cx="12" cy="12" r="7"></circle><line x1="12" y1="2" x2="12" y2="5"></line><line x1="12" y1="19" x2="12" y2="22"></line><line x1="2" y1="12" x2="5" y2="12"></line><line x1="19" y1="12" x2="22" y2="12"></line></svg>`,
    chat: `<svg ${PANE_ICON_SVG_ATTRS}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`,
    "view-in-lea": `<svg ${PANE_ICON_SVG_ATTRS}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`,
    copy: `<svg ${PANE_ICON_SVG_ATTRS}><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
    check: `<svg ${PANE_ICON_SVG_ATTRS}><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    more: `<svg ${PANE_ICON_SVG_ATTRS}><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>`
  };

  function renderPaneItemPrimaryAction(item, action) {
    return action.id === "repair" ? renderRepairButton(item) : renderFormalizeButton(item);
  }

  function renderPaneItemIconAction(item, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ol-lean-icon-action";
    button.title = action.label;
    button.setAttribute("aria-label", action.label);
    button.innerHTML = PANE_ICON_SVG[action.id] || "";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (action.id === "go-to-source") {
        goToPaneItemSource(item);
        return;
      }
      if (action.id === "chat") {
        openLeanPaneChat(item);
        return;
      }
      if (action.id === "view-in-lea") {
        button.disabled = true;
        if (leanPaneStatus) leanPaneStatus.textContent = "Opening Lea session...";
        try {
          const { sessionOpened } = await openLeaUiForPaneItem(item);
          if (leanPaneStatus) {
            leanPaneStatus.textContent = sessionOpened ? "Opened Lea session." : "Opened Lea UI.";
          }
        } catch (error) {
          if (leanPaneStatus) leanPaneStatus.textContent = normalizeErrorMessage(error);
        } finally {
          button.disabled = false;
        }
      }
    });
    return button;
  }

  function renderPaneOverflowMenu(item, overflowActions) {
    const wrap = document.createElement("div");
    wrap.className = "ol-lean-overflow";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "ol-lean-icon-action";
    trigger.title = "More actions";
    trigger.setAttribute("aria-label", "More actions");
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = PANE_ICON_SVG.more;
    const menu = document.createElement("div");
    menu.className = "ol-lean-overflow-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    for (const action of overflowActions) {
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = "ol-lean-overflow-item";
      entry.setAttribute("role", "menuitem");
      entry.textContent = action.label;
      entry.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeActiveOverflowMenu();
        runPaneOverflowAction(item, action).catch(renderLeanPaneError);
      });
      menu.appendChild(entry);
    }
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const wasOpen = !menu.hidden;
      closeActiveOverflowMenu();
      if (!wasOpen) {
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        activeOverflowMenu = { wrap, menu, trigger };
      }
    });
    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    return wrap;
  }

  function closeActiveOverflowMenu() {
    if (!activeOverflowMenu) return;
    activeOverflowMenu.menu.hidden = true;
    activeOverflowMenu.trigger.setAttribute("aria-expanded", "false");
    activeOverflowMenu = null;
  }

  // Overflow actions report through the pane status line (the menu entry is
  // gone once the menu closes, so per-button pending text has nowhere to live).
  // Formalize/stub reuse the same companion paths as the primary button and
  // the in-document popover.
  async function runPaneOverflowAction(item, action) {
    if (action.id === "edit") {
      openLeanPaneEdit(item);
      return;
    }
    if (action.id !== "formalize" && action.id !== "stub") return;
    if (leanPaneStatus) {
      leanPaneStatus.textContent = action.id === "stub"
        ? "Creating Lean stub..."
        : "Starting formalization...";
    }
    try {
      const target = leanPaneView.paneItemToFormalizeTarget(item);
      await (action.id === "stub" ? stubTheorem(target) : formalize(target));
      await refreshLeanPaneNow({ background: true });
    } catch (error) {
      if (leanPaneStatus) leanPaneStatus.textContent = normalizeErrorMessage(error);
    }
  }

  // A highlighted Lean code block with a hover-revealed copy control in its
  // corner -- copy belongs to the content it copies, not to the action row.
  function renderLeanCodeBlock(className, code, copyLabel) {
    const wrap = document.createElement("div");
    wrap.className = "ol-lean-code-block";
    const pre = document.createElement("pre");
    pre.className = className;
    renderLeanPaneCode(pre, code);
    wrap.appendChild(pre);
    wrap.appendChild(renderCopyIconButton(copyLabel, code));
    return wrap;
  }

  function renderCopyIconButton(label, text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ol-lean-icon-action ol-lean-code-copy";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = PANE_ICON_SVG.copy;
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        button.innerHTML = PANE_ICON_SVG.check;
        button.title = "Copied";
      } catch {
        button.title = "Copy failed";
      }
      setTimeout(() => {
        button.innerHTML = PANE_ICON_SVG.copy;
        button.title = label;
      }, 1500);
    });
    return button;
  }

  // Open this item's Lea session in the standalone UI, mirroring the popover's
  // "View in Lea UI" action. The session is resolved through the companion's
  // chat-session lookup (read-only: it never creates a session); when no
  // session has been recorded yet, fall back to the Lea UI itself, matching
  // the popover's base-link fallback.
  async function openLeaUiForPaneItem(item) {
    const baseUrl = await chatCompanionBaseUrl();
    const target = leanPaneView.paneItemToChatTarget(item, itemsProjectId(lastLeanPaneManifest?.items || []));
    const response = await fetch(`${baseUrl}/lean-pane/chat/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target })
    });
    const payload = await response.json().catch(() => ({}));
    const sessionUrl = String(payload?.leaSessionUrl || "").trim();
    if (sessionUrl) {
      await openLeaSession({ url: sessionUrl, baseUrl: sessionUrl });
      return { sessionOpened: true };
    }
    const settings = await getSettings();
    const uiBaseUrl = String(settings.leaUiBaseUrl || DEFAULT_LEA_UI_BASE_URL).replace(/\/+$/, "");
    await openLeaSession({ url: uiBaseUrl, baseUrl: uiBaseUrl });
    return { sessionOpened: false };
  }

  function isChatResponseActive(payload) {
    return Boolean(payload && payload.ok !== false && payload.activeRun);
  }

  function ensureChatPanel() {
    if (leanPaneChatPanel && leanPaneChatPanel.isConnected) return leanPaneChatPanel;
    const panel = document.createElement("div");
    panel.className = "ol-lean-chat-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Lea chat");
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeLeanPaneChat();
      }
    });
    (leanPane || document.body).appendChild(panel);
    leanPaneChatPanel = panel;
    return panel;
  }

  function closeLeanPaneChat() {
    leanPaneChatToken += 1;
    clearTimeout(leanPaneChatPollTimer);
    leanPaneChatPollTimer = null;
    if (leanPaneChatPanel) leanPaneChatPanel.remove();
    leanPaneChatPanel = null;
    leanPaneChatItem = null;
    leanPaneChatTarget = null;
    leanPaneChatResponse = null;
    leanPaneChatSessionId = "";
    leanPaneChatRunId = "";
    leanPaneChatLoading = false;
    leanPaneChatSending = false;
    leanPaneChatError = null;
    leanPaneChatOptimistic = [];
    leanPaneChatPollFailures = 0;
  }

  async function chatCompanionBaseUrl() {
    const settings = await getSettings();
    return String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
  }

  async function openLeanPaneChat(item) {
    const token = ++leanPaneChatToken;
    clearTimeout(leanPaneChatPollTimer);
    leanPaneChatItem = item;
    leanPaneChatTarget = leanPaneView.paneItemToChatTarget(item, itemsProjectId(lastLeanPaneManifest?.items || []));
    leanPaneChatResponse = null;
    leanPaneChatSessionId = "";
    leanPaneChatRunId = "";
    leanPaneChatError = null;
    leanPaneChatOptimistic = [];
    leanPaneChatPollFailures = 0;
    leanPaneChatLoading = true;
    leanPaneChatSending = false;
    ensureChatPanel();
    renderChatPanel();
    const input = leanPaneChatPanel?.querySelector(".ol-lean-chat-input");
    if (input) input.focus();
    try {
      const baseUrl = await chatCompanionBaseUrl();
      const response = await fetch(`${baseUrl}/lean-pane/chat/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: leanPaneChatTarget })
      });
      const payload = await response.json().catch(() => ({}));
      if (token !== leanPaneChatToken) return;
      leanPaneChatLoading = false;
      leanPaneChatResponse = payload;
      leanPaneChatSessionId = payload.leaSessionId || "";
      if (isChatResponseActive(payload)) {
        leanPaneChatSending = true;
        startChatPolling();
      }
      renderChatPanel();
    } catch (error) {
      if (token !== leanPaneChatToken) return;
      leanPaneChatLoading = false;
      leanPaneChatError = error;
      renderChatPanel();
    }
  }

  async function sendChatMessage() {
    if (!leanPaneChatTarget) return;
    const input = leanPaneChatPanel?.querySelector(".ol-lean-chat-input");
    const text = String(input?.value || "").trim();
    if (!text) return;
    const token = leanPaneChatToken;
    leanPaneChatSending = true;
    leanPaneChatError = null;
    leanPaneChatPollFailures = 0;
    leanPaneChatOptimistic.push({ role: "user", content: text, kind: "user" });
    if (input) input.value = "";
    renderChatPanel();
    try {
      // Flush the latest .tex mirror so Lea sees current source before answering.
      await syncTexMirrorNow({ force: true }).catch(() => {});
      const baseUrl = await chatCompanionBaseUrl();
      const response = await fetch(`${baseUrl}/lean-pane/chat/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: leanPaneChatTarget, message: text })
      });
      const payload = await response.json().catch(() => ({}));
      if (token !== leanPaneChatToken) return;
      if (!response.ok || !payload.ok) {
        leanPaneChatSending = false;
        leanPaneChatError = new Error(payload.message || `Companion returned HTTP ${response.status}.`);
        renderChatPanel();
        return;
      }
      leanPaneChatSessionId = payload.leaSessionId || leanPaneChatSessionId;
      leanPaneChatRunId = payload.runId || "";
      startChatPolling();
      renderChatPanel();
    } catch (error) {
      if (token !== leanPaneChatToken) return;
      leanPaneChatSending = false;
      leanPaneChatError = error;
      renderChatPanel();
    }
  }

  function startChatPolling(delayMs = (pushConnected ? LEAN_PANE_CHAT_POLL_RECONCILE_MS : LEAN_PANE_POLL_DELAY_MS)) {
    clearTimeout(leanPaneChatPollTimer);
    leanPaneChatPollTimer = setTimeout(() => {
      // pollChatSession handles its own transient errors; the catch is a
      // last-resort guard against an unexpected synchronous throw.
      pollChatSession().catch(() => {});
    }, delayMs);
  }

  async function pollChatSession() {
    if (!leanPaneChatSessionId) return;
    const token = leanPaneChatToken;
    let payload = null;
    try {
      const baseUrl = await chatCompanionBaseUrl();
      const response = await fetch(`${baseUrl}/lean-pane/chat/session/${encodeURIComponent(leanPaneChatSessionId)}`);
      payload = await response.json().catch(() => ({}));
    } catch {
      // Transient failure (companion restarting, network blip). AUDIT M2: do
      // NOT stop polling and strand the panel on "Lea is working…" — retry
      // with backoff up to a cap, only surfacing an error once we've truly
      // given up.
      if (token !== leanPaneChatToken) return;
      leanPaneChatPollFailures += 1;
      if (leanPaneChatPollFailures >= LEAN_PANE_CHAT_POLL_MAX_FAILURES) {
        leanPaneChatSending = false;
        leanPaneChatError = new Error("Lost contact with the companion while waiting for Lea. Check that it's running, then try again.");
        renderChatPanel();
        return;
      }
      startChatPolling(LEAN_PANE_POLL_DELAY_MS * (leanPaneChatPollFailures + 1));
      return;
    }
    if (token !== leanPaneChatToken) return;
    leanPaneChatPollFailures = 0;
    if (payload && payload.ok) {
      leanPaneChatResponse = payload;
      leanPaneChatOptimistic = [];
      if (isChatResponseActive(payload)) {
        leanPaneChatSending = true;
        startChatPolling();
      } else {
        const wasRunning = leanPaneChatSending;
        leanPaneChatSending = false;
        // A finished chat run may have changed the item's artifact/status.
        if (wasRunning) refreshLeanPaneNow({ background: true }).catch(() => {});
      }
    } else {
      // Adapter reachable but reporting unavailable mid-run: surface it and
      // stop polling.
      leanPaneChatSending = false;
      leanPaneChatResponse = payload;
    }
    renderChatPanel();
  }

  async function stopChatRun() {
    const token = leanPaneChatToken;
    try {
      const baseUrl = await chatCompanionBaseUrl();
      await fetch(`${baseUrl}/lean-pane/chat/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: leanPaneChatRunId, sessionId: leanPaneChatSessionId })
      });
    } catch {
      // best-effort; the next poll reflects the actual run state
    }
    if (token === leanPaneChatToken) pollChatSession().catch(() => {});
  }

  function chatTranscriptMessages() {
    const persisted = Array.isArray(leanPaneChatResponse?.messages) ? leanPaneChatResponse.messages : [];
    return [...persisted, ...leanPaneChatOptimistic];
  }

  function renderChatPanel() {
    if (!leanPaneChatPanel) return;
    const panel = leanPaneChatPanel;
    const item = leanPaneChatItem || {};
    const state = leanPaneView.nextChatState({
      loading: leanPaneChatLoading,
      sending: leanPaneChatSending,
      response: leanPaneChatResponse,
      error: leanPaneChatError
    });
    panel.dataset.chatState = state;
    // Autoscroll only when the user is already pinned to the bottom, so live
    // answers follow along but reading earlier messages isn't yanked away.
    const previousTranscript = panel.querySelector(".ol-lean-chat-transcript");
    const pinToBottom = previousTranscript
      ? (previousTranscript.scrollHeight - previousTranscript.scrollTop - previousTranscript.clientHeight) < 48
      : true;
    panel.replaceChildren();

    // Header: declaration name + pane status chip + close
    const header = document.createElement("div");
    header.className = "ol-lean-chat-header";
    const title = document.createElement("span");
    title.className = "ol-lean-chat-title";
    title.textContent = item.leanDeclarationName || item.label || "Lea chat";
    header.appendChild(title);
    const chip = document.createElement("span");
    chip.className = `ol-lean-project-status ol-lean-project-status-${item.status || "unknown"}`;
    chip.textContent = leanPaneView.formatPaneStatus(item.status || "unknown");
    header.appendChild(chip);
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "ol-lean-chat-close";
    closeButton.setAttribute("aria-label", "Close chat");
    closeButton.textContent = "✕";
    closeButton.addEventListener("click", closeLeanPaneChat);
    header.appendChild(closeButton);
    panel.appendChild(header);

    if (item.sourceFile) {
      const source = document.createElement("p");
      source.className = "ol-lean-chat-source";
      source.textContent = item.sourceStartLine
        ? `${item.sourceFile}:${item.sourceStartLine}-${item.sourceEndLine || item.sourceStartLine}`
        : item.sourceFile;
      panel.appendChild(source);
    }

    // Transcript
    const transcript = document.createElement("div");
    transcript.className = "ol-lean-chat-transcript";
    if (state === "loading-session") {
      transcript.appendChild(chatNotice("Loading conversation…"));
    } else if (state === "adapter-unavailable") {
      transcript.appendChild(chatNotice(leanPaneChatResponse?.message || "The Lea adapter is unavailable."));
    } else {
      const messages = chatTranscriptMessages();
      if (messages.length === 0 && state === "no-session") {
        transcript.appendChild(chatNotice("No conversation yet. Ask Lea about this item to start one."));
      } else if (messages.length === 0) {
        transcript.appendChild(chatNotice("No messages yet."));
      } else {
        for (const message of messages) {
          transcript.appendChild(renderChatBubble(message));
        }
      }
      if (leanPaneChatSending) transcript.appendChild(chatNotice("Lea is working…"));
      // Self-repair: the last completed run's downstream impact (companion
      // Phase 1 post-run cascade) -- broken dependents + one repair action.
      const impactNotice = renderChatRunImpactNotice(leanPaneChatResponse?.lastRunImpact);
      if (impactNotice) transcript.appendChild(impactNotice);
    }
    panel.appendChild(transcript);

    if (leanPaneChatError) {
      const error = document.createElement("p");
      error.className = "ol-lean-chat-error";
      error.textContent = normalizeErrorMessage(leanPaneChatError);
      panel.appendChild(error);
    }

    // Composer
    const composer = document.createElement("div");
    composer.className = "ol-lean-chat-composer";
    const input = document.createElement("textarea");
    input.className = "ol-lean-chat-input";
    input.rows = 2;
    input.placeholder = "Ask Lea about this item...";
    input.disabled = !leanPaneView.chatComposerEnabled(state);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (leanPaneView.chatComposerEnabled(state)) sendChatMessage();
      }
    });
    composer.appendChild(input);

    const controls = document.createElement("div");
    controls.className = "ol-lean-chat-controls";
    if (leanPaneView.chatRunActive(state)) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "ol-lean-secondary-button ol-lean-chat-stop";
      stop.textContent = "Stop";
      stop.addEventListener("click", stopChatRun);
      controls.appendChild(stop);
    } else {
      const send = document.createElement("button");
      send.type = "button";
      send.className = "ol-lean-primary-button ol-lean-chat-send";
      send.textContent = "Send";
      send.disabled = !leanPaneView.chatComposerEnabled(state);
      send.addEventListener("click", () => sendChatMessage());
      controls.appendChild(send);
    }
    const sessionUrl = leanPaneChatResponse?.leaSessionUrl || "";
    if (sessionUrl) {
      const open = document.createElement("a");
      open.className = "ol-lean-chat-open";
      // Keep href + target as a safe fallback (and for context-menu / modifier
      // clicks), but route a plain click through the background worker so an
      // already-open Lea tab is focused and navigated instead of duplicated.
      open.href = sessionUrl;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = "Open in Lea";
      open.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
        event.preventDefault();
        // baseUrl defaults to the session URL's origin, which is what the worker
        // matches existing Lea tabs against.
        openLeaSession({ url: sessionUrl, baseUrl: sessionUrl }).catch((error) => {
          leanPaneChatError = error;
          renderChatPanel();
        });
      });
      controls.appendChild(open);
    }
    composer.appendChild(controls);
    panel.appendChild(composer);

    // Pin to the bottom once the whole panel (composer included) is laid out, so
    // the transcript's final flex height is settled before we scroll.
    if (pinToBottom) transcript.scrollTop = transcript.scrollHeight;
  }

  function chatNotice(text) {
    const notice = document.createElement("p");
    notice.className = "ol-lean-chat-notice";
    notice.textContent = text;
    return notice;
  }

  // "This change broke N downstream items" after a chat run whose post-run
  // cascade found breakage, with the same repair affordance the pane offers.
  // The stored impact is the HISTORICAL record of what the run broke; the
  // companion annotates each entry with its live state (stillBroken /
  // nowRepairing, PLAN-self-repair-stale-offers Fix 2), and the counts and
  // the repair offer here derive from that live state only.
  function renderChatRunImpactNotice(lastRunImpact) {
    const raw = Array.isArray(lastRunImpact?.dependentsImpact) ? lastRunImpact.dependentsImpact : [];
    if (raw.length === 0) return null;
    // Map the server annotation onto the reconciliation fields
    // (stillBroken is LIVE truth, so `matched` when present); an unannotated
    // entry (older record) keeps its snapshot state via the unmatched
    // fallback in stillBrokenDependents.
    const dependents = raw.map((d) => ({
      ...d,
      matched: d.stillBroken !== undefined,
      nowBroken: d.stillBroken === true,
      sinceFixed: Boolean(d.brokenByUpstream) && d.stillBroken === false && !d.nowRepairing,
      nowRepairing: Boolean(d.nowRepairing)
    }));
    const broken = leanPaneView.stillBrokenDependents(dependents);
    const everBroken = dependents.filter((d) => d.brokenByUpstream);

    const container = document.createElement("div");
    container.className = "ol-lean-chat-impact";
    const heading = document.createElement("p");
    heading.textContent = broken.length > 0
      ? `This change broke ${broken.length} downstream item${broken.length === 1 ? "" : "s"}:`
      : everBroken.length > 0
        ? `This change broke ${everBroken.length} downstream item${everBroken.length === 1 ? "" : "s"} -- all since fixed or being repaired:`
        : `This change touched ${dependents.length} downstream item${dependents.length === 1 ? "" : "s"} (re-verified):`;
    container.appendChild(heading);
    for (const dependent of dependents) {
      const line = document.createElement("p");
      line.className = "ol-lean-chat-impact-item";
      line.textContent = leanPaneView.formatDependentOutcome(dependent);
      container.appendChild(line);
    }
    if (broken.length > 0) {
      const repairAll = document.createElement("button");
      repairAll.type = "button";
      repairAll.className = "ol-lean-primary-button ol-lean-repair-all-button";
      repairAll.textContent = `Repair all (${broken.length})`;
      repairAll.addEventListener("click", () => {
        requestRepair({
          overleafProjectId: leanPaneChatTarget?.overleafProjectId || itemsProjectId(lastLeanPaneManifest?.items || []),
          items: broken.map((d) => ({ targetKind: "theorem", targetLabel: d.targetLabel }))
        });
      });
      container.appendChild(repairAll);
    }
    return container;
  }

  function renderChatBubble(message) {
    const bubble = document.createElement("div");
    bubble.className = `ol-lean-chat-bubble ${leanPaneView.chatBubbleClass(message.role)}`;
    renderChatMarkdown(bubble, message.content || "");
    return bubble;
  }

  // Minimal inline rendering: paragraphs, `inline code`, and **bold**. The mirror
  // shows the persisted transcript verbatim; it never rewrites stored messages.
  function renderChatMarkdown(container, text) {
    const lines = String(text || "").split(/\r?\n/);
    lines.forEach((line, index) => {
      renderChatInline(container, line);
      if (index < lines.length - 1) container.appendChild(document.createElement("br"));
    });
  }

  function renderChatInline(container, line) {
    const tokenRe = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
    let lastIndex = 0;
    let match;
    while ((match = tokenRe.exec(line)) !== null) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
      }
      if (match[1]) {
        const code = document.createElement("code");
        code.textContent = match[1].slice(1, -1);
        container.appendChild(code);
      } else if (match[2]) {
        const strong = document.createElement("strong");
        strong.textContent = match[2].slice(2, -2);
        container.appendChild(strong);
      }
      lastIndex = tokenRe.lastIndex;
    }
    if (lastIndex < line.length) {
      container.appendChild(document.createTextNode(line.slice(lastIndex)));
    }
  }

  function renderLeanPaneError(error) {
    if (!leanPaneBody || !leanPaneStatus) return;
    leanPaneStatus.textContent = "Could not load Lean pane.";
    leanPaneBody.replaceChildren();
    const message = document.createElement("p");
    message.className = "ol-lean-project-pane-error";
    message.textContent = normalizeErrorMessage(error);
    leanPaneBody.appendChild(message);
  }

  function showTargetPopover(clientX, clientY, target) {
    if (target?.syntax === "diagnostic") {
      showDiagnosticPopover(clientX, clientY, target);
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

    const key = targetKey(target);
    popover.dataset.targetKey = key;
    popover.querySelector("strong").textContent = target.targetLabel;
    const actions = popover.querySelector("[data-role='theorem-actions']");
    const status = popover.querySelector(".ol-lean-popover-status");
    const leanStatement = popover.querySelector(".ol-lean-popover-lean");
    const stubbedWarning = popover.querySelector(".ol-lean-popover-warning");
    const statusInfo = latestStatuses[key] || {};
    const currentStatus = statusInfo.status || "unknown";
    const actionStatus = getActionStatus(statusInfo);
    renderLeanStatement(leanStatement, statusInfo.leanStatement || "");
    renderTargetWarning(stubbedWarning, target, statusInfo);
    renderTargetActions(actions, target, currentStatus, status, leanStatement, actionStatus, statusInfo);
    if (currentStatus === "in_progress") {
      status.textContent = inProgressMessage(latestStatuses[key], target);
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

  function renderTargetActions(actions, target, currentStatus, status, leanStatement, actionStatus = currentStatus, statusInfo = {}) {
    actions.replaceChildren();
    const disabled = currentStatus === "in_progress" || isExtensionContextInvalidated();
    const actionSpecs = actionSpecsForStatus(actionStatus, target);
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
          const result = await spec.run(target);
          status.textContent = `${formatStatus(result.status, result)}${result.relativePath ? ` at ${result.relativePath}` : ""}`;
          renderLeanStatement(leanStatement, result.leanStatement || latestStatuses[targetKey(target)]?.leanStatement || "");
          await refreshStatusesNow();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
          if (isMaxSpendError(error)) {
            showCostCapNotice(null, { force: true, noticeKey: `error:${Date.now()}` });
          }
          const latestStatus = latestStatuses[targetKey(target)] || { status: currentStatus };
          renderTargetActions(actions, target, latestStatus.status || currentStatus, status, leanStatement, getActionStatus(latestStatus));
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

    const paneButton = document.createElement("button");
    paneButton.type = "button";
    paneButton.textContent = "Show in Lean pane";
    paneButton.dataset.role = "show-in-lean-pane";
    paneButton.disabled = isExtensionContextInvalidated();
    paneButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      status.textContent = "Opening Lean pane...";
      try {
        const item = await showTargetInLeanPane(target);
        status.textContent = `Opened ${item.label || target.targetLabel} in the Lean pane.`;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
    actions.appendChild(paneButton);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", closePopover);
    actions.appendChild(closeButton);
  }

  async function showTargetInLeanPane(target) {
    if (!leanPane) {
      showLeanPane({ deferRefresh: true, preservePopover: true });
    }
    await refreshLeanPaneNow({
      forceFetch: !lastLeanPaneManifest,
      background: Boolean(lastLeanPaneManifest)
    });
    const item = findLeanPaneItemForTarget(lastLeanPaneManifest?.items || [], target);
    if (!item) {
      throw new Error(`Could not find ${target.targetLabel || "this item"} in the Lean pane.`);
    }
    for (const id of leanPaneView.treeAncestorIdsForFile(item.sourceFile || "")) {
      leanPaneExpandedTreeNodeIds.add(id);
    }
    leanPaneExpandedItemIds.add(item.id);
    renderLeanPaneManifest(lastLeanPaneManifest);
    highlightLeanPaneItem(item.id);
    return item;
  }

  function findLeanPaneItemForTarget(items, target) {
    const targetLabel = String(target?.targetLabel || "").trim();
    const latexLabel = String(target?.latexLabel || "").trim();
    const targetFrom = Number(target?.from);
    const targetTo = Number(target?.to);
    const activePath = normalizeDocPath(latestActiveTexPath);
    let best = null;

    for (const item of Array.isArray(items) ? items : []) {
      let score = 0;
      if (targetLabel && item?.label === targetLabel) score += 100;
      if (targetLabel && item?.leanDeclarationName === targetLabel) score += 100;
      if (latexLabel && item?.latexLabel === latexLabel) score += 80;
      if (
        Number.isFinite(targetFrom) &&
        Number.isFinite(targetTo) &&
        item?.sourceStartOffset === targetFrom &&
        item?.sourceEndOffset === targetTo
      ) {
        score += 60;
      }
      if (activePath && normalizeDocPath(item?.sourceFile) === activePath) score += 5;
      if (score >= 60 && (!best || score > best.score)) {
        best = { item, score };
      }
    }
    return best?.item || null;
  }

  function highlightLeanPaneItem(itemId) {
    if (!leanPaneBody) return;
    const element = [...leanPaneBody.querySelectorAll(".ol-lean-project-item")]
      .find((candidate) => candidate.dataset.itemId === itemId);
    if (!element) return;
    element.classList.add("ol-lean-project-item-focus");
    element.scrollIntoView?.({ block: "center", behavior: "smooth" });
    clearTimeout(leanPaneHighlightTimer);
    leanPaneHighlightTimer = setTimeout(() => {
      element.classList.remove("ol-lean-project-item-focus");
    }, 1800);
  }

  function actionSpecsForStatus(status, target) {
    const definition = isDefinitionTarget(target);
    if (status === "unformalized") {
      const specs = [{
        role: "target-action",
        label: definition ? "Formalize definition" : "Formalize",
        primary: true,
        pendingText: "Starting Lea...",
        run: formalize
      }];
      if (!definition) {
        specs.push({
          role: "theorem-stub-action",
          label: "Stub",
          primary: false,
          pendingText: "Creating Lean stub...",
          run: stubTheorem
        });
      }
      return specs;
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
      label: buttonTextForStatus(status, target),
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
        <section class="ol-lean-project-identity-panel" data-role="project-identity">
          <div class="ol-lean-provider-title">Project</div>
          <div class="ol-lean-provider-row">
            <div class="ol-lean-provider-row-head">
              <span data-role="project-name">Overleaf Project</span>
              <strong data-role="project-exists">Not created</strong>
            </div>
            <p class="ol-lean-provider-note" data-role="project-namespace">Lean namespace: --</p>
            <p class="ol-lean-provider-note" data-role="project-binding">Overleaf binding: --</p>
            <p class="ol-lean-provider-note ol-lean-project-message" data-role="project-message"></p>
            <div class="ol-lean-provider-key-controls">
              <button type="button" class="ol-lean-provider-key-button" data-role="edit-project-name">Edit name</button>
            </div>
          </div>
        </section>
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
        <section class="ol-lean-provider-panel" data-role="github-token-panel">
          <div class="ol-lean-provider-title">GitHub sharing</div>
          <p class="ol-lean-provider-note">The push token is stored by Lea (lea.local.toml) — never in Chrome. It enables Push in the Lean pane's Share panel.</p>
          <div class="ol-lean-provider-row">
            <div class="ol-lean-provider-row-head">
              <span>Push token</span>
              <strong data-role="github-token-status">Missing</strong>
            </div>
            <div class="ol-lean-provider-key-controls">
              <button type="button" class="ol-lean-provider-key-button" data-role="github-token-toggle">Add token</button>
              <button type="button" class="ol-lean-provider-key-button" data-role="github-token-clear" hidden>Remove</button>
              <input type="password" autocomplete="off" spellcheck="false" data-role="github-token-input" placeholder="GitHub token (repo scope)" hidden>
              <button type="button" class="ol-lean-provider-key-button" data-role="github-token-save" hidden>Save token</button>
            </div>
          </div>
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

    // GitHub push token (D34): saved immediately via its own companion endpoint
    // (write-through to the adapter's lea.local.toml), independent of the main
    // "Save changes" flow. Presence-only display; the raw token is never read back.
    const githubToggle = popover.querySelector("[data-role='github-token-toggle']");
    const githubClear = popover.querySelector("[data-role='github-token-clear']");
    const githubInput = popover.querySelector("[data-role='github-token-input']");
    const githubSave = popover.querySelector("[data-role='github-token-save']");
    githubToggle.addEventListener("click", () => {
      githubInput.hidden = false;
      githubSave.hidden = false;
      githubInput.focus();
    });
    githubSave.addEventListener("click", async () => {
      const value = githubInput.value.trim();
      if (!value) return;
      githubSave.disabled = true;
      status.textContent = "Saving GitHub token...";
      try {
        await updateGithubToken({ value });
        githubInput.value = "";
        githubInput.hidden = true;
        githubSave.hidden = true;
        renderGithubTokenStatus(popover, true);
        status.textContent = "GitHub token saved.";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        githubSave.disabled = false;
      }
    });
    githubClear.addEventListener("click", async () => {
      githubClear.disabled = true;
      status.textContent = "Removing GitHub token...";
      try {
        await updateGithubToken({ clear: true });
        renderGithubTokenStatus(popover, false);
        status.textContent = "GitHub token removed.";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        githubClear.disabled = false;
      }
    });
    popover.querySelector("[data-role='edit-project-name']").addEventListener("click", async () => {
      status.textContent = "Updating project name...";
      try {
        const saved = await openProjectIdentityEditor({ source: "settings", popover });
        if (!saved) status.textContent = "";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
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

  function updatePopoverStatus(popover, target) {
    const key = targetKey(target);
    if (!popover || popover.dataset.targetKey !== key) return;
    const statusInfo = latestStatuses[key] || { status: "unknown" };
    const currentStatus = statusInfo.status || "unknown";
    const actionStatus = getActionStatus(statusInfo);
    const chip = popover.querySelector(".ol-lean-status-chip");
    const detail = popover.querySelector(".ol-lean-popover-detail");
    const actions = popover.querySelector("[data-role='theorem-actions']");
    const leanStatement = popover.querySelector(".ol-lean-popover-lean");
    const stubbedWarning = popover.querySelector(".ol-lean-popover-warning");

    if (chip) {
      chip.className = `ol-lean-status-chip ol-lean-status-chip-${currentStatus}`;
      chip.textContent = formatStatus(currentStatus, statusInfo);
      if (hasStubbedTheoremUses(statusInfo)) {
        chip.appendChild(createStubbedTheoremUsesMark());
      }
    }
    if (actions) {
      renderTargetActions(actions, target, currentStatus, popover.querySelector(".ol-lean-popover-status"), leanStatement, actionStatus, statusInfo);
    }

    if (detail) {
      if (isExtensionContextInvalidated()) {
        detail.textContent = "Extension was reloaded. Refresh this Overleaf tab.";
      } else if (statusInfo.message) {
        detail.textContent = statusInfo.message;
      } else if (statusInfo.relativePath) {
        detail.textContent = statusInfo.relativePath;
      } else if (currentStatus === "in_progress") {
        detail.textContent = inProgressMessage(statusInfo, target);
      } else {
        detail.textContent = `Ready to send this ${targetNoun(target)} to Lea.`;
      }
    }
    renderLeanStatement(leanStatement, statusInfo.leanStatement || "");
    renderTargetWarning(stubbedWarning, target, statusInfo);
  }

  async function formalize(target) {
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
        targetKind: target.targetKind,
        targetLabel: target.targetLabel,
        targetText: target.targetText,
        targetUses: target.targetUses || [],
        targetContext: target.targetContext || "",
        projectName: lastProjectIdentity?.projectName || guessProjectName(lastLeanPaneFiles || []),
        projectNamespace: lastProjectIdentity?.namespace || "",
        sourceHash: await sha256(normalizeTargetText(target.targetText))
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    return payload;
  }

  async function stubTheorem(target) {
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
        targetKind: target.targetKind,
        targetLabel: target.targetLabel,
        targetText: target.targetText,
        targetUses: target.targetUses || [],
        targetContext: target.targetContext || "",
        projectName: lastProjectIdentity?.projectName || guessProjectName(lastLeanPaneFiles || []),
        projectNamespace: lastProjectIdentity?.namespace || "",
        sourceHash: await sha256(normalizeTargetText(target.targetText))
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    return payload;
  }

  // Build the full per-item payload /stub and /formalize expect (the same shape
  // the single-item formalize() sends), for every item a batch will run over.
  async function buildBatchTargetPayloads(items) {
    const overleafProjectId = extractOverleafProjectId();
    const projectName = lastProjectIdentity?.projectName || guessProjectName(lastLeanPaneFiles || []);
    const projectNamespace = lastProjectIdentity?.namespace || "";
    return Promise.all(items.map(async (item) => {
      const target = leanPaneView.paneItemToFormalizeTarget(item);
      return {
        overleafProjectId,
        targetKind: target.targetKind,
        targetLabel: target.targetLabel,
        targetText: target.targetText,
        targetUses: target.targetUses || [],
        targetContext: target.targetContext || "",
        projectName,
        projectNamespace,
        sourceHash: await sha256(normalizeTargetText(target.targetText))
      };
    }));
  }

  // "Stub all" / "Formalize all": the batch versions of the per-item buttons.
  // They gather the eligible items from the live manifest, flush the .tex
  // mirror (statement translation reads local notation), POST the full target
  // set to the companion, then drive the SAME batch panel + polling the repair
  // batch uses -- one shared progress surface, distinguished by `operation`.
  async function runTargetBatch({ endpoint, items, errorKey }) {
    leanPaneRepairError = null;
    if (items.length === 0) return;
    try {
      await syncTexMirrorNow({ force: true }).catch(() => {});
      const baseUrl = await chatCompanionBaseUrl();
      const payloads = await buildBatchTargetPayloads(items);
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overleafProjectId: extractOverleafProjectId(), items: payloads })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || `Companion returned HTTP ${response.status}.`);
      leanPaneRepairBatch = payload;
      startRepairBatchPolling();
    } catch (error) {
      leanPaneRepairError = { itemKey: errorKey, message: normalizeErrorMessage(error) };
    }
    renderLeanPaneManifest(lastLeanPaneManifest);
    scheduleLeanPaneRefresh();
  }

  function stubAllTheorems() {
    const items = leanPaneView.stubbableItems(lastLeanPaneManifest?.items || []);
    return runTargetBatch({ endpoint: "/stub/all", items, errorKey: "batch" });
  }

  function formalizeAllItems() {
    const items = leanPaneView.formalizableItems(lastLeanPaneManifest?.items || []);
    return runTargetBatch({ endpoint: "/formalize/all", items, errorKey: "batch" });
  }

  async function refreshSingleStatus(target) {
    await refreshStatusesNow();
    return latestStatuses[targetKey(target)] || {
      status: "unavailable",
      relativePath: ""
    };
  }

  function scheduleStatusRefresh(delayMs = STATUS_REFRESH_DEBOUNCE_MS) {
    clearTimeout(statusRefreshTimer);
    statusRefreshTimer = setTimeout(() => {
      refreshStatusesNow().catch((error) => {
        postStatusError(error);
      });
    }, delayMs);
  }

  async function refreshStatusesNow() {
    if (latestTargets.length === 0) {
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
        targets: latestTargets.map((target) => ({
          targetKind: target.targetKind,
          targetLabel: target.targetLabel,
          targetText: target.targetText
        }))
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    postStatuses(withFallbackStatuses(payload.statuses || {}));
    if (activePopover?.dataset.targetKey) {
      const target = latestTargets.find((item) => targetKey(item) === activePopover.dataset.targetKey);
      if (target) updatePopoverStatus(activePopover, target);
    }
    if (Object.values(latestStatuses).some((status) => status.status === "in_progress")) {
      scheduleStatusRefresh(pushConnected ? STATUS_REFRESH_RECONCILE_MS : STATUS_REFRESH_IN_PROGRESS_MS);
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
      // Two sync tiers (PLAN-system-hardening 3.2): the whole-project zip
      // download used to run on every edit-pause once a project was activated
      // — heavy for large projects and unkind to Overleaf's servers. Now an
      // ordinary edit ships just the active editor buffer (mode "upsert" —
      // the adapter writes it without treating absent files as deleted); the
      // zip + full reconcile runs only on activation, when the active file
      // isn't in the cached set (new/renamed doc), on a periodic refresh to
      // pick up collaborator edits, and stays the base of the forced
      // pre-formalize sync.
      const activeRel = String(latestActiveTexPath || "").replace(/^\/+/, "");
      const cacheUsable = Boolean(lastMirrorFiles) && lastMirrorProjectId === projectId;
      const activeKnown = !activeRel || (cacheUsable && lastMirrorFiles.some((file) => file.path === activeRel));
      const fullSyncDue =
        !cacheUsable ||
        !activeKnown ||
        Date.now() - lastTexMirrorFullSyncAt > TEX_MIRROR_FULL_SYNC_INTERVAL_MS;

      if (!force && !fullSyncDue && activeRel && typeof latestActiveTex === "string") {
        const response = await fetch(`${baseUrl}/mirror-tex`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            overleafProjectId: projectId,
            mode: "upsert",
            files: [{ path: activeRel, content: latestActiveTex }]
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
        }
        lastMirrorFiles = lastMirrorFiles.map((file) =>
          file.path === activeRel ? { ...file, content: latestActiveTex } : file
        );
        texMirrorDirty = false;
        return payload;
      }

      // Full tier. Re-download + unzip only when the cached set can't serve
      // (new project / unknown active file / periodic refresh); a forced
      // pre-formalize sync with a healthy cache POSTs the cached set — the
      // adapter is authoritative and no-ops cheaply on identical content, so
      // divergence self-heals without a zip per formalize.
      const needFetch = !cacheUsable || !activeKnown ||
        Date.now() - lastTexMirrorFullSyncAt > TEX_MIRROR_FULL_SYNC_INTERVAL_MS;
      const files = needFetch ? await collectProjectTexFiles(projectId) : lastMirrorFiles;
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
      if (needFetch) lastTexMirrorFullSyncAt = Date.now();
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
    for (const target of latestTargets) {
      statuses[targetKey(target)] = {
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
    for (const target of latestTargets) {
      const key = targetKey(target);
      if (!completeStatuses[key]) {
        completeStatuses[key] = {
          status: "unavailable",
          message: `The companion did not return a status for this ${targetNoun(target)}.`
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
      const coords = diagnostic.coords;
      if (!coords) continue;
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
    for (const target of latestTargets) {
      const coords = target.coords;
      if (!coords) continue;
      const statusInfo = latestStatuses[targetKey(target)] || { status: "unknown" };
      const status = statusInfo.status || "unknown";
      const badge = document.createElement("button");
      badge.className = `ol-lean-status ol-lean-status-${status}`;
      badge.type = "button";
      badge.appendChild(document.createTextNode(formatStatus(status, statusInfo)));
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
      const statusLabel = `${formatStatus(status, statusInfo)}${turnProgress.label ? ` ${turnProgress.label}` : ""}${stubbedUsesLabel}`;
      badge.title = statusInfo.message || `Lean status for ${target.targetLabel}: ${statusLabel}`;
      badge.setAttribute("aria-label", `Open Lea popover for ${target.targetLabel}. Status: ${statusLabel}.`);
      badge.style.left = `${Math.min(coords.left + 8, window.innerWidth - 140)}px`;
      badge.style.top = `${coords.top}px`;
      badge.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showTargetPopover(event.clientX, event.clientY, target);
      });
      badgeLayer.appendChild(badge);
    }
  }

  function formatStatus(status, statusInfo = null) {
    if ((status === "formalized" || status === "defined") && statusInfo?.resultKind === "defined") {
      return "defined";
    }
    switch (status) {
      case "unformalized":
        return "unformalized";
      case "in_progress":
        return "in progress";
      case "formalized":
        return "formalized";
      case "defined":
        return "defined";
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

  function inProgressMessage(statusInfo, target = null) {
    const turnProgressText = formatTurnProgress(statusInfo);
    const noun = targetNoun(target);
    return turnProgressText
      ? `Lea ${noun} formalization is in progress: ${turnProgressText}.`
      : `Lea ${noun} formalization is in progress. Waiting for the first turn update.`;
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
    const names = uses.map((use) => use.declarationName || use.targetLabel).filter(Boolean).join(", ");
    const plural = uses.length !== 1;
    element.hidden = false;
    element.textContent = plural
      ? `Proof uses supporting theorems ${names}, which have been sorry stubbed but not fully formalized.`
      : `Proof uses supporting theorem ${names}, which has been sorry stubbed but not fully formalized.`;
  }

  function renderTargetWarning(element, target, statusInfo) {
    if (!element) return;
    const uses = getStubbedTheoremUses(statusInfo);
    if (uses.length > 0) {
      renderStubbedTheoremUsesWarning(element, statusInfo);
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

  function buttonTextForStatus(status, target = null) {
    const definition = isDefinitionTarget(target);
    switch (status) {
      case "in_progress":
        return "Formalizing...";
      case "formalized":
      case "defined":
      case "disproved":
      case "unknown":
        return "Check status";
      case "sorry_stub":
      case "unformalized":
      default:
        return definition ? "Regenerate definition" : "Run Lea";
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
    // A malformed stored leaUiBaseUrl (a user typo in options) must not throw
    // out of popover render (AUDIT L4) — fall back to the default origin.
    let url;
    try {
      url = new URL(baseUrl || DEFAULT_LEA_UI_BASE_URL);
    } catch {
      url = new URL(DEFAULT_LEA_UI_BASE_URL);
    }
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
    renderGithubTokenStatus(popover, Boolean(settings.githubTokenConfigured));
    popover.dataset.savedModel = modelSelect.value;
    popover.dataset.savedMaxTurns = String(Number.parseInt(maxTurnsInput.value, 10) || DEFAULT_LEA_MAX_TURNS);
    popover.dataset.savedMaxSpend = settings.leaMaxSpendUsd == null ? "" : String(settings.leaMaxSpendUsd);
    popover.dataset.savedTexMirror = String(texMirrorInput.checked);
    popover.querySelector("[data-role='save-settings']").disabled = true;
    try {
      const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
      lastProjectIdentity = await loadProjectIdentity({ baseUrl, projectId: extractOverleafProjectId() });
      renderProjectSettingsSection(popover, lastProjectIdentity);
      renderLeanPaneProjectIdentity(lastProjectIdentity);
    } catch {
      renderProjectSettingsSection(popover, null);
    }
  }

  function renderProjectSettingsSection(popover, identity) {
    const projectName = popover.querySelector("[data-role='project-name']");
    const exists = popover.querySelector("[data-role='project-exists']");
    const namespace = popover.querySelector("[data-role='project-namespace']");
    const binding = popover.querySelector("[data-role='project-binding']");
    const fallback = guessProjectName(lastLeanPaneFiles || []);
    if (projectName) projectName.textContent = identity?.projectName || fallback;
    if (exists) exists.textContent = identity?.exists ? "Created" : "Not created";
    if (namespace) namespace.textContent = `Lean namespace: ${identity?.namespace || "--"}`;
    if (binding) binding.textContent = `Overleaf binding: ${identity?.slug || extractOverleafProjectId() || "--"}`;
  }

  function renderGithubTokenStatus(popover, configured) {
    const panel = popover.querySelector("[data-role='github-token-panel']");
    const chip = popover.querySelector("[data-role='github-token-status']");
    const toggle = popover.querySelector("[data-role='github-token-toggle']");
    const clear = popover.querySelector("[data-role='github-token-clear']");
    if (!chip) return;
    // Same configured-state styling hook as the provider-key rows.
    const row = panel?.querySelector(".ol-lean-provider-row");
    if (row) row.dataset.configured = configured ? "true" : "false";
    chip.textContent = configured ? "Configured" : "Missing";
    if (toggle) toggle.textContent = configured ? "Replace token" : "Add token";
    if (clear) clear.hidden = !configured;
  }

  // POST /settings/github-token: { value } saves, { clear: true } removes. The
  // companion writes through to the adapter's settings and never persists the
  // token itself.
  async function updateGithubToken(payload) {
    const baseUrl = await chatCompanionBaseUrl();
    const response = await fetch(`${baseUrl}/settings/github-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.message || `Could not update the GitHub token (HTTP ${response.status}).`);
    }
    return body;
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
      // 5s, not 1s (AUDIT M4): each refresh fans out to the adapter's
      // /api/stats; the settings popover doesn't need per-second usage.
    }, 5000);
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
    for (const [statusKey, statusInfo] of Object.entries(statuses || {})) {
      if (!isMaxSpendStatus(statusInfo)) continue;
      parts.push([
        statusKey,
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

  function rememberTarget(target) {
    if (!target?.targetLabel) return;
    const key = targetKey(target);
    const existingIndex = latestTargets.findIndex((item) => targetKey(item) === key);
    if (existingIndex === -1) {
      latestTargets = [...latestTargets, target];
      return;
    }
    latestTargets = latestTargets.map((item, index) => (index === existingIndex ? target : item));
  }

  function targetKey(target) {
    return `${target?.targetKind || "theorem"}:${target?.targetLabel || ""}`;
  }

  function isDefinitionTarget(target) {
    return target?.targetKind === "definition";
  }

  function targetNoun(target) {
    return isDefinitionTarget(target) ? "definition" : "theorem";
  }

  function extractOverleafProjectId() {
    const match = location.pathname.match(/\/project\/([^/]+)/);
    return match ? match[1] : "unknown";
  }

  function normalizeDocPath(value) {
    return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  }

  function normalizeTargetText(text) {
    return String(text).replace(/\s+/g, " ").trim();
  }

  async function sha256(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function startEventsClient() {
    try {
      const module = await import(chrome.runtime.getURL("eventsClient.mjs"));
      // The companion URL comes from settings (async); cache it for the
      // client's synchronous url() and refresh the cache on every reconnect
      // attempt so a settings change is picked up without a page reload.
      let companionUrlCache = DEFAULT_COMPANION_URL;
      const refreshUrlCache = () => {
        getSettings()
          .then((settings) => {
            companionUrlCache = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
          })
          .catch(() => {});
      };
      refreshUrlCache();
      eventsClient = module.createEventsClient({
        url: () => {
          refreshUrlCache();
          const projectId = extractOverleafProjectId();
          const query = projectId && projectId !== "unknown"
            ? `?projectId=${encodeURIComponent(projectId)}`
            : "";
          return `${companionUrlCache}/events${query}`;
        },
        onEvent: handlePushEvent,
        onConnectionChange: (connected) => {
          pushConnected = connected;
          if (connected) {
            // Reconcile once on (re)connect: anything that changed while the
            // stream was down is picked up now instead of on the slow poll.
            scheduleStatusRefresh();
            if (leanPane) scheduleLeanPaneRefresh();
          }
        },
        // Bind EventSource + timers to the content-script scope: the module's
        // own defaults resolve in the module realm, which under the test
        // harness is Node's — real sockets and a real clock (same trap as
        // editorHookWatchdog). `typeof` guard: no EventSource here means the
        // push channel is unavailable and the polls stay primary.
        EventSourceImpl: typeof EventSource === "undefined" ? null : EventSource,
        setTimeoutImpl: (fn, ms) => setTimeout(fn, ms),
        clearTimeoutImpl: (id) => clearTimeout(id)
      });
      eventsClient.start();
    } catch {
      // Push is an optimization; the poll fallback keeps everything working.
    }
  }

  function handlePushEvent(type, data) {
    if (type === "jobs-changed") {
      scheduleStatusRefresh();
      if (leanPane) scheduleLeanPaneRefresh();
      return;
    }
    if (type === "chat-updated") {
      // Only refetch when the chat panel is open — and if the event names a
      // target, only when it's the one being viewed.
      if (!leanPaneChatPanel || !leanPaneChatItem) return;
      const eventKey = data && typeof data.targetKey === "string" ? data.targetKey : "";
      if (eventKey && leanPaneChatTarget?.targetKey && eventKey !== leanPaneChatTarget.targetKey) return;
      pollChatSession().catch(() => {});
      return;
    }
    if (type === "repair-batch-updated") {
      if (!leanPaneRepairBatch?.batchId) return;
      if (data && data.batchId && data.batchId !== leanPaneRepairBatch.batchId) return;
      startRepairBatchPolling({ immediate: true });
    }
  }

  async function startEditorHookWatchdog() {
    try {
      const module = await import(chrome.runtime.getURL("editorHookWatchdog.mjs"));
      editorHookWatchdog = module.createEditorHookWatchdog({
        // querySelector guard: exotic embedding contexts (and the test
        // harness's minimal document) may lack it — treat as "no editor".
        isEditorPresent: () =>
          typeof document.querySelector === "function" &&
          Boolean(document.querySelector(".cm-editor, .cm-content")),
        onWarn: renderEditorHookWarning,
        onRecover: removeEditorHookWarning,
        // Bind timers to the content-script scope: the module's own defaults
        // resolve in the module realm, which under the test harness is the
        // real Node clock rather than the page's (fake) one.
        setTimeoutImpl: (fn, ms) => setTimeout(fn, ms),
        clearTimeoutImpl: (id) => clearTimeout(id)
      });
      // The hook signal can beat the module import — honor it instead of arming.
      if (editorHookSignalSeen) editorHookWatchdog.editorHooked();
      else editorHookWatchdog.arm();
    } catch {
      // Best-effort: the watchdog must never break the page.
    }
  }

  function renderEditorHookWarning() {
    if (editorHookWarningBanner) return;
    const banner = document.createElement("div");
    banner.className = "ol-lean-editor-hook-warning";
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Lea can't attach to the Overleaf editor";
    const detail = document.createElement("span");
    detail.textContent = "Overleaf may have changed its editor internals. Theorem badges and % lea: markers won't work until the extension is updated.";
    body.append(title, detail);
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", removeEditorHookWarning);
    banner.append(body, dismiss);
    (document.body || document.documentElement).appendChild(banner);
    editorHookWarningBanner = banner;
  }

  function removeEditorHookWarning() {
    editorHookWarningBanner?.remove();
    editorHookWarningBanner = null;
  }

  function injectPageBridge() {
    const script = document.createElement("script");
    script.type = "module";
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

  function requestTargetsSoon() {
    requestTargets();
    setTimeout(requestTargets, 300);
    setTimeout(requestTargets, 1000);
  }

  function requestTargets() {
    window.postMessage({ type: "OL_LEAN_REQUEST_TARGETS" }, "*");
  }
})();

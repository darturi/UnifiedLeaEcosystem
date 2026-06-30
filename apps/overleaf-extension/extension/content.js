(function () {
  const DEFAULT_COMPANION_URL = "http://127.0.0.1:31245";
  const DEFAULT_LEA_UI_BASE_URL = "http://localhost:5173";
  const DEFAULT_LEA_MODEL = "o4-mini";
  const DEFAULT_LEA_MAX_TURNS = 20;
  const DEFAULT_LEA_TEX_MIRROR_ENABLED = true;
  const LEA_UI_VIEW_STATUSES = new Set(["formalized", "defined", "disproved", "in_progress", "sorry_stub"]);
  const TEX_MIRROR_SYNC_DELAY_MS = 1500;
  const LEAN_PANE_REFRESH_DELAY_MS = 1500;
  const LEAN_PANE_POLL_DELAY_MS = 4000;
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
  let latestStatuses = {};
  let badgeLayer = null;
  let settingsButton = null;
  let leanPaneButton = null;
  let leanPane = null;
  let leanPaneBody = null;
  let leanPaneStatus = null;
  let leanPaneRefreshTimer = null;
  let leanPanePollTimer = null;
  let leanPaneView = null;
  let leanPaneExpandedTreeNodeIds = new Set();
  let leanPaneTreeDefaultsKey = "";
  let leanPaneExpandedItemIds = new Set();
  let leanPaneHighlightTimer = null;
  let lastLeanPaneManifest = null;
  let lastLeanPaneFiles = null;
  let lastLeanPaneProjectId = "";
  let costCapNotice = null;
  let dismissedCostCapNoticeKeys = new Set();
  let activeCostCapNoticeKeys = new Set();
  let costCapUsageLimitReached = false;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
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
  requestTargetsSoon();
  renderSettingsButton();
  renderLeanPaneButton();

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (activePopover) {
      closePopover();
      return;
    }
    if (leanPane) closeLeanPane();
  });

  document.addEventListener("click", (event) => {
    if (activePopover && !activePopover.contains(event.target)) {
      closePopover();
    }
  });

  window.addEventListener("resize", renderStatusBadges);
  window.addEventListener("scroll", () => {
    requestTargets();
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
    leanPane = document.createElement("aside");
    leanPane.className = "ol-lean-project-pane";
    leanPane.setAttribute("role", "complementary");
    leanPane.setAttribute("aria-label", "Lean project pane");
    leanPane.tabIndex = -1;

    const header = document.createElement("div");
    header.className = "ol-lean-project-pane-header";
    const titleWrap = document.createElement("div");
    const kicker = document.createElement("p");
    kicker.className = "ol-lean-project-pane-kicker";
    kicker.textContent = "Project preview";
    const title = document.createElement("h2");
    title.textContent = "Lean pane";
    titleWrap.appendChild(kicker);
    titleWrap.appendChild(title);

    const controls = document.createElement("div");
    controls.className = "ol-lean-project-pane-controls";
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
    controls.appendChild(refresh);
    controls.appendChild(close);
    header.appendChild(titleWrap);
    header.appendChild(controls);

    leanPaneStatus = document.createElement("p");
    leanPaneStatus.className = "ol-lean-project-pane-status";
    leanPaneBody = document.createElement("div");
    leanPaneBody.className = "ol-lean-project-pane-body";

    leanPane.appendChild(header);
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
    if (!leanPane) return;
    leanPane.remove();
    leanPane = null;
    leanPaneBody = null;
    leanPaneStatus = null;
    leanPaneExpandedTreeNodeIds = new Set();
    leanPaneTreeDefaultsKey = "";
  }

  // Load the pure pane helpers once. The pane is only built on user click (well
  // after startup), so a lazy import here always resolves before any render runs.
  async function ensureLeanPaneView() {
    if (leanPaneView) return leanPaneView;
    leanPaneView = await import(chrome.runtime.getURL("leanPaneView.mjs"));
    return leanPaneView;
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
    await ensureLeanPaneView();
    if (!background) {
      leanPaneStatus.textContent = "Loading project inventory...";
      leanPaneBody.replaceChildren();
    }

    const projectId = extractOverleafProjectId();
    const files = await getLeanPaneProjectFiles({ projectId, forceFetch });
    const settings = await getSettings();
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
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
    }, LEAN_PANE_POLL_DELAY_MS);
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

    const chip = document.createElement("span");
    chip.className = `ol-lean-project-status ol-lean-project-tree-status ol-lean-project-status-${node.status || "unknown"}`;
    chip.textContent = leanPaneView.formatPaneStatus(node.status || "unknown");
    row.appendChild(chip);
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
    card.appendChild(header);

    const natural = document.createElement("p");
    natural.className = "ol-lean-project-natural";
    renderLeanPaneLatex(natural, item.naturalLanguageLatex || item.naturalLanguageRendered || "");
    card.appendChild(natural);

    if (item.leanStub) {
      const stub = document.createElement("pre");
      stub.className = "ol-lean-project-code";
      renderLeanPaneCode(stub, item.leanStub);
      card.appendChild(stub);
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

    const actions = document.createElement("div");
    actions.className = "ol-lean-project-detail-actions";
    actions.appendChild(renderGoToSourceButton(item));
    if (leanPaneView.canFormalizePaneItem(item)) {
      actions.appendChild(renderFormalizeButton(item));
    }
    if (item.leanStub) {
      actions.appendChild(renderCopyButton("Copy stub", item.leanStub));
    }
    if (item.leanArtifactContent) {
      actions.appendChild(renderCopyButton("Copy artifact", item.leanArtifactContent));
    }
    if (actions.children.length > 0) detail.appendChild(actions);

    if (item.leanArtifactContent) {
      const artifact = document.createElement("pre");
      artifact.className = "ol-lean-project-artifact";
      renderLeanPaneCode(artifact, item.leanArtifactContent);
      detail.appendChild(artifact);
    } else {
      const empty = document.createElement("p");
      empty.className = "ol-lean-project-missing";
      empty.textContent = "No generated Lean artifact is available for this item.";
      detail.appendChild(empty);
    }
    return detail;
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
  function renderGoToSourceButton(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ol-lean-secondary-button";
    button.textContent = "Go to source";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
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
    });
    return button;
  }

  // Item 12: start a formalization run for this item, reusing the same /formalize
  // path the in-document badge uses, then refresh so the pane reflects in-progress
  // (polling, from item 4, takes over until it settles).
  function renderFormalizeButton(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ol-lean-secondary-button ol-lean-formalize-button";
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

  function renderCopyButton(label, text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ol-lean-secondary-button";
    button.textContent = label;
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy failed";
      }
    });
    return button;
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
        sourceHash: await sha256(normalizeTargetText(target.targetText))
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    return payload;
  }

  async function refreshSingleStatus(target) {
    await refreshStatusesNow();
    return latestStatuses[targetKey(target)] || {
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

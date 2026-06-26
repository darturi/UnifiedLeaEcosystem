import { parseTargetDocument } from "./targetParserCore.mjs";

(function () {
  let activeView = null;
  const NAVIGATE_POLL_INTERVAL_MS = 120;
  const NAVIGATE_POLL_ATTEMPTS = 25; // ~3s for a freshly-opened doc to load

  window.addEventListener("UNSTABLE_editor:extensions", (event) => {
    const detail = event.detail || {};
    const CodeMirror = detail.CodeMirror || window.CodeMirror;
    const extensions = detail.extensions;

    if (!CodeMirror || !Array.isArray(extensions)) {
      return;
    }

    const ViewPlugin = CodeMirror.ViewPlugin;
    const Decoration = CodeMirror.Decoration;
    if (!ViewPlugin || !Decoration) {
      return;
    }

    const targetMark = Decoration.mark({ class: "ol-lean-theorem" });

    function buildDecorations(view) {
      const builder = [];
      const source = view.state.doc.toString();
      const documentResult = parseTargetDocument(source);
      for (const target of [...documentResult.targets, ...documentResult.diagnostics]) {
        builder.push(targetMark.range(target.from, target.to));
      }
      return Decoration.set(builder, true);
    }

    const targetPlugin = ViewPlugin.fromClass(
      class {
        constructor(view) {
          activeView = view;
          this.decorations = buildDecorations(view);
          publishTargets(view);
        }

        update(update) {
          activeView = update.view;
          if (update.docChanged || update.viewportChanged) {
            this.decorations = buildDecorations(update.view);
            publishTargets(update.view);
          }
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
        eventHandlers: {
          click(event, view) {
            const coords = { x: event.clientX, y: event.clientY };
            const pos = view.posAtCoords(coords);
            if (typeof pos !== "number") return false;

            const target = findTargetAtPosition(view.state.doc.toString(), pos);
            if (!target) return false;

            event.preventDefault();
            event.stopPropagation();
            window.postMessage({
              type: target.syntax === "diagnostic" ? "OL_LEAN_DIAGNOSTIC_CLICK" : "OL_LEAN_TARGET_CLICK",
              clientX: event.clientX,
              clientY: event.clientY,
              target,
              diagnostic: target
            }, "*");
            return true;
          }
        }
      }
    );

    extensions.push(targetPlugin);
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "OL_LEAN_REQUEST_TARGETS") {
      if (activeView) publishTargets(activeView);
      return;
    }
    if (event.data?.type === "OL_LEAN_NAVIGATE") {
      navigateToSource(event.data);
      return;
    }
  });

  // Item 11: jump the editor to a source block. Navigation is anchored on the item's
  // marker text (robust to edits and path-format quirks) and falls back to byte
  // offsets. When the active document's path can't be matched to the item's file, the
  // current view is still attempted — Overleaf's internal path API is best-effort.
  function navigateToSource(message) {
    const activePath = getActiveDocPath();
    const inActiveFile = !activePath || sameDocPath(activePath, message?.sourceFile);

    if (inActiveFile) {
      const ok = selectTargetInActiveView(message, { allowOffsets: true });
      postNavigateResult(ok, ok ? "" : "not_found", message?.sourceFile);
      return;
    }

    // A different, known file: open it through Overleaf's IDE API (which also scrolls
    // to the line natively), then wait for that doc to become active and select the
    // block precisely.
    if (openDocByPath(message?.sourceFile, message)) {
      waitForActiveDoc(message?.sourceFile, message, NAVIGATE_POLL_ATTEMPTS);
      return;
    }

    // Couldn't switch files (private API changed/unavailable): only navigate in the
    // current view if the item's anchor text is actually present, so we never select
    // an unrelated range from a different file, and tell the UI it failed.
    const ok = selectTargetInActiveView(message, { allowOffsets: false });
    postNavigateResult(ok, ok ? "" : "open_failed", message?.sourceFile);
  }

  // After opening a different file, the new CodeMirror document loads asynchronously.
  // Poll (bounded) until the target doc is active (or its anchor text is visible),
  // then select; report failure if it never arrives.
  function waitForActiveDoc(targetPath, message, attempts) {
    const activePath = getActiveDocPath();
    const source = activeView ? activeView.state.doc.toString() : "";
    const ready = (activePath && sameDocPath(activePath, targetPath)) ||
      findAnchorIndex(source, message) >= 0;

    if (ready) {
      const ok = selectTargetInActiveView(message, { allowOffsets: true });
      postNavigateResult(ok, ok ? "" : "not_found", targetPath);
      return;
    }
    if (attempts <= 0) {
      postNavigateResult(false, "open_timeout", targetPath);
      return;
    }
    window.setTimeout(() => waitForActiveDoc(targetPath, message, attempts - 1), NAVIGATE_POLL_INTERVAL_MS);
  }

  function postNavigateResult(ok, reason, sourceFile) {
    window.postMessage({
      type: "OL_LEAN_NAVIGATE_RESULT",
      ok: Boolean(ok),
      reason: reason || "",
      sourceFile: sourceFile || ""
    }, "*");
  }

  function selectTargetInActiveView(message, { allowOffsets }) {
    const view = activeView;
    if (!view) return false;
    const source = view.state.doc.toString();

    let from = findAnchorIndex(source, message);
    let to = from;
    if (from < 0) {
      if (!allowOffsets) return false;
      const offsetFrom = Number(message?.from);
      if (!Number.isFinite(offsetFrom)) return false;
      from = offsetFrom;
      const offsetTo = Number(message?.to);
      to = Number.isFinite(offsetTo) ? offsetTo : offsetFrom;
    }

    const docLength = view.state.doc.length;
    const anchor = Math.max(0, Math.min(from, docLength));
    const head = Math.max(anchor, Math.min(to, docLength));
    view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
    if (typeof view.focus === "function") view.focus();
    return true;
  }

  // Locate the item's block by its marker text. Prefers the Lea marker
  // (`% lea: … label=<name>`), then the LaTeX `\label{…}`. Returns -1 if neither is
  // found (e.g. the item lives in a different file than the one open).
  function findAnchorIndex(source, message) {
    const text = String(source || "");
    const leanLabel = String(message?.leanLabel || "").trim();
    if (leanLabel) {
      const markerRe = new RegExp(
        `%[ \\t]*lea:[^\\n]*\\blabel[ \\t]*=[ \\t]*\\{?${escapeRegExp(leanLabel)}\\b`,
        "i"
      );
      const match = markerRe.exec(text);
      if (match) return match.index;
    }
    const latexLabel = String(message?.latexLabel || "").trim();
    if (latexLabel) {
      const index = text.indexOf(`\\label{${latexLabel}}`);
      if (index >= 0) return index;
    }
    return -1;
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function sameDocPath(a, b) {
    const left = normalizeDocPath(a);
    return left !== "" && left === normalizeDocPath(b);
  }

  function normalizeDocPath(value) {
    return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  }

  // Open a project file by path through Overleaf's IDE API. Tries the known method
  // shapes defensively (the private API has shifted across Overleaf versions) and
  // passes `gotoLine` so Overleaf scrolls to the block natively even before the
  // anchor-select runs. Returns true if a real open call was made.
  function openDocByPath(targetPath, message) {
    try {
      const ide = window._ide;
      const ft = ide && ide.fileTreeManager;
      const em = ide && ide.editorManager;
      if (!ft || !em) return false;
      const wanted = normalizeDocPath(targetPath);
      if (!wanted) return false;

      const entity = resolveEntityByPath(ft, wanted);
      if (!entity) return false;

      const line = Number(message?.line);
      const options = Number.isFinite(line) && line > 0 ? { gotoLine: line } : {};

      if (typeof em.openDoc === "function") {
        em.openDoc(entity, options);
        return true;
      }
      const id = entity._id || entity.id;
      if (id && typeof em.openDocId === "function") {
        em.openDocId(id, options);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // Resolve a file-tree entity from a path, tolerating the different return shapes
  // Overleaf's findEntityByPath has used (entity directly, or { entity, ... }) and
  // an optional leading slash.
  function resolveEntityByPath(ft, wanted) {
    if (typeof ft.findEntityByPath !== "function") return null;
    for (const candidate of [wanted, `/${wanted}`]) {
      try {
        const found = ft.findEntityByPath(candidate);
        const entity = found && (found.entity || found);
        if (entity && (entity._id || entity.id || entity.name || entity.type)) return entity;
      } catch {
        // try the next candidate form
      }
    }
    return null;
  }

  window.setInterval(() => {
    if (activeView) publishTargets(activeView);
  }, 1500);

  function getActiveDocPath() {
    try {
      const ide = window._ide;
      const ft = ide && ide.fileTreeManager;
      const docId = ide && ide.editorManager &&
        (ide.editorManager.getCurrentDocId ? ide.editorManager.getCurrentDocId() : ide.editorManager.openDocId);
      if (!docId || !ft) return "";
      const entity = ft.findEntityById ? ft.findEntityById(docId) : null;
      if (!entity) return "";
      if (ft.getEntityPath) return ft.getEntityPath(entity) || "";
      return entity.path || "";
    } catch {
      return "";
    }
  }

  function publishTargets(view) {
    const source = view.state.doc.toString();
    const documentResult = parseTargetDocument(source);
    window.postMessage({
      type: "OL_LEAN_TARGETS_VISIBLE",
      activeTex: source,
      activePath: getActiveDocPath(),
      targets: documentResult.targets.map((target) => withCoords(view, target)).filter(hasCoords),
      diagnostics: documentResult.diagnostics.map((diagnostic) => withCoords(view, diagnostic)).filter(hasCoords)
    }, "*");
  }

  function findTargetAtPosition(source, position) {
    const documentResult = parseTargetDocument(source);
    return [...documentResult.targets, ...documentResult.diagnostics]
      .find((target) => target.from <= position && position <= target.to);
  }

  function withCoords(view, target) {
    return {
      targetKind: target.targetKind,
      targetLabel: target.targetLabel,
      targetText: target.targetText,
      targetUses: target.targetUses,
      targetContext: target.targetContext,
      latexEnvironment: target.latexEnvironment,
      latexLabel: target.latexLabel,
      sourceHash: target.sourceHash,
      syntax: target.syntax,
      code: target.code,
      message: target.message,
      from: target.from,
      to: target.to,
      badgeFrom: target.badgeFrom,
      bodyFrom: target.bodyFrom,
      bodyTo: target.bodyTo,
      coords: getTargetCoords(view, target)
    };
  }

  function hasCoords(target) {
    return Boolean(target.coords);
  }

  function getTargetCoords(view, target) {
    const positions = [
      target.badgeFrom,
      target.bodyFrom,
      target.from,
      Math.max(target.from, target.to - 1)
    ].filter((position) => typeof position === "number");
    let coords = null;
    for (const position of positions) {
      coords = view.coordsAtPos(position);
      if (coords) break;
    }
    if (!coords) {
      return null;
    }
    if (!isUsableCoords(view, coords)) {
      return null;
    }
    return {
      left: Math.max(coords.right, coords.left),
      top: coords.top,
      bottom: coords.bottom
    };
  }

  function isUsableCoords(view, coords) {
    if (![coords.left, coords.right, coords.top, coords.bottom].every(Number.isFinite)) {
      return false;
    }

    const viewportHeight = Number.isFinite(window.innerHeight) ? window.innerHeight : null;
    if (viewportHeight !== null && (coords.bottom < 0 || coords.top > viewportHeight)) {
      return false;
    }

    const editorRect = view.scrollDOM?.getBoundingClientRect?.() || view.dom?.getBoundingClientRect?.();
    if (editorRect && (coords.bottom < editorRect.top || coords.top > editorRect.bottom)) {
      return false;
    }

    return true;
  }
})();

import { parseTargetDocument } from "./targetParserCore.mjs";

(function () {
  let activeView = null;

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
    if (event.data?.type !== "OL_LEAN_REQUEST_TARGETS") return;
    if (activeView) publishTargets(activeView);
  });

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

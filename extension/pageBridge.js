(function () {
  const THEOREM_PREFIX = "\\theorem";
  const LABEL_PREFIX = "[label=";
  const LATEX_LABEL_PREFIX = "\\label";
  const LATEX_USES_PREFIX = "\\uses";
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

    const theoremMark = Decoration.mark({ class: "ol-lean-theorem" });

    function buildDecorations(view) {
      const builder = [];
      const source = view.state.doc.toString();
      for (const theorem of parseTheorems(source)) {
        builder.push(theoremMark.range(theorem.from, theorem.to));
      }
      return Decoration.set(builder, true);
    }

    const theoremPlugin = ViewPlugin.fromClass(
      class {
        constructor(view) {
          activeView = view;
          this.decorations = buildDecorations(view);
          publishTheorems(view);
        }

        update(update) {
          activeView = update.view;
          if (update.docChanged || update.viewportChanged) {
            this.decorations = buildDecorations(update.view);
            publishTheorems(update.view);
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

            const theorem = findTheoremAtPosition(view.state.doc.toString(), pos);
            if (!theorem) return false;

            event.preventDefault();
            event.stopPropagation();
            window.postMessage({
              type: "OL_LEAN_THEOREM_CLICK",
              clientX: event.clientX,
              clientY: event.clientY,
              theorem
            }, "*");
            return true;
          }
        }
      }
    );

    extensions.push(theoremPlugin);
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "OL_LEAN_REQUEST_THEOREMS") return;
    if (activeView) publishTheorems(activeView);
  });

  window.setInterval(() => {
    if (activeView) publishTheorems(activeView);
  }, 1500);

  function publishTheorems(view) {
    const theorems = parseTheorems(view.state.doc.toString());
    window.postMessage({
      type: "OL_LEAN_THEOREMS_VISIBLE",
      theorems: theorems.map((theorem) => ({
        label: theorem.label,
        text: theorem.text,
        uses: theorem.uses,
        from: theorem.from,
        to: theorem.to,
        coords: getTheoremCoords(view, theorem)
      }))
    }, "*");
  }

  function getTheoremCoords(view, theorem) {
    const coords = view.coordsAtPos(theorem.to) || view.coordsAtPos(theorem.from);
    if (!coords) {
      return {
        left: 24,
        top: 24,
        bottom: 42
      };
    }
    return {
      left: Math.max(coords.right, coords.left),
      top: coords.top,
      bottom: coords.bottom
    };
  }

  function parseTheorems(source) {
    const theorems = [];
    let index = 0;

    while (index < source.length) {
      const start = source.indexOf(THEOREM_PREFIX, index);
      if (start === -1) break;

      const parsed = parseTheoremAt(source, start);
      if (parsed.ok) {
        theorems.push(parsed.theorem);
        index = parsed.theorem.to;
      } else {
        index = start + THEOREM_PREFIX.length;
      }
    }

    return theorems;
  }

  function findTheoremAtPosition(source, position) {
    return parseTheorems(source).find((theorem) => theorem.from <= position && position <= theorem.to);
  }

  function parseTheoremAt(source, start) {
    if (!source.startsWith(THEOREM_PREFIX, start)) {
      return { ok: false };
    }

    let cursor = skipWhitespace(source, start + THEOREM_PREFIX.length);
    let label = null;

    if (source.startsWith(LABEL_PREFIX, cursor)) {
      const labelStart = cursor + LABEL_PREFIX.length;
      const labelEnd = source.indexOf("]", labelStart);
      if (labelEnd === -1) return { ok: false };
      label = source.slice(labelStart, labelEnd).trim();
      cursor = skipWhitespace(source, labelEnd + 1);
    }

    if (source[cursor] !== "{") return { ok: false };

    const bodyFrom = cursor + 1;
    let depth = 1;
    cursor = bodyFrom;

    while (cursor < source.length) {
      const char = source[cursor];
      const previous = source[cursor - 1];

      if (char === "{" && previous !== "\\") {
        depth += 1;
      } else if (char === "}" && previous !== "\\") {
        depth -= 1;
        if (depth === 0) {
          const bodyEnd = cursor;
          let theoremEnd = cursor + 1;
          const labelResult = label
            ? { ok: true, label, end: theoremEnd }
            : parseTrailingLatexLabel(source, theoremEnd);
          if (!labelResult.ok) return { ok: false };
          theoremEnd = labelResult.end;
          const usesResult = parseTrailingLatexUses(source, theoremEnd);
          if (!usesResult.ok) return { ok: false };
          theoremEnd = usesResult.end;
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(labelResult.label)) return { ok: false };

          return {
            ok: true,
            theorem: {
              label: labelResult.label,
              text: source.slice(bodyFrom, bodyEnd).trim(),
              uses: usesResult.uses,
              from: start,
              to: theoremEnd
            }
          };
        }
      }

      cursor += 1;
    }

    return { ok: false };
  }

  function parseTrailingLatexLabel(source, cursor) {
    cursor = skipWhitespace(source, cursor);
    if (!source.startsWith(LATEX_LABEL_PREFIX, cursor)) return { ok: false };

    cursor = skipWhitespace(source, cursor + LATEX_LABEL_PREFIX.length);
    if (source[cursor] !== "{") return { ok: false };

    const labelStart = cursor + 1;
    const labelEnd = source.indexOf("}", labelStart);
    if (labelEnd === -1) return { ok: false };

    return {
      ok: true,
      label: source.slice(labelStart, labelEnd).trim(),
      end: labelEnd + 1
    };
  }

  function parseTrailingLatexUses(source, cursor) {
    const originalCursor = cursor;
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === "%" && source[cursor - 1] !== "\\") {
      const commentUsesStart = skipWhitespace(source, cursor + 1);
      if (!source.startsWith(LATEX_USES_PREFIX, commentUsesStart)) {
        return { ok: true, uses: [], end: originalCursor };
      }
      cursor = commentUsesStart;
    }

    if (!source.startsWith(LATEX_USES_PREFIX, cursor)) {
      return { ok: true, uses: [], end: originalCursor };
    }

    cursor = skipWhitespace(source, cursor + LATEX_USES_PREFIX.length);
    if (source[cursor] !== "{") return { ok: false };

    const usesStart = cursor + 1;
    const usesEnd = source.indexOf("}", usesStart);
    if (usesEnd === -1) return { ok: false };

    return {
      ok: true,
      uses: source.slice(usesStart, usesEnd)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      end: usesEnd + 1
    };
  }

  function skipWhitespace(source, cursor) {
    while (cursor < source.length && /\s/.test(source[cursor])) {
      cursor += 1;
    }
    return cursor;
  }
})();

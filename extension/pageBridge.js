(function () {
  const THEOREM_PREFIX = "\\theorem";
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
        context: theorem.context,
        from: theorem.from,
        to: theorem.to,
        bodyFrom: theorem.bodyFrom,
        bodyTo: theorem.bodyTo,
        coords: getTheoremCoords(view, theorem)
      }))
    }, "*");
  }

  function getTheoremCoords(view, theorem) {
    const positions = [
      theorem.bodyTo,
      Math.max(theorem.from, theorem.to - 1),
      theorem.from
    ].filter((position) => typeof position === "number");
    let coords = null;
    for (const position of positions) {
      coords = view.coordsAtPos(position);
      if (coords) break;
    }
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

    if (source[cursor] !== "[") {
      return { ok: false };
    }

    const metadataResult = parseOptionalMetadata(source, cursor);
    if (!metadataResult.ok) return { ok: false };
    cursor = skipWhitespace(source, metadataResult.end);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(metadataResult.metadata.label || "")) return { ok: false };

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

          return {
            ok: true,
            theorem: {
              label: metadataResult.metadata.label,
              text: source.slice(bodyFrom, bodyEnd).trim(),
              uses: metadataResult.metadata.uses,
              context: metadataResult.metadata.context,
              from: start,
              to: cursor + 1,
              bodyFrom,
              bodyTo: bodyEnd
            }
          };
        }
      }

      cursor += 1;
    }

    return { ok: false };
  }

  function parseOptionalMetadata(source, cursor) {
    const metadataStart = cursor + 1;
    let depth = 0;
    let bracketDepth = 0;
    cursor = metadataStart;

    while (cursor < source.length) {
      const char = source[cursor];
      const previous = source[cursor - 1];

      if (char === "{" && previous !== "\\") {
        depth += 1;
      } else if (char === "}" && previous !== "\\") {
        depth = Math.max(0, depth - 1);
      } else if (char === "[" && previous !== "\\" && depth === 0) {
        bracketDepth += 1;
      } else if (char === "]" && previous !== "\\" && depth === 0 && bracketDepth > 0) {
        bracketDepth -= 1;
      } else if (char === "]" && previous !== "\\" && depth === 0) {
        return {
          ok: true,
          metadata: parseMetadata(source.slice(metadataStart, cursor)),
          end: cursor + 1
        };
      }

      cursor += 1;
    }

    return { ok: false };
  }

  function parseMetadata(source) {
    const metadata = { label: "", uses: [], context: "" };
    for (const entry of splitMetadataEntries(source)) {
      const separator = entry.indexOf("=");
      if (separator === -1) continue;

      const key = entry.slice(0, separator).trim();
      const value = unbrace(entry.slice(separator + 1).trim());
      if (key === "label") {
        metadata.label = value.trim();
      } else if (key === "uses") {
        metadata.uses = splitTopLevel(value, ",")
          .map((item) => unbrace(item.trim()).trim())
          .filter(Boolean);
      } else if (key === "context") {
        metadata.context = value.trim();
      }
    }
    return metadata;
  }

  function splitMetadataEntries(source) {
    const parts = [];
    let depth = 0;
    let bracketDepth = 0;
    let partStart = 0;

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const previous = source[index - 1];
      if (char === "{" && previous !== "\\") {
        depth += 1;
      } else if (char === "}" && previous !== "\\") {
        depth = Math.max(0, depth - 1);
      } else if (char === "[" && previous !== "\\" && depth === 0) {
        bracketDepth += 1;
      } else if (char === "]" && previous !== "\\" && depth === 0 && bracketDepth > 0) {
        bracketDepth -= 1;
      } else if (isMetadataSeparator(source, index, depth, bracketDepth)) {
        parts.push(source.slice(partStart, index));
        partStart = index + 1;
      }
    }

    parts.push(source.slice(partStart));
    return parts;
  }

  function isMetadataSeparator(source, index, depth, bracketDepth) {
    if (depth !== 0 || bracketDepth !== 0) {
      return false;
    }
    if (source[index] === ",") {
      return true;
    }
    if (source[index] !== "\n") {
      return false;
    }
    return /^(?:\s*)(?:label|uses|context)\s*=/.test(source.slice(index + 1));
  }

  function splitTopLevel(source, separator) {
    const parts = [];
    let depth = 0;
    let bracketDepth = 0;
    let partStart = 0;

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const previous = source[index - 1];
      if (char === "{" && previous !== "\\") {
        depth += 1;
      } else if (char === "}" && previous !== "\\") {
        depth = Math.max(0, depth - 1);
      } else if (char === "[" && previous !== "\\" && depth === 0) {
        bracketDepth += 1;
      } else if (char === "]" && previous !== "\\" && depth === 0 && bracketDepth > 0) {
        bracketDepth -= 1;
      } else if (char === separator && depth === 0 && bracketDepth === 0) {
        parts.push(source.slice(partStart, index));
        partStart = index + 1;
      }
    }

    parts.push(source.slice(partStart));
    return parts;
  }

  function unbrace(value) {
    if (value.startsWith("{") && value.endsWith("}")) {
      return value.slice(1, -1);
    }
    return value;
  }

  function skipWhitespace(source, cursor) {
    while (cursor < source.length && /\s/.test(source[cursor])) {
      cursor += 1;
    }
    return cursor;
  }
})();

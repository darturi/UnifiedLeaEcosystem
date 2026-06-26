import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const pageBridgePath = path.join(repoRoot, "apps/overleaf-extension/extension/pageBridge.js");

test("page bridge positions target badges from badgeFrom", async () => {
  const source = [
    "\\begin{definition}\\label{def:even-nat}",
    "% lea: define label=EvenNat",
    "A natural number is even if it is twice another natural number.",
    "\\end{definition}"
  ].join("\n");
  const expectedBadgeFrom = source.indexOf("\n");
  const messages = [];
  const listeners = new Map();
  const coordPositions = [];
  const extensions = [];

  globalThis.window = {
    CodeMirror: null,
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    postMessage(message) {
      messages.push(message);
    },
    setInterval() {}
  };

  try {
    await import(`${pathToFileURL(pageBridgePath).href}?badgeFrom=${Date.now()}`);
    const [installBridge] = listeners.get("UNSTABLE_editor:extensions") || [];
    assert.equal(typeof installBridge, "function");

    installBridge({
      detail: {
        extensions,
        CodeMirror: {
          ViewPlugin: {
            fromClass(PluginClass, spec) {
              return { PluginClass, spec };
            }
          },
          Decoration: {
            mark() {
              return {
                range(from, to) {
                  return { from, to };
                }
              };
            },
            set(ranges) {
              return ranges;
            }
          }
        }
      }
    });

    assert.equal(extensions.length, 1);
    const view = {
      state: {
        doc: {
          toString() {
            return source;
          }
        }
      },
      coordsAtPos(position) {
        coordPositions.push(position);
        return { left: position, right: position + 1, top: 10, bottom: 28 };
      }
    };

    new extensions[0].PluginClass(view);

    const visibleMessage = messages.find((message) => message.type === "OL_LEAN_TARGETS_VISIBLE");
    assert.ok(visibleMessage);
    assert.equal(visibleMessage.targets.length, 1);
    assert.equal(visibleMessage.targets[0].badgeFrom, expectedBadgeFrom);
    assert.equal(coordPositions[0], expectedBadgeFrom);
    assert.deepEqual(visibleMessage.targets[0].coords, {
      left: expectedBadgeFrom + 1,
      top: 10,
      bottom: 28
    });
  } finally {
    delete globalThis.window;
  }
});

test("page bridge does not publish targets when CodeMirror has no coordinates", async () => {
  const source = [
    "\\begin{theorem}",
    "% lea: formalize label=offscreen_theorem",
    "An offscreen theorem.",
    "\\end{theorem}"
  ].join("\n");
  const messages = [];
  const listeners = new Map();
  const extensions = [];

  globalThis.window = {
    CodeMirror: null,
    innerHeight: 768,
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    postMessage(message) {
      messages.push(message);
    },
    setInterval() {}
  };

  try {
    await import(`${pathToFileURL(pageBridgePath).href}?noCoords=${Date.now()}`);
    const [installBridge] = listeners.get("UNSTABLE_editor:extensions") || [];
    assert.equal(typeof installBridge, "function");

    installBridge({
      detail: {
        extensions,
        CodeMirror: {
          ViewPlugin: {
            fromClass(PluginClass, spec) {
              return { PluginClass, spec };
            }
          },
          Decoration: {
            mark() {
              return {
                range(from, to) {
                  return { from, to };
                }
              };
            },
            set(ranges) {
              return ranges;
            }
          }
        }
      }
    });

    const view = {
      state: {
        doc: {
          toString() {
            return source;
          }
        }
      },
      coordsAtPos() {
        return null;
      }
    };

    new extensions[0].PluginClass(view);

    const visibleMessage = messages.find((message) => message.type === "OL_LEAN_TARGETS_VISIBLE");
    assert.ok(visibleMessage);
    assert.deepEqual(visibleMessage.targets, []);
    assert.deepEqual(visibleMessage.diagnostics, []);
  } finally {
    delete globalThis.window;
  }
});

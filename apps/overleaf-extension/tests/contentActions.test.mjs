import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const contentScriptPath = path.join(repoRoot, "apps/overleaf-extension/extension/content.js");
const contentScript = fs.readFileSync(contentScriptPath, "utf8");

const CASES = [
  ["unformalized", { status: "unformalized", leaSessionId: "stale-session" }, false],
  ["unknown", { status: "unknown", leaSessionId: "stale-session" }, false],
  ["formalized", { status: "formalized" }, true],
  ["disproved", { status: "disproved" }, true],
  ["in_progress", { status: "in_progress" }, true],
  ["sorry_stub", { status: "sorry_stub" }, true],
  ["failed with unformalized effective status", { status: "failed", effectiveStatus: "unformalized", leaSessionId: "stale-session" }, false],
  ["failed with sorry_stub effective status", { status: "failed", effectiveStatus: "sorry_stub" }, true]
];

for (const [name, statusInfo, shouldShow] of CASES) {
  test(`View in Lea UI visibility: ${name}`, async () => {
    const harness = createContentHarness(statusInfo);
    await harness.loadStatusForVisibleTheorem();

    harness.window.postMessage({
      type: "OL_LEAN_TARGET_CLICK",
      target: harness.target,
      clientX: 16,
      clientY: 20
    }, "*");

    assert.equal(harness.hasViewInLeaUiButton(), shouldShow);
  });
}

test("diagnostic markers render a non-runnable fix badge and popover", async () => {
  const harness = createContentHarness({ status: "unformalized" });
  const diagnostic = {
    code: "missing_label",
    message: "Lea marker is missing an explicit label=... value.",
    syntax: "diagnostic",
    coords: { left: 40, top: 50 }
  };
  await harness.loadVisibleTheorems({ diagnostics: [diagnostic] });

  assert.equal(harness.hasButtonText("fix marker"), true);

  harness.window.postMessage({
    type: "OL_LEAN_DIAGNOSTIC_CLICK",
    diagnostic,
    clientX: 20,
    clientY: 20
  }, "*");

  assert.match(harness.bodyText(), /Lea marker is missing an explicit label/);
  assert.equal(harness.hasButtonText("Formalize"), false);
});

test("targets without coordinates do not render floating status badges", async () => {
  const harness = createContentHarness(
    { status: "unformalized" },
    { coords: null }
  );
  await harness.loadStatusForVisibleTheorem();

  assert.equal(harness.hasButtonText("unformalized"), false);
});

test("definition targets use definition copy and do not show Stub", async () => {
  const harness = createContentHarness(
    { status: "unformalized" },
    { targetKind: "definition", targetLabel: "DemoDefinition", targetText: "A definition." }
  );
  await harness.loadStatusForVisibleTheorem();

  harness.window.postMessage({
    type: "OL_LEAN_TARGET_CLICK",
    target: harness.target,
    clientX: 16,
    clientY: 20
  }, "*");

  assert.equal(harness.hasButtonText("Formalize definition"), true);
  assert.equal(harness.hasButtonText("Stub"), false);
});

test("definition success renders a defined badge", async () => {
  const harness = createContentHarness(
    { status: "formalized", resultKind: "defined" },
    { targetKind: "definition", targetLabel: "DemoDefinition", targetText: "A definition." }
  );
  await harness.loadStatusForVisibleTheorem();

  assert.equal(harness.hasButtonText("defined"), true);
  assert.equal(harness.hasButtonText("formalized"), false);
});

function createContentHarness(statusInfo, theoremPatch = {}) {
  const document = new FakeDocument();
  const timers = [];
  let nextTimerId = 1;

  const window = {
    innerWidth: 1024,
    innerHeight: 768,
    location: { pathname: "/project/project-1" },
    _listeners: new Map(),
    addEventListener(type, listener) {
      const listeners = this._listeners.get(type) || [];
      listeners.push(listener);
      this._listeners.set(type, listeners);
    },
    postMessage(data) {
      for (const listener of this._listeners.get("message") || []) {
        listener({ source: window, data });
      }
    },
    open() {
      return {};
    }
  };
  document.defaultView = window;

  const target = {
    targetKind: "theorem",
    targetLabel: "demo_theorem",
    targetText: "A theorem.",
    targetUses: [],
    targetContext: "",
    coords: { left: 12, top: 18 },
    ...theoremPatch
  };

  const context = {
    URL,
    TextEncoder,
    clearTimeout(id) {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index !== -1) timers.splice(index, 1);
    },
    crypto: {
      subtle: {
        async digest() {
          return new ArrayBuffer(0);
        }
      }
    },
    document,
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
          return { statuses: { [`${target.targetKind}:${target.targetLabel}`]: statusInfo } };
      }
    }),
    globalThis: null,
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.push({ id, callback });
      return id;
    },
    window,
    chrome: {
      runtime: {
        id: "test-extension",
        getURL: (file) => `chrome-extension://test/${file}`,
        sendMessage(_message, callback) {
          callback?.({ ok: true });
        },
        lastError: null
      },
      storage: {
        sync: {
          async get(defaults) {
            return defaults;
          },
          async set() {}
        }
      }
    }
  };
  context.globalThis = context;
  context.self = window;
  context.location = window.location;

  vm.runInNewContext(contentScript, context, { filename: contentScriptPath });
  timers.splice(0, timers.length);

  return {
    target,
    window,
    async loadStatusForVisibleTheorem() {
      await this.loadVisibleTheorems();
    },
    async loadVisibleTheorems({ diagnostics = [] } = {}) {
      window.postMessage({
        type: "OL_LEAN_TARGETS_VISIBLE",
        targets: [target],
        diagnostics,
        activeTex: "\\begin{theorem}\n% lea: formalize label=demo_theorem\nA theorem.\n\\end{theorem}",
        activePath: "main.tex"
      }, "*");
      assert.ok(timers.length > 0, "expected status refresh to be scheduled");
      const scheduledTimers = timers.splice(0, timers.length);
      for (const timer of scheduledTimers) {
        timer.callback();
      }
      await flushPromises();
    },
    hasViewInLeaUiButton() {
      return document.body
        .querySelectorAll("button")
        .some((button) => button.dataset.role === "open-lea-session" && button.textContent === "View in Lea UI");
    },
    hasButtonText(text) {
      return document.body
        .querySelectorAll("button")
        .some((button) => button.textContent === text);
    },
    bodyText() {
      return document.body.textContent;
    }
  };
}

async function flushPromises() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body");
    this.documentElement = new FakeElement("html");
    this.head = new FakeElement("head");
    this._listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this._listeners.get(type) || [];
    listeners.push(listener);
    this._listeners.set(type, listeners);
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createTextNode(text) {
    return new FakeText(text);
  }
}

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = text;
    this.parentNode = null;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.hidden = false;
    this._textContent = "";
    this._className = "";
    this.classList = {
      contains: (className) => this.className.split(/\s+/).includes(className)
    };
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value || "");
  }

  get isConnected() {
    return Boolean(this.parentNode);
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent || "").join("");
  }

  set textContent(value) {
    this._textContent = String(value || "");
    this.children = [];
  }

  set innerHTML(value) {
    this._textContent = "";
    this.children = [];
    const html = String(value || "");
    if (html.includes("ol-lean-popover-title")) {
      this.appendChild(new FakeElement("p")).className = "ol-lean-popover-title";
      const meta = this.appendChild(new FakeElement("p"));
      meta.className = "ol-lean-popover-meta";
      meta.appendChild(new FakeElement("strong"));
      const actions = this.appendChild(new FakeElement("div"));
      actions.className = "ol-lean-popover-actions";
      actions.dataset.role = "theorem-actions";
      const lean = this.appendChild(new FakeElement("pre"));
      lean.className = "ol-lean-popover-lean";
      lean.hidden = true;
      const warning = this.appendChild(new FakeElement("p"));
      warning.className = "ol-lean-popover-warning";
      warning.hidden = true;
      const status = this.appendChild(new FakeElement("p"));
      status.className = "ol-lean-popover-status";
      return;
    }
    if (html.includes("ol-lean-trigger-mark")) {
      const mark = this.appendChild(new FakeElement("span"));
      mark.className = "ol-lean-trigger-mark";
      mark.textContent = "L";
    }
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) {
      child.parentNode = null;
    }
    this.children = [];
    for (const child of children) {
      this.appendChild(child);
    }
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index !== -1) siblings.splice(index, 1);
    this.parentNode = null;
  }

  addEventListener() {}

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) {
      this.dataset[toDatasetKey(name.slice(5))] = String(value);
    }
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 120, bottom: 32, width: 120, height: 32 };
  }

  contains(target) {
    if (target === this) return true;
    return this.children.some((child) => child.contains?.(target));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matches = [];
    walk(this, (node) => {
      if (node !== this && matchesSelector(node, selector)) {
        matches.push(node);
      }
    });
    return matches;
  }
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) {
    walk(child, visit);
  }
}

function matchesSelector(node, selector) {
  if (!(node instanceof FakeElement)) return false;
  const dataRoleMatch = selector.match(/^\[data-role=['"]?([^'"\]]+)['"]?\]$/);
  if (dataRoleMatch) {
    return node.dataset.role === dataRoleMatch[1];
  }
  if (selector.startsWith(".")) {
    return node.className.split(/\s+/).includes(selector.slice(1));
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function toDatasetKey(name) {
  return name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

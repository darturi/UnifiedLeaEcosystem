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

test("Lean pane trigger opens a project pane and renders manifest items", async () => {
  const harness = createContentHarness(
    { status: "unformalized" },
    {},
    {
      locationPath: "/project/unknown",
      manifest: {
        ok: true,
        rootFile: "main.tex",
        items: [{
          id: "theorem:thm:main",
          kind: "theorem",
          label: "thm:main",
          title: "Main theorem",
          status: "missing-stub",
          sourceFile: "main.tex",
          sourceStartLine: 1,
          sourceEndLine: 3,
          naturalLanguageRendered: "A theorem.",
          naturalLanguageLatex: "A theorem.",
          leanKind: "theorem"
        }],
        diagnostics: []
      }
    }
  );
  await harness.loadVisibleTheorems();

  harness.clickPaneTrigger();
  await flushPromises();

  assert.match(harness.bodyText(), /Lean pane/);
  harness.clickPaneTreeRowText("main.tex");
  assert.match(harness.bodyText(), /Main theorem/);
  assert.match(harness.bodyText(), /missing stub/);
});

test("Lean pane renders every source file equally with file rows collapsed by default", async () => {
  const harness = createContentHarness(
    { status: "unformalized" },
    {},
    {
      locationPath: "/project/unknown",
      manifest: {
        ok: true,
        rootFile: "main.tex",
        items: [
          {
            id: "theorem:main:0",
            kind: "theorem",
            label: "main",
            title: "Main theorem",
            status: "valid",
            sourceFile: "main.tex",
            documentOrder: 0,
            naturalLanguageLatex: "Main theorem.",
            leanKind: "theorem"
          },
          {
            id: "definition:defs:1",
            kind: "definition",
            label: "defs",
            title: "Section definition",
            status: "missing-stub",
            sourceFile: "sections/defs.tex",
            documentOrder: 1,
            naturalLanguageLatex: "A definition.",
            leanKind: "def"
          },
          {
            id: "lemma:supp:2",
            kind: "lemma",
            label: "supp",
            title: "Supplemental lemma",
            status: "valid",
            sourceFile: "supp.tex",
            documentOrder: 2,
            naturalLanguageLatex: "A supplemental result.",
            leanKind: "theorem"
          }
        ],
        diagnostics: []
      }
    }
  );
  await harness.loadVisibleTheorems();
  harness.clickPaneTrigger();
  await flushPromises();

  assert.match(harness.bodyText(), /3 labeled items across 3 \.tex files\./);
  assert.deepEqual(harness.paneTreeRowTexts().map((text) => text.replace(/\s+/g, " ")), [
    "▸main.tex1 itemvalid",
    "▸sections/1 itemmissing stub",
    "▸supp.tex1 itemvalid"
  ]);
  assert.doesNotMatch(harness.bodyText(), /Main theorem/);
  assert.doesNotMatch(harness.bodyText(), /Section definition/);
  assert.doesNotMatch(harness.bodyText(), /Supplemental lemma/);

  harness.clickPaneTreeRowText("main.tex");
  assert.match(harness.bodyText(), /Main theorem/);
  harness.clickPaneTreeRowText("sections/");
  harness.clickPaneTreeRowText("defs.tex");
  assert.match(harness.bodyText(), /Section definition/);
  harness.clickPaneTreeRowText("supp.tex");
  assert.match(harness.bodyText(), /Supplemental lemma/);
});

test("Lean pane polling refresh preserves expanded folder and file rows", async () => {
  let manifestCalls = 0;
  const manifest = () => {
    const sectionStatus = manifestCalls === 0 ? "in-progress" : "invalid";
    manifestCalls += 1;
    return {
      ok: true,
      rootFile: "main.tex",
      items: [
        {
          id: "theorem:main:0",
          kind: "theorem",
          label: "main",
          title: "Main theorem",
          status: "valid",
          sourceFile: "main.tex",
          documentOrder: 0,
          naturalLanguageLatex: "Main theorem.",
          leanKind: "theorem"
        },
        {
          id: "lemma:section:1",
          kind: "lemma",
          label: "section",
          title: "Section lemma",
          status: sectionStatus,
          inProgress: sectionStatus === "in-progress",
          sourceFile: "sections/defs.tex",
          documentOrder: 1,
          naturalLanguageLatex: "A lemma.",
          leanKind: "theorem"
        }
      ],
      diagnostics: []
    };
  };
  const harness = createContentHarness({ status: "unformalized" }, {}, {
    locationPath: "/project/unknown",
    manifest
  });
  await harness.loadVisibleTheorems();
  harness.clickPaneTrigger();
  await flushPromises();
  harness.clickPaneTreeRowText("sections/");
  harness.clickPaneTreeRowText("defs.tex");
  assert.match(harness.bodyText(), /Section lemma/);
  assert.match(harness.bodyText(), /in progress/);

  await harness.runScheduledTimers();

  assert.match(harness.bodyText(), /Section lemma/);
  assert.match(harness.bodyText(), /invalid/);
  assert.equal(harness.countSelector(".ol-lean-project-item-header"), 1);
});

test("Lean pane expanded detail shows copy actions only for generated content", async () => {
  const harness = createContentHarness(
    { status: "unformalized" },
    {},
    {
      locationPath: "/project/unknown",
      manifest: {
        ok: true,
        rootFile: "main.tex",
        items: [{
          id: "theorem:thm:main",
          kind: "theorem",
          label: "thm:main",
          status: "valid",
          sourceFile: "main.tex",
          sourceStartLine: 1,
          sourceEndLine: 3,
          naturalLanguageRendered: "A theorem.",
          naturalLanguageLatex: "A theorem.",
          leanKind: "theorem",
          leanDeclarationName: "main_theorem",
          leanStub: "theorem main_theorem : True",
          leanArtifactPath: "workspace/proofs/Main.lean",
          leanArtifactContent: "theorem main_theorem : True := by\n  trivial\n"
        }],
        diagnostics: []
      }
    }
  );
  await harness.loadVisibleTheorems();
  harness.clickPaneTrigger();
  await flushPromises();

  harness.clickPaneTreeRowText("main.tex");
  harness.clickFirstPaneItem();

  assert.equal(harness.hasButtonText("Copy stub"), true);
  assert.equal(harness.hasButtonText("Copy artifact"), true);
  assert.match(harness.bodyText(), /workspace\/proofs\/Main\.lean/);
});

test("Lean pane renders lightweight math and highlighted Lean code", async () => {
  const harness = createContentHarness(
    { status: "unformalized" },
    {},
    {
      locationPath: "/project/unknown",
      manifest: {
        ok: true,
        rootFile: "main.tex",
        items: [{
          id: "theorem:main_theorem:0",
          kind: "theorem",
          label: "main_theorem",
          title: "Main theorem",
          status: "valid",
          sourceFile: "main.tex",
          sourceStartLine: 1,
          sourceEndLine: 4,
          naturalLanguageRendered: "For every x in R, x^2 >= 0.",
          naturalLanguageLatex: "For every $x \\in \\mathbb{R}$, $x^2 \\ge 0$.",
          leanKind: "theorem",
          leanDeclarationName: "main_theorem",
          leanStub: "theorem main_theorem : Nat := 2",
          leanArtifactPath: "workspace/proofs/Main.lean",
          leanArtifactContent: "theorem main_theorem : Nat := by\n  -- proof\n  exact 2\n"
        }],
        diagnostics: []
      }
    }
  );
  await harness.loadVisibleTheorems();
  harness.clickPaneTrigger();
  await flushPromises();

  harness.clickPaneTreeRowText("main.tex");
  assert.ok(harness.countSelector(".ol-lean-project-math") >= 2);
  assert.equal(harness.countSelector(".ol-lean-project-math-sup"), 1);
  assert.ok(harness.countSelector(".ol-lean-project-lean-kw") >= 1);
  assert.ok(harness.countSelector(".ol-lean-project-lean-ty") >= 1);
  assert.ok(harness.countSelector(".ol-lean-project-lean-num") >= 1);
  assert.match(harness.bodyText(), /For every x ∈ ℝ, x2 ≥ 0\./);

  harness.clickFirstPaneItem();

  assert.equal(harness.hasButtonText("Copy stub"), true);
  assert.equal(harness.hasButtonText("Copy artifact"), true);
  assert.ok(harness.countSelector(".ol-lean-project-lean-com") >= 1);
});

test("Lean pane 'Go to source' posts a navigate message with the item's offsets", async () => {
  const harness = createContentHarness(
    { status: "unformalized" },
    {},
    {
      locationPath: "/project/unknown",
      manifest: {
        ok: true,
        rootFile: "main.tex",
        items: [{
          id: "theorem:main_theorem:0",
          kind: "theorem",
          label: "main_theorem",
          status: "missing-stub",
          sourceFile: "main.tex",
          sourceStartLine: 1,
          sourceEndLine: 4,
          sourceStartOffset: 3,
          sourceEndOffset: 42,
          naturalLanguageRendered: "A theorem.",
          naturalLanguageLatex: "A theorem.",
          leanKind: "theorem",
          leanDeclarationName: "main_theorem",
          formalizable: true
        }],
        diagnostics: []
      }
    }
  );
  await harness.loadVisibleTheorems();
  harness.clickPaneTrigger();
  await flushPromises();
  harness.clickPaneTreeRowText("main.tex");
  harness.clickFirstPaneItem();
  harness.clickButtonText("Go to source");

  const navigate = harness.postedMessages.find((message) => message.type === "OL_LEAN_NAVIGATE");
  assert.ok(navigate, "expected an OL_LEAN_NAVIGATE message");
  assert.equal(navigate.sourceFile, "main.tex");
  assert.equal(navigate.from, 3);
  assert.equal(navigate.to, 42);
});

test("source popover 'Show in Lean pane' opens, expands, and highlights the matching item", async () => {
  const harness = createContentHarness(
    { status: "formalized" },
    { targetLabel: "main_theorem" },
    {
      locationPath: "/project/unknown",
      manifest: {
        ok: true,
        rootFile: "main.tex",
        items: [{
          id: "theorem:main_theorem:0",
          kind: "theorem",
          label: "main_theorem",
          status: "valid",
          sourceFile: "sections/defs.tex",
          sourceStartLine: 1,
          sourceEndLine: 4,
          sourceStartOffset: 0,
          sourceEndOffset: 42,
          naturalLanguageRendered: "A theorem.",
          naturalLanguageLatex: "A theorem.",
          leanKind: "theorem",
          leanDeclarationName: "main_theorem",
          leanArtifactContent: "theorem main_theorem : True := by\n  trivial\n"
        }],
        diagnostics: []
      }
    }
  );
  await harness.loadVisibleTheorems();

  harness.openTargetPopover();
  assert.equal(harness.hasButtonText("Show in Lean pane"), true);

  harness.clickButtonText("Show in Lean pane");
  await flushPromises();

  assert.match(harness.bodyText(), /Lean pane/);
  assert.match(harness.bodyText(), /No generated Lean artifact|theorem main_theorem/);
  assert.equal(harness.countSelector(".ol-lean-project-detail"), 1);
  assert.equal(harness.countSelector(".ol-lean-project-item-focus"), 1);
  assert.ok(harness.paneTreeRowTexts().some((text) => text.includes("sections/")));
  assert.ok(harness.paneTreeRowTexts().some((text) => text.includes("defs.tex")));
  assert.equal(harness.firstFocusedPaneItemScrolled(), true);
  assert.match(harness.bodyText(), /Opened main_theorem in the Lean pane\./);
});

test("source popover 'Show in Lean pane' matches by Lean declaration name", async () => {
  const harness = createContentHarness(
    { status: "formalized" },
    { targetLabel: "main_theorem" },
    {
      locationPath: "/project/unknown",
      manifest: {
        ok: true,
        rootFile: "main.tex",
        items: [{
          id: "theorem:display-label:0",
          kind: "theorem",
          label: "display-label",
          status: "valid",
          sourceFile: "main.tex",
          sourceStartLine: 1,
          sourceEndLine: 4,
          sourceStartOffset: 3,
          sourceEndOffset: 42,
          naturalLanguageRendered: "A theorem.",
          naturalLanguageLatex: "A theorem.",
          leanKind: "theorem",
          leanDeclarationName: "main_theorem"
        }],
        diagnostics: []
      }
    }
  );
  await harness.loadVisibleTheorems();

  harness.openTargetPopover();
  harness.clickButtonText("Show in Lean pane");
  await flushPromises();

  assert.equal(harness.countSelector(".ol-lean-project-detail"), 1);
  assert.equal(harness.countSelector(".ol-lean-project-item-focus"), 1);
  assert.match(harness.bodyText(), /Opened display-label in the Lean pane\./);
});

test("source popover reports when 'Show in Lean pane' cannot find a matching item", async () => {
  const harness = createContentHarness(
    { status: "formalized" },
    { targetLabel: "main_theorem" },
    {
      locationPath: "/project/unknown",
      manifest: {
        ok: true,
        rootFile: "main.tex",
        items: [{
          id: "theorem:other_theorem:0",
          kind: "theorem",
          label: "other_theorem",
          status: "valid",
          sourceFile: "main.tex",
          sourceStartLine: 1,
          sourceEndLine: 4,
          sourceStartOffset: 99,
          sourceEndOffset: 120,
          naturalLanguageRendered: "Other theorem.",
          naturalLanguageLatex: "Other theorem.",
          leanKind: "theorem",
          leanDeclarationName: "other_theorem"
        }],
        diagnostics: []
      }
    }
  );
  await harness.loadVisibleTheorems();

  harness.openTargetPopover();
  harness.clickButtonText("Show in Lean pane");
  await flushPromises();

  assert.match(harness.bodyText(), /Could not find main_theorem in the Lean pane\./);
  assert.equal(harness.countSelector(".ol-lean-project-item-focus"), 0);
});

test("Lean pane 'Formalize' starts a run via the /formalize endpoint", async () => {
  const harness = createContentHarness(
    { status: "unformalized" },
    {},
    {
      locationPath: "/project/unknown",
      manifest: {
        ok: true,
        rootFile: "main.tex",
        items: [{
          id: "theorem:main_theorem:0",
          kind: "theorem",
          label: "main_theorem",
          status: "missing-stub",
          sourceFile: "main.tex",
          sourceStartLine: 1,
          sourceEndLine: 4,
          sourceStartOffset: 0,
          sourceEndOffset: 42,
          naturalLanguageRendered: "A theorem.",
          naturalLanguageLatex: "A theorem.",
          leanKind: "theorem",
          leanDeclarationName: "main_theorem",
          formalizable: true,
          targetUses: ["helper_lemma"],
          targetContext: "Use the helper."
        }],
        diagnostics: []
      }
    }
  );
  await harness.loadVisibleTheorems();
  harness.clickPaneTrigger();
  await flushPromises();
  harness.clickPaneTreeRowText("main.tex");
  harness.clickFirstPaneItem();
  harness.clickButtonText("Formalize");
  await flushPromises();

  const call = harness.fetchCalls.find((entry) => entry.url.includes("/formalize"));
  assert.ok(call, "expected a POST to /formalize");
  assert.equal(call.options.method, "POST");
  const body = JSON.parse(call.options.body);
  assert.equal(body.targetLabel, "main_theorem");
  assert.equal(body.targetKind, "theorem");
  assert.deepEqual(body.targetUses, ["helper_lemma"]);
  assert.equal(body.targetContext, "Use the helper.");
});

function createContentHarness(statusInfo, theoremPatch = {}, options = {}) {
  const document = new FakeDocument();
  const timers = [];
  const fetchCalls = [];
  const postedMessages = [];
  let nextTimerId = 1;

  const window = {
    innerWidth: 1024,
    innerHeight: 768,
    location: { pathname: options.locationPath || "/project/project-1" },
    _listeners: new Map(),
    addEventListener(type, listener) {
      const listeners = this._listeners.get(type) || [];
      listeners.push(listener);
      this._listeners.set(type, listeners);
    },
    postMessage(data) {
      postedMessages.push(data);
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
    fetch: async (url, fetchOptions) => {
      fetchCalls.push({ url: String(url), options: fetchOptions });
      return {
        ok: true,
        status: 200,
        async json() {
          if (String(url).includes("/lean-pane/manifest")) {
            return typeof options.manifest === "function"
              ? options.manifest(fetchCalls)
              : options.manifest || { ok: true, rootFile: "main.tex", items: [], diagnostics: [] };
          }
          if (String(url).includes("/formalize")) {
            return { jobId: "job-1", status: "in_progress" };
          }
          return { statuses: { [`${target.targetKind}:${target.targetLabel}`]: statusInfo } };
        }
      };
    },
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
        // Real .mjs web-accessible resources resolve to their on-disk path so the
        // pane's lazy `import(chrome.runtime.getURL(...))` works under the harness.
        getURL: (file) => file.endsWith(".mjs")
          ? path.join(repoRoot, "apps/overleaf-extension/extension", file)
          : `chrome-extension://test/${file}`,
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

  vm.runInNewContext(contentScript, context, {
    filename: contentScriptPath,
    // content.js loads web-accessible-resource modules via
    // `import(chrome.runtime.getURL(...))`; getURL returns an absolute path for .mjs
    // resources and the default loader imports them, so the pane's lazy module load
    // works under the test harness without --experimental-vm-modules.
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
  });
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
    openTargetPopover() {
      window.postMessage({
        type: "OL_LEAN_TARGET_CLICK",
        target,
        clientX: 16,
        clientY: 20
      }, "*");
    },
    clickPaneTrigger() {
      const button = document.body.querySelector(".ol-lean-pane-trigger");
      assert.ok(button, "expected Lean pane trigger");
      button.click();
    },
    clickFirstPaneItem() {
      const button = document.body.querySelector(".ol-lean-project-item-header");
      assert.ok(button, "expected Lean pane item header");
      button.click();
    },
    clickFirstPaneTreeRow(kind = "") {
      const selector = kind ? `.ol-lean-project-tree-row-${kind}` : ".ol-lean-project-tree-row";
      const button = document.body.querySelector(selector);
      assert.ok(button, `expected Lean pane tree row ${kind || ""}`.trim());
      button.click();
    },
    clickPaneTreeRowText(text) {
      const button = document.body
        .querySelectorAll(".ol-lean-project-tree-row")
        .find((candidate) => candidate.textContent.includes(text));
      assert.ok(button, `expected a tree row containing "${text}"`);
      button.click();
    },
    clickButtonText(text) {
      const button = document.body
        .querySelectorAll("button")
        .find((candidate) => candidate.textContent === text);
      assert.ok(button, `expected a button labeled "${text}"`);
      button.click();
    },
    async runScheduledTimers() {
      const scheduledTimers = timers.splice(0, timers.length);
      for (const timer of scheduledTimers) {
        timer.callback();
      }
      await flushPromises();
    },
    fetchCalls,
    postedMessages,
    bodyText() {
      return document.body.textContent;
    },
    countSelector(selector) {
      return document.body.querySelectorAll(selector).length;
    },
    paneTreeRowTexts() {
      return document.body
        .querySelectorAll(".ol-lean-project-tree-row")
        .map((row) => row.textContent);
    },
    firstFocusedPaneItemScrolled() {
      const item = document.body.querySelector(".ol-lean-project-item-focus");
      return Boolean(item?.scrollIntoViewOptions);
    }
  };
}

async function flushPromises() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 4; i += 1) {
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
    this.style = {
      setProperty: (name, value) => {
        this.style[name] = String(value);
      }
    };
    this.attributes = {};
    this._listeners = new Map();
    this.hidden = false;
    this._textContent = "";
    this._className = "";
    this.classList = {
      contains: (className) => this.className.split(/\s+/).includes(className),
      add: (...classNames) => {
        const next = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const className of classNames) next.add(className);
        this.className = [...next].join(" ");
      },
      remove: (...classNames) => {
        const remove = new Set(classNames);
        this.className = this.className
          .split(/\s+/)
          .filter((className) => className && !remove.has(className))
          .join(" ");
      }
    };
    this.scrollTop = 0;
    this.scrollIntoViewOptions = null;
  }

  focus() {}

  blur() {}

  scrollIntoView(options) {
    this.scrollIntoViewOptions = options || true;
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

  addEventListener(type, listener) {
    const listeners = this._listeners.get(type) || [];
    listeners.push(listener);
    this._listeners.set(type, listeners);
  }

  click() {
    for (const listener of this._listeners.get("click") || []) {
      listener({
        preventDefault() {},
        stopPropagation() {},
        clientX: 0,
        clientY: 0,
        target: this
      });
    }
  }

  replaceWith(next) {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index === -1) return;
    next.parentNode = this.parentNode;
    siblings[index] = next;
    this.parentNode = null;
  }

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

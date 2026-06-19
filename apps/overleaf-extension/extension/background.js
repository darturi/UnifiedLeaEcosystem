chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OPEN_LEA_SESSION") {
    openLeaSessionTab(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }

  if (message?.type === "OPEN_OVERLEAF_DOCUMENT") {
    openOverleafDocumentTab(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }

  return false;
});

async function openLeaSessionTab({ url, baseUrl }) {
  const targetUrl = normalizeHttpUrl(url, "Lea session URL");
  const base = normalizeHttpUrl(baseUrl || targetUrl, "Lea UI base URL");
  const pattern = `${new URL(base).origin}/*`;
  const tabs = await chrome.tabs.query({ url: pattern });
  const existing = tabs.find((tab) => typeof tab.id === "number");

  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, url: targetUrl });
    if (typeof existing.windowId === "number") {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url: targetUrl, active: true });
}

// Reverse of openLeaSessionTab: open the originating Overleaf document, or — if it's
// already open in some tab — activate that tab instead of opening a duplicate. The
// Lea UI tab that requested this is left untouched. Matching is by the `/project/<id>`
// path so we focus the *right* document, not just any Overleaf tab.
async function openOverleafDocumentTab({ url }) {
  const targetUrl = normalizeHttpUrl(url, "Overleaf document URL");
  const projectId = overleafProjectIdFromUrl(targetUrl);
  const pattern = `${new URL(targetUrl).origin}/*`;
  const tabs = await chrome.tabs.query({ url: pattern });
  const existing = tabs.find(
    (tab) =>
      typeof tab.id === "number" &&
      projectId &&
      overleafProjectIdFromUrl(tab.url || "") === projectId
  );

  if (existing) {
    // Already open — just focus it; don't reload the user's editor.
    await chrome.tabs.update(existing.id, { active: true });
    if (typeof existing.windowId === "number") {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url: targetUrl, active: true });
}

function overleafProjectIdFromUrl(value) {
  try {
    const match = new URL(value).pathname.match(/\/project\/([^/]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function normalizeHttpUrl(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is missing.`);
  const parsed = new URL(text);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must be an http(s) URL.`);
  }
  return parsed.toString();
}

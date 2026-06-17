chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "OPEN_LEA_SESSION") {
    return false;
  }

  openLeaSessionTab(message)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  return true;
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

function normalizeHttpUrl(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is missing.`);
  const parsed = new URL(text);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must be an http(s) URL.`);
  }
  return parsed.toString();
}

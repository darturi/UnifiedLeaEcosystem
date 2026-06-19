// Lea UI ↔ extension bridge.
//
// Runs as a content script on the Lea UI origin. The Lea UI is a plain web page, so it
// cannot enumerate or activate browser tabs; this bridge relays its "open the source
// Overleaf document" request to the extension background, which does the
// new-tab-or-activate-existing logic. It is the reverse analogue of the Overleaf
// content script's "View in Lea UI" relay.
//
// Protocol (must match src/app/lib/overleafLink.ts):
//   page  → bridge: { source: "lea-ui",        type: "OPEN_OVERLEAF_DOCUMENT",        requestId, url }
//   bridge → page:  { source: "lea-ui-bridge", type: "OPEN_OVERLEAF_DOCUMENT_RESULT", requestId, ok, message }

(() => {
  const REQUEST_SOURCE = "lea-ui";
  const RESPONSE_SOURCE = "lea-ui-bridge";
  const REQUEST_TYPE = "OPEN_OVERLEAF_DOCUMENT";
  const RESPONSE_TYPE = "OPEN_OVERLEAF_DOCUMENT_RESULT";
  const MARKER_ATTR = "data-lea-overleaf-bridge";

  // Announce to the page that the bridge is available, so the UI prefers the
  // extension path over a plain window.open.
  const markPresent = () => {
    const root = document.documentElement;
    if (root) root.setAttribute(MARKER_ATTR, "1");
  };
  markPresent();
  // The SPA may replace <html> attributes during hydration; re-assert once loaded.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", markPresent, { once: true });
  }

  function respond(requestId, ok, message) {
    window.postMessage(
      { source: RESPONSE_SOURCE, type: RESPONSE_TYPE, requestId, ok, message },
      window.location.origin
    );
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== REQUEST_SOURCE || data.type !== REQUEST_TYPE) return;

    const requestId = data.requestId;
    const url = String(data.url || "").trim();
    if (!url) {
      respond(requestId, false, "No Overleaf document URL was provided.");
      return;
    }

    // The extension may have been reloaded out from under this page.
    if (!chrome?.runtime?.sendMessage) {
      respond(requestId, false, "Extension was reloaded. Refresh this tab.");
      return;
    }

    try {
      chrome.runtime.sendMessage({ type: REQUEST_TYPE, url }, (response) => {
        if (chrome.runtime.lastError) {
          respond(requestId, false, chrome.runtime.lastError.message || "Bridge unavailable.");
          return;
        }
        if (response?.ok) respond(requestId, true);
        else respond(requestId, false, response?.message || "Could not open the Overleaf document.");
      });
    } catch (error) {
      respond(requestId, false, error instanceof Error ? error.message : String(error));
    }
  });
})();

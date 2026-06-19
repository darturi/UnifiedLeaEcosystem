// Open (or focus) the originating Overleaf document for an Overleaf-spawned session.
//
// The Lea UI is a plain web page, so it cannot enumerate or activate browser tabs on
// its own. When the Overleaf extension is installed it injects a content-script
// bridge (`extension/uiBridge.js`) on this origin that relays to the extension's
// background, which does the new-tab-or-activate-existing logic (mirroring the
// Overleaf→UI "View in Lea UI" action). When the extension is absent we fall back to
// window.open, which can only open a new tab (it cannot activate a pre-existing,
// independently-opened Overleaf tab). The Lea UI tab itself is never navigated away.
//
// This is the symmetric counterpart of `openLeaSession` in the extension's content.js.

const BRIDGE_MARKER_ATTR = 'data-lea-overleaf-bridge';
const REQUEST_SOURCE = 'lea-ui';
const RESPONSE_SOURCE = 'lea-ui-bridge';
const REQUEST_TYPE = 'OPEN_OVERLEAF_DOCUMENT';
const RESPONSE_TYPE = 'OPEN_OVERLEAF_DOCUMENT_RESULT';
const BRIDGE_TIMEOUT_MS = 1500;

function bridgePresent(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.documentElement?.getAttribute(BRIDGE_MARKER_ATTR) === '1'
  );
}

function openInNewTab(url: string): boolean {
  const opened = window.open(url, '_blank', 'noopener');
  return Boolean(opened);
}

// Ask the extension bridge to open/focus the document. Resolves true on the bridge's
// ok ack; rejects on an explicit failure ack; resolves false on timeout (caller then
// falls back to window.open).
function requestViaBridge(url: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const requestId = `ov-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data;
      if (
        !data ||
        data.source !== RESPONSE_SOURCE ||
        data.type !== RESPONSE_TYPE ||
        data.requestId !== requestId
      ) {
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      if (data.ok) resolve(true);
      else reject(new Error(data.message || 'The Overleaf tab could not be opened.'));
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false); // no ack — treat as bridge unavailable, let caller fall back
    }, BRIDGE_TIMEOUT_MS);

    window.addEventListener('message', onMessage);
    window.postMessage(
      { source: REQUEST_SOURCE, type: REQUEST_TYPE, requestId, url },
      window.location.origin,
    );
  });
}

export async function openOverleafDocument(url?: string | null): Promise<void> {
  const target = String(url || '').trim();
  if (!target) {
    throw new Error('No Overleaf document link is available for this session.');
  }

  if (bridgePresent()) {
    const handled = await requestViaBridge(target);
    if (handled) return;
    // Bridge marker was set but it never acked (e.g. extension was reloaded) — fall
    // back to a plain new tab rather than leaving the click dead.
  }

  if (!openInNewTab(target)) {
    throw new Error('Your browser blocked the Overleaf tab.');
  }
}

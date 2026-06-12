(function () {
  const DEFAULT_COMPANION_URL = "http://127.0.0.1:31245";
  let activePopover = null;
  let statusRefreshTimer = null;
  let latestTheorems = [];
  let latestStatuses = {};
  let badgeLayer = null;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "OL_LEAN_THEOREM_CLICK") {
      rememberTheorem(event.data.theorem);
      showPopover(event.data.clientX, event.data.clientY, event.data.theorem);
      return;
    }
    if (event.data?.type === "OL_LEAN_THEOREMS_VISIBLE") {
      latestTheorems = event.data.theorems || [];
      renderStatusBadges();
      scheduleStatusRefresh();
    }
  });

  injectPageBridge();
  requestTheoremsSoon();

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePopover();
  });

  document.addEventListener("click", (event) => {
    if (activePopover && !activePopover.contains(event.target)) {
      closePopover();
    }
  });

  window.addEventListener("resize", renderStatusBadges);
  window.addEventListener("scroll", () => {
    requestTheorems();
    renderStatusBadges();
  }, true);

  function showPopover(clientX, clientY, theorem) {
    closePopover();

    const popover = document.createElement("div");
    popover.className = "ol-lean-popover";
    popover.innerHTML = `
      <p class="ol-lean-popover-title">Lean formalization</p>
      <p class="ol-lean-popover-meta">Label: <strong></strong></p>
    <div class="ol-lean-popover-actions">
        <button type="button" data-primary="true">Confirm</button>
        <button type="button">Close</button>
      </div>
      <pre class="ol-lean-popover-lean" hidden></pre>
      <p class="ol-lean-popover-status"></p>
    `;

    popover.querySelector("strong").textContent = theorem.label;
    const confirmButton = popover.querySelector("button[data-primary='true']");
    const closeButton = popover.querySelector("button:not([data-primary])");
    const status = popover.querySelector(".ol-lean-popover-status");
    const leanStatement = popover.querySelector(".ol-lean-popover-lean");
    const currentStatus = latestStatuses[theorem.label]?.status || "unknown";
    renderLeanStatement(leanStatement, latestStatuses[theorem.label]?.leanStatement || "");
    confirmButton.textContent = buttonTextForStatus(currentStatus);
    confirmButton.disabled = currentStatus === "in_progress" || isExtensionContextInvalidated();
    if (currentStatus === "in_progress") {
      status.textContent = "Lea proof is in progress.";
    } else if (isExtensionContextInvalidated()) {
      status.textContent = "Extension was reloaded. Refresh this Overleaf tab.";
    }

    confirmButton.addEventListener("click", async () => {
      confirmButton.disabled = true;
      status.textContent = currentStatus === "formalized" || currentStatus === "unknown"
        ? "Checking Lea status..."
        : "Starting Lea...";
      try {
        const result = currentStatus === "formalized" || currentStatus === "unknown"
          ? await refreshSingleStatus(theorem)
          : await formalize(theorem);
        status.textContent = `${formatStatus(result.status)} at ${result.relativePath}`;
        renderLeanStatement(leanStatement, result.leanStatement || latestStatuses[theorem.label]?.leanStatement || "");
        await refreshStatusesNow();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
        confirmButton.disabled = false;
      }
    });

    closeButton.addEventListener("click", closePopover);

    document.body.appendChild(popover);
    const rect = popover.getBoundingClientRect();
    const left = Math.min(clientX + 8, window.innerWidth - rect.width - 12);
    const top = Math.min(clientY + 8, window.innerHeight - rect.height - 12);
    popover.style.left = `${Math.max(12, left)}px`;
    popover.style.top = `${Math.max(12, top)}px`;
    activePopover = popover;
  }

  function closePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  async function formalize(theorem) {
    const settings = await getSettings();
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/formalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        overleafProjectId: extractOverleafProjectId(),
        theoremLabel: theorem.label,
        theoremText: theorem.text,
        sourceHash: await sha256(normalizeTheoremText(theorem.text))
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    return payload;
  }

  async function refreshSingleStatus(theorem) {
    await refreshStatusesNow();
    return latestStatuses[theorem.label] || {
      status: "unavailable",
      relativePath: ""
    };
  }

  function scheduleStatusRefresh() {
    clearTimeout(statusRefreshTimer);
    statusRefreshTimer = setTimeout(() => {
      refreshStatusesNow().catch((error) => {
        postStatusError(error);
      });
    }, 250);
  }

  async function refreshStatusesNow() {
    if (latestTheorems.length === 0) {
      postStatuses({});
      return;
    }

    const settings = await getSettings();
    const baseUrl = String(settings.companionUrl || DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/statuses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        overleafProjectId: extractOverleafProjectId(),
        theorems: latestTheorems.map((theorem) => ({
          theoremLabel: theorem.label,
          theoremText: theorem.text
        }))
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Companion returned HTTP ${response.status}.`);
    }
    postStatuses(withFallbackStatuses(payload.statuses || {}));
    if (Object.values(latestStatuses).some((status) => status.status === "in_progress")) {
      scheduleStatusRefresh();
    }
  }

  function postStatusError(error) {
    const message = normalizeErrorMessage(error);
    const statuses = {};
    for (const theorem of latestTheorems) {
      statuses[theorem.label] = {
        status: "offline",
        message
      };
    }
    postStatuses(statuses);
  }

  function postStatuses(statuses) {
    latestStatuses = statuses || {};
    renderStatusBadges();
  }

  function withFallbackStatuses(statuses) {
    const completeStatuses = { ...statuses };
    for (const theorem of latestTheorems) {
      if (!completeStatuses[theorem.label]) {
        completeStatuses[theorem.label] = {
          status: "unavailable",
          message: "The companion did not return a status for this theorem."
        };
      }
    }
    return completeStatuses;
  }

  function renderStatusBadges() {
    if (!badgeLayer) {
      badgeLayer = document.createElement("div");
      badgeLayer.className = "ol-lean-status-layer";
      (document.body || document.documentElement).appendChild(badgeLayer);
    }

    badgeLayer.replaceChildren();
    for (const theorem of latestTheorems) {
      const coords = theorem.coords || { left: 24, top: 24 };
      const statusInfo = latestStatuses[theorem.label] || { status: "unknown" };
      const status = statusInfo.status || "unknown";
      const badge = document.createElement("span");
      badge.className = `ol-lean-status ol-lean-status-${status}`;
      badge.textContent = formatStatus(status);
      badge.title = statusInfo.message || `Lean status for ${theorem.label}: ${formatStatus(status)}`;
      badge.style.left = `${Math.min(coords.left + 8, window.innerWidth - 140)}px`;
      badge.style.top = `${coords.top}px`;
      badge.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showPopover(event.clientX, event.clientY, theorem);
      });
      badgeLayer.appendChild(badge);
    }
  }

  function formatStatus(status) {
    switch (status) {
      case "unformalized":
        return "unformalized";
      case "in_progress":
        return "in progress";
      case "formalized":
        return "formalized";
      case "sorry_stub":
        return "sorry stub";
      case "failed":
        return "failed";
      case "offline":
        return "offline";
      case "unavailable":
        return "unavailable";
      default:
        return "checking";
    }
  }

  function renderLeanStatement(element, statement) {
    if (!element) return;
    if (!statement) {
      element.hidden = true;
      element.textContent = "";
      return;
    }
    element.hidden = false;
    element.textContent = statement;
  }

  function buttonTextForStatus(status) {
    switch (status) {
      case "in_progress":
        return "Formalizing...";
      case "formalized":
      case "unknown":
        return "Check status";
      case "sorry_stub":
      case "unformalized":
      default:
        return "Run Lea";
    }
  }

  function getSettings() {
    if (isExtensionContextInvalidated()) {
      return Promise.reject(new Error("Extension was reloaded. Refresh this Overleaf tab."));
    }
    return chrome.storage.sync.get({
      companionUrl: DEFAULT_COMPANION_URL
    });
  }

  function isExtensionContextInvalidated() {
    return !globalThis.chrome?.runtime?.id;
  }

  function normalizeErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Extension context invalidated/i.test(message)) {
      return "Extension was reloaded. Refresh this Overleaf tab.";
    }
    return message;
  }

  function rememberTheorem(theorem) {
    if (!theorem?.label) return;
    const existingIndex = latestTheorems.findIndex((item) => item.label === theorem.label);
    if (existingIndex === -1) {
      latestTheorems = [...latestTheorems, theorem];
      return;
    }
    latestTheorems = latestTheorems.map((item, index) => (index === existingIndex ? theorem : item));
  }

  function extractOverleafProjectId() {
    const match = location.pathname.match(/\/project\/([^/]+)/);
    return match ? match[1] : "unknown";
  }

  function normalizeTheoremText(text) {
    return String(text).replace(/\s+/g, " ").trim();
  }

  async function sha256(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function injectPageBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("pageBridge.js");
    script.onload = () => script.remove();
    const target = document.documentElement || document.head || document.body;
    if (target) {
      target.appendChild(script);
      return;
    }
    document.addEventListener("DOMContentLoaded", () => {
      (document.documentElement || document.head || document.body).appendChild(script);
    }, { once: true });
  }

  function requestTheoremsSoon() {
    requestTheorems();
    setTimeout(requestTheorems, 300);
    setTimeout(requestTheorems, 1000);
  }

  function requestTheorems() {
    window.postMessage({ type: "OL_LEAN_REQUEST_THEOREMS" }, "*");
  }
})();

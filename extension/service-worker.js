const HOST_NAME = "com.cdt_bridge";
const DEBUGGER_VERSION = "1.3";
const DEV_RELOAD_ALLOWED_IDS_STORAGE_KEY = "developmentReloadAllowedIds";
const DEFAULT_DEV_RELOAD_ALLOWED_IDS = Object.freeze([
  "hacmcjjofinfaaahgdhopnnnipgjigge"
]);
const DEV_RELOAD_MESSAGE_TYPE = "cdt-bridge.dev-reload.v1";
const SUPPORTED_METHODS = new Set([
  "Browser.getWindowForTarget",
  "Browser.grantPermissions",
  "Browser.setContentsSize",
  "Browser.setDownloadBehavior",
  "Target.setAutoAttach",
  "Page.enable",
  "Page.navigate",
  "Page.reload",
  "Page.bringToFront",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.captureScreenshot",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.handleJavaScriptDialog",
  "Page.printToPDF",
  "Page.setDocumentContent",
  "Runtime.enable",
  "Runtime.callFunctionOn",
  "Runtime.evaluate",
  "Runtime.runIfWaitingForDebugger",
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Network.enable",
  "Network.emulateNetworkConditions",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.getResponseBody",
  "Network.setExtraHTTPHeaders",
  "Network.setCookies",
  "Network.clearBrowserCookies",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelectorAll",
  "DOM.describeNode",
  "DOM.resolveNode",
  "DOM.getBoxModel",
  "DOM.setFileInputFiles",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Log.enable",
  "Overlay.highlightNode",
  "Overlay.hideHighlight",
  "Fetch.enable",
  "Fetch.disable",
  "Fetch.continueWithAuth",
  "Fetch.continueRequest",
  "Fetch.failRequest",
  "Fetch.fulfillRequest",
  "IO.close",
  "IO.read",
  "Profiler.start",
  "Profiler.stop",
  "Security.setIgnoreCertificateErrors",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearDataForOrigin",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setEmulatedMedia",
  "Emulation.setUserAgentOverride",
  "Tracing.start",
  "Tracing.end"
]);
const OPTIONAL_NOOP_METHODS = new Set([
  "Runtime.runIfWaitingForDebugger",
  "Target.setAutoAttach"
]);
const BROWSER_INTERNAL_URL_PATTERN =
  /^(?:chrome|chrome-untrusted|edge|brave|vivaldi|opera|devtools):\/\/|^about:(?!blank$|srcdoc$)/i;
const COMMAND_TIMEOUT_MS = 5000;
const INTERNAL_NAVIGATION_FALLBACK_MS = 100;
const ACTION_ICON_SIZES = [16, 32];
const BRIDGE_SETTINGS_STORAGE_KEY = "bridgeSettings";
const DEFAULT_BRIDGE_PORT = 9222;
const DEFAULT_BRIDGE_SETTINGS = Object.freeze({
  port: DEFAULT_BRIDGE_PORT
});
const TAB_ACCESS_STORAGE_KEY = "tabAccessAllowlist";
const BLOCKED_REQUESTS_STORAGE_KEY = "blockedRequestsLog";
const BLOCKED_REQUESTS_MAX_ENTRIES = 50;
const CRASH_LOG_STORAGE_KEY = "crashLog";
const CRASH_LOG_MAX_ENTRIES = 50;
const ATTACH_LOG_STORAGE_KEY = "attachLog";
const ATTACH_LOG_MAX_ENTRIES = 50;
const TAB_ACCESS_BLOCKED_CODE = -32003;
const INTERNAL_PAGE_NOOP_METHODS = new Set([
  "Page.enable",
  "Runtime.enable",
  "Accessibility.enable",
  "Network.enable",
  "DOM.enable",
  "Log.enable"
]);
const ACTION_COLORS = {
  connected: "#16a34a",
  disconnected: "#6b7280",
  alert: "#dc2626",
  foreground: "#f9fafb"
};

const state = {
  nativePort: null,
  nativeConnected: false,
  stoppingHost: false,
  bridgeStatus: null,
  developmentReloadToken: null,
  developmentReloadAllowedIds: [...DEFAULT_DEV_RELOAD_ALLOWED_IDS],
  lastError: null,
  settings: { ...DEFAULT_BRIDGE_SETTINGS },
  tabAccessAllowlist: [],
  settingsLoaded: false,
  blockedRequests: [],
  attachLog: [],
  rootAttachments: new Map(),
  sessions: new Map(),
  spawnedTabs: new Map(),
  spawnedTabPolicedUrls: new Map(),
  transientSpawnTabs: new Set(),
  expectedDetachTabs: new Set(),
  pendingInternalNavigations: new Map(),
  internalNavigationTabs: new Set()
};

function createError(code, message, data = undefined) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  return error;
}

function isBrowserInternalUrl(url) {
  return typeof url === "string" && BROWSER_INTERNAL_URL_PATTERN.test(url);
}

function serializeError(error) {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data })
    };
  }

  return {
    code: -32603,
    message: error instanceof Error ? error.message : "Internal error"
  };
}

function makePageTargetId(tabId) {
  return `page:${tabId}`;
}

function parsePageTargetId(targetId) {
  if (!targetId?.startsWith("page:")) {
    return null;
  }

  const tabId = Number(targetId.slice("page:".length));
  return Number.isInteger(tabId) ? tabId : null;
}

function makeRootSessionId() {
  return `root-${crypto.randomUUID()}`;
}

function normalizeBridgePort(rawValue, fallback = DEFAULT_BRIDGE_SETTINGS.port) {
  const parsed = Number.parseInt(rawValue ?? `${fallback}`, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback;
}

function normalizeDevelopmentReloadAllowedIds(value) {
  if (!Array.isArray(value)) {
    return [...DEFAULT_DEV_RELOAD_ALLOWED_IDS];
  }
  const ids = [...new Set(value)];
  if (!ids.every((id) => typeof id === "string" && /^[a-p]{32}$/.test(id))) {
    throw createError(-32602, "Allowed extension IDs must be 32 lowercase a-p characters");
  }
  return ids;
}

async function loadSettings() {
  if (state.settingsLoaded) {
    return state.settings;
  }

  const stored = await chrome.storage.local.get([
    BRIDGE_SETTINGS_STORAGE_KEY,
    DEV_RELOAD_ALLOWED_IDS_STORAGE_KEY,
    TAB_ACCESS_STORAGE_KEY,
    BLOCKED_REQUESTS_STORAGE_KEY,
    ATTACH_LOG_STORAGE_KEY
  ]);
  state.settings = {
    port: normalizeBridgePort(stored?.[BRIDGE_SETTINGS_STORAGE_KEY]?.port)
  };
  state.developmentReloadAllowedIds = normalizeDevelopmentReloadAllowedIds(
    stored?.[DEV_RELOAD_ALLOWED_IDS_STORAGE_KEY]
  );
  state.tabAccessAllowlist = normalizeTabAccessAllowlist(stored?.[TAB_ACCESS_STORAGE_KEY]);
  state.blockedRequests = normalizeBlockedRequests(stored?.[BLOCKED_REQUESTS_STORAGE_KEY]);
  state.attachLog = normalizeAttachLog(stored?.[ATTACH_LOG_STORAGE_KEY]);
  state.settingsLoaded = true;
  return state.settings;
}

async function loadCrashLog() {
  const stored = await chrome.storage.local.get(CRASH_LOG_STORAGE_KEY);
  const entries = stored?.[CRASH_LOG_STORAGE_KEY];
  return Array.isArray(entries) ? entries : [];
}

let crashLogQueue = Promise.resolve();

function appendCrashLog(entry) {
  // Best-effort: the crash log must never throw, even while the SW is dying.
  // Appends are queued so concurrent crashes cannot overwrite each other.
  crashLogQueue = crashLogQueue
    .then(async () => {
      const entries = await loadCrashLog();
      entries.push({ time: new Date().toISOString(), ...entry });
      await chrome.storage.local.set({
        [CRASH_LOG_STORAGE_KEY]: entries.slice(-CRASH_LOG_MAX_ENTRIES)
      });
    })
    .catch(() => {
      // Ignore storage failures; there is nowhere else to log them.
    });
  return crashLogQueue;
}

async function saveDevelopmentReloadAllowedIds(value) {
  const ids = normalizeDevelopmentReloadAllowedIds(value);
  await chrome.storage.local.set({ [DEV_RELOAD_ALLOWED_IDS_STORAGE_KEY]: ids });
  state.developmentReloadAllowedIds = ids;
  return ids;
}

function normalizeBlockedRequests(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const entries = [];
  for (const item of value) {
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (url.length === 0 || seen.has(url)) {
      continue;
    }
    seen.add(url);
    entries.push({
      url,
      resourceType: typeof item?.resourceType === "string" ? item.resourceType : "other",
      tabId: typeof item?.tabId === "number" ? item.tabId : null,
      time: typeof item?.time === "string" ? item.time : new Date(0).toISOString(),
      count: Number.isInteger(item?.count) && item.count > 0 ? item.count : 1
    });
  }
  return entries.slice(0, BLOCKED_REQUESTS_MAX_ENTRIES);
}

async function recordBlockedRequest({ url, resourceType, tabId }) {
  if (typeof url !== "string" || url.length === 0) {
    return;
  }

  const now = new Date().toISOString();
  const existing = state.blockedRequests.find((entry) => entry.url === url);
  if (existing) {
    existing.time = now;
    existing.count += 1;
    if (typeof tabId === "number") {
      existing.tabId = tabId;
    }
  } else {
    state.blockedRequests.unshift({
      url,
      resourceType: typeof resourceType === "string" ? resourceType : "other",
      tabId: typeof tabId === "number" ? tabId : null,
      time: now,
      count: 1
    });
    state.blockedRequests = state.blockedRequests.slice(0, BLOCKED_REQUESTS_MAX_ENTRIES);
  }

  try {
    await chrome.storage.local.set({ [BLOCKED_REQUESTS_STORAGE_KEY]: state.blockedRequests });
  } catch {
    // Keep the in-memory entry even if persistence fails; the popup reads state.
  }
}

function normalizeAttachLog(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item === "object" && typeof item.time === "string")
    .slice(0, ATTACH_LOG_MAX_ENTRIES);
}

// Diagnostics: record every extension-initiated debugger attach so we can
// answer "why is this tab gated?" (trigger, opener tab, URL at attach time).
function recordAttachLog(entry) {
  state.attachLog.unshift({ time: new Date().toISOString(), ...entry });
  state.attachLog = state.attachLog.slice(0, ATTACH_LOG_MAX_ENTRIES);
  void chrome.storage.local
    .set({ [ATTACH_LOG_STORAGE_KEY]: state.attachLog })
    .catch(() => {
      // Keep the in-memory entry even if persistence fails.
    });
}

function normalizeTabAccessAllowlist(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw createError(-32602, "Tab access allowlist must be an array of { url, enabled } entries");
  }

  const seen = new Set();
  const entries = [];
  for (const item of value) {
    const url = typeof item === "string" ? item : item?.url;
    const enabled = typeof item === "string" ? true : item?.enabled === true;
    if (typeof url !== "string") {
      throw createError(-32602, "Tab access allowlist entries must contain a url string");
    }
    const trimmed = url.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    entries.push({ url: trimmed, enabled });
  }
  return entries;
}

function escapeRegExpPart(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const allowlistMatcherCache = new Map();

function compileAllowlistPattern(pattern) {
  const schemeIndex = pattern.indexOf("://");
  const afterScheme = schemeIndex === -1 ? -1 : schemeIndex + 3;
  let hostEnd = -1;
  if (schemeIndex !== -1) {
    const slashIndex = pattern.indexOf("/", afterScheme);
    const colonIndex = pattern.indexOf(":", afterScheme);
    const bounds = [slashIndex, colonIndex].filter((index) => index !== -1);
    hostEnd = bounds.length > 0 ? Math.min(...bounds) : pattern.length;
  }

  let regex = "^";
  const parts = pattern.split("*");
  const starPositions = [];
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === "*") {
      starPositions.push(i);
    }
  }
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) {
      const starAt = starPositions[i - 1];
      const starInHost = starAt >= afterScheme && starAt < hostEnd;
      if (starInHost) {
        // A host wildcard matches whole labels only (so "*.example.com" never
        // matches "example.com.evil.com"). When the literal part keeps its
        // leading dot, fold it into the label group so the apex domain
        // ("example.com") still matches.
        regex += "(?:[a-z0-9-]+\\.)*";
        if (parts[i].startsWith(".")) {
          parts[i] = parts[i].slice(1);
        }
      } else {
        regex += ".*";
      }
    }
    regex += escapeRegExpPart(parts[i]);
  }

  // Patterns match the start of a URL; require a URL boundary so that
  // "https://nos.nl" does not match "https://nos.nlevil.com".
  // Skip the boundary when the pattern ends with "/" — the path separator
  // already provides a natural boundary, and the assertion would incorrectly
  // require the next char to also be a boundary (breaking prefix matches).
  if (!pattern.endsWith("*") && !pattern.endsWith("/")) {
    regex += "(?=[/:?#]|$)";
  }

  return new RegExp(regex, "i");
}

function getAllowlistMatcher(pattern) {
  let matcher = allowlistMatcherCache.get(pattern);
  if (!matcher) {
    matcher = compileAllowlistPattern(pattern);
    allowlistMatcherCache.set(pattern, matcher);
  }
  return matcher;
}

function matchesAllowlistPattern(pattern, url) {
  return getAllowlistMatcher(pattern).test(url);
}

function isTabUrlAllowed(url) {
  if (typeof url !== "string" || url.length === 0) {
    return false;
  }
  return state.tabAccessAllowlist.some(
    (entry) => entry.enabled && matchesAllowlistPattern(entry.url, url)
  );
}

async function saveTabAccessAllowlist(value) {
  const entries = normalizeTabAccessAllowlist(value);
  await chrome.storage.local.set({ [TAB_ACCESS_STORAGE_KEY]: entries });
  state.tabAccessAllowlist = entries;
  return entries;
}

async function autoAddBlockedTabUrl(url) {
  if (typeof url !== "string" || url.length === 0) {
    return;
  }
  if (state.tabAccessAllowlist.some((entry) => entry.url === url)) {
    return;
  }

  const entries = [...state.tabAccessAllowlist, { url, enabled: false }];
  state.tabAccessAllowlist = entries;
  try {
    await chrome.storage.local.set({ [TAB_ACCESS_STORAGE_KEY]: entries });
  } catch {
    // Keep the in-memory entry even if persistence fails; the popup can re-save it.
  }
}

async function assertTabAccessAllowed(url) {
  if (isTabUrlAllowed(url)) {
    return;
  }

  // Auto-add the blocked URL (disabled) so the user can approve it in the popup.
  await autoAddBlockedTabUrl(url);
  throw createError(
    TAB_ACCESS_BLOCKED_CODE,
    `Tab access blocked: "${url}" is not on the allowlist. Approve this URL manually in the CDT Bridge popup before retrying.`,
    { url, reason: "not-allowlisted" }
  );
}

async function assertTabAccessForTab(tabId, { navigationUrl = null } = {}) {
  const tab = await chrome.tabs.get(tabId);
  const currentUrl = tab.url ?? "";
  if (currentUrl === "") {
    // A freshly created or still-navigating tab has no committed URL yet.
    // There is nothing to allowlist here; the caller should retry once the
    // navigation commits. Do not report this as a missing allowlist entry.
    throw createError(
      TAB_ACCESS_BLOCKED_CODE,
      "Tab access blocked: the tab has no committed URL yet. Retry once the page finishes loading.",
      { reason: "no-committed-url" }
    );
  }
  await assertTabAccessAllowed(currentUrl);
  if (typeof navigationUrl === "string" && navigationUrl.length > 0) {
    await assertTabAccessAllowed(navigationUrl);
  }
}

function isTransientSpawnUrl(url) {
  return (
    !url ||
    url === "about:blank" ||
    url === "about:srcdoc" ||
    /^chrome:\/\/newtab/i.test(url)
  );
}

function isAgentTab(tabId) {
  if (typeof tabId !== "number") {
    return false;
  }
  if (state.rootAttachments.has(tabId)) {
    return true;
  }
  // A session alone (no debugger attach yet) still counts: the agent may
  // command this tab at any moment.
  for (const session of state.sessions.values()) {
    if (session.tabId === tabId) {
      return true;
    }
  }
  return false;
}

function trackSpawnedTab(tab) {
  if (typeof tab.id !== "number" || !isAgentTab(tab.openerTabId)) {
    return;
  }
  // If the tab was created with a transient URL (about:blank, chrome://newtab),
  // the user likely opened it manually via the + button while an agent tab
  // was focused (Chrome sets openerTabId to the active tab). Remember this so
  // we skip it on later onUpdated calls too. The agent cannot attach to
  // disallowed URLs anyway (enforced by assertTabAccessForTab), so the Fetch
  // gate adds no security here.
  if (isTransientSpawnUrl(tab.url)) {
    state.transientSpawnTabs.add(tab.id);
    return;
  }
  if (state.transientSpawnTabs.has(tab.id)) {
    return;
  }
  // Idempotent: openerTabId may be absent at onCreated for cross-origin
  // window.open and only appear on a later onUpdated, so this is called
  // from both. Skip tabs already tracked to avoid redundant attaches.
  if (state.spawnedTabs.has(tab.id)) {
    return;
  }
  state.spawnedTabs.set(tab.id, true);
  // Gate this tab's network as soon as possible. Without this, a
  // window.open() reference from the opener would allow same-origin
  // reads of disallowed pages that load ungated in the new tab.
  void (async () => {
    const attachment = await ensureDebuggerAttached(tab.id, "spawned-tab");
    attachment.extensionHeld = true;
  })().catch(() => {
    // Best effort; policeSpawnedTabUrl reloads if the gate missed the load.
  });
  // If the initial document committed before this tab was tracked (e.g.
  // cross-origin window.open, where openerTabId arrives late), police the
  // current URL now so a disallowed load is reloaded through the gate.
  if (typeof tab.url === "string") {
    void policeSpawnedTabUrl(tab.id, tab.url);
  }
}

async function policeSpawnedTabUrl(tabId, url) {
  if (!state.spawnedTabs.has(tabId) || isTransientSpawnUrl(url)) {
    return;
  }
  if (isTabUrlAllowed(url) || isBrowserInternalUrl(url)) {
    return;
  }
  // A committed disallowed URL must be reloaded so the fresh document
  // request is intercepted by the (now-active) Fetch gate. Attach state
  // cannot prove the original in-flight load was gated: the document may
  // have been fetched before Fetch.enable took effect, leaving a fully
  // readable page behind a window.open() reference. The per-URL set
  // prevents reload loops on redirect chains within a disallowed site.
  const policedUrls = state.spawnedTabPolicedUrls.get(tabId) ?? new Set();
  if (policedUrls.has(url)) {
    return;
  }
  policedUrls.add(url);
  state.spawnedTabPolicedUrls.set(tabId, policedUrls);
  try {
    const attachment = await ensureDebuggerAttached(tabId, "police-reload");
    attachment.extensionHeld = true;
    // bypassCache: a cache-served reload would skip the Fetch gate.
    await chrome.tabs.reload(tabId, { bypassCache: true });
  } catch {
    // The tab may be gone or refuse the debugger; allow a later retry.
    state.spawnedTabPolicedUrls.delete(tabId);
  }
}

const BLOCKED_SUBRESOURCE_BANNER_ID = "cdt-bridge-blocked-subresources";

// Self-contained, idempotent page script: keeps a per-document list of
// subresources the Fetch gate blocked and renders/updates a fixed banner.
// Runs in the page's main world via Runtime.evaluate (unaffected by CSP).
function blockedSubresourceIndicatorScript(url, resourceType) {
  return `(() => {
    try {
      const url = ${JSON.stringify(url)};
      const resourceType = ${JSON.stringify(resourceType)};
      if (!Array.isArray(window.__cdtBridgeBlockedSubresources)) {
        window.__cdtBridgeBlockedSubresources = [];
      }
      const entries = window.__cdtBridgeBlockedSubresources;
      let entry = entries.find((item) => item.url === url);
      if (!entry) {
        entry = { url, resourceType, count: 0 };
        entries.push(entry);
      }
      entry.count += 1;
      if (window.__cdtBridgeBannerCollapsed === undefined) {
        window.__cdtBridgeBannerCollapsed = true; // start collapsed
      }
      const collapsed = window.__cdtBridgeBannerCollapsed;
      let banner = document.getElementById(${JSON.stringify(BLOCKED_SUBRESOURCE_BANNER_ID)});
      if (!banner) {
        banner = document.createElement("div");
        banner.id = ${JSON.stringify(BLOCKED_SUBRESOURCE_BANNER_ID)};
        banner.style.cssText = "position:fixed;bottom:12px;right:12px;z-index:2147483647;max-width:440px;background:#7f1d1d;color:#fef2f2;border:1px solid:#fca5a5;border-radius:8px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.35);";
        (document.body || document.documentElement).appendChild(banner);
      }
      banner.textContent = "";
      const header = document.createElement("div");
      header.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;";
      const toggle = document.createElement("span");
      toggle.style.flex = "none";
      toggle.textContent = collapsed ? "\u25B8" : "\u25BE";
      const title = document.createElement("span");
      title.textContent = "CDT Bridge blocked " + entries.length + " subresource" + (entries.length === 1 ? "" : "s") + " on this page";
      header.appendChild(toggle);
      header.appendChild(title);
      header.addEventListener("click", () => {
        window.__cdtBridgeBannerCollapsed = !window.__cdtBridgeBannerCollapsed;
        const body = document.getElementById(${JSON.stringify(BLOCKED_SUBRESOURCE_BANNER_ID)} + "-body");
        if (body) body.style.display = window.__cdtBridgeBannerCollapsed ? "none" : "";
        toggle.textContent = window.__cdtBridgeBannerCollapsed ? "\u25B8" : "\u25BE";
      });
      banner.appendChild(header);
      const body = document.createElement("div");
      body.id = ${JSON.stringify(BLOCKED_SUBRESOURCE_BANNER_ID)} + "-body";
      body.style.cssText = "max-height:40vh;overflow:auto;padding:0 10px 8px;";
      body.style.display = collapsed ? "none" : "";
      const shown = entries.slice(-5);
      for (const item of shown) {
        const line = document.createElement("div");
        line.textContent = item.resourceType + ": " + item.url + (item.count > 1 ? " (x" + item.count + ")" : "");
        body.appendChild(line);
      }
      if (entries.length > shown.length) {
        const more = document.createElement("div");
        more.textContent = "+ " + (entries.length - shown.length) + " more";
        body.appendChild(more);
      }
      banner.appendChild(body);
    } catch {}
  })();`;
}

// Best-effort: show the user, right on the page, that the gate blocked
// subresources. Document blocks are skipped: the page itself did not load,
// so there is no live document to render into.
async function notifyBlockedSubresourceInPage(tabId, url, resourceType) {
  try {
    await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression: blockedSubresourceIndicatorScript(url, resourceType)
      }
    );
  } catch {
    // The page may be mid-navigation, crashed, or gone; the popup's
    // blocked-requests log still records the block.
  }
}

async function handleFetchRequestPaused(source, params) {
  const requestId = params?.requestId;
  const request = params?.request ?? {};
  const url = request.url;
  // Fetch.requestPaused carries resourceType as a top-level param.
  const resourceType = params?.resourceType ?? request.resourceType ?? "other";

  const allowed =
    typeof url === "string" &&
    (isTabUrlAllowed(url) || isBrowserInternalUrl(url));
  if (!allowed) {
    console.warn(`[cdt-bridge] fetch-gate: blocking ${resourceType} ${url} (tab ${source.tabId})`);
    // Record every blocked request (not just navigations) so the popup can
    // show the user what the gate blocked and let them allow it.
    void recordBlockedRequest({ url, resourceType, tabId: source.tabId });
    if (resourceType !== "Document" && typeof url === "string") {
      void notifyBlockedSubresourceInPage(source.tabId, url, resourceType);
    }
  }
  if (!allowed && resourceType === "Document" && typeof url === "string") {
    // Only auto-add navigations; blocked subresources would spam the list.
    await autoAddBlockedTabUrl(url);
  }

  const debuggee = source.sessionId
    ? { tabId: source.tabId, sessionId: source.sessionId }
    : { tabId: source.tabId };
  try {
    if (allowed) {
      await chrome.debugger.sendCommand(debuggee, "Fetch.continueRequest", { requestId });
    } else {
      await chrome.debugger.sendCommand(debuggee, "Fetch.failRequest", {
        requestId,
        errorReason: "BlockedByClient"
      });
    }
  } catch {
    // The tab or session may have gone away while the request was paused.
  }
}

async function saveSettings(nextSettings) {
  const settings = {
    port: normalizeBridgePort(nextSettings?.port)
  };
  await chrome.storage.local.set({
    [BRIDGE_SETTINGS_STORAGE_KEY]: settings
  });
  state.settings = settings;
  state.settingsLoaded = true;
  return settings;
}

function postNativeMessage(message) {
  if (state.nativePort) {
    state.nativePort.postMessage(message);
  }
}

function isBridgeConnected() {
  return Boolean(state.bridgeStatus?.connected ?? state.bridgeStatus);
}

function drawActionIcon(size, connected) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not draw action icon");
  }

  const strokeWidth = Math.max(2, Math.round(size / 8));
  const nodeRadius = Math.max(2.5, size / 5);
  const centerY = size / 2;
  const leftX = size * 0.28;
  const rightX = size * 0.72;

  context.clearRect(0, 0, size, size);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = connected ? ACTION_COLORS.connected : ACTION_COLORS.disconnected;
  context.fillStyle = ACTION_COLORS.foreground;
  context.lineWidth = strokeWidth;

  context.beginPath();
  context.arc(leftX, centerY, nodeRadius, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.beginPath();
  context.arc(rightX, centerY, nodeRadius, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.beginPath();
  context.moveTo(leftX + nodeRadius + strokeWidth / 2, centerY);
  if (connected) {
    context.lineTo(rightX - nodeRadius - strokeWidth / 2, centerY);
  } else {
    const gap = Math.max(1.5, size / 10);
    context.lineTo(size / 2 - gap, centerY);
    context.moveTo(size / 2 + gap, centerY);
    context.lineTo(rightX - nodeRadius - strokeWidth / 2, centerY);
  }
  context.stroke();

  if (!connected) {
    context.strokeStyle = ACTION_COLORS.alert;
    context.lineWidth = Math.max(2, Math.round(size / 7));
    context.beginPath();
    context.moveTo(size * 0.32, size * 0.72);
    context.lineTo(size * 0.68, size * 0.28);
    context.stroke();
  }

  return context.getImageData(0, 0, size, size);
}

async function updateActionState() {
  const connected = isBridgeConnected();
  const imageData = Object.fromEntries(
    ACTION_ICON_SIZES.map((size) => [size, drawActionIcon(size, connected)])
  );
  const badgeText = connected ? "ON" : "OFF";
  const badgeColor = connected ? ACTION_COLORS.connected : ACTION_COLORS.alert;
  const title = connected
    ? `CDT Bridge connected (${state.bridgeStatus?.httpBaseUrl ?? "local bridge"})`
    : "CDT Bridge disconnected";

  await Promise.all([
    chrome.action.setIcon({ imageData }),
    chrome.action.setBadgeText({ text: badgeText }),
    chrome.action.setBadgeBackgroundColor({ color: badgeColor }),
    chrome.action.setTitle({ title })
  ]);
}

function refreshActionState() {
  void updateActionState().catch((error) => {
    console.error("Failed to update action state", error);
  });
}

async function detachDebuggerTab(tabId) {
  state.expectedDetachTabs.add(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    state.expectedDetachTabs.delete(tabId);
    throw error;
  }
}

let nativePortPromise = null;

async function ensureNativePort() {
  await loadSettings();

  if (state.nativePort) {
    await waitForBridgeStatus();
    return state.nativePort;
  }

  // Dedupe concurrent callers (boot auto-connect vs. popup Start): without
  // this, two connectNative calls launch two native hosts, the second hits
  // EADDRINUSE, and an orphaned host can keep holding the bridge port.
  if (nativePortPromise) {
    return nativePortPromise;
  }

  nativePortPromise = (async () => {
    state.stoppingHost = false;
    const port = chrome.runtime.connectNative(HOST_NAME);
    state.nativePort = port;
    state.nativeConnected = true;
    state.bridgeStatus = null;
    state.developmentReloadToken = null;
    state.lastError = null;
    refreshActionState();

    port.onMessage.addListener((message) => {
      void handleNativeMessage(message);
    });

    port.onDisconnect.addListener(() => {
      const wasStopping = state.stoppingHost;
      state.stoppingHost = false;
      state.nativeConnected = false;
      state.nativePort = null;
      state.bridgeStatus = null;
      state.developmentReloadToken = null;
      state.lastError = wasStopping
        ? null
        : chrome.runtime.lastError?.message ?? "Native host disconnected";
      void appendCrashLog({
        type: "port-disconnect",
        stopping: wasStopping,
        lastError: chrome.runtime.lastError?.message ?? null
      });
      refreshActionState();
    });

    port.postMessage({
      type: "hello",
      version: "0.1.0",
      bridgePort: state.settings.port
    });

    await waitForBridgeStatus();
    return port;
  })().finally(() => {
    nativePortPromise = null;
  });

  return nativePortPromise;
}

async function waitForBridgeStatus(timeoutMs = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (state.bridgeStatus) {
      return state.bridgeStatus;
    }

    if (!state.nativePort) {
      throw createError(-32000, state.lastError ?? "Native host not connected");
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw createError(-32000, "Timed out waiting for bridge startup");
}

async function disconnectDebuggerSessions() {
  for (const [tabId] of state.rootAttachments) {
    try {
      await detachDebuggerTab(tabId);
    } catch {
      // Ignore detach races for tabs already closed or detached.
    }
  }

  state.rootAttachments.clear();
  state.sessions.clear();
  state.lastError = null;

  return {
    connected: Boolean(state.bridgeStatus),
    detached: true
  };
}

async function stopHost({ clearLastError = true } = {}) {
  state.stoppingHost = true;
  await disconnectDebuggerSessions();

  if (!state.nativePort) {
    state.nativeConnected = false;
    state.stoppingHost = false;
    state.bridgeStatus = null;
    state.developmentReloadToken = null;
    if (clearLastError) {
      state.lastError = null;
    }
    refreshActionState();
    return { connected: false, stopped: true };
  }

  const port = state.nativePort;
  state.stoppingHost = true;
  state.nativePort = null;
  state.nativeConnected = false;
  state.bridgeStatus = null;
  state.developmentReloadToken = null;
  if (clearLastError) {
    state.lastError = null;
  }
  refreshActionState();

  try {
    port.disconnect();
  } catch {
    // Ignore disconnect races.
  }

  return { connected: false, stopped: true };
}

async function listTargets() {
  const windows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ["normal"]
  });
  return windows
    .sort(compareWindowsForDiscovery)
    .flatMap((window) =>
      (window.tabs ?? [])
        .filter((tab) => typeof tab.id === "number")
        .sort(compareTabsForDiscovery)
        .map((tab) => buildTargetInfo(tab))
    );
}

function buildTargetInfo(tab) {
  const url = tab.url ?? "about:blank";
  return {
    targetId: makePageTargetId(tab.id),
    tabId: tab.id,
    type: "page",
    title: tab.title ?? "",
    url,
    attached: state.rootAttachments.has(tab.id),
    blocked: !isTabUrlAllowed(url),
    faviconUrl: tab.favIconUrl ?? undefined
  };
}

function compareWindowsForDiscovery(left, right) {
  if (Boolean(left.focused) !== Boolean(right.focused)) {
    return left.focused ? -1 : 1;
  }

  if ((left.id ?? 0) !== (right.id ?? 0)) {
    return (left.id ?? 0) - (right.id ?? 0);
  }

  return 0;
}

function compareTabsForDiscovery(left, right) {
  return (left.index ?? 0) - (right.index ?? 0);
}

const attachmentPromises = new Map();
// Tabs whose move into the "gated" group is in flight: the group is created
// together with the tab and styled afterwards, so the membership event
// fires before the group has its "gated" title. The membership watcher must
// ignore those events or it would ungate the tab right after gating it.
const gatedGroupMovesInFlight = new Set();

async function ensureDebuggerAttached(tabId, reason = "unknown") {
  if (state.rootAttachments.has(tabId)) {
    return state.rootAttachments.get(tabId);
  }
  const pending = attachmentPromises.get(tabId);
  if (pending) {
    return pending;
  }

  const promise = (async () => {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);

    const attachment = {
      tabId,
      targetId: makePageTargetId(tabId),
      rootSessions: new Set(),
      childSessions: new Set(),
      extensionHeld: false
    };

    state.rootAttachments.set(tabId, attachment);

    try {
      const attachedTab = await chrome.tabs.get(tabId).catch(() => null);
      recordAttachLog({
        reason,
        tabId,
        openerTabId: attachedTab?.openerTabId ?? null,
        url: attachedTab?.url ?? null
      });
    } catch {
      // Logging must never break the attach path.
    }

    try {
      await chrome.debugger.sendCommand(
        { tabId },
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true
        }
      );
    } catch {
      // Not every Chrome/Edge build will accept this before attach flows are fully active.
    }

    try {
      // Gate every network request of this tab through the allowlist.
      await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {});
    } catch {
      // Fetch gating is best-effort; the command-level checks still apply.
    }

    // Mark the tab in the tab strip: the red "gated" group is the primary
    // indication; the gated favicon is the fallback for tabs that cannot be
    // grouped (pinned tabs and special pages).
    const grouped = await addTabToGatedGroup(tabId);
    if (!grouped) {
      attachment.usesGatedFavicon = true;
      try {
        await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", {
          source: GATED_FAVICON_INSTALL_SCRIPT
        });
      } catch {
        // Best-effort; the current-document injection below still applies.
      }
      void installGatedFavicon(tabId);
    }

    return attachment;
  })();
  attachmentPromises.set(tabId, promise);
  try {
    return await promise;
  } finally {
    attachmentPromises.delete(tabId);
  }
}

function lookupSession(sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session) {
    throw createError(-32000, "Unknown session", { sessionId });
  }
  return session;
}

function removeSession(sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session) {
    return;
  }

  state.sessions.delete(sessionId);

  const attachment = state.rootAttachments.get(session.tabId);
  if (!attachment) {
    return;
  }

  if (session.root) {
    attachment.rootSessions.delete(sessionId);
  } else {
    attachment.childSessions.delete(sessionId);
  }
}

async function cleanupTabAttachment(tabId) {
  const attachment = state.rootAttachments.get(tabId);
  if (!attachment) {
    return;
  }

  if (attachment.rootSessions.size > 0 || attachment.childSessions.size > 0) {
    return;
  }

  // Extension-held attachments (the Fetch gate for spawned tabs) must
  // survive agent attach/detach cycles; the tab closing removes them.
  if (attachment.extensionHeld) {
    return;
  }

  try {
    await detachDebuggerTab(tabId);
  } catch {
    // Ignore detach races for tabs that already closed.
  }

  state.rootAttachments.delete(tabId);
}

// Visual indication in the tab strip: gated tabs get a marker prefixed to
// their title. The page can reassert its title at any time, so the marker is
// re-applied on every title change while the tab stays gated, and stripped
// again on ungate/detach.
// Visual indication in the tab strip: gated tabs get a "no entry" favicon.
// The tabs API cannot set favicons, so the icon is swapped from inside the
// page (CDP). The install script is registered for every new document while
// the tab stays gated, re-asserts itself against page favicon changes, and
// remembers the original icon; the restore script runs on ungate (before
// detach, the last chance to get into the page).
const GATED_FAVICON_HREF =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%23dc2626'/%3E%3Crect x='6' y='13' width='20' height='6' rx='2' fill='white'/%3E%3C/svg%3E";

const GATED_FAVICON_INSTALL_SCRIPT = `(() => {
  if (window.__cdtBridgeGatedIcon) return;
  window.__cdtBridgeGatedIcon = true;
  const HREF = ${JSON.stringify(GATED_FAVICON_HREF)};
  const ATTR = "data-cdt-gated-icon";
  const saveOriginal = (link) => {
    if (!window.__cdtBridgeGatedIconOriginal && link && link.href) {
      window.__cdtBridgeGatedIconOriginal = link.href;
    }
  };
  const assertIcon = () => {
    try {
      let ours = document.querySelector("link[" + ATTR + "]");
      if (!ours) {
        ours = document.createElement("link");
        ours.rel = "icon";
        ours.setAttribute(ATTR, "1");
        (document.head || document.documentElement).appendChild(ours);
        ours.href = HREF;
      }
      const others = document.querySelectorAll('link[rel*="icon"]:not([' + ATTR + '])');
      for (const other of others) {
        saveOriginal(other);
        other.remove();
      }
    } catch {}
  };
  assertIcon();
  try {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const nodes = [
          ...(mutation.type === "attributes" ? [mutation.target] : []),
          ...mutation.addedNodes,
          ...mutation.removedNodes
        ];
        if (nodes.some((node) => node && node.nodeType === 1 && node.tagName === "LINK")) {
          assertIcon();
          return;
        }
      }
    });
    observer.observe(document.head || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["rel", "href"]
    });
  } catch {}
})();`;

const GATED_FAVICON_RESTORE_SCRIPT = `(() => {
  try {
    const ours = document.querySelector("link[data-cdt-gated-icon]");
    if (ours) ours.remove();
    const original = window.__cdtBridgeGatedIconOriginal;
    if (original) {
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = original;
      (document.head || document.documentElement).appendChild(link);
    }
    delete window.__cdtBridgeGatedIcon;
    delete window.__cdtBridgeGatedIconOriginal;
  } catch {}
})();`;

const GATED_TAB_GROUP_TITLE = "gated";
const GATED_TAB_GROUP_COLOR = "red";
// The tabGroups API requires the "tabGroups" manifest permission; without it
// (or in browser builds without the API) chrome.tabGroups is undefined and
// the group indication/control is skipped — the favicon and gate still work.
const hasTabGroupsApi = Boolean(chrome.tabGroups?.query);

// Chrome reports the tab's group as `groupId` (older builds: `tabGroupId`).
function getTabGroupId(tab) {
  return tab?.groupId ?? tab?.tabGroupId ?? chrome.tabGroups.TAB_GROUP_ID_NONE;
}

// Group indication and control: gated tabs live in a red "gated" tab group
// (one per window, created on demand for the session). Group membership is
// the gate state: a gated tab that leaves the group is ungated
// automatically (see the tabs.onUpdated membership watcher below). Tabs are
// moved out of user groups when they get gated; pinned and special tabs
// cannot be grouped and are skipped (the gated favicon marks them instead).
// The tabGroups API only manages group properties; group creation and
// membership moves use chrome.tabs.group/ungroup (a group is created
// together with its first tab; Chrome deletes it when the last tab
// leaves). Best-effort throughout. Returns whether the tab is in the
// "gated" group (the favicon fallback applies when it is not).
async function addTabToGatedGroup(tabId) {
  if (!hasTabGroupsApi) {
    return false;
  }
  gatedGroupMovesInFlight.add(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    const existing = await chrome.tabGroups.query({
      title: GATED_TAB_GROUP_TITLE,
      windowId: tab.windowId
    });
    if (existing.length > 0) {
      if (getTabGroupId(tab) !== existing[0].id) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: existing[0].id });
      }
      return true;
    }
    // No "gated" group in this window yet: create it together with the tab
    // (the tabGroups API cannot create empty groups), then style it.
    const groupId = await chrome.tabs.group({
      tabIds: [tabId],
      createProperties: { windowId: tab.windowId }
    });
    await chrome.tabGroups.update(groupId, {
      title: GATED_TAB_GROUP_TITLE,
      color: GATED_TAB_GROUP_COLOR
    });
    return true;
  } catch {
    // Grouping is best-effort; the favicon still marks the tab.
    return false;
  } finally {
    gatedGroupMovesInFlight.delete(tabId);
  }
}

async function removeTabFromGatedGroup(tabId) {
  if (!hasTabGroupsApi) {
    return;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    const groupId = getTabGroupId(tab);
    if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      return;
    }
    const group = (await chrome.tabGroups.query({})).find(
      (candidate) => candidate.id === groupId && candidate.title === GATED_TAB_GROUP_TITLE
    );
    if (!group) {
      return; // The tab is in a user group; do not touch it.
    }
    // Chrome deletes the group when its last tab leaves.
    await chrome.tabs.ungroup([tabId]);
  } catch {
    // Best-effort; the tab may be gone.
  }
}

// A (re)gated tab that is sitting on a disallowed URL must be reloaded so
// the fresh document request is intercepted by the Fetch gate; otherwise
// the already-loaded page stays fully readable. bypassCache forces a real
// network request — a cache-served reload would skip the gate entirely.
async function policeGatedTabUrl(tabId, url) {
  if (!url || isTransientSpawnUrl(url) || isBrowserInternalUrl(url) || isTabUrlAllowed(url)) {
    return;
  }
  try {
    await chrome.tabs.reload(tabId, { bypassCache: true });
  } catch {
    // The tab may be gone.
  }
}

// The debugger attachment does not survive a service worker restart (idle
// termination or extension reload), but the "gated" group does. Group
// membership is the persistent gate state, so on every boot every tab still
// in the group is gated again; tabs sitting on a disallowed URL are
// reloaded so the Fetch gate blocks the document. Returns a summary for the
// boot log so a silently failing restore is visible in diagnostics.
async function restoreGatedGroupTabs() {
  const summary = { groups: 0, tabs: 0, restored: [], failed: [] };
  if (!hasTabGroupsApi) {
    return summary;
  }
  let groups = [];
  try {
    groups = await chrome.tabGroups.query({ title: GATED_TAB_GROUP_TITLE });
  } catch (error) {
    summary.error = String(error?.message ?? error);
    return summary;
  }
  summary.groups = groups.length;
  for (const group of groups) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ groupId: group.id });
    } catch {
      continue;
    }
    for (const tab of tabs) {
      if (typeof tab.id !== "number") {
        continue;
      }
      summary.tabs += 1;
      try {
        const attachment = await ensureDebuggerAttached(tab.id, "group-restore");
        attachment.extensionHeld = true;
        await policeGatedTabUrl(tab.id, tab.url);
        summary.restored.push(tab.id);
      } catch (error) {
        summary.failed.push({
          tabId: tab.id,
          url: tab.url ?? null,
          error: String(error?.message ?? error)
        });
      }
    }
  }
  return summary;
}

// Group membership is the gate state in both directions: a gated tab that
// leaves the "gated" group is ungated, and a tab the user moves into the
// group is gated (extension-held, like a spawned tab; the user's drag is
// the authorization, so no allowlist check).
async function handleGatedGroupMembership(tabId) {
  if (gatedGroupMovesInFlight.has(tabId)) {
    return; // Our own move; the tab is already gated.
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    return;
  }
  const groupId = getTabGroupId(tab);
  let inGatedGroup = false;
  if (groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const group = (await chrome.tabGroups.query({})).find(
      (candidate) => candidate.id === groupId
    );
    inGatedGroup = group?.title === GATED_TAB_GROUP_TITLE;
  }
  const attachment = state.rootAttachments.get(tabId);
  if (inGatedGroup) {
    if (!attachment || attachment.releasing) {
      const newAttachment = await ensureDebuggerAttached(tabId, "group-gate");
      newAttachment.extensionHeld = true;
      await policeGatedTabUrl(tabId, tab.url);
    }
    return;
  }
  if (attachment && !attachment.releasing) {
    await ungateTab(tabId);
  }
}

async function evaluateGatedFavicon(tabId, script) {
  try {
    await Promise.race([
      chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: script }),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  } catch {
    // The tab may be gone, mid-navigation, or a page where JS cannot run.
  }
}

// Install the gated favicon in the current document. The document's JS
// context may not exist yet right after attach or at URL commit, so retry
// briefly. The script is idempotent per document, and the on-new-document
// registration covers documents created meanwhile.
async function installGatedFavicon(tabId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!state.rootAttachments.has(tabId)) {
      return;
    }
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: GATED_FAVICON_INSTALL_SCRIPT
      });
      return;
    } catch {
      // No execution context yet (or mid-navigation); retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

// User-initiated (popup): release a tab from the extension's debugger gate
// entirely. The agent can attach (and re-gate) the tab again later if it
// needs it; until then the tab loads and browses like any normal tab.
async function ungateTab(tabId) {
  const attachment = state.rootAttachments.get(tabId);
  if (!attachment) {
    throw createError(-32000, `Tab ${tabId} is not gated`, { tabId });
  }
  if (attachment.releasing) {
    return { ungated: true, tabId };
  }
  attachment.releasing = true;

  attachment.extensionHeld = false;
  state.spawnedTabs.delete(tabId);
  state.spawnedTabPolicedUrls.delete(tabId);

  // Drop this tab's sessions so the detach is a full cleanup, not an
  // agent detach that cleanupTabAttachment would try to preserve.
  for (const [sessionId, session] of state.sessions.entries()) {
    if (session.tabId !== tabId) {
      continue;
    }
    state.sessions.delete(sessionId);
    if (session.root) {
      attachment.rootSessions.delete(sessionId);
    } else {
      attachment.childSessions.delete(sessionId);
    }
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  // Restore the favicon while the debugger is still attached; after detach
  // there is no way back into the page.
  if (attachment.usesGatedFavicon) {
    await evaluateGatedFavicon(tabId, GATED_FAVICON_RESTORE_SCRIPT);
  }
  await removeTabFromGatedGroup(tabId);
  try {
    await detachDebuggerTab(tabId);
  } catch {
    // The debugger may already be gone (user cancelled the infobar);
    // onDetach has cleaned up what it could, finish the job below.
  }
  state.rootAttachments.delete(tabId);
  recordAttachLog({
    reason: "ungate",
    tabId,
    openerTabId: tab?.openerTabId ?? null,
    url: tab?.url ?? null
  });
  return { ungated: true, tabId };
}

async function attachTarget(targetId) {
  const tabId = parsePageTargetId(targetId);
  if (!Number.isInteger(tabId)) {
    throw createError(-32602, "Only page targets are supported for top-level attach", {
      targetId
    });
  }

  await assertTabAccessForTab(tabId);

  const sessionId = makeRootSessionId();
  state.sessions.set(sessionId, { tabId, targetId, root: true });
  return { sessionId, targetId, tabId };
}

async function ensureRootSessionAttached(sessionId) {
  const session = lookupSession(sessionId);
  if (!session.root) {
    return session;
  }

  const attachment = await ensureDebuggerAttached(session.tabId, "agent-attach");
  attachment.rootSessions.add(sessionId);
  return session;
}

async function detachTarget({ sessionId, targetId }) {
  if (sessionId) {
    const session = lookupSession(sessionId);
    if (session.root) {
      removeSession(sessionId);
      await cleanupTabAttachment(session.tabId);
      return {};
    }

    await chrome.debugger.sendCommand(
      { tabId: session.tabId },
      "Target.detachFromTarget",
      { sessionId }
    );
    removeSession(sessionId);
    await cleanupTabAttachment(session.tabId);
    return {};
  }

  const tabId = parsePageTargetId(targetId);
  if (!Number.isInteger(tabId)) {
    throw createError(-32602, "detach requires sessionId or page targetId");
  }

  // The agent must not be able to detach (and thus ungate) a tab it cannot
  // access, including tabs the extension gated internally.
  await assertTabAccessForTab(tabId);

  for (const [existingSessionId, session] of state.sessions.entries()) {
    if (session.tabId === tabId) {
      state.sessions.delete(existingSessionId);
    }
  }

  // cleanupTabAttachment keeps the debugger attached on extension-held
  // tabs so the extension's Fetch gate survives this detach.
  await cleanupTabAttachment(tabId);

  return {};
}

async function resolveDebuggee({ targetId, sessionId }) {
  if (sessionId) {
    const session = lookupSession(sessionId);
    return {
      tabId: session.tabId,
      debuggee: session.root ? { tabId: session.tabId } : { tabId: session.tabId, sessionId },
      targetId: session.targetId,
      rootSessionId: session.root ? sessionId : null
    };
  }

  const tabId = parsePageTargetId(targetId);
  if (!Number.isInteger(tabId)) {
    throw createError(-32602, "sendCommand requires a known sessionId or page targetId");
  }

  await ensureDebuggerAttached(tabId, "agent-command");
  return {
    tabId,
    debuggee: { tabId },
    targetId,
    rootSessionId: null
  };
}

async function sendDebuggerCommand(debuggee, method, params) {
  return await Promise.race([
    chrome.debugger.sendCommand(debuggee, method, params),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(
          createError(-32000, "Debugger command timed out", {
            method,
            debuggee
          })
        );
      }, COMMAND_TIMEOUT_MS);
    })
  ]);
}

function toSyntheticEvaluationResult(value) {
  return {
    result: {
      type: typeof value,
      value
    }
  };
}

function emitSyntheticCdpEvent(tabId, method, params = {}) {
  const targetId = makePageTargetId(tabId);
  const sessionIds = [...state.sessions.entries()]
    .filter(([, session]) => session.root && session.tabId === tabId)
    .map(([sessionId]) => sessionId);

  if (sessionIds.length === 0) {
    emitNativeEvent({
      type: "cdpEvent",
      tabId,
      targetId,
      method,
      params
    });
    return;
  }

  for (const sessionId of sessionIds) {
    emitNativeEvent({
      type: "cdpEvent",
      tabId,
      targetId,
      sessionId,
      method,
      params
    });
  }
}

function getSyntheticFrameId(tabId) {
  return `frame-${tabId}`;
}

function getSyntheticSecurityOrigin(url) {
  if (!isBrowserInternalUrl(url)) {
    try {
      return new URL(url).origin;
    } catch {
      return "null";
    }
  }

  const schemeIndex = url.indexOf("://");
  if (schemeIndex === -1) {
    return "null";
  }

  const pathIndex = url.indexOf("/", schemeIndex + 3);
  return pathIndex === -1 ? url : url.slice(0, pathIndex);
}

function emitSyntheticInternalNavigationCommitted(tabId, navigation) {
  emitSyntheticCdpEvent(tabId, "Page.frameNavigated", {
    frame: {
      id: navigation.frameId,
      loaderId: navigation.loaderId,
      url: navigation.url,
      domainAndRegistry: "",
      securityOrigin: getSyntheticSecurityOrigin(navigation.url),
      mimeType: "text/html"
    }
  });
}

function emitSyntheticInternalNavigationCompleted(tabId) {
  const timestamp = Date.now() / 1000;
  emitSyntheticCdpEvent(tabId, "Page.domContentEventFired", { timestamp });
  emitSyntheticCdpEvent(tabId, "Page.loadEventFired", { timestamp });
}

function finalizePendingInternalNavigation(tabId, navigation) {
  if (!navigation.committed) {
    emitSyntheticInternalNavigationCommitted(tabId, navigation);
    navigation.committed = true;
  }
  emitSyntheticInternalNavigationCompleted(tabId);
  state.pendingInternalNavigations.delete(tabId);
  state.internalNavigationTabs.delete(tabId);
}

function clearPendingInternalNavigation(tabId) {
  const navigation = state.pendingInternalNavigations.get(tabId);
  if (navigation?.fallbackTimer) {
    clearTimeout(navigation.fallbackTimer);
  }
  state.pendingInternalNavigations.delete(tabId);
  state.internalNavigationTabs.delete(tabId);
}

async function maybeHandleBrowserInternalCommand({ tabId, targetId, method, params, sessionId }) {
  const currentTab = await chrome.tabs.get(tabId);
  const currentUrl = currentTab.url ?? "about:blank";

  if (method === "Page.navigate") {
    const nextUrl = params?.url ?? "about:blank";
    if (!isBrowserInternalUrl(nextUrl)) {
      return null;
    }

    state.internalNavigationTabs.add(tabId);
    await chrome.tabs.update(tabId, { url: nextUrl, active: true });
    const navigation = {
      frameId: getSyntheticFrameId(tabId),
      loaderId: crypto.randomUUID(),
      url: nextUrl,
      committed: false,
      fallbackTimer: null
    };
    navigation.fallbackTimer = setTimeout(() => {
      if (!state.pendingInternalNavigations.has(tabId)) {
        return;
      }

      finalizePendingInternalNavigation(tabId, navigation);
    }, INTERNAL_NAVIGATION_FALLBACK_MS);
    state.pendingInternalNavigations.set(tabId, navigation);
    return {
      frameId: navigation.frameId,
      loaderId: navigation.loaderId
    };
  }

  if (!isBrowserInternalUrl(currentUrl)) {
    return null;
  }

  if (INTERNAL_PAGE_NOOP_METHODS.has(method)) {
    return {};
  }

  switch (method) {
    case "Page.reload":
      await chrome.tabs.reload(tabId, {
        bypassCache: Boolean(params?.ignoreCache)
      });
      return {};
    case "Page.bringToFront":
      await activateTarget(targetId);
      return {};
    case "Runtime.evaluate":
      if (params?.expression === "location.href") {
        return toSyntheticEvaluationResult(currentUrl);
      }
      if (params?.expression === "document.title") {
        return toSyntheticEvaluationResult(currentTab.title ?? "");
      }
      return null;
    default:
      return null;
  }
}

async function sendCommand(payload) {
  if (!SUPPORTED_METHODS.has(payload.method)) {
    throw createError(-32601, "Method not supported", {
      method: payload.method
    });
  }

  const navigationUrl =
    payload.method === "Page.navigate" && typeof payload.params?.url === "string"
      ? payload.params.url
      : null;
  if (payload.sessionId) {
    const session = lookupSession(payload.sessionId);
    await assertTabAccessForTab(session.tabId, { navigationUrl });
  } else {
    const tabId = parsePageTargetId(payload.targetId);
    if (Number.isInteger(tabId)) {
      await assertTabAccessForTab(tabId, { navigationUrl });
    }
  }

  const resolved = await resolveDebuggee(payload);
  if (OPTIONAL_NOOP_METHODS.has(payload.method)) {
    return {};
  }

  const internalFallback = await maybeHandleBrowserInternalCommand({
    tabId: resolved.tabId,
    targetId: resolved.targetId,
    method: payload.method,
    params: payload.params ?? {},
    sessionId: payload.sessionId ?? null
  });
  if (internalFallback !== null) {
    return internalFallback;
  }

  let debuggee = resolved.debuggee;
  if (resolved.rootSessionId) {
    const session = await ensureRootSessionAttached(resolved.rootSessionId);
    debuggee = { tabId: session.tabId };
  }

  const result = await sendDebuggerCommand(debuggee, payload.method, payload.params ?? {});

  if (payload.method === "Target.attachToTarget" && result?.sessionId) {
    const attachment = state.rootAttachments.get(resolved.tabId);
    if (attachment) {
      attachment.childSessions.add(result.sessionId);
      state.sessions.set(result.sessionId, {
        tabId: resolved.tabId,
        targetId: payload.params?.targetId ?? resolved.targetId,
        root: false
      });
    }
  }

  if (payload.method === "Target.detachFromTarget" && payload.params?.sessionId) {
    removeSession(payload.params.sessionId);
    await cleanupTabAttachment(resolved.tabId);
  }

  return result ?? {};
}

async function createTarget(url) {
  const targetUrl = url || "about:blank";
  await assertTabAccessAllowed(targetUrl);

  const tab = await chrome.tabs.create({
    url: targetUrl,
    active: true
  });

  if (typeof tab.id !== "number") {
    throw createError(-32603, "Browser did not return a tab id");
  }

  // The tab starts loading before the Fetch gate can attach, and the Fetch
  // domain never intercepts requests served from the HTTP cache. Without
  // this, the agent's own initial load would fetch subresources ungated
  // and keep serving them from cache on every later load. Gate the tab
  // immediately and force one reloaded, fully-gated pass. bypassCache is
  // required: a normal reload would be served from the cache the ungated
  // initial load just populated, and cache hits are invisible to Fetch.
  void (async () => {
    try {
      const attachment = await ensureDebuggerAttached(tab.id, "agent-created");
      attachment.extensionHeld = true;
      const current = await chrome.tabs.get(tab.id);
      if (isTransientSpawnUrl(current.url ?? "")) {
        return;
      }
      await chrome.tabs.reload(tab.id, { bypassCache: true });
    } catch {
      // The tab may be gone or refuse the debugger; nothing to gate.
    }
  })();

  return { targetId: makePageTargetId(tab.id), tabId: tab.id };
}

async function activateTarget(targetId) {
  const tabId = parsePageTargetId(targetId);
  if (!Number.isInteger(tabId)) {
    throw createError(-32602, "Target.activateTarget requires a page targetId");
  }

  await assertTabAccessForTab(tabId);
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return {};
}

async function closeTarget(targetId) {
  const tabId = parsePageTargetId(targetId);
  if (!Number.isInteger(tabId)) {
    throw createError(-32602, "Target.closeTarget requires a page targetId");
  }

  await assertTabAccessForTab(tabId);
  await chrome.tabs.remove(tabId);
  return { success: true };
}

function parseBrowserDiagnostics() {
  const userAgent = navigator.userAgent ?? "";
  const browserMatch = userAgent.match(/(?:HeadlessChrome|Chrome|Chromium|Edg)\/[0-9.]+/);
  const webKitMatch = userAgent.match(/AppleWebKit\/([0-9.]+)/);

  return {
    browserVersion: browserMatch?.[0]?.replace(/^HeadlessChrome\//, "Chrome/") ?? "Chrome/0.0.0.0",
    userAgent,
    jsVersion: null,
    webKitVersion: webKitMatch?.[1] ?? "537.36"
  };
}

async function getDiagnostics() {
  const browser = parseBrowserDiagnostics();
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    browserVersion: browser.browserVersion,
    userAgent: browser.userAgent,
    jsVersion: browser.jsVersion,
    webKitVersion: browser.webKitVersion,
    attachedTabs: [...state.rootAttachments.keys()],
    bridgeStatus: state.bridgeStatus,
    lastError: state.lastError,
    settings: state.settings,
    developmentReloadAllowedIds: state.developmentReloadAllowedIds,
    tabAccessAllowlist: state.tabAccessAllowlist,
    blockedRequests: state.blockedRequests,
    attachLog: state.attachLog,
    crashLog: await loadCrashLog()
  };
}

function getCapabilities() {
  return {
    protocolVersion: "1.3",
    methods: [...SUPPORTED_METHODS].sort()
  };
}

async function reloadDevelopmentExtension(payload) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    typeof payload.extensionId !== "string" ||
    !state.developmentReloadAllowedIds.includes(payload.extensionId)
  ) {
    throw createError(-32602, "reloadDevelopmentExtension requires an allowlisted development extension ID");
  }

  const response = await chrome.runtime.sendMessage(payload.extensionId, {
    type: DEV_RELOAD_MESSAGE_TYPE
  });
  if (!response?.ok) {
    throw createError(-32603, response?.error ?? "Target did not acknowledge the development reload");
  }
  return { ok: true };
}

async function handleNativeRequest(message) {
  switch (message.action) {
    case "ping":
      return { ok: true };
    case "listTargets":
      return await listTargets();
    case "attach":
      return await attachTarget(message.payload.targetId);
    case "detach":
      return await detachTarget(message.payload);
    case "sendCommand":
      return await sendCommand(message.payload);
    case "createTarget":
      return await createTarget(message.payload.url);
    case "activateTarget":
      return await activateTarget(message.payload.targetId);
    case "closeTarget":
      return await closeTarget(message.payload.targetId);
    case "getDiagnostics":
      return await getDiagnostics();
    case "getCapabilities":
      return getCapabilities();
    case "reloadDevelopmentExtension":
      return await reloadDevelopmentExtension(message.payload);
    default:
      throw createError(-32601, "Unknown native host action", {
        action: message.action
      });
  }
}

async function handleNativeMessage(message) {
  if (message.type === "event") {
    if (message.event === "bridgeStatus") {
      state.bridgeStatus = message.payload;
      refreshActionState();
    } else if (message.event === "developmentReloadToken") {
      state.developmentReloadToken = message.payload?.token ?? null;
    } else if (message.event === "developmentReloadError") {
      state.lastError = message.payload?.message ?? "Development reload host error";
    }
    return;
  }

  if (message.type !== "request") {
    return;
  }

  try {
    const result = await handleNativeRequest(message);
    postNativeMessage({
      type: "response",
      requestId: message.requestId,
      ok: true,
      result
    });
  } catch (error) {
    state.lastError = error.message;
    postNativeMessage({
      type: "response",
      requestId: message.requestId,
      ok: false,
      error: serializeError(error)
    });
  }
}

function emitNativeEvent(payload) {
  postNativeMessage({
    type: "event",
    payload
  });
}

function emitTargetLifecycle(type, targetInfoOrId) {
  if (!state.nativePort) {
    return;
  }

  if (type === "targetDestroyed") {
    emitNativeEvent({ type, targetId: targetInfoOrId });
  } else {
    emitNativeEvent({ type, targetInfo: targetInfoOrId });
  }
}

// Capture silent SW deaths: an unhandled rejection or uncaught error terminates
// the MV3 worker with no other trace, so persist it before the SW goes away.
self.addEventListener("unhandledrejection", (event) => {
  const reason = event?.reason;
  let message;
  if (typeof reason?.message === "string") {
    message = reason.message;
  } else if (reason !== null && typeof reason === "object") {
    // Plain protocol-error objects are common; keep them readable.
    try {
      message = JSON.stringify(reason);
    } catch {
      message = String(reason);
    }
  } else {
    message = String(reason ?? "unknown");
  }
  void appendCrashLog({
    type: "unhandledrejection",
    message,
    stack: typeof reason?.stack === "string" ? reason.stack : null
  });
});

self.addEventListener("error", (event) => {
  void appendCrashLog({
    type: "error",
    message: event?.message ?? "uncaught error",
    source: event?.filename ?? null,
    line: event?.lineno ?? null,
    stack: event?.error?.stack ?? null
  });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") {
    return;
  }

  if (method === "Fetch.requestPaused") {
    // Resolve paused requests ourselves so the allowlist gate is unconditional.
    // Do not forward: the request is continued or failed by the gate.
    void handleFetchRequestPaused(source, params);
    return;
  }

  const targetId = makePageTargetId(source.tabId);

  if (method === "Target.attachedToTarget" && params?.sessionId) {
    const parentSession = source.sessionId ? state.sessions.get(source.sessionId) : null;
    const attachment = state.rootAttachments.get(source.tabId);
    attachment?.childSessions.add(params.sessionId);
    state.sessions.set(params.sessionId, {
      tabId: parentSession?.tabId ?? attachment?.tabId ?? source.tabId,
      targetId: params.targetInfo?.targetId ?? parentSession?.targetId ?? targetId,
      root: false
    });
  }

  if (method === "Target.detachedFromTarget" && params?.sessionId) {
    removeSession(params.sessionId);
    void cleanupTabAttachment(source.tabId);
  }

  emitNativeEvent({
    type: "cdpEvent",
    tabId: source.tabId,
    targetId,
    sessionId: source.sessionId,
    method,
    params
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId !== "number") {
    return;
  }

  const wasExpected = state.expectedDetachTabs.delete(source.tabId);
  const wasInternalNavigation =
    state.pendingInternalNavigations.has(source.tabId) || state.internalNavigationTabs.has(source.tabId);

  for (const [sessionId, session] of state.sessions.entries()) {
    if (session.tabId === source.tabId) {
      if (!wasInternalNavigation || !session.root) {
        state.sessions.delete(sessionId);
      }
    }
  }

  // Note: if the debugger detaches for external reasons (user cancels the
  // debug infobar) the gated favicon cannot be restored anymore; it stays
  // until the tab is ungated from the popup or the page is reloaded after
  // the detach.
  void removeTabFromGatedGroup(source.tabId);
  state.rootAttachments.delete(source.tabId);
  if (wasInternalNavigation) {
    state.internalNavigationTabs.delete(source.tabId);
  }
  state.lastError =
    wasExpected || wasInternalNavigation
      ? null
      : `Debugger detached from tab ${source.tabId}: ${reason}`;

  refreshActionState();
});

chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id === "number") {
    emitTargetLifecycle("targetCreated", buildTargetInfo(tab));
  }
  trackSpawnedTab(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  emitTargetLifecycle(
    "targetInfoChanged",
    buildTargetInfo({
      ...tab,
      id: tabId
    })
  );

  // openerTabId can be populated after onCreated (notably for cross-origin
  // window.open), so (re)check spawn tracking before policing the URL.
  trackSpawnedTab({ ...tab, id: tabId });

  if (changeInfo.url) {
    void policeSpawnedTabUrl(tabId, changeInfo.url);
  }

  // A new document committed; make sure the gated favicon install script
  // ran in it (favicon-fallback tabs only; grouped tabs are marked by the
  // group). The on-new-document registration can miss the very first
  // document of an agent-created tab (it commits after the attach, and the
  // one-shot injection raced the load). The script is idempotent per
  // document, so extra calls on redirects are no-ops.
  if (changeInfo.url && state.rootAttachments.get(tabId)?.usesGatedFavicon) {
    void installGatedFavicon(tabId);
  }

  const pendingNavigation = state.pendingInternalNavigations.get(tabId);
  const tabUrl = tab.url ?? changeInfo.url ?? "about:blank";
  if (!pendingNavigation || !isBrowserInternalUrl(tabUrl)) {
    return;
  }

  if (changeInfo.url) {
    emitSyntheticInternalNavigationCommitted(tabId, {
      ...pendingNavigation,
      url: changeInfo.url
    });
    pendingNavigation.url = changeInfo.url;
    pendingNavigation.committed = true;
  }

  if (changeInfo.status === "complete") {
    if (pendingNavigation.fallbackTimer) {
      clearTimeout(pendingNavigation.fallbackTimer);
      pendingNavigation.fallbackTimer = null;
    }
    finalizePendingInternalNavigation(tabId, pendingNavigation);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPendingInternalNavigation(tabId);
  state.spawnedTabs.delete(tabId);
  state.spawnedTabPolicedUrls.delete(tabId);
  emitTargetLifecycle("targetDestroyed", makePageTargetId(tabId));
});

// Group membership is the gate state in both directions: a gated tab that
// leaves the "gated" group (dragged out, moved to another group, group
// deleted) is ungated automatically, and a tab the user moves into the
// group is gated. Current Chrome removed tabGroups.onChanged, so membership
// changes are watched via tabs.onUpdated (changeInfo.groupId). The
// releasing flag and the in-flight set guard against re-entrant and
// self-triggered transitions.
if (hasTabGroupsApi) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo?.groupId === undefined) {
      return;
    }
    void handleGatedGroupMembership(tabId).catch(() => {
      // The tab may be gone or the transition may have raced.
    });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      switch (message?.action) {
        case "connect-host":
        case "start-host":
          state.lastError = null;
          await ensureNativePort();
          sendResponse({ ok: true, state: await getDiagnostics(), capabilities: getCapabilities() });
          return;
        case "disconnect-host":
          sendResponse({
            ok: true,
            result: await disconnectDebuggerSessions(),
            state: await getDiagnostics()
          });
          return;
        case "stop-host":
          sendResponse({
            ok: true,
            result: await stopHost(),
            state: await getDiagnostics()
          });
          return;
        case "set-port": {
          state.lastError = null;
          const wasConnected = Boolean(state.nativePort);
          const settings = await saveSettings({ port: message.port });
          if (wasConnected) {
            await stopHost();
            await ensureNativePort();
          }
          sendResponse({
            ok: true,
            state: await getDiagnostics(),
            bridgeStatus: state.bridgeStatus,
            settings
          });
          return;
        }
        case "get-popup-state":
          // Keep popup startup independent of chrome.tabs/chrome.windows calls.
          // Those calls can be slow while Chrome is restoring windows.
          sendResponse({
            ok: true,
            state: await getDiagnostics(),
            bridgeStatus: state.bridgeStatus,
            settings: state.settings,
            reloadToken: state.developmentReloadToken
          });
          return;
        case "get-state":
          sendResponse({
            ok: true,
            state: await getDiagnostics(),
            bridgeStatus: state.bridgeStatus,
            settings: state.settings,
            reloadToken: state.developmentReloadToken,
            capabilities: getCapabilities(),
            targets: await listTargets()
          });
          return;
        case "refresh-targets":
          sendResponse({ ok: true, targets: await listTargets() });
          return;
        case "get-development-reload-token":
          sendResponse({ ok: true, token: state.developmentReloadToken });
          return;
        case "regenerate-development-reload-token":
          if (!state.nativePort) {
            throw createError(-32000, "Native host is not connected");
          }
          postNativeMessage({ type: "developmentReloadControl", action: "regenerateToken" });
          sendResponse({ ok: true });
          return;
        case "set-development-reload-allowed-ids":
          sendResponse({
            ok: true,
            allowedExtensionIds: await saveDevelopmentReloadAllowedIds(message.extensionIds)
          });
          return;
        case "set-tab-access-allowlist":
          sendResponse({
            ok: true,
            tabAccessAllowlist: await saveTabAccessAllowlist(message.entries)
          });
          return;
        case "ungate-tab": {
          const tabId = Number(message.tabId);
          if (!Number.isInteger(tabId) || tabId < 0) {
            throw createError(-32602, "ungate-tab requires a numeric tabId");
          }
          const result = await ungateTab(tabId);
          sendResponse({ ok: true, ...result, state: await getDiagnostics() });
          return;
        }
        case "dismiss-blocked-request":
          state.blockedRequests = state.blockedRequests.filter(
            (entry) => entry.url !== message.url
          );
          await chrome.storage.local.set({ [BLOCKED_REQUESTS_STORAGE_KEY]: state.blockedRequests });
          sendResponse({ ok: true, blockedRequests: state.blockedRequests });
          return;
        case "clear-blocked-requests":
          state.blockedRequests = [];
          await chrome.storage.local.set({ [BLOCKED_REQUESTS_STORAGE_KEY]: state.blockedRequests });
          sendResponse({ ok: true, blockedRequests: state.blockedRequests });
          return;
        default:
          sendResponse({
            ok: false,
            error: serializeError(createError(-32601, "Unknown popup action"))
          });
      }
    } catch (error) {
      sendResponse({ ok: false, error: serializeError(error) });
    }
  })();

  return true;
});

// Development-only self-reload: the native host's loopback reload endpoint
// forwards an allowlisted extension ID here, and this extension sends the
// fixed reload message to that ID. With its own ID allowlisted (and in
// externally_connectable), the same flow reloads this extension so the
// development loop does not need a manual chrome://extensions reload.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.type !== DEV_RELOAD_MESSAGE_TYPE) {
    return;
  }
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "Unauthorized development reload request" });
    return;
  }
  // Acknowledge before the worker is torn down by the reload.
  sendResponse({ ok: true });
  setTimeout(() => chrome.runtime.reload(), 0);
});

refreshActionState();

void (async () => {
  await loadSettings();
  const groupRestore = await restoreGatedGroupTabs();
  await appendCrashLog({ type: "boot", tabGroupsApi: hasTabGroupsApi, groupRestore });
  await ensureNativePort();
})().catch((error) => {
  state.lastError = error.message;
  refreshActionState();
});

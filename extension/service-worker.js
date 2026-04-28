const HOST_NAME = "com.cdt_bridge";
const DEBUGGER_VERSION = "1.3";
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
  lastError: null,
  rootAttachments: new Map(),
  sessions: new Map(),
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

async function ensureNativePort() {
  if (state.nativePort) {
    await waitForBridgeStatus();
    return state.nativePort;
  }

  state.stoppingHost = false;
  const port = chrome.runtime.connectNative(HOST_NAME);
  state.nativePort = port;
  state.nativeConnected = true;
  state.bridgeStatus = null;
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
    state.lastError = wasStopping
      ? null
      : chrome.runtime.lastError?.message ?? "Native host disconnected";
    refreshActionState();
  });

  port.postMessage({
    type: "hello",
    version: "0.1.0"
  });

  await waitForBridgeStatus();
  return port;
}

async function waitForBridgeStatus(timeoutMs = 5000) {
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
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => typeof tab.id === "number")
    .sort(compareTabsForDiscovery)
    .map((tab) => buildTargetInfo(tab));
}

function buildTargetInfo(tab) {
  return {
    targetId: makePageTargetId(tab.id),
    tabId: tab.id,
    type: "page",
    title: tab.title ?? "",
    url: tab.url ?? "about:blank",
    attached: state.rootAttachments.has(tab.id),
    faviconUrl: tab.favIconUrl ?? undefined
  };
}

function compareTabsForDiscovery(left, right) {
  if (Boolean(left.active) !== Boolean(right.active)) {
    return left.active ? -1 : 1;
  }

  const leftFocused = left.windowId === chrome.windows.WINDOW_ID_CURRENT;
  const rightFocused = right.windowId === chrome.windows.WINDOW_ID_CURRENT;
  if (leftFocused !== rightFocused) {
    return leftFocused ? -1 : 1;
  }

  if ((left.windowId ?? 0) !== (right.windowId ?? 0)) {
    return (left.windowId ?? 0) - (right.windowId ?? 0);
  }

  return (left.index ?? 0) - (right.index ?? 0);
}

async function ensureDebuggerAttached(tabId) {
  if (state.rootAttachments.has(tabId)) {
    return state.rootAttachments.get(tabId);
  }

  await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);

  const attachment = {
    tabId,
    targetId: makePageTargetId(tabId),
    rootSessions: new Set(),
    childSessions: new Set()
  };

  state.rootAttachments.set(tabId, attachment);

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

  return attachment;
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

  try {
    await detachDebuggerTab(tabId);
  } catch {
    // Ignore detach races for tabs that already closed.
  }

  state.rootAttachments.delete(tabId);
}

async function attachTarget(targetId) {
  const tabId = parsePageTargetId(targetId);
  if (!Number.isInteger(tabId)) {
    throw createError(-32602, "Only page targets are supported for top-level attach", {
      targetId
    });
  }

  const sessionId = makeRootSessionId();
  state.sessions.set(sessionId, { tabId, targetId, root: true });
  return { sessionId, targetId, tabId };
}

async function ensureRootSessionAttached(sessionId) {
  const session = lookupSession(sessionId);
  if (!session.root) {
    return session;
  }

  const attachment = await ensureDebuggerAttached(session.tabId);
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

  for (const [existingSessionId, session] of state.sessions.entries()) {
    if (session.tabId === tabId) {
      state.sessions.delete(existingSessionId);
    }
  }

  state.rootAttachments.delete(tabId);
  try {
    await detachDebuggerTab(tabId);
  } catch {
    // Ignore detach races when the tab disappeared.
  }

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

  await ensureDebuggerAttached(tabId);
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

async function createInternalNavigationTab(url) {
  const tab = await chrome.tabs.create({
    url,
    active: true
  });

  if (typeof tab.id !== "number") {
    throw createError(-32603, "Browser did not return a tab id");
  }

  return tab;
}

async function retargetRootSession(sessionId, nextTabId) {
  const session = lookupSession(sessionId);
  if (!session.root) {
    throw createError(-32602, "Browser-internal navigation requires a top-level page session");
  }

  const previousTabId = session.tabId;
  const previousAttachment = state.rootAttachments.get(previousTabId);
  previousAttachment?.rootSessions.delete(sessionId);

  session.tabId = nextTabId;
  session.targetId = makePageTargetId(nextTabId);

  await cleanupTabAttachment(previousTabId);
  return session;
}

async function maybeHandleBrowserInternalCommand({ tabId, targetId, method, params, sessionId }) {
  const currentTab = await chrome.tabs.get(tabId);
  const currentUrl = currentTab.url ?? "about:blank";

  if (method === "Page.navigate") {
    const nextUrl = params?.url ?? "about:blank";
    if (!isBrowserInternalUrl(nextUrl)) {
      return null;
    }

    const nextTab = await createInternalNavigationTab(nextUrl);
    const nextTabId = nextTab.id;
    if (sessionId) {
      state.internalNavigationTabs.add(tabId);
      state.internalNavigationTabs.add(nextTabId);
      await retargetRootSession(sessionId, nextTabId);
    }

    const navigation = {
      frameId: getSyntheticFrameId(nextTabId),
      loaderId: crypto.randomUUID(),
      url: nextUrl,
      committed: false,
      fallbackTimer: null
    };
    navigation.fallbackTimer = setTimeout(() => {
      if (!state.pendingInternalNavigations.has(nextTabId)) {
        return;
      }

      finalizePendingInternalNavigation(nextTabId, navigation);
    }, INTERNAL_NAVIGATION_FALLBACK_MS);
    state.pendingInternalNavigations.set(nextTabId, navigation);
    return {
      frameId: navigation.frameId,
      loaderId: navigation.loaderId
    };
  }

  if (!isBrowserInternalUrl(currentUrl)) {
    return null;
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
  const tab = await chrome.tabs.create({
    url: url || "about:blank",
    active: true
  });

  if (typeof tab.id !== "number") {
    throw createError(-32603, "Browser did not return a tab id");
  }

  return { targetId: makePageTargetId(tab.id), tabId: tab.id };
}

async function activateTarget(targetId) {
  const tabId = parsePageTargetId(targetId);
  if (!Number.isInteger(tabId)) {
    throw createError(-32602, "Target.activateTarget requires a page targetId");
  }

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
    lastError: state.lastError
  };
}

function getCapabilities() {
  return {
    protocolVersion: "1.3",
    methods: [...SUPPORTED_METHODS].sort()
  };
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

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") {
    return;
  }

  const targetId = makePageTargetId(source.tabId);

  if (method === "Target.attachedToTarget" && params?.sessionId) {
    const attachment = state.rootAttachments.get(source.tabId);
    attachment?.childSessions.add(params.sessionId);
    state.sessions.set(params.sessionId, {
      tabId: source.tabId,
      targetId: params.targetInfo?.targetId ?? targetId,
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
      state.sessions.delete(sessionId);
    }
  }

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
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  emitTargetLifecycle(
    "targetInfoChanged",
    buildTargetInfo({
      ...tab,
      id: tabId
    })
  );

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
  emitTargetLifecycle("targetDestroyed", makePageTargetId(tabId));
});

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
        case "get-state":
          sendResponse({
            ok: true,
            state: await getDiagnostics(),
            bridgeStatus: state.bridgeStatus,
            capabilities: getCapabilities(),
            targets: await listTargets()
          });
          return;
        case "refresh-targets":
          sendResponse({ ok: true, targets: await listTargets() });
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

void ensureNativePort().catch((error) => {
  state.lastError = error.message;
  refreshActionState();
});

refreshActionState();

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import path from "node:path";

const serviceWorkerPath = path.resolve(process.cwd(), "extension", "service-worker.js");

async function loadServiceWorkerHarness({
  tab = { id: 1, url: "about:blank", title: "Blank" },
  windows = undefined,
  storedBridgeSettings = undefined,
  storedTabAccessAllowlist = undefined,
  debuggerSendCommand = async () => {
    throw new Error("Debugger command should not have been called");
  },
  runtimeSendMessage = async () => ({ ok: true })
} = {}) {
  let source = await readFile(serviceWorkerPath, "utf8");
  source = source.replace(
    /\nrefreshActionState\(\);\n\nvoid \(async \(\) => \{\n[\s\S]*?\n\}\)\(\)\.catch\(\(error\) => \{\n[\s\S]*?\n\}\);\n?$/,
    "\n"
  );
  source += "\n;globalThis.__serviceWorkerTestExports = { sendCommand, handleNativeRequest, state, makePageTargetId, loadSettings };\n";

  const runtimeListeners = [];
  const debuggerEventListeners = [];
  const debuggerDetachListeners = [];
  const postedMessages = [];
  const nativeMessageListeners = [];
  const nativeDisconnectListeners = [];
  const tabListeners = {
    created: [],
    updated: [],
    removed: []
  };
  const windowMap = new Map();
  const seedWindows =
    windows ??
    [
      {
        id: tab.windowId ?? 1,
        focused: true,
        type: "normal",
        tabs: [{ windowId: tab.windowId ?? 1, index: 0, active: true, ...tab }]
      }
    ];
  const tabs = new Map();
  let nextTabId = 1;
  let activeTabId = tab.id;

  for (const seedWindow of seedWindows) {
    const normalizedWindow = {
      id: seedWindow.id,
      focused: Boolean(seedWindow.focused),
      type: seedWindow.type ?? "normal",
      tabs: []
    };
    for (const seedTab of seedWindow.tabs ?? []) {
      const normalizedTab = {
        windowId: seedWindow.id,
        index: seedTab.index ?? normalizedWindow.tabs.length,
        active: Boolean(seedTab.active),
        ...seedTab
      };
      tabs.set(normalizedTab.id, normalizedTab);
      normalizedWindow.tabs.push(normalizedTab);
      if (normalizedTab.active) {
        activeTabId = normalizedTab.id;
      }
      nextTabId = Math.max(nextTabId, normalizedTab.id + 1);
    }
    windowMap.set(normalizedWindow.id, normalizedWindow);
  }
  const nativePort = {
    onMessage: {
      addListener(listener) {
        nativeMessageListeners.push(listener);
      }
    },
    onDisconnect: {
      addListener(listener) {
        nativeDisconnectListeners.push(listener);
      }
    },
    postMessage(message) {
      postedMessages.push(message);
      if (message.type === "hello") {
        const bridgeStatus = {
          connected: true,
          version: message.version,
          port: message.bridgePort,
          host: "127.0.0.1",
          httpBaseUrl: `http://127.0.0.1:${message.bridgePort}`,
          browserWebSocketUrl: `ws://127.0.0.1:${message.bridgePort}/devtools/browser/test`
        };
        queueMicrotask(() => {
          for (const listener of nativeMessageListeners) {
            listener({
              type: "event",
              event: "bridgeStatus",
              payload: bridgeStatus
            });
          }
        });
      }
    },
    disconnect() {
      for (const listener of nativeDisconnectListeners) {
        listener();
      }
    }
  };
  const chrome = {
    runtime: {
      connectNative() {
        return nativePort;
      },
      async sendMessage(extensionId, message) {
        return await runtimeSendMessage(extensionId, message);
      },
      getManifest() {
        return { version: "0.1.0" };
      },
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        }
      },
      lastError: null
    },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") {
            return { [key]: storage.get(key) };
          }
          return Object.fromEntries(storage.entries());
        },
        async set(items) {
          for (const [key, value] of Object.entries(items)) {
            storage.set(key, value);
          }
        }
      }
    },
    action: {
      async setIcon() {},
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle() {}
    },
    debugger: {
      async attach() {},
      async detach() {},
      async sendCommand(debuggee, method, params) {
        return await debuggerSendCommand(debuggee, method, params);
      },
      onEvent: {
        addListener(listener) {
          debuggerEventListeners.push(listener);
        }
      },
      onDetach: {
        addListener(listener) {
          debuggerDetachListeners.push(listener);
        }
      }
    },
    tabs: {
      async query() {
        return [...tabs.values()].map((value) => ({ ...value }));
      },
      async get(tabId) {
        assert.equal(tabs.has(tabId), true);
        return { ...tabs.get(tabId) };
      },
      async update(tabId, updateProperties) {
        assert.equal(tabs.has(tabId), true);
        const currentTab = tabs.get(tabId);
        Object.assign(currentTab, updateProperties);
        if (typeof updateProperties.url === "string") {
          currentTab.title = updateProperties.url === "chrome://extensions" ? "Extensions" : currentTab.title;
        }
        if (updateProperties.active) {
          activeTabId = tabId;
          const window = windowMap.get(currentTab.windowId);
          for (const sibling of window?.tabs ?? []) {
            sibling.active = sibling.id === tabId;
          }
        }
        return { ...currentTab };
      },
      async create(createProperties) {
        const windowId = createProperties.windowId ?? 1;
        const window = windowMap.get(windowId) ?? {
          id: windowId,
          focused: true,
          type: "normal",
          tabs: []
        };
        windowMap.set(windowId, window);
        const createdTab = {
          id: nextTabId++,
          url: createProperties.url ?? "about:blank",
          title: createProperties.url === "chrome://extensions" ? "Extensions" : createProperties.url ?? "",
          active: Boolean(createProperties.active),
          windowId,
          index: window.tabs.length
        };
        tabs.set(createdTab.id, createdTab);
        window.tabs.push(createdTab);
        if (createdTab.active) {
          activeTabId = createdTab.id;
          for (const sibling of window.tabs) {
            sibling.active = sibling.id === createdTab.id;
          }
        }
        return { ...createdTab };
      },
      async remove(tabId) {
        const removedTab = tabs.get(tabId);
        tabs.delete(tabId);
        const window = windowMap.get(removedTab?.windowId);
        if (window) {
          window.tabs = window.tabs.filter((candidate) => candidate.id !== tabId);
          window.tabs.forEach((candidate, index) => {
            candidate.index = index;
          });
        }
      },
      async reload(tabId) {
        assert.equal(tabs.has(tabId), true);
      },
      onCreated: {
        addListener(listener) {
          tabListeners.created.push(listener);
        }
      },
      onUpdated: {
        addListener(listener) {
          tabListeners.updated.push(listener);
        }
      },
      onRemoved: {
        addListener(listener) {
          tabListeners.removed.push(listener);
        }
      }
    },
    windows: {
      WINDOW_ID_CURRENT: 1,
      WINDOW_ID_NONE: -1,
      async getAll(getInfo) {
        const allowedTypes = new Set(getInfo?.windowTypes ?? []);
        return [...windowMap.values()]
          .filter((window) => allowedTypes.size === 0 || allowedTypes.has(window.type))
          .map((window) => ({
            id: window.id,
            focused: window.focused,
            type: window.type,
            tabs: getInfo?.populate ? window.tabs.map((value) => ({ ...value })) : undefined
          }));
      },
      async update() {}
    }
  };
  const storage = new Map();
  if (storedBridgeSettings !== undefined) {
    storage.set("bridgeSettings", storedBridgeSettings);
  }
  if (storedTabAccessAllowlist !== undefined) {
    storage.set("tabAccessAllowlist", storedTabAccessAllowlist);
  }

  const context = vm.createContext({
    chrome,
    console,
    crypto,
    navigator: {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    },
    OffscreenCanvas: class {
      constructor(size) {
        this.size = size;
      }

      getContext() {
        return {
          clearRect() {},
          beginPath() {},
          arc() {},
          fill() {},
          stroke() {},
          moveTo() {},
          lineTo() {},
          getImageData() {
            return { data: new Uint8ClampedArray(this.size * this.size * 4) };
          }
        };
      }
    },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(source, context, { filename: serviceWorkerPath });
  await context.__serviceWorkerTestExports.loadSettings();
  return {
    ...context.__serviceWorkerTestExports,
    get currentTab() {
      return { ...tabs.get(activeTabId) };
    },
    get tabs() {
      return new Map([...tabs.entries()].map(([id, value]) => [id, { ...value }]));
    },
    nativePort,
    postedMessages,
    storage,
    listeners: {
      runtime: runtimeListeners,
      debuggerEvent: debuggerEventListeners,
      debuggerDetach: debuggerDetachListeners,
      tabs: tabListeners
    }
  };
}

function allowUrls(...urls) {
  return urls.map((url) => ({ url, enabled: true }));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("service worker keeps browser-internal navigation on the current tab", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 7, url: "about:blank", title: "Blank" },
    storedTabAccessAllowlist: allowUrls("about:blank", "chrome://extensions")
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 7,
    targetId: harness.makePageTargetId(7),
    root: true
  });

  const result = await harness.sendCommand({
    method: "Page.navigate",
    params: { url: "chrome://extensions" },
    sessionId
  });

  assert.equal(harness.currentTab.url, "chrome://extensions");
  assert.equal(harness.currentTab.title, "Extensions");
  assert.match(result.frameId, /^frame-7$/);
  assert.match(result.loaderId, /^[0-9a-f-]+$/i);
  assert.equal(harness.state.sessions.get(sessionId).tabId, 7);
  assert.equal(harness.tabs.size, 1);
});

test("service worker synthesizes location and title for browser-internal pages", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 11, url: "chrome://extensions", title: "Extensions" },
    storedTabAccessAllowlist: allowUrls("chrome://extensions"),
    debuggerSendCommand: async (debuggee, method) => {
      sentCommands.push({ debuggee, method });
      throw new Error("Debugger rejected command");
    }
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 11,
    targetId: harness.makePageTargetId(11),
    root: true
  });

  const hrefResult = await harness.sendCommand({
    method: "Runtime.evaluate",
    params: { expression: "location.href" },
    sessionId
  });
  const titleResult = await harness.sendCommand({
    method: "Runtime.evaluate",
    params: { expression: "document.title" },
    sessionId
  });

  assert.equal(JSON.stringify(hrefResult), JSON.stringify({
    result: {
      type: "string",
      value: "chrome://extensions"
    }
  }));
  assert.equal(JSON.stringify(titleResult), JSON.stringify({
    result: {
      type: "string",
      value: "Extensions"
    }
  }));
  assert.deepEqual(sentCommands.map(({ method }) => method), []);
});

test("service worker keeps the root session alive across internal-page debugger detach", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 13, url: "about:blank", title: "Blank" },
    storedTabAccessAllowlist: allowUrls("about:blank", "chrome://extensions")
  });
  const sessionId = "root-session";
  harness.state.nativePort = harness.nativePort;
  harness.state.sessions.set(sessionId, {
    tabId: 13,
    targetId: harness.makePageTargetId(13),
    root: true
  });
  harness.state.rootAttachments.set(13, {
    tabId: 13,
    targetId: harness.makePageTargetId(13),
    rootSessions: new Set([sessionId]),
    childSessions: new Set()
  });

  await harness.sendCommand({
    method: "Page.navigate",
    params: { url: "chrome://extensions" },
    sessionId
  });
  harness.listeners.debuggerDetach[0]({ tabId: 13 }, "target_closed");

  const hrefResult = await harness.sendCommand({
    method: "Runtime.evaluate",
    params: { expression: "location.href" },
    sessionId
  });

  assert.equal(harness.state.sessions.has(sessionId), true);
  assert.equal(harness.state.nativePort, harness.nativePort);
  assert.equal(
    JSON.stringify(hrefResult),
    JSON.stringify({
      result: {
        type: "string",
        value: "chrome://extensions"
      }
    })
  );
});

test("service worker treats Page.enable as a no-op for internal pages", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 15, url: "chrome://extensions", title: "Extensions" },
    storedTabAccessAllowlist: allowUrls("chrome://extensions"),
    debuggerSendCommand: async (debuggee, method, params) => {
      sentCommands.push({ debuggee, method, params });
      throw new Error("Debugger command should not have been called");
    }
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 15,
    targetId: harness.makePageTargetId(15),
    root: true
  });

  const result = await harness.sendCommand({
    method: "Page.enable",
    sessionId
  });

  assert.equal(JSON.stringify(result), "{}");
  assert.deepEqual(sentCommands, []);
});

test("service worker keeps child sessions bound to the parent tab when attached events report a different tab id", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 19, url: "about:blank", title: "Blank" },
    storedTabAccessAllowlist: allowUrls("about:blank", "https://example.com"),
    debuggerSendCommand: async (debuggee, method, params) => {
      sentCommands.push({ debuggee, method, params });
      return method === "Page.navigate" ? { frameId: "frame-19", loaderId: "loader-19" } : {};
    }
  });
  const rootSessionId = "root-session";
  harness.state.sessions.set(rootSessionId, {
    tabId: 19,
    targetId: harness.makePageTargetId(19),
    root: true
  });
  harness.state.rootAttachments.set(19, {
    tabId: 19,
    targetId: harness.makePageTargetId(19),
    rootSessions: new Set([rootSessionId]),
    childSessions: new Set()
  });

  harness.listeners.debuggerEvent[0](
    { tabId: 47940036, sessionId: rootSessionId },
    "Target.attachedToTarget",
    {
      sessionId: "child-session",
      targetInfo: {
        targetId: "child-target",
        type: "page",
        title: "Blank",
        url: "about:blank"
      }
    }
  );

  const childSession = harness.state.sessions.get("child-session");
  assert.equal(childSession?.tabId, 19);
  assert.equal(childSession?.targetId, "child-target");

  const result = await harness.sendCommand({
    method: "Page.navigate",
    params: { url: "https://example.com" },
    sessionId: "child-session"
  });

  assert.equal(JSON.stringify(result), JSON.stringify({
    frameId: "frame-19",
    loaderId: "loader-19"
  }));
  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].method, "Page.navigate");
  assert.equal(JSON.stringify(sentCommands[0].debuggee), JSON.stringify({
    tabId: 19,
    sessionId: "child-session"
  }));
  assert.equal(JSON.stringify(sentCommands[0].params), JSON.stringify({
    url: "https://example.com"
  }));
});

test("service worker ignores source-tab detaches during internal-page retargeting", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 21, url: "chrome://newtab/", title: "New Tab" },
    storedTabAccessAllowlist: allowUrls("chrome://newtab/", "chrome://extensions")
  });
  const sessionId = "root-session";
  harness.state.nativePort = harness.nativePort;
  harness.state.sessions.set(sessionId, {
    tabId: 21,
    targetId: harness.makePageTargetId(21),
    root: true
  });
  harness.state.rootAttachments.set(21, {
    tabId: 21,
    targetId: harness.makePageTargetId(21),
    rootSessions: new Set([sessionId]),
    childSessions: new Set()
  });

  await harness.sendCommand({
    method: "Page.navigate",
    params: { url: "chrome://extensions" },
    sessionId
  });

  harness.listeners.debuggerDetach[0]({ tabId: 21 }, "target_closed");

  assert.equal(harness.state.nativePort, harness.nativePort);
  assert.equal(harness.state.sessions.has(sessionId), true);
  assert.equal(harness.state.lastError, null);
});

test("service worker keeps the native host running after unexpected debugger detaches", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 27, url: "about:blank", title: "Blank" }
  });
  const sessionId = "root-session";
  harness.state.nativePort = harness.nativePort;
  harness.state.sessions.set(sessionId, {
    tabId: 27,
    targetId: harness.makePageTargetId(27),
    root: true
  });
  harness.state.rootAttachments.set(27, {
    tabId: 27,
    targetId: harness.makePageTargetId(27),
    rootSessions: new Set([sessionId]),
    childSessions: new Set()
  });

  harness.listeners.debuggerDetach[0]({ tabId: 27 }, "target_closed");

  assert.equal(harness.state.nativePort, harness.nativePort);
  assert.equal(harness.state.sessions.has(sessionId), false);
  assert.equal(harness.state.rootAttachments.has(27), false);
  assert.equal(harness.state.lastError, "Debugger detached from tab 27: target_closed");
});

test("service worker emits synthetic load events for internal-page navigations", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 17, url: "about:blank", title: "Blank" },
    storedTabAccessAllowlist: allowUrls("about:blank", "chrome://extensions")
  });
  const sessionId = "root-session";
  harness.state.nativePort = harness.nativePort;
  harness.state.sessions.set(sessionId, {
    tabId: 17,
    targetId: harness.makePageTargetId(17),
    root: true
  });

  await harness.sendCommand({
    method: "Page.navigate",
    params: { url: "chrome://extensions" },
    sessionId
  });
  const newTabId = harness.state.sessions.get(sessionId).tabId;
  harness.listeners.tabs.updated[0](
    newTabId,
    { url: "chrome://extensions" },
    { id: newTabId, url: "chrome://extensions", title: "Extensions" }
  );
  harness.listeners.tabs.updated[0](
    newTabId,
    { status: "complete" },
    { id: newTabId, url: "chrome://extensions", title: "Extensions" }
  );

  const methods = harness.postedMessages
    .filter((message) => message.type === "event" && message.payload?.type === "cdpEvent")
    .map((message) => message.payload.method);

  assert.ok(methods.includes("Page.frameNavigated"));
  assert.ok(methods.includes("Page.domContentEventFired"));
  assert.ok(methods.includes("Page.loadEventFired"));
});

test("service worker falls back to synthetic load events when internal tabs do not report completion", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 31, url: "about:blank", title: "Blank" },
    storedTabAccessAllowlist: allowUrls("about:blank", "chrome://extensions")
  });
  const sessionId = "root-session";
  harness.state.nativePort = harness.nativePort;
  harness.state.sessions.set(sessionId, {
    tabId: 31,
    targetId: harness.makePageTargetId(31),
    root: true
  });

  await harness.sendCommand({
    method: "Page.navigate",
    params: { url: "chrome://extensions" },
    sessionId
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const methods = harness.postedMessages
    .filter((message) => message.type === "event" && message.payload?.type === "cdpEvent")
    .map((message) => message.payload.method);

  assert.ok(methods.includes("Page.frameNavigated"));
  assert.ok(methods.includes("Page.domContentEventFired"));
  assert.ok(methods.includes("Page.loadEventFired"));
  assert.equal(harness.state.pendingInternalNavigations.size, 0);
});

test("service worker starts the native host with the persisted bridge port", async () => {
  const harness = await loadServiceWorkerHarness({
    storedBridgeSettings: { port: 9333 }
  });

  const response = await new Promise((resolve) => {
    harness.listeners.runtime[0]({ action: "start-host" }, null, resolve);
  });

  assert.equal(response.ok, true);
  assert.equal(harness.postedMessages[0].bridgePort, 9333);
  assert.equal(response.state.settings.port, 9333);
});

test("service worker persists bridge port updates for future restarts", async () => {
  const harness = await loadServiceWorkerHarness();

  await new Promise((resolve) => {
    harness.listeners.runtime[0]({ action: "set-port", port: "9444" }, null, resolve);
  });
  const response = await new Promise((resolve) => {
    harness.listeners.runtime[0]({ action: "start-host" }, null, resolve);
  });

  assert.equal(harness.storage.get("bridgeSettings").port, 9444);
  assert.equal(response.ok, true);
  assert.equal(harness.postedMessages[0].bridgePort, 9444);
  assert.equal(response.state.settings.port, 9444);
});

test("service worker lists tabs in focused-window order and skips non-normal windows", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 3,
        focused: false,
        type: "normal",
        tabs: [
          { id: 31, url: "https://three.example/1", title: "Three One", index: 0, active: true },
          { id: 32, url: "https://three.example/2", title: "Three Two", index: 1, active: false }
        ]
      },
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 11, url: "https://one.example/1", title: "One One", index: 0, active: false },
          { id: 12, url: "https://one.example/2", title: "One Two", index: 1, active: true }
        ]
      },
      {
        id: 9,
        focused: false,
        type: "popup",
        tabs: [{ id: 91, url: "chrome-extension://popup", title: "Popup", index: 0, active: true }]
      }
    ]
  });

  const targets = await new Promise((resolve) => {
    harness.listeners.runtime[0]({ action: "refresh-targets" }, null, (response) => resolve(response.targets));
  });

  assert.deepEqual(
    targets.map((target) => target.tabId),
    [11, 12, 31, 32]
  );
});

test("service worker sends only the fixed development reload message to Helpers", async () => {
  const sent = [];
  const harness = await loadServiceWorkerHarness({
    runtimeSendMessage: async (extensionId, message) => {
      sent.push({ extensionId, message });
      return { ok: true };
    }
  });

  assert.equal(
    (
      await harness.handleNativeRequest({
        action: "reloadDevelopmentExtension",
        payload: { extensionId: "hacmcjjofinfaaahgdhopnnnipgjigge" }
      })
    ).ok,
    true
  );
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    {
      extensionId: "hacmcjjofinfaaahgdhopnnnipgjigge",
      message: { type: "cdt-bridge.dev-reload.v1" }
    }
  ]);
  await assert.rejects(
    harness.handleNativeRequest({
      action: "reloadDevelopmentExtension",
      payload: { extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
    }),
    /requires an allowlisted development extension ID/
  );
});

test("service worker blocks commands for non-allowlisted tabs and auto-adds the URL disabled", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 41, url: "https://blocked.example/page", title: "Blocked" }
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 41,
    targetId: harness.makePageTargetId(41),
    root: true
  });

  await assert.rejects(
    harness.sendCommand({
      method: "Runtime.evaluate",
      params: { expression: "1" },
      sessionId
    }),
    (error) => {
      assert.equal(error.code, -32003);
      assert.match(error.message, /blocked/i);
      assert.match(error.message, /manually/i);
      return true;
    }
  );

  assert.deepEqual(plain(harness.state.tabAccessAllowlist), [
    { url: "https://blocked.example/page", enabled: false }
  ]);
  assert.deepEqual(plain(harness.storage.get("tabAccessAllowlist")), [
    { url: "https://blocked.example/page", enabled: false }
  ]);
});

test("service worker allows tabs whose URL starts with an allowlisted prefix", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 43, url: "https://example.com/deep/path?q=1", title: "Example" },
    storedTabAccessAllowlist: allowUrls("https://example.com"),
    debuggerSendCommand: async (debuggee, method) => {
      sentCommands.push(method);
      return {};
    }
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 43,
    targetId: harness.makePageTargetId(43),
    root: true
  });
  harness.state.rootAttachments.set(43, {
    tabId: 43,
    targetId: harness.makePageTargetId(43),
    rootSessions: new Set([sessionId]),
    childSessions: new Set()
  });

  await harness.sendCommand({
    method: "Runtime.evaluate",
    params: { expression: "1" },
    sessionId
  });

  assert.deepEqual(sentCommands, ["Runtime.evaluate"]);
});

test("service worker blocks navigation to a non-allowlisted URL and auto-adds it", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 45, url: "https://allowed.example", title: "Allowed" },
    storedTabAccessAllowlist: allowUrls("https://allowed.example")
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 45,
    targetId: harness.makePageTargetId(45),
    root: true
  });

  await assert.rejects(
    harness.sendCommand({
      method: "Page.navigate",
      params: { url: "https://elsewhere.example/x" },
      sessionId
    }),
    /Tab access blocked/
  );

  assert.equal(harness.currentTab.url, "https://allowed.example");
  assert.deepEqual(plain(harness.state.tabAccessAllowlist), [
    { url: "https://allowed.example", enabled: true },
    { url: "https://elsewhere.example/x", enabled: false }
  ]);
});

test("service worker blocks attach for non-allowlisted tabs", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 61, url: "https://locked.example", title: "Locked" }
  });

  await assert.rejects(
    harness.handleNativeRequest({ action: "attach", payload: { targetId: "page:61" } }),
    /Tab access blocked/
  );

  assert.equal(harness.state.sessions.size, 0);
  assert.deepEqual(plain(harness.state.tabAccessAllowlist), [
    { url: "https://locked.example", enabled: false }
  ]);
});

test("service worker blocks createTarget for non-allowlisted URLs", async () => {
  const harness = await loadServiceWorkerHarness();

  await assert.rejects(
    harness.handleNativeRequest({
      action: "createTarget",
      payload: { url: "https://nope.example" }
    }),
    /Tab access blocked/
  );

  assert.deepEqual(plain(harness.state.tabAccessAllowlist), [
    { url: "https://nope.example", enabled: false }
  ]);
});

test("service worker persists popup tab access allowlist updates", async () => {
  const harness = await loadServiceWorkerHarness({
    storedTabAccessAllowlist: [{ url: "https://pending.example", enabled: false }]
  });

  const response = await new Promise((resolve) => {
    harness.listeners.runtime[0](
      {
        action: "set-tab-access-allowlist",
        entries: [{ url: "https://pending.example", enabled: true }]
      },
      null,
      resolve
    );
  });

  assert.equal(response.ok, true);
  assert.deepEqual(plain(response.tabAccessAllowlist), [
    { url: "https://pending.example", enabled: true }
  ]);
  assert.deepEqual(plain(harness.storage.get("tabAccessAllowlist")), [
    { url: "https://pending.example", enabled: true }
  ]);
});

test("service worker marks non-allowlisted targets as blocked in target lists", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 51, url: "https://allowed.example", title: "Allowed", index: 0, active: true },
          { id: 52, url: "https://blocked.example", title: "Blocked", index: 1, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://allowed.example")
  });

  const targets = await new Promise((resolve) => {
    harness.listeners.runtime[0]({ action: "refresh-targets" }, null, (response) =>
      resolve(response.targets)
    );
  });

  assert.deepEqual(
    targets.map((target) => [target.tabId, target.blocked]),
    [
      [51, false],
      [52, true]
    ]
  );
});

test("service worker treats domain wildcards as whole-label subdomain matches", async () => {
  const harness = await loadServiceWorkerHarness({
    storedTabAccessAllowlist: [{ url: "https://*.example.com", enabled: true }]
  });

  const cdnTarget = await harness.handleNativeRequest({
    action: "createTarget",
    payload: { url: "https://cdn.example.com/assets/app.js" }
  });
  const apexTarget = await harness.handleNativeRequest({
    action: "createTarget",
    payload: { url: "https://example.com/" }
  });
  assert.equal(typeof cdnTarget.tabId, "number");
  assert.equal(typeof apexTarget.tabId, "number");

  await assert.rejects(
    harness.handleNativeRequest({
      action: "createTarget",
      payload: { url: "https://example.com.evil.com/" }
    }),
    /Tab access blocked/
  );
  await assert.rejects(
    harness.handleNativeRequest({
      action: "createTarget",
      payload: { url: "https://evilexample.com/" }
    }),
    /Tab access blocked/
  );
});

test("service worker does not match plain prefixes against lookalike hosts", async () => {
  const harness = await loadServiceWorkerHarness({
    storedTabAccessAllowlist: allowUrls("https://nos.nl")
  });

  await assert.rejects(
    harness.handleNativeRequest({
      action: "createTarget",
      payload: { url: "https://nos.nlevil.com/" }
    }),
    /Tab access blocked/
  );
});

test("service worker gates network requests of attached tabs through the allowlist", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 71, url: "https://app.example", title: "App" },
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async (debuggee, method, params) => {
      sentCommands.push({ method, params });
      return {};
    }
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 71,
    targetId: harness.makePageTargetId(71),
    root: true
  });

  await harness.sendCommand({
    method: "Runtime.evaluate",
    params: { expression: "1" },
    sessionId
  });
  assert.ok(sentCommands.some(({ method }) => method === "Fetch.enable"));

  const emitPaused = (params) =>
    harness.listeners.debuggerEvent[0]({ tabId: 71 }, "Fetch.requestPaused", params);
  emitPaused({ requestId: "r1", request: { url: "https://app.example/data.js", resourceType: "script" } });
  emitPaused({ requestId: "r2", request: { url: "https://other.example/secret", resourceType: "xhr" } });
  emitPaused({ requestId: "r3", request: { url: "https://other.example/page", resourceType: "document" } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(
    sentCommands
      .filter(({ method }) => method === "Fetch.continueRequest" || method === "Fetch.failRequest")
      .map(({ method, params }) => [method, params.requestId, params.errorReason ?? null]),
    [
      ["Fetch.continueRequest", "r1", null],
      ["Fetch.failRequest", "r2", "BlockedByClient"],
      ["Fetch.failRequest", "r3", "BlockedByClient"]
    ]
  );

  // Only the blocked document navigation is auto-added, not the blocked xhr.
  assert.deepEqual(plain(harness.state.tabAccessAllowlist), [
    { url: "https://app.example", enabled: true },
    { url: "https://other.example/page", enabled: false }
  ]);

  // Paused requests are resolved by the gate and not forwarded to the agent.
  assert.ok(
    !harness.postedMessages.some(
      (message) =>
        message.type === "event" &&
        message.payload?.type === "cdpEvent" &&
        message.payload.method === "Fetch.requestPaused"
    )
  );
});

test("service worker checks every redirect hop of a gated request", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 73, url: "https://app.example", title: "App" },
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async (debuggee, method, params) => {
      sentCommands.push({ method, params });
      return {};
    }
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 73,
    targetId: harness.makePageTargetId(73),
    root: true
  });
  await harness.sendCommand({
    method: "Runtime.evaluate",
    params: { expression: "1" },
    sessionId
  });

  const emitPaused = (params) =>
    harness.listeners.debuggerEvent[0]({ tabId: 73 }, "Fetch.requestPaused", params);
  emitPaused({ requestId: "r1", request: { url: "https://app.example/redirect", resourceType: "document" } });
  emitPaused({
    requestId: "r1",
    response: { status: 302 },
    request: { url: "https://other.example/taken", resourceType: "document" }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(
    sentCommands
      .filter(({ method }) => method === "Fetch.continueRequest" || method === "Fetch.failRequest")
      .map(({ method, params }) => [method, params.requestId]),
    [
      ["Fetch.continueRequest", "r1"],
      ["Fetch.failRequest", "r1"]
    ]
  );
});

test("service worker closes spawned tabs that open a non-allowlisted URL", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 81, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 90, url: "https://blocked.example/x", title: "Blocked", index: 1, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example")
  });
  harness.state.rootAttachments.set(81, {
    tabId: 81,
    targetId: harness.makePageTargetId(81),
    rootSessions: new Set(),
    childSessions: new Set()
  });

  harness.listeners.tabs.created[0]({
    id: 90,
    openerTabId: 81,
    url: "https://blocked.example/x",
    title: "Blocked"
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.tabs.has(90), false);
  assert.deepEqual(plain(harness.state.tabAccessAllowlist), [
    { url: "https://app.example", enabled: true },
    { url: "https://blocked.example/x", enabled: false }
  ]);
});

test("service worker leaves spawned tabs alone when allowed or not spawned by an attached tab", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 83, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 91, url: "https://app.example/new", title: "New", index: 1, active: false },
          { id: 92, url: "https://blocked.example/y", title: "Blocked", index: 2, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example")
  });
  harness.state.rootAttachments.set(83, {
    tabId: 83,
    targetId: harness.makePageTargetId(83),
    rootSessions: new Set(),
    childSessions: new Set()
  });

  harness.listeners.tabs.created[0]({ id: 91, openerTabId: 83, url: "https://app.example/new" });
  harness.listeners.tabs.created[0]({ id: 92, openerTabId: 55, url: "https://blocked.example/y" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.tabs.has(91), true);
  assert.equal(harness.tabs.has(92), true);
  assert.deepEqual(plain(harness.state.tabAccessAllowlist), allowUrls("https://app.example"));
});

test("service worker closes spawned tabs that later navigate to a non-allowlisted URL", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 85, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 93, url: "about:blank", title: "", index: 1, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example")
  });
  harness.state.rootAttachments.set(85, {
    tabId: 85,
    targetId: harness.makePageTargetId(85),
    rootSessions: new Set(),
    childSessions: new Set()
  });

  harness.listeners.tabs.created[0]({ id: 93, openerTabId: 85, url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.tabs.has(93), true);

  harness.listeners.tabs.updated[0](
    93,
    { url: "https://blocked.example/late" },
    { id: 93, url: "https://blocked.example/late", title: "Blocked" }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.tabs.has(93), false);
  assert.deepEqual(plain(harness.state.tabAccessAllowlist), [
    { url: "https://app.example", enabled: true },
    { url: "https://blocked.example/late", enabled: false }
  ]);
});

test("service worker closes spawned tabs when the opener only has a session (no debugger attach yet)", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 87, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 94, url: "https://blocked.example/z", title: "Blocked", index: 1, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example")
  });
  // Session only — no entry in rootAttachments.
  harness.state.sessions.set("root-session-87", {
    tabId: 87,
    targetId: harness.makePageTargetId(87),
    root: true
  });

  harness.listeners.tabs.created[0]({
    id: 94,
    openerTabId: 87,
    url: "https://blocked.example/z",
    title: "Blocked"
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.tabs.has(94), false);
  assert.equal(harness.state.spawnedTabsClosed, 1);
});


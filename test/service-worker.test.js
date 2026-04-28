import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import path from "node:path";

const serviceWorkerPath = path.resolve(process.cwd(), "extension", "service-worker.js");

async function loadServiceWorkerHarness({
  tab = { id: 1, url: "about:blank", title: "Blank" },
  storedBridgeSettings = undefined,
  debuggerSendCommand = async () => {
    throw new Error("Debugger command should not have been called");
  }
} = {}) {
  let source = await readFile(serviceWorkerPath, "utf8");
  source = source.replace(
    /\nrefreshActionState\(\);\n\nvoid \(async \(\) => \{\n[\s\S]*?\n\}\)\(\)\.catch\(\(error\) => \{\n[\s\S]*?\n\}\);\n?$/,
    "\n"
  );
  source += "\n;globalThis.__serviceWorkerTestExports = { sendCommand, state, makePageTargetId };\n";

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
  const tabs = new Map([[tab.id, { ...tab }]]);
  let nextTabId = tab.id + 1;
  let activeTabId = tab.id;
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
        }
        return { ...currentTab };
      },
      async create(createProperties) {
        const createdTab = {
          id: nextTabId++,
          url: createProperties.url ?? "about:blank",
          title: createProperties.url === "chrome://extensions" ? "Extensions" : createProperties.url ?? "",
          active: Boolean(createProperties.active),
          windowId: 1,
          index: tabs.size
        };
        tabs.set(createdTab.id, createdTab);
        if (createdTab.active) {
          activeTabId = createdTab.id;
        }
        return { ...createdTab };
      },
      async remove(tabId) {
        tabs.delete(tabId);
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
      async update() {}
    }
  };
  const storage = new Map();
  if (storedBridgeSettings !== undefined) {
    storage.set("bridgeSettings", storedBridgeSettings);
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

test("service worker opens a new tab for browser-internal navigation", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 7, url: "about:blank", title: "Blank" }
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
  assert.match(result.frameId, /^frame-8$/);
  assert.match(result.loaderId, /^[0-9a-f-]+$/i);
  assert.equal(harness.state.sessions.get(sessionId).tabId, 8);
});

test("service worker synthesizes location and title for browser-internal pages", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 11, url: "chrome://extensions", title: "Extensions" },
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
    tab: { id: 13, url: "about:blank", title: "Blank" }
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

test("service worker ignores source-tab detaches during internal-page retargeting", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 21, url: "chrome://newtab/", title: "New Tab" }
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
    tab: { id: 17, url: "about:blank", title: "Blank" }
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
    tab: { id: 31, url: "about:blank", title: "Blank" }
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

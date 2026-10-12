import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import path from "node:path";

const serviceWorkerPath = path.resolve(process.cwd(), "extension", "service-worker.js");

async function loadServiceWorkerHarness({
  tab = { id: 1, url: "about:blank", title: "Blank" },
  windows = undefined,
  tabGroupsApi = true,
  storedBridgeSettings = undefined,
  storedTabAccessAllowlist = undefined,
  storedBlockedRequestsLog = undefined,
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
  source += "\n;globalThis.__serviceWorkerTestExports = { sendCommand, handleNativeRequest, state, makePageTargetId, loadSettings, ensureNativePort, restoreGatedGroupTabs, GATED_FAVICON_INSTALL_SCRIPT, GATED_FAVICON_RESTORE_SCRIPT };\n";

  const runtimeListeners = [];
  const externalMessageListeners = [];
  let runtimeReloadCalls = 0;
  const selfListeners = {};
  const debuggerEventListeners = [];
  const debuggerDetachListeners = [];
  const postedMessages = [];
  const nativeMessageListeners = [];
  const nativeDisconnectListeners = [];
  const reloadCalls = [];
  const tabListeners = {
    created: [],
    updated: [],
    removed: []
  };
  const tabGroupCalls = [];
  const tabGroups = new Map();
  let nextGroupId = 4242;
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
        tabGroupId: seedTab.tabGroupId ?? -1,
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
      id: "kbnaphbhjlbdmpekigjhfgogcimcpamf",
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
      onMessageExternal: {
        addListener(listener) {
          externalMessageListeners.push(listener);
        }
      },
      reload() {
        runtimeReloadCalls += 1;
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
      async query(queryInfo) {
        return [...tabs.values()]
          .filter(
            (value) =>
              queryInfo?.groupId === undefined || value.tabGroupId === queryInfo.groupId
          )
          .map((value) => ({ ...value }));
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
      async group(options) {
        const tabIds = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
        let groupId = options.groupId;
        if (groupId === undefined) {
          groupId = nextGroupId++;
          tabGroups.set(groupId, {
            id: groupId,
            title: "",
            color: undefined,
            windowId: options.createProperties?.windowId ?? 1
          });
        }
        tabGroupCalls.push({
          fn: "group",
          tabIds,
          groupId,
          created: options.groupId === undefined
        });
        for (const id of tabIds) {
          const current = tabs.get(id);
          if (!current) {
            continue;
          }
          current.tabGroupId = groupId;
          for (const listener of tabListeners.updated) {
            listener(id, { groupId }, { ...current });
          }
        }
        return groupId;
      },
      async ungroup(tabIds) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        tabGroupCalls.push({ fn: "ungroup", tabIds: ids });
        for (const id of ids) {
          const current = tabs.get(id);
          if (!current) {
            continue;
          }
          const previous = current.tabGroupId;
          current.tabGroupId = -1;
          // Chrome deletes a group when its last tab leaves.
          if (previous !== -1 && ![...tabs.values()].some((t) => t.tabGroupId === previous)) {
            tabGroups.delete(previous);
          }
          for (const listener of tabListeners.updated) {
            listener(id, { groupId: -1 }, { ...current });
          }
        }
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
          tabGroupId: -1,
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
        reloadCalls.push(tabId);
      },
      onCreated: {
        addListener(listener) {
          tabListeners.created.push(listener);
        }
      },
      onUpdated: {
        addListener(listener) {
          tabListeners.updated.push((tabId, changeInfo, tab) => {
            // Real Chrome delivers the tab's current state; a page title
            // change overrides any extension-set title, so mirror that.
            const current = tabs.get(tabId);
            if (current && tab && typeof tab === "object") {
              Object.assign(current, tab);
            }
            listener(tabId, changeInfo, tab);
          });
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
    },
    tabGroups: tabGroupsApi
      ? {
          TAB_GROUP_ID_NONE: -1,
          async query(queryInfo) {
            return [...tabGroups.values()]
              .filter(
                (group) =>
                  (!queryInfo?.title || group.title === queryInfo.title) &&
                  (queryInfo?.windowId === undefined || group.windowId === queryInfo.windowId)
              )
              .map((group) => ({ ...group }));
          },
          async update(groupId, updateProperties) {
            const group = tabGroups.get(groupId);
            if (!group) {
              throw new Error(`No such tab group: ${groupId}`);
            }
            Object.assign(group, updateProperties);
            tabGroupCalls.push({ fn: "update", groupId, ...updateProperties });
            return { ...group };
          }
        }
      : undefined,
  };
  const storage = new Map();
  if (storedBridgeSettings !== undefined) {
    storage.set("bridgeSettings", storedBridgeSettings);
  }
  if (storedTabAccessAllowlist !== undefined) {
    storage.set("tabAccessAllowlist", storedTabAccessAllowlist);
  }
  if (storedBlockedRequestsLog !== undefined) {
    storage.set("blockedRequestsLog", storedBlockedRequestsLog);
  }

  const context = vm.createContext({
    chrome,
    console,
    crypto,
    self: {
      addEventListener(type, listener) {
        (selfListeners[type] ??= []).push(listener);
      }
    },
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
    seedTabGroup(groupId, { title, windowId = 1 }) {
      tabGroups.set(groupId, { id: groupId, title, windowId });
    },
    putTabInGroup(tabId, groupId) {
      const tab = tabs.get(tabId);
      assert.ok(tab, `No such tab: ${tabId}`);
      tab.tabGroupId = groupId;
    },
    nativePort,
    postedMessages,
    storage,
    reloadCalls,
    get runtimeReloadCalls() {
      return runtimeReloadCalls;
    },
    tabGroupCalls,
    listeners: {
      runtime: runtimeListeners,
      runtimeExternal: externalMessageListeners,
      self: selfListeners,
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

test("service worker records crashes and disconnects in a persisted crash log", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 31, url: "about:blank", title: "Blank" }
  });

  const rejectionError = new Error("gate exploded");
  harness.listeners.self.unhandledrejection[0]({ reason: rejectionError });
  harness.listeners.self.unhandledrejection[0]({ reason: "string rejection" });
  harness.listeners.self.unhandledrejection[0]({ reason: { code: -32003, data: { url: "https://nu.nl" } } });
  harness.listeners.self.error[0]({
    message: "boom",
    filename: "extension/service-worker.js",
    lineno: 42,
    error: new Error("boom")
  });

  await harness.ensureNativePort();
  harness.nativePort.disconnect();

  await new Promise((resolve) => setTimeout(resolve, 0));

  const crashLog = harness.storage.get("crashLog");
  assert.equal(crashLog.length, 5);
  assert.equal(crashLog[0].type, "unhandledrejection");
  assert.equal(crashLog[0].message, "gate exploded");
  assert.match(crashLog[0].stack, /gate exploded/);
  assert.match(crashLog[0].time, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(crashLog[1].type, "unhandledrejection");
  assert.equal(crashLog[1].message, "string rejection");
  assert.equal(crashLog[1].stack, null);
  assert.equal(crashLog[2].type, "unhandledrejection");
  assert.equal(crashLog[2].message, JSON.stringify({ code: -32003, data: { url: "https://nu.nl" } }));
  assert.equal(crashLog[3].type, "error");
  assert.equal(crashLog[3].message, "boom");
  assert.equal(crashLog[3].source, "extension/service-worker.js");
  assert.equal(crashLog[3].line, 42);
  assert.match(crashLog[3].stack, /boom/);
  assert.equal(crashLog[4].type, "port-disconnect");
  assert.equal(crashLog[4].stopping, false);

  const diagnostics = await harness.handleNativeRequest({ action: "getDiagnostics" });
  assert.deepEqual(plain(diagnostics.crashLog), plain(crashLog));
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

  harness.seedTabGroup(900, { title: "gated", windowId: 1 });
  harness.seedTabGroup(902, { title: "gated", windowId: 3 });
  for (const tabId of [11, 12]) {
    harness.putTabInGroup(tabId, 900);
  }
  for (const tabId of [31, 32]) {
    harness.putTabInGroup(tabId, 902);
  }
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
      message: { type: "browser-bridge.dev-reload.v1" }
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

test("service worker reports which development reload target did not respond", async () => {
  const harness = await loadServiceWorkerHarness({
    runtimeSendMessage: async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
  });

  await assert.rejects(
    harness.handleNativeRequest({
      action: "reloadDevelopmentExtension",
      payload: { extensionId: "hacmcjjofinfaaahgdhopnnnipgjigge" }
    }),
    (error) => {
      assert.equal(error.code, -32603);
      assert.match(error.message, /Development reload target hacmcjjofinfaaahgdhopnnnipgjigge did not respond/);
      assert.match(error.message, /Receiving end does not exist/);
      return true;
    }
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

test("service worker reports a clear error for tabs without a committed URL", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 90, url: "", title: "" },
    storedTabAccessAllowlist: allowUrls("https://allowed.example")
  });

  // A freshly created tab has url "" until the navigation commits. The
  // error must say so — not claim a missing allowlist entry for "".
  await assert.rejects(
    harness.handleNativeRequest({ action: "attach", payload: { targetId: "page:90" } }),
    /no committed URL yet/
  );

  // The allowlist must not be polluted with an empty entry.
  assert.deepEqual(plain(harness.state.tabAccessAllowlist), [
    { url: "https://allowed.example", enabled: true }
  ]);
});

test("service worker blocks navigating a non-allowlisted tab to an allowlisted URL", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 62, url: "https://locked.example", title: "Locked" },
    storedTabAccessAllowlist: allowUrls("https://allowed.example"),
    debuggerSendCommand: async (debuggee, method) => {
      sentCommands.push(method);
      return {};
    }
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 62,
    targetId: harness.makePageTargetId(62),
    root: true
  });

  // The escape hatch is not allowed: neither through an existing session...
  await assert.rejects(
    harness.sendCommand({
      method: "Page.navigate",
      params: { url: "https://allowed.example/" },
      sessionId
    }),
    /Tab access blocked/
  );

  // ...nor through a bare targetId.
  await assert.rejects(
    harness.sendCommand({
      method: "Page.navigate",
      params: { url: "https://allowed.example/" },
      targetId: harness.makePageTargetId(62)
    }),
    /Tab access blocked/
  );

  assert.equal(sentCommands.length, 0);
  assert.equal(harness.currentTab.url, "https://locked.example");
});

test("service worker blocks inert enable commands on non-allowlisted tabs", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 63, url: "https://locked.example", title: "Locked" },
    storedTabAccessAllowlist: allowUrls("https://allowed.example"),
    debuggerSendCommand: async (debuggee, method) => {
      sentCommands.push(method);
      return {};
    }
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 63,
    targetId: harness.makePageTargetId(63),
    root: true
  });

  for (const method of [
    "Runtime.enable",
    "Page.enable",
    "Network.enable",
    "DOM.enable",
    "Log.enable"
  ]) {
    await assert.rejects(
      harness.sendCommand({ method, params: {}, sessionId }),
      /Tab access blocked/
    );
  }

  assert.equal(sentCommands.length, 0);
});

test("service worker blocks reads and detach on non-allowlisted tabs", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 64, url: "https://locked.example", title: "Locked" },
    storedTabAccessAllowlist: allowUrls("https://allowed.example"),
    debuggerSendCommand: async (debuggee, method) => {
      sentCommands.push(method);
      return {};
    }
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 64,
    targetId: harness.makePageTargetId(64),
    root: true
  });

  await assert.rejects(
    harness.sendCommand({
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
      sessionId
    }),
    /Tab access blocked/
  );
  await assert.rejects(
    harness.handleNativeRequest({ action: "detach", payload: { targetId: "page:64" } }),
    /Tab access blocked/
  );

  assert.equal(sentCommands.length, 0);
});

test("service worker keeps extension-held Fetch gate across agent attach/detach", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 65, url: "https://allowed.example", title: "Allowed" },
    storedTabAccessAllowlist: allowUrls("https://allowed.example")
  });
  harness.state.rootAttachments.set(65, {
    tabId: 65,
    targetId: harness.makePageTargetId(65),
    rootSessions: new Set(),
    childSessions: new Set(),
    extensionHeld: true
  });

  const attached = await harness.handleNativeRequest({
    action: "attach",
    payload: { targetId: "page:65" }
  });
  await harness.handleNativeRequest({
    action: "detach",
    payload: { sessionId: attached.sessionId }
  });

  // The debugger attachment must survive the agent cycle so the
  // extension's Fetch gate (e.g. for a spawned tab) stays active.
  assert.equal(harness.state.rootAttachments.has(65), true);
  assert.equal(harness.state.rootAttachments.get(65).extensionHeld, true);
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

test("service worker forces a gated reload for the initial load of created tabs", async () => {
  const harness = await loadServiceWorkerHarness({
    storedTabAccessAllowlist: allowUrls("https://allowed.example"),
    debuggerSendCommand: async () => ({})
  });

  const created = await harness.handleNativeRequest({
    action: "createTarget",
    payload: { url: "https://allowed.example/" }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The initial load beats the Fetch gate, so the tab must be reloaded
  // once the gate is active — and the gate must survive agent detach.
  assert.deepEqual(harness.reloadCalls, [created.tabId]);
  assert.equal(harness.state.rootAttachments.get(created.tabId)?.extensionHeld, true);
});

test("service worker does not reload transient created tabs", async () => {
  const harness = await loadServiceWorkerHarness({
    storedTabAccessAllowlist: allowUrls("about:blank"),
    debuggerSendCommand: async () => ({})
  });

  const created = await harness.handleNativeRequest({
    action: "createTarget",
    payload: { url: "about:blank" }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(typeof created.tabId, "number");
  assert.deepEqual(harness.reloadCalls, []);
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

test("service worker preserves the same URL in separate tab access groups", async () => {
  const harness = await loadServiceWorkerHarness();
  const entries = [
    { url: "https://cdn.example", enabled: false, group: "site-a" },
    { url: "https://cdn.example", enabled: true, group: "site-b" }
  ];
  const response = await new Promise((resolve) => {
    harness.listeners.runtime[0](
      { action: "set-tab-access-allowlist", entries },
      null,
      resolve
    );
  });

  assert.equal(response.ok, true);
  assert.deepEqual(plain(response.tabAccessAllowlist), entries);
  assert.deepEqual(plain(harness.storage.get("tabAccessAllowlist")), entries);
});

test("service worker preserves explicit group overrides on tab access entries", async () => {
  const harness = await loadServiceWorkerHarness({
    storedTabAccessAllowlist: [
      { url: "https://cdn.example", enabled: true, group: "app.example" },
      { url: "https://app.example", enabled: true, group: "   " },
      "https://plain.example"
    ]
  });

  const response = await new Promise((resolve) => {
    harness.listeners.runtime[0](
      {
        action: "set-tab-access-allowlist",
        entries: [
          { url: "https://cdn.example", enabled: true, group: "app.example" },
          { url: "https://app.example", enabled: true },
          { url: "https://plain.example", enabled: false }
        ]
      },
      null,
      resolve
    );
  });

  assert.equal(response.ok, true);
  assert.deepEqual(plain(response.tabAccessAllowlist), [
    { url: "https://cdn.example", enabled: true, group: "app.example" },
    { url: "https://app.example", enabled: true },
    { url: "https://plain.example", enabled: false }
  ]);
  assert.deepEqual(plain(harness.storage.get("tabAccessAllowlist")), [
    { url: "https://cdn.example", enabled: true, group: "app.example" },
    { url: "https://app.example", enabled: true },
    { url: "https://plain.example", enabled: false }
  ]);
});

test("service worker only returns gated tabs and marks inaccessible gated targets as blocked", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 51, url: "https://allowed.example", title: "Allowed", index: 0, active: true },
          { id: 52, url: "https://blocked.example", title: "Blocked", index: 1, active: false },
          { id: 53, url: "https://ungated.example", title: "Ungated", index: 2, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://allowed.example")
  });

  harness.seedTabGroup(901, { title: "gated", windowId: 1 });
  harness.putTabInGroup(51, 901);
  harness.putTabInGroup(52, 901);
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

test("service worker lets enabled blocking exceptions override wildcard allows", async () => {
  const harness = await loadServiceWorkerHarness({
    storedTabAccessAllowlist: [
      { url: "https://*.google.com", enabled: true },
      { url: "https://mail.google.com", enabled: true, effect: "deny" }
    ]
  });

  const searchTarget = await harness.handleNativeRequest({
    action: "createTarget",
    payload: { url: "https://www.google.com/search?q=hello" }
  });
  assert.equal(typeof searchTarget.tabId, "number");
  await assert.rejects(
    harness.handleNativeRequest({
      action: "createTarget",
      payload: { url: "https://mail.google.com/mail/u/0/" }
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
  emitPaused({ requestId: "r1", resourceType: "Script", request: { url: "https://app.example/data.js" } });
  emitPaused({ requestId: "r2", resourceType: "XHR", request: { url: "https://other.example/secret" } });
  emitPaused({ requestId: "r3", resourceType: "Document", request: { url: "https://other.example/page" } });
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

test("service worker shows an in-page banner when subresources are blocked", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 74, url: "https://app.example", title: "App" },
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async (debuggee, method, params) => {
      sentCommands.push({ debuggee, method, params });
      return {};
    }
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 74,
    targetId: harness.makePageTargetId(74),
    root: true
  });
  await harness.sendCommand({
    method: "Runtime.evaluate",
    params: { expression: "1" },
    sessionId
  });

  const emitPaused = (source, params) =>
    harness.listeners.debuggerEvent[0](source, "Fetch.requestPaused", params);
  emitPaused({ tabId: 74 }, { requestId: "r1", resourceType: "Script", request: { url: "https://cdn.example/app.js" } });
  // A blocked document has no live page to render a banner into.
  emitPaused({ tabId: 74 }, { requestId: "r2", resourceType: "Document", request: { url: "https://other.example/page" } });
  // Subresources blocked in an iframe session still banner on the top page.
  emitPaused({ tabId: 74, sessionId: "iframe-session" }, { requestId: "r3", resourceType: "Image", request: { url: "https://ads.example/tracker.png" } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const bannerCommands = sentCommands.filter(
    ({ method, params }) =>
      method === "Runtime.evaluate" &&
      /browser-bridge-blocked-subresources/.test(params?.expression ?? "")
  );
  assert.equal(bannerCommands.length, 2);
  for (const { debuggee } of bannerCommands) {
    // Targeted at the top page, never at the paused iframe session.
    assert.deepEqual(plain(debuggee), { tabId: 74 });
  }
  const expressions = bannerCommands.map(({ params }) => params.expression);
  assert.ok(expressions.some((expression) => /cdn\.example\/app\.js/.test(expression) && /Script/.test(expression)));
  assert.ok(expressions.some((expression) => /ads\.example\/tracker\.png/.test(expression) && /Image/.test(expression)));
  for (const expression of expressions) {
    assert.doesNotMatch(expression, /other\.example\/page/);
  }
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
  emitPaused({ requestId: "r1", resourceType: "Document", request: { url: "https://app.example/redirect" } });
  emitPaused({
    requestId: "r1",
    resourceType: "Document",
    response: { status: 302 },
    request: { url: "https://other.example/taken" }
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

test("service worker records blocked requests for the popup and persists them", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 81, url: "https://app.example", title: "App" },
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async (debuggee, method, params) => {
      sentCommands.push({ method, params });
      return {};
    }
  });
  const sessionId = "root-session";
  harness.state.sessions.set(sessionId, {
    tabId: 81,
    targetId: harness.makePageTargetId(81),
    root: true
  });
  await harness.sendCommand({
    method: "Runtime.evaluate",
    params: { expression: "1" },
    sessionId
  });

  const emitPaused = (params) =>
    harness.listeners.debuggerEvent[0]({ tabId: 81 }, "Fetch.requestPaused", params);
  emitPaused({ requestId: "r1", resourceType: "Script", request: { url: "https://app.example/data.js" } });
  emitPaused({ requestId: "r2", resourceType: "Image", request: { url: "https://cdn.example/img.svg" } });
  emitPaused({ requestId: "r3", resourceType: "Image", request: { url: "https://cdn.example/img.svg" } });
  emitPaused({ requestId: "r4", resourceType: "Script", request: { url: "https://widget.example/js" } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Allowed requests are not recorded; duplicates collapse into one entry.
  assert.deepEqual(
    plain(harness.state.blockedRequests).map(({ url, resourceType, tabId, count }) => ({
      url,
      resourceType,
      tabId,
      count
    })),
    [
      { url: "https://widget.example/js", resourceType: "Script", tabId: 81, count: 1 },
      { url: "https://cdn.example/img.svg", resourceType: "Image", tabId: 81, count: 2 }
    ]
  );
  assert.deepEqual(
    plain(harness.storage.get("blockedRequestsLog")).map(({ url }) => url),
    ["https://widget.example/js", "https://cdn.example/img.svg"]
  );

  // The log is exposed through diagnostics for the popup.
  const popupState = await new Promise((resolve) => {
    harness.listeners.runtime[0]({ action: "get-popup-state" }, null, resolve);
  });
  assert.deepEqual(
    plain(popupState.state.blockedRequests).map(({ url }) => url),
    ["https://widget.example/js", "https://cdn.example/img.svg"]
  );

  const dismissed = await new Promise((resolve) => {
    harness.listeners.runtime[0](
      { action: "dismiss-blocked-request", url: "https://widget.example/js" },
      null,
      resolve
    );
  });
  assert.equal(dismissed.ok, true);
  assert.deepEqual(
    plain(dismissed.blockedRequests).map(({ url }) => url),
    ["https://cdn.example/img.svg"]
  );

  const cleared = await new Promise((resolve) => {
    harness.listeners.runtime[0]({ action: "clear-blocked-requests" }, null, resolve);
  });
  assert.equal(cleared.ok, true);
  assert.deepEqual(plain(cleared.blockedRequests), []);
  assert.deepEqual(plain(harness.storage.get("blockedRequestsLog")), []);
});

test("service worker restores the blocked requests log from storage", async () => {
  const stored = [
    { url: "https://cdn.example/img.svg", resourceType: "Image", tabId: 5, time: "2026-01-01T00:00:00.000Z", count: 3 }
  ];
  const harness = await loadServiceWorkerHarness({
    storedBlockedRequestsLog: stored
  });
  assert.deepEqual(plain(harness.state.blockedRequests), stored);
});


test("service worker gates network of tabs spawned from agent tabs", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 96, url: "https://app.example", title: "App" },
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async (debuggee, method, params) => {
      sentCommands.push({ method, params });
      return {};
    }
  });
  harness.state.sessions.set("root-session-96", {
    tabId: 96,
    targetId: harness.makePageTargetId(96),
    root: true
  });

  harness.listeners.tabs.created[0]({ id: 97, openerTabId: 96, url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.state.spawnedTabs.has(97), true);
  assert.ok(sentCommands.some(({ method }) => method === "Fetch.enable"));
});

test("service worker does not gate tabs spawned by non-agent tabs", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tab: { id: 98, url: "https://app.example", title: "App" },
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async (debuggee, method) => {
      sentCommands.push({ method });
      return {};
    }
  });

  harness.listeners.tabs.created[0]({ id: 99, openerTabId: 55, url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.state.spawnedTabs.has(99), false);
  assert.ok(!sentCommands.some(({ method }) => method === "Fetch.enable"));
});

test("service worker gates cross-origin spawned tabs whose openerTabId arrives at onUpdated", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 106, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 107, url: "about:blank", title: "", index: 1, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async (debuggee, method) => {
      sentCommands.push({ method });
      return {};
    }
  });
  harness.state.sessions.set("root-session-106", {
    tabId: 106,
    targetId: harness.makePageTargetId(106),
    root: true
  });

  // Cross-origin window.open: openerTabId is absent at creation time.
  harness.listeners.tabs.created[0]({ id: 107, url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.state.spawnedTabs.has(107), false);

  // The opener relationship is established on a later update, and the
  // disallowed URL has already committed.
  harness.listeners.tabs.updated[0](
    107,
    { url: "https://blocked.example/x", status: "complete" },
    { id: 107, url: "https://blocked.example/x", title: "", openerTabId: 106 }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.state.spawnedTabs.has(107), true);
  assert.ok(sentCommands.some(({ method }) => method === "Fetch.enable"));
  assert.deepEqual(harness.reloadCalls, [107]);
});

test("service worker reloads spawned tabs that beat the gate to a disallowed URL", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 100, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 101, url: "about:blank", title: "", index: 1, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async (debuggee, method) => {
      sentCommands.push({ method });
      return {};
    }
  });
  harness.state.sessions.set("root-session-100", {
    tabId: 100,
    targetId: harness.makePageTargetId(100),
    root: true
  });

  harness.listeners.tabs.created[0]({ id: 101, openerTabId: 100, url: "about:blank" });
  // Simulate the document load beating the gate: URL lands before attach finished.
  harness.state.rootAttachments.delete(101);
  harness.listeners.tabs.updated[0](
    101,
    { url: "https://blocked.example/x" },
    { id: 101, url: "https://blocked.example/x", title: "" }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(sentCommands.some(({ method }) => method === "Fetch.enable"));
  assert.deepEqual(harness.reloadCalls, [101]);
});

test("service worker reloads spawned tabs even when the debugger attached before the disallowed URL committed", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 102, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 103, url: "about:blank", title: "", index: 1, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async () => ({})
  });
  harness.state.sessions.set("root-session-102", {
    tabId: 102,
    targetId: harness.makePageTargetId(102),
    root: true
  });
  harness.state.spawnedTabs.set(103, true);
  // Attach completed (and Fetch.enable was sent) before the URL-change
  // event arrived — but the in-flight document request was issued before
  // Fetch.enable took effect, so the page is fully loaded. Attach state
  // cannot prove the load was gated; the tab must be reloaded.
  harness.state.rootAttachments.set(103, {
    tabId: 103,
    targetId: harness.makePageTargetId(103),
    rootSessions: new Set(),
    childSessions: new Set()
  });

  harness.listeners.tabs.updated[0](
    103,
    { url: "https://blocked.example/x" },
    { id: 103, url: "https://blocked.example/x", title: "" }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(harness.reloadCalls, [103]);
});

test("service worker does not reload a spawned tab twice for the same disallowed URL", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 104, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 105, url: "about:blank", title: "", index: 1, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async () => ({})
  });
  harness.state.sessions.set("root-session-104", {
    tabId: 104,
    targetId: harness.makePageTargetId(104),
    root: true
  });
  harness.state.spawnedTabs.set(105, true);

  const changeInfo = { url: "https://blocked.example/x" };
  const tab = { id: 105, url: "https://blocked.example/x", title: "" };
  harness.listeners.tabs.updated[0](105, changeInfo, tab);
  await new Promise((resolve) => setTimeout(resolve, 20));
  harness.listeners.tabs.updated[0](105, changeInfo, tab);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(harness.reloadCalls, [105]);
});

test("popup ungate-tab releases an extension-held spawned tab from the gate", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 130, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 131, url: "https://blocked.example/x", title: "Blocked", index: 1, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async () => ({})
  });
  harness.state.sessions.set("root-session-130", {
    tabId: 130,
    targetId: harness.makePageTargetId(130),
    root: true
  });

  harness.listeners.tabs.created[0]({ id: 131, openerTabId: 130, url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.state.rootAttachments.has(131), true);
  assert.equal(harness.state.spawnedTabs.has(131), true);

  const response = await new Promise((resolve) => {
    harness.listeners.runtime[0]({ action: "ungate-tab", tabId: 131 }, null, resolve);
  });
  assert.equal(response.ok, true);
  assert.equal(response.ungated, true);
  assert.equal(harness.state.rootAttachments.has(131), false);
  assert.equal(harness.state.spawnedTabs.has(131), false);
  assert.equal(harness.state.lastError, null);
  assert.equal(harness.state.attachLog[0]?.reason, "ungate");

  // A later disallowed navigation must not re-gate the released tab.
  harness.listeners.tabs.updated[0](
    131,
    { url: "https://blocked.example/y" },
    { id: 131, url: "https://blocked.example/y", title: "" }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.state.rootAttachments.has(131), false);
  assert.deepEqual(harness.reloadCalls, []);
});

test("popup ungate-tab rejects tabs that are not gated", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 140, url: "https://app.example", title: "App" },
    storedTabAccessAllowlist: allowUrls("https://app.example")
  });
  const response = await new Promise((resolve) => {
    harness.listeners.runtime[0]({ action: "ungate-tab", tabId: 140 }, null, resolve);
  });
  assert.equal(response.ok, false);
  assert.match(response.error.message, /not gated/);
});

test("ungroupable gated tabs fall back to the gated favicon and ungate restores it", async () => {
  const sentCommands = [];
  const harness = await loadServiceWorkerHarness({
    tabGroupsApi: false,
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 150, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 151, url: "about:blank", title: "", index: 1, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async (debuggee, method, params) => {
      sentCommands.push({ method, params });
      return {};
    }
  });
  // A syntax error in an injected script is silently swallowed by
  // Runtime.evaluate; compile both scripts to catch that here.
  new vm.Script(harness.GATED_FAVICON_INSTALL_SCRIPT);
  new vm.Script(harness.GATED_FAVICON_RESTORE_SCRIPT);
  harness.state.sessions.set("root-session-150", {
    tabId: 150,
    targetId: harness.makePageTargetId(150),
    root: true
  });

  harness.listeners.tabs.created[0]({ id: 151, openerTabId: 150, url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Registered for every future document of the gated tab...
  const installs = sentCommands.filter(
    ({ method, params }) =>
      method === "Page.addScriptToEvaluateOnNewDocument" &&
      typeof params?.source === "string" &&
      params.source.includes("data-browser-bridge-gated-icon")
  );
  assert.ok(installs.length >= 1, "install script registered for new documents");
  // ...and injected into the current document.
  const isInstallScript = (value) =>
    typeof value === "string" && value.includes("data-browser-bridge-gated-icon") && value.includes("MutationObserver");
  const currentDocEvals = sentCommands.filter(
    ({ method, params }) => method === "Runtime.evaluate" && isInstallScript(params?.expression)
  );
  assert.ok(currentDocEvals.length >= 1, "install script evaluated in current document");

  // A document that commits after the attach (agent-created tab) must also
  // get the install script.
  const evalCountBefore = sentCommands.filter(
    ({ method, params }) => method === "Runtime.evaluate" && isInstallScript(params?.expression)
  ).length;
  harness.listeners.tabs.updated[0](
    151,
    { url: "https://blocked.example/x" },
    { id: 151, url: "https://blocked.example/x", title: "" }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const evalCountAfter = sentCommands.filter(
    ({ method, params }) => method === "Runtime.evaluate" && isInstallScript(params?.expression)
  ).length;
  assert.ok(evalCountAfter > evalCountBefore, "install script re-evaluated on committed navigation");

  const response = await new Promise((resolve) => {
    harness.listeners.runtime[0]({ action: "ungate-tab", tabId: 151 }, null, resolve);
  });
  assert.equal(response.ok, true);
  // Ungate restores the original icon while the debugger is still attached.
  const restores = sentCommands.filter(
    ({ method, params }) =>
      method === "Runtime.evaluate" &&
      typeof params?.expression === "string" &&
      params.expression.includes("delete window.__browserBridgeGatedIcon")
  );
  assert.ok(restores.length >= 1, "restore script evaluated on ungate");
});

test("concurrent ensureNativePort calls share one native port connection", async () => {
  const harness = await loadServiceWorkerHarness();
  const [first, second] = await Promise.all([
    harness.ensureNativePort(),
    harness.ensureNativePort()
  ]);
  assert.equal(first, second);
  const hellos = harness.postedMessages.filter((message) => message.type === "hello");
  assert.equal(hellos.length, 1);
});

test("turning YOLO off creates one gated group and reapplies the allowlist", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [{
      id: 1,
      focused: true,
      type: "normal",
      tabs: [
        { id: 150, url: "https://blocked.example/a", title: "Blocked A", index: 0, active: true, tabGroupId: 500 },
        { id: 151, url: "https://app.example", title: "Allowed", index: 1, active: false, tabGroupId: 500 },
        { id: 152, url: "https://blocked.example/b", title: "Blocked B", index: 2, active: false, tabGroupId: 500 }
      ]
    }],
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async () => ({})
  });
  harness.seedTabGroup(500, { title: "YOLO", windowId: 1 });
  harness.state.yoloModeEnabled = true;
  for (const tabId of [150, 151, 152]) {
    harness.state.rootAttachments.set(tabId, { tabId, extensionHeld: true });
  }

  const response = await new Promise((resolve) => {
    harness.listeners.runtime[0]({ action: "set-yolo-mode", enabled: false }, null, resolve);
  });

  assert.equal(response.ok, true);
  const created = harness.tabGroupCalls.filter((call) => call.fn === "group" && call.created);
  assert.equal(created.length, 1, "all tabs reuse a single new gated group");
  const gatedGroup = harness.tabGroupCalls.find(
    (call) => call.fn === "update" && call.title === "gated"
  );
  assert.ok(gatedGroup);
  assert.deepEqual(harness.reloadCalls.sort(), [150, 152]);
  for (const tab of harness.tabs.values()) {
    assert.notEqual(tab.tabGroupId, 500, "no tab remains in the YOLO group");
  }
});

test("gated tabs are grouped in the 'gated' group and leaving the group ungates them", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 160, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 161, url: "about:blank", title: "", index: 1, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async () => ({})
  });
  harness.state.sessions.set("root-session-160", {
    tabId: 160,
    targetId: harness.makePageTargetId(160),
    root: true
  });

  harness.listeners.tabs.created[0]({ id: 161, openerTabId: 160, url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const groupCall = harness.tabGroupCalls.find(
    (call) => call.fn === "group" && call.tabIds.includes(161)
  );
  assert.ok(groupCall, "gated group created with the spawned tab");
  const groupId = groupCall.groupId;
  const styleCall = harness.tabGroupCalls.find(
    (call) => call.fn === "update" && call.groupId === groupId
  );
  assert.equal(styleCall?.title, "gated");
  assert.equal(styleCall?.color, "red");

  // The user drags the tab out of the group: Chrome fires tabs.onUpdated
  // with the new groupId and the tab must be ungated automatically.
  const draggedTab = { ...harness.tabs.get(161), tabGroupId: -1 };
  for (const listener of harness.listeners.tabs.updated) {
    listener(161, { groupId: -1 }, draggedTab);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.state.rootAttachments.has(161), false);
  assert.equal(harness.state.spawnedTabs.has(161), false);
  assert.equal(harness.state.attachLog[0]?.reason, "ungate");
});

test("gating a tab in a user group moves it to the 'gated' group", async () => {
  const harness = await loadServiceWorkerHarness({
    tab: { id: 170, url: "https://app.example", title: "App", tabGroupId: 7 },
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async () => ({})
  });

  const attached = await harness.handleNativeRequest({ action: "attach", payload: { targetId: "page:170" } });
  // The debugger attaches lazily on the first command.
  await harness.handleNativeRequest({
    action: "sendCommand",
    payload: { sessionId: attached.sessionId, method: "Page.enable", params: {} }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const groupCall = harness.tabGroupCalls.find(
    (call) => call.fn === "group" && call.tabIds.includes(170)
  );
  assert.ok(groupCall, "tab moved from the user group to the gated group");
  const styleCall = harness.tabGroupCalls.find(
    (call) => call.fn === "update" && call.groupId === groupCall.groupId
  );
  assert.equal(styleCall?.title, "gated");
});

test("moving an ungated tab into the 'gated' group gates it", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 180, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 181, url: "about:blank", title: "", index: 1, active: false },
          { id: 182, url: "https://app.example", title: "Other", index: 2, active: false }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async () => ({})
  });
  harness.state.sessions.set("root-session-180", {
    tabId: 180,
    targetId: harness.makePageTargetId(180),
    root: true
  });

  // Gate a spawned tab so the "gated" group exists.
  harness.listeners.tabs.created[0]({ id: 181, openerTabId: 180, url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const groupCall = harness.tabGroupCalls.find(
    (call) => call.fn === "group" && call.tabIds.includes(181)
  );
  assert.ok(groupCall, "gated group created");

  // The user drags the ungated tab into the group: it must be gated
  // (extension-held, like a spawned tab).
  const draggedTab = { ...harness.tabs.get(182), tabGroupId: groupCall.groupId };
  for (const listener of harness.listeners.tabs.updated) {
    listener(182, { groupId: groupCall.groupId }, draggedTab);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.state.rootAttachments.has(182), true);
  assert.equal(harness.state.rootAttachments.get(182).extensionHeld, true);
  assert.equal(harness.state.attachLog[0]?.reason, "group-gate");
  // The tab is on an allowlisted URL: no police reload.
  assert.deepEqual(harness.reloadCalls, []);
});

test("service worker re-gates tabs in the 'gated' group after a restart", async () => {
  const harness = await loadServiceWorkerHarness({
    windows: [
      {
        id: 1,
        focused: true,
        type: "normal",
        tabs: [
          { id: 190, url: "https://app.example", title: "App", index: 0, active: true },
          { id: 191, url: "https://blocked.example/x", title: "Blocked", index: 1, active: false, tabGroupId: 4242 }
        ]
      }
    ],
    storedTabAccessAllowlist: allowUrls("https://app.example"),
    debuggerSendCommand: async () => ({})
  });
  // The group survived the restart; the debugger attachment did not.
  harness.seedTabGroup(4242, { title: "gated", windowId: 1 });
  await harness.restoreGatedGroupTabs();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.state.rootAttachments.has(191), true);
  assert.equal(harness.state.rootAttachments.get(191).extensionHeld, true);
  assert.equal(harness.state.attachLog[0]?.reason, "group-restore");
  assert.equal(harness.state.rootAttachments.has(190), false);
  // The disallowed document is reloaded so the Fetch gate blocks it.
  assert.deepEqual(harness.reloadCalls, [191]);
});

test("service worker reloads itself on its own development reload message", async () => {
  const harness = await loadServiceWorkerHarness();
  const response = await new Promise((resolve) => {
    harness.listeners.runtimeExternal[0](
      { type: "browser-bridge.dev-reload.v1" },
      { id: "kbnaphbhjlbdmpekigjhfgogcimcpamf" },
      resolve
    );
  });
  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(response), ["ok"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(harness.runtimeReloadCalls, 1);
});

test("service worker rejects development reload messages from other senders or types", async () => {
  const harness = await loadServiceWorkerHarness();
  const handler = harness.listeners.runtimeExternal[0];
  const unauthorized = await new Promise((resolve) => {
    handler(
      { type: "browser-bridge.dev-reload.v1" },
      { id: "hacmcjjofinfaaahgdhopnnnipgjigge" },
      resolve
    );
  });
  assert.equal(unauthorized.ok, false);
  handler({ type: "something-else" }, { id: "kbnaphbhjlbdmpekigjhfgogcimcpamf" }, () => {});
  assert.equal(harness.runtimeReloadCalls, 0);
});

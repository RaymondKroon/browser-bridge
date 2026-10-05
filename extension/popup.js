let currentReloadToken = null;
let reloadRequiresToken = false;
let currentReloadEndpoint = null;
let currentAllowedIds = [];
let currentTabAccess = [];
let currentBlockedRequests = [];
const TAB_ACCESS_GROUP_COLLAPSE_KEY = "tabAccessGroupCollapse";
let tabAccessGroupCollapse = {};
const TAB_ACCESS_GROUP_NAMES_KEY = "tabAccessGroupNames";
let tabAccessGroupNames = {};
const TAB_ACCESS_GROUP_ORDER_KEY = "tabAccessGroupOrder";
let tabAccessGroupOrder = [];
const TAB_ACCESS_ENTRY_DRAG_TYPE = "application/x-browser-bridge-tab-access-entry";
const TAB_ACCESS_GROUP_DRAG_TYPE = "application/x-browser-bridge-tab-access-group";

async function send(action, extra = {}) {
  return chrome.runtime.sendMessage({ action, ...extra });
}

function updatePortInput(settings) {
  const portInput = document.getElementById("bridge-port");
  portInput.value = `${settings?.port ?? 9222}`;
}

function copyReloadCurl(extensionId) {
  const authHeader = reloadRequiresToken ? ` -H 'Authorization: Bearer ${currentReloadToken}'` : "";
  const curl = `curl --fail-with-body -X POST '${currentReloadEndpoint}' -H 'Content-Type: application/json'${authHeader} --data '{"extensionId":"${extensionId}"}'`;
  return navigator.clipboard.writeText(curl);
}

async function persistAllowedIds(ids) {
  const response = await send("set-development-reload-allowed-ids", { extensionIds: ids });
  if (!response.ok) {
    throw new Error(response.error?.message ?? "Could not save allowed extension IDs");
  }
  updateAllowedIds(response.allowedExtensionIds);
}

function updateAllowedIds(ids) {
  currentAllowedIds = ids ?? [];
  const list = document.getElementById("reload-allowed-id-list");
  list.replaceChildren();
  currentAllowedIds.forEach((extensionId, index) => {
    const row = document.createElement("div");
    row.className = "reload-id-row";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 32;
    input.spellcheck = false;
    input.value = extensionId;
    input.addEventListener("change", () => {
      const next = [...currentAllowedIds];
      next[index] = input.value.trim();
      void persistAllowedIds(next);
    });
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "secondary small-button";
    copyButton.textContent = "curl";
    copyButton.disabled = !currentReloadEndpoint || (reloadRequiresToken && !currentReloadToken);
    copyButton.addEventListener("click", () => void copyReloadCurl(extensionId));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "secondary small-button";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => void persistAllowedIds(currentAllowedIds.filter((_, item) => item !== index)));
    row.append(input, copyButton, deleteButton);
    list.append(row);
  });
}

async function persistTabAccess(entries) {
  const response = await send("set-tab-access-allowlist", { entries });
  if (!response.ok) {
    throw new Error(response.error?.message ?? "Could not save tab access allowlist");
  }
  updateTabAccess(response.tabAccessAllowlist);
}

function tabAccessGroupKey(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const host = parsed.hostname.replace(/^\*\./, "").toLowerCase();
      const labels = host.split(".").filter(Boolean);
      const isIp = host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
      if (isIp) {
        return host;
      }
      if (labels.length >= 2) {
        return labels.slice(-2).join(".");
      }
      if (labels.length === 1) {
        return host; // localhost or bare host
      }
    }
  } catch {
    // Unparseable URL; falls through to the "Other" group.
  }
  return "other";
}

function tabAccessGroupLabel(key) {
  const custom = tabAccessGroupNames[key];
  if (typeof custom === "string" && custom.length > 0) {
    return custom;
  }
  return key === "other" ? "Other" : key;
}

function beginGroupRename(key, label) {
  if (label.querySelector("input")) {
    return;
  }
  label.replaceChildren();
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-access-group-rename";
  input.spellcheck = false;
  input.value = tabAccessGroupLabel(key);
  label.append(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) {
      return;
    }
    done = true;
    if (save) {
      const value = input.value.trim();
      const defaultLabel = key === "other" ? "Other" : key;
      if (value && value !== defaultLabel) {
        tabAccessGroupNames[key] = value;
      } else {
        delete tabAccessGroupNames[key];
      }
      void chrome.storage.local.set({ [TAB_ACCESS_GROUP_NAMES_KEY]: tabAccessGroupNames });
    }
    updateTabAccess(currentTabAccess);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(true);
    } else if (event.key === "Escape") {
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
}

function buildNewTabAccessRow(groupKey) {
  const row = document.createElement("div");
  row.className = "tab-access-row tab-access-row-new";
  const placeholder = document.createElement("span");
  placeholder.className = "tab-access-drag-handle";
  placeholder.textContent = "\u00A0";
  const input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = "https://\u2026";
  let done = false;
  const commit = (save) => {
    if (done) {
      return;
    }
    done = true;
    const url = input.value.trim();
    if (save && url) {
      const entry = { url, enabled: true };
      if (groupKey !== tabAccessGroupKey(url)) {
        entry.group = groupKey;
      }
      void persistTabAccess([...currentTabAccess, entry]);
    } else {
      row.remove();
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(true);
    } else if (event.key === "Escape") {
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
  row.append(placeholder, input);
  return row;
}

function buildTabAccessRow(entry, index) {
  const row = document.createElement("div");
  row.className = "tab-access-row";
  const handle = document.createElement("span");
  handle.className = "tab-access-drag-handle";
  handle.textContent = "\u2807";
  handle.draggable = true;
  const moved = entry.group !== undefined && entry.group !== tabAccessGroupKey(entry.url);
  handle.title = moved
    ? `Pinned to ${entry.group} (derived: ${tabAccessGroupKey(entry.url)}). Drag to move to another group.`
    : "Drag to move to another group";
  handle.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", String(index));
    event.dataTransfer.setData(TAB_ACCESS_ENTRY_DRAG_TYPE, String(index));
    event.dataTransfer.effectAllowed = "move";
  });
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = entry.enabled;
  checkbox.title = entry.enabled
    ? (entry.effect === "deny" ? "Exception active (blocks matching URLs)" : "Allowed")
    : "Rule disabled";
  checkbox.addEventListener("change", () => {
    const next = [...currentTabAccess];
    next[index] = { ...next[index], enabled: checkbox.checked };
    void persistTabAccess(next);
  });
  const effectButton = document.createElement("button");
  effectButton.type = "button";
  effectButton.className = `tab-access-effect small-button ${entry.effect === "deny" ? "tab-access-effect-block" : "tab-access-effect-allow"}`;
  effectButton.textContent = entry.effect === "deny" ? "Block" : "Allow";
  effectButton.title = entry.effect === "deny"
    ? "This rule is an exception that blocks matching URLs; click to allow instead"
    : "This rule allows matching URLs; click to make it a blocking exception";
  effectButton.addEventListener("click", () => {
    const next = [...currentTabAccess];
    const updated = { ...next[index] };
    if (updated.effect === "deny") {
      delete updated.effect;
    } else {
      updated.effect = "deny";
    }
    next[index] = updated;
    void persistTabAccess(next);
  });
  const input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;
  input.value = entry.url;
  input.addEventListener("change", () => {
    const next = [...currentTabAccess];
    next[index] = { ...next[index], url: input.value.trim() };
    void persistTabAccess(next);
  });
  row.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes(TAB_ACCESS_ENTRY_DRAG_TYPE)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    row.classList.add("tab-access-row-dropping");
  });
  row.addEventListener("dragleave", () => row.classList.remove("tab-access-row-dropping"));
  row.addEventListener("drop", (event) => {
    if (!event.dataTransfer.types.includes(TAB_ACCESS_ENTRY_DRAG_TYPE)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    row.classList.remove("tab-access-row-dropping");
    const sourceIndex = Number(event.dataTransfer.getData(TAB_ACCESS_ENTRY_DRAG_TYPE));
    reorderTabAccessEntries(sourceIndex, index);
  });
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "secondary small-button";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", () => void persistTabAccess(currentTabAccess.filter((_, item) => item !== index)));
  row.append(handle, checkbox, effectButton, input, deleteButton);
  return row;
}

function updateTabAccess(entries) {
  currentTabAccess = entries ?? [];
  const list = document.getElementById("tab-access-list");
  list.replaceChildren();
  if (currentTabAccess.length === 0) {
    const empty = document.createElement("span");
    empty.className = "tab-access-empty";
    empty.textContent = "No URLs allowed. Blocked URLs are added here automatically (off).";
    list.append(empty);
    return;
  }

  const groups = new Map();
  currentTabAccess.forEach((entry, index) => {
    const key = entry.group ?? tabAccessGroupKey(entry.url);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push({ entry, index });
  });

  const compareGroupKeys = (a, b) => {
    const aIndex = tabAccessGroupOrder.indexOf(a);
    const bIndex = tabAccessGroupOrder.indexOf(b);
    if (aIndex !== -1 || bIndex !== -1) {
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return a.localeCompare(b);
  };
  [...groups.entries()]
    .sort((a, b) => compareGroupKeys(a[0], b[0]))
    .forEach(([key, members]) => {
      const collapsed = tabAccessGroupCollapse[key] === true;
      const group = document.createElement("div");
      group.className = "tab-access-group";

      const header = document.createElement("div");
      header.className = "tab-access-group-header";
      const groupDragHandle = document.createElement("span");
      groupDragHandle.className = "tab-access-group-drag-handle";
      groupDragHandle.textContent = "\u2807";
      groupDragHandle.draggable = true;
      groupDragHandle.title = "Drag to reorder groups";
      groupDragHandle.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData(TAB_ACCESS_GROUP_DRAG_TYPE, key);
        event.dataTransfer.effectAllowed = "move";
      });

      const groupCheckbox = document.createElement("input");
      groupCheckbox.type = "checkbox";
      const enabledCount = members.filter(({ entry }) => entry.enabled).length;
      groupCheckbox.checked = enabledCount === members.length;
      groupCheckbox.indeterminate = enabledCount > 0 && enabledCount < members.length;
      groupCheckbox.title = enabledCount === members.length
        ? "All allowed (toggle to block all)"
        : `Allowed: ${enabledCount}/${members.length} (toggle to allow all)`;
      groupCheckbox.addEventListener("change", () => {
        const next = [...currentTabAccess];
        for (const { index } of members) {
          next[index] = { ...next[index], enabled: groupCheckbox.checked };
        }
        void persistTabAccess(next);
      });

      const label = document.createElement("span");
      label.className = "tab-access-group-label";
      label.textContent = tabAccessGroupLabel(key);
      label.title = collapsed ? "Click to expand group" : "Click to collapse group";
      label.addEventListener("click", () => {
        if (label.querySelector("input")) {
          return; // rename in progress
        }
        setCollapsed(tabAccessGroupCollapse[key] !== true);
      });

      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.className = "tab-access-rename";
      renameButton.textContent = "\u270E";
      renameButton.title = "Rename group";
      renameButton.addEventListener("click", () => beginGroupRename(key, label));

      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "tab-access-add";
      addButton.textContent = "+";
      addButton.title = `Add URL to ${tabAccessGroupLabel(key)}`;

      const dependenciesButton = document.createElement("button");
      dependenciesButton.type = "button";
      dependenciesButton.className = "tab-access-dependencies";
      dependenciesButton.textContent = "Deps";
      dependenciesButton.title = `Add all dependencies of ${members[0]?.entry.url ?? "the first entry"}`;
      dependenciesButton.addEventListener("click", () => {
        void addGroupDependencyOrigins(key, members, dependenciesButton);
      });

      const collapseButton = document.createElement("button");
      collapseButton.type = "button";
      collapseButton.className = "tab-access-collapse";
      collapseButton.textContent = collapsed ? "+" : "\u2212";
      collapseButton.title = collapsed ? "Expand group" : "Collapse group";

      const body = document.createElement("div");
      body.className = "tab-access-group-body";
      body.hidden = collapsed;
      members.forEach(({ entry, index }) => body.append(buildTabAccessRow(entry, index)));

      const setCollapsed = (isCollapsed) => {
        tabAccessGroupCollapse[key] = isCollapsed;
        void chrome.storage.local.set({ [TAB_ACCESS_GROUP_COLLAPSE_KEY]: tabAccessGroupCollapse });
        body.hidden = isCollapsed;
        collapseButton.textContent = isCollapsed ? "+" : "\u2212";
        collapseButton.title = isCollapsed ? "Expand group" : "Collapse group";
        label.title = isCollapsed ? "Click to expand group" : "Click to collapse group";
      };
      collapseButton.addEventListener("click", () => {
        setCollapsed(tabAccessGroupCollapse[key] !== true);
      });
      addButton.addEventListener("click", () => {
        if (body.hidden) {
          setCollapsed(false);
        }
        const newRow = buildNewTabAccessRow(key);
        body.append(newRow);
        newRow.querySelector("input").focus();
      });

      group.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        group.classList.add("tab-access-group-dropping");
      });
      group.addEventListener("dragleave", () => {
        group.classList.remove("tab-access-group-dropping");
      });
      group.addEventListener("drop", (event) => {
        event.preventDefault();
        group.classList.remove("tab-access-group-dropping");
        const draggedGroupKey = event.dataTransfer.getData(TAB_ACCESS_GROUP_DRAG_TYPE);
        if (draggedGroupKey) {
          reorderTabAccessGroups(draggedGroupKey, key, compareGroupKeys);
          return;
        }
        const index = Number(event.dataTransfer.getData("text/plain"));
        if (!Number.isInteger(index) || index < 0 || index >= currentTabAccess.length) {
          return;
        }
        const derived = tabAccessGroupKey(currentTabAccess[index].url);
        const target = key === derived ? undefined : key;
        if ((currentTabAccess[index].group ?? undefined) === target) {
          return;
        }
        const next = [...currentTabAccess];
        next[index] = { ...next[index], group: target };
        void persistTabAccess(next);
      });

      header.append(groupDragHandle, collapseButton, groupCheckbox, label, dependenciesButton, addButton, renameButton);
      group.append(header, body);
      list.append(group);
    });
}

function reorderTabAccessEntries(sourceIndex, targetIndex) {
  if (
    !Number.isInteger(sourceIndex) ||
    !Number.isInteger(targetIndex) ||
    sourceIndex < 0 ||
    targetIndex < 0 ||
    sourceIndex >= currentTabAccess.length ||
    targetIndex >= currentTabAccess.length
  ) {
    return;
  }
  const groupKey = currentTabAccess[targetIndex].group ?? tabAccessGroupKey(currentTabAccess[targetIndex].url);
  const indices = currentTabAccess
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => (entry.group ?? tabAccessGroupKey(entry.url)) === groupKey)
    .map(({ index }) => index);
  const sourcePosition = indices.indexOf(sourceIndex);
  const targetPosition = indices.indexOf(targetIndex);
  if (sourcePosition === -1 || targetPosition === -1 || sourcePosition === targetPosition) {
    return;
  }
  const reordered = indices.map((index) => currentTabAccess[index]);
  reordered.splice(targetPosition, 0, reordered.splice(sourcePosition, 1)[0]);
  const next = [...currentTabAccess];
  indices.forEach((index, position) => {
    next[index] = reordered[position];
  });
  void persistTabAccess(next);
}

function reorderTabAccessGroups(sourceKey, targetKey, compareGroupKeys) {
  if (sourceKey === targetKey) {
    return;
  }
  const keys = [...new Set(currentTabAccess.map((entry) => entry.group ?? tabAccessGroupKey(entry.url)))];
  keys.sort(compareGroupKeys);
  const sourceIndex = keys.indexOf(sourceKey);
  const targetIndex = keys.indexOf(targetKey);
  if (sourceIndex === -1 || targetIndex === -1) {
    return;
  }
  keys.splice(targetIndex, 0, keys.splice(sourceIndex, 1)[0]);
  tabAccessGroupOrder = keys;
  void chrome.storage.local.set({ [TAB_ACCESS_GROUP_ORDER_KEY]: tabAccessGroupOrder });
  updateTabAccess(currentTabAccess);
}

async function addGroupDependencyOrigins(groupKey, members, button) {
  const firstUrl = members[0]?.entry.url;
  if (!firstUrl) {
    return;
  }
  button.disabled = true;
  button.textContent = "…";
  button.title = "Loading the first group URL and discovering its network dependencies";
  try {
    const [currentTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const response = await send("discover-tab-dependencies", {
      url: firstUrl,
      groupKey,
      groupEntryUrls: members.map(({ entry }) => entry.url),
      currentTabId: currentTab?.id
    });
    if (!response.ok) {
      throw new Error(response.error?.message ?? "Dependency discovery failed");
    }
    const oldUrls = new Set(currentTabAccess.map((entry) => entry.url));
    const additions = (response.origins ?? []).filter((origin) => !oldUrls.has(origin));
    if (Array.isArray(response.tabAccessAllowlist)) {
      updateTabAccess(response.tabAccessAllowlist);
    }
    button.title = additions.length > 0
      ? `Added ${additions.length} dependency origin(s)`
      : "No new HTTP(S) dependency origins found";
  } catch (error) {
    button.title = error.message ?? "Dependency discovery failed";
  } finally {
    button.textContent = "Deps";
    button.disabled = false;
  }
}

function blockedRequestOrigin(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
  } catch {
    // Unparseable URL; fall back to the exact URL.
  }
  return url;
}

function blockedRequestPrefix(url) {
  try {
    const parsed = new URL(url);
    if (["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
      return parsed.origin + parsed.pathname;
    }
  } catch {
    // Unparseable URL; fall back to trimming the query string and fragment.
  }
  return url.split(/[?#]/, 1)[0];
}

function updateBlockedRequests(entries) {
  currentBlockedRequests = entries ?? [];
  const list = document.getElementById("blocked-requests-list");
  const clearButton = document.getElementById("clear-blocked-requests-button");
  list.replaceChildren();
  clearButton.hidden = currentBlockedRequests.length === 0;
  if (currentBlockedRequests.length === 0) {
    const empty = document.createElement("span");
    empty.className = "tab-access-empty";
    empty.textContent = "No blocked requests recorded.";
    list.append(empty);
    return;
  }

  currentBlockedRequests.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "blocked-request-row";
    const url = document.createElement("span");
    url.className = "blocked-request-url";
    url.textContent = entry.url;
    const actions = document.createElement("div");
    actions.className = "blocked-request-actions";
    const allowButton = document.createElement("button");
    allowButton.type = "button";
    allowButton.className = "secondary small-button";
    allowButton.textContent = "Allow";
    allowButton.title = `Allow ${blockedRequestPrefix(entry.url)}`;
    allowButton.addEventListener("click", () => void allowBlockedRequest(entry.url, "prefix"));
    const originButton = document.createElement("button");
    originButton.type = "button";
    originButton.className = "secondary small-button";
    originButton.textContent = "Origin";
    originButton.title = `Allow ${blockedRequestOrigin(entry.url)}`;
    originButton.addEventListener("click", () => void allowBlockedRequest(entry.url, "origin"));
    const dismissButton = document.createElement("button");
    dismissButton.type = "button";
    dismissButton.className = "secondary small-button";
    dismissButton.textContent = "Dismiss";
    dismissButton.addEventListener("click", () => void dismissBlockedRequest(entry.url));
    actions.append(allowButton, originButton, dismissButton);
    const meta = document.createElement("span");
    meta.className = "blocked-request-meta";
    const timeLabel = Date.parse(entry.time) > 0 ? new Date(entry.time).toLocaleString() : "";
    meta.textContent = [entry.resourceType, entry.count > 1 ? `x${entry.count}` : null, timeLabel]
      .filter(Boolean)
      .join(" ");
    row.append(url, actions, meta);
    list.append(row);
  });
}

async function allowBlockedRequest(url, scope) {
  const target = scope === "origin" ? blockedRequestOrigin(url) : blockedRequestPrefix(url);
  if (!currentTabAccess.some((entry) => entry.url === target && entry.enabled)) {
    await persistTabAccess([...currentTabAccess, { url: target, enabled: true }]);
  }
  const response = await send("dismiss-blocked-request", { url });
  if (!response.ok) {
    throw new Error(response.error?.message ?? "Could not dismiss blocked request");
  }
  updateBlockedRequests(response.blockedRequests);
}

async function dismissBlockedRequest(url) {
  const response = await send("dismiss-blocked-request", { url });
  if (!response.ok) {
    throw new Error(response.error?.message ?? "Could not dismiss blocked request");
  }
  updateBlockedRequests(response.blockedRequests);
}

async function clearBlockedRequests() {
  const response = await send("clear-blocked-requests");
  if (!response.ok) {
    throw new Error(response.error?.message ?? "Could not clear blocked requests");
  }
  updateBlockedRequests(response.blockedRequests);
}

function updateConnectionButton(state) {
  const button = document.getElementById("connection-button");
  const bridgeConnected = Boolean(state.bridgeStatus);
  button.textContent = bridgeConnected ? "Stop" : "Start";
  button.disabled = false;
  button.classList.add("secondary");
}

async function refresh() {
  const response = await send("get-popup-state");
  const bridgeStatus = response.bridgeStatus ?? response.state.bridgeStatus;
  const reloadStatus = bridgeStatus?.developmentReload;

  document.getElementById("host-status").textContent = bridgeStatus ? "Started" : "Stopped";
  document.getElementById("bridge-url").textContent = bridgeStatus?.httpBaseUrl ?? "-";
  document.getElementById("reload-host-status").textContent = !bridgeStatus
    ? "Stopped"
    : reloadStatus?.enabled
      ? "Running (loopback only)"
      : "Not configured";
  currentReloadEndpoint = reloadStatus?.enabled
    ? `http://${reloadStatus.host}:${reloadStatus.port}${reloadStatus.path}`
    : null;
  document.getElementById("reload-endpoint").textContent = currentReloadEndpoint ?? "-";
  reloadRequiresToken = reloadStatus?.requireToken === true;
  currentReloadToken = reloadRequiresToken ? response.reloadToken : null;
  document.getElementById("reload-auth").hidden = !reloadRequiresToken;
  document.getElementById("reload-token").textContent = currentReloadToken ?? "-";
  document.getElementById("last-error").textContent = response.state.lastError ?? "-";
  updatePortInput(response.settings ?? response.state.settings);
  updateAllowedIds(response.state.developmentReloadAllowedIds);
  updateTabAccess(response.state.tabAccessAllowlist);
  document.getElementById("yolo-mode").checked = response.state.yoloModeEnabled === true;
  document.getElementById("add-active-tab-yolo-button").hidden = response.state.yoloModeEnabled !== true;
  updateBlockedRequests(response.state.blockedRequests);
  updateConnectionButton(response.state);
}

async function toggleConnection() {
  const state = await send("get-popup-state");
  const bridgeConnected = Boolean(state.state.bridgeStatus);
  await send(bridgeConnected ? "stop-host" : "start-host");

  await refresh();
}

async function regenerateReloadToken() {
  const button = document.getElementById("regenerate-reload-token-button");
  button.disabled = true;
  try {
    await send("regenerate-development-reload-token");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await refresh();
  } finally {
    button.disabled = false;
  }
}

async function addAllowedId() {
  const input = document.getElementById("new-reload-id");
  const extensionId = input.value.trim();
  if (!extensionId || currentAllowedIds.includes(extensionId)) {
    return;
  }
  await persistAllowedIds([...currentAllowedIds, extensionId]);
  input.value = "";
}

async function addTabAccessUrl() {
  const input = document.getElementById("new-tab-access-url");
  const url = input.value.trim();
  if (!url) {
    return;
  }
  await persistTabAccess([...currentTabAccess, { url, enabled: true }]);
  input.value = "";
}

async function addActiveTabToNewGroup() {
  const button = document.getElementById("add-active-tab-group-button");
  button.disabled = true;
  button.title = "Reading the active tab URL";
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const parsed = new URL(tab?.url ?? "");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("The active tab must be an HTTP(S) page");
    }
    parsed.hash = "";
    const url = parsed.href;
    const groupKey = `active-tab:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const groupLabel = parsed.hostname || "Active tab";
    tabAccessGroupNames = { ...tabAccessGroupNames, [groupKey]: groupLabel };
    tabAccessGroupOrder = [...tabAccessGroupOrder, groupKey];
    await chrome.storage.local.set({
      [TAB_ACCESS_GROUP_NAMES_KEY]: tabAccessGroupNames,
      [TAB_ACCESS_GROUP_ORDER_KEY]: tabAccessGroupOrder
    });
    await persistTabAccess([
      ...currentTabAccess,
      { url, enabled: true, group: groupKey }
    ]);
    button.title = `Added ${url} to a new ${groupLabel} group`;
  } catch (error) {
    button.title = error.message ?? "Could not add the active tab";
  } finally {
    button.disabled = false;
  }
}

async function addActiveTabToYoloGroup() {
  const button = document.getElementById("add-active-tab-yolo-button");
  button.disabled = true;
  button.title = "Adding the active tab to the YOLO group";
  try {
    const response = await send("add-active-tab-to-yolo-group");
    if (!response.ok) {
      throw new Error(response.error?.message ?? "Could not add the active tab to the YOLO group");
    }
    button.title = "Active tab added to the YOLO group";
  } catch (error) {
    button.title = error.message ?? "Could not add the active tab to the YOLO group";
  } finally {
    button.disabled = false;
  }
}

async function savePort() {
  const button = document.getElementById("save-port-button");
  const port = document.getElementById("bridge-port").value;
  button.disabled = true;

  try {
    await send("set-port", { port });
    await refresh();
  } finally {
    button.disabled = false;
  }
}

document.getElementById("connection-button").addEventListener("click", toggleConnection);
document.getElementById("yolo-mode").addEventListener("change", async (event) => {
  const response = await send("set-yolo-mode", { enabled: event.target.checked });
  if (!response.ok) {
    event.target.checked = !event.target.checked;
    return;
  }
  await refresh();
});
document.getElementById("regenerate-reload-token-button").addEventListener("click", () => {
  void regenerateReloadToken();
});
document.getElementById("add-reload-id-button").addEventListener("click", () => {
  void addAllowedId();
});
document.getElementById("add-tab-access-button").addEventListener("click", () => {
  void addTabAccessUrl();
});
document.getElementById("add-active-tab-group-button").addEventListener("click", () => {
  void addActiveTabToNewGroup();
});
document.getElementById("add-active-tab-yolo-button").addEventListener("click", () => {
  void addActiveTabToYoloGroup();
});
document.getElementById("clear-blocked-requests-button").addEventListener("click", () => {
  void clearBlockedRequests();
});
document.getElementById("new-tab-access-url").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addTabAccessUrl();
  }
});
document.getElementById("new-reload-id").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addAllowedId();
  }
});
document.getElementById("save-port-button").addEventListener("click", () => {
  void savePort();
});
document.getElementById("bridge-port").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void savePort();
  }
});

async function init() {
  const stored = await chrome.storage.local.get([
    TAB_ACCESS_GROUP_COLLAPSE_KEY,
    TAB_ACCESS_GROUP_NAMES_KEY,
    TAB_ACCESS_GROUP_ORDER_KEY
  ]);
  tabAccessGroupCollapse = stored[TAB_ACCESS_GROUP_COLLAPSE_KEY] ?? {};
  tabAccessGroupNames = stored[TAB_ACCESS_GROUP_NAMES_KEY] ?? {};
  tabAccessGroupOrder = Array.isArray(stored[TAB_ACCESS_GROUP_ORDER_KEY])
    ? stored[TAB_ACCESS_GROUP_ORDER_KEY]
    : [];
  await refresh();
}
void init();

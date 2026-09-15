let currentReloadToken = null;
let reloadRequiresToken = false;
let currentReloadEndpoint = null;
let currentAllowedIds = [];
let currentTabAccess = [];
let currentBlockedRequests = [];
const TAB_ACCESS_GROUP_COLLAPSE_KEY = "tabAccessGroupCollapse";
let tabAccessGroupCollapse = {};

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

function buildTabAccessRow(entry, index) {
  const row = document.createElement("div");
  row.className = "tab-access-row";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = entry.enabled;
  checkbox.title = entry.enabled ? "Allowed" : "Blocked (toggle to allow)";
  checkbox.addEventListener("change", () => {
    const next = [...currentTabAccess];
    next[index] = { ...next[index], enabled: checkbox.checked };
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
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "secondary small-button";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", () => void persistTabAccess(currentTabAccess.filter((_, item) => item !== index)));
  row.append(checkbox, input, deleteButton);
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
    const key = tabAccessGroupKey(entry.url);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push({ entry, index });
  });

  [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([key, members]) => {
      const collapsed = tabAccessGroupCollapse[key] === true;
      const group = document.createElement("div");
      group.className = "tab-access-group";

      const header = document.createElement("div");
      header.className = "tab-access-group-header";

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
      label.textContent = key === "other" ? "Other" : key;

      const collapseButton = document.createElement("button");
      collapseButton.type = "button";
      collapseButton.className = "tab-access-collapse";
      collapseButton.textContent = collapsed ? "+" : "\u2212";
      collapseButton.title = collapsed ? "Expand group" : "Collapse group";

      const body = document.createElement("div");
      body.className = "tab-access-group-body";
      body.hidden = collapsed;
      members.forEach(({ entry, index }) => body.append(buildTabAccessRow(entry, index)));

      collapseButton.addEventListener("click", () => {
        const isCollapsed = tabAccessGroupCollapse[key] !== true;
        tabAccessGroupCollapse[key] = isCollapsed;
        void chrome.storage.local.set({ [TAB_ACCESS_GROUP_COLLAPSE_KEY]: tabAccessGroupCollapse });
        body.hidden = isCollapsed;
        collapseButton.textContent = isCollapsed ? "+" : "\u2212";
        collapseButton.title = isCollapsed ? "Expand group" : "Collapse group";
      });

      header.append(collapseButton, groupCheckbox, label);
      group.append(header, body);
      list.append(group);
    });
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
  if (!currentTabAccess.some((entry) => entry.url === target)) {
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
  if (!url || currentTabAccess.some((entry) => entry.url === url)) {
    return;
  }
  await persistTabAccess([...currentTabAccess, { url, enabled: true }]);
  input.value = "";
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
document.getElementById("regenerate-reload-token-button").addEventListener("click", () => {
  void regenerateReloadToken();
});
document.getElementById("add-reload-id-button").addEventListener("click", () => {
  void addAllowedId();
});
document.getElementById("add-tab-access-button").addEventListener("click", () => {
  void addTabAccessUrl();
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
  const stored = await chrome.storage.local.get(TAB_ACCESS_GROUP_COLLAPSE_KEY);
  tabAccessGroupCollapse = stored[TAB_ACCESS_GROUP_COLLAPSE_KEY] ?? {};
  await refresh();
}
void init();

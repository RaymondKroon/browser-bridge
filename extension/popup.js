let currentReloadToken = null;
let reloadRequiresToken = false;
let currentReloadEndpoint = null;
let currentAllowedIds = [];
let currentTabAccess = [];

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

  currentTabAccess.forEach((entry, index) => {
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
    list.append(row);
  });
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
  document.getElementById("spawned-closed").textContent = `${response.state.spawnedTabsClosed ?? 0}`;
  const lastClose = (response.state.lastSpawnedCloses ?? [])[response.state.lastSpawnedCloses?.length - 1];
  document.getElementById("spawned-last").textContent = lastClose ? `${lastClose.url} (opener ${lastClose.openerTabId ?? "?"})` : "-";
  updatePortInput(response.settings ?? response.state.settings);
  updateAllowedIds(response.state.developmentReloadAllowedIds);
  updateTabAccess(response.state.tabAccessAllowlist);
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
void refresh();

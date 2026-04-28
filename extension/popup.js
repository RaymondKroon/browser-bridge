async function send(action, extra = {}) {
  return chrome.runtime.sendMessage({ action, ...extra });
}

function updatePortInput(settings) {
  const portInput = document.getElementById("bridge-port");
  portInput.value = `${settings?.port ?? 9222}`;
}

function updateConnectionButton(state) {
  const button = document.getElementById("connection-button");
  const bridgeConnected = Boolean(state.bridgeStatus);
  button.textContent = bridgeConnected ? "Stop" : "Start";
  button.disabled = false;
  button.classList.add("secondary");
}

async function refresh() {
  const response = await send("get-state");

  document.getElementById("host-status").textContent = response.state.bridgeStatus
    ? "Started"
    : "Stopped";
  document.getElementById("bridge-url").textContent =
    response.bridgeStatus?.httpBaseUrl ?? response.state.bridgeStatus?.httpBaseUrl ?? "-";
  document.getElementById("last-error").textContent = response.state.lastError ?? "-";
  updatePortInput(response.settings ?? response.state.settings);
  updateConnectionButton(response.state);
}

async function toggleConnection() {
  const state = await send("get-state");
  const bridgeConnected = Boolean(state.state.bridgeStatus);
  await send(bridgeConnected ? "stop-host" : "start-host");

  await refresh();
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

async function send(action, extra = {}) {
  return chrome.runtime.sendMessage({ action, ...extra });
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
  updateConnectionButton(response.state);
}

async function toggleConnection() {
  const state = await send("get-state");
  const bridgeConnected = Boolean(state.state.bridgeStatus);
  await send(bridgeConnected ? "stop-host" : "start-host");

  await refresh();
}

document.getElementById("connection-button").addEventListener("click", toggleConnection);
void refresh();

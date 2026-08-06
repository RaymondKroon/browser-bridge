# CDT bridge

Proof of concept for reusing an already-running Chrome, Chromium, or Edge session through an MV3 extension, a native messaging host, and a local CDP-compatible bridge that `agent-browser` can connect to.

## What ships

1. `extension/` - unpacked MV3 extension with a service worker and popup UI.
2. `native-host/` - native messaging entrypoint plus Windows and Linux launchers.
3. `src/` - shared Node-side bridge and host implementation.
4. `scripts/register-native-host.ps1`, `scripts/unregister-native-host.ps1`, `scripts/register-native-host.sh`, and `scripts/unregister-native-host.sh` - register or unregister the native host manifest on Windows and Linux.
5. `test/` - protocol tests plus an `agent-browser` smoke test that runs against a fake extension transport.

## Supported v1 surface

The bridge intentionally exposes a curated subset instead of pretending to be full Chrome DevTools Protocol:

- Discovery: `/json/version`, `/json`, `/json/list`, `/healthz`
- Browser domain: `Browser.getVersion`
- Target domain: `Target.getTargets`, `Target.setDiscoverTargets`, `Target.createTarget`, `Target.attachToTarget`, `Target.detachFromTarget`, `Target.activateTarget`, `Target.closeTarget`
- Page domain: `Page.enable`, `Page.navigate`, `Page.reload`, `Page.bringToFront`
- Runtime domain: `Runtime.enable`, `Runtime.evaluate`, `Runtime.runIfWaitingForDebugger`
- Network domain: `Network.enable`, `Network.getCookies`, `Network.setCookies`, `Network.clearBrowserCookies`
- DOM domain: `DOM.enable`, `DOM.getDocument`, `DOM.querySelectorAll`, `DOM.describeNode`, `DOM.resolveNode`, `DOM.getBoxModel`, `DOM.setFileInputFiles`
- Input domain: `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`
- Log domain: `Log.enable`
- Overlay domain: `Overlay.highlightNode`, `Overlay.hideHighlight`
- Fetch domain: `Fetch.enable`, `Fetch.disable`, `Fetch.continueRequest`, `Fetch.failRequest`, `Fetch.fulfillRequest`
- Storage domain: `Storage.getCookies`, `Storage.setCookies`, `Storage.clearDataForOrigin`
- Emulation domain: `Emulation.setDeviceMetricsOverride`, `Emulation.setEmulatedMedia`, `Emulation.setUserAgentOverride`

Unsupported methods return a structured JSON-RPC/CDP-style error with code `-32601`.

## Install

1. Install dependencies:

   ```bash
   npm install
   ```

2. On Linux, set up the development install. It derives the stable extension ID from the public key in the manifest, registers the native host, and creates an ignored loopback reload configuration; no manually copied ID is needed:

   ```bash
   bash ./scripts/setup-development-install.sh --browser chromium
   ```

   Use `--browser all` for every supported browser, or `--dry-run` to print the derived ID without changing native-host registration. Load `extension/` as an unpacked extension in Chrome, Chromium, or Edge after the script completes.

   On Windows, use the PowerShell setup script. It derives the stable ID, registers the native host, and creates an ignored loopback development-reload configuration:

    ```powershell
    .\scripts\setup-development-install.ps1 -Browser Both
    ```

   Reload or load `extension/` as unpacked after running the script.

    To remove registrations later:

    ```powershell
    .\scripts\unregister-native-host.ps1 -Browser Both
    ```

   On Linux, remove registrations later with:

    ```bash
    bash ./scripts/unregister-native-host.sh --browser all
    ```

   The Linux script writes the manifest into the standard per-user native messaging directories for Chrome (`~/.config/google-chrome`), Chromium (`~/.config/chromium`), and Edge (`~/.config/microsoft-edge`).

3. Open the extension popup and confirm the bridge status shows a local URL such as `http://127.0.0.1:<bridge-port>`.

### Development extension reload

The popup’s **Allowed reload IDs** list is stored in `chrome.storage.local` for this CDT Bridge installation. Helpers (`hacmcjjofinfaaahgdhopnnnipgjigge`) is the initial development entry; add other cooperating development-extension IDs in the popup and click **Save allowed IDs**. CDT Bridge sends only `{ "type": "cdt-bridge.dev-reload.v1" }`. When `native-host/development-reload.config.json` exists, the native host additionally binds a separate authenticated control endpoint only to `127.0.0.1`:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:9230/development/reload/hacmcjjofinfaaahgdhopnnnipgjigge `
  -Headers @{ "Content-Type" = "application/json" } `
  -Body "{}"
```

The extension ID is part of the URI, but CDT Bridge accepts only IDs in the popup-managed allowed-ID list; another ID is rejected by the controller before any external message is sent. The endpoint accepts no message type or other command. Its `{ "ok": true }` response means the target acknowledged and scheduled reload; inspect Chrome for any subsequent extension load error. The endpoint is disabled when that configuration file is absent. Set `requireToken` to `true` and add a high-entropy `token` in the ignored configuration only when local-process authentication is desired.

   The bridge uses port `9222` by default. You can change it from the popup, and the extension persists that setting across browser restarts. If the configured port is busy, the native host falls back to a free local port.

## Use with agent-browser

Point `agent-browser` at the bridge URL reported by the extension popup or toolbar action, not a hardcoded remote-debugging port:

```bash
agent-browser --cdp <bridge-port-from-popup> tab list
agent-browser --cdp <bridge-port-from-popup> eval "document.title"
agent-browser --cdp ws://127.0.0.1:<bridge-port-from-popup>/devtools/browser tab list
```

If `agent-browser doctor`, `tab list`, or `snapshot` hangs, repair its stale daemon sidecar files first:

```powershell
npm run repair:agent-browser
```

If you know no healthy `agent-browser` daemon should be running, force-reset all daemon sidecars:

```powershell
npm run repair:agent-browser:force
```

The repair command removes stale `*.pid`, `*.port`, and `*.stream` files from `~\.agent-browser` so the next raw `agent-browser` command can start cleanly.

On Windows, you can also inspect or terminate live `agent-browser` processes:

```powershell
.\scripts\list-agent-browser-processes.ps1
.\scripts\kill-agent-browser-processes.ps1
```

`agent-browser` expects a browser-level CDP websocket. The bridge therefore exposes:

- `GET /json/version`
- `GET /json/list`
- `ws://127.0.0.1:<port>/devtools/browser`
- `ws://127.0.0.1:<port>/devtools/browser/<bridge-id>`

## Notes and deviations

- The extension reuses the running browser session; it does not require `--remote-debugging-port`.
- Top-level page sessions are logical bridge sessions backed by one `chrome.debugger` attachment per tab.
- Child `sessionId` values created by Chrome through `Target.setAutoAttach` are forwarded as real debugger sessions.
- Non-local clients are rejected; the bridge only accepts loopback HTTP and WebSocket connections.
- Native messaging still requires explicit installation and per-extension registration.

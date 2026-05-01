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

2. Load `extension/` as an unpacked extension in Chrome, Chromium, or Edge.

3. Copy the extension ID from the browser's extensions page.

4. Register the native host.

   On Windows:

    ```powershell
    .\scripts\register-native-host.ps1 -ExtensionId <your-extension-id> -Browser Both
    ```

    To remove those registrations later:

    ```powershell
    .\scripts\unregister-native-host.ps1 -Browser Both
    ```

   On Linux:

    ```bash
    bash ./scripts/register-native-host.sh --extension-id <your-extension-id> --browser all
    ```

    To remove those registrations later:

    ```bash
    bash ./scripts/unregister-native-host.sh --browser all
    ```

   The Linux script writes the manifest into the standard per-user native messaging directories for Chrome (`~/.config/google-chrome`), Chromium (`~/.config/chromium`), and Edge (`~/.config/microsoft-edge`).

5. Open the extension popup and confirm the bridge status shows a local URL such as `http://127.0.0.1:<bridge-port>`.

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

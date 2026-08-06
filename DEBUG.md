# Debugging CDT Bridge

Use this guide to debug the extension, native host, and `agent-browser` flow in a fresh session.

## Quick facts

- The extension connects to the native messaging host named `com.cdt_bridge`.
- The Linux registration script writes `~/.config/<browser>/NativeMessagingHosts/com.cdt_bridge.json`.
- The extension popup is the fastest health check:
  - **Native host** should show `Started`
  - **Bridge** should show `http://127.0.0.1:<port>`
  - **Port** defaults to `9222` unless you saved a different value in the popup
  - **Last error** should be `-`
- After changing extension code, reload the unpacked extension and restart Chromium before retesting.

## 1. Install and baseline checks

```bash
npm install
npm test
```

If `agent-browser` behaves strangely, kill it:

```bash
pkill agent-browser
```

## 2. Load the extension

1. Open Chromium/Chrome/Edge.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Register the native host and print the stable ID without copying it manually:

   ```bash
   bash ./scripts/setup-development-install.sh --browser chromium
   ```

5. Load `extension/` as an unpacked extension.

`extension/manifest.json` includes a development-only public key so this unpacked controller has a stable extension ID. A normal new install does not need `development-controller.pem`: Chrome derives the ID from the committed public key. That ignored local private key is only retained if you intentionally create a replacement key with `setup-development-install.sh --new-development-key`. Do not use a production signing key. Replacing the key assigns a new ID, requires re-registering the native host, and requires every target extension to trust the new controller ID.

## 3. Register the native host

### Linux

```bash
./scripts/register-native-host.sh --extension-id <extension-id> --browser chromium
```

Use `--browser all` if you want all supported browsers.

### Validate registration

```bash
cat ~/.config/chromium/NativeMessagingHosts/com.cdt_bridge.json
ls -l native-host/launch-host.sh
```

The manifest should point at:

```json
{
  "name": "com.cdt_bridge",
  "type": "stdio"
}
```

## 4. Validate the native host outside the browser

This confirms the Node host itself starts:

```bash
timeout 1s node native-host/host.js || true
```

Expected: binary native-messaging output that includes a `bridgeStatus` event.

## 5. Check the extension popup

Open the popup and confirm:

- **Native host** = `Started`
- **Bridge** = `http://127.0.0.1:<port>`
- **Last error** = `-`

If the popup shows:

```text
Specified native messaging host not found.
```

then Chromium is not resolving the host manifest. Recheck:

1. the extension ID in `allowed_origins`
2. the manifest path under `~/.config/chromium/NativeMessagingHosts`
3. that `native-host/launch-host.sh` is executable
4. that Chromium was restarted after registration

### Important real-Chromium note

In the real `chromium-browser` run from this session, the bridge auto-started on browser launch because the extension service worker calls `ensureNativePort()` during startup. That means the popup already showed:

- **Native host** = `Started`
- **Bridge** = `http://127.0.0.1:<port>`

without clicking **Start**.

The popup's **Port** field is persistent, so the auto-started host should come back on the last saved port unless that port is already in use.

## 6. Smoke test the bridge directly

Use the bridge port from the popup.

```bash
curl http://127.0.0.1:<bridge-port>/json/version
curl http://127.0.0.1:<bridge-port>/json/list
agent-browser --cdp <bridge-port> tab list
agent-browser --cdp <bridge-port> eval "document.title"
```

## 7. Reproduce the internal-page problem

The key case from this session was:

```bash
agent-browser --cdp <bridge-port> open chrome://extensions
```

Also test:

```bash
agent-browser --cdp <bridge-port> open about:blank
agent-browser --cdp <bridge-port> open chrome://extensions
```

Expected behavior:

- it opens the Extensions page
- it does not crash the host
- it does not hang

## 8. Important implementation behavior

For browser-internal URLs such as `chrome://extensions`:

- the extension does **not** navigate the current debugged tab in place
- it opens a **new tab**
- it retargets the logical root session to that new tab
- it emits synthetic CDP events:
  - `Page.frameNavigated`
  - `Page.domContentEventFired`
  - `Page.loadEventFired`
- it synthesizes `Runtime.evaluate` results for:
  - `location.href`
  - `document.title`

This avoids:

- host crashes from broken native-messaging pipes
- hangs waiting for page-load signals
- disconnects when Chromium detaches `chrome.debugger` during internal-page handoff

## 9. Real Chromium debugging workflow

Use a normal GUI Chromium run. In this session, `--headless=new` did not load the unpacked extension reliably.

Example:

```bash
chromium-browser \
  --user-data-dir="$(mktemp -d)" \
  --remote-debugging-port=9224 \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-sync \
  --disable-component-update \
  --load-extension="$PWD/extension" \
  about:blank
```

For the real Fedora Chromium build used here, `--user-data-dir` also changed native-messaging manifest lookup. Registering only under `~/.config/chromium/NativeMessagingHosts` was **not enough**. Chromium only resolved the host after the manifest also existed at:

```bash
<user-data-dir>/NativeMessagingHosts/com.cdt_bridge.json
```

Example:

```bash
PROFILE="$(mktemp -d)"
chromium-browser \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port=9224 \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-sync \
  --disable-component-update \
  --disable-extensions-except="$PWD/extension" \
  --load-extension="$PWD/extension" \
  about:blank
```

Then install the host manifest in **both** places before restarting Chromium:

```bash
./scripts/register-native-host.sh --extension-id <extension-id> --browser chromium
mkdir -p "$PROFILE/NativeMessagingHosts"
cp ~/.config/chromium/NativeMessagingHosts/com.cdt_bridge.json \
  "$PROFILE/NativeMessagingHosts/com.cdt_bridge.json"
```

Then:

1. launch Chromium with a remembered `PROFILE`
2. find the unpacked extension ID from `chrome://extensions` or from `curl http://127.0.0.1:9224/json/list`
3. register the native host for that ID
4. copy the manifest into `$PROFILE/NativeMessagingHosts/com.cdt_bridge.json`
5. restart Chromium with the same `PROFILE`
6. open the popup and confirm the bridge is already started
7. run `agent-browser --session real-chromium --cdp <bridge-port> open chrome://extensions`

The real validation from this session was:

```bash
agent-browser --session real-chromium --cdp <bridge-port> open chrome://extensions
```

Expected output:

```text
✓ Extensions
  chrome://extensions/
```

## 10. Inspect Chromium over raw CDP

If needed, verify targets from Chromium itself:

```bash
curl http://127.0.0.1:9224/json/version
curl http://127.0.0.1:9224/json/list
```

To wake the extension service worker, open:

```text
chrome-extension://<extension-id>/popup.html
```

Useful targets to look for:

- `chrome-extension://<extension-id>/popup.html`
- `chrome-extension://<extension-id>/service-worker.js`

## 11. Common failure modes

| Symptom | Likely cause | Check |
| --- | --- | --- |
| `Specified native messaging host not found.` | Chromium cannot resolve the manifest | manifest path, `allowed_origins`, restart browser |
| `Specified native messaging host not found.` while using `--user-data-dir` | Chromium is reading manifests from the profile-specific `NativeMessagingHosts` directory | copy `com.cdt_bridge.json` into `<user-data-dir>/NativeMessagingHosts/` and restart |
| `CDP error (Page.navigate): Native messaging input ended` | browser-side disconnect during internal-page flow | reload extension, restart browser, retest `open chrome://extensions` |
| Host crashes with `EPIPE` | native-messaging pipe broke during cleanup | verify latest `src/native-host/native-messaging-transport.js` is loaded |
| `agent-browser` hangs | stale daemon files or missing synthetic load events | run repair script, confirm latest extension is loaded |

## 12. Files most relevant to this bug

- `extension/service-worker.js`
- `src/native-host/native-messaging-transport.js`
- `src/bridge/cdp-bridge-server.js`
- `test/service-worker.test.js`
- `test/native-messaging-transport.test.js`

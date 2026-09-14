# CDT Bridge — Spec

Requirements, architecture, and quality bar for the CDT bridge. The README covers
install/usage; this file is the source of truth for what the system must do and how
changes are verified.

## Purpose

Expose a curated CDP (Chrome DevTools Protocol) endpoint for an already-running
Chrome/Chromium/Edge session, so an agent (`agent-browser`) can drive the user's real
browser without a separate debug instance.

## Architecture

Three parts, connected as: agent ⇄ HTTP/WebSocket ⇄ native host ⇄ native messaging ⇄ extension ⇄ chrome.debugger ⇄ tabs.

- `extension/` — MV3 extension. `service-worker.js` owns `chrome.debugger` sessions,
  translates bridge requests into CDP commands, and keeps the native port alive via
  `ensureNativePort()` at boot. `popup.html`/`popup.js` are the health-check UI.
- `native-host/` — entrypoint (`host.js`) + launchers; `src/native-host/` holds the
  implementation. The host process hosts the bridge and **exits on native-messaging
  port disconnect** (`src/native-host/main.js`).
- `src/bridge/cdp-bridge-server.js` — loopback HTTP + WebSocket server (default port
  9222) that speaks CDP over WebSocket and serves discovery endpoints.

Key invariants:

- The bridge is loopback-only (`127.0.0.1`); non-local requests are rejected.
- The bridge exposes a curated method allowlist (`SUPPORTED_METHODS` in
  `service-worker.js`); unsupported methods return CDP error `-32601`.
- Browser-internal URLs (`chrome://`, `about:*` except blank/srcdoc) are opened in a
  new tab with synthetic CDP events instead of in-place navigation (see DEBUG.md §8).
- Tab access is gated by a user-managed allowlist (`tabAccessAllowlist` in
  `chrome.storage.local`); blocked requests are failed via the Fetch domain.
  Every blocked request (including subresources, which are not auto-added to
  the allowlist) is recorded in `blockedRequestsLog` (last 50 entries, deduped
  by URL) so the popup can show what was blocked and offer one-click origin
  allowlisting.
- Tab access is strict: attaching to, detaching, or sending any command to a
  tab whose current URL is not allowlisted is rejected — including
  `Page.navigate` to an allowlisted URL and inert domain-enable commands
  (`*.enable`). The agent's sanctioned path to an allowed site is
  `Target.createTarget` (a new tab), which is gated on the destination URL.
  Detaching never removes the debugger from extension-held tabs (spawned-tab
  Fetch gates), so agent attach/detach cycles cannot ungate a tab.
- Agent-created tabs are gated from the start: `Target.createTarget` attaches
  the Fetch gate immediately and forces one reload, because the tab's
  initial load otherwise beats the gate and the Fetch domain never
  intercepts requests served from the HTTP cache. Without the reload, an
  agent-created tab could fetch (and re-serve from cache) non-allowlisted
  subresources ungated.
- The development reload token never crosses the bridge (not in
  `bridgeStatus`/diagnostics); it travels only over native messaging.

## Diagnostics requirement

Because the MV3 service worker can die silently (unhandled rejection) and the native
host's console is invisible under native messaging, both sides must persist crash
evidence:

- **SW crash log** — `chrome.storage.local` key `crashLog` (last 50 entries,
  `{ time, type, message, stack?, ... }`; types: `boot`, `port-disconnect`,
  `unhandledrejection`, `error`). Exposed via `getDiagnostics` and
  `GET /json/diagnostics` on the bridge.
- **Native host crash log** — JSON lines at `~/.cdt-bridge/native-host-crash.log`
  (dir overridable via `CDT_BRIDGE_CRASH_LOG_DIR`; path reported in `bridgeStatus`
  as `crashLogPath`; types: `boot`, `disconnect`, `uncaughtException`,
  `unhandledRejection`). Written synchronously so entries survive an immediate exit.

How to interpret a drop is documented in DEBUG.md §14.

## Quality bar

- `npm test` (i.e. `node --test`) must pass with zero failures before any commit.
  This includes the `agent-browser` smoke test against the fake transport.
- Every behavior change gets a focused test in `test/` (service worker behavior is
  tested by loading `extension/service-worker.js` in a `vm` context with a mocked
  `chrome` API — keep that harness in sync when the SW's top-level shape changes).
- Keep the SW's trailing boot block shape stable or update the harness's strip
  regex in `test/service-worker.test.js`.
- Commit per completed task; do not push from the agent side (the user syncs to the
  Windows machine manually).

# Browser Bridge — Spec

Requirements, architecture, and quality bar for Browser Bridge. The README covers
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
- `ensureNativePort` dedupes concurrent connect attempts (boot auto-connect vs.
  popup Start); without it two native hosts could launch, the second hitting
  `EADDRINUSE` and an orphaned host holding the bridge port.
- Restart resilience: the host retries binding the bridge port and the
  development-reload port (6 attempts, 500 ms apart) so a still-exiting
  previous instance does not break startup. If the bridge port stays
  occupied it falls back to an ephemeral loopback port; if the reload port
  stays occupied the reload endpoint is disabled with a warning instead of
  crashing the host. If the extension port disconnects during startup (fast
  stop/start toggling, extension reload), the host exits cleanly without a
  startup-failure log entry. The extension waits up to 20 s for
  `bridgeStatus` after (re)connecting the native port.
- The bridge exposes a curated method allowlist (`SUPPORTED_METHODS` in
  `service-worker.js`); unsupported methods return CDP error `-32601`.
- Browser-internal URLs (`chrome://`, `about:*` except blank/srcdoc) are opened in a
  new tab with synthetic CDP events instead of in-place navigation (see DEBUG.md §8).
- Tab access is gated by a user-managed allowlist (`tabAccessAllowlist` in
  `chrome.storage.local`); blocked requests are failed via the Fetch domain.
  Every blocked request (including subresources, which are not auto-added to
  the allowlist) is recorded in `blockedRequestsLog` (last 50 entries, deduped
  by URL) so the popup can show what was blocked and offer one-click origin
  allowlisting. When a *subresource* is blocked, the extension also injects
  a visible banner into the affected page (idempotent `Runtime.evaluate` in
  the main world, fixed bottom-right, lists up to the last 5 blocked URLs
  with counts). The banner is a live indicator: the user sees it on screen
  and the agent can read it from the DOM/AX tree. Blocked documents get no
  banner (the page itself did not load); injection is best-effort and
  silently skipped if the page context is unavailable.
- Tab access is strict: attaching to, detaching, or sending any command to a
  tab whose current URL is not allowlisted is rejected — including
  `Page.navigate` to an allowlisted URL and inert domain-enable commands
  (`*.enable`). The agent's sanctioned path to an allowed site is
  `Target.createTarget` (a new tab), which is gated on the destination URL.
  Detaching never removes the debugger from extension-held tabs (spawned-tab
  Fetch gates), so agent attach/detach cycles cannot ungate a tab.
  Gated tabs are collected in a red "gated" tab group (one per window, created
  on demand per bridge session); every tab the extension gates — agent-created,
  spawned, or attached — is moved into it, out of any user group, via
  `chrome.tabs.group`/`ungroup` (the `tabGroups` API only manages group
  properties and cannot create empty groups: the group is created together
  with its first tab via `tabs.group` + `createProperties`, then styled with
  `tabGroups.update`; Chrome deletes it when the last tab leaves). The
  `tabGroups` manifest permission is required — without it Chrome leaves
  `chrome.tabGroups` undefined and the group indication is skipped (the
  favicon and gate still work). Group membership is the gate state in both
  directions: a gated tab that leaves the group (dragged out, moved to
  another group, or the group deleted) is ungated automatically, and a tab
  the user moves into the group is gated (extension-held, like a spawned
  tab; the drag is the authorization, so no allowlist check) — both via
  `tabs.onUpdated` (`changeInfo.groupId`; current Chrome removed
  `tabGroups.onChanged`). The `ungate-tab` action does the ungate
  explicitly. The group also survives service worker restarts and extension
  reloads (the debugger attachment does not): on every boot the extension
  re-gates every tab still in the group (attach reason `group-restore`), and
  tabs sitting on a disallowed URL — whether restored or dragged in — are
  reloaded so the Fetch gate blocks the document. Ungate detaches the debugger, clears extension-held and spawn
  tracking, and restores the original favicon. Tabs that cannot be grouped
  (pinned tabs and special pages) fall back to a "no entry" favicon, swapped
  from inside the page via CDP (the tabs API cannot set favicons): the
  install script is registered with `Page.addScriptToEvaluateOnNewDocument`
  for the tab's lifetime, re-asserts itself against page favicon changes
  (MutationObserver), and remembers the original icon. Ungate restores the
  original icon before detaching; if the user cancels the debug infobar
  instead, the gated icon stays until the next reload or ungate. Note:
  Chrome reports tabs opened with the "+" button while an agent tab is
  active as *spawned from* that tab (`openerTabId` is set), so such
  user-opened tabs are gated like agent-spawned ones — dragging them out of
  the "gated" group is the escape hatch.
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
- **SW attach log** — `chrome.storage.local` key `attachLog` (last 50
  entries, `{ time, reason, tabId, openerTabId, url }`; reasons:
  `spawned-tab`, `police-reload`, `agent-attach`, `agent-command`,
  `agent-created`, `ungate`). Records every extension-initiated debugger
  attach/unattach so gated tabs can be explained. Exposed via
  `getDiagnostics` and `GET /json/diagnostics`.
- **Native host crash log** — JSON lines at `~/.browser-bridge/native-host-crash.log`
  (dir overridable via `BROWSER_BRIDGE_CRASH_LOG_DIR`; path reported in `bridgeStatus`
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

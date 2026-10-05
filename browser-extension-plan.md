# Browser extension plan

## Problem statement

We want a browser extension that gives an external agent access to the currently running browser session without restarting Chrome/Edge with `--remote-debugging-port`.

The main motivation is to reuse the already-open browser, tabs, cookies, and authenticated state.

## Key feasibility constraint

An extension can use `chrome.debugger` as an alternate transport for **parts** of the Chrome DevTools Protocol, but it is **not** a full replacement for a native CDP endpoint:

1. `chrome.debugger` only exposes a **restricted subset** of CDP domains.
2. A Manifest V3 extension **cannot act as a raw local TCP/WebSocket server** for arbitrary external tools by itself.
3. For CLI/agent integration, we will likely need **two pieces**:
   1. an MV3 extension inside the browser
   2. a small local bridge process connected via **Native Messaging**

Because of that, the realistic target is a **CDP-like bridge** backed by `chrome.debugger`, not a complete drop-in implementation of every CDP feature.

## Recommended architecture

**Recommended:** MV3 extension + native messaging host + CDP-compatibility shim.

### Components

1. **MV3 extension**
   - service worker for command routing and debugger session lifecycle
   - optional side panel or popup for user consent, status, and diagnostics
   - optional offscreen document if we need DOM-capable utility work

2. **Native messaging host**
   - local process started by the extension
   - exposes a local API for the agent/CLI
   - translates between external requests and extension messages

3. **Compatibility shim**
   - implements a stable request/response/event contract
   - mirrors CDP naming where possible
   - returns explicit `MethodNotFound` / `NotSupported` style errors for unsupported domains

## Scope

### In scope

1. Attach to an existing tab without browser restart.
2. Reuse existing login state and cookies from the running browser profile.
3. Provide automation and inspection for a practical subset of CDP-backed use cases.
4. Support tab discovery, attach, detach, command execution, and event streaming.
5. Support agent-browser style integration through a local bridge.

### Out of scope

1. Full parity with every Chrome DevTools Protocol domain.
2. Emulating browser startup flags that only work before browser launch.
3. Bypassing enterprise policy if `chrome.debugger` or extension installation is also blocked.
4. Pure extension-only local socket serving with no companion bridge process.

## Functional requirements

### 1. Session and target management

1. The system must discover open tabs and windows.
2. The system must attach to a chosen tab on demand.
3. The system must detach cleanly and release debugger ownership.
4. The system must support reconnecting after tab refreshes, navigations, and extension worker restarts.
5. The system should support related targets such as iframes and workers where `chrome.debugger` allows it.
6. The system should use flat sessions / `Target.setAutoAttach` where supported.

### 2. External control surface

1. The native host must expose a stable local interface for an external agent.
2. The interface must support:
   - list targets
   - attach/detach
   - send command
   - receive events
   - query capability support
3. The request/response model should preserve CDP-style message correlation via request IDs.
4. The interface must be versioned so the agent can negotiate supported capabilities.

### 3. CDP domain support

The first version should target domains that are both high-value and available through `chrome.debugger`, likely including:

1. `Runtime`
2. `Page`
3. `Network`
4. `DOM`
5. `CSS`
6. `Input`
7. `Log`
8. `Overlay`
9. `Target`
10. `Fetch`
11. `Storage`
12. `Emulation`

Each supported domain must have:

1. explicit command allowlisting
2. explicit event routing
3. a compatibility note describing deviations from raw CDP

Unsupported domains/commands must fail with a structured error, never silently no-op.

### 4. Permissions and consent

1. The extension must declare only the permissions required for its feature set.
2. The extension must request user consent before attaching to a tab if Chrome surfaces a debugger infobar/prompt.
3. The extension must make the active attachment state visible to the user.
4. The extension must provide a one-click detach/disable control.

### 5. Reliability

1. The system must survive MV3 service worker suspension.
2. The system must restore command routing after worker restart.
3. The system must detect stale tab/session mappings and recover.
4. The system must handle browser updates and protocol drift gracefully.

### 6. Security

1. Only the installed local bridge process may communicate with the extension's privileged control path.
2. The bridge protocol must reject unauthenticated or unexpected clients.
3. The system must restrict control to explicitly allowed tabs or user-approved sessions if needed.
4. Sensitive data must not be logged by default.
5. Errors must not leak cookies, auth headers, or page content beyond what the caller explicitly requested.

### 7. Diagnostics

1. The extension must expose health/status information:
   - extension version
   - browser version
   - attached tabs
   - supported domains
   - last error
2. The bridge must provide debug logs for transport, command, and event flow.
3. The system must clearly differentiate:
   - extension not installed
   - native host not installed
   - attach denied
   - command unsupported
   - tab closed
   - worker restarted

## Non-functional requirements

1. **No browser restart for normal use.**
2. **Windows-first implementation**, with room for macOS/Linux later.
3. **Manifest V3 compatible.**
4. **Low overhead** when idle.
5. **Predictable failure modes** with structured errors.
6. **Protocol stability** across extension and bridge upgrades.
7. **Minimal permissions** and clear user-facing trust model.

## Risks and constraints

1. `chrome.debugger` domain coverage is incomplete.
2. Some CDP semantics may differ from direct remote-debugging-port behavior.
3. Another debugger consumer may already own the tab, causing attach failures.
4. Enterprise policy may also restrict extension installation, debugger permission use, or native messaging host registration.
5. MV3 service worker lifecycle can interrupt long-lived flows unless explicitly designed around.
6. Browser UI may show debugger warnings that affect UX.

## Suggested phased delivery

### Phase 1: Proof of concept

1. MV3 extension attaches to the active tab.
2. Native host exchanges messages with the extension.
3. Basic commands work: `Runtime.evaluate`, `Page.navigate`, `Page.reload`, `DOM.getDocument`.

### Phase 2: Agent integration

1. Local bridge exposes a stable API to the CLI/agent.
2. Event streaming works for `Runtime`, `Network`, and `Page`.
3. Target discovery and attach selection are implemented.

### Phase 3: Hardening

1. Capability negotiation and versioning.
2. Recovery from worker restart and tab lifecycle changes.
3. Logging, diagnostics, and secure installation flow.

### Phase 4: Compatibility expansion

1. Add more supported domains where `chrome.debugger` permits them.
2. Document deviations from raw CDP.
3. Decide whether a partial `agent-browser` adapter is sufficient or if a separate client should be built.

## Acceptance criteria

The first usable version is complete when:

1. An external agent can connect to the local bridge.
2. The bridge can list browser targets from the running browser.
3. The extension can attach to an already-open tab without restarting the browser.
4. The agent can issue a small supported subset of CDP-style commands and receive responses/events.
5. Unsupported commands fail with explicit structured errors.
6. The user can see and stop the active debug session.

## Open questions

1. Do we need **raw CDP wire compatibility**, or is **CDP-like compatibility** enough for `agent-browser`?
2. Should the bridge expose **WebSocket**, **HTTP**, or only a local stdio/pipe interface?
3. Is the target browser **Chrome only**, **Edge only**, or both?
4. Do we need multi-tab concurrent sessions in v1?
5. Is tab attach allowed only for the active tab, or for any open tab?
6. Do we want a visible side panel for consent and status, or keep UI minimal?

## Recommendation

Proceed only if we accept the following product definition:

**We are building an extension-based automation bridge that reuses the running browser session and exposes a curated CDP-compatible subset through a native host, not a full reimplementation of the entire Chrome DevTools Protocol.**

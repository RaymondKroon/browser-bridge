---
name: chrome-dev-extension-reload
description: Adds and verifies a secure development-only protocol for a Chrome/Chromium extension to reload itself when an explicitly trusted controller extension requests it. Use when setting up automated reload after edits to an unpacked MV3 extension, or when integrating a development extension reloader.
---

# Cooperative Chrome Extension Development Reload

Use this skill to implement automated reload for **extensions controlled by the project**. Chrome does not offer a public API that lets one extension reload arbitrary other extensions. The supported pattern is:

1. A controller extension sends an external message to a target extension.
2. The target verifies the controller's extension ID.
3. The target calls `chrome.runtime.reload()` on itself.

Do **not** attempt to automate the Reload button in `chrome://extensions`, use `chrome.developerPrivate`, or toggle enable/disable through `chrome.management`. Those approaches are privileged, unreliable, or not a reload API.

## Security and scope

Before editing, establish all of the following:

- The target is an unpacked development extension owned by the project.
- The controller extension ID is known and stable for the development profile.
- The feature will not be present in a production build, or is explicitly guarded by a development-only configuration.
- The target accepts only a narrowly defined reload message from that exact controller ID.

Never implement a wildcard sender, a message that reloads on arbitrary input, or a web-page-triggerable reload endpoint.

If the controller ID is unstable because the extension is unpacked, give the controller a stable development key in its manifest and document the resulting ID. Do not reuse a private production signing key for this purpose.

The ID is deterministic: it is the first 16 bytes of SHA-256 of the DER-encoded public key from the manifest's `key` field, with each nibble mapped to `a`-`p`. Compute it from the manifest (a few lines of Node or .NET) instead of copying it from `chrome://extensions` — the visible ID belongs to whatever profile you are looking at, and copying it from the wrong profile is a common source of mismatched `allowed_origins` / `externally_connectable` entries. Registration scripts should derive the ID this way and reject an explicitly passed ID that disagrees with the manifest.

## Target-extension implementation

### 1. Locate the MV3 worker and manifest

Inspect the project before changing it. Find:

- `manifest.json` and its `background.service_worker`, if present;
- the service-worker/module entry point;
- any existing build-time development flags; and
- any existing `chrome.runtime.onMessageExternal` listener.

Merge with an existing external-message listener rather than registering overlapping, contradictory handlers.

### 2. Allow only the controller extension

In the target extension's `manifest.json`, add or merge `externally_connectable`:

```json
{
  "externally_connectable": {
    "ids": ["CONTROLLER_EXTENSION_ID"]
  }
}
```

Preserve existing `ids` and `matches` entries. Do not replace an existing allowlist. If the manifest is generated, change the source manifest/configuration rather than generated output.

### 3. Add a development-only message handler

Adapt this pattern to the project's style and configuration mechanism:

```js
const DEV_RELOAD_CONTROLLER_ID = "CONTROLLER_EXTENSION_ID";
const DEV_RELOAD_MESSAGE_TYPE = "browser-bridge.dev-reload.v1";

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.type !== DEV_RELOAD_MESSAGE_TYPE) {
    return;
  }

  if (sender.id !== DEV_RELOAD_CONTROLLER_ID) {
    sendResponse({ ok: false, error: "Unauthorized development reload request" });
    return;
  }

  // Send the acknowledgement before this extension tears down its worker.
  sendResponse({ ok: true });
  setTimeout(() => chrome.runtime.reload(), 0);
});
```

Requirements:

- Include this code only in development builds where possible. A manifest-only allowlist is not enough protection for a production build.
- Use a namespaced, versioned message type, not a generic value such as `"reload"`.
- Compare `sender.id` exactly; do not trust a caller-provided ID.
- Do not accept an extension ID or arbitrary command from the message payload.
- Send the acknowledgement before scheduling reload. The target worker will be terminated as part of reload, so no post-reload response is possible.
- If the project uses TypeScript, declare message types and use the project build pipeline; do not put uncompiled TypeScript in the loaded extension directory.

The target may optionally validate that it is an unpacked development build using a build-time constant. Avoid using `chrome.management` merely to determine this, since it adds an unnecessary permission.

## Controller implementation

The controller must itself be an extension. A page, native host, or Node process cannot call Chrome extension messaging directly.

The controller sends one exact request:

```js
const response = await chrome.runtime.sendMessage(
  targetExtensionId,
  { type: "browser-bridge.dev-reload.v1" }
);

if (!response?.ok) {
  throw new Error(response?.error ?? "Target did not acknowledge reload");
}
```

For a bridge such as this repository, expose a **separate, explicitly named development action** from the native/HTTP side to the controller service worker. Its input must be validated against a local allowlist of target extension IDs. Do not turn arbitrary CDP `Runtime.evaluate` input into cross-extension messaging.

Recommended controller request shape:

```json
{
  "action": "reloadDevelopmentExtension",
  "payload": { "extensionId": "<allowlisted target ID>" }
}
```

Recommended controller behavior:

1. Reject an absent, malformed, or non-allowlisted ID.
2. Send the fixed message type above with `chrome.runtime.sendMessage`.
3. Return only the pre-reload acknowledgement to the caller.
4. Treat native-messaging/worker disconnects during a reload as expected only for the **target**, not the controller.
5. Never offer this action on a non-loopback network endpoint.

### Invoking the controller from Pi or another local process

Pi, a shell script, Node, and a native host are **not extension contexts** and cannot call `chrome.runtime.sendMessage` directly. They may invoke a narrowly scoped local control endpoint, which forwards the validated action over the controller extension's existing native-messaging connection:

```text
Pi / watcher / local process
  -> loopback control endpoint or Unix-domain socket
  -> native host
  -> controller extension service worker
  -> chrome.runtime.sendMessage(targetId, fixed reload message)
  -> target extension
```

`curl` is suitable only for that local control transport; it cannot communicate with the target extension directly. For example, a development-only HTTP endpoint may accept one fixed action:

```bash
curl --fail-with-body \
  -X POST http://127.0.0.1:<control-port>/development/reload \
  -H 'Content-Type: application/json' \
  --data '{"extensionId":"<allowlisted-target-id>"}'
```

Requirements for this transport:

1. Bind HTTP only to loopback (`127.0.0.1` and/or `::1`), or prefer a Unix-domain socket where practical. Never expose it on a LAN, public interface, or tunnel.
2. If other local processes are not trusted, require a high-entropy development token from ignored local configuration. Do not place it in the extension bundle, source control, or a URL query string.
3. Route only `POST /development/reload` (or an equivalently explicit development-only path), reject other methods, and impose a small request-body limit. Keep the extension ID out of the URL path and query string.
4. Strictly validate the JSON schema: require exactly `{ "extensionId": "<allowlisted-target-id>" }` with a valid extension-ID format, then check that ID against the native-side/controller-side allowlist before forwarding it. Do not accept a message type, JavaScript, CDP method, or arbitrary extension command from the request.
5. Keep this control route separate from a CDP bridge. In particular, do not map arbitrary CDP `Runtime.evaluate` requests to cross-extension messaging.
6. Return the controller's pre-reload acknowledgement only. `{ ok: true }` means that the target scheduled a reload, not that its updated code loaded successfully.

A file watcher may call this local controller action after a debounced successful build. The watcher must watch source/build completion, not individual partial writes in the unpacked directory.

## Stable identifiers and configuration

Use configuration rather than source edits for IDs where the project supports it:

- development manifest template or environment substitution for `externally_connectable.ids`;
- local ignored development config for the controller allowlist; and
- documented setup instructions that show how to obtain IDs from `chrome://extensions`.

If project policy permits committing development IDs, clearly label them as development-only. Never copy a user profile's unrelated extension IDs into the repository.

## Verification

After implementation, verify all of these cases:

1. **Authorized target reload**: edit a harmless target source file, invoke the controller action, and verify the target worker/page starts with the new code.
2. **Acknowledgement**: the controller receives `{ ok: true }` before the target unloads.
3. **Unauthorized sender**: send the same message from an extension whose ID is not allowlisted; verify it is rejected or cannot connect.
4. **Wrong message**: send an unrelated external message from the authorized controller; verify no reload occurs.
5. **Failure visibility**: introduce a temporary manifest/source error in an unpacked target and confirm the workflow reports that reload was requested while Chrome surfaces the actual load error. Do not report a successful post-reload health check unless one is actually implemented.
6. **Local control transport**: verify a loopback/Unix-socket request with a valid development token and allowlisted ID receives the acknowledgement; malformed bodies, missing/invalid tokens, non-allowlisted IDs, wrong HTTP methods, and non-loopback peers are rejected without messaging the controller.
7. **Regression tests**: add unit tests for sender validation, message matching, and local-control input validation, using the project's existing Chrome API harness/mocks. Run the project's full relevant test suite.

For a robust post-reload check, have the target send a new, authenticated `ready` message to the controller after its service worker starts. Correlate it with a nonce generated by the controller; do not treat an old worker event as success.

## Limitations to document

- This reloads only extensions that deliberately include this protocol.
- It cannot reload arbitrary installed, policy-managed, Chrome Web Store, or third-party extensions.
- `Page.reload` on `chrome://extensions` reloads the browser page, not an extension.
- `chrome.runtime.reload()` reloads the calling extension only.
- A successful request acknowledgement means reload was scheduled; it is not proof that the modified extension loaded successfully.
- Pi, `curl`, Node, and native hosts cannot use Chrome external-extension messaging directly; they require the cooperating controller extension and its explicitly scoped local control transport.

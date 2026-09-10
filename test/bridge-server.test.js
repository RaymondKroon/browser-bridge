import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { CdpBridgeServer } from "../src/bridge/cdp-bridge-server.js";
import { FakeExtensionTransport } from "./fake-extension-transport.js";

async function readJson(url, options) {
  const response = await fetch(url, options);
  return await response.json();
}

async function readResponse(url, options) {
  return await fetch(url, options);
}

async function waitForClose(ws, timeoutMs = 2000) {
  return await Promise.race([
    once(ws, "close"),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for websocket close after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

test("bridge exposes discovery endpoints and browser websocket", async () => {
  const transport = new FakeExtensionTransport();
  const bridge = new CdpBridgeServer({ transport, port: 0 });
  await bridge.start();

  try {
    const version = await readJson(`${bridge.httpBaseUrl}/json/version`);
    assert.equal(version.webSocketDebuggerUrl, bridge.browserWebSocketUrl);

    const list = await readJson(`${bridge.httpBaseUrl}/json/list`);
    assert.ok(list.some((target) => target.id === "page:1"));
    assert.match(list[0].devtoolsFrontendUrl, /\/devtools\/inspector\.html\?ws=/);

    const protocol = await readJson(`${bridge.httpBaseUrl}/json/protocol`);
    assert.ok(Array.isArray(protocol.domains));
    assert.ok(protocol.domains.some((domain) => domain.domain === "Page"));

    const diagnostics = await readJson(`${bridge.httpBaseUrl}/json/diagnostics`);
    assert.equal(diagnostics.browserVersion, "FakeBrowser/1.0");
    assert.deepEqual(diagnostics.crashLog, []);

    const createdTarget = await readJson(`${bridge.httpBaseUrl}/json/new?https://example.com`, {
      method: "PUT"
    });
    assert.equal(createdTarget.id, "page:2");
    assert.equal(createdTarget.url, "https://example.com");

    const activateResponse = await readResponse(`${bridge.httpBaseUrl}/json/activate/page%3A2`);
    assert.equal(activateResponse.status, 200);
    assert.equal(await activateResponse.text(), "Target activated");

    const closeResponse = await readResponse(`${bridge.httpBaseUrl}/json/close/page%3A2`);
    assert.equal(closeResponse.status, 200);
    assert.equal(await closeResponse.text(), "Target is closing");

    const ws = new WebSocket(bridge.browserWebSocketUrl);
    await once(ws, "open");

    ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    const [rawVersion] = await once(ws, "message");
    const versionMessage = JSON.parse(rawVersion.toString());
    assert.equal(versionMessage.id, 1);
    assert.equal(versionMessage.result.protocolVersion, "1.3");

    ws.send(JSON.stringify({ id: 2, method: "Target.getTargets" }));
    const [rawTargets] = await once(ws, "message");
    const targetsMessage = JSON.parse(rawTargets.toString());
    assert.equal(targetsMessage.id, 2);
    assert.ok(targetsMessage.result.targetInfos.length >= 1);
    assert.equal("webSocketDebuggerUrl" in targetsMessage.result.targetInfos[0], false);

    ws.send(JSON.stringify({ id: 3, method: "Browser.getWindowForTarget", params: { targetId: "page:1" } }));
    const [rawWindow] = await once(ws, "message");
    const windowMessage = JSON.parse(rawWindow.toString());
    assert.equal(windowMessage.id, 3);
    assert.equal(windowMessage.result.windowId, 1);

    ws.close();
  } finally {
    await bridge.stop();
  }
});

test("bridge page websocket supports snapshot-like commands without a stored session", async () => {
  const transport = new FakeExtensionTransport();
  const bridge = new CdpBridgeServer({ transport, port: 0 });
  await bridge.start();

  try {
    const targets = await readJson(`${bridge.httpBaseUrl}/json/list`);
    const pageTarget = targets.find((target) => target.id === "page:1");
    assert.ok(pageTarget?.webSocketDebuggerUrl, "expected page websocket URL");

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await once(ws, "open");

    ws.send(JSON.stringify({ id: 1, method: "Accessibility.getFullAXTree" }));
    const [rawTree] = await once(ws, "message");
    const treeMessage = JSON.parse(rawTree.toString());
    assert.equal(treeMessage.id, 1);
    assert.match(JSON.stringify(treeMessage.result.nodes), /RootWebArea|Search/);

    ws.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: "document.title" } }));
    const [rawEval] = await once(ws, "message");
    const evalMessage = JSON.parse(rawEval.toString());
    assert.equal(evalMessage.id, 2);
    assert.equal(evalMessage.result.result.value, "Fake Page");

    ws.send(JSON.stringify({ id: 3, method: "Page.getLayoutMetrics" }));
    const [rawLayout] = await once(ws, "message");
    const layoutMessage = JSON.parse(rawLayout.toString());
    assert.equal(layoutMessage.id, 3);
    assert.equal(layoutMessage.result.cssContentSize.width, 1280);

    ws.close();
  } finally {
    await bridge.stop();
  }
});

test("bridge stop closes active websocket clients promptly", async () => {
  const transport = new FakeExtensionTransport();
  const bridge = new CdpBridgeServer({ transport, port: 0 });
  await bridge.start();

  const ws = new WebSocket(bridge.browserWebSocketUrl);
  await once(ws, "open");

  ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  await once(ws, "message");

  await bridge.stop();
  await waitForClose(ws);
});

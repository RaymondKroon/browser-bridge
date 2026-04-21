import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { CdpBridgeServer } from "../src/bridge/cdp-bridge-server.js";
import { FakeExtensionTransport } from "./fake-extension-transport.js";

async function readJson(url) {
  const response = await fetch(url);
  return await response.json();
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
    assert.equal(list[0].type, "browser");
    assert.ok(list.some((target) => target.targetId === "page:1"));

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
    const pageTarget = targets.find((target) => target.targetId === "page:1");
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

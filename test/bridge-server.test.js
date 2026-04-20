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

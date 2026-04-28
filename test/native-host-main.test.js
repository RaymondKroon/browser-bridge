import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import {
  parsePreferredPort,
  startBridgeServer,
  waitForInitialHello
} from "../src/native-host/main.js";
import { FakeExtensionTransport } from "./fake-extension-transport.js";

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

test("native host falls back to a free port when the preferred port is occupied", async () => {
  const occupiedServer = http.createServer((_req, res) => {
    res.writeHead(200).end("occupied");
  });
  await listen(occupiedServer, 0);
  const occupiedPort = occupiedServer.address().port;

  const transport = new FakeExtensionTransport();
  const warnings = [];
  const bridge = await startBridgeServer({
    transport,
    preferredPort: occupiedPort,
    logger: {
      warn(message) {
        warnings.push(message);
      }
    }
  });

  try {
    assert.notEqual(bridge.port, occupiedPort);
    assert.match(bridge.httpBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(warnings.length, 1);

    const response = await fetch(`${bridge.httpBaseUrl}/json/version`);
    const payload = await response.json();
    assert.equal(payload.webSocketDebuggerUrl, bridge.browserWebSocketUrl);
  } finally {
    await bridge.stop();
    occupiedServer.close();
    await once(occupiedServer, "close");
  }
});

test("native host defaults to port 9222 when the preferred port is missing or invalid", () => {
  assert.equal(parsePreferredPort(undefined), 9222);
  assert.equal(parsePreferredPort("not-a-port"), 9222);
  assert.equal(parsePreferredPort("70000"), 9222);
  assert.equal(parsePreferredPort("9333"), 9333);
});

test("native host reads the initial hello message before bridge startup", async () => {
  const transport = new EventEmitter();
  const helloPromise = waitForInitialHello(transport, 100);

  queueMicrotask(() => {
    transport.emit("message", {
      type: "hello",
      version: "0.1.0",
      bridgePort: 9444
    });
  });

  await assert.doesNotReject(async () => {
    const hello = await helloPromise;
    assert.equal(hello.bridgePort, 9444);
  });
});

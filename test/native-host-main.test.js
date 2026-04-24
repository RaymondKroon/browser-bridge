import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { startBridgeServer } from "../src/native-host/main.js";
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

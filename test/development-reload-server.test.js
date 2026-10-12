import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DevelopmentReloadServer } from "../src/native-host/development-reload-server.js";

test("development reload server accepts only its authenticated fixed request", async () => {
  const requests = [];
  const token = randomBytes(32).toString("hex");
  const server = new DevelopmentReloadServer({
    config: { port: 0, requireToken: true, token },
    transport: {
      async request(action, payload) {
        requests.push({ action, payload });
        return { ok: true };
      }
    },
    logger: { warn() {} }
  });
  await server.start();
  const port = server.server.address().port;

  const post = (headers, body = '{"extensionId":"hacmcjjofinfaaahgdhopnnnipgjigge"}') =>
    fetch(`http://127.0.0.1:${port}/development/reload`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body
    });

  try {
    const accepted = await post({ authorization: `Bearer ${token}` });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true });
    assert.deepEqual(requests, [
      {
        action: "reloadDevelopmentExtension",
        payload: { extensionId: "hacmcjjofinfaaahgdhopnnnipgjigge" }
      }
    ]);

    const unauthorized = await post({ authorization: "Bearer wrong" });
    assert.equal(unauthorized.status, 401);
    assert.equal(requests.length, 1);

    const legacyPath = await fetch(
      `http://127.0.0.1:${port}/development/reload/hacmcjjofinfaaahgdhopnnnipgjigge`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: '{"extensionId":"hacmcjjofinfaaahgdhopnnnipgjigge"}'
      }
    );
    assert.equal(legacyPath.status, 404);
    assert.equal(requests.length, 1);

    const invalidId = await post({ authorization: `Bearer ${token}` }, '{"extensionId":"bad"}');
    assert.equal(invalidId.status, 400);
    assert.equal(requests.length, 1);

    const extraPayloadProperty = await post(
      { authorization: `Bearer ${token}` },
      '{"extensionId":"hacmcjjofinfaaahgdhopnnnipgjigge","action":"reload"}'
    );
    assert.equal(extraPayloadProperty.status, 400);
    assert.equal(requests.length, 1);
  } finally {
    await server.stop();
  }
});

test("development reload server defaults to unauthenticated loopback requests", async () => {
  const requests = [];
  const server = new DevelopmentReloadServer({
    config: { port: 0, requireToken: false },
    transport: {
      async request(action, payload) {
        requests.push({ action, payload });
        return { ok: true };
      }
    },
    logger: { warn() {} }
  });
  await server.start();
  const port = server.server.address().port;
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/development/reload`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"extensionId":"hacmcjjofinfaaahgdhopnnnipgjigge"}'
      }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(requests, [
      {
        action: "reloadDevelopmentExtension",
        payload: { extensionId: "hacmcjjofinfaaahgdhopnnnipgjigge" }
      }
    ]);
  } finally {
    await server.stop();
  }
});

test("development reload server propagates controller failures without masking their reason", async () => {
  const server = new DevelopmentReloadServer({
    config: { port: 0, requireToken: false },
    transport: {
      async request() {
        throw {
          code: -32603,
          message: "Could not establish connection. Receiving end does not exist."
        };
      }
    },
    logger: { warn() {} }
  });
  await server.start();
  const port = server.server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/development/reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"extensionId":"hacmcjjofinfaaahgdhopnnnipgjigge"}'
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "Could not establish connection. Receiving end does not exist."
    });
  } finally {
    await server.stop();
  }
});

test("development reload server keeps body validation errors generic", async () => {
  let requested = false;
  const server = new DevelopmentReloadServer({
    config: { port: 0, requireToken: false },
    transport: {
      async request() {
        requested = true;
        return { ok: true };
      }
    },
    logger: { warn() {} }
  });
  await server.start();
  const port = server.server.address().port;
  try {
    const invalidJson = await fetch(`http://127.0.0.1:${port}/development/reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"extensionId":'
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), { ok: false, error: "Invalid development reload request" });

    const oversized = await fetch(`http://127.0.0.1:${port}/development/reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `"${"a".repeat(2048)}"`
    });
    assert.equal(oversized.status, 413);
    assert.equal(requested, false);
  } finally {
    await server.stop();
  }
});

import http from "node:http";

async function listenOnFreePort() {
  const holder = http.createServer();
  await new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.listen(0, "127.0.0.1", resolve);
  });
  return holder;
}

test("development reload server retries while the port is being released", async () => {
  const holder = await listenOnFreePort();
  const port = holder.address().port;
  setTimeout(() => holder.close(), 30);

  const server = new DevelopmentReloadServer({
    config: { port, requireToken: false },
    transport: { request: async () => ({ ok: true }) },
    logger: { warn() {} },
    bindAttempts: 5,
    bindRetryDelayMs: 20
  });
  await server.start();
  try {
    assert.equal(server.server.address().port, port);
  } finally {
    await server.stop();
  }
});

test("development reload server fails after retries when the port stays occupied", async () => {
  const holder = await listenOnFreePort();
  const port = holder.address().port;

  const server = new DevelopmentReloadServer({
    config: { port, requireToken: false },
    transport: { request: async () => ({ ok: true }) },
    logger: { warn() {} },
    bindAttempts: 2,
    bindRetryDelayMs: 10
  });
  await assert.rejects(
    () => server.start(),
    (error) => error.code === "EADDRINUSE"
  );
  holder.close();
});

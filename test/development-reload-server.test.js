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

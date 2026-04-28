import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { NativeMessagingTransport } from "../src/native-host/native-messaging-transport.js";

class MockInput extends EventEmitter {
  resume() {}
}

class MockOutput extends EventEmitter {
  constructor({ failOnWrite = false } = {}) {
    super();
    this.failOnWrite = failOnWrite;
    this.destroyed = false;
    this.writableEnded = false;
  }

  write(_chunk) {
    if (this.failOnWrite) {
      queueMicrotask(() => {
        const error = new Error("write EPIPE");
        error.code = "EPIPE";
        this.destroyed = true;
        this.emit("error", error);
      });
    }
    return true;
  }
}

test("native messaging transport rejects pending requests when output breaks", async () => {
  const input = new MockInput();
  const output = new MockOutput({ failOnWrite: true });
  const transport = new NativeMessagingTransport({ input, output });
  const disconnectErrors = [];
  transport.on("disconnect", (error) => {
    disconnectErrors.push(error);
  });
  transport.start();

  await assert.rejects(
    transport.request("detach", { sessionId: "session-1" }),
    (error) => {
      assert.equal(error.code, "EPIPE");
      assert.match(error.message, /EPIPE/);
      return true;
    }
  );

  assert.equal(disconnectErrors.length, 1);
  await assert.rejects(
    transport.request("detach", { sessionId: "session-2" }),
    (error) => {
      assert.equal(error.code, "EPIPE");
      assert.match(error.message, /write EPIPE/);
      return true;
    }
  );
});

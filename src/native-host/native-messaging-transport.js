import { EventEmitter } from "node:events";
import { makeBridgeSessionId, toProtocolError } from "../bridge/constants.js";

export class NativeMessagingTransport extends EventEmitter {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    super();
    this.input = input;
    this.output = output;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.started = false;
    this.disconnected = false;
    this.disconnectError = null;
  }

  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.input.on("data", (chunk) => this.handleChunk(chunk));
    this.input.on("end", () => this.handleDisconnect(new Error("Native messaging input ended")));
    this.input.on("close", () =>
      this.handleDisconnect(new Error("Native messaging input closed"))
    );
    this.output.on("error", (error) => this.handleDisconnect(error));
    this.output.on("close", () =>
      this.handleDisconnect(new Error("Native messaging output closed"))
    );
    this.input.resume?.();
  }

  handleChunk(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) {
        return;
      }

      const payloadBuffer = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      let message;
      try {
        message = JSON.parse(payloadBuffer.toString("utf8"));
      } catch {
        continue;
      }

      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.type === "response" && message.requestId) {
      const pending = this.pending.get(message.requestId);
      if (!pending) {
        return;
      }

      this.pending.delete(message.requestId);
      if (message.ok === false) {
        pending.reject(message.error ?? new Error("Native host request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.type === "event") {
      this.emit("event", message.payload ?? message);
    }
  }

  handleDisconnect(error) {
    if (this.disconnected) {
      return;
    }

    this.disconnected = true;
    this.disconnectError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("disconnect", error);
  }

  sendRaw(message) {
    if (this.disconnected || this.output.destroyed || this.output.writableEnded) {
      throw this.disconnectError ?? new Error("Native messaging output is not writable");
    }

    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    const frame = Buffer.concat([header, payload]);

    try {
      this.output.write(frame);
    } catch (error) {
      this.handleDisconnect(error);
      throw error;
    }
  }

  notify(event, payload) {
    this.sendRaw({
      type: "event",
      event,
      payload
    });
  }

  async request(action, payload, timeoutMs = 10000) {
    const requestId = makeBridgeSessionId("request");
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject({
          code: -32000,
          message: "Native messaging request timed out",
          data: { action, timeoutMs }
        });
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });

    try {
      this.sendRaw({
        type: "request",
        requestId,
        action,
        payload
      });
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        this.pending.delete(requestId);
        pending.reject(error);
      }
    }

    try {
      return await response;
    } catch (error) {
      throw toProtocolError(error, "Extension bridge request failed");
    }
  }
}

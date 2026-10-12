import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const MAX_BODY_BYTES = 1024;
const RELOAD_PATH = "/development/reload";
// A previous host instance may still be exiting and holding the port.
const RELOAD_BIND_ATTEMPTS = 6;
const RELOAD_BIND_RETRY_DELAY_MS = 500;

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function tokensMatch(candidate, expected) {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
    chunks.push(chunk);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    !/^[a-p]{32}$/.test(payload.extensionId)
  ) {
    throw new Error("Request body must contain only a valid extensionId");
  }
  return payload;
}

export async function loadDevelopmentReloadConfig(configPath) {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const config = JSON.parse(raw);
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error("development reload config port must be an integer from 1024 through 65535");
  }
  const requireToken = config.requireToken === true;
  if (requireToken && (typeof config.token !== "string" || config.token.length < 32)) {
    throw new Error("development reload config token must be at least 32 characters when requireToken is true");
  }
  return { port: config.port, requireToken, ...(requireToken ? { token: config.token } : {}) };
}

export class DevelopmentReloadServer {
  constructor({ transport, config, logger = console, bindAttempts = RELOAD_BIND_ATTEMPTS, bindRetryDelayMs = RELOAD_BIND_RETRY_DELAY_MS } = {}) {
    this.transport = transport;
    this.config = config;
    this.logger = logger;
    this.server = null;
    this.bindAttempts = bindAttempts;
    this.bindRetryDelayMs = bindRetryDelayMs;
  }

  async start() {
    if (this.server) {
      return this;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= this.bindAttempts; attempt += 1) {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response);
      });
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.config.port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        this.server = server;
        return this;
      } catch (error) {
        server.close();
        if (error?.code !== "EADDRINUSE") {
          throw error;
        }
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, this.bindRetryDelayMs));
      }
    }
    throw lastError;
  }

  async stop() {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }

  async handleRequest(request, response) {
    let payload;
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (
        !isLoopbackAddress(request.socket.remoteAddress) ||
        request.method !== "POST" ||
        url.pathname !== RELOAD_PATH ||
        url.search ||
        request.headers["content-type"] !== "application/json"
      ) {
        writeJson(response, 404, { ok: false, error: "Not found" });
        return;
      }

      if (this.config.requireToken) {
        const authorization = request.headers.authorization;
        const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
        if (!tokensMatch(token, this.config.token)) {
          writeJson(response, 401, { ok: false, error: "Unauthorized" });
          return;
        }
      }

      payload = await readJsonBody(request);
    } catch (error) {
      const statusCode = error?.message === "Request body is too large" ? 413 : 400;
      this.logger.warn?.(`Development reload request rejected: ${error?.message ?? error}`);
      writeJson(response, statusCode, { ok: false, error: "Invalid development reload request" });
      return;
    }

    try {
      const result = await this.transport.request("reloadDevelopmentExtension", payload);
      writeJson(response, 200, result);
    } catch (error) {
      // The request itself was valid; the controller or target extension
      // rejected it. Surface the underlying reason (it originates from our
      // own controller extension) instead of a generic message.
      const message = error?.message ?? String(error);
      this.logger.warn?.(`Development reload request failed: ${message}`);
      writeJson(response, 502, { ok: false, error: message });
    }
  }
}

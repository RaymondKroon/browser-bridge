import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const MAX_BODY_BYTES = 1024;
const RELOAD_PATH_PATTERN = /^\/development\/reload\/([a-p]{32})$/;

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

  const text = Buffer.concat(chunks).toString("utf8");
  if (text !== "{}") {
    throw new Error("Request body must be exactly an empty JSON object");
  }
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
  constructor({ transport, config, logger = console }) {
    this.transport = transport;
    this.config = config;
    this.logger = logger;
    this.server = null;
  }

  async start() {
    if (this.server) {
      return this;
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return this;
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
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const pathMatch = RELOAD_PATH_PATTERN.exec(url.pathname);
      if (
        !isLoopbackAddress(request.socket.remoteAddress) ||
        request.method !== "POST" ||
        !pathMatch ||
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

      await readJsonBody(request);
      const result = await this.transport.request("reloadDevelopmentExtension", {
        extensionId: pathMatch[1]
      });
      writeJson(response, 200, result);
    } catch (error) {
      const statusCode = error?.message === "Request body is too large" ? 413 : 400;
      this.logger.warn?.(`Development reload request rejected: ${error?.message ?? error}`);
      writeJson(response, statusCode, { ok: false, error: "Invalid development reload request" });
    }
  }
}

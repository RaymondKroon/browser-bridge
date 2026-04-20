import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_VERSION,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  SUPPORTED_METHODS,
  createProtocolError,
  toProtocolError
} from "./constants.js";

function isLocalAddress(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function sendWsJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function normalizeTargetInfo(target, pageWebSocketDebuggerUrl) {
  return {
    targetId: target.targetId,
    type: target.type ?? "page",
    title: target.title ?? "",
    url: target.url ?? "about:blank",
    attached: Boolean(target.attached),
    canAccessOpener: false,
    browserContextId: "default",
    openerId: target.openerId ?? undefined,
    faviconUrl: target.faviconUrl ?? undefined,
    webSocketDebuggerUrl: pageWebSocketDebuggerUrl
  };
}

export class CdpBridgeServer {
  constructor({
    transport,
    host = DEFAULT_BRIDGE_HOST,
    port = DEFAULT_BRIDGE_PORT,
    logger = console
  }) {
    this.transport = transport;
    this.host = host;
    this.port = port;
    this.logger = logger;
    this.browserId = randomUUID();
    this.connections = new Set();
    this.sockets = new Set();
    this.server = null;
    this.wss = null;
    this.boundEventHandler = (event) => this.handleTransportEvent(event);
  }

  async start() {
    if (this.server) {
      return this;
    }

    this.server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => {
        this.sockets.delete(socket);
      });
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    this.port = this.server.address().port;
    this.transport.on("event", this.boundEventHandler);
    return this;
  }

  async stop() {
    this.transport.off("event", this.boundEventHandler);

    for (const connection of [...this.connections]) {
      await this.cleanupConnection(connection);
    }

    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
      this.wss.close();
      this.wss = null;
    }

    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  get browserWebSocketUrl() {
    return `ws://${this.host}:${this.port}/devtools/browser/${this.browserId}`;
  }

  get httpBaseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  async getVersionPayload() {
    let diagnostics = null;
    try {
      diagnostics = await this.transport.request("getDiagnostics", {});
    } catch {
      diagnostics = null;
    }

    return {
      Browser: diagnostics?.browserVersion ?? "CDT Extension Bridge/0.1.0",
      "Protocol-Version": BRIDGE_PROTOCOL_VERSION,
      "User-Agent": diagnostics?.userAgent ?? "CDT Extension Bridge",
      "V8-Version": diagnostics?.jsVersion ?? process.version,
      "WebKit-Version": "extension-bridge",
      webSocketDebuggerUrl: this.browserWebSocketUrl
    };
  }

  async listTargets() {
    const targets = await this.transport.request("listTargets", {});
    return targets.map((target) =>
      normalizeTargetInfo(
        target,
        `ws://${this.host}:${this.port}/devtools/page/${encodeURIComponent(target.targetId)}`
      )
    );
  }

  async handleHttpRequest(req, res) {
    if (!isLocalAddress(req.socket.remoteAddress)) {
      res.writeHead(403).end();
      return;
    }

    const requestUrl = new URL(req.url, this.httpBaseUrl);

    try {
      if (requestUrl.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: BRIDGE_VERSION }));
        return;
      }

      if (requestUrl.pathname === "/json/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(await this.getVersionPayload()));
        return;
      }

      if (requestUrl.pathname === "/json" || requestUrl.pathname === "/json/list") {
        const targets = await this.listTargets();
        const browserTarget = {
          id: this.browserId,
          type: "browser",
          title: "CDT Extension Bridge",
          url: this.httpBaseUrl,
          webSocketDebuggerUrl: this.browserWebSocketUrl
        };

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([browserTarget, ...targets]));
        return;
      }

      res.writeHead(404).end();
    } catch (error) {
      this.logger.error?.("HTTP handler failed", error);
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: toProtocolError(error, "Bridge unavailable") }));
    }
  }

  async handleUpgrade(req, socket, head) {
    if (!isLocalAddress(req.socket.remoteAddress)) {
      socket.destroy();
      return;
    }

    const requestUrl = new URL(req.url, this.httpBaseUrl);
    const browserPath =
      requestUrl.pathname === "/" ||
      requestUrl.pathname === "/devtools/browser" ||
      requestUrl.pathname === `/devtools/browser/${this.browserId}`;
    const pagePrefix = "/devtools/page/";

    if (!browserPath && !requestUrl.pathname.startsWith(pagePrefix)) {
      socket.destroy();
      return;
    }

    const mode = browserPath ? "browser" : "page";
    const targetId =
      mode === "page" ? decodeURIComponent(requestUrl.pathname.slice(pagePrefix.length)) : null;

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = {
        ws,
        mode,
        targetId,
        discoverTargets: false,
        pageSessionId: null,
        sessions: new Map(),
        initPromise: null
      };

      this.connections.add(connection);
      ws.on("message", (raw) => {
        void this.handleSocketMessage(connection, raw.toString());
      });
      ws.on("close", () => {
        void this.cleanupConnection(connection);
      });
      ws.on("error", () => {
        void this.cleanupConnection(connection);
      });

      if (mode === "page") {
        connection.initPromise = this.bootstrapPageConnection(connection);
      }
    });
  }

  async bootstrapPageConnection(connection) {
    const attachResult = await this.transport.request("attach", {
      targetId: connection.targetId,
      flatten: true
    });

    connection.pageSessionId = attachResult.sessionId;
    connection.sessions.set(attachResult.sessionId, {
      targetId: connection.targetId,
      root: true
    });
  }

  async cleanupConnection(connection) {
    if (!this.connections.has(connection)) {
      return;
    }

    this.connections.delete(connection);

    const detachPromises = [];
    for (const sessionId of connection.sessions.keys()) {
      detachPromises.push(
        this.transport.request("detach", { sessionId }).catch(() => undefined)
      );
    }

    await Promise.allSettled(detachPromises);
    connection.sessions.clear();

    try {
      connection.ws.close();
    } catch {
      // Ignore close races.
    }
    try {
      connection.ws.terminate();
    } catch {
      // Ignore terminate races.
    }
  }

  async handleSocketMessage(connection, rawText) {
    let message;
    try {
      message = JSON.parse(rawText);
    } catch (error) {
      sendWsJson(connection.ws, {
        id: null,
        error: toProtocolError(createProtocolError(-32700, "Invalid JSON"))
      });
      return;
    }

    if (connection.initPromise) {
      try {
        await connection.initPromise;
      } catch (error) {
        sendWsJson(connection.ws, {
          id: message.id ?? null,
          error: toProtocolError(error)
        });
        return;
      }
    }

    try {
      const result = await this.executeCommand(connection, message);
      if (message.id !== undefined) {
        sendWsJson(connection.ws, { id: message.id, result });
      }
    } catch (error) {
      if (message.id !== undefined) {
        sendWsJson(connection.ws, {
          id: message.id,
          error: toProtocolError(error)
        });
      }
    }
  }

  async executeCommand(connection, message) {
    if (!message?.method || typeof message.method !== "string") {
      throw createProtocolError(-32600, "Missing CDP method");
    }

    switch (message.method) {
      case "Browser.getVersion":
        return {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          product: "CDT Extension Bridge/0.1.0",
          revision: "extension-bridge",
          userAgent: "CDT Extension Bridge",
          jsVersion: process.version
        };
      case "Target.setDiscoverTargets":
        connection.discoverTargets = Boolean(message.params?.discover);
        return {};
      case "Target.getTargets": {
        const targetInfos = await this.listTargets();
        return { targetInfos };
      }
      case "Target.createTarget": {
        const result = await this.transport.request("createTarget", {
          url: message.params?.url ?? "about:blank"
        });
        return { targetId: result.targetId };
      }
      case "Target.attachToTarget": {
        const targetId = message.params?.targetId;
        if (!targetId) {
          throw createProtocolError(-32602, "Target.attachToTarget requires targetId");
        }

        const result = await this.transport.request("attach", {
          targetId,
          flatten: message.params?.flatten !== false
        });
        connection.sessions.set(result.sessionId, { targetId, root: true });
        return { sessionId: result.sessionId };
      }
      case "Target.detachFromTarget": {
        if (!message.params?.sessionId && !message.params?.targetId) {
          throw createProtocolError(
            -32602,
            "Target.detachFromTarget requires sessionId or targetId"
          );
        }

        await this.transport.request("detach", {
          sessionId: message.params?.sessionId,
          targetId: message.params?.targetId
        });

        if (message.params?.sessionId) {
          connection.sessions.delete(message.params.sessionId);
        }
        return {};
      }
      case "Target.activateTarget":
        await this.transport.request("activateTarget", {
          targetId: message.params?.targetId
        });
        return {};
      case "Target.closeTarget":
        await this.transport.request("closeTarget", {
          targetId: message.params?.targetId
        });
        return { success: true };
      default:
        break;
    }

    if (!SUPPORTED_METHODS.has(message.method)) {
      throw createProtocolError(-32601, "Method not supported", {
        method: message.method
      });
    }

    const sessionId = message.sessionId ?? connection.pageSessionId;
    if (!sessionId) {
      throw createProtocolError(-32000, "No active session for command", {
        method: message.method
      });
    }

    const session = connection.sessions.get(sessionId);
    const targetId = session?.targetId ?? connection.targetId ?? null;
    const result = await this.transport.request("sendCommand", {
      method: message.method,
      params: message.params ?? {},
      sessionId,
      targetId
    });

    if (message.method === "Target.attachToTarget" && result?.sessionId) {
      connection.sessions.set(result.sessionId, {
        targetId: message.params?.targetId ?? targetId,
        root: false
      });
    }

    if (message.method === "Target.detachFromTarget" && message.params?.sessionId) {
      connection.sessions.delete(message.params.sessionId);
    }

    return result ?? {};
  }

  handleTransportEvent(event) {
    if (!event || typeof event !== "object") {
      return;
    }

    if (event.type === "targetCreated" || event.type === "targetInfoChanged") {
      const method =
        event.type === "targetCreated" ? "Target.targetCreated" : "Target.targetInfoChanged";
      const pageWs = `ws://${this.host}:${this.port}/devtools/page/${encodeURIComponent(
        event.targetInfo.targetId
      )}`;
      const targetInfo = normalizeTargetInfo(event.targetInfo, pageWs);

      for (const connection of this.connections) {
        if (connection.mode === "browser" && connection.discoverTargets) {
          sendWsJson(connection.ws, { method, params: { targetInfo } });
        }
      }
      return;
    }

    if (event.type === "targetDestroyed") {
      for (const connection of this.connections) {
        if (connection.mode === "browser" && connection.discoverTargets) {
          sendWsJson(connection.ws, {
            method: "Target.targetDestroyed",
            params: { targetId: event.targetId }
          });
        }
      }
      return;
    }

    if (event.type !== "cdpEvent") {
      return;
    }

    for (const connection of this.connections) {
      if (connection.mode === "page") {
        if (
          event.sessionId === connection.pageSessionId ||
          (!event.sessionId && event.targetId === connection.targetId)
        ) {
          sendWsJson(connection.ws, {
            method: event.method,
            params: event.params ?? {}
          });
        }
        continue;
      }

      if (event.sessionId) {
        if (connection.sessions.has(event.sessionId)) {
          sendWsJson(connection.ws, {
            method: event.method,
            params: event.params ?? {},
            sessionId: event.sessionId
          });
        }
        continue;
      }

      if (!event.targetId) {
        continue;
      }

      for (const [sessionId, session] of connection.sessions.entries()) {
        if (session.root && session.targetId === event.targetId) {
          sendWsJson(connection.ws, {
            method: event.method,
            params: event.params ?? {},
            sessionId
          });
        }
      }
    }
  }
}

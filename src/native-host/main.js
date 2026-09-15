import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { BRIDGE_VERSION, DEFAULT_BRIDGE_PORT } from "../bridge/constants.js";
import { CdpBridgeServer } from "../bridge/cdp-bridge-server.js";
import { NativeMessagingTransport } from "./native-messaging-transport.js";
import { createCrashLogger } from "./crash-logger.js";
import {
  DevelopmentReloadServer,
  loadDevelopmentReloadConfig
} from "./development-reload-server.js";

const DEVELOPMENT_RELOAD_CONFIG_URL = new URL(
  "../../native-host/development-reload.config.json",
  import.meta.url
);

const INITIAL_HELLO_TIMEOUT_MS = 1000;
// The previous host instance may still be exiting and holding the port when a
// new one starts (stop/start toggling, extension reload). Retry the bind a
// few times before giving up on the preferred port.
const PORT_BIND_ATTEMPTS = 6;
const PORT_BIND_RETRY_DELAY_MS = 500;

export function parsePreferredPort(rawValue, fallback = DEFAULT_BRIDGE_PORT) {
  const parsed = Number.parseInt(rawValue ?? `${fallback}`, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : fallback;
}

export async function waitForInitialHello(transport, timeoutMs = INITIAL_HELLO_TIMEOUT_MS) {
  return await new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      transport.off?.("message", onMessage);
    };
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const onMessage = (message) => {
      if (message?.type === "hello") {
        settle(message);
      }
    };
    const timeout = setTimeout(() => settle(null), timeoutMs);

    transport.on("message", onMessage);
  });
}

export async function startBridgeServer({
  transport,
  preferredPort = DEFAULT_BRIDGE_PORT,
  logger = console,
  portAttempts = PORT_BIND_ATTEMPTS,
  portRetryDelayMs = PORT_BIND_RETRY_DELAY_MS
} = {}) {
  const tryStart = async (port) => {
    const bridge = new CdpBridgeServer({
      transport,
      port,
      logger
    });
    await bridge.start();
    return bridge;
  };

  const tryStartWithRetry = async (port) => {
    let lastError = null;
    for (let attempt = 1; attempt <= portAttempts; attempt += 1) {
      try {
        return await tryStart(port);
      } catch (error) {
        if (error?.code !== "EADDRINUSE") {
          throw error;
        }
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, portRetryDelayMs));
      }
    }
    throw lastError;
  };

  try {
    return await tryStartWithRetry(preferredPort);
  } catch (error) {
    if (error?.code !== "EADDRINUSE" || preferredPort === 0) {
      throw error;
    }

    logger.warn?.(
      `Bridge port ${preferredPort} is already in use; falling back to an ephemeral loopback port`
    );
    return await tryStart(0);
  }
}

export async function runNativeHost() {
  const crashLogger = createCrashLogger();
  crashLogger.installProcessHandlers();

  const tStart = Date.now();
  const transport = new NativeMessagingTransport();
  transport.start();

  const hello = await waitForInitialHello(transport);
  const tHello = Date.now();
  const preferredPort = parsePreferredPort(
    hello?.bridgePort,
    parsePreferredPort(process.env.CDT_BRIDGE_PORT)
  );
  const bridge = await startBridgeServer({ transport, preferredPort });
  const tBridge = Date.now();

  let reloadConfig = null;
  let reloadServer = null;
  if (!transport.disconnected) {
    reloadConfig = await loadDevelopmentReloadConfig(DEVELOPMENT_RELOAD_CONFIG_URL);
    if (reloadConfig) {
      try {
        reloadServer = await new DevelopmentReloadServer({ transport, config: reloadConfig }).start();
      } catch (error) {
        if (error?.code !== "EADDRINUSE") {
          await bridge.stop();
          throw error;
        }
        // The previous host may still hold the port; the development reload
        // endpoint is a convenience, so continue without it rather than crash.
        console.warn(
          `Development reload port ${reloadConfig.port} is unavailable; continuing without it`
        );
      }
    }
  }

  if (transport.disconnected) {
    // The extension went away during startup (fast stop/start toggling or an
    // extension reload); exit cleanly instead of logging a startup failure.
    await reloadServer?.stop();
    await bridge.stop();
    process.exit(0);
  }

  // The token stays out of bridgeStatus/diagnostics so CDP clients cannot read it.
  // It is sent only across native messaging for the extension popup to display.
  try {
    if (reloadConfig?.requireToken) {
      transport.notify("developmentReloadToken", { token: reloadConfig.token });
    }

    transport.notify("bridgeStatus", {
      connected: true,
      version: BRIDGE_VERSION,
      port: bridge.port,
      host: bridge.host,
      httpBaseUrl: bridge.httpBaseUrl,
      browserWebSocketUrl: bridge.browserWebSocketUrl,
      crashLogPath: crashLogger.logPath,
      developmentReload: reloadServer
        ? {
            enabled: true,
            host: "127.0.0.1",
            port: reloadConfig.port,
            path: "/development/reload",
            requireToken: reloadConfig.requireToken
          }
        : { enabled: false }
    });
  } catch {
    // The port went away between the check above and the notify.
    await reloadServer?.stop();
    await bridge.stop();
    process.exit(0);
  }

  transport.on("message", async (message) => {
    if (
      message?.type !== "developmentReloadControl" ||
      message.action !== "regenerateToken" ||
      !reloadConfig?.requireToken
    ) {
      return;
    }
    try {
      const token = randomBytes(32).toString("hex");
      reloadConfig.token = token;
      await writeFile(DEVELOPMENT_RELOAD_CONFIG_URL, `${JSON.stringify(reloadConfig, null, 2)}\n`, {
        mode: 0o600
      });
      transport.notify("developmentReloadToken", { token });
    } catch (error) {
      transport.notify("developmentReloadError", {
        message: `Could not regenerate development reload token: ${error?.message ?? error}`
      });
    }
  });

  crashLogger.append("boot", {
    pid: process.pid,
    bridgePort: bridge.port,
    startupMs: {
      hello: tHello - tStart,
      bridge: tBridge - tHello,
      reload: Date.now() - tBridge,
      total: Date.now() - tStart
    }
  });

  transport.on("disconnect", async (error) => {
    crashLogger.append("disconnect", {
      reason: error ? error.message ?? String(error) : null
    });
    await reloadServer?.stop();
    await bridge.stop();
    process.exit(0);
  });

  const shutdown = async () => {
    await reloadServer?.stop();
    await bridge.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

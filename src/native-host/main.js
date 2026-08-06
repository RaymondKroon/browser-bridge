import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { BRIDGE_VERSION, DEFAULT_BRIDGE_PORT } from "../bridge/constants.js";
import { CdpBridgeServer } from "../bridge/cdp-bridge-server.js";
import { NativeMessagingTransport } from "./native-messaging-transport.js";
import {
  DevelopmentReloadServer,
  loadDevelopmentReloadConfig
} from "./development-reload-server.js";

const DEVELOPMENT_RELOAD_CONFIG_URL = new URL(
  "../../native-host/development-reload.config.json",
  import.meta.url
);

const INITIAL_HELLO_TIMEOUT_MS = 1000;

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
  logger = console
}) {
  const tryStart = async (port) => {
    const bridge = new CdpBridgeServer({
      transport,
      port,
      logger
    });
    await bridge.start();
    return bridge;
  };

  try {
    return await tryStart(preferredPort);
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
  const transport = new NativeMessagingTransport();
  transport.start();

  const hello = await waitForInitialHello(transport);
  const preferredPort = parsePreferredPort(
    hello?.bridgePort,
    parsePreferredPort(process.env.CDT_BRIDGE_PORT)
  );
  const bridge = await startBridgeServer({ transport, preferredPort });
  const reloadConfig = await loadDevelopmentReloadConfig(DEVELOPMENT_RELOAD_CONFIG_URL);
  const reloadServer = reloadConfig
    ? await new DevelopmentReloadServer({ transport, config: reloadConfig }).start()
    : null;

  // The token stays out of bridgeStatus/diagnostics so CDP clients cannot read it.
  // It is sent only across native messaging for the extension popup to display.
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

  transport.on("disconnect", async () => {
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

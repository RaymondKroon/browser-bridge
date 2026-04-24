import { BRIDGE_VERSION, DEFAULT_BRIDGE_PORT } from "../bridge/constants.js";
import { CdpBridgeServer } from "../bridge/cdp-bridge-server.js";
import { NativeMessagingTransport } from "./native-messaging-transport.js";

function parsePreferredPort(rawValue) {
  const parsed = Number.parseInt(rawValue ?? `${DEFAULT_BRIDGE_PORT}`, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : DEFAULT_BRIDGE_PORT;
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

  const preferredPort = parsePreferredPort(process.env.CDT_BRIDGE_PORT);
  const bridge = await startBridgeServer({ transport, preferredPort });

  transport.notify("bridgeStatus", {
    connected: true,
    version: BRIDGE_VERSION,
    port: bridge.port,
    host: bridge.host,
    httpBaseUrl: bridge.httpBaseUrl,
    browserWebSocketUrl: bridge.browserWebSocketUrl
  });

  transport.on("disconnect", async () => {
    await bridge.stop();
    process.exit(0);
  });

  const shutdown = async () => {
    await bridge.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

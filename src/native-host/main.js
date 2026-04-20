import { BRIDGE_VERSION, DEFAULT_BRIDGE_PORT } from "../bridge/constants.js";
import { CdpBridgeServer } from "../bridge/cdp-bridge-server.js";
import { NativeMessagingTransport } from "./native-messaging-transport.js";

export async function runNativeHost() {
  const transport = new NativeMessagingTransport();
  transport.start();

  const preferredPort = Number.parseInt(
    process.env.CDT_BRIDGE_PORT ?? `${DEFAULT_BRIDGE_PORT}`,
    10
  );

  const bridge = new CdpBridgeServer({
    transport,
    port: Number.isFinite(preferredPort) ? preferredPort : DEFAULT_BRIDGE_PORT
  });

  await bridge.start();

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

import { runNativeHost } from "../src/native-host/main.js";
import { createCrashLogger } from "../src/native-host/crash-logger.js";

const crashLogger = createCrashLogger();

runNativeHost().catch((error) => {
  crashLogger.append("startup-failure", {
    message: error?.message ?? String(error),
    stack: error?.stack ?? null
  });
  console.error(error);
  process.exit(1);
});

import { runNativeHost } from "../src/native-host/main.js";
import { createCrashLogger } from "../src/native-host/crash-logger.js";

const crashLogger = createCrashLogger();

// Startup diagnostics: time from process start to finished module loading.
// A large value points at process-launch overhead (AV scanning, slow file
// system) rather than the bridge code itself.
crashLogger.append("host-start", {
  pid: process.pid,
  importMs: Math.round(Date.now() - performance.timeOrigin),
  execPath: process.execPath
});

runNativeHost().catch((error) => {
  crashLogger.append("startup-failure", {
    message: error?.message ?? String(error),
    stack: error?.stack ?? null
  });
  console.error(error);
  process.exit(1);
});

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function resolveCrashLogPath(env = process.env) {
  const base = env.CDT_BRIDGE_CRASH_LOG_DIR ?? path.join(homedir(), ".cdt-bridge");
  return path.join(base, "native-host-crash.log");
}

// Synchronous JSON-lines crash log for the native host. When launched via
// native messaging, console output is invisible, so the only way to see a
// crash is a file on disk. Writes are sync so the entry lands even when the
// process exits immediately after logging.
export function createCrashLogger(logPath = resolveCrashLogPath()) {
  let dirReady = false;
  let dirFailed = false;

  const ensureDir = () => {
    if (dirReady || dirFailed) {
      return dirReady;
    }
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      dirReady = true;
    } catch {
      dirFailed = true;
    }
    return dirReady;
  };

  const append = (type, detail = {}) => {
    if (!ensureDir()) {
      return false;
    }
    try {
      appendFileSync(
        logPath,
        `${JSON.stringify({ time: new Date().toISOString(), type, ...detail })}\n`
      );
      return true;
    } catch {
      return false;
    }
  };

  return {
    logPath,
    append,
    installProcessHandlers() {
      process.on("uncaughtException", (error) => {
        append("uncaughtException", {
          message: error?.message ?? String(error),
          stack: error?.stack ?? null
        });
        process.exit(1);
      });
      process.on("unhandledRejection", (reason) => {
        append("unhandledRejection", {
          message: reason instanceof Error ? reason.message : String(reason ?? "unknown"),
          stack: reason instanceof Error ? reason.stack ?? null : null
        });
        process.exit(1);
      });
    }
  };
}

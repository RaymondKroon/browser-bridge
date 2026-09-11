import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Rejections in this codebase are often plain protocol-error objects, not
// Error instances — serialize them so the log stays diagnosable.
function describeReason(reason) {
  if (reason instanceof Error) {
    return { message: reason.message, stack: reason.stack ?? null };
  }
  if (reason !== null && typeof reason === "object") {
    try {
      return { message: JSON.stringify(reason), stack: null };
    } catch {
      // Fall through to String() for circular/unsupported values.
    }
  }
  return { message: String(reason ?? "unknown"), stack: null };
}

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
        append("unhandledRejection", describeReason(reason));
        process.exit(1);
      });
    }
  };
}

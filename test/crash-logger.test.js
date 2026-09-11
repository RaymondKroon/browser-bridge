import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCrashLogger, resolveCrashLogPath } from "../src/native-host/crash-logger.js";

function readLogLines(logPath) {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("crash logger appends JSON lines to the log file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cdt-crash-"));
  const logger = createCrashLogger(path.join(dir, "nested", "crash.log"));

  assert.equal(logger.append("boot", { pid: 123 }), true);
  assert.equal(logger.append("disconnect", { reason: "pipe closed" }), true);

  const lines = readLogLines(logger.logPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "boot");
  assert.equal(lines[0].pid, 123);
  assert.match(lines[0].time, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(lines[1].type, "disconnect");
  assert.equal(lines[1].reason, "pipe closed");
});

test("crash logger resolves the default log path under the home directory", () => {
  const logPath = resolveCrashLogPath({});
  assert.equal(path.basename(logPath), "native-host-crash.log");
  assert.equal(path.basename(path.dirname(logPath)), ".cdt-bridge");
});

test("crash logger honors the CDT_BRIDGE_CRASH_LOG_DIR override", () => {
  const logPath = resolveCrashLogPath({ CDT_BRIDGE_CRASH_LOG_DIR: "/tmp/custom" });
  assert.equal(logPath, path.join("/tmp/custom", "native-host-crash.log"));
});

test("crash logger captures uncaught exceptions before exiting", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cdt-crash-"));
  const logPath = path.join(dir, "crash.log");
  const loggerPath = fileURLToPath(
    new URL("../src/native-host/crash-logger.js", import.meta.url)
  );
  const script = `
    import { createCrashLogger } from ${JSON.stringify(loggerPath)};
    createCrashLogger(${JSON.stringify(logPath)}).installProcessHandlers();
    throw new Error("kaboom");
  `;

  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
    child.on("close", resolve);
    child.on("error", reject);
  });

  assert.equal(status, 1);
  const lines = readLogLines(logPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "uncaughtException");
  assert.equal(lines[0].message, "kaboom");
  assert.match(lines[0].stack, /kaboom/);
});

test("crash logger serializes object rejection reasons", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cdt-crash-"));
  const logPath = path.join(dir, "crash.log");
  const loggerPath = fileURLToPath(
    new URL("../src/native-host/crash-logger.js", import.meta.url)
  );
  const reason = { code: -32003, message: "Blocked by allowlist", data: { url: "https://nu.nl" } };
  const script = `
    import { createCrashLogger } from ${JSON.stringify(loggerPath)};
    createCrashLogger(${JSON.stringify(logPath)}).installProcessHandlers();
    Promise.reject(${JSON.stringify(reason)});
  `;

  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
    child.on("close", resolve);
    child.on("error", reject);
  });

  assert.equal(status, 1);
  const lines = readLogLines(logPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "unhandledRejection");
  assert.equal(lines[0].message, JSON.stringify(reason));
  assert.equal(lines[0].message.includes("[object Object]"), false);
});

test("crash logger captures unhandled rejections before exiting", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cdt-crash-"));
  const logPath = path.join(dir, "crash.log");
  const loggerPath = fileURLToPath(
    new URL("../src/native-host/crash-logger.js", import.meta.url)
  );
  const script = `
    import { createCrashLogger } from ${JSON.stringify(loggerPath)};
    createCrashLogger(${JSON.stringify(logPath)}).installProcessHandlers();
    Promise.reject(new Error("rejection kaboom"));
  `;

  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
    child.on("close", resolve);
    child.on("error", reject);
  });

  assert.equal(status, 1);
  const lines = readLogLines(logPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "unhandledRejection");
  assert.equal(lines[0].message, "rejection kaboom");
});

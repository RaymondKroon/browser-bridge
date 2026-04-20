import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { CdpBridgeServer } from "../src/bridge/cdp-bridge-server.js";
import { FakeExtensionTransport } from "./fake-extension-transport.js";

function runAgentBrowser(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const command = isWindows
      ? path.resolve(
          process.cwd(),
          "node_modules",
          "agent-browser",
          "bin",
          "agent-browser-win32-x64.exe"
        )
      : path.resolve(process.cwd(), "node_modules", ".bin", "agent-browser");
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0"
      }
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}\nTimed out after ${timeoutMs}ms`
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function cleanupAgentBrowser(sessionName) {
  if (sessionName) {
    await runAgentBrowser(["--session", sessionName, "close", "--all"], 5000).catch(() => undefined);
    return;
  }

  await runAgentBrowser(["close", "--all"], 5000).catch(() => undefined);
}

test("agent-browser accepts an HTTP CDP endpoint", { timeout: 20000 }, async () => {
  const transport = new FakeExtensionTransport();
  const bridge = new CdpBridgeServer({ transport, port: 0 });
  const sessionName = `bridge-http-${Date.now()}`;
  await bridge.start();

  try {
    await cleanupAgentBrowser(sessionName);
    const result = await runAgentBrowser([
      "--session",
      sessionName,
      "connect",
      `${bridge.port}`
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
  } finally {
    await cleanupAgentBrowser(sessionName);
    await bridge.stop();
  }
});

test("agent-browser accepts a root websocket CDP URL", { timeout: 20000 }, async () => {
  const transport = new FakeExtensionTransport();
  const bridge = new CdpBridgeServer({ transport, port: 0 });
  const sessionName = `bridge-root-${Date.now()}`;
  await bridge.start();

  try {
    await cleanupAgentBrowser(sessionName);
    const result = await runAgentBrowser([
      "--session",
      sessionName,
      "connect",
      `ws://127.0.0.1:${bridge.port}`
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
  } finally {
    await cleanupAgentBrowser(sessionName);
    await bridge.stop();
  }
});

test("agent-browser can take an interactive snapshot", { timeout: 20000 }, async () => {
  const transport = new FakeExtensionTransport();
  const bridge = new CdpBridgeServer({ transport, port: 0 });
  const sessionName = `bridge-snapshot-${Date.now()}`;
  await bridge.start();

  try {
    await cleanupAgentBrowser(sessionName);
    const result = await runAgentBrowser([
      "--session",
      sessionName,
      "--cdp",
      `${bridge.port}`,
      "snapshot",
      "-i"
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /RootWebArea|button|Search/);
  } finally {
    await cleanupAgentBrowser(sessionName);
    await bridge.stop();
  }
});

test("agent-browser can list tabs without an explicit session", { timeout: 20000 }, async () => {
  const transport = new FakeExtensionTransport();
  const bridge = new CdpBridgeServer({ transport, port: 0 });
  await bridge.start();

  try {
    await cleanupAgentBrowser();
    const result = await runAgentBrowser([
      "--cdp",
      `${bridge.port}`,
      "tab",
      "list"
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Fake Page|about:blank/);
  } finally {
    await cleanupAgentBrowser();
    await bridge.stop();
  }
});

test("agent-browser can take an interactive snapshot without an explicit session", { timeout: 20000 }, async () => {
  const transport = new FakeExtensionTransport();
  const bridge = new CdpBridgeServer({ transport, port: 0 });
  await bridge.start();

  try {
    await cleanupAgentBrowser();
    const result = await runAgentBrowser([
      "--cdp",
      `${bridge.port}`,
      "snapshot",
      "-i"
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /button|Search/);
  } finally {
    await cleanupAgentBrowser();
    await bridge.stop();
  }
});

test("agent-browser cookie commands use Network cookie methods", { timeout: 30000 }, async () => {
  const transport = new FakeExtensionTransport();
  const bridge = new CdpBridgeServer({ transport, port: 0 });
  const sessionName = `bridge-cookies-${Date.now()}`;
  await bridge.start();

  try {
    await cleanupAgentBrowser(sessionName);
    const result = await runAgentBrowser([
      "--session",
      sessionName,
      "--cdp",
      `${bridge.port}`,
      "batch",
      "open https://example.com",
      "cookies set session abc --url https://example.com",
      "cookies --json",
      "cookies clear"
    ], 20000);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.ok(
      transport.commandLog.some(({ method }) => method === "Network.setCookies"),
      "expected agent-browser to call Network.setCookies"
    );
    assert.ok(
      transport.commandLog.some(({ method }) => method === "Network.getCookies"),
      "expected agent-browser to call Network.getCookies"
    );
    assert.ok(
      transport.commandLog.some(({ method }) => method === "Network.clearBrowserCookies"),
      "expected agent-browser to call Network.clearBrowserCookies"
    );
  } finally {
    await cleanupAgentBrowser(sessionName);
    await bridge.stop();
  }
});

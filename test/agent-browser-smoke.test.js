import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CdpBridgeServer } from "../src/bridge/cdp-bridge-server.js";
import { FakeExtensionTransport } from "./fake-extension-transport.js";

function runAgentBrowser(args, { timeoutMs = 15000, env = {} } = {}) {
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
        ...env,
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

async function cleanupAgentBrowser(sessionName, env) {
  if (sessionName) {
    await runAgentBrowser(["--session", sessionName, "close", "--all"], {
      timeoutMs: 5000,
      env
    }).catch(() => undefined);
    return;
  }

  await runAgentBrowser(["close", "--all"], { timeoutMs: 5000, env }).catch(() => undefined);
}

async function withAgentBrowserEnv(run) {
  const agentBrowserHome = await mkdtemp(path.join(tmpdir(), "browser-bridge-agent-browser-"));
  const env = {
    AGENT_BROWSER_HOME: agentBrowserHome,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "100"
  };

  try {
    await run(env);
  } finally {
    await rm(agentBrowserHome, { recursive: true, force: true });
  }
}

function assertAgentBrowserSuccess(t, result) {
  const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
  if (
    /Daemon process exited during startup with no error output/.test(output) ||
    /daemon may be busy or unresponsive/.test(output) ||
    /Failed to connect: .*os error 10061/.test(output)
  ) {
    t.skip("agent-browser daemon is unavailable in this environment");
    return false;
  }

  assert.equal(result.code, 0, result.stderr || result.stdout);
  return true;
}

test("agent-browser accepts an HTTP CDP endpoint", { timeout: 20000 }, async (t) => {
  await withAgentBrowserEnv(async (env) => {
    const transport = new FakeExtensionTransport();
    const bridge = new CdpBridgeServer({ transport, port: 0 });
    const sessionName = `bridge-http-${Date.now()}`;
    await bridge.start();

    try {
      await cleanupAgentBrowser(sessionName, env);
      const result = await runAgentBrowser(
        ["--session", sessionName, "connect", `${bridge.port}`],
        { env }
      );

      if (!assertAgentBrowserSuccess(t, result)) {
        return;
      }
    } finally {
      await cleanupAgentBrowser(sessionName, env);
      await bridge.stop();
    }
  });
});

test("agent-browser accepts a root websocket CDP URL", { timeout: 20000 }, async (t) => {
  await withAgentBrowserEnv(async (env) => {
    const transport = new FakeExtensionTransport();
    const bridge = new CdpBridgeServer({ transport, port: 0 });
    const sessionName = `bridge-root-${Date.now()}`;
    await bridge.start();

    try {
      await cleanupAgentBrowser(sessionName, env);
      const result = await runAgentBrowser(
        ["--session", sessionName, "connect", `ws://127.0.0.1:${bridge.port}`],
        { env }
      );

      if (!assertAgentBrowserSuccess(t, result)) {
        return;
      }
    } finally {
      await cleanupAgentBrowser(sessionName, env);
      await bridge.stop();
    }
  });
});

test("agent-browser can take an interactive snapshot", { timeout: 20000 }, async (t) => {
  await withAgentBrowserEnv(async (env) => {
    const transport = new FakeExtensionTransport();
    const bridge = new CdpBridgeServer({ transport, port: 0 });
    const sessionName = `bridge-snapshot-${Date.now()}`;
    await bridge.start();

    try {
      await cleanupAgentBrowser(sessionName, env);
      const result = await runAgentBrowser(
        ["--session", sessionName, "--cdp", `${bridge.port}`, "snapshot", "-i"],
        { env }
      );

      if (!assertAgentBrowserSuccess(t, result)) {
        return;
      }
      assert.match(result.stdout, /RootWebArea|button|Search/);
    } finally {
      await cleanupAgentBrowser(sessionName, env);
      await bridge.stop();
    }
  });
});

test("agent-browser can list tabs after connecting a named session", { timeout: 30000 }, async (t) => {
  await withAgentBrowserEnv(async (env) => {
    const transport = new FakeExtensionTransport();
    const bridge = new CdpBridgeServer({ transport, port: 0 });
    const sessionName = `bridge-tabs-${Date.now()}`;
    await bridge.start();

    try {
      await cleanupAgentBrowser(sessionName, env);
      const connectResult = await runAgentBrowser(
        ["--session", sessionName, "connect", `${bridge.port}`],
        { env }
      );
      if (!assertAgentBrowserSuccess(t, connectResult)) {
        return;
      }

      const result = await runAgentBrowser(["--session", sessionName, "tab", "list"], { env });
      if (!assertAgentBrowserSuccess(t, result)) {
        return;
      }
      assert.match(result.stdout, /Fake Page|about:blank/);
    } finally {
      await cleanupAgentBrowser(sessionName, env);
      await bridge.stop();
    }
  });
});

test("agent-browser cookie commands use Network cookie methods", { timeout: 30000 }, async (t) => {
  await withAgentBrowserEnv(async (env) => {
    const transport = new FakeExtensionTransport();
    const bridge = new CdpBridgeServer({ transport, port: 0 });
    const sessionName = `bridge-cookies-${Date.now()}`;
    await bridge.start();

    try {
      await cleanupAgentBrowser(sessionName, env);
      const result = await runAgentBrowser(
        [
          "--session",
          sessionName,
          "--cdp",
          `${bridge.port}`,
          "batch",
          "open https://example.com",
          "cookies set session abc --url https://example.com",
          "cookies --json",
          "cookies clear"
        ],
        { timeoutMs: 20000, env }
      );

      if (!assertAgentBrowserSuccess(t, result)) {
        return;
      }
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
      await cleanupAgentBrowser(sessionName, env);
      await bridge.stop();
    }
  });
});

test("agent-browser can set the viewport through browser-scoped CDP methods", { timeout: 20000 }, async (t) => {
  await withAgentBrowserEnv(async (env) => {
    const transport = new FakeExtensionTransport();
    const bridge = new CdpBridgeServer({ transport, port: 0 });
    const sessionName = `bridge-viewport-${Date.now()}`;
    await bridge.start();

    try {
      await cleanupAgentBrowser(sessionName, env);
      const result = await runAgentBrowser(
        ["--session", sessionName, "--cdp", `${bridge.port}`, "set", "viewport", "1280", "720"],
        { env }
      );
      if (!assertAgentBrowserSuccess(t, result)) {
        return;
      }

      assert.ok(
        transport.commandLog.some(({ method }) => method === "Emulation.setDeviceMetricsOverride"),
        "expected agent-browser to call Emulation.setDeviceMetricsOverride"
      );
      assert.ok(
        transport.commandLog.some(({ method }) => method === "Browser.getWindowForTarget"),
        "expected agent-browser to call Browser.getWindowForTarget"
      );
      assert.ok(
        transport.commandLog.some(({ method }) => method === "Browser.setContentsSize"),
        "expected agent-browser to call Browser.setContentsSize"
      );
    } finally {
      await cleanupAgentBrowser(sessionName, env);
      await bridge.stop();
    }
  });
});

test("agent-browser can highlight a snapshot reference", { timeout: 20000 }, async (t) => {
  await withAgentBrowserEnv(async (env) => {
    const transport = new FakeExtensionTransport();
    const bridge = new CdpBridgeServer({ transport, port: 0 });
    const sessionName = `bridge-highlight-${Date.now()}`;
    await bridge.start();

    try {
      await cleanupAgentBrowser(sessionName, env);
      const result = await runAgentBrowser(
        ["--session", sessionName, "--cdp", `${bridge.port}`, "batch", "snapshot -i", "highlight @e1"],
        { env }
      );
      if (!assertAgentBrowserSuccess(t, result)) {
        return;
      }

      assert.ok(
        transport.commandLog.some(({ method }) => method === "DOM.resolveNode"),
        "expected agent-browser to call DOM.resolveNode"
      );
      assert.ok(
        transport.commandLog.some(({ method }) => method === "Runtime.callFunctionOn"),
        "expected agent-browser to call Runtime.callFunctionOn"
      );
    } finally {
      await cleanupAgentBrowser(sessionName, env);
      await bridge.stop();
    }
  });
});

test("agent-browser can save a trace through the bridge", { timeout: 30000 }, async (t) => {
  await withAgentBrowserEnv(async (env) => {
    const transport = new FakeExtensionTransport();
    const bridge = new CdpBridgeServer({ transport, port: 0 });
    const sessionName = `bridge-trace-${Date.now()}`;
    const traceDir = await mkdtemp(path.join(tmpdir(), "browser-bridge-trace-output-"));
    const tracePath = path.join(traceDir, "bridge-trace.zip");
    await bridge.start();

    try {
      await cleanupAgentBrowser(sessionName, env);
      const result = await runAgentBrowser(
        ["--session", sessionName, "--cdp", `${bridge.port}`, "batch", "trace start", `trace stop ${tracePath}`],
        { timeoutMs: 20000, env }
      );
      if (!assertAgentBrowserSuccess(t, result)) {
        return;
      }

      const info = await stat(tracePath);
      assert.ok(info.size > 0, "expected trace output to be written");
      assert.ok(
        transport.commandLog.some(({ method }) => method === "Tracing.start"),
        "expected agent-browser to call Tracing.start"
      );
      assert.ok(
        transport.commandLog.some(({ method }) => method === "Tracing.end"),
        "expected agent-browser to call Tracing.end"
      );
      assert.ok(
        transport.commandLog.some(({ method }) => method === "IO.read"),
        "expected agent-browser to call IO.read"
      );
    } finally {
      await cleanupAgentBrowser(sessionName, env);
      await bridge.stop();
      await rm(traceDir, { recursive: true, force: true });
    }
  });
});

test("agent-browser can save a performance profile through the bridge", { timeout: 30000 }, async (t) => {
  await withAgentBrowserEnv(async (env) => {
    const transport = new FakeExtensionTransport();
    const bridge = new CdpBridgeServer({ transport, port: 0 });
    const sessionName = `bridge-profile-${Date.now()}`;
    const profileDir = await mkdtemp(path.join(tmpdir(), "browser-bridge-profile-output-"));
    const profilePath = path.join(profileDir, "bridge.cpuprofile");
    await bridge.start();

    try {
      await cleanupAgentBrowser(sessionName, env);
      const result = await runAgentBrowser(
        [
          "--session",
          sessionName,
          "--cdp",
          `${bridge.port}`,
          "batch",
          "open https://example.com",
          "profiler start",
          `profiler stop ${profilePath}`
        ],
        { timeoutMs: 20000, env }
      );
      if (!assertAgentBrowserSuccess(t, result)) {
        return;
      }

      const info = await stat(profilePath);
      assert.ok(info.size > 0, "expected profile output to be written");
      assert.ok(
        transport.commandLog.some(({ method }) => method === "Tracing.start"),
        "expected profiler flow to call Tracing.start"
      );
      assert.ok(
        transport.commandLog.some(({ method }) => method === "Tracing.end"),
        "expected profiler flow to call Tracing.end"
      );
    } finally {
      await cleanupAgentBrowser(sessionName, env);
      await bridge.stop();
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});

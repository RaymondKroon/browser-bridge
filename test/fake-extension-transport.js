import { EventEmitter } from "node:events";
import { makeBridgeSessionId } from "../src/bridge/constants.js";

export class FakeExtensionTransport extends EventEmitter {
  constructor() {
    super();
    this.targets = new Map([
      [
        "page:1",
        {
          targetId: "page:1",
          tabId: 1,
          type: "page",
          title: "Fake Page",
          url: "about:blank",
          attached: false
        }
      ]
    ]);
    this.sessions = new Map();
    this.cookies = [];
    this.commandLog = [];
    this.ioStreams = new Map();
    this.traceSequence = 0;
    this.tracingState = null;
  }

  async request(action, payload) {
    switch (action) {
      case "getDiagnostics":
        return {
          browserVersion: "FakeBrowser/1.0",
          userAgent: "FakeBrowser/1.0",
          jsVersion: "FakeJS/1.0",
          crashLog: []
        };
      case "listTargets":
        return [...this.targets.values()];
      case "createTarget": {
        const targetId = `page:${this.targets.size + 1}`;
        this.targets.set(targetId, {
          targetId,
          tabId: this.targets.size + 1,
          type: "page",
          title: payload.url,
          url: payload.url,
          attached: false
        });
        this.emit("event", {
          type: "targetCreated",
          targetInfo: this.targets.get(targetId)
        });
        return { targetId };
      }
      case "attach": {
        const sessionId = makeBridgeSessionId("session");
        this.sessions.set(sessionId, payload.targetId);
        const target = this.targets.get(payload.targetId);
        if (target) {
          target.attached = true;
        }
        return { sessionId };
      }
      case "detach":
        if (payload.sessionId) {
          const targetId = this.sessions.get(payload.sessionId);
          this.sessions.delete(payload.sessionId);
          if (targetId && this.targets.has(targetId)) {
            this.targets.get(targetId).attached = false;
          }
        }
        return {};
      case "activateTarget":
        return { success: true };
      case "closeTarget":
        if (payload.targetId && this.targets.has(payload.targetId)) {
          this.targets.delete(payload.targetId);
          this.emit("event", {
            type: "targetDestroyed",
            targetId: payload.targetId
          });
        }
        return { success: true };
      case "sendCommand":
        return this.handleCommand(payload);
      default:
        throw new Error(`Unsupported fake action: ${action}`);
    }
  }

  async handleCommand({ method, params, sessionId, targetId }) {
    this.commandLog.push({ method, params, sessionId, targetId });

    switch (method) {
      case "Browser.getWindowForTarget":
        return {
          windowId: 1,
          bounds: {
            left: 0,
            top: 0,
            width: 1280,
            height: 720,
            windowState: "normal"
          }
        };
      case "Browser.grantPermissions":
      case "Browser.setContentsSize":
      case "Browser.setDownloadBehavior":
      case "Page.enable":
      case "Page.addScriptToEvaluateOnNewDocument":
      case "Page.handleJavaScriptDialog":
      case "Runtime.enable":
      case "Runtime.runIfWaitingForDebugger":
      case "Accessibility.enable":
      case "Network.enable":
      case "Network.emulateNetworkConditions":
      case "Network.setExtraHTTPHeaders":
      case "DOM.enable":
      case "Target.setAutoAttach":
      case "Fetch.continueWithAuth":
      case "Profiler.start":
      case "Security.setIgnoreCertificateErrors":
        return {};
      case "Tracing.start":
        this.tracingState = {
          categories: params?.categories ?? "",
          sessionId,
          targetId
        };
        return {};
      case "Tracing.end": {
        const stream = `trace-stream-${++this.traceSequence}`;
        this.ioStreams.set(stream, {
          data: this.buildTracePayload(),
          offset: 0
        });
        queueMicrotask(() => {
          this.emit("event", {
            type: "cdpEvent",
            targetId,
            sessionId: this.tracingState?.sessionId ?? sessionId,
            method: "Tracing.tracingComplete",
            params: {
              dataLossOccurred: false,
              stream
            }
          });
        });
        this.tracingState = null;
        return {};
      }
      case "Page.captureScreenshot":
        return {
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnR4V8AAAAASUVORK5CYII="
        };
      case "Page.getFrameTree":
        return {
          frameTree: {
            frame: {
              id: "frame-1",
              url: this.targets.get(targetId)?.url ?? "about:blank",
              domainAndRegistry: "",
              securityOrigin: "null",
              mimeType: "text/html"
            }
          }
        };
      case "Page.getLayoutMetrics":
        return {
          layoutViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1280,
            clientHeight: 720
          },
          visualViewport: {
            offsetX: 0,
            offsetY: 0,
            pageX: 0,
            pageY: 0,
            clientWidth: 1280,
            clientHeight: 720,
            scale: 1,
            zoom: 1
          },
          contentSize: {
            x: 0,
            y: 0,
            width: 1280,
            height: 720
          },
          cssLayoutViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1280,
            clientHeight: 720
          },
          cssVisualViewport: {
            offsetX: 0,
            offsetY: 0,
            pageX: 0,
            pageY: 0,
            clientWidth: 1280,
            clientHeight: 720,
            scale: 1,
            zoom: 1
          },
          cssContentSize: {
            x: 0,
            y: 0,
            width: 1280,
            height: 720
          }
        };
      case "Page.printToPDF":
        return {
          data: "JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nPj4KZW5kb2JqCnRyYWlsZXIKPDwvUm9vdCAxIDAgUj4+CiUlRU9G"
        };
      case "Page.setDocumentContent":
        return {};
      case "Page.navigate": {
        const target = this.targets.get(targetId);
        if (target) {
          target.url = params.url;
          target.title = params.url;
        }
        queueMicrotask(() => {
          this.emit("event", {
            type: "cdpEvent",
            targetId,
            sessionId,
            method: "Page.loadEventFired",
            params: { timestamp: Date.now() / 1000 }
          });
        });
        return { frameId: "frame-1", loaderId: "loader-1" };
      }
      case "Runtime.evaluate":
        return {
          result: {
            type: "string",
            value:
              params.expression === "document.title"
                ? this.targets.get(targetId)?.title ?? ""
                : params.expression === "location.href"
                  ? this.targets.get(targetId)?.url ?? "about:blank"
                  : "ok"
          }
        };
      case "Runtime.callFunctionOn":
        return {
          result: {
            type: "string",
            value: "ok"
          }
        };
      case "Network.getAllCookies":
      case "Network.getCookies":
      case "Storage.getCookies":
        return {
          cookies: this.getCookiesForRequest(method, params, targetId)
        };
      case "Network.getResponseBody":
        return {
          body: "",
          base64Encoded: false
        };
      case "Network.setCookies":
      case "Storage.setCookies":
        this.setCookies(params?.cookies ?? []);
        return {};
      case "Network.clearBrowserCookies":
        this.cookies = [];
        return {};
      case "Storage.clearDataForOrigin":
        if (params?.storageTypes?.split(",").includes("cookies")) {
          this.cookies = this.cookies.filter((cookie) => !this.cookieMatchesOrigin(cookie, params.origin));
        }
        return {};
      case "IO.close":
        if (params?.handle) {
          this.ioStreams.delete(params.handle);
        }
        return {};
      case "IO.read":
        return this.readStream(params?.handle);
      case "Profiler.stop":
        return {
          profile: {
            nodes: [],
            startTime: 0,
            endTime: 0,
            samples: [],
            timeDeltas: []
          }
        };
      case "DOM.getDocument":
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: 9,
            nodeName: "#document",
            localName: "",
            childNodeCount: 1
          }
        };
      case "DOM.resolveNode":
        return {
          object: {
            type: "object",
            className: "HTMLButtonElement",
            description: "button",
            objectId: `node-${params?.backendNodeId ?? 2}`
          }
        };
      case "Overlay.highlightNode":
      case "Overlay.hideHighlight":
        return {};
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            {
              nodeId: "1",
              role: { type: "role", value: "RootWebArea" },
              name: { type: "computedString", value: "Fake Page" },
              childIds: ["2"],
              backendDOMNodeId: 1,
              ignored: false
            },
            {
              nodeId: "2",
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Search" },
              backendDOMNodeId: 2,
              ignored: false
            }
          ]
        };
      default:
        return {};
    }
  }

  getCookiesForRequest(method, params, targetId) {
    if (method === "Storage.getCookies") {
      return [...this.cookies];
    }

    const requestedUrls =
      params?.urls?.length > 0 ? params.urls : [this.targets.get(targetId)?.url].filter(Boolean);

    if (requestedUrls.length === 0) {
      return [...this.cookies];
    }

    return this.cookies.filter((cookie) =>
      requestedUrls.some((requestedUrl) => this.cookieMatchesUrl(cookie, requestedUrl))
    );
  }

  setCookies(cookieParams) {
    for (const cookieParam of cookieParams) {
      const cookie = this.normalizeCookie(cookieParam);
      this.cookies = this.cookies.filter(
        (existingCookie) =>
          !(
            existingCookie.name === cookie.name &&
            existingCookie.domain === cookie.domain &&
            existingCookie.path === cookie.path
          )
      );
      this.cookies.push(cookie);
    }
  }

  normalizeCookie(cookieParam) {
    const cookieUrl = cookieParam.url ? new URL(cookieParam.url) : null;
    const domain = cookieParam.domain ?? cookieUrl?.hostname ?? "example.com";
    const path = cookieParam.path ?? this.normalizePath(cookieUrl?.pathname);
    const expires = cookieParam.expires ?? -1;
    const session = expires === -1;

    return {
      name: cookieParam.name,
      value: cookieParam.value,
      domain,
      path,
      expires,
      size: `${cookieParam.name ?? ""}${cookieParam.value ?? ""}`.length,
      httpOnly: Boolean(cookieParam.httpOnly),
      secure: Boolean(cookieParam.secure),
      session,
      sameSite: cookieParam.sameSite ?? "Lax",
      priority: cookieParam.priority ?? "Medium"
    };
  }

  normalizePath(pathname) {
    if (!pathname || pathname === "") {
      return "/";
    }

    return pathname.startsWith("/") ? pathname : `/${pathname}`;
  }

  cookieMatchesUrl(cookie, requestedUrl) {
    try {
      const url = new URL(requestedUrl);
      const hostname = url.hostname;
      const normalizedDomain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
      const domainMatches =
        hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
      const pathMatches = url.pathname.startsWith(cookie.path);
      return domainMatches && pathMatches;
    } catch {
      return false;
    }
  }

  cookieMatchesOrigin(cookie, origin) {
    try {
      const url = new URL(origin);
      const hostname = url.hostname;
      const normalizedDomain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
      return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
    } catch {
      return false;
    }
  }

  buildTracePayload() {
    return JSON.stringify({
      traceEvents: [
        {
          pid: 1,
          tid: 1,
          ts: 0,
          ph: "M",
          cat: "__metadata",
          name: "process_name",
          args: {
            name: "Fake Renderer"
          }
        }
      ],
      metadata: {
        source: "fake-extension-transport"
      }
    });
  }

  readStream(handle) {
    const stream = this.ioStreams.get(handle);
    if (!stream) {
      return {
        data: "",
        base64Encoded: false,
        eof: true
      };
    }

    const data = stream.data.slice(stream.offset);
    stream.offset = stream.data.length;
    return {
      data,
      base64Encoded: false,
      eof: true
    };
  }
}

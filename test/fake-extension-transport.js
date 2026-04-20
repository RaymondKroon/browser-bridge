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
  }

  async request(action, payload) {
    switch (action) {
      case "getDiagnostics":
        return {
          browserVersion: "FakeBrowser/1.0",
          userAgent: "FakeBrowser/1.0",
          jsVersion: "FakeJS/1.0"
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
      case "closeTarget":
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
      case "Page.enable":
      case "Runtime.enable":
      case "Runtime.runIfWaitingForDebugger":
      case "Accessibility.enable":
      case "Network.enable":
      case "DOM.enable":
      case "Target.setAutoAttach":
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
      case "Network.getCookies":
      case "Storage.getCookies":
        return {
          cookies: this.getCookiesForRequest(method, params, targetId)
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
}

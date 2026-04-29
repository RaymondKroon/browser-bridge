import { randomUUID } from "node:crypto";

export const BRIDGE_VERSION = "0.1.0";
export const BRIDGE_PROTOCOL_VERSION = "1.3";
export const HOST_NAME = "com.cdt_bridge";
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 9222;

export const SUPPORTED_METHODS = new Set([
  "Browser.getVersion",
  "Browser.getWindowForTarget",
  "Browser.grantPermissions",
  "Browser.setContentsSize",
  "Browser.setDownloadBehavior",
  "Target.getTargets",
  "Target.setDiscoverTargets",
  "Target.createTarget",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Target.activateTarget",
  "Target.closeTarget",
  "Target.setAutoAttach",
  "Page.enable",
  "Page.navigate",
  "Page.reload",
  "Page.bringToFront",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.captureScreenshot",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.handleJavaScriptDialog",
  "Page.printToPDF",
  "Page.setDocumentContent",
  "Runtime.enable",
  "Runtime.callFunctionOn",
  "Runtime.evaluate",
  "Runtime.runIfWaitingForDebugger",
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Network.enable",
  "Network.emulateNetworkConditions",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.getResponseBody",
  "Network.setExtraHTTPHeaders",
  "Network.setCookies",
  "Network.clearBrowserCookies",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelectorAll",
  "DOM.describeNode",
  "DOM.resolveNode",
  "DOM.getBoxModel",
  "DOM.setFileInputFiles",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Log.enable",
  "Overlay.highlightNode",
  "Overlay.hideHighlight",
  "Fetch.enable",
  "Fetch.disable",
  "Fetch.continueWithAuth",
  "Fetch.continueRequest",
  "Fetch.failRequest",
  "Fetch.fulfillRequest",
  "IO.close",
  "IO.read",
  "Profiler.start",
  "Profiler.stop",
  "Security.setIgnoreCertificateErrors",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearDataForOrigin",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setEmulatedMedia",
  "Emulation.setUserAgentOverride",
  "Tracing.start",
  "Tracing.end"
]);

export function createProtocolError(code, message, data = undefined) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  return error;
}

export function toProtocolError(error, fallbackMessage = "Internal error") {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data })
    };
  }

  return {
    code: -32603,
    message: error instanceof Error ? error.message : fallbackMessage
  };
}

export function makePageTargetId(tabId) {
  return `page:${tabId}`;
}

export function parsePageTargetId(targetId) {
  if (!targetId?.startsWith("page:")) {
    return null;
  }

  const tabId = Number(targetId.slice("page:".length));
  return Number.isInteger(tabId) ? tabId : null;
}

export function makeBridgeSessionId(prefix = "bridge") {
  return `${prefix}-${randomUUID()}`;
}

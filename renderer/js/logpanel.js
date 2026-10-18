/** Log panels and toasts. Everything the user sees here is either bridge output or a UI action. */

import { $, clear, el, nowStamp } from "./util.js";

const MAX_LINES = 400;

function appendTo(container, level, message, withStamp = true) {
  if (!container) return;
  const line = el("div", { className: `log-line ${level}` }, [
    withStamp ? el("span", { className: "t", text: nowStamp() }) : null,
    el("span", { className: "m", text: message }),
  ]);
  container.appendChild(line);
  while (container.childElementCount > MAX_LINES) container.removeChild(container.firstChild);
  container.scrollTop = container.scrollHeight;
}

export const consoleLog = {
  write(level, message) {
    appendTo($("console-log"), level, message);
  },
  clear() {
    clear($("console-log"));
  },
};

export const bridgeLog = {
  write(level, message) {
    appendTo($("bridge-log"), level, message);
  },
  clear() {
    clear($("bridge-log"));
  },
};

let toastHost = null;

export function toast(title, body, options = {}) {
  toastHost = toastHost || $("toasts");
  if (!toastHost) return;
  const kind = options.kind || "info";
  const node = el("div", { className: `toast ${kind}` }, [
    el("div", { className: "t-title", text: title }),
    body ? el("div", { className: "t-body", text: body }) : null,
    options.remedy ? el("div", { className: "t-remedy", text: `Suggested fix: ${options.remedy}` }) : null,
  ]);
  toastHost.appendChild(node);
  const lifetime = options.sticky ? 20000 : 7000;
  setTimeout(() => node.remove(), lifetime);
  node.addEventListener("click", () => node.remove());
  while (toastHost.childElementCount > 5) toastHost.removeChild(toastHost.firstChild);
}

/** Report a thrown error consistently, including the bridge's remedy text. */
export function reportError(error, context) {
  const title = context ? `${context} failed` : "Operation failed";
  toast(title, `${error.message}${error.details ? `\n${error.details}` : ""}`, {
    kind: "error",
    remedy: error.remedy || null,
  });
  consoleLog.write("error", `${title}: ${error.message}${error.details ? ` — ${error.details}` : ""}`);
  if (error.remedy) consoleLog.write("warn", `Remedy: ${error.remedy}`);
}

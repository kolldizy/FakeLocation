/**
 * Modal dialogs built on the single `#modal` element in index.html.
 *
 * Electron does not implement `window.prompt()`, so text input always goes
 * through here. Only one dialog can be open at a time; opening another resolves
 * the previous one with `null`.
 */

import { $, el, clear } from "./util.js";

let activeResolve = null;
let keyHandler = null;

function close(result) {
  const backdrop = $("modal");
  const resolve = activeResolve;
  activeResolve = null;
  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler);
    keyHandler = null;
  }
  backdrop.hidden = true;
  clear($("modal-body"));
  if (resolve) resolve(result);
}

function open({ title }) {
  if (activeResolve) close(null);
  const backdrop = $("modal");
  $("modal-title").textContent = title;
  const body = $("modal-body");
  clear(body);

  keyHandler = (event) => {
    if (event.key === "Escape") close(null);
  };
  document.addEventListener("keydown", keyHandler);

  backdrop.hidden = false;
  return body;
}

document.addEventListener("DOMContentLoaded", () => {
  const backdrop = $("modal");
  if (!backdrop) return;
  $("modal-close").addEventListener("click", () => close(null));
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close(null);
  });
});

/**
 * Ask for a single line of text.
 * @returns {Promise<string|null>} the trimmed value, or null when cancelled.
 */
export function promptText({ title, label, value = "", hint = "", confirmLabel = "Save", placeholder = "" }) {
  return new Promise((resolve) => {
    // `open()` settles whatever dialog it replaces, so the new resolver must not be
    // installed until that has happened — otherwise opening a dialog resolves its own
    // promise with `null` before the user can answer it.
    const body = open({ title });
    activeResolve = resolve;

    const input = el("input", { attrs: { type: "text", value, placeholder, maxlength: "120" } });
    const error = el("div", { className: "hint bad", attrs: { hidden: "hidden" } });
    const confirm = el("button", { className: "btn primary", text: confirmLabel, attrs: { type: "button" } });

    const submit = () => {
      const text = input.value.trim();
      if (!text) {
        error.textContent = "A name is required.";
        error.hidden = false;
        input.focus();
        return;
      }
      close(text);
    };

    confirm.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });

    body.appendChild(
      el("div", { className: "field" }, [
        el("label", { text: label }),
        input,
        error,
        hint ? el("div", { className: "hint", text: hint }) : null,
      ])
    );
    body.appendChild(
      el("div", { className: "btn-row end" }, [
        el("button", { className: "btn ghost", text: "Cancel", attrs: { type: "button" }, on: { click: () => close(null) } }),
        confirm,
      ])
    );

    input.focus();
    input.select();
  });
}

/**
 * Ask a yes/no question. `danger` styles the confirm button as destructive.
 * @returns {Promise<boolean>}
 */
export function confirmAction({ title, message, confirmLabel = "Confirm", danger = false, hint = "" }) {
  return new Promise((resolve) => {
    // `open()` settles whatever dialog it replaces, so the new resolver must not be
    // installed until that has happened — otherwise opening a dialog resolves its own
    // promise with `false` and a confirmation can never be accepted.
    const body = open({ title });
    activeResolve = (value) => resolve(Boolean(value));

    body.appendChild(el("p", { text: message, attrs: { style: "margin:0 0 6px; font-size:12.5px; line-height:1.7;" } }));
    if (hint) body.appendChild(el("div", { className: "hint", text: hint }));
    body.appendChild(
      el("div", { className: "btn-row end", attrs: { style: "margin-top:14px;" } }, [
        el("button", { className: "btn ghost", text: "Cancel", attrs: { type: "button" }, on: { click: () => close(false) } }),
        el("button", {
          className: danger ? "btn danger" : "btn primary",
          text: confirmLabel,
          attrs: { type: "button" },
          on: { click: () => close(true) },
        }),
      ])
    );
  });
}

/** Read-only dialog used for help text and setup instructions. */
export function showInfo({ title, children = [] }) {
  return new Promise((resolve) => {
    const body = open({ title });
    activeResolve = () => resolve(undefined);
    for (const child of children) body.appendChild(child);
    body.appendChild(
      el("div", { className: "btn-row end", attrs: { style: "margin-top:14px;" } }, [
        el("button", { className: "btn primary", text: "Close", attrs: { type: "button" }, on: { click: () => close(true) } }),
      ])
    );
  });
}

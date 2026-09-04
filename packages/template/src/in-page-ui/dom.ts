// Tiny DOM helpers shared by Hexclave's in-page UIs (the dev tool and the
// standalone clickmap overlay). This module deliberately lives outside both
// feature folders so either feature can be removed without affecting the other.

type DomAttributeValue =
  | string
  | number
  | boolean
  | { [key: string]: string | number }
  | (() => void)
  | null
  | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, DomAttributeValue> | null,
  ...children: (string | Node | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'className') {
        el.className = v;
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  for (const child of children) {
    if (child == null) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function setHtml(el: HTMLElement, html: string) {
  el.innerHTML = html;
}

export function hasAppendChild(value: unknown): value is { appendChild(node: Node): void } {
  return typeof value === 'object' && value !== null && typeof value['appendChild'] === 'function';
}

export function canMountIntoDom(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  if (typeof document.createElement !== 'function') {
    return false;
  }
  return hasAppendChild(document['body']);
}

// ---------------------------------------------------------------------------
// Window-global singleton slot, so remounts (e.g. across HMR or multiple app
// instances) can tear down the previous instance before mounting a new one.
// ---------------------------------------------------------------------------

export type UiGlobalInstance = {
  cleanup: () => void;
};

function isUiGlobalInstance(value: unknown): value is UiGlobalInstance {
  return typeof value === 'object' && value !== null && typeof value['cleanup'] === 'function';
}

export function getGlobalUiInstance(key: string): UiGlobalInstance | null {
  if (typeof window === 'undefined') return null;
  const value: unknown = window[key];
  return isUiGlobalInstance(value) ? value : null;
}

export function setGlobalUiInstance(key: string, instance: UiGlobalInstance | null) {
  if (typeof window === 'undefined') return;
  if (instance === null) {
    Reflect.deleteProperty(window, key);
  } else {
    Reflect.set(window, key, instance);
  }
}

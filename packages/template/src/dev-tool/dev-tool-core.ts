// IF_PLATFORM js-like

import type { RequestLogEntry } from "@hexclave/shared/dist/interface/client-interface";
import { DEV_TOOL_ROOT_ID } from "@hexclave/shared/dist/utils/dev-tool";
import { runAsynchronously, runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { isLocalhost } from "@hexclave/shared/dist/utils/urls";
import type { StackClientApp } from "../lib/hexclave-app";
import { getGlobalUiInstance, h, hasAppendChild, setGlobalUiInstance, setHtml, type UiGlobalInstance } from "../in-page-ui/dom";
import { HEXCLAVE_LOGO_SVG } from "../in-page-ui/logo";
import { getBaseUrl } from "../lib/hexclave-app/apps/implementations/common";
import type { HandlerUrlOptions, HandlerUrls, HandlerUrlTarget } from "../lib/hexclave-app/common";
import { hexclaveAppInternalsSymbol } from "../lib/hexclave-app/common";
import { getPagePrompt } from "../lib/hexclave-app/url-targets";
import { devToolCSS } from "./dev-tool-styles";
import type { TriggerCorner, TriggerPlacement } from "./dev-tool-trigger-position";
import { clampTriggerPosition, getSnappedTriggerPlacement, resolveTriggerPosition } from "./dev-tool-trigger-position";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabId = 'overview' | 'customize' | 'ai' | 'dashboard' | 'console' | 'support';

type TabResult = { element: HTMLElement, cleanup?: () => void };

type ApiLogEntry = {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  duration?: number;
  error?: string;
};

type EventLogEntry = {
  id: string;
  timestamp: number;
  type: 'error' | 'info';
  message: string;
};

type DevToolState = {
  isOpen: boolean;
  activeTab: TabId;
  panelWidth: number;
  panelHeight: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Hexclave rebrand: UI-only local prefs — straight rename (one-time reset is harmless)
const STORAGE_KEY = '__hexclave-dev-tool-state';
const TRIGGER_POS_KEY = 'hexclave-devtool-trigger-position';
const ROOT_ID = DEV_TOOL_ROOT_ID;
const GLOBAL_INSTANCE_KEY = '__hexclave-dev-tool-instance';
const MAX_LOG_ENTRIES = 500;
const CONSOLE_LOG_BATCH_SIZE = 100;
const DRAG_THRESHOLD = 5;
const DOCS_URL = 'https://docs.hexclave.com';
// The local development-environment dashboard always listens on this loopback
// port (see the CLI's DEFAULT_DASHBOARD_PORT). The dev tool runs inside the
// customer's own app, so it can't read the CLI's env vars — the port is fixed.
const LOCAL_DASHBOARD_ORIGIN = 'http://localhost:26700';
const HOSTED_DASHBOARD_URL = 'https://app.hexclave.com';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>' },
  { id: 'customize', label: 'Customize', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>' },
  { id: 'ai', label: 'AI', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' },
  { id: 'console', label: 'Console', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>' },
  { id: 'dashboard', label: 'Dashboard', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>' },
  { id: 'support', label: 'Support', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
];

// Clickmaps is intentionally NOT a dev tool tab or feature. It's a fully
// independent module (see src/clickmap) with its own mount, root element, and
// styles, so the dev tool can be changed or removed without affecting it.

const DEFAULT_STATE: DevToolState = {
  isOpen: false,
  activeTab: 'overview',
  panelWidth: 800,
  panelHeight: 520,
};


// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function loadState(): DevToolState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Migrate old 'components' tab name to 'customize'
      if (parsed.activeTab === 'components') parsed.activeTab = 'customize';
      if (parsed.activeTab === 'docs') parsed.activeTab = 'overview';
      return { ...DEFAULT_STATE, ...parsed, isOpen: false };
    }
  } catch {}
  return { ...DEFAULT_STATE };
}

function saveState(state: DevToolState) {
  try {
    // Keep layout preferences across pages, but do not reopen the panel automatically on remount.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, isOpen: false }));
  } catch {}
}

function createStateStore() {
  let state = loadState();
  const listeners = new Set<() => void>();

  return {
    get: () => state,
    update(partial: Partial<DevToolState>) {
      state = { ...state, ...partial };
      saveState(state);
      listeners.forEach((fn) => fn());
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Global log store (survives remounts, shared across instances)
// ---------------------------------------------------------------------------

type LogStore = {
  apiLogs: ApiLogEntry[];
  eventLogs: EventLogEntry[];
  listeners: Set<() => void>;
  addApiLog(entry: ApiLogEntry): void;
  addEventLog(entry: EventLogEntry): void;
  clear(): void;
  subscribe(fn: () => void): () => void;
};

function getGlobalLogStore(): LogStore {
  const g = globalThis as any;
  if (!g.__STACK_DEV_TOOL_LOG_STORE__) {
    g.__STACK_DEV_TOOL_LOG_STORE__ = {
      apiLogs: [] as ApiLogEntry[],
      eventLogs: [] as EventLogEntry[],
      listeners: new Set<() => void>(),
      addApiLog(entry: ApiLogEntry) {
        this.apiLogs = [entry, ...this.apiLogs].slice(0, MAX_LOG_ENTRIES);
        this.listeners.forEach((fn: () => void) => fn());
      },
      addEventLog(entry: EventLogEntry) {
        this.eventLogs = [entry, ...this.eventLogs].slice(0, MAX_LOG_ENTRIES);
        this.listeners.forEach((fn: () => void) => fn());
      },
      clear() {
        this.apiLogs = [];
        this.eventLogs = [];
        this.listeners.forEach((fn: () => void) => fn());
      },
      subscribe(fn: () => void) {
        this.listeners.add(fn);
        return () => {
          this.listeners.delete(fn);
        };
      },
    };
  }
  return g.__STACK_DEV_TOOL_LOG_STORE__;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;
function nextId() {
  return `sdt-${++_idCounter}-${Date.now()}`;
}

function resolveApiBaseUrl(app: StackClientApp<true>): string {
  const opts = app[hexclaveAppInternalsSymbol].getConstructorOptions();
  return getBaseUrl(opts.baseUrl);
}

function localDashboardProjectUrl(app: StackClientApp<true>): string {
  return `${LOCAL_DASHBOARD_ORIGIN}/projects/${encodeURIComponent(app.projectId)}`;
}

function parseProjectAvailabilityResponse(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  return 'project_available' in body && body.project_available === true;
}

// How long to wait for the availability probe before giving up. A refused
// connection rejects almost immediately, but a host that accepts the socket yet
// never responds would otherwise leave the tab stuck on "Checking…" forever.
const LOCAL_DASHBOARD_PROBE_TIMEOUT_MS = 3000;

// Whether the current page can even talk to the HTTP-only local dashboard.
// LOCAL_DASHBOARD_ORIGIN is `http://localhost:26700`, so the page itself must be
// an http: localhost origin: an https: page (e.g. an HTTPS dev server) would
// have both the probe fetch and the iframe embed blocked as mixed content, so
// we treat that as "not available" and fall back to the hosted dashboard.
function canReachLocalDashboard(): boolean {
  return isLocalhost(window.location.href) && window.location.protocol === 'http:';
}

// Decides whether the Dashboard tab can embed the locally-running
// development-environment dashboard. Rather than inferring from build-time env
// vars (which don't reflect whether the dev environment is actually up right
// now), we ask the running development environment directly:
//   1. We must be viewing the app from an http: localhost origin — the HTTP-only
//      dashboard on :26700 is only reachable from, and only relevant to, a local
//      browser (and an https: page can't reach it without mixed-content errors).
//   2. The development environment must be running AND already own this exact
//      project (see the project-availability route it answers).
// Any failure — dev environment not running (connection refused), probe timeout,
// project unknown, or a malformed response — resolves to `false`, which shows
// the hosted-dashboard hint instead.
async function isLocalDashboardProjectAvailable(app: StackClientApp<true>): Promise<boolean> {
  if (!canReachLocalDashboard()) return false;
  const url = `${LOCAL_DASHBOARD_ORIGIN}/api/development-environment/project-availability?project_id=${encodeURIComponent(app.projectId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_DASHBOARD_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) return false;
    return parseProjectAvailabilityResponse(await response.json());
  } catch {
    // Reachability probe: when the local development environment isn't running,
    // the fetch rejects (connection refused); when it hangs, the AbortController
    // aborts it. Either way that simply means "not available".
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  } as any);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateRandomEmail(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `dev-${id}@devtool-quick-sign-up.example.com`;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function parseMarkdownImage(line: string): { alt: string, src: string } | null {
  const match = line.trim().match(/^!\[([^\]]*)\]\((.+)\)$/);
  if (!match) return null;

  const [, alt, src] = match;
  const normalizedSrc = src.trim();
  if (normalizedSrc === '') return null;

  return {
    alt: alt.trim(),
    src: normalizedSrc,
  };
}

function appendInlineMarkdown(container: HTMLElement, text: string) {
  const tokenPattern = /(\[[^\]]+\]\([^)]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const token = match[0];
    if (token.startsWith("`")) {
      container.appendChild(h("code", { className: "sdt-ai-inline-code" }, token.slice(1, -1)));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const bold = h("strong", { className: "sdt-ai-bold" });
      appendInlineMarkdown(bold, token.slice(2, -2));
      container.appendChild(bold);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      const italic = h("em");
      appendInlineMarkdown(italic, token.slice(1, -1));
      container.appendChild(italic);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const [, linkText, href] = linkMatch;
        const trimmedHref = href.trim();
        if (/^(https?:\/\/|mailto:)/i.test(trimmedHref)) {
          const link = h("a", {
            className: "sdt-ai-link",
            href: trimmedHref,
            target: "_blank",
            rel: "noopener noreferrer",
          });
          appendInlineMarkdown(link, linkText);
          container.appendChild(link);
        } else {
          container.appendChild(document.createTextNode(token));
        }
      } else {
        container.appendChild(document.createTextNode(token));
      }
    }

    lastIndex = tokenPattern.lastIndex;
  }

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

// ---------------------------------------------------------------------------
// Trigger button (draggable pill — corner-snapping, icon only)
// ---------------------------------------------------------------------------

function createTrigger(onClick: () => void): { element: HTMLElement; cleanup: () => void } {
  type Position = { left: number; top: number };
  type Placement = TriggerPlacement;

  // Measured lazily after the element is appended to the DOM.
  let triggerSize = { width: 36, height: 36 };

  function isPosition(value: unknown): value is Position {
    if (typeof value !== 'object' || value === null) return false;
    return typeof value['left'] === 'number' && typeof value['top'] === 'number';
  }

  function isPlacement(value: unknown): value is Placement {
    if (typeof value !== 'object' || value === null) return false;
    const corner = value['corner'];
    return ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(String(corner));
  }

  function loadPlacement(): Placement | null {
    try {
      const raw = localStorage.getItem(TRIGGER_POS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);

      if (isPlacement(parsed)) return parsed;

      // Migrate old side-based placement { side, offset } to nearest corner.
      if (typeof parsed === 'object' && parsed !== null && 'side' in parsed && 'offset' in parsed) {
        const side = String(parsed['side']);
        const offset = Number(parsed['offset']);
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let corner: TriggerCorner;
        if (side === 'right')  corner = offset < vh / 2 ? 'top-right'   : 'bottom-right';
        else if (side === 'left')   corner = offset < vh / 2 ? 'top-left'    : 'bottom-left';
        else if (side === 'top')    corner = offset < vw / 2 ? 'top-left'    : 'top-right';
        else                        corner = offset < vw / 2 ? 'bottom-left' : 'bottom-right';
        return { corner };
      }

      // Migrate old absolute position.
      if (isPosition(parsed)) {
        return getSnappedTriggerPlacement(parsed, triggerSize, { width: window.innerWidth, height: window.innerHeight });
      }
    } catch {}
    return null;
  }

  function savePlacement(placement: Placement) {
    try {
      localStorage.setItem(TRIGGER_POS_KEY, JSON.stringify(placement));
    } catch {}
  }

  let animationTimeout: number | null = null;

  function setPositionAnimation(isAnimated: boolean) {
    if (animationTimeout !== null) {
      window.clearTimeout(animationTimeout);
      animationTimeout = null;
    }
    btn.classList.toggle('sdt-trigger-position-animated', isAnimated);
    if (isAnimated) {
      animationTimeout = window.setTimeout(() => {
        animationTimeout = null;
        btn.classList.remove('sdt-trigger-position-animated');
      }, 180);
    }
  }

  function applyPos(nextPos: Position, options?: { animate?: boolean }) {
    setPositionAnimation(options?.animate === true);
    pos = nextPos;
    btn.style.left = pos.left + 'px';
    btn.style.top = pos.top + 'px';
  }

  const btn = h('button', {
    className: 'sdt-trigger',
    'aria-label': 'Toggle Hexclave Dev Tools',
    'data-hexclave-devtool-trigger': 'true',
    title: 'Hexclave Dev Tools',
  });
  const logoSpan = h('span', { className: 'sdt-trigger-logo' });
  setHtml(logoSpan, HEXCLAVE_LOGO_SVG);
  btn.appendChild(logoSpan);

  let placement = loadPlacement() ?? { corner: 'bottom-right' as TriggerCorner };
  let pos = resolveTriggerPosition(placement, triggerSize, { width: window.innerWidth, height: window.innerHeight });
  applyPos(pos);

  let dragState: { startX: number; startY: number; startLeft: number; startTop: number; didDrag: boolean } | null = null;

  // After mount, measure the actual rendered size and re-snap if needed.
  requestAnimationFrame(() => {
    const rect = btn.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      triggerSize = { width: rect.width, height: rect.height };
      const measured = resolveTriggerPosition(placement, triggerSize, { width: window.innerWidth, height: window.innerHeight });
      if (measured.left !== pos.left || measured.top !== pos.top) {
        applyPos(measured, { animate: true });
      }
    }
  });

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setPositionAnimation(false);
    btn.setPointerCapture(e.pointerId);
    dragState = { startX: e.clientX, startY: e.clientY, startLeft: pos.left, startTop: pos.top, didDrag: false };
  });

  btn.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.didDrag && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    dragState.didDrag = true;
    applyPos(clampTriggerPosition(
      { left: dragState.startLeft + dx, top: dragState.startTop + dy },
      triggerSize,
      { width: window.innerWidth, height: window.innerHeight },
    ));
  });

  btn.addEventListener('pointerup', (e) => {
    const ds = dragState;
    dragState = null;
    if (!ds) return;
    btn.releasePointerCapture(e.pointerId);
    if (ds.didDrag) {
      placement = getSnappedTriggerPlacement(pos, triggerSize, { width: window.innerWidth, height: window.innerHeight });
      applyPos(resolveTriggerPosition(placement, triggerSize, { width: window.innerWidth, height: window.innerHeight }), { animate: true });
      savePlacement(placement);
    } else {
      onClick();
    }
  });

  // On viewport resize, reapply the existing corner placement to the new dimensions.
  // Placement (corner) only changes when the user drags.
  function onResize() {
    const resizedPos = resolveTriggerPosition(placement, triggerSize, { width: window.innerWidth, height: window.innerHeight });
    if (resizedPos.left !== pos.left || resizedPos.top !== pos.top) {
      applyPos(resizedPos, { animate: true });
    }
  }

  window.addEventListener('resize', onResize);

  return {
    element: btn,
    cleanup: () => {
      if (animationTimeout !== null) {
        window.clearTimeout(animationTimeout);
      }
      window.removeEventListener('resize', onResize);
    },
  };
}

// ---------------------------------------------------------------------------
// Tab bar with sliding indicator
// ---------------------------------------------------------------------------

function createTabBar(
  tabs: { id: string; label: string; icon?: string }[],
  activeTab: string,
  onTabChange: (id: string) => void,
  opts?: { variant?: 'bar' | 'pills'; trailing?: HTMLElement },
): { el: HTMLElement; setActive: (id: string) => void } {
  const variant = opts?.variant ?? 'bar';
  const barClass = variant === 'pills' ? 'sdt-console-tabs' : 'sdt-tabbar';
  const tabClass = variant === 'pills' ? 'sdt-console-tab' : 'sdt-tab';
  const indicatorClass = variant === 'pills' ? 'sdt-console-tab-indicator' : 'sdt-tab-indicator';

  const bar = h('div', { className: barClass });
  const indicator = h('div', { className: indicatorClass });
  indicator.style.opacity = '0';
  bar.appendChild(indicator);

  let current = activeTab;
  let isInitial = true;

  const buttons = tabs.map((tab) => {
    const btn = h('button', {
      className: tabClass,
      'data-tab-id': tab.id,
      'data-active': String(tab.id === activeTab),
    });
    if (tab.icon) {
      const iconSpan = h('span', { className: 'sdt-tab-icon' });
      setHtml(iconSpan, tab.icon);
      btn.appendChild(iconSpan);
    }
    btn.appendChild(document.createTextNode(tab.label));
    btn.addEventListener('click', () => onTabChange(tab.id));
    bar.appendChild(btn);
    return btn;
  });

  if (variant === 'bar') {
    bar.appendChild(h('div', { className: 'sdt-tabbar-spacer' }));
  }
  if (opts?.trailing) {
    bar.appendChild(opts.trailing);
  }

  function measure() {
    const btn = bar.querySelector<HTMLElement>(`[data-tab-id="${current}"]`);
    if (!btn) return;
    indicator.style.transform = `translateX(${btn.offsetLeft}px)`;
    indicator.style.width = btn.offsetWidth + 'px';
    indicator.style.height = btn.offsetHeight + 'px';
    indicator.style.opacity = '1';
    indicator.style.transition = isInitial ? 'none' : '';
    isInitial = false;
  }

  const ro = new ResizeObserver(measure);
  ro.observe(bar);
  requestAnimationFrame(measure);

  function setActive(id: string) {
    current = id;
    buttons.forEach((btn) => {
      const tabId = btn.getAttribute('data-tab-id');
      btn.setAttribute('data-active', String(tabId === id));
    });
    measure();
  }

  return { el: bar, setActive };
}

// ---------------------------------------------------------------------------
// Iframe helper
// ---------------------------------------------------------------------------

function populateIframeTab(container: HTMLElement, src: string, title: string, loadingMsg = 'Loading\u2026', errorMsg = 'Unable to load content', errorDetail?: string, openExternallyLabel?: string): void {
  container.innerHTML = '';
  if (openExternallyLabel != null) {
    container.appendChild(h('div', { className: 'sdt-iframe-toolbar' },
      h('a', { href: src, target: '_blank', rel: 'noopener noreferrer', className: 'sdt-iframe-open-link' }, openExternallyLabel),
    ));
  }
  const loadingEl = h('div', { className: 'sdt-iframe-loading' }, loadingMsg);
  container.appendChild(loadingEl);

  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.title = title;
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
  iframe.style.display = 'none';

  iframe.addEventListener('load', () => {
    loadingEl.style.display = 'none';
    iframe.style.display = 'block';
  });

  iframe.addEventListener('error', () => {
    loadingEl.style.display = 'none';
    container.innerHTML = '';
    const errDiv = h('div', { className: 'sdt-iframe-error' });
    errDiv.appendChild(h('div', null, errorMsg));
    if (errorDetail) {
      errDiv.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--sdt-text-tertiary)' } }, errorDetail));
    }
    const retryBtn = h('button', { className: 'sdt-iframe-error-btn' }, 'Retry');
    retryBtn.addEventListener('click', () => {
      populateIframeTab(container, src, title, loadingMsg, errorMsg, errorDetail, openExternallyLabel);
    });
    errDiv.appendChild(retryBtn);
    const link = h('a', { href: src, target: '_blank', rel: 'noopener noreferrer', style: { color: 'var(--sdt-accent)', fontSize: '12px', textDecoration: 'none' } }, 'Open in new tab');
    errDiv.appendChild(link);
    container.appendChild(errDiv);
  });

  container.appendChild(iframe);
}

// ===========================================================================================
// TABS
// ===========================================================================================

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function hasPersistentTokenStoreForDevTool(app: StackClientApp<boolean>): boolean {
  return app[hexclaveAppInternalsSymbol].getConstructorOptions().tokenStore !== null;
}

function createOverviewTab(app: StackClientApp<true>): TabResult {
  const container = h('div', { className: 'sdt-ov' });
  const hasPersistentTokenStore = hasPersistentTokenStoreForDevTool(app);

  // ── Identity card ──────────────────────────────────────────────────────────
  const heroCard = h('div', { className: 'sdt-ov-card sdt-ov-card-hero' });
  heroCard.appendChild(h('div', { className: 'sdt-ov-label' }, 'Identity'));

  const userRow = h('div', { className: 'sdt-ov-user-row' });
  const avatar = h('div', { className: 'sdt-ov-avatar' }, '?');
  const userMeta = h('div', { className: 'sdt-ov-user-meta' });
  const userName = h('div', { className: 'sdt-ov-user-name' }, 'Loading\u2026');
  const userEmail = h('div', { className: 'sdt-ov-user-email' }, '');
  const authIndicator = h('div', { className: 'sdt-ov-auth-indicator', style: { display: 'none' } }, 'Authenticated');
  userMeta.append(userName, userEmail, authIndicator);
  userRow.append(avatar, userMeta);
  heroCard.appendChild(userRow);

  const actions = h('div', { className: 'sdt-ov-actions' });
  const toast = h('div', { className: 'sdt-ov-toast', style: { display: 'none' } });

  function isBestEffortOverviewError(error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return true;
    }
    if (error instanceof TypeError) {
      return true;
    }
    if (error instanceof Error) {
      return error.message.includes('Failed to fetch')
        || error.message.includes('NetworkError')
        || error.message.includes('Load failed')
        || error.message.includes('network connection');
    }
    return false;
  }

  function showToast(msg: string, type: 'success' | 'error') {
    toast.textContent = msg;
    toast.className = `sdt-ov-toast sdt-ov-toast-${type}`;
    toast.style.display = '';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 4000);
  }

  let currentUser: any = null;
  let loading = false;

  function rebuildActions() {
    actions.innerHTML = '';
    if (!hasPersistentTokenStore) {
      userName.textContent = 'Current user unavailable';
      userEmail.textContent = 'This app was initialized without a token store';
      actions.appendChild(h('button', { className: 'sdt-ov-btn sdt-ov-btn-wide', disabled: 'true' }, 'Session actions unavailable'));
      return;
    }
    if (currentUser) {
      const signOutBtn = h('button', { className: 'sdt-ov-btn sdt-ov-btn-danger' }, 'Sign Out');
      signOutBtn.disabled = loading;
      signOutBtn.addEventListener('click', () => {
        runAsynchronously(async () => {
          loading = true;
          rebuildActions();
          try {
            await currentUser.signOut();
            showToast('Signed out', 'success');
          } catch (e: any) {
            showToast(e.message || 'Sign out failed', 'error');
          }
          loading = false;
          await refreshUser();
        });
      });
      const randomBtn = h('button', { className: 'sdt-ov-btn sdt-ov-btn-primary' }, 'Random User');
      randomBtn.disabled = loading;
      randomBtn.addEventListener('click', () => {
        runAsynchronously(doQuickSignIn());
      });
      actions.append(signOutBtn, randomBtn);
    } else {
      const quickBtn = h('button', { className: 'sdt-ov-btn sdt-ov-btn-primary sdt-ov-btn-wide' }, loading ? 'Working\u2026' : 'Quick Sign Up');
      quickBtn.disabled = loading;
      quickBtn.addEventListener('click', () => {
        runAsynchronously(doQuickSignIn());
      });
      actions.appendChild(quickBtn);
    }

  }

  async function doQuickSignIn() {
    if (!isLocalhost(window.location.href)) {
      showToast('Quick sign-in is only available on localhost', 'error');
      return;
    }
    loading = true;
    rebuildActions();
    const email = generateRandomEmail();
    try {
      const signUpResult = await app.signUpWithCredential({ email, password: email, noRedirect: true } as any);
      if (signUpResult.status === 'error') {
        showToast(`Sign up failed: ${signUpResult.error.message}`, 'error');
        loading = false;
        rebuildActions();
        return;
      }
      const signInResult = await app.signInWithCredential({ email, password: email, noRedirect: true });
      if (signInResult.status === 'error') {
        showToast(`Sign in failed: ${signInResult.error.message}`, 'error');
      } else {
        showToast(`Signed in as ${email}`, 'success');
      }
    } catch (e: any) {
      showToast(e.message || 'Unknown error', 'error');
    }
    loading = false;
    await refreshUser();
  }

  heroCard.append(actions, toast);

  // ── Auth methods card ──────────────────────────────────────────────────────
  const methodsCard = h('div', { className: 'sdt-ov-card sdt-ov-card-auth' });
  methodsCard.appendChild(h('div', { className: 'sdt-ov-label' }, 'Auth Methods'));
  const authGrid = h('div', { className: 'sdt-ov-auth-grid' });
  for (let i = 0; i < 3; i++) {
    authGrid.appendChild(h('div', { className: 'sdt-ov-method sdt-ov-skeleton-pill' }));
  }
  methodsCard.appendChild(authGrid);
  let hasActiveAuthMethod: boolean | null = null;

  async function loadAuthMethods() {
    try {
      const project = await app.getProject();
      authGrid.innerHTML = '';
      const config = project.config;
      hasActiveAuthMethod = config.credentialEnabled
        || config.magicLinkEnabled
        || config.passkeyEnabled
        || config.oauthProviders.length > 0;
      const methods = [
        { label: 'Password', enabled: config.credentialEnabled },
        { label: 'Magic Link', enabled: config.magicLinkEnabled },
        { label: 'Passkey', enabled: config.passkeyEnabled },
      ];
      for (const m of methods) {
        const pill = h('div', { className: `sdt-ov-method ${m.enabled ? 'sdt-ov-method-on' : 'sdt-ov-method-off'}` });
        pill.appendChild(h('span', { className: 'sdt-ov-method-name' }, m.label));
        authGrid.appendChild(pill);
      }
      for (const p of config.oauthProviders) {
        const pill = h('div', { className: 'sdt-ov-method sdt-ov-method-on sdt-ov-method-oauth' });
        pill.appendChild(h('span', { className: 'sdt-ov-method-name' }, p.id));
        authGrid.appendChild(pill);
      }
      if (!config.signUpEnabled) {
        const pill = h('div', { className: 'sdt-ov-method sdt-ov-method-warn' });
        pill.appendChild(h('span', { className: 'sdt-ov-method-name' }, 'Sign-up off'));
        authGrid.appendChild(pill);
      }
      buildChecklist();
    } catch (error) {
      authGrid.innerHTML = '<div style="font-size:11px;color:var(--sdt-text-tertiary)">Could not load auth methods</div>';
      hasActiveAuthMethod = null;
      buildChecklist();
      if (!isBestEffortOverviewError(error)) {
        throw error;
      }
    }
  }

  // Overview hydration is best-effort while the local Stack backend is still booting.
  runAsynchronously(loadAuthMethods());

  // ── Setup checklist (only shown when something is incomplete) ──────────────
  const checksCard = h('div', { className: 'sdt-ov-card sdt-ov-card-checks' });
  const projectId = app.projectId;
  let checksCardMounted = false;

  function buildChecklist() {
    checksCard.innerHTML = '';
    const currentUserCheck = hasPersistentTokenStore
      ? { ok: !!currentUser, label: 'Sign in a test user', hint: 'Use \u201cQuick Sign Up\u201d above \u2192' }
      : { ok: true, label: 'Current-user tools unavailable', hint: null };
    const checks = [
      { ok: !!projectId && projectId !== 'default', label: 'Project configured', hint: null },
      { ok: hasActiveAuthMethod === true, label: 'Auth method active', hint: hasActiveAuthMethod === null ? 'Still checking project config' : null },
      currentUserCheck,
    ];
    const passCount = checks.filter((c) => c.ok).length;
    const allGood = passCount === checks.length;

    if (allGood) {
      if (checksCardMounted && checksCard.parentElement) {
        container.removeChild(checksCard);
        checksCardMounted = false;
      }
      return;
    }

    if (!checksCardMounted) {
      container.appendChild(checksCard);
      checksCardMounted = true;
    }

    const titleRow = h('div', { className: 'sdt-ov-checks-header' });
    const titleLabel = h('div', { className: 'sdt-ov-label', style: { marginBottom: '0', color: 'var(--sdt-warning)' } }, 'Setup');
    const badge = h('span', { className: 'sdt-ov-checks-badge sdt-ov-checks-badge-warn' }, `${passCount}\u200a/\u200a${checks.length}`);
    titleRow.append(titleLabel, badge);
    checksCard.appendChild(titleRow);

    const bar = h('div', { className: 'sdt-ov-checks-bar' });
    const fill = h('div', { className: 'sdt-ov-checks-bar-fill' });
    fill.style.width = `${(passCount / checks.length) * 100}%`;
    bar.appendChild(fill);
    checksCard.appendChild(bar);

    for (const c of checks) {
      const row = h('div', { className: 'sdt-ov-setup-row' });
      row.appendChild(h('span', { className: `sdt-ov-setup-dot ${c.ok ? 'sdt-ov-setup-dot-ok' : 'sdt-ov-setup-dot-warn'}` }));
      row.appendChild(h('span', { className: 'sdt-ov-setup-label' }, c.label));
      if (!c.ok && c.hint) {
        row.appendChild(h('span', { className: 'sdt-ov-setup-hint' }, c.hint));
      }
      checksCard.appendChild(row);
    }
  }

  async function refreshUser() {
    if (!hasPersistentTokenStore) {
      avatar.className = 'sdt-ov-avatar';
      avatar.textContent = '?';
      userName.textContent = 'Current user unavailable';
      userEmail.textContent = 'This app was initialized without a token store';
      authIndicator.style.display = 'none';
      currentUser = null;
      rebuildActions();
      buildChecklist();
      return;
    }
    try {
      currentUser = await app.getUser();

      if (currentUser) {
        const initials = (currentUser.displayName || currentUser.primaryEmail || '?')
          .split(' ').map((s: string) => s[0]).join('').slice(0, 2).toUpperCase();
        avatar.className = 'sdt-ov-avatar sdt-ov-avatar-active';
        if (currentUser.profileImageUrl) {
          avatar.innerHTML = `<img src="${escapeHtml(currentUser.profileImageUrl)}" alt="" />`;
        } else {
          avatar.textContent = initials;
        }
        userName.textContent = currentUser.displayName || '(No display name)';
        userEmail.textContent = currentUser.primaryEmail || 'No email';
        authIndicator.style.display = '';
      } else {
        avatar.className = 'sdt-ov-avatar';
        avatar.textContent = '?';
        userName.textContent = 'No user signed in';
        userEmail.textContent = 'Sign in to test auth flows';
        authIndicator.style.display = 'none';
      }
    } catch (error) {
      avatar.className = 'sdt-ov-avatar';
      avatar.textContent = '?';
      userName.textContent = 'Could not load user';
      userEmail.textContent = 'Check your local Stack backend';
      authIndicator.style.display = 'none';
      currentUser = null;
      if (!isBestEffortOverviewError(error)) {
        throw error;
      }
    }
    rebuildActions();
    buildChecklist();
  }

  container.append(heroCard, methodsCard);
  buildChecklist();
  runAsynchronously(refreshUser());
  const userPoll = setInterval(() => {
    runAsynchronously(refreshUser());
  }, 3000);

  return { element: container, cleanup: () => clearInterval(userPoll) };
}

// ---------------------------------------------------------------------------
// Console tab
// ---------------------------------------------------------------------------

type MergedLogEntry =
  | { kind: 'api', entry: ApiLogEntry }
  | { kind: 'event', entry: EventLogEntry };

function createConsoleTab(logStore: LogStore): TabResult {
  const container = h('div', { className: 'sdt-console-panel' });

  const EVENT_TYPE_STYLES: Record<string, string> = {
    'error': 'sdt-badge-error',
    'info': 'sdt-badge-info',
  };

  const title = h('div', { className: 'sdt-console-title' }, 'Logs');
  const actions = h('div', { className: 'sdt-console-actions' });
  const copyBtn = h('button', { className: 'sdt-console-action-btn', title: 'Copy logs' });
  setHtml(copyBtn, '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy');
  const exportBtn = h('button', { className: 'sdt-console-action-btn', title: 'Export logs' });
  setHtml(exportBtn, '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Export');
  const clearBtn = h('button', { className: 'sdt-console-action-btn', title: 'Clear logs' });
  setHtml(clearBtn, '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>Clear');
  actions.append(copyBtn, exportBtn, clearBtn);
  container.appendChild(h('div', { className: 'sdt-console-header' }, title, actions));

  const contentArea = h('div', { className: 'sdt-console-log-scroll sdt-tab-content-fade' });
  container.appendChild(contentArea);

  let visibleLogCount = CONSOLE_LOG_BATCH_SIZE;

  function getMergedLogs(): MergedLogEntry[] {
    return [
      ...logStore.apiLogs.map((entry) => ({ kind: 'api' as const, entry })),
      ...logStore.eventLogs.map((entry) => ({ kind: 'event' as const, entry })),
    ].sort((a, b) => b.entry.timestamp - a.entry.timestamp);
  }

  function formatLogLine(item: MergedLogEntry): string {
    if (item.kind === 'api') {
      const log = item.entry;
      const status = log.status !== undefined ? ` [${log.status}]` : '';
      const duration = log.duration !== undefined ? ` ${log.duration}ms` : '';
      const error = log.error !== undefined ? ` ${log.error}` : '';
      return `${new Date(log.timestamp).toISOString()} ${log.method} ${log.url}${status}${duration}${error}`;
    }

    const log = item.entry;
    return `${new Date(log.timestamp).toISOString()} ${log.type.toUpperCase()} ${log.message}`;
  }

  function formatLogsForExport(): string {
    const lines = [
      '=== Hexclave Dev Tool Logs ===',
      `Generated: ${new Date().toISOString()}`,
      `Total logs: ${getMergedLogs().length}`,
      '',
      ...getMergedLogs().map(formatLogLine),
    ];
    return lines.join('\n');
  }

  function renderLogItem(item: MergedLogEntry): HTMLElement {
    if (item.kind === 'api') {
      const log = item.entry;
      const row = h('div', { className: 'sdt-log-item' });
      row.appendChild(h('span', { className: 'sdt-log-time' }, formatTimestamp(log.timestamp)));
      row.appendChild(h('span', { className: `sdt-log-method sdt-log-method-${log.method.toLowerCase()}` }, log.method));
      row.appendChild(h('span', { className: 'sdt-log-url' }, log.url));
      if (log.status !== undefined) {
        row.appendChild(h('span', { className: `sdt-log-status ${log.status < 400 ? 'sdt-log-status-ok' : 'sdt-log-status-err'}` }, String(log.status)));
      }
      if (log.duration !== undefined) {
        row.appendChild(h('span', { className: 'sdt-log-time' }, log.duration + 'ms'));
      }
      return row;
    }

    const log = item.entry;
    const row = h('div', { className: 'sdt-log-item' });
    row.appendChild(h('span', { className: 'sdt-log-time' }, formatTimestamp(log.timestamp)));
    row.appendChild(h('span', { className: `sdt-badge ${EVENT_TYPE_STYLES[log.type] || 'sdt-badge-info'}` }, log.type));
    row.appendChild(h('span', { className: 'sdt-log-message' }, log.message));
    return row;
  }

  function renderLogs() {
    const previousScrollTop = contentArea.scrollTop;
    contentArea.innerHTML = '';
    const merged = getMergedLogs();
    visibleLogCount = Math.min(Math.max(visibleLogCount, CONSOLE_LOG_BATCH_SIZE), Math.max(merged.length, CONSOLE_LOG_BATCH_SIZE));

    if (merged.length === 0) {
      contentArea.innerHTML = '<div class="sdt-empty-state"><div class="sdt-empty-state-icon">\uD83D\uDCCB</div><div>No logs recorded yet</div><div style="font-size:12px;color:var(--sdt-text-tertiary)">API calls and auth events will appear here</div></div>';
      return;
    }

    const list = h('div', { className: 'sdt-log-list' });
    for (const item of merged.slice(0, visibleLogCount)) {
      list.appendChild(renderLogItem(item));
    }
    if (visibleLogCount < merged.length) {
      list.appendChild(h('div', { className: 'sdt-log-load-hint' }, `${merged.length - visibleLogCount} older logs available`));
    }
    contentArea.appendChild(list);
    contentArea.scrollTop = Math.min(previousScrollTop, contentArea.scrollHeight);
  }

  function maybeLoadOlderLogs() {
    const mergedLength = getMergedLogs().length;
    if (visibleLogCount >= mergedLength) return;
    const distanceFromBottom = contentArea.scrollHeight - contentArea.scrollTop - contentArea.clientHeight;
    if (distanceFromBottom <= 48) {
      visibleLogCount = Math.min(visibleLogCount + CONSOLE_LOG_BATCH_SIZE, mergedLength);
      renderLogs();
    }
  }

  contentArea.addEventListener('scroll', maybeLoadOlderLogs);
  renderLogs();

  copyBtn.addEventListener('click', () => {
    runAsynchronously(
      navigator.clipboard.writeText(formatLogsForExport()).then(() => {
        copyBtn.textContent = '\u2713 Copied';
        setTimeout(() => {
          setHtml(copyBtn, '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy');
        }, 1500);
      })
    );
  });

  exportBtn.addEventListener('click', () => {
    const blob = new Blob([formatLogsForExport()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `hexclave-dev-tool-logs-${new Date().toISOString()}.txt` });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  clearBtn.addEventListener('click', () => {
    visibleLogCount = CONSOLE_LOG_BATCH_SIZE;
    logStore.clear();
  });

  const unsub = logStore.subscribe(() => {
    renderLogs();
  });

  return {
    element: container,
    cleanup: () => {
      contentArea.removeEventListener('scroll', maybeLoadOlderLogs);
      unsub();
    },
  };
}

// ---------------------------------------------------------------------------
// AI tab
// ---------------------------------------------------------------------------

function createAITab(app: StackClientApp<true>): HTMLElement {
  const container = h('div', { className: 'sdt-ai-container' });
  const apiBaseUrl = resolveApiBaseUrl(app);

  type ToolCallState = 'running' | 'success' | 'error';
  type ToolCall = {
    id: string,
    toolName: string,
    argsText: string | null,
    resultText: string | null,
    state: ToolCallState,
    errorText: string | null,
    isExpanded: boolean,
  };
  type AssistantPart =
    | { type: 'text', content: string }
    | { type: 'tool', toolCallId: string };
  type UserMessage = { role: 'user'; content: string };
  type AssistantMessage = { role: 'assistant'; parts: AssistantPart[]; toolCallsById: Map<string, ToolCall> };
  type Message = UserMessage | AssistantMessage;
  const messages: Message[] = [];
  let aiLoading = false;
  let activeAiAbortController: AbortController | null = null;

  const messagesArea = h('div', { className: 'sdt-ai-messages' });
  const inputArea = h('div', { className: 'sdt-ai-input-area' });

  const SUGGESTED_QUESTIONS = [
    { icon: '\uD83D\uDD12', text: 'How do I protect a Next.js route?' },
    { icon: '\uD83D\uDC65', text: 'How do teams and permissions work?' },
    { icon: '\uD83D\uDD17', text: 'How do I add OAuth providers?' },
    { icon: '\u2709\uFE0F', text: 'How do I customize auth emails?' },
  ];

  function getHeaders(): Record<string, string> {
    const opts = app[hexclaveAppInternalsSymbol].getConstructorOptions();
    // Hexclave rebrand: emit x-hexclave-* request headers (backend dual-accepts).
    const headers: Record<string, string> = {
      'X-Hexclave-Access-Type': 'client',
      'X-Hexclave-Project-Id': app.projectId,
    };
    if ('publishableClientKey' in opts && opts.publishableClientKey) {
      headers['X-Hexclave-Publishable-Client-Key'] = opts.publishableClientKey as string;
    }
    return headers;
  }

  function renderToolCard(toolCall: ToolCall): HTMLElement {
    const toolCard = h('div', { className: 'sdt-ai-tool-card' });
    const header = h('button', { className: 'sdt-ai-tool-header', type: 'button' });
    header.appendChild(h('span', { className: 'sdt-ai-tool-name' }, toolCall.toolName));
    header.appendChild(h('span', { className: `sdt-ai-tool-status sdt-ai-tool-status-${toolCall.state}` }, toolCall.state));
    header.appendChild(h('span', { className: `sdt-ai-tool-chevron${toolCall.isExpanded ? ' sdt-ai-tool-chevron-open' : ''}` }, '\u25BE'));
    header.addEventListener('click', () => {
      toolCall.isExpanded = !toolCall.isExpanded;
      renderMessages();
    });
    toolCard.appendChild(header);

    if (toolCall.isExpanded) {
      const body = h('div', { className: 'sdt-ai-tool-body' });
      if (toolCall.argsText !== null) {
        body.appendChild(h('div', { className: 'sdt-ai-tool-label' }, 'Args'));
        const argsPre = h('pre', { className: 'sdt-ai-tool-pre' });
        argsPre.appendChild(h('code', null, toolCall.argsText));
        body.appendChild(argsPre);
      }
      if (toolCall.resultText !== null) {
        body.appendChild(h('div', { className: 'sdt-ai-tool-label' }, toolCall.state === 'error' ? 'Error' : 'Result'));
        const resultPre = h('pre', { className: 'sdt-ai-tool-pre' });
        resultPre.appendChild(h('code', null, toolCall.resultText));
        body.appendChild(resultPre);
      }
      if (toolCall.state === 'running') {
        body.appendChild(h('div', { className: 'sdt-ai-tool-running' }, 'Running...'));
      }
      toolCard.appendChild(body);
    }

    return toolCard;
  }

  function renderMessages() {
    messagesArea.innerHTML = '';

    if (messages.length === 0) {
      const empty = h('div', { className: 'sdt-ai-empty' });
      const icon = h('div', { className: 'sdt-ai-empty-icon' });
      setHtml(icon, '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>');
      empty.appendChild(icon);
      empty.appendChild(h('div', { className: 'sdt-ai-empty-title' }, 'Ask AI'));
      empty.appendChild(h('div', { className: 'sdt-ai-empty-desc' }, 'Get help with Hexclave integration, troubleshooting, and best practices.'));

      const suggestions = h('div', { className: 'sdt-ai-suggestions' });
      for (const q of SUGGESTED_QUESTIONS) {
        const btn = h('button', { className: 'sdt-ai-suggestion' });
        btn.appendChild(h('span', { className: 'sdt-ai-suggestion-icon' }, q.icon));
        btn.appendChild(h('span', null, q.text));
        btn.addEventListener('click', () => {
          runAsynchronously(sendMessage(q.text));
        });
        suggestions.appendChild(btn);
      }
      empty.appendChild(suggestions);
      messagesArea.appendChild(empty);
      return;
    }

    const list = h('div', { className: 'sdt-ai-message-list' });
    for (const msg of messages) {
      if (msg.role === 'user') {
        const msgDiv = h('div', { className: 'sdt-ai-msg sdt-ai-msg-user' });
        const bubble = h('div', { className: 'sdt-ai-bubble sdt-ai-bubble-user' });
        bubble.appendChild(h('p', null, msg.content));
        msgDiv.appendChild(bubble);
        const avatarDiv = h('div', { className: 'sdt-ai-avatar sdt-ai-avatar-user' });
        setHtml(avatarDiv, '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>');
        msgDiv.appendChild(avatarDiv);
        list.appendChild(msgDiv);
      } else {
        const msgDiv = h('div', { className: 'sdt-ai-msg sdt-ai-msg-assistant' });
        const avatarDiv = h('div', { className: 'sdt-ai-avatar sdt-ai-avatar-assistant' });
        setHtml(avatarDiv, '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>');
        msgDiv.appendChild(avatarDiv);
        const bubble = h('div', { className: 'sdt-ai-bubble sdt-ai-bubble-assistant' });
        if (msg.parts.length === 0) {
          bubble.innerHTML = '<div class="sdt-ai-thinking"><span class="sdt-ai-thinking-dot"></span><span class="sdt-ai-thinking-dot"></span><span class="sdt-ai-thinking-dot"></span></div>';
        } else {
          for (const part of msg.parts) {
            if (part.type === 'text') {
              const textContainer = h('div', { className: 'sdt-ai-part-text' });
              renderMarkdownInto(textContainer, part.content);
              bubble.appendChild(textContainer);
              continue;
            }

            const toolCall = msg.toolCallsById.get(part.toolCallId);
            if (toolCall == null) {
              const missingTool = h('div', { className: 'sdt-ai-tool-card' });
              const missingBody = h('div', { className: 'sdt-ai-tool-body' });
              missingBody.appendChild(h('div', { className: 'sdt-ai-tool-label' }, 'Error'));
              const missingPre = h('pre', { className: 'sdt-ai-tool-pre' });
              missingPre.appendChild(h('code', null, `Missing tool call state for ${part.toolCallId}`));
              missingBody.appendChild(missingPre);
              missingTool.appendChild(missingBody);
              bubble.appendChild(missingTool);
              continue;
            }
            const toolsContainer = h('div', { className: 'sdt-ai-tools' });
            toolsContainer.appendChild(renderToolCard(toolCall));
            bubble.appendChild(toolsContainer);
          }
        }
        msgDiv.appendChild(bubble);
        list.appendChild(msgDiv);
      }
    }
    messagesArea.appendChild(list);
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function renderMarkdownInto(el: HTMLElement, content: string) {
    function appendBlockWithInlineMarkdown(tag: "p" | "li" | "h1" | "h2" | "h3", className: string, text: string) {
      const block = h(tag, { className });
      appendInlineMarkdown(block, text);
      el.appendChild(block);
    }

    const lines = content.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith('```')) {
        const lang = line.slice(3).trim();
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        i++;
        const block = h('div', { className: 'sdt-ai-code-block' });
        const header = h('div', { className: 'sdt-ai-code-header' });
        header.appendChild(h('span', { className: 'sdt-ai-code-lang' }, lang || 'CODE'));
        const copyBtn = h('button', { className: 'sdt-ai-copy-btn' }, '\u2398');
        const code = codeLines.join('\n');
        copyBtn.addEventListener('click', () => {
          runAsynchronously(navigator.clipboard.writeText(code).then(() => {
            copyBtn.textContent = '\u2713';
            setTimeout(() => {
              copyBtn.textContent = '\u2398';
            }, 1500);
          }));
        });
        header.appendChild(copyBtn);
        block.appendChild(header);
        const pre = h('pre', { className: 'sdt-ai-code-pre' });
        pre.appendChild(h('code', null, code));
        block.appendChild(pre);
        el.appendChild(block);
        continue;
      }

      const headingMatch = line.match(/^(#{1,3}) (.+)/);
      if (headingMatch) {
        const tag = `h${headingMatch[1].length}` as 'h1' | 'h2' | 'h3';
        appendBlockWithInlineMarkdown(tag, "sdt-ai-heading", headingMatch[2]);
        i++;
        continue;
      }

      if (/^[-*] /.test(line)) {
        const ul = h('ul', { className: 'sdt-ai-list' });
        while (i < lines.length && /^[-*] /.test(lines[i])) {
          const li = h("li");
          appendInlineMarkdown(li, lines[i].replace(/^[-*] /, ""));
          ul.appendChild(li);
          i++;
        }
        el.appendChild(ul);
        continue;
      }

      if (/^\d+\. /.test(line)) {
        const ol = h('ol', { className: 'sdt-ai-list sdt-ai-list-ordered' });
        while (i < lines.length && /^\d+\. /.test(lines[i])) {
          const li = h("li");
          appendInlineMarkdown(li, lines[i].replace(/^\d+\. /, ""));
          ol.appendChild(li);
          i++;
        }
        el.appendChild(ol);
        continue;
      }

      if (line.trim() === '') {
        i++;
        continue;
      }

      appendBlockWithInlineMarkdown("p", "sdt-ai-paragraph", line);
      i++;
    }
  }

  function stringifyForDebug(value: unknown): string {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return String(value);
    }
    return JSON.stringify(value, null, 2);
  }

  function getLastItem<T>(items: readonly T[]): T | undefined {
    return items.length > 0 ? items[items.length - 1] : undefined;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function expectObject(value: unknown, payload: string): Record<string, unknown> {
    if (!isRecord(value)) {
      throw new Error(`SSE payload must be an object: ${payload}`);
    }
    return value;
  }

  function getRequiredStringField(event: Record<string, unknown>, field: string, payload: string): string {
    const value = event[field];
    if (typeof value !== 'string') {
      throw new Error(`SSE event '${String(event.type)}' missing string '${field}': ${payload}`);
    }
    return value;
  }

  function getCurrentAssistantMessage(): AssistantMessage {
    const lastMessage = getLastItem(messages);
    if (lastMessage?.role !== 'assistant') {
      throw new Error('Expected current message to be an assistant message');
    }
    return lastMessage;
  }

  function appendTextDelta(delta: string) {
    const assistantMessage = getCurrentAssistantMessage();
    const lastPart = getLastItem(assistantMessage.parts);
    if (lastPart?.type === 'text') {
      lastPart.content += delta;
      return;
    }
    assistantMessage.parts.push({ type: 'text', content: delta });
  }

  function ensureToolPart(assistantMessage: AssistantMessage, toolCallId: string) {
    const hasPart = assistantMessage.parts.some(part => part.type === 'tool' && part.toolCallId === toolCallId);
    if (!hasPart) {
      assistantMessage.parts.push({ type: 'tool', toolCallId });
    }
  }

  function findOrCreateToolCall(toolCallId: string, fallbackToolName: string): ToolCall {
    const assistantMessage = getCurrentAssistantMessage();
    const existing = assistantMessage.toolCallsById.get(toolCallId);
    if (existing != null) {
      if (existing.toolName === 'tool' && fallbackToolName !== 'tool') {
        existing.toolName = fallbackToolName;
      }
      ensureToolPart(assistantMessage, toolCallId);
      return existing;
    }

    const created: ToolCall = {
      id: toolCallId,
      toolName: fallbackToolName,
      argsText: null,
      resultText: null,
      state: 'running',
      errorText: null,
      isExpanded: false,
    };
    assistantMessage.toolCallsById.set(toolCallId, created);
    ensureToolPart(assistantMessage, toolCallId);
    return created;
  }

  async function sendMessage(text: string) {
    if (!text.trim() || aiLoading) return;
    messages.push({ role: 'user', content: text.trim() });
    messages.push({ role: 'assistant', parts: [], toolCallsById: new Map<string, ToolCall>() });
    aiLoading = true;
    renderMessages();
    renderInput();

    try {
      const abortController = new AbortController();
      activeAiAbortController = abortController;
      const res = await fetch(`${apiBaseUrl}/api/latest/ai/query/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getHeaders(),
        },
        signal: abortController.signal,
        body: JSON.stringify({
          systemPrompt: 'command-center-ask-ai',
          tools: ['docs'],
          quality: 'smart',
          speed: 'slow',
          messages: messages
            .slice(0, -1)
            .map((m) => ({
              role: m.role,
              content: [{ type: 'text', text: m.role === 'user' ? m.content : m.parts.filter(part => part.type === 'text').map(part => part.content).join('') }],
            })),
        }),
      });

      if (!res.ok) {
        throw new Error(`AI request failed with status ${res.status}`);
      }
      if (!res.body) {
        throw new Error('AI request returned no response body');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const streamLines = buffer.split('\n');
        buffer = streamLines.pop() || '';

        for (const streamLine of streamLines) {
          const line = streamLine.trim();
          if (line === '' || line.startsWith(':')) continue;
          if (!line.startsWith('data: ')) {
            throw new Error(`Unexpected SSE line: ${line}`);
          }

          const payload = line.slice(6);
          if (payload === '[DONE]') continue;
          const event = expectObject(JSON.parse(payload), payload);
          const eventType = getRequiredStringField(event, 'type', payload);

          switch (eventType) {
            case 'start':
            case 'start-step':
            case 'finish-step':
            case 'finish':
            case 'message-metadata':
            case 'text-start':
            case 'text-end':
            case 'reasoning-start':
            case 'reasoning-delta':
            case 'reasoning-end':
            case 'source-url':
            case 'source-document':
            case 'file': {
              break;
            }
            case 'text-delta': {
              const delta = getRequiredStringField(event, 'delta', payload);
              appendTextDelta(delta);
              break;
            }
            case 'tool-input-start': {
              const toolCallId = getRequiredStringField(event, 'toolCallId', payload);
              const toolName = getRequiredStringField(event, 'toolName', payload);
              const toolCall = findOrCreateToolCall(toolCallId, toolName);
              toolCall.state = 'running';
              toolCall.resultText = null;
              toolCall.errorText = null;
              toolCall.argsText = '';
              break;
            }
            case 'tool-input-delta': {
              const toolCallId = getRequiredStringField(event, 'toolCallId', payload);
              const inputTextDelta = getRequiredStringField(event, 'inputTextDelta', payload);
              const toolCall = findOrCreateToolCall(toolCallId, 'tool');
              toolCall.argsText = (toolCall.argsText ?? '') + inputTextDelta;
              break;
            }
            case 'tool-input-available': {
              const toolCallId = getRequiredStringField(event, 'toolCallId', payload);
              const toolName = getRequiredStringField(event, 'toolName', payload);
              const toolCall = findOrCreateToolCall(toolCallId, toolName);
              toolCall.argsText = stringifyForDebug(event.input);
              break;
            }
            case 'tool-input-error': {
              const toolCallId = getRequiredStringField(event, 'toolCallId', payload);
              const toolName = getRequiredStringField(event, 'toolName', payload);
              const errorText = getRequiredStringField(event, 'errorText', payload);
              const toolCall = findOrCreateToolCall(toolCallId, toolName);
              toolCall.state = 'error';
              toolCall.errorText = errorText;
              toolCall.resultText = errorText;
              break;
            }
            case 'tool-output-available': {
              const toolCallId = getRequiredStringField(event, 'toolCallId', payload);
              const toolCall = findOrCreateToolCall(toolCallId, 'tool');
              const preliminary = event.preliminary === true;
              toolCall.resultText = stringifyForDebug(event.output);
              if (!preliminary) {
                toolCall.state = 'success';
              }
              break;
            }
            case 'tool-output-error': {
              const toolCallId = getRequiredStringField(event, 'toolCallId', payload);
              const errorText = getRequiredStringField(event, 'errorText', payload);
              const toolCall = findOrCreateToolCall(toolCallId, 'tool');
              toolCall.state = 'error';
              toolCall.errorText = errorText;
              toolCall.resultText = errorText;
              break;
            }
            case 'tool-output-denied': {
              const toolCallId = getRequiredStringField(event, 'toolCallId', payload);
              const toolCall = findOrCreateToolCall(toolCallId, 'tool');
              toolCall.state = 'error';
              toolCall.errorText = 'Tool output denied';
              toolCall.resultText = 'Tool output denied';
              break;
            }
            case 'tool-approval-request': {
              const toolCallId = getRequiredStringField(event, 'toolCallId', payload);
              const approvalId = getRequiredStringField(event, 'approvalId', payload);
              const toolCall = findOrCreateToolCall(toolCallId, 'tool');
              toolCall.state = 'running';
              toolCall.resultText = `Approval requested (${approvalId})`;
              break;
            }
            case 'abort': {
              const reason = typeof event.reason === 'string' ? event.reason : 'unknown reason';
              throw new Error(`AI stream aborted: ${reason}`);
            }
            case 'error': {
              throw new Error(
                typeof event.errorText === 'string'
                  ? `AI stream error: ${event.errorText}`
                  : `AI stream error event: ${payload}`
              );
            }
            default: {
              if (eventType.startsWith('data-')) {
                break;
              }
              throw new Error(`Unexpected AI stream event type: ${eventType}`);
            }
          }
        }

        renderMessages();
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        const assistantMessage = getCurrentAssistantMessage();
        if (assistantMessage.parts.length === 0) {
          assistantMessage.parts.push({ type: 'text', content: 'Stopped.' });
        }
        renderMessages();
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown AI stream error';
      const lastMessage = getLastItem(messages);
      if (lastMessage?.role === 'assistant') {
        lastMessage.parts = [{ type: 'text', content: message }];
        lastMessage.toolCallsById.clear();
      }
      renderMessages();
      alert(`AI stream failed: ${message}`);
    } finally {
      aiLoading = false;
      activeAiAbortController = null;
      renderMessages();
      renderInput();
    }
  }

  const inputWrapper = h('div', { className: 'sdt-ai-input-wrapper' });
  const input = h('input', {
    type: 'text',
    className: 'sdt-ai-input',
    placeholder: 'Ask anything about Hexclave...',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const sendBtn = h('button', { className: 'sdt-ai-send-btn', title: 'Send' });
  setHtml(sendBtn, '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>');

  function renderInput() {
    input.disabled = false;
    input.placeholder = messages.length === 0 ? 'Ask anything about Hexclave...' : 'Ask a follow-up...';
    if (aiLoading) {
      sendBtn.classList.add('sdt-ai-send-btn-active');
      sendBtn.classList.add('sdt-ai-stop-btn');
      sendBtn.setAttribute('title', 'Stop');
      setHtml(sendBtn, '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>');
    } else if (input.value.trim()) {
      sendBtn.classList.add('sdt-ai-send-btn-active');
      sendBtn.classList.remove('sdt-ai-stop-btn');
      sendBtn.setAttribute('title', 'Send');
      setHtml(sendBtn, '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>');
    } else {
      sendBtn.classList.remove('sdt-ai-send-btn-active');
      sendBtn.classList.remove('sdt-ai-stop-btn');
      sendBtn.setAttribute('title', 'Send');
      setHtml(sendBtn, '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>');
    }
  }

  input.addEventListener('input', renderInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (aiLoading) {
        activeAiAbortController?.abort();
      } else {
        runAsynchronously(sendMessage(input.value));
        input.value = '';
      }
      renderInput();
    }
  });
  sendBtn.addEventListener('click', () => {
    if (aiLoading) {
      activeAiAbortController?.abort();
    } else {
      runAsynchronously(sendMessage(input.value));
      input.value = '';
    }
    renderInput();
  });

  const newChatBtn = h('button', { className: 'sdt-ai-new-chat', title: 'New conversation', style: { display: 'none' } });
  setHtml(newChatBtn, '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>');
  newChatBtn.addEventListener('click', () => {
    if (aiLoading) {
      activeAiAbortController?.abort();
    }
    messages.length = 0;
    input.value = '';
    renderMessages();
    renderInput();
    newChatBtn.style.display = 'none';
  });

  inputWrapper.append(input, sendBtn);
  inputArea.append(newChatBtn, inputWrapper);

  container.append(messagesArea, inputArea);
  renderMessages();
  renderInput();

  return container;
}

// ---------------------------------------------------------------------------
// Dashboard tab
// ---------------------------------------------------------------------------

function createDashboardTab(app: StackClientApp<true>): HTMLElement {
  const container = h('div', { className: 'sdt-iframe-container' });

  function showChecking() {
    container.innerHTML = '';
    container.appendChild(h('div', { className: 'sdt-iframe-loading' }, 'Checking development environment\u2026'));
  }

  function showUnavailable() {
    container.innerHTML = '';
    const message = h('div', { className: 'sdt-dashboard-unavailable' });
    const text = h('div', { className: 'sdt-dashboard-unavailable-text' });
    text.appendChild(document.createTextNode('Navigate to '));
    text.appendChild(h('a', {
      className: 'sdt-dashboard-unavailable-link',
      href: HOSTED_DASHBOARD_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
    }, HOSTED_DASHBOARD_URL));
    text.appendChild(document.createTextNode(" to view this project's dashboard"));
    message.appendChild(text);
    container.appendChild(message);
  }

  async function check() {
    showChecking();
    const available = await isLocalDashboardProjectAvailable(app);
    // The dev tool may have been torn down while we were probing; only mutate
    // the DOM if this container is still mounted.
    if (!container.isConnected) return;
    if (available) {
      populateIframeTab(
        container,
        localDashboardProjectUrl(app),
        'Hexclave Dashboard',
        'Loading dashboard\u2026',
        'Unable to load dashboard',
        'The dashboard may require authentication or block framing',
        'Open in New Tab',
      );
    } else {
      showUnavailable();
    }
  }

  runAsynchronously(check);
  return container;
}

// ---------------------------------------------------------------------------
// Support tab
// ---------------------------------------------------------------------------

function createSupportTab(app: StackClientApp<true>): HTMLElement {
  const container = h('div', { className: 'sdt-support-tab' });
  const apiBaseUrl = resolveApiBaseUrl(app);

  function createFeedbackForm(): HTMLElement {
    const pane = h('div', { className: 'sdt-support-feedback-pane' });
    const form = h('form', { className: 'sdt-support-form' });

    let feedbackType: 'feedback' | 'bug' = 'feedback';
    let status: 'idle' | 'submitting' | 'success' | 'error' = 'idle';
    let errorMessage = '';

    const nameInput = h('input', { className: 'sdt-support-input', type: 'text', placeholder: 'Your name' }) as HTMLInputElement;
    const emailInput = h('input', { className: 'sdt-support-input', type: 'email', placeholder: 'you@example.com', required: 'true' }) as HTMLInputElement;
    const messageInput = h('textarea', { className: 'sdt-support-textarea', placeholder: "What's on your mind?", required: 'true', rows: '5' }) as HTMLTextAreaElement;

    function render() {
      form.innerHTML = '';

      if (status === 'success') {
        const successDiv = h('div', { className: 'sdt-support-status sdt-support-status-success' });
        const icon = h('div', { className: 'sdt-support-status-icon' });
        setHtml(icon, '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M6 10l3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
        successDiv.append(
          icon,
          h('div', { className: 'sdt-support-status-title' }, 'Feedback sent'),
          h('div', { className: 'sdt-support-status-msg' }, "Thank you! We'll get back to you soon."),
        );
        const resetBtn = h('button', { className: 'sdt-support-submit', style: { marginTop: '12px', width: 'auto' } }, 'Send another');
        resetBtn.addEventListener('click', () => {
          status = 'idle';
          render();
        });
        successDiv.appendChild(resetBtn);
        form.appendChild(successDiv);
        return;
      }

      if (status === 'error') {
        const errDiv = h('div', { className: 'sdt-support-status sdt-support-status-error' });
        const icon = h('div', { className: 'sdt-support-status-icon' });
        setHtml(icon, '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 6v5m0 3h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>');
        errDiv.append(
          icon,
          h('div', { className: 'sdt-support-status-title' }, 'Failed to send'),
          h('div', { className: 'sdt-support-status-msg' }, errorMessage || 'Please try again.'),
        );
        const retryBtn = h('button', { className: 'sdt-support-submit', style: { marginTop: '12px', width: 'auto' } }, 'Try again');
        retryBtn.addEventListener('click', () => {
          status = 'idle';
          errorMessage = '';
          render();
        });
        errDiv.appendChild(retryBtn);
        form.appendChild(errDiv);
        return;
      }

      const nameField = h('div', { className: 'sdt-support-field' });
      const nameLabel = h('label', { className: 'sdt-support-label' }, 'Name ');
      nameLabel.appendChild(h('span', { className: 'sdt-support-optional' }, 'optional'));
      nameField.append(nameLabel, nameInput);
      form.appendChild(nameField);

      const emailField = h('div', { className: 'sdt-support-field' });
      emailField.append(h('label', { className: 'sdt-support-label' }, 'Email'), emailInput);
      form.appendChild(emailField);

      const msgField = h('div', { className: 'sdt-support-field' });
      msgField.append(h('label', { className: 'sdt-support-label' }, feedbackType === 'bug' ? 'Description' : 'Message'), messageInput);
      messageInput.placeholder = feedbackType === 'bug' ? 'Steps to reproduce, expected vs. actual behavior\u2026' : "What's on your mind?";
      form.appendChild(msgField);

      const typeCards = h('div', { className: 'sdt-support-type-cards' });
      const feedbackBtn = h('button', { type: 'button', className: `sdt-support-type-card ${feedbackType === 'feedback' ? 'sdt-support-type-card-active' : ''}` });
      setHtml(feedbackBtn, '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>Feedback</span>');
      feedbackBtn.addEventListener('click', () => {
        feedbackType = 'feedback';
        render();
      });
      const bugBtn = h('button', { type: 'button', className: `sdt-support-type-card ${feedbackType === 'bug' ? 'sdt-support-type-card-active' : ''}` });
      setHtml(bugBtn, '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M6 17H3M21 5c0 2.1-1.6 3.8-3.53 4M18 13h4M21 17h-3"/></svg><span>Bug Report</span>');
      bugBtn.addEventListener('click', () => {
        feedbackType = 'bug';
        render();
      });
      typeCards.append(feedbackBtn, bugBtn);
      form.appendChild(typeCards);

      const submitBtn = h('button', { type: 'submit', className: 'sdt-support-submit' });
      setHtml(submitBtn, 'Submit <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>');
      submitBtn.disabled = status === 'submitting';
      form.appendChild(submitBtn);

      const channels = h('div', { className: 'sdt-support-channels' });
      channels.innerHTML = `
        <a href="https://discord.hexclave.com" target="_blank" rel="noopener noreferrer" class="sdt-support-channel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
          <span>Discord</span>
        </a>
        <a href="mailto:team@hexclave.com" class="sdt-support-channel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
          <span>Email</span>
        </a>
        <a href="https://github.com/hexclave/hexclave" target="_blank" rel="noopener noreferrer" class="sdt-support-channel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>
          <span>GitHub</span>
        </a>`;
      form.appendChild(channels);
      form.insertBefore(channels, form.firstChild);
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!emailInput.value.trim() || !messageInput.value.trim()) return;
      runAsynchronously(async () => {
        status = 'submitting';
        render();
        try {
          const response = await fetch(`${apiBaseUrl}/api/latest/internal/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
              name: nameInput.value.trim() || undefined,
              email: emailInput.value.trim(),
              message: messageInput.value.trim(),
              feedback_type: feedbackType,
            }),
          });
          if (!response.ok) {
            throw new Error(`Failed to send: ${response.status} ${response.statusText}`);
          }
          const result = await response.json();
          if (!result.success) {
            throw new Error(result.message || 'Failed to send feedback');
          }
          status = 'success';
          messageInput.value = '';
        } catch (err: any) {
          status = 'error';
          errorMessage = err.message || 'An unexpected error occurred';
        }
        render();
      });
    });

    render();
    pane.appendChild(form);
    return pane;
  }

  container.appendChild(createFeedbackForm());
  return container;
}

// ---------------------------------------------------------------------------
// Components tab
// ---------------------------------------------------------------------------

function createComponentsTab(app: StackClientApp<true>): HTMLElement {
  const container = h('div', { className: 'sdt-pg-layout' });
  const apiBaseUrl = resolveApiBaseUrl(app);
  const urls = app[hexclaveAppInternalsSymbol].getUrls();
  const urlOptions: HandlerUrlOptions = app[hexclaveAppInternalsSymbol].getConstructorOptions().urls ?? {};

  const PAGE_ENTRIES: { key: keyof HandlerUrls; label: string }[] = [
    { key: 'signIn' as any, label: 'Sign-in' },
    { key: 'signUp' as any, label: 'Sign-up' },
    { key: 'forgotPassword' as any, label: 'Forgot password' },
    { key: 'passwordReset' as any, label: 'Password reset' },
    { key: 'emailVerification' as any, label: 'Email verification' },
    { key: 'accountSettings' as any, label: 'Account settings' },
    { key: 'teamInvitation' as any, label: 'Team invitation' },
    { key: 'cliAuthConfirm' as any, label: 'CLI auth confirmation' },
    { key: 'mfa' as any, label: 'MFA' },
    { key: 'onboarding' as any, label: 'Onboarding' },
    { key: 'error' as any, label: 'Error' },
  ];

  type PageClassification = 'handler-component' | 'hosted' | 'custom';

  function classifyPage(key: keyof HandlerUrls): { classification: PageClassification; version: number | null } {
    const target: HandlerUrlTarget = (urlOptions as any)[key] ?? (urlOptions as any).default ?? { type: 'handler-component' };
    if (typeof target === 'string') {
      return { classification: 'custom', version: null };
    }
    if ('type' in target) {
      if (target.type === 'custom') {
        return { classification: 'custom', version: (target as any).version ?? null };
      }
      return { classification: target.type as PageClassification, version: null };
    }
    return { classification: 'handler-component', version: null };
  }

  type PageInfo = {
    key: keyof HandlerUrls;
    label: string;
    url: string;
    classification: PageClassification;
    version: number | null;
    versionStatus: string;
    versionChangelogs: { version: number; changelog: string }[];
  };

  let latestVersions: Map<string, { version: number; changelogs: Record<number, string> }> | null = null;
  let selectedKey: string | null = null;

  runAsynchronously(
    fetch(`${apiBaseUrl}/api/latest/internal/component-versions`)
      .then((r) => r.json())
      .then((data) => {
        latestVersions = new Map(Object.entries(data.versions ?? {}));
        renderSidebar();
      })
      .catch(() => {})
  );

  function buildPages(): PageInfo[] {
    return PAGE_ENTRIES.map((entry) => {
      const { classification, version } = classifyPage(entry.key);
      let versionStatus = 'current';
      let versionChangelogs: { version: number; changelog: string }[] = [];

      if (classification === 'custom' && version != null && latestVersions) {
        const info = latestVersions.get(entry.key as string);
        if (info && version < info.version) {
          versionStatus = 'outdated';
          versionChangelogs = Object.entries(info.changelogs)
            .map(([v, cl]) => ({ version: Number(v), changelog: cl }))
            .filter((e) => e.version > version)
            .sort((a, b) => a.version - b.version);
        }
      }

      return {
        key: entry.key,
        label: entry.label,
        url: (urls as any)[entry.key] || '',
        classification,
        version,
        versionStatus,
        versionChangelogs,
      };
    });
  }

  const sidebar = h('div', { className: 'sdt-pg-sidebar' });
  const mainArea = h('div', { className: 'sdt-pg-main' });

  function renderSidebar() {
    sidebar.innerHTML = '';
    const pages = buildPages();
    const outdatedCount = pages.filter((p) => p.versionStatus === 'outdated').length;

    const head = h('div', { className: 'sdt-pg-sidebar-head' });
    head.appendChild(h('span', { className: 'sdt-pg-sidebar-title' }, 'Pages'));
    head.appendChild(h('span', { className: 'sdt-pg-sidebar-count' }, String(pages.length)));
    if (outdatedCount > 0) {
      head.appendChild(h('span', { className: 'sdt-pg-sidebar-warn' }, `${outdatedCount} outdated`));
    }
    sidebar.appendChild(head);

    const list = h('div', { className: 'sdt-pg-list' });
    for (const page of pages) {
      const isOutdated = page.versionStatus === 'outdated';
      const item = h('div', {
        className: `sdt-pg-item ${isOutdated ? 'sdt-pg-item-warn' : ''}`,
        'data-selected': String(selectedKey === page.key),
      });
      const dotClass = isOutdated
        ? 'sdt-pg-item-dot-warn'
        : page.classification === 'custom'
          ? 'sdt-pg-item-dot-custom'
          : 'sdt-pg-item-dot-handler';
      item.appendChild(h('span', { className: `sdt-pg-item-dot ${dotClass}` }));
      item.appendChild(h('span', { className: 'sdt-pg-item-label' }, page.label));
      if (isOutdated) {
        item.appendChild(h('span', { className: 'sdt-pg-badge sdt-pg-badge-outdated' }, 'Outdated'));
      }
      item.addEventListener('click', () => {
        selectedKey = page.key as string;
        renderSidebar();
        renderDetail(page);
      });
      list.appendChild(item);
    }
    sidebar.appendChild(list);
  }

  function renderDetail(page: PageInfo) {
    mainArea.innerHTML = '';
    const detail = h('div', { className: 'sdt-pg-detail' });

    const header = h('div', { className: 'sdt-pg-header' });
    const headerTop = h('div', { className: 'sdt-pg-header-top' });
    headerTop.appendChild(h('h3', { className: 'sdt-pg-title' }, `${page.label} Page`));
    if (page.versionStatus === 'outdated') {
      headerTop.appendChild(h('span', { className: 'sdt-pg-badge sdt-pg-badge-outdated' }, 'Outdated'));
    }
    header.appendChild(headerTop);

    const redirectMethod = `hexclaveApp.redirectTo${(page.key as string).charAt(0).toUpperCase()}${(page.key as string).slice(1)}()`;
    const codeRow = h('div', { className: 'sdt-pg-code-inline' });
    codeRow.appendChild(h('code', { className: 'sdt-pg-code' }, redirectMethod));
    const openBtn = h('button', { className: 'sdt-pg-copy-btn sdt-pg-open-btn' });
    setHtml(openBtn, 'Open <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M7 7h10v10"/></svg>');
    openBtn.addEventListener('click', () => {
      const openedWindow = window.open('about:blank', '_blank');
      if (openedWindow != null) {
        openedWindow.opener = null;
      }
      runAsynchronouslyWithAlert(async () => {
        const redirectUrl = await app[hexclaveAppInternalsSymbol].getRedirectToHandlerUrl(page.key);
        const resolved = new URL(redirectUrl, window.location.origin);
        if (openedWindow != null) {
          openedWindow.location.replace(resolved.toString());
        } else {
          window.open(resolved.toString(), '_blank', 'noopener,noreferrer');
        }
      });
    });
    codeRow.appendChild(openBtn);
    header.appendChild(codeRow);
    detail.appendChild(header);

    const prompt = getPagePrompt(page.key as string, page.version ?? undefined);
    if (prompt) {
      const isOutdated = page.versionStatus === 'outdated';
      const showPrompt = page.classification === 'handler-component' || page.classification === 'hosted' || isOutdated;
      if (showPrompt) {
        let promptText: string;
        if (isOutdated && prompt.upgradePrompt) {
          promptText = prompt.upgradePrompt;
        } else if (prompt.fullPrompt) {
          promptText = prompt.fullPrompt;
        } else {
          promptText = '';
        }

        if (promptText) {
          const section = h('div', { className: 'sdt-pg-section' });
          section.appendChild(h('div', { className: 'sdt-pg-section-label' }, isOutdated ? 'Use this prompt to upgrade your component:' : 'Want to customize this page? Paste this prompt into your coding agent.'));
          section.appendChild(h('pre', { className: 'sdt-pg-pre' }, promptText));
          const footer = h('div', { className: 'sdt-pg-section-footer' });
          const copyBtn = h('button', { className: 'sdt-pg-copy-btn' }, 'Copy prompt');
          copyBtn.addEventListener('click', () => {
            runAsynchronously(navigator.clipboard.writeText(promptText).then(() => {
              copyBtn.textContent = '\u2713 Copied';
              setTimeout(() => {
                copyBtn.textContent = 'Copy prompt';
              }, 1500);
            }));
          });
          footer.appendChild(copyBtn);
          section.appendChild(footer);
          detail.appendChild(section);
        }
      }
    }

    mainArea.appendChild(detail);
  }

  function renderEmptyMain() {
    mainArea.innerHTML = '';
    const empty = h('div', { className: 'sdt-pg-empty' });
    const icon = h('div', { className: 'sdt-pg-empty-icon' });
    setHtml(icon, '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>');
    empty.appendChild(icon);
    empty.appendChild(h('div', { className: 'sdt-pg-empty-text' }, 'Select a page to inspect'));
    empty.appendChild(h('div', { className: 'sdt-pg-empty-sub' }, 'View configuration, preview, and upgrade prompts'));
    mainArea.appendChild(empty);
  }

  renderSidebar();
  renderEmptyMain();

  container.append(sidebar, mainArea);
  return container;
}

// ---------------------------------------------------------------------------
// Panel (main shell with tab bar and content area)
// ---------------------------------------------------------------------------

function createPanel(
  app: StackClientApp<true>,
  state: ReturnType<typeof createStateStore>,
  logStore: LogStore,
  onClose: () => void,
): { element: HTMLElement, cleanup: () => void } {
  const panel = h('div', { className: 'sdt-panel' });
  let panelAnimationTimeout: ReturnType<typeof setTimeout> | null = null;

  function animateNextPanelGeometryChange() {
    panel.classList.add('sdt-panel-geometry-animated');
    if (panelAnimationTimeout !== null) {
      clearTimeout(panelAnimationTimeout);
    }
    panelAnimationTimeout = setTimeout(() => {
      panel.classList.remove('sdt-panel-geometry-animated');
      panelAnimationTimeout = null;
    }, 220);
  }

  function applyPanelMode(tabId: TabId, opts?: { animate?: boolean }) {
    if (opts?.animate === true) {
      animateNextPanelGeometryChange();
    }

    if (tabId === 'dashboard') {
      panel.classList.add('sdt-panel-fullscreen');
      panel.style.width = '';
      panel.style.height = '';
      return;
    }

    panel.classList.remove('sdt-panel-fullscreen');
    panel.style.width = state.get().panelWidth + 'px';
    panel.style.height = state.get().panelHeight + 'px';
  }

  const tabs = TABS;
  const storedActiveTab = state.get().activeTab;
  const activeTab = tabs.some((tab) => tab.id === storedActiveTab) ? storedActiveTab : DEFAULT_STATE.activeTab;

  applyPanelMode(activeTab);

  const inner = h('div', { className: 'sdt-panel-inner' });

  const closeBtn = h('button', { className: 'sdt-close-btn', 'aria-label': 'Close' });
  setHtml(closeBtn, '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="3" x2="11" y2="11"/><line x1="11" y1="3" x2="3" y2="11"/></svg>');
  closeBtn.addEventListener('click', onClose);

  const docsLink = h('a', { href: DOCS_URL, target: '_blank', rel: 'noopener noreferrer', className: 'sdt-docs-link' });
  docsLink.appendChild(document.createTextNode('Docs'));
  const docsIcon = h('span', { className: 'sdt-docs-link-icon', 'aria-hidden': 'true' });
  setHtml(docsIcon, '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7"/><path d="M7 7h10v10"/></svg>');
  docsLink.appendChild(docsIcon);

  const trailingControls = h('div', { className: 'sdt-tabbar-actions' }, docsLink, closeBtn);

  const tabBar = createTabBar(tabs, activeTab, (id) => {
    state.update({ activeTab: id as TabId });
    applyPanelMode(id as TabId, { animate: true });
    showTab(id as TabId);
  }, { trailing: trailingControls });
  inner.appendChild(tabBar.el);

  const content = h('div', { className: 'sdt-content' });
  const layers = h('div', { className: 'sdt-tab-layers' });
  content.appendChild(layers);
  inner.appendChild(content);

  const mountedPanes = new Map<TabId, HTMLElement>();
  const cleanups: Array<() => void> = [];

  function mountTab(pane: HTMLElement, result: TabResult | HTMLElement) {
    if ('element' in result) {
      pane.appendChild(result.element);
      if (result.cleanup) {
        cleanups.push(result.cleanup);
      }
    } else {
      pane.appendChild(result);
    }
  }

  function getOrCreatePane(tabId: TabId): HTMLElement {
    if (mountedPanes.has(tabId)) {
      return mountedPanes.get(tabId)!;
    }
    const pane = h('div', { className: 'sdt-tab-pane' });
    if (tabId === 'dashboard') {
      pane.classList.add('sdt-tab-pane-iframe');
    }
    switch (tabId) {
      case 'overview': {
        mountTab(pane, createOverviewTab(app));
        break;
      }
      case 'customize': {
        mountTab(pane, createComponentsTab(app));
        break;
      }
      case 'ai': {
        mountTab(pane, createAITab(app));
        break;
      }
      case 'console': {
        mountTab(pane, createConsoleTab(logStore));
        break;
      }
      case 'dashboard': {
        mountTab(pane, createDashboardTab(app));
        break;
      }
      case 'support': {
        mountTab(pane, createSupportTab(app));
        break;
      }
    }
    mountedPanes.set(tabId, pane);
    layers.appendChild(pane);
    return pane;
  }

  function showTab(tabId: TabId) {
    const pane = getOrCreatePane(tabId);
    tabBar.setActive(tabId);
    for (const [, p] of mountedPanes) {
      p.classList.remove('sdt-tab-pane-active');
    }
    pane.classList.add('sdt-tab-pane-active');
  }

  showTab(activeTab);

  function addResizeHandle(edge: 'top' | 'left' | 'top-left') {
    const handle = h('div', { className: `sdt-resize-handle sdt-resize-${edge}` });
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (panelAnimationTimeout !== null) {
        clearTimeout(panelAnimationTimeout);
        panelAnimationTimeout = null;
      }
      panel.classList.remove('sdt-panel-geometry-animated');
      handle.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;
      startW = panel.offsetWidth;
      startH = panel.offsetHeight;
    });

    handle.addEventListener('pointermove', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const dx = startX - e.clientX;
      const dy = startY - e.clientY;
      if (edge === 'left' || edge === 'top-left') {
        const newW = Math.max(400, Math.min(startW + dx, window.innerWidth - 32));
        panel.style.width = newW + 'px';
      }
      if (edge === 'top' || edge === 'top-left') {
        const newH = Math.max(300, Math.min(startH + dy, window.innerHeight - 80));
        panel.style.height = newH + 'px';
      }
    });

    handle.addEventListener('pointerup', (e) => {
      handle.releasePointerCapture(e.pointerId);
      state.update({ panelWidth: panel.offsetWidth, panelHeight: panel.offsetHeight });
    });

    panel.appendChild(handle);
  }

  addResizeHandle('top');
  addResizeHandle('left');
  addResizeHandle('top-left');

  panel.appendChild(inner);
  return {
    element: panel,
    cleanup: () => {
      if (panelAnimationTimeout !== null) {
        clearTimeout(panelAnimationTimeout);
      }
      for (const fn of cleanups) fn();
    },
  };
}

// ===========================================================================================
// Main entry point
// ===========================================================================================

export function createDevTool(app: StackClientApp<true>): () => void {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return () => {};
  }
  const body = document['body'];
  if (!hasAppendChild(body)) return () => {};

  getGlobalUiInstance(GLOBAL_INSTANCE_KEY)?.cleanup();
  let existingRoot = document.getElementById(ROOT_ID);
  while (existingRoot !== null) {
    existingRoot.remove();
    existingRoot = document.getElementById(ROOT_ID);
  }

  const root = document.createElement('div');
  root.id = ROOT_ID;
  body.appendChild(root);

  const wrapper = h('div', { className: 'hexclave-devtool' });
  root.appendChild(wrapper);

  const style = document.createElement('style');
  style.textContent = devToolCSS;
  wrapper.appendChild(style);

  const state = createStateStore();
  const logStore = getGlobalLogStore();

  let panel: { element: HTMLElement, cleanup: () => void } | null = null;

  function closePanelAndPersistClosed() {
    closePanel();
  }

  function openPanel() {
    if (panel) return;
    panel = createPanel(app, state, logStore, closePanelAndPersistClosed);
    wrapper.appendChild(panel.element);
  }

  function closePanel() {
    if (!panel) return;
    state.update({ isOpen: false });
    const closing = panel;
    panel = null;
    closing.cleanup();
    closing.element.classList.add('sdt-panel-exiting');
    setTimeout(() => {
      if (wrapper.contains(closing.element)) {
        wrapper.removeChild(closing.element);
      }
    }, 150);
  }

  function togglePanel() {
    if (state.get().isOpen) {
      closePanel();
    } else {
      state.update({ isOpen: true });
      openPanel();
    }
  }

  const trigger = createTrigger(togglePanel);
  wrapper.appendChild(trigger.element);

  if (state.get().isOpen) {
    openPanel();
  }

  const removeRequestListener = app[hexclaveAppInternalsSymbol].addRequestListener((entry: RequestLogEntry) => {
    const timestamp = Date.now();
    logStore.addApiLog({
      id: nextId(),
      timestamp,
      method: entry.method,
      url: entry.path,
      status: entry.status,
      duration: entry.duration,
      error: entry.error,
    });
    if (entry.error) {
      logStore.addEventLog({ id: nextId(), timestamp, type: 'error', message: `Network error on ${entry.method} ${entry.path}: ${entry.error}` });
    } else if (entry.status && entry.status >= 400) {
      logStore.addEventLog({ id: nextId(), timestamp, type: 'error', message: `API error ${entry.status} on ${entry.method} ${entry.path}` });
    }
  });

  let didCleanup = false;
  const instance: UiGlobalInstance = {
    cleanup: () => {
      if (didCleanup) return;
      didCleanup = true;
      if (getGlobalUiInstance(GLOBAL_INSTANCE_KEY) === instance) {
        setGlobalUiInstance(GLOBAL_INSTANCE_KEY, null);
      }
      trigger.cleanup();
      removeRequestListener();
      panel?.cleanup();
      if (root.parentNode) {
        root.parentNode.removeChild(root);
      }
    },
  };
  setGlobalUiInstance(GLOBAL_INSTANCE_KEY, instance);

  return () => {
    instance.cleanup();
  };
}

// END_PLATFORM

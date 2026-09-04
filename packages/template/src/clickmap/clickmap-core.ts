// IF_PLATFORM js-like

// Standalone clickmap overlay. This module is fully independent from the dev
// tool (packages/template/src/dev-tool): it has its own DOM root, its own
// stylesheet, and its own mount lifecycle, so the dev tool can be changed or
// removed without affecting clickmaps. It's opened via a dashboard-minted
// token (the CLICKMAP_OVERLAY_TOKEN_UPDATED event / resume flow) — see
// ./index.ts for the lazy-loading entry point.

import { AnalyticsClickmapResponseBodySchema, type AnalyticsClickmapResponse } from "@hexclave/shared/dist/interface/admin-metrics";
import {
  CLICKMAP_OVERLAY_RESUME_STORAGE_KEY,
  CLICKMAP_OVERLAY_TOKEN_STORAGE_KEY,
  CLICKMAP_OVERLAY_TOKEN_UPDATED_EVENT,
} from "@hexclave/shared/dist/utils/analytics-clickmap-overlay";
import { CLICKMAP_ROOT_ID, DEV_TOOL_ROOT_ID } from "@hexclave/shared/dist/utils/dev-tool";
import { cssEscapeIdent } from "@hexclave/shared/dist/utils/dom";
import { buildElementsChain, parseElementsChain, type ElementsChainSegment } from "@hexclave/shared/dist/utils/elements-chain";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { getGlobalUiInstance, h, hasAppendChild, setGlobalUiInstance, setHtml, type UiGlobalInstance } from "../in-page-ui/dom";
import type { StackClientApp } from "../lib/hexclave-app";
import { hexclaveAppInternalsSymbol } from "../lib/hexclave-app/common";
import { clickmapCSS } from "./clickmap-styles";

type ClickmapPanelResult = { element: HTMLElement, cleanup?: () => void };

// ---------------------------------------------------------------------------
// Clickmap panel
// ---------------------------------------------------------------------------

type ClickmapClickGroup = {
  selector: string;
  label: string;
  count: number;
  // Clicks on this element that produced no observable effect (is_dead rows).
  deadCount: number;
  element: Element | null;
  rect: DOMRect | null;
};

type ClickmapGroupOverlayElement = {
  marker: HTMLElement;
  outline: HTMLElement;
};

type ClickmapListRowElement = {
  row: HTMLElement;
  count: HTMLElement;
  check: HTMLButtonElement;
  eye: HTMLButtonElement;
  label: HTMLElement;
  dead: HTMLElement;
  selector: HTMLElement;
  group: ClickmapClickGroup | null;
  renderedEyeIcon: string;
  renderedCheckIcon: string;
};

const CLICKMAP_FILTERS_STORAGE_KEY = 'hexclave-clickmap-overlay-filters';

type ClickmapRangeKey = '24h' | '7d' | '30d';
type ClickmapDeviceKey = 'all' | 'mobile' | 'tablet' | 'laptop' | 'desktop' | 'widescreen' | 'tv';

type ClickmapFilters = {
  range: ClickmapRangeKey,
  device: ClickmapDeviceKey,
  urlPattern: string,
  elementSearch: string,
  // Reveal dead clicks in the overlay. Off by default: every displayed count
  // is alive clicks only, dead chips are hidden, and elements whose clicks
  // were all dead are dropped. Pure client-side filter — the server response
  // always carries both clicks (total) and dead_clicks per element, so
  // toggling never refetches.
  showDead: boolean,
};

type ClickmapViewportBucket = {
  min: number,
  max: number | null,
};

const CLICKMAP_DEFAULT_FILTERS: ClickmapFilters = {
  range: '7d',
  device: 'all',
  urlPattern: '',
  elementSearch: '',
  showDead: false,
};

const CLICKMAP_RANGE_MS: Record<ClickmapRangeKey, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const CLICKMAP_VIEWPORT_BUCKETS: Record<Exclude<ClickmapDeviceKey, 'all'>, ClickmapViewportBucket> = {
  mobile: { min: 0, max: 767 },
  tablet: { min: 768, max: 1023 },
  laptop: { min: 1024, max: 1199 },
  desktop: { min: 1200, max: 1439 },
  widescreen: { min: 1440, max: 1919 },
  tv: { min: 1920, max: null },
};

function getClickmapViewportBucket(device: ClickmapDeviceKey): ClickmapViewportBucket | null {
  if (device === 'all') return null;
  return CLICKMAP_VIEWPORT_BUCKETS[device];
}

function isClickmapViewportWidthInBucket(width: number, bucket: ClickmapViewportBucket): boolean {
  return width >= bucket.min && (bucket.max == null || width <= bucket.max);
}

function getClickmapRecommendedViewportWidth(bucket: ClickmapViewportBucket): number {
  if (bucket.max == null) return bucket.min;
  return Math.round((bucket.min + bucket.max) / 2);
}

function formatClickmapViewportBucket(bucket: ClickmapViewportBucket): string {
  if (bucket.max == null) return `${bucket.min}px+`;
  return `${bucket.min}-${bucket.max}px`;
}

function isClickmapRangeKey(value: unknown): value is ClickmapRangeKey {
  return value === '24h' || value === '7d' || value === '30d';
}
function isClickmapDeviceKey(value: unknown): value is ClickmapDeviceKey {
  return value === 'all' || value === 'mobile' || value === 'tablet' || value === 'laptop' || value === 'desktop' || value === 'widescreen' || value === 'tv';
}
const CLICKMAP_DOM_INDEX_DEBOUNCE_MS = 250;

type ServerClickmapSelector = {
  selector: string;
  clicks: number;
};

type ServerClickmapElement = {
  elementsChain: string;
  elementsText: string;
  tagName: string;
  href: string | null;
  clicks: number;
  deadClicks: number;
};

type ServerClickmap = {
  path: string;
  // True aggregate click total returned for the active filter (summed across
  // every matching route), independent of how many elements can be drawn on the
  // current page's DOM. The overlay can only render elements that exist on the
  // page you're viewing, but this count reflects the full pattern.
  totalClicks: number;
  selectors: ServerClickmapSelector[];
  elements: ServerClickmapElement[];
};

function cssEscapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function readChainAttr(segment: ElementsChainSegment, attr: string): string {
  if (!Object.prototype.hasOwnProperty.call(segment.attrs, attr)) return '';
  const value = segment.attrs[attr];
  return typeof value === 'string' ? value : '';
}

// Compact, human-readable counts for tight UI surfaces (markers, chips,
// stats): 999 → "999", 1234 → "1.2k", 1_250_000 → "1.3m", 2e9 → "2b". One
// decimal place (trailing .0 drops out of the arithmetic), and rounding
// cascades into the next unit so 999_950+ reads "1m" rather than "1000k".
function formatClickmapCount(value: number): string {
  let scaled = value;
  let suffix = '';
  for (const nextSuffix of ['k', 'm', 'b']) {
    // 999.95 is the smallest value that would display as "1000" at one
    // decimal place, so it already belongs to the next unit up.
    if (scaled < 999.95) break;
    scaled /= 1000;
    suffix = nextSuffix;
  }
  if (suffix === '') return String(Math.round(scaled));
  return `${Math.round(scaled * 10) / 10}${suffix}`;
}

function getClickmapHue(count: number, maxCount: number): number {
  if (maxCount <= 1) return 185;
  const intensity = Math.min(1, count / maxCount);
  return 185 - Math.round(intensity * 155);
}


function getReadableElementLabel(element: Element): string {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel != null && ariaLabel.trim() !== '') {
    return ariaLabel.trim().slice(0, 80);
  }
  const title = element.getAttribute('title');
  if (title != null && title.trim() !== '') {
    return title.trim().slice(0, 80);
  }
  const text = element.textContent.trim().replace(/\s+/g, ' ');
  if (text !== '') {
    return text.slice(0, 80);
  }
  return element.tagName.toLowerCase();
}

function isElementVisibleForClickmap(element: Element): boolean {
  // Never treat our own UI (or the dev tool's, if it happens to be mounted
  // alongside) as a clickmap candidate.
  if (element.closest(`#${cssEscapeIdent(CLICKMAP_ROOT_ID)}, #${cssEscapeIdent(DEV_TOOL_ROOT_ID)}`) != null) {
    return false;
  }
  if (element.closest('[hidden], [aria-hidden="true"], [inert]') != null) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  return true;
}

function getElementFromSelector(selector: string): Element | null {
  try {
    const elements = Array.from(document.querySelectorAll(selector));
    return elements.find(isElementVisibleForClickmap) ?? null;
  } catch {
    return null;
  }
}

function getSessionStorageString(key: string): string | null {
  try {
    const value = sessionStorage.getItem(key);
    return value == null || value.trim() === '' ? null : value;
  } catch {
    return null;
  }
}

function removeSessionStorageItem(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Storage can be blocked in private or embedded contexts; the toolbar keeps
    // rendering the actionable error state in that case.
  }
}

// Read a string claim out of a JWT payload without verifying the signature. The
// clickmap token is self-describing — it carries the `project_id` and `origin`
// it was minted for — so the overlay derives both from the token itself instead
// of needing them handed over alongside. The server still verifies the token on
// every request; this is only used to scope/label the token client-side.
function getJwtPayloadClaim(token: string, claim: string): string | null {
  const tokenParts = token.split('.');
  if (tokenParts.length < 2 || tokenParts[1] === '') {
    return null;
  }
  try {
    const payloadPart = tokenParts[1];
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload: unknown = JSON.parse(atob(padded));
    if (typeof payload !== 'object' || payload === null) {
      return null;
    }
    const value = payload[claim];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function getClickmapTokenFromStorage(): string | null {
  return getSessionStorageString(CLICKMAP_OVERLAY_TOKEN_STORAGE_KEY);
}

function getClickmapOriginFromStorage(): string | null {
  const token = getClickmapTokenFromStorage();
  return token == null ? null : getJwtPayloadClaim(token, 'origin');
}

function clearClickmapTokenStorage(): void {
  removeSessionStorageItem(CLICKMAP_OVERLAY_TOKEN_STORAGE_KEY);
}

function parseServerClickmapResponse(value: unknown, path: string): ServerClickmap {
  let parsed: AnalyticsClickmapResponse;
  try {
    // Validate against the canonical response contract instead of hand-walking
    // `unknown`. Anything that doesn't match is treated as "no data" so the
    // overlay stays alive rather than crashing on shape drift.
    parsed = AnalyticsClickmapResponseBodySchema.validateSync(value);
  } catch {
    return { path, totalClicks: 0, selectors: [], elements: [] };
  }
  return {
    path,
    // True aggregate across every matching route, independent of what the
    // current DOM can render.
    totalClicks: parsed.routes.reduce((sum, route) => sum + route.clicks, 0),
    selectors: parsed.selectors.map((selector) => ({ selector: selector.selector, clicks: selector.clicks })),
    elements: parsed.elements.map((element) => ({
      elementsChain: element.elements_chain,
      elementsText: element.elements_text,
      tagName: element.tag_name,
      href: element.href,
      clicks: element.clicks,
      deadClicks: element.dead_clicks,
    })),
  };
}

// Heuristic: does this path segment look like an opaque per-entity id (a UUID,
// numeric id, Mongo ObjectId, ULID, etc.) rather than a human-readable slug?
// Used to auto-wildcard slug routes so a single clickmap pattern aggregates
// across every user/team instead of just the one currently in the URL.
function isDynamicPathSegment(segment: string): boolean {
  if (segment === '') return false;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // keep the raw segment if it isn't valid percent-encoding
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) return true; // UUID
  if (/^[0-9a-f]{32}$/i.test(decoded)) return true; // UUID without dashes / md5
  if (/^[0-9a-f]{24}$/i.test(decoded)) return true; // Mongo ObjectId
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(decoded)) return true; // ULID
  if (/^\d+$/.test(decoded)) return true; // numeric id
  return false;
}

// Turn the current pathname into a clickmap URL pattern by replacing id-like
// segments with `*` (PostHog-style wildcards). Stable slugs are preserved so
// e.g. `/teams/<uuid>/settings` becomes `/teams/*/settings`.
function wildcardizePathname(pathname: string): string {
  const trailingSlash = pathname.length > 1 && pathname.endsWith('/');
  const segments = pathname.split('/').map((segment) => (isDynamicPathSegment(segment) ? '*' : segment));
  const joined = segments.join('/');
  return trailingSlash ? `${joined}/` : joined;
}

// Translate a PostHog-style glob (where `*` is the only wildcard) into an
// anchored regex source mirroring the backend's SQL LIKE semantics.
function globToRegexSource(glob: string): string {
  return glob
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
}

// Does `path` match the active URL pattern? Used to tell the user when the page
// they're on isn't covered by the pattern, so the overlay can't be drawn here
// even though aggregate data exists. Glob matching mirrors the backend's
// anchored `LIKE`.
function patternMatchesPath(pattern: string, path: string): boolean {
  if (pattern === '') return true;
  try {
    return new RegExp(`^${globToRegexSource(pattern)}$`).test(path);
  } catch {
    return false;
  }
}

function createClickmapPanel(app: StackClientApp<true>, onClose: () => void): ClickmapPanelResult {
  const container = h('div', { className: 'sdt-hm' });
  const overlayHighlight = h('div', { className: 'sdt-hm-highlight' });
  const overlayRoot = h('div', { className: 'sdt-hm-overlay-root', 'aria-hidden': 'true' }, overlayHighlight);
  const statsCount = h('div', { className: 'sdt-hm-stat-value' }, '0');
  const selectorCount = h('div', { className: 'sdt-hm-stat-value' }, '0');
  const viewportValue = h('div', { className: 'sdt-hm-stat-value' }, `${window.innerWidth}x${window.innerHeight}`);
  const list = h('div', { className: 'sdt-hm-list' });
  const empty = h('div', { className: 'sdt-hm-empty' }, 'Paste a clickmap token from the dashboard to load aggregated element clicks for this page.');
  const status = h('div', { className: 'sdt-hm-token-status' });
  const viewportWarningTitle = h('div', { className: 'sdt-hm-viewport-warning-title' });
  const viewportWarningBody = h('div', { className: 'sdt-hm-viewport-warning-body' });
  const viewportWarningWidthValue = h('code', { className: 'sdt-hm-viewport-warning-code' });
  const viewportWarningHeightValue = h('code', { className: 'sdt-hm-viewport-warning-code' });
  const viewportWarningWidthCopy = h('button', { className: 'sdt-hm-copy-btn', type: 'button' });
  const viewportWarningHeightCopy = h('button', { className: 'sdt-hm-copy-btn', type: 'button' });
  const viewportWarning = h('div', { className: 'sdt-hm-viewport-warning', role: 'status' },
    viewportWarningTitle,
    viewportWarningBody,
    h('div', { className: 'sdt-hm-viewport-warning-actions' },
      h('span', { className: 'sdt-hm-viewport-warning-action' },
        h('span', { className: 'sdt-hm-viewport-warning-label' }, 'Width'),
        viewportWarningWidthValue,
        viewportWarningWidthCopy,
      ),
      h('span', { className: 'sdt-hm-viewport-warning-action' },
        h('span', { className: 'sdt-hm-viewport-warning-label' }, 'Height'),
        viewportWarningHeightValue,
        viewportWarningHeightCopy,
      ),
    ),
  );
  const overlayToggle = h('button', { className: 'sdt-hm-btn sdt-hm-btn-primary' }, 'Hide');
  const expandButton = h('button', { className: 'sdt-hm-icon-btn', 'aria-label': 'Expand clickmap options', 'data-sdt-tip': 'Expand clickmap options' });
  const closeButton = h('button', { className: 'sdt-hm-icon-btn', 'aria-label': 'Close clickmap', 'data-sdt-tip': 'Close clickmap' });
  const miniClicks = h('span', { className: 'sdt-hm-toolbar-metric-value' }, '0');
  const miniElements = h('span', { className: 'sdt-hm-toolbar-metric-value' }, '0');

  function readStoredFilters(): ClickmapFilters {
    try {
      const raw = sessionStorage.getItem(CLICKMAP_FILTERS_STORAGE_KEY);
      if (raw == null) return { ...CLICKMAP_DEFAULT_FILTERS };
      const parsed: unknown = JSON.parse(raw);
      if (parsed == null || typeof parsed !== 'object') return { ...CLICKMAP_DEFAULT_FILTERS };
      const obj = parsed as Record<string, unknown>;
      return {
        range: isClickmapRangeKey(obj.range) ? obj.range : CLICKMAP_DEFAULT_FILTERS.range,
        device: isClickmapDeviceKey(obj.device) ? obj.device : CLICKMAP_DEFAULT_FILTERS.device,
        urlPattern: typeof obj.urlPattern === 'string' ? obj.urlPattern : CLICKMAP_DEFAULT_FILTERS.urlPattern,
        elementSearch: typeof obj.elementSearch === 'string' ? obj.elementSearch : CLICKMAP_DEFAULT_FILTERS.elementSearch,
        showDead: typeof obj.showDead === 'boolean' ? obj.showDead : CLICKMAP_DEFAULT_FILTERS.showDead,
      };
    } catch {
      return { ...CLICKMAP_DEFAULT_FILTERS };
    }
  }
  function persistFilters(next: ClickmapFilters) {
    try {
      sessionStorage.setItem(CLICKMAP_FILTERS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage errors
    }
  }

  let currentPath = window.location.pathname;
  let serverClickmap: ServerClickmap = { path: currentPath, totalClicks: 0, selectors: [], elements: [] };
  let loadingServerClickmap = false;
  let serverClickmapError: string | null = null;
  let serverClickmapRequestId = 0;
  let overlayVisible = true;
  let expanded = false;
  let renderFrame = 0;
  let overlayMode: 'hidden' | 'elements' = 'hidden';
  let highlightedGroupSelector: string | null = null;
  let highlightRenderedSelector: string | null = null;
  let highlightSettleTimer: number | null = null;
  // Hovering a count marker tints its outline. The marker button is the only
  // pointer-interactive part of the overlay (outlines are pointer-events:none
  // so the page stays usable), so it owns the hover.
  let hoveredGroupSelector: string | null = null;
  const mutedGroupSelectors = new Set<string>();
  // Datagrid-style row selection, keyed by the same selector ids as muting but
  // independent of it: it drives the page highlight and scopes the list
  // header's bulk show/hide actions. The anchor remembers the last plainly
  // clicked row so shift+click can extend a contiguous range in list order.
  const selectedGroupSelectors = new Set<string>();
  let selectionAnchorSelector: string | null = null;
  // Snapshot of the groups from the last render, in list order. Range
  // selection and the header's bulk actions operate on this.
  let latestGroups: ClickmapClickGroup[] = [];
  const groupOverlayElements = new Map<string, ClickmapGroupOverlayElement>();
  const listRowElements = new Map<string, ClickmapListRowElement>();

  function resetCopyButton(button: HTMLElement, label: string) {
    button.textContent = label;
  }

  function copyClickmapViewportValue(button: HTMLElement, value: string, label: string) {
    runAsynchronously(async () => {
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = 'Copied';
        window.setTimeout(() => resetCopyButton(button, label), 1200);
      } catch {
        button.textContent = 'Copy failed';
        window.setTimeout(() => resetCopyButton(button, label), 1600);
      }
    });
  }

  // DOM-index cache for fast element-chain inference.
  const domIndex = new Map<string, Element[]>();
  let domIndexDirty = true;
  let domIndexDebounce = 0;
  function rebuildDomIndex() {
    domIndex.clear();
    trimTargetCache = new WeakMap();
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (!isElementVisibleForClickmap(el)) continue;
      const tag = el.tagName.toLowerCase();
      const bucket = domIndex.get(tag) ?? [];
      bucket.push(el);
      domIndex.set(tag, bucket);
    }
    domIndexDirty = false;
  }

  // Attribute clicks to the logical control, not the fragment the browser
  // reported (PostHog's trimElement). A click on a <span> or <svg> inside a
  // button records a span/svg-leaf chain, so the matched element walks up to
  // the nearest clickable ancestor: a real control (semantic selector) or the
  // element where cursor:pointer begins (computed pointer while the parent's
  // isn't — catches div-as-button components with zero hardcoded tags). No
  // hit within the cap returns the element unchanged. Resolution happens here
  // at render time, never at capture: stored chains stay raw, so these rules
  // can evolve and historical clicks regroup for free.
  const CLICKMAP_TRIM_TARGET_SELECTOR = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [contenteditable="true"]';
  const CLICKMAP_TRIM_MAX_HOPS = 10;
  // getComputedStyle on every hop is too hot for the per-render group loop;
  // resolutions are cached per matched element and dropped together with the
  // dom index (same trigger: the page's DOM changed).
  let trimTargetCache = new WeakMap<Element, { target: Element, key: string }>();
  function resolveClickTarget(start: Element): { target: Element, key: string } {
    const cached = trimTargetCache.get(start);
    if (cached != null) return cached;
    let target = start;
    let current: Element | null = start;
    for (let hops = 0; current != null && current !== document.body && current !== document.documentElement && hops < CLICKMAP_TRIM_MAX_HOPS; hops++) {
      if (current.matches(CLICKMAP_TRIM_TARGET_SELECTOR)) {
        target = current;
        break;
      }
      const parent: Element | null = current.parentElement;
      if (window.getComputedStyle(current).cursor === 'pointer' && (parent == null || window.getComputedStyle(parent).cursor !== 'pointer')) {
        target = current;
        break;
      }
      current = parent;
    }
    const resolved = { target, key: buildElementsChain(target) };
    trimTargetCache.set(start, resolved);
    return resolved;
  }
  function ensureDomIndex() {
    if (domIndexDirty) rebuildDomIndex();
  }
  function invalidateDomIndex() {
    domIndexDirty = true;
  }
  function scheduleDomIndexInvalidation() {
    if (domIndexDebounce !== 0) {
      window.clearTimeout(domIndexDebounce);
    }
    domIndexDebounce = window.setTimeout(() => {
      domIndexDebounce = 0;
      invalidateDomIndex();
      scheduleRender();
    }, CLICKMAP_DOM_INDEX_DEBOUNCE_MS);
  }

  function isElementChainCandidateUnique(matches: Element[]): Element | null {
    const visible = matches.filter(isElementVisibleForClickmap);
    return visible.length === 1 ? visible[0] : null;
  }

  function queryUniqueBySelector(selector: string): Element | null {
    try {
      const all = Array.from(document.querySelectorAll(selector));
      return isElementChainCandidateUnique(all);
    } catch {
      return null;
    }
  }

  function elementMatchesSegment(element: Element, segment: ElementsChainSegment, useClasses: boolean): boolean {
    if (element.tagName.toLowerCase() !== segment.tag) return false;
    if (useClasses) {
      for (const cls of segment.classes) {
        if (!element.classList.contains(cls)) return false;
      }
    }
    return true;
  }

  function ancestorMatchesChain(leaf: Element, chain: ElementsChainSegment[], useClasses: boolean, useNthOfType: boolean, useNthChild: boolean): boolean {
    let cursor: Element | null = leaf;
    for (let i = 0; i < chain.length; i++) {
      if (cursor == null) return false;
      const segment = chain[i];
      if (!elementMatchesSegment(cursor, segment, useClasses)) return false;
      if (useNthOfType && segment.nthOfType != null) {
        if (computeNthOfType(cursor) !== segment.nthOfType) return false;
      }
      if (useNthChild && segment.nthChild != null) {
        if (computeNthChild(cursor) !== segment.nthChild) return false;
      }
      cursor = cursor.parentElement;
    }
    return true;
  }

  function computeNthOfType(el: Element): number {
    let n = 1;
    let sib = el.previousElementSibling;
    const tag = el.tagName;
    while (sib != null) {
      if (sib.tagName === tag) n += 1;
      sib = sib.previousElementSibling;
    }
    return n;
  }

  function computeNthChild(el: Element): number {
    let n = 1;
    let sib = el.previousElementSibling;
    while (sib != null) {
      n += 1;
      sib = sib.previousElementSibling;
    }
    return n;
  }

  function inferElementFromChain(chain: ElementsChainSegment[]): Element | null {
    if (chain.length === 0) return null;
    const leaf = chain[0];

    // 1. Stable attribute selectors on leaf (no tag).
    const stableAttrOrder: Array<{ attr: string, prefix?: string }> = [
      { attr: 'data-hexclave-id' },
      { attr: 'data-testid' },
      { attr: 'data-test-id' },
      { attr: 'name' },
    ];
    for (const { attr } of stableAttrOrder) {
      const value = readChainAttr(leaf, attr);
      if (value === '') continue;
      const sel = `[${attr}="${cssEscapeAttrValue(value)}"]`;
      const match: Element | null = queryUniqueBySelector(sel);
      if (match) return match;
    }
    const id = readChainAttr(leaf, 'id');
    if (id !== '') {
      const match: Element | null = queryUniqueBySelector(`#${cssEscapeIdent(id)}`);
      if (match) return match;
    }
    if (leaf.href != null && leaf.href !== '' && leaf.tag === 'a') {
      const match: Element | null = queryUniqueBySelector(`a[href="${cssEscapeAttrValue(leaf.href)}"]`);
      if (match) return match;
    }

    // 2. Tag + stable attribute on the leaf.
    const otherStableAttrs = ['aria-label', 'role', 'placeholder', 'title', 'type'];
    for (const attr of otherStableAttrs) {
      const value = readChainAttr(leaf, attr);
      if (value === '') continue;
      const sel = `${leaf.tag}[${attr}="${cssEscapeAttrValue(value)}"]`;
      const match: Element | null = queryUniqueBySelector(sel);
      if (match) return match;
    }

    // 3, 4, 5: walk the DOM index by leaf tag, score the chain.
    ensureDomIndex();
    const candidates = domIndex.get(leaf.tag) ?? [];
    if (candidates.length === 0) return null;

    // Variant 3: tag.classes across the chain, no nth.
    const v3: Element[] = [];
    for (const candidate of candidates) {
      if (ancestorMatchesChain(candidate, chain, true, false, false)) v3.push(candidate);
    }
    const u3 = isElementChainCandidateUnique(v3);
    if (u3 != null) return u3;

    // Variant 4: tag.classes + nth-of-type.
    const v4: Element[] = [];
    for (const candidate of candidates) {
      if (ancestorMatchesChain(candidate, chain, true, true, false)) v4.push(candidate);
    }
    const u4 = isElementChainCandidateUnique(v4);
    if (u4 != null) return u4;

    // Variant 5: tag.classes + nth-child.
    const v5: Element[] = [];
    for (const candidate of candidates) {
      if (ancestorMatchesChain(candidate, chain, true, true, true)) v5.push(candidate);
    }
    const u5 = isElementChainCandidateUnique(v5);
    if (u5 != null) return u5;

    return null;
  }

  setHtml(closeButton, '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>');
  const chevronUpSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';
  const chevronDownSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  const clicksIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/></svg>';
  const elementsIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>';
  const eyeIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeOffIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';
  // Only swap the chevron when the expanded state actually changes. render()
  // runs constantly (route poll, scroll, body mutations), and rewriting the
  // button's SVG on every pass detaches the element under the user's pointer
  // mid-press, which makes the browser drop the click entirely — the button
  // appeared to have dead spots wherever the icon sat.
  let renderedExpandIcon = '';
  function syncExpandIcon() {
    const icon = expanded ? chevronDownSvg : chevronUpSvg;
    if (renderedExpandIcon === icon) return;
    renderedExpandIcon = icon;
    setHtml(expandButton, icon);
  }
  syncExpandIcon();
  resetCopyButton(viewportWarningWidthCopy, 'Copy width');
  resetCopyButton(viewportWarningHeightCopy, 'Copy height');
  viewportWarningWidthCopy.addEventListener('click', () => {
    copyClickmapViewportValue(viewportWarningWidthCopy, viewportWarningWidthValue.textContent, 'Copy width');
  });
  viewportWarningHeightCopy.addEventListener('click', () => {
    copyClickmapViewportValue(viewportWarningHeightCopy, viewportWarningHeightValue.textContent, 'Copy height');
  });

  const stats = h('div', { className: 'sdt-hm-stats' },
    h('div', { className: 'sdt-hm-stat' }, h('div', { className: 'sdt-hm-stat-label' }, 'Clicks'), statsCount),
    h('div', { className: 'sdt-hm-stat' }, h('div', { className: 'sdt-hm-stat-label' }, 'Elements'), selectorCount),
    h('div', { className: 'sdt-hm-stat' }, h('div', { className: 'sdt-hm-stat-label' }, 'Viewport'), viewportValue),
  );

  let filters: ClickmapFilters = readStoredFilters();
  let filterReloadDebounce = 0;
  // When the user hasn't typed a custom pattern, the URL pattern field mirrors
  // the current route with id-like segments auto-wildcarded (`/teams/*/settings`)
  // so the clickmap aggregates across all entities. A stored non-empty pattern
  // means the user took manual control, so we leave it alone.
  let urlPatternUserEdited = filters.urlPattern.trim() !== '';

  function getEffectiveUrlPattern(): string {
    if (urlPatternUserEdited) return filters.urlPattern.trim();
    return wildcardizePathname(window.location.pathname);
  }
  // Reflect the current route into the field while in auto mode. No-op once the
  // user has typed their own pattern.
  function syncAutoUrlPattern() {
    if (urlPatternUserEdited) return;
    const auto = wildcardizePathname(window.location.pathname);
    if (urlPatternInput.value !== auto) {
      urlPatternInput.value = auto;
    }
  }

  function makeFilterSelect(options: Array<[string, string]>, value: string): HTMLSelectElement {
    const el = h('select', { className: 'sdt-hm-filter-input' }) as HTMLSelectElement;
    for (const [optValue, label] of options) {
      const opt = h('option', { value: optValue }, label) as HTMLOptionElement;
      el.appendChild(opt);
    }
    el.value = value;
    return el;
  }

  const rangeSelect = makeFilterSelect([
    ['24h', 'Last 24h'],
    ['7d', 'Last 7 days'],
    ['30d', 'Last 30 days'],
  ], filters.range);
  // Viewport filter as a segmented switcher: equal-weight options with a single
  // pill that slides to the active mode, instead of a hidden-until-opened native
  // <select>. The thumb is an absolutely-positioned element measured from the
  // active button so labels of different widths still track precisely.
  const deviceOptions: [ClickmapDeviceKey, string][] = [
    ['all', 'All'],
    ['mobile', 'Mobile'],
    ['tablet', 'Tablet'],
    ['laptop', 'Laptop'],
    ['desktop', 'Desktop'],
    ['widescreen', 'Wide'],
    ['tv', 'TV'],
  ];
  const deviceThumb = h('span', { className: 'sdt-hm-seg-thumb', 'aria-hidden': 'true' });
  const deviceSwitcher = h('div', {
    className: 'sdt-hm-seg',
    role: 'radiogroup',
    'aria-label': 'Viewport',
  }, deviceThumb);
  const deviceButtons = new Map<ClickmapDeviceKey, HTMLButtonElement>();
  // Skip the animated slide the very first time the thumb is placed (panel open),
  // so it appears already parked on the active option rather than sweeping in.
  let deviceThumbPlaced = false;
  function positionDeviceThumb() {
    const active = deviceButtons.get(filters.device);
    // While the panel is collapsed the switcher isn't laid out (offsetWidth 0);
    // defer until it has real geometry so the thumb lands in the right place.
    if (active == null || active.offsetWidth === 0) return;
    if (!deviceThumbPlaced) {
      deviceThumb.style.transition = 'none';
    }
    deviceThumb.style.transform = `translateX(${active.offsetLeft}px)`;
    deviceThumb.style.width = `${active.offsetWidth}px`;
    if (!deviceThumbPlaced) {
      // Force a reflow so the no-transition placement commits before we hand
      // animation back, otherwise the first real move wouldn't tween.
      void deviceThumb.offsetWidth;
      deviceThumb.style.transition = '';
      deviceThumbPlaced = true;
    }
  }
  for (const [key, label] of deviceOptions) {
    const btn = h('button', {
      className: 'sdt-hm-seg-btn',
      type: 'button',
      role: 'radio',
    }, label) as HTMLButtonElement;
    btn.setAttribute('aria-checked', String(key === filters.device));
    btn.addEventListener('click', () => {
      if (filters.device === key) return;
      updateFilters({ device: key });
      for (const [k, b] of deviceButtons) {
        b.setAttribute('aria-checked', String(k === key));
      }
      positionDeviceThumb();
    });
    deviceButtons.set(key, btn);
    deviceSwitcher.appendChild(btn);
  }
  const urlPatternInput = h('input', {
    className: 'sdt-hm-filter-input',
    type: 'text',
    placeholder: '/products/*',
    spellcheck: 'false',
    autocomplete: 'off',
    autocapitalize: 'off',
  }) as HTMLInputElement;
  urlPatternInput.value = getEffectiveUrlPattern();
  // Reverts the field back to the auto-wildcarded current route. Shown whenever
  // the field holds a custom pattern (i.e. reverting would change something).
  const urlPatternReset = h('button', {
    className: 'sdt-hm-filter-reset',
    type: 'button',
    'aria-label': 'Revert the URL pattern to the current page',
    'data-sdt-tip': 'Revert to the current page',
  }) as HTMLButtonElement;
  setHtml(urlPatternReset, '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>');

  // The revert button appears the moment the field diverges from the
  // auto-wildcarded current route. Toggled directly from the input handlers (on
  // top of render()) so it shows up immediately on edit, independent of the
  // panel's expanded state and of whether the pattern still covers this page.
  function syncUrlPatternResetVisibility() {
    const auto = wildcardizePathname(window.location.pathname);
    const showReset = urlPatternUserEdited && filters.urlPattern.trim() !== auto;
    urlPatternReset.classList.toggle('sdt-hm-filter-reset-visible', showReset);
  }

  // Info button + popover explaining the URL pattern syntax. The backend
  // translates `*` into a SQL LIKE `%`, so `*` is the only wildcard — every
  // other character is matched literally against the page's pathname.
  const urlPatternInfo = h('button', {
    className: 'sdt-hm-filter-info',
    type: 'button',
    'aria-label': 'URL pattern help',
    'aria-expanded': 'false',
    'data-sdt-tip': 'How URL patterns work',
  }) as HTMLButtonElement;
  setHtml(urlPatternInfo, '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>');

  function makeUrlHelpRow(pattern: string, description: string): HTMLElement {
    return h('div', { className: 'sdt-hm-url-help-row' },
      h('code', { className: 'sdt-hm-url-help-code' }, pattern),
      h('span', { className: 'sdt-hm-url-help-desc' }, description),
    );
  }
  function makeCode(text: string): HTMLElement {
    return h('code', { className: 'sdt-hm-url-help-code' }, text);
  }
  const urlHelpTitle = h('div', { className: 'sdt-hm-url-help-title' });
  const urlHelpBody = h('div', { className: 'sdt-hm-url-help-body' });
  const urlHelpRows = h('div', { className: 'sdt-hm-url-help-rows' });
  function renderUrlHelp() {
    urlHelpTitle.textContent = 'URL pattern · glob';
    urlHelpBody.replaceChildren(
      'Limits the clickmap to pages whose path matches. Matched against the pathname only — no domain, hash, or query string. ',
      makeCode('*'),
      ' is the only wildcard and stands in for any characters (including ',
      makeCode('/'),
      '). Everything else is matched literally.',
    );
    urlHelpRows.replaceChildren(
      makeUrlHelpRow('/pricing', 'That exact page'),
      makeUrlHelpRow('/products/*', 'Any path under /products/'),
      makeUrlHelpRow('/teams/*/members', 'A wildcard segment in the middle'),
      makeUrlHelpRow('*/settings', 'Any path ending in /settings'),
      makeUrlHelpRow('*', 'Every page'),
      makeUrlHelpRow('(empty)', 'Auto-tracks the page you are viewing'),
    );
  }
  const urlPatternHelp = h('div', { className: 'sdt-hm-url-help', role: 'dialog', 'aria-label': 'URL pattern help' },
    urlHelpTitle,
    urlHelpBody,
    urlHelpRows,
  );

  let urlHelpOpen = false;
  function setUrlHelpOpen(open: boolean) {
    urlHelpOpen = open;
    urlPatternHelp.classList.toggle('sdt-hm-url-help-open', open);
    urlPatternInfo.setAttribute('aria-expanded', String(open));
  }
  urlPatternInfo.addEventListener('click', (event) => {
    event.stopPropagation();
    setUrlHelpOpen(!urlHelpOpen);
  });
  urlPatternHelp.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  renderUrlHelp();

  const elementSearchInput = h('input', {
    className: 'sdt-hm-filter-input',
    type: 'text',
    placeholder: 'Search element text or tag',
    'aria-label': 'Search element text or tag',
    spellcheck: 'false',
    autocomplete: 'off',
    autocapitalize: 'off',
  }) as HTMLInputElement;
  elementSearchInput.value = filters.elementSearch;

  function wrapFilterField(label: string, input: HTMLElement, action?: HTMLElement): HTMLElement {
    const labelRow = h('span', { className: 'sdt-hm-filter-label-row' },
      h('span', { className: 'sdt-hm-filter-label' }, label),
    );
    if (action != null) {
      labelRow.appendChild(action);
    }
    return h('label', { className: 'sdt-hm-filter-field' },
      labelRow,
      input,
    );
  }

  // The range and URL-pattern controls live in the always-visible toolbar so
  // they're reachable whether or not the panel is expanded (the previous pill
  // only showed a static title + a single clicks badge and felt empty). The
  // remaining filters stay in the expanded body.
  const clicksIcon = h('span', { className: 'sdt-hm-toolbar-metric-icon' });
  const elementsIcon = h('span', { className: 'sdt-hm-toolbar-metric-icon' });
  setHtml(clicksIcon, clicksIconSvg);
  setHtml(elementsIcon, elementsIconSvg);

  // "Show dead clicks" toggle. Two synced controls — a compact icon toggle in
  // the always-visible toolbar and a labeled button in the expanded actions
  // row — flip the same filters.showDead flag. Off (default) the overlay
  // pretends dead clicks don't exist: counts are alive-only and all-dead
  // elements are hidden; on, totals include dead clicks and the per-element
  // "% dead" chips appear. Icons are written once at creation (see
  // syncExpandIcon for the dead-spot hazard of rewriting SVG on every
  // render); state sync only toggles classes/attrs.
  const showDeadIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg>';
  const showDeadMiniToggle = h('button', {
    className: 'sdt-hm-icon-btn sdt-hm-dead-toggle',
    type: 'button',
    'aria-pressed': 'false',
    'aria-label': 'Show dead clicks',
    'data-sdt-tip': 'Show dead clicks',
  }) as HTMLButtonElement;
  setHtml(showDeadMiniToggle, showDeadIconSvg);
  const showDeadToggleIcon = h('span', { className: 'sdt-hm-dead-toggle-icon' });
  setHtml(showDeadToggleIcon, showDeadIconSvg);
  const showDeadToggle = h('button', {
    className: 'sdt-hm-btn sdt-hm-dead-toggle',
    type: 'button',
    'aria-pressed': 'false',
    'data-sdt-tip': 'Include clicks that had no effect',
  }, showDeadToggleIcon, 'Dead clicks') as HTMLButtonElement;

  function syncShowDeadToggles() {
    for (const button of [showDeadMiniToggle, showDeadToggle]) {
      button.setAttribute('aria-pressed', String(filters.showDead));
      button.classList.toggle('sdt-hm-dead-toggle-active', filters.showDead);
    }
  }
  function setShowDead(next: boolean) {
    if (filters.showDead === next) return;
    filters = { ...filters, showDead: next };
    persistFilters(filters);
    syncShowDeadToggles();
    scheduleRender();
  }
  showDeadMiniToggle.addEventListener('click', () => setShowDead(!filters.showDead));
  showDeadToggle.addEventListener('click', () => setShowDead(!filters.showDead));
  syncShowDeadToggles();

  // Overlay visibility toggle in the always-visible toolbar, twinned with the
  // expanded panel's labeled button (both flip overlayVisible). Eye = shown,
  // eye-off = hidden; the icon is only rewritten on state flips (see
  // syncExpandIcon for the dead-spot hazard of rewriting SVG every render).
  const overlayMiniToggle = h('button', {
    className: 'sdt-hm-icon-btn',
    type: 'button',
    'aria-pressed': 'false',
    'aria-label': 'Hide overlay',
    'data-sdt-tip': 'Hide overlay',
  }) as HTMLButtonElement;
  let renderedOverlayMiniIcon = '';
  function syncOverlayMiniToggle() {
    overlayMiniToggle.setAttribute('aria-pressed', String(!overlayVisible));
    const label = overlayVisible ? 'Hide overlay' : 'Show overlay';
    overlayMiniToggle.setAttribute('aria-label', label);
    overlayMiniToggle.setAttribute('data-sdt-tip', label);
    overlayMiniToggle.classList.toggle('sdt-hm-overlay-mini-off', !overlayVisible);
    const icon = overlayVisible ? eyeIconSvg : eyeOffIconSvg;
    if (renderedOverlayMiniIcon !== icon) {
      renderedOverlayMiniIcon = icon;
      setHtml(overlayMiniToggle, icon);
    }
  }
  overlayMiniToggle.addEventListener('click', () => {
    overlayVisible = !overlayVisible;
    render();
  });
  syncOverlayMiniToggle();
  const toolbar = h('div', { className: 'sdt-hm-toolbar' },
    closeButton,
    h('div', { className: 'sdt-hm-toolbar-title' }, 'Clickmap'),
    h('div', { className: 'sdt-hm-toolbar-filters' },
      rangeSelect,
      h('div', { className: 'sdt-hm-toolbar-url' }, urlPatternInput, urlPatternReset, urlPatternInfo, urlPatternHelp),
    ),
    h('div', { className: 'sdt-hm-toolbar-metrics' },
      h('span', { className: 'sdt-hm-toolbar-metric', 'data-sdt-tip': 'Aggregate clicks' }, miniClicks, clicksIcon),
      h('span', { className: 'sdt-hm-toolbar-metric', 'data-sdt-tip': 'Mapped elements' }, miniElements, elementsIcon),
    ),
    showDeadMiniToggle,
    overlayMiniToggle,
    expandButton,
  );

  // The mismatch warning is anchored directly under the viewport switcher it
  // describes (not in the scrollable body, where it sat below the status line
  // and could scroll out of view while the filter that triggered it stayed
  // visible). It can't live inside the field's <label>: a label click
  // activates its first labelable descendant, so warning text clicks would
  // press the first segment button.
  const filterRow = h('div', { className: 'sdt-hm-filters' },
    wrapFilterField('Viewport', deviceSwitcher),
    viewportWarning,
  );

  function scheduleFilterReload() {
    if (filterReloadDebounce !== 0) {
      window.clearTimeout(filterReloadDebounce);
    }
    filterReloadDebounce = window.setTimeout(() => {
      filterReloadDebounce = 0;
      runAsynchronously(loadServerClickmap());
    }, 250);
  }

  function updateFilters(next: Partial<ClickmapFilters>) {
    filters = { ...filters, ...next };
    persistFilters(filters);
    scheduleFilterReload();
  }

  let elementSearchDebounce = 0;
  function updateElementSearch(value: string) {
    filters = { ...filters, elementSearch: value };
    persistFilters(filters);
    if (elementSearchDebounce !== 0) {
      window.clearTimeout(elementSearchDebounce);
    }
    elementSearchDebounce = window.setTimeout(() => {
      elementSearchDebounce = 0;
      scheduleRender();
    }, 120);
  }

  rangeSelect.addEventListener('change', () => {
    if (isClickmapRangeKey(rangeSelect.value)) updateFilters({ range: rangeSelect.value });
  });
  urlPatternInput.addEventListener('input', () => {
    const value = urlPatternInput.value;
    // Clearing the field hands control back to auto mode (reflect the route).
    urlPatternUserEdited = value.trim() !== '';
    updateFilters({ urlPattern: value });
    syncUrlPatternResetVisibility();
  });
  urlPatternReset.addEventListener('click', () => {
    // Hand control back to auto mode and reflect the current route immediately,
    // so the pattern covers the page the overlay is bound to.
    urlPatternUserEdited = false;
    urlPatternInput.value = wildcardizePathname(window.location.pathname);
    updateFilters({ urlPattern: '' });
    syncUrlPatternResetVisibility();
  });
  elementSearchInput.addEventListener('input', () => {
    updateElementSearch(elementSearchInput.value);
  });

  // Two regions: a fixed head (viewport filter + stats/actions) and a
  // scrolling body (status, list header, list). Element search lives in the
  // sticky list header next to the selection and bulk-visibility controls,
  // so every list control sits in one row directly above the rows it
  // operates on. Keeping borders to a single head/body divider avoids the
  // dense stack of bordered bands that made the expanded panel feel
  // congested.
  const actions = h('div', { className: 'sdt-hm-actions' }, stats, showDeadToggle, overlayToggle);
  const head = h('div', { className: 'sdt-hm-head' },
    filterRow,
    actions,
  );
  // Datagrid-style list header: master checkbox + selection summary on the
  // left, bulk visibility actions on the right. Sticky inside the scrolling
  // body so the bulk actions stay reachable while the list scrolls.
  const listHeaderCheck = h('button', {
    className: 'sdt-hm-row-check',
    type: 'button',
    role: 'checkbox',
    'aria-checked': 'false',
    'aria-label': 'Select all elements',
  }) as HTMLButtonElement;
  const listHeaderSummary = h('span', { className: 'sdt-hm-list-header-summary' });
  const listShowButton = h('button', { className: 'sdt-hm-btn sdt-hm-btn-sm', type: 'button' }, 'Show all') as HTMLButtonElement;
  const listHideButton = h('button', { className: 'sdt-hm-btn sdt-hm-btn-sm', type: 'button' }, 'Hide all') as HTMLButtonElement;
  const listHeader = h('div', { className: 'sdt-hm-list-header' },
    listHeaderCheck,
    listHeaderSummary,
    elementSearchInput,
    listShowButton,
    listHideButton,
  );
  listHeaderCheck.addEventListener('click', () => {
    const allSelected = latestGroups.length > 0 && latestGroups.every((group) => selectedGroupSelectors.has(group.selector));
    if (allSelected) {
      clearSelection();
      return;
    }
    selectedGroupSelectors.clear();
    for (const group of latestGroups) selectedGroupSelectors.add(group.selector);
    selectionAnchorSelector = null;
    scheduleRender();
  });
  listShowButton.addEventListener('click', () => {
    for (const group of getBulkActionGroups()) mutedGroupSelectors.delete(group.selector);
    scheduleRender();
  });
  listHideButton.addEventListener('click', () => {
    for (const group of getBulkActionGroups()) mutedGroupSelectors.add(group.selector);
    scheduleRender();
  });
  const body = h('div', { className: 'sdt-hm-body' }, status, listHeader, list);
  const details = h('div', { className: 'sdt-hm-details' }, head, body);

  function getGroups(): ClickmapClickGroup[] {
    const byKey = new Map<string, ClickmapClickGroup>();
    if (serverClickmap.path !== currentPath) {
      return [];
    }

    const searchQuery = filters.elementSearch.trim().toLowerCase();
    const matchesSearch = (entry: ServerClickmapElement): boolean => {
      if (searchQuery === '') return true;
      const haystacks = [entry.elementsText, entry.tagName, entry.href ?? '', entry.elementsChain];
      return haystacks.some((value) => value.toLowerCase().includes(searchQuery));
    };

    // Prefer the elements-chain inference path (PostHog-style).
    if (serverClickmap.elements.length > 0) {
      ensureDomIndex();
      for (const elementEntry of serverClickmap.elements) {
        if (!matchesSearch(elementEntry)) continue;
        const chain = parseElementsChain(elementEntry.elementsChain);
        let element = chain.length > 0 ? inferElementFromChain(chain) : null;
        if (element == null && elementEntry.href != null && elementEntry.href !== '' && elementEntry.tagName.toLowerCase() === 'a') {
          element = queryUniqueBySelector(`a[href="${cssEscapeAttrValue(elementEntry.href)}"]`);
        }
        if (element == null) continue;
        // Group by the trimmed click target, not the raw chain: span-leaf and
        // button-leaf rows for the same control land in one group.
        const { target, key } = resolveClickTarget(element);
        const existing = byKey.get(key);
        if (existing != null) {
          existing.count += elementEntry.clicks;
          existing.deadCount += elementEntry.deadClicks;
          continue;
        }
        byKey.set(key, {
          selector: key,
          label: getReadableElementLabel(target),
          count: elementEntry.clicks,
          deadCount: elementEntry.deadClicks,
          element: target,
          rect: target.getBoundingClientRect(),
        });
      }
    }

    // Legacy selectors fallback (older backends or unresolved chains).
    if (byKey.size === 0) {
      for (const selectorClickmap of serverClickmap.selectors) {
        if (searchQuery !== '' && !selectorClickmap.selector.toLowerCase().includes(searchQuery)) continue;
        const element = getElementFromSelector(selectorClickmap.selector);
        if (element == null) continue;
        const { target, key } = resolveClickTarget(element);
        const existing = byKey.get(key);
        if (existing != null) {
          existing.count += selectorClickmap.clicks;
          continue;
        }
        byKey.set(key, {
          selector: key,
          label: getReadableElementLabel(target),
          count: selectorClickmap.clicks,
          // Legacy selector rows have no dead-click aggregation.
          deadCount: 0,
          element: target,
          rect: target.getBoundingClientRect(),
        });
      }
    }

    let groups = Array.from(byKey.values());
    if (!filters.showDead) {
      // Dead clicks are hidden by default: an element whose clicks were all
      // dead has nothing left to display.
      groups = groups.filter((group) => getGroupDisplayCount(group) > 0);
    }
    return groups.sort((a, b) => getGroupDisplayCount(b) - getGroupDisplayCount(a) || stringCompare(a.selector, b.selector));
  }

  // Displayed numbers follow the toggle: alive clicks only by default, full
  // totals (alive + dead) when dead clicks are shown. The clamp guards
  // against sampling-scaled dead counts rounding above the scaled total.
  function getGroupDisplayCount(group: ClickmapClickGroup): number {
    return filters.showDead ? group.count : Math.max(0, group.count - group.deadCount);
  }

  function getDeadClickPercentage(group: ClickmapClickGroup): number {
    if (group.count <= 0) return 100;
    return Math.min(100, Math.round((group.deadCount / group.count) * 100));
  }

  function scheduleRender() {
    cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(render);
  }

  function clearClickmapOverlayElements() {
    groupOverlayElements.clear();
    overlayRoot.replaceChildren(overlayHighlight);
    overlayHighlight.classList.remove('sdt-hm-highlight-visible', 'sdt-hm-highlight-animating');
    highlightRenderedSelector = null;
  }

  function clearClickmapListElements() {
    listRowElements.clear();
    list.replaceChildren();
  }

  function getClickmapViewportSize(): { width: number, height: number } {
    const visualViewport = window.visualViewport;
    if (visualViewport != null) {
      return { width: visualViewport.width, height: visualViewport.height };
    }
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function shouldShowElements(): boolean {
    return overlayVisible;
  }

  function toggleMutedGroup(selector: string) {
    if (mutedGroupSelectors.has(selector)) {
      mutedGroupSelectors.delete(selector);
    } else {
      mutedGroupSelectors.add(selector);
    }
    scheduleRender();
  }

  function clearSelection() {
    if (selectedGroupSelectors.size === 0 && highlightedGroupSelector == null) return;
    selectedGroupSelectors.clear();
    selectionAnchorSelector = null;
    highlightedGroupSelector = null;
    scheduleRender();
  }

  function toggleSelectedGroup(selector: string) {
    if (selectedGroupSelectors.has(selector)) {
      selectedGroupSelectors.delete(selector);
      if (highlightedGroupSelector === selector) highlightedGroupSelector = null;
    } else {
      selectedGroupSelectors.add(selector);
      highlightedGroupSelector = selector;
    }
    selectionAnchorSelector = selector;
    scheduleRender();
  }

  // Datagrid click semantics on list rows: plain click selects just that row
  // (clicking the only selected row clears the selection again), ctrl/cmd
  // toggles membership, shift extends a contiguous range from the anchor in
  // list order. The most recently clicked row becomes the highlighted lead,
  // which drives the page's glide-highlight box.
  function selectGroupFromEvent(group: ClickmapClickGroup, event: { shiftKey: boolean, ctrlKey: boolean, metaKey: boolean }) {
    const toggle = event.ctrlKey || event.metaKey;
    if (event.shiftKey && selectionAnchorSelector != null) {
      const order = latestGroups.map((candidate) => candidate.selector);
      const anchorIndex = order.indexOf(selectionAnchorSelector);
      const targetIndex = order.indexOf(group.selector);
      if (anchorIndex !== -1 && targetIndex !== -1) {
        if (!toggle) selectedGroupSelectors.clear();
        const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        for (const selector of order.slice(start, end + 1)) {
          selectedGroupSelectors.add(selector);
        }
        highlightedGroupSelector = group.selector;
        scheduleRender();
        return;
      }
    }
    if (toggle) {
      toggleSelectedGroup(group.selector);
      return;
    }
    selectionAnchorSelector = group.selector;
    if (selectedGroupSelectors.size === 1 && selectedGroupSelectors.has(group.selector)) {
      selectedGroupSelectors.delete(group.selector);
      highlightedGroupSelector = null;
    } else {
      selectedGroupSelectors.clear();
      selectedGroupSelectors.add(group.selector);
      highlightedGroupSelector = group.selector;
    }
    scheduleRender();
  }

  // Targets for the header's bulk show/hide: the selection when there is one,
  // otherwise every listed element.
  function getBulkActionGroups(): ClickmapClickGroup[] {
    if (selectedGroupSelectors.size > 0) {
      return latestGroups.filter((group) => selectedGroupSelectors.has(group.selector));
    }
    return latestGroups;
  }

  function setHoveredGroup(selector: string | null) {
    if (hoveredGroupSelector === selector) return;
    hoveredGroupSelector = selector;
    scheduleRender();
  }

  const checkIconSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const dashIconSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>';

  function createListRowElement(selector: string): ClickmapListRowElement {
    const count = h('span', { className: 'sdt-hm-row-count' });
    const label = h('span', { className: 'sdt-hm-row-label' });
    const dead = h('span', { className: 'sdt-hm-row-dead' });
    const selectorText = h('span', { className: 'sdt-hm-row-selector' });
    const check = h('button', { className: 'sdt-hm-row-check', type: 'button', role: 'checkbox', 'aria-checked': 'false' }) as HTMLButtonElement;
    const eye = h('button', { className: 'sdt-hm-row-eye', type: 'button' }) as HTMLButtonElement;
    const row = h('div', {
      className: 'sdt-hm-row',
      role: 'button',
      tabindex: '0',
    },
      check,
      count,
      h('span', { className: 'sdt-hm-row-meta' },
        h('span', { className: 'sdt-hm-row-label-row' }, label, dead),
        selectorText,
      ),
      eye,
    );
    const rowElement: ClickmapListRowElement = { row, count, check, eye, label, dead, selector: selectorText, group: null, renderedEyeIcon: '', renderedCheckIcon: '' };
    check.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (rowElement.group == null) return;
      // The checkbox always toggles membership (no modifier needed), like a
      // datagrid checkbox column; shift still extends an additive range.
      if (event.shiftKey && selectionAnchorSelector != null) {
        selectGroupFromEvent(rowElement.group, { shiftKey: true, ctrlKey: true, metaKey: false });
        return;
      }
      toggleSelectedGroup(rowElement.group.selector);
    });
    eye.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMutedGroup(selector);
    });
    row.addEventListener('click', (event) => {
      if (rowElement.group == null) return;
      selectGroupFromEvent(rowElement.group, event);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (rowElement.group == null) return;
      selectGroupFromEvent(rowElement.group, event);
    });
    return rowElement;
  }

  function updateListRowElement(rowElement: ClickmapListRowElement, group: ClickmapClickGroup) {
    const muted = mutedGroupSelectors.has(group.selector);
    const highlighted = highlightedGroupSelector === group.selector;
    const selected = selectedGroupSelectors.has(group.selector);
    rowElement.group = group;
    rowElement.row.classList.toggle('sdt-hm-row-muted', muted);
    rowElement.row.classList.toggle('sdt-hm-row-highlighted', highlighted);
    rowElement.row.classList.toggle('sdt-hm-row-selected', selected);
    rowElement.check.setAttribute('aria-checked', String(selected));
    rowElement.check.setAttribute('aria-label', selected ? `Deselect ${group.label}` : `Select ${group.label}`);
    // Same dead-spot hazard as syncExpandIcon: only rewrite the SVG when the
    // selected state actually flips.
    const checkIcon = selected ? checkIconSvg : '';
    if (rowElement.renderedCheckIcon !== checkIcon) {
      rowElement.renderedCheckIcon = checkIcon;
      setHtml(rowElement.check, checkIcon);
    }
    rowElement.count.textContent = formatClickmapCount(getGroupDisplayCount(group));
    rowElement.eye.setAttribute('aria-pressed', String(muted));
    rowElement.eye.setAttribute('aria-label', muted ? `Unmute ${group.label}` : `Mute ${group.label}`);
    rowElement.eye.title = muted ? 'Unmute element' : 'Mute element';
    // Same dead-spot hazard as syncExpandIcon: only rewrite the SVG when the
    // muted state actually flips, or clicks land on a detached icon.
    const eyeIcon = muted ? eyeOffIconSvg : eyeIconSvg;
    if (rowElement.renderedEyeIcon !== eyeIcon) {
      rowElement.renderedEyeIcon = eyeIcon;
      setHtml(rowElement.eye, eyeIcon);
    }
    rowElement.label.textContent = group.label;
    if (filters.showDead && group.deadCount > 0) {
      const deadPct = getDeadClickPercentage(group);
      rowElement.dead.textContent = `${deadPct}% dead`;
      rowElement.dead.title = `${formatClickmapCount(group.deadCount)} of ${formatClickmapCount(group.count)} clicks had no visible effect`;
      rowElement.dead.classList.add('sdt-hm-row-dead-visible');
    } else {
      rowElement.dead.textContent = '';
      rowElement.dead.title = '';
      rowElement.dead.classList.remove('sdt-hm-row-dead-visible');
    }
    rowElement.selector.textContent = group.selector;
  }

  function renderOverlay(groups: ClickmapClickGroup[]) {
    const nextMode = shouldShowElements() ? 'elements' : 'hidden';
    if (overlayMode !== nextMode) {
      overlayMode = nextMode;
      clearClickmapOverlayElements();
    }
    if (!shouldShowElements()) {
      return;
    }

    const visibleGroupKeys = new Set<string>();
    const maxCount = Math.max(1, ...groups.map(getGroupDisplayCount));
    for (const group of groups) {
      if (group.rect == null || group.rect.width <= 0 || group.rect.height <= 0) {
        continue;
      }
      visibleGroupKeys.add(group.selector);
      const displayCount = getGroupDisplayCount(group);
      const hue = getClickmapHue(displayCount, maxCount);
      const muted = mutedGroupSelectors.has(group.selector);
      // Every selected row reads as highlighted on the page, so a multi-row
      // selection lights up all of its outlines at once; the glide box still
      // follows only the lead (highlightedGroupSelector).
      const highlighted = highlightedGroupSelector === group.selector || selectedGroupSelectors.has(group.selector);
      let overlayElement = groupOverlayElements.get(group.selector);
      if (overlayElement == null) {
        const marker = h('button', { className: 'sdt-hm-marker', type: 'button', tabindex: '-1' });
        marker.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleMutedGroup(group.selector);
        });
        marker.addEventListener('pointerenter', () => setHoveredGroup(group.selector));
        marker.addEventListener('pointerleave', () => {
          if (hoveredGroupSelector === group.selector) setHoveredGroup(null);
        });
        overlayElement = {
          marker,
          outline: h('div', { className: 'sdt-hm-outline' }),
        };
        groupOverlayElements.set(group.selector, overlayElement);
        overlayRoot.append(overlayElement.outline, overlayElement.marker);
      }
      const { marker, outline } = overlayElement;
      const deadSuffix = filters.showDead && group.deadCount > 0 && group.count > 0
        ? ` (${getDeadClickPercentage(group)}% dead)`
        : '';
      marker.title = muted ? `Unmute ${group.selector}` : `Mute ${displayCount} clicks${deadSuffix} on ${group.selector}`;
      marker.setAttribute('aria-label', marker.title);
      marker.style.left = `${Math.round(group.rect.left + group.rect.width / 2)}px`;
      marker.style.top = `${Math.round(group.rect.top + group.rect.height / 2)}px`;
      marker.style.background = `hsla(${hue}, 96%, 58%, 0.94)`;
      marker.style.boxShadow = `0 0 0 1px hsla(${hue}, 96%, 22%, 0.35), 0 8px 24px hsla(${hue}, 96%, 45%, 0.32)`;
      marker.textContent = formatClickmapCount(displayCount);
      marker.classList.toggle('sdt-hm-marker-muted', muted);
      marker.classList.toggle('sdt-hm-marker-highlighted', highlighted);

      outline.style.left = `${group.rect.left}px`;
      outline.style.top = `${group.rect.top}px`;
      outline.style.width = `${group.rect.width}px`;
      outline.style.height = `${group.rect.height}px`;
      outline.style.borderColor = `hsla(${hue}, 96%, 58%, 0.5)`;
      // Hover fills the box with a faint wash of its own border color; the
      // empty string falls back to the stylesheet's neutral background.
      outline.style.background = hoveredGroupSelector === group.selector ? `hsla(${hue}, 96%, 58%, 0.16)` : '';
      outline.classList.toggle('sdt-hm-outline-muted', muted);
      outline.classList.toggle('sdt-hm-outline-highlighted', highlighted);
    }
    for (const [key, overlayElement] of groupOverlayElements) {
      if (!visibleGroupKeys.has(key)) {
        overlayElement.marker.remove();
        overlayElement.outline.remove();
        groupOverlayElements.delete(key);
      }
    }
    renderHighlightBox(groups);
  }

  function renderHighlightBox(groups: ClickmapClickGroup[]) {
    const group = highlightedGroupSelector == null
      ? null
      : groups.find((candidate) => candidate.selector === highlightedGroupSelector) ?? null;
    const rect = group?.rect ?? null;
    if (group == null || rect == null || rect.width <= 0 || rect.height <= 0) {
      if (highlightSettleTimer != null) {
        window.clearTimeout(highlightSettleTimer);
        highlightSettleTimer = null;
      }
      overlayHighlight.classList.remove('sdt-hm-highlight-visible', 'sdt-hm-highlight-animating');
      highlightRenderedSelector = null;
      return;
    }
    const wasVisible = overlayHighlight.classList.contains('sdt-hm-highlight-visible');
    if (wasVisible && highlightRenderedSelector !== group.selector) {
      // Geometry transitions stay on briefly after retargeting so the box can
      // glide between visible elements, then come off so manual scrolling
      // tracks the element exactly instead of lagging behind.
      overlayHighlight.classList.add('sdt-hm-highlight-animating');
      if (highlightSettleTimer != null) window.clearTimeout(highlightSettleTimer);
      highlightSettleTimer = window.setTimeout(() => {
        overlayHighlight.classList.remove('sdt-hm-highlight-animating');
        highlightSettleTimer = null;
      }, 700);
    }
    highlightRenderedSelector = group.selector;
    overlayHighlight.style.left = `${rect.left}px`;
    overlayHighlight.style.top = `${rect.top}px`;
    overlayHighlight.style.width = `${rect.width}px`;
    overlayHighlight.style.height = `${rect.height}px`;
    overlayHighlight.classList.add('sdt-hm-highlight-visible');
  }

  function renderList(groups: ClickmapClickGroup[]) {
    if (groups.length === 0) {
      clearClickmapListElements();
      list.appendChild(empty);
      return;
    }
    const previousScrollTop = body.scrollTop;
    empty.remove();
    const renderedKeys = new Set<string>();
    let nextRowNode: ChildNode | null = list.firstChild;
    for (const group of groups.slice(0, 30)) {
      renderedKeys.add(group.selector);
      let rowElement = listRowElements.get(group.selector);
      if (rowElement == null) {
        rowElement = createListRowElement(group.selector);
        listRowElements.set(group.selector, rowElement);
      }
      updateListRowElement(rowElement, group);
      if (rowElement.row !== nextRowNode) {
        list.insertBefore(rowElement.row, nextRowNode);
      }
      nextRowNode = rowElement.row.nextSibling;
    }
    for (const [selector, rowElement] of listRowElements) {
      if (renderedKeys.has(selector)) continue;
      rowElement.row.remove();
      listRowElements.delete(selector);
    }
    body.scrollTop = previousScrollTop;
  }

  // Same dead-spot hazard as syncExpandIcon: only rewrite the master
  // checkbox's SVG when its tri-state actually changes.
  let renderedHeaderCheckIcon = '';
  function syncListHeader(groups: ClickmapClickGroup[]) {
    // The header stays visible while a search is filtering everything out —
    // the search box lives here, so hiding it would leave no way to clear
    // the query. It only disappears in the true empty state (no data).
    const visible = groups.length > 0 || filters.elementSearch.trim() !== '';
    listHeader.classList.toggle('sdt-hm-list-header-visible', visible);
    if (!visible) return;
    const selectedCount = selectedGroupSelectors.size;
    const allSelected = selectedCount > 0 && groups.every((group) => selectedGroupSelectors.has(group.selector));
    listHeaderCheck.setAttribute('aria-checked', allSelected ? 'true' : selectedCount > 0 ? 'mixed' : 'false');
    listHeaderCheck.setAttribute('aria-label', allSelected ? 'Clear selection' : 'Select all elements');
    const headerCheckIcon = allSelected ? checkIconSvg : selectedCount > 0 ? dashIconSvg : '';
    if (renderedHeaderCheckIcon !== headerCheckIcon) {
      renderedHeaderCheckIcon = headerCheckIcon;
      setHtml(listHeaderCheck, headerCheckIcon);
    }
    listHeaderSummary.textContent = selectedCount > 0
      ? `${formatClickmapCount(selectedCount)} of ${formatClickmapCount(groups.length)} selected`
      : `${formatClickmapCount(groups.length)} element${groups.length === 1 ? '' : 's'}`;
    const bulkTargets = getBulkActionGroups();
    const bulkScope = selectedCount > 0 ? 'selected' : 'all';
    listShowButton.textContent = `Show ${bulkScope}`;
    listHideButton.textContent = `Hide ${bulkScope}`;
    // Disabled whenever the action would be a no-op on its targets.
    listShowButton.disabled = bulkTargets.every((group) => !mutedGroupSelectors.has(group.selector));
    listHideButton.disabled = bulkTargets.every((group) => mutedGroupSelectors.has(group.selector));
  }

  function render() {
    if (currentPath !== window.location.pathname) {
      currentPath = window.location.pathname;
      serverClickmap = { path: currentPath, totalClicks: 0, selectors: [], elements: [] };
      serverClickmapError = null;
      clearClickmapListElements();
      syncAutoUrlPattern();
      runAsynchronously(loadServerClickmap());
    }
    const groups = getGroups();
    latestGroups = groups;
    const groupKeys = new Set(groups.map((group) => group.selector));
    for (const mutedGroupSelector of mutedGroupSelectors) {
      if (!groupKeys.has(mutedGroupSelector)) mutedGroupSelectors.delete(mutedGroupSelector);
    }
    for (const selectedGroupSelector of selectedGroupSelectors) {
      if (!groupKeys.has(selectedGroupSelector)) selectedGroupSelectors.delete(selectedGroupSelector);
    }
    if (selectionAnchorSelector != null && !groupKeys.has(selectionAnchorSelector)) {
      selectionAnchorSelector = null;
    }
    if (highlightedGroupSelector != null && !groupKeys.has(highlightedGroupSelector)) {
      highlightedGroupSelector = null;
    }
    if (hoveredGroupSelector != null && !groupKeys.has(hoveredGroupSelector)) {
      hoveredGroupSelector = null;
    }
    // Clicks mapped to an element that actually exists in the current DOM (what
    // the overlay can draw) vs. the true aggregate the filter matched server-side.
    // Follows the dead-clicks toggle so the message matches the drawn numbers.
    const mappedClicks = groups.reduce((sum, group) => sum + getGroupDisplayCount(group), 0);
    const aggregateClicks = serverClickmap.path === currentPath ? serverClickmap.totalClicks : 0;
    const viewport = getClickmapViewportSize();
    const roundedViewportWidth = Math.round(viewport.width);
    const roundedViewportHeight = Math.round(viewport.height);
    const selectedViewportBucket = getClickmapViewportBucket(filters.device);
    const viewportFilterMatches = selectedViewportBucket == null || isClickmapViewportWidthInBucket(roundedViewportWidth, selectedViewportBucket);
    statsCount.textContent = formatClickmapCount(aggregateClicks);
    selectorCount.textContent = formatClickmapCount(groups.length);
    viewportValue.textContent = `${roundedViewportWidth}x${roundedViewportHeight}`;
    overlayToggle.textContent = overlayVisible ? 'Hide overlay' : 'Show overlay';
    syncOverlayMiniToggle();
    viewportWarning.classList.toggle('sdt-hm-viewport-warning-visible', !viewportFilterMatches);
    if (selectedViewportBucket != null && !viewportFilterMatches) {
      const recommendedWidth = getClickmapRecommendedViewportWidth(selectedViewportBucket);
      const recommendedHeight = Math.max(1, roundedViewportHeight);
      viewportWarningTitle.textContent = 'Viewport filter mismatch';
      viewportWarningBody.textContent = `This page is ${roundedViewportWidth}px wide, but ${filters.device} is ${formatClickmapViewportBucket(selectedViewportBucket)}. Resize the window or use the DevTools device toolbar before comparing this clickmap.`;
      viewportWarningWidthValue.textContent = String(recommendedWidth);
      viewportWarningHeightValue.textContent = String(recommendedHeight);
    }
    const effectiveUrlPattern = getEffectiveUrlPattern();
    const urlPatternMatchesPath = patternMatchesPath(effectiveUrlPattern, currentPath);
    // Re-evaluated here too so route changes (which move the auto pattern under
    // a custom one) keep the revert affordance in sync.
    syncUrlPatternResetVisibility();
    const token = getClickmapTokenFromStorage();
    const tokenOrigin = getClickmapOriginFromStorage();
    if (token == null) {
      status.textContent = serverClickmapError ?? 'No clickmap token in sessionStorage. Paste one from the dashboard to load this page.';
    } else if (tokenOrigin != null && tokenOrigin !== window.location.origin) {
      status.textContent = `Token was minted for ${tokenOrigin}, but this page is ${window.location.origin}. Generate a token for this exact origin.`;
    } else if (loadingServerClickmap) {
      status.textContent = 'Loading aggregate clickmap...';
    } else if (serverClickmapError != null) {
      status.textContent = serverClickmapError;
    } else {
      const scope = effectiveUrlPattern !== '' && effectiveUrlPattern !== currentPath ? effectiveUrlPattern : currentPath;
      let message = `Loaded ${formatClickmapCount(aggregateClicks)} aggregate clicks for ${scope}.`;
      if (aggregateClicks === 0) {
        message = `No clicks recorded for ${scope} in this range.`;
      } else if (!urlPatternMatchesPath) {
        // The overlay is bound to the page you're viewing; off-pattern pages
        // can't render it. This is the "* / shows 0 dots" case made explicit.
        message += ' This page isn’t covered by the pattern — reset it or open a matching page to see the overlay.';
      } else if (groups.length === 0) {
        message += ' No matching elements found on this page yet.';
      } else if (mappedClicks < aggregateClicks) {
        message += ` ${formatClickmapCount(mappedClicks)} mapped to elements on this page.`;
      }
      status.textContent = message;
    }
    status.classList.toggle('sdt-hm-token-status-error', serverClickmapError != null || (token != null && tokenOrigin != null && tokenOrigin !== window.location.origin));
    miniClicks.textContent = formatClickmapCount(aggregateClicks);
    miniElements.textContent = formatClickmapCount(groups.length);
    container.classList.toggle('sdt-hm-expanded', expanded);
    expandButton.setAttribute('aria-expanded', String(expanded));
    expandButton.setAttribute('aria-label', expanded ? 'Collapse clickmap options' : 'Expand clickmap options');
    expandButton.setAttribute('data-sdt-tip', expanded ? 'Collapse clickmap options' : 'Expand clickmap options');
    syncExpandIcon();
    // Keep the viewport switcher's sliding thumb aligned once the panel is laid
    // out (expand, resize-driven re-render); it no-ops while collapsed.
    positionDeviceThumb();
    renderOverlay(groups);
    syncListHeader(groups);
    renderList(groups);
  }

  async function loadServerClickmap() {
    const requestId = serverClickmapRequestId + 1;
    serverClickmapRequestId = requestId;
    const isLatestRequest = () => requestId === serverClickmapRequestId;
    const token = getClickmapTokenFromStorage();
    if (token == null) {
      serverClickmap = { path: currentPath, totalClicks: 0, selectors: [], elements: [] };
      serverClickmapError = null;
      loadingServerClickmap = false;
      render();
      return;
    }
    const tokenOrigin = getClickmapOriginFromStorage();
    if (tokenOrigin != null && tokenOrigin !== window.location.origin) {
      serverClickmap = { path: currentPath, totalClicks: 0, selectors: [], elements: [] };
      serverClickmapError = null;
      loadingServerClickmap = false;
      render();
      return;
    }

    loadingServerClickmap = true;
    serverClickmapError = null;
    render();
    try {
      const until = new Date();
      const since = new Date(until.getTime() - CLICKMAP_RANGE_MS[filters.range]);
      const requestedPath = window.location.pathname;
      const effectiveUrlPattern = getEffectiveUrlPattern();
      const body: Record<string, unknown> = {
        clickmap_token: token,
        origin: window.location.origin,
        since: since.toISOString(),
        until: until.toISOString(),
      };
      if (effectiveUrlPattern !== '') {
        body.url_pattern = effectiveUrlPattern;
      } else {
        body.route_path = requestedPath;
      }
      if (filters.device !== 'all') {
        body.device = filters.device;
      }
      const response = await app[hexclaveAppInternalsSymbol].sendRequest("/analytics/clickmap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, "client");
      if (!response.ok) {
        throw new Error(`Clickmap request failed with HTTP ${response.status}`);
      }
      const responseBody: unknown = await response.json();
      if (!isLatestRequest()) {
        return;
      }
      serverClickmap = parseServerClickmapResponse(responseBody, requestedPath);
    } catch (error) {
      if (!isLatestRequest()) {
        return;
      }
      serverClickmap = { path: currentPath, totalClicks: 0, selectors: [], elements: [] };
      if (error instanceof Error && error.message.includes('Clickmap token does not belong to this project')) {
        clearClickmapTokenStorage();
        serverClickmapError = 'The stored clickmap token belongs to another project. Generate a fresh token for this project.';
      } else {
        serverClickmapError = error instanceof Error ? error.message : 'Failed to load clickmap data';
      }
    } finally {
      if (isLatestRequest()) {
        loadingServerClickmap = false;
        render();
      }
    }
  }

  // The clickmap overlay leaves the page fully interactive. When the user
  // navigates away with a token loaded, drop a sentinel so the dev tool on the
  // next page can auto-reopen straight back into the clickmap tab.
  const onBeforeUnloadResume = () => {
    const token = getClickmapTokenFromStorage();
    const tokenOrigin = getClickmapOriginFromStorage();
    if (token == null || (tokenOrigin != null && tokenOrigin !== window.location.origin)) {
      return;
    }
    try {
      sessionStorage.setItem(CLICKMAP_OVERLAY_RESUME_STORAGE_KEY, '1');
    } catch {
      // ignore (private mode, etc.)
    }
  };

  // render() fires constantly while the overlay is open (route poll, scroll,
  // host-page mutations), so the toolbar can be rewritten or reflowed between
  // pointerdown and pointerup. If that churn replaces the node the press
  // started on, or shifts the button out from under the cursor, the browser
  // never synthesizes the click and the press is silently dropped. Capturing
  // the pointer pins the rest of the press — pointerup and the resulting
  // click included — to the button itself, so mid-press churn can't eat it.
  const pinPressToButton = (button: HTMLButtonElement) => {
    button.addEventListener('pointerdown', (event) => {
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // The pointer may already be gone (e.g. pen lifted); a plain click
        // still works in that case.
      }
    });
  };
  pinPressToButton(overlayToggle);
  pinPressToButton(closeButton);
  pinPressToButton(expandButton);
  pinPressToButton(showDeadMiniToggle);
  pinPressToButton(showDeadToggle);
  pinPressToButton(overlayMiniToggle);
  pinPressToButton(listHeaderCheck);
  pinPressToButton(listShowButton);
  pinPressToButton(listHideButton);
  overlayToggle.addEventListener('click', () => {
    overlayVisible = !overlayVisible;
    render();
  });
  closeButton.addEventListener('click', onClose);
  expandButton.addEventListener('click', () => {
    expanded = !expanded;
    render();
  });
  const onTokenUpdated = () => {
    runAsynchronously(loadServerClickmap());
  };
  const routePollInterval = window.setInterval(scheduleRender, 500);
  // Mutations the overlay/dev-tool cause themselves must not drive a re-render:
  // `renderOverlay` rewrites marker/outline inline styles into `overlayRoot` on
  // every paint, so observing them would re-arm scheduleRender → paint → mutate
  // → … a permanent render loop while the tab is open. Ignore records whose
  // targets all sit inside our own overlay/panel roots or the dev tool's root.
  const isSelfMutationTarget = (target: Node | null): boolean => {
    const element = target instanceof Element ? target : target?.parentElement ?? null;
    if (element == null) return false;
    return overlayRoot.contains(element) || element.closest(`#${cssEscapeIdent(CLICKMAP_ROOT_ID)}, #${cssEscapeIdent(DEV_TOOL_ROOT_ID)}`) != null;
  };
  const mutationObserver = new MutationObserver((mutations) => {
    if (mutations.every((mutation) => isSelfMutationTarget(mutation.target))) {
      return;
    }
    scheduleDomIndexInvalidation();
    scheduleRender();
  });
  const visualViewport = window.visualViewport;
  mutationObserver.observe(document.body, { attributes: true, childList: true, subtree: true });

  // Mounted inside the clickmap root (not document.body) so everything that
  // ignores Hexclave UI by root id — most importantly the SDK's dead-click
  // MutationObserver — also ignores the overlay's constant marker/outline
  // rewrites instead of reading them as the page reacting to a click. The
  // overlay root is position:fixed, so the unstyled parent changes nothing
  // visually.
  (document.getElementById(CLICKMAP_ROOT_ID) ?? document.body).appendChild(overlayRoot);
  rebuildDomIndex();
  scheduleRender();
  window.addEventListener('beforeunload', onBeforeUnloadResume);
  const onWindowResize = () => {
    scheduleRender();
  };
  document.addEventListener('scroll', scheduleRender, true);
  window.addEventListener('resize', onWindowResize);
  visualViewport?.addEventListener('resize', scheduleRender);
  visualViewport?.addEventListener('scroll', scheduleRender);
  window.addEventListener(CLICKMAP_OVERLAY_TOKEN_UPDATED_EVENT, onTokenUpdated);
  // Dismiss the URL-pattern help popover on an outside click or Escape.
  const onDocumentPointerDown = (event: MouseEvent) => {
    if (!urlHelpOpen) return;
    if (event.target instanceof Node && urlPatternHelp.contains(event.target)) return;
    if (event.target instanceof Node && urlPatternInfo.contains(event.target)) return;
    setUrlHelpOpen(false);
  };
  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (urlHelpOpen) {
      setUrlHelpOpen(false);
      return;
    }
    clearSelection();
  };
  document.addEventListener('mousedown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeyDown, true);
  render();
  runAsynchronously(loadServerClickmap());

  container.append(details, toolbar);
  return {
    element: container,
    cleanup: () => {
      cancelAnimationFrame(renderFrame);
      if (domIndexDebounce !== 0) window.clearTimeout(domIndexDebounce);
      if (filterReloadDebounce !== 0) window.clearTimeout(filterReloadDebounce);
      if (elementSearchDebounce !== 0) window.clearTimeout(elementSearchDebounce);
      window.clearInterval(routePollInterval);
      mutationObserver.disconnect();
      clearClickmapOverlayElements();
      domIndex.clear();
      window.removeEventListener('beforeunload', onBeforeUnloadResume);
      document.removeEventListener('scroll', scheduleRender, true);
      window.removeEventListener('resize', onWindowResize);
      visualViewport?.removeEventListener('resize', scheduleRender);
      visualViewport?.removeEventListener('scroll', scheduleRender);
      window.removeEventListener(CLICKMAP_OVERLAY_TOKEN_UPDATED_EVENT, onTokenUpdated);
      document.removeEventListener('mousedown', onDocumentPointerDown, true);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
      overlayRoot.remove();
    },
  };
}

// ===========================================================================================
// Mount
// ===========================================================================================

const GLOBAL_INSTANCE_KEY = '__hexclave-clickmap-instance';

/**
 * Opens the clickmap overlay: mounts its own root element, injects its own
 * styles, and shows the bottom-centered panel.
 *
 * Returns a cleanup that tears everything down. `onClosed` fires exactly once,
 * when the overlay is closed (by the user or via the returned cleanup), so the
 * caller can let a later token event reopen it.
 */
export function openClickmapOverlay(app: StackClientApp<true>, onClosed: () => void): () => void {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return () => {};
  }
  const body = document['body'];
  if (!hasAppendChild(body)) return () => {};

  getGlobalUiInstance(GLOBAL_INSTANCE_KEY)?.cleanup();
  let existingRoot = document.getElementById(CLICKMAP_ROOT_ID);
  while (existingRoot !== null) {
    existingRoot.remove();
    existingRoot = document.getElementById(CLICKMAP_ROOT_ID);
  }

  const root = document.createElement('div');
  root.id = CLICKMAP_ROOT_ID;
  body.appendChild(root);

  const wrapper = h('div', { className: 'hexclave-clickmap' });
  root.appendChild(wrapper);

  const style = document.createElement('style');
  style.textContent = clickmapCSS;
  wrapper.appendChild(style);

  const panel = createClickmapPanel(app, () => instance.cleanup());
  wrapper.appendChild(
    h('div', { className: 'sdt-hm-panel' },
      h('div', { className: 'sdt-hm-panel-inner' }, panel.element),
    ),
  );

  let didCleanup = false;
  const instance: UiGlobalInstance = {
    cleanup: () => {
      if (didCleanup) return;
      didCleanup = true;
      if (getGlobalUiInstance(GLOBAL_INSTANCE_KEY) === instance) {
        setGlobalUiInstance(GLOBAL_INSTANCE_KEY, null);
      }
      panel.cleanup?.();
      if (root.parentNode) {
        root.parentNode.removeChild(root);
      }
      onClosed();
    },
  };
  setGlobalUiInstance(GLOBAL_INSTANCE_KEY, instance);

  return () => {
    instance.cleanup();
  };
}

// END_PLATFORM

import {
  PAIRING_REQUEST_TIMEOUT_MS,
  TV_FRESHNESS_INTERVAL_MS,
  TV_SNAPSHOT_POLL_INTERVAL_MS,
  TV_SNAPSHOT_REQUEST_TIMEOUT_MS,
  assertPairingChallenge,
  assertPairingStatus,
  assertTvSnapshot,
  classifyDisplayRefreshResponse,
  createApiUrl,
  createRequestHeaders,
  formatCompact,
  formatDuration,
  formatExactUsd,
  formatSignedPercent,
  getConnectionStatus,
  getCelebrationEffectState,
  getFixturePreviewTime,
  getDisplaySessionRetryDelay,
  getNextScreenIndex,
  getNiceChartScale,
  getScreenDurationSeconds,
  replaceStage,
  resolveTvBoxRuntimeConfiguration,
  selectPresentationView,
  shouldPollDisplaySnapshot,
} from "/tv-box/runtime.mjs";
import { createCelebrationLayer } from "/tv-box/effects.mjs";
import { createIcon } from "/tv-box/icons.mjs";

const root = document.querySelector("#tv-box-root");
const stageRoot = document.querySelector("#tv-box-stage");
const footerRoot = document.querySelector("#tv-box-footer");
const controlsRoot = document.querySelector("#tv-box-controls");
const celebrationBackground = document.querySelector("#tv-box-celebration-background");
const celebrationForeground = document.querySelector("#tv-box-celebration-foreground");
const configElement = document.querySelector("#tv-box-config");
if (!(root instanceof HTMLElement)
  || !(stageRoot instanceof HTMLElement)
  || !(footerRoot instanceof HTMLElement)
  || !(controlsRoot instanceof HTMLElement)
  || !(celebrationBackground instanceof HTMLElement)
  || !(celebrationForeground instanceof HTMLElement)
  || !(configElement instanceof HTMLScriptElement)) {
  throw new Error("TV Box document is missing a required presentation element.");
}

const runtimeConfiguration = resolveTvBoxRuntimeConfiguration(
  JSON.parse(configElement.textContent ?? "{}"),
  window.location.origin,
);
const fixtureMonotonicStartedAt = runtimeConfiguration.mode === "fixture-preview"
  ? performance.now()
  : null;
const state = {
  accessToken: null,
  challenge: null,
  pairingError: false,
  snapshot: null,
  unavailableReason: null,
  screenIndex: 0,
  profileKey: null,
  rotationTimer: undefined,
  presentationTimer: undefined,
  snapshotTimer: undefined,
  freshnessTimer: undefined,
  pairingTimer: undefined,
  pairingRetryAttempt: 0,
  pairingPollFailureAttempt: 0,
  sessionTimer: undefined,
  authenticationState: "restoring",
  sessionRecoveryInFlight: false,
  sessionRetryAttempt: 0,
  activeRequest: null,
  lastLoggedFailure: null,
  rotationPaused: false,
  controlsVisible: false,
  controlsTimer: undefined,
  fullscreenAvailable: false,
  isFullscreen: false,
  renderedViewKey: null,
  renderedHighlightKey: null,
  stopped: false,
};
const backgroundEffects = createCelebrationLayer(celebrationBackground);
const foregroundEffects = createCelebrationLayer(celebrationForeground);

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className != null) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function createSvgElement(tagName, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function reportFailure(key, cause) {
  const signature = `${key}:${cause instanceof Error ? cause.message : String(cause)}`;
  if (state.lastLoggedFailure === signature) return;
  state.lastLoggedFailure = signature;
  console.error(`[Hexclave TV Box] ${key}`, cause);
}

function clearFailure() {
  state.lastLoggedFailure = null;
}

function apiUrl(path) {
  if (runtimeConfiguration.mode !== "live") {
    throw new Error("TV Box fixture previews cannot make API requests.");
  }
  return createApiUrl(runtimeConfiguration.apiBaseUrl, path);
}

function currentTimeMilliseconds() {
  if (runtimeConfiguration.mode !== "fixture-preview") return Date.now();
  if (fixtureMonotonicStartedAt == null) {
    throw new Error("TV Box fixture preview clock was not initialized.");
  }
  return getFixturePreviewTime(
    runtimeConfiguration.snapshot.generatedAt,
    fixtureMonotonicStartedAt,
    performance.now(),
  );
}

async function request(path, options = {}) {
  return await fetch(apiUrl(path), {
    ...options,
    credentials: "include",
    headers: createRequestHeaders(options),
    cache: "no-store",
  });
}

async function requestWithTimeout(path, options, timeoutMilliseconds) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    return await request(path, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function replaceRoot(content) {
  replaceStage(stageRoot, content);
}

function clearFooter() {
  footerRoot.replaceChildren();
  delete footerRoot.dataset.footerKey;
  footerRoot.hidden = true;
}

function iconMark(iconName, tone = "cyan") {
  const container = createElement("span", `tv-icon tv-icon-${tone}`);
  container.append(createIcon(iconName));
  return container;
}

function renderMessage(type, title, message) {
  clearFooter();
  const stage = createElement("section", "tv-message-stage");
  const content = createElement("div", "tv-message");
  content.append(
    iconMark(type === "error" ? "warning" : type === "empty" ? "check" : "broadcast", type === "error" ? "rose" : "cyan"),
    createElement("h1", "tv-message-title", title),
    createElement("p", "tv-message-copy", message),
  );
  stage.append(content);
  replaceRoot(stage);
}

function renderPairing() {
  clearFooter();
  const stage = createElement("section", "tv-pairing-stage");
  const card = createElement("div", "tv-pairing-card");
  card.append(
    iconMark(state.pairingError ? "warning" : "display", state.pairingError ? "rose" : "cyan"),
    createElement("p", "tv-kicker", "Hexclave TV Mode"),
    createElement("h1", "tv-pairing-title", "Launch TV Mode"),
    createElement("p", "tv-pairing-copy", "Open TV Mode in the Hexclave dashboard, choose Pair Display, and enter this secure code to connect the screen."),
  );
  const codePanel = createElement("div", "tv-pairing-code-panel");
  if (state.challenge == null) {
    const pending = createElement("div", "tv-pairing-pending");
    pending.append(
      createElement("span", "tv-live-dot"),
      document.createTextNode(state.pairingError
        ? "We couldn’t create a pairing code. Retrying automatically…"
        : "Preparing a secure pairing code…"),
    );
    codePanel.append(pending);
  } else {
    const code = state.challenge.pairingCode;
    codePanel.append(createElement("p", "tv-pairing-code", `${code.slice(0, 4)}-${code.slice(4)}`));
    if (state.pairingError) {
      codePanel.append(createElement("p", "tv-pairing-warning", "Connection interrupted. Retrying automatically…"));
    }
  }
  card.append(
    codePanel,
    createElement("p", "tv-pairing-footnote", "Codes expire after 10 minutes. Project data stays unavailable until an administrator approves this display."),
  );
  stage.append(card);
  replaceRoot(stage);
}

function metric(label, value, detail, hero = false) {
  const container = createElement("div", `tv-metric${hero ? " tv-metric-hero" : ""}`);
  container.append(
    createElement("p", "tv-metric-label", label),
    createElement("p", "tv-metric-value", value),
  );
  if (detail != null) container.append(createElement("p", "tv-metric-detail", detail));
  return container;
}

function glassPanel(tone, children, extraClass = "") {
  const panel = createElement("div", `tv-panel tv-panel-${tone} ${extraClass}`.trim());
  const sheen = createElement("div", "tv-panel-sheen");
  const content = createElement("div", "tv-panel-content");
  content.append(...children);
  panel.append(sheen, content);
  return panel;
}

function insight(screen, tone) {
  const fallback = {
    "live-pulse": screen.sourceStatus === "insufficient-data"
      ? "A validated recent baseline is required before live activity can be compared."
      : "Comparable live-activity analysis will appear when a validated recent baseline is available.",
    "audience-momentum": screen.sourceStatus === "insufficient-data"
      ? "More qualifying audience activity is required before a reliable lifecycle insight can be identified."
      : "No evidence-qualified audience lifecycle insight was identified for this seven-day window.",
    "revenue-payments": screen.sourceStatus === "insufficient-data"
      ? "At least 10 completed payment outcomes are required before Payment Success can be assessed."
      : "No evidence-qualified revenue or payment insight was identified for this 30-day window.",
    "email-health": screen.sourceStatus === "insufficient-data"
      ? "At least 20 confirmed delivery outcomes are required before delivery health can be assessed."
      : "No evidence-qualified email delivery insight was identified for this seven-day window.",
  }[screen.id];
  const message = screen.sourceStatus === "stale"
    ? "Insight analysis will resume when a fresh snapshot is available."
    : screen.insight?.message ?? fallback;
  const container = createElement("div", `tv-insight tv-insight-${tone}`);
  container.append(
    createIcon(screen.insight == null ? "info" : "check", "tv-insight-icon"),
    createElement("p", "tv-insight-copy", message),
  );
  return container;
}

function chartHeader(title, subtitle, live = false) {
  const header = createElement("div", "tv-chart-header");
  const copy = createElement("div");
  copy.append(
    createElement("p", "tv-chart-title", title),
    createElement("p", "tv-chart-subtitle", subtitle),
  );
  header.append(copy);
  if (live) {
    const badge = createElement("span", "tv-live-badge");
    badge.append(createElement("span", "tv-live-dot-static"), document.createTextNode("Live"));
    header.append(badge);
  }
  return header;
}

function lineChart(points, color, label) {
  const chart = createElement("div", "tv-line-chart");
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", label);
  const maximumValue = Math.max(...points.map((point) => point.value), 1);
  const scale = getNiceChartScale(maximumValue);
  const coordinates = points.map((point, index) => (
    `${points.length === 1 ? 50 : (index / (points.length - 1)) * 100},${88 - (point.value / scale.maximum) * 76}`
  )).join(" ");
  const plot = createElement("div", "tv-line-plot");
  const yAxis = createElement("div", "tv-line-y-axis");
  for (const value of scale.ticks) {
    yAxis.append(createElement("span", null, formatCompact(Math.round(value))));
    const grid = createElement("span", "tv-line-grid");
    grid.style.top = `${12 + (1 - value / scale.maximum) * 76}%`;
    plot.append(grid);
  }
  const svg = createSvgElement("svg", {
    viewBox: "0 0 100 100",
    preserveAspectRatio: "none",
    class: "tv-line-svg",
  });
  const gradientId = `tv-box-gradient-${Math.random().toString(36).slice(2)}`;
  const definitions = createSvgElement("defs");
  const gradient = createSvgElement("linearGradient", { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(
    createSvgElement("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.32 }),
    createSvgElement("stop", { offset: "65%", "stop-color": color, "stop-opacity": 0.08 }),
    createSvgElement("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 }),
  );
  definitions.append(gradient);
  svg.append(
    definitions,
    createSvgElement("polygon", { points: `0,100 ${coordinates} 100,100`, fill: `url(#${gradientId})` }),
    createSvgElement("polyline", {
      points: coordinates,
      fill: "none",
      stroke: color,
      "stroke-width": 2.4,
      "vector-effect": "non-scaling-stroke",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  const xAxis = createElement("div", "tv-line-x-axis");
  for (const point of points) xAxis.append(createElement("span", null, point.label));
  plot.append(svg, xAxis);
  chart.append(yAxis, plot);
  return chart;
}

function stackedBars(points, colors, labels) {
  const container = createElement("div", "tv-stacked-chart");
  const legend = createElement("div", "tv-chart-legend");
  labels.forEach((label, index) => {
    const item = createElement("span", "tv-chart-legend-item");
    const dot = createElement("span", "tv-chart-legend-dot");
    dot.style.backgroundColor = colors[index];
    item.append(dot, document.createTextNode(label));
    legend.append(item);
  });
  const plot = createElement("div", "tv-stacked-plot");
  const maximumValue = Math.max(...points.map((point) => point.primary + point.secondary + point.tertiary), 1);
  const scale = getNiceChartScale(maximumValue);
  for (const value of scale.ticks) {
    const line = createElement("span", "tv-stacked-grid");
    line.style.bottom = `${(value / scale.maximum) * 88}%`;
    line.append(createElement("span", "tv-stacked-tick", formatCompact(Math.round(value))));
    plot.append(line);
  }
  for (const point of points) {
    const total = point.primary + point.secondary + point.tertiary;
    const column = createElement("div", "tv-stacked-column");
    const bar = createElement("div", "tv-stacked-bar");
    bar.style.height = `${(total / scale.maximum) * 88}%`;
    [point.primary, point.secondary, point.tertiary].forEach((value, index) => {
      const segment = createElement("span", "tv-stacked-segment");
      segment.style.height = `${total === 0 ? 0 : (value / total) * 100}%`;
      segment.style.backgroundColor = colors[index];
      bar.append(segment);
    });
    column.append(bar, createElement("span", "tv-stacked-label", point.label));
    plot.append(column);
  }
  container.append(legend, plot);
  return container;
}

function sourceState(screen) {
  const content = {
    empty: ["Waiting for Activity", "No qualifying activity yet.", "This screen will update automatically when activity arrives."],
    unavailable: ["Source Unavailable", "This data source isn’t connected yet.", "Connect the required app to show this screen."],
    error: ["Data Temporarily Unavailable", "We couldn’t refresh this data right now.", "TV Mode will retry automatically while the rest of the presentation continues."],
  }[screen.sourceStatus];
  if (content == null) return null;
  const panel = createElement("div", "tv-source-state");
  panel.append(
    createIcon("shield-warning", "tv-source-state-icon"),
    createElement("p", "tv-source-message", content[1]),
    createElement("p", "tv-source-detail", `${screen.sourceLabel} · ${content[2]}`),
  );
  return { eyebrow: content[0], content: panel };
}

function screenFrame({ eyebrow, title, description, tone, icon, content, highlight }) {
  const stage = createElement("section", "tv-screen-stage");
  const header = createElement("header", "tv-screen-header");
  const heading = createElement("div", "tv-screen-heading");
  const eyebrowElement = createElement("p", `tv-screen-eyebrow tv-tone-${tone}`);
  eyebrowElement.append(createIcon(icon, "tv-screen-eyebrow-icon"), document.createTextNode(eyebrow));
  heading.append(eyebrowElement, createElement("h1", "tv-screen-title", title), createElement("p", "tv-screen-description", description));
  header.append(heading);
  if (highlight != null) header.append(renderHighlight(highlight));
  const body = createElement("div", "tv-screen-body");
  body.append(content);
  stage.append(header, body);
  return stage;
}

function renderHighlight(highlight) {
  const isCelebration = highlight.variant === "celebration";
  const isResolved = highlight.variant === "resolved-incident";
  const isCritical = highlight.event.presentationClass === "critical-incident";
  const tone = highlight.variant === "celebration"
    ? "amber"
    : highlight.variant === "resolved-incident" ? "emerald" : "rose";
  const usesWideLayout = highlight.event.title.length > 52 || highlight.event.summary.length > 88;
  const highlightKey = [highlight.event.id, highlight.variant, highlight.expiresAt, highlight.animationExpiresAt].join("\0");
  const entering = state.renderedHighlightKey !== highlightKey;
  state.renderedHighlightKey = highlightKey;
  const container = createElement("aside", `tv-highlight tv-highlight-${tone}${usesWideLayout ? " tv-highlight-wide" : ""}${entering ? " tv-highlight-entering" : ""}`);
  container.append(
    iconMark(isResolved ? "check" : isCelebration ? "confetti" : "warning", tone),
    createElement("div", "tv-highlight-copy"),
  );
  const copy = container.lastElementChild;
  const heading = createElement("div", "tv-highlight-heading");
  heading.append(
    createElement("p", "tv-highlight-label", isCelebration ? "Event Highlight" : isResolved ? "Restored" : isCritical ? "Active Critical Incident" : "Active Incident"),
    createElement("time", "tv-highlight-time", formatTime(highlight.event.updatedAt)),
  );
  const detail = createElement("div", "tv-highlight-detail");
  const metric = createElement("span", "tv-highlight-metric");
  metric.append(document.createTextNode(`${highlight.event.metricLabel} · ${highlight.event.metricValue}`));
  if (highlight.event.expectedRange != null) {
    metric.append(createElement("span", "tv-highlight-range", ` · ${highlight.event.expectedRange}`));
  }
  detail.append(createElement("span", "tv-highlight-source", highlight.event.sourceLabel), metric);
  copy.append(
    heading,
    createElement("p", "tv-highlight-title", highlight.event.title),
    createElement("p", "tv-highlight-summary", highlight.event.summary),
    detail,
  );
  return container;
}

function formatTime(isoDate) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(isoDate));
}

function livePulseScreen(screen, highlight) {
  const terminal = sourceState(screen);
  if (terminal != null) {
    return screenFrame({
      eyebrow: terminal.eyebrow,
      title: "Live Pulse",
      description: "Current activity and monitored source status.",
      tone: "rose",
      icon: "activity",
      content: terminal.content,
      highlight,
    });
  }
  const data = screen.data;
  const left = createElement("div", "tv-panel-stack tv-panel-stack-live");
  const primary = createElement("div");
  const liveSignal = createElement("div", "tv-live-signal");
  liveSignal.append(createElement("span", "tv-live-dot"), document.createTextNode("Live signal"));
  primary.append(
    liveSignal,
    metric(
      "Live now · rolling 2 min",
      data.liveUsers.toLocaleString(),
      screen.insight == null
        ? "Distinct signed-in users refreshing now"
        : `${formatSignedPercent(screen.insight.evidence.deltaPercent)} vs recent baseline`,
      true,
    ),
  );
  const secondary = createElement("div", "tv-metric-grid tv-metric-grid-two tv-metric-divider");
  secondary.append(
    metric("Active today · UTC", data.todayActiveUsers.toLocaleString(), "Current UTC day"),
    metric("Monitored sources", String(data.sourceHealth.length), "Reporting now"),
  );
  left.append(primary, secondary, insight(screen, "cyan"));

  const right = createElement("div", "tv-chart-stack tv-chart-stack-live");
  right.append(
    chartHeader("Today’s Activity", "Current UTC day", true),
    lineChart(data.hourlyActivity, "#67e8f9", "Current UTC day activity"),
  );
  const facts = createElement("div", "tv-source-facts");
  for (const fact of data.sourceHealth) {
    const item = createElement("div", "tv-source-fact");
    const statusIcon = fact.status === "healthy"
      ? "check"
      : fact.status === "error" || fact.status === "stale" ? "shield-warning" : "info";
    const detail = createElement("p", `tv-source-fact-detail tv-status-${fact.status}`);
    detail.append(createIcon(statusIcon), document.createTextNode(fact.detail));
    item.append(
      createElement("p", "tv-source-fact-label", fact.label),
      createElement("p", "tv-source-fact-value", fact.value),
      detail,
    );
    facts.append(item);
  }
  right.append(facts);
  const grid = createElement("div", "tv-screen-grid tv-screen-grid-live");
  grid.append(glassPanel("cyan", [left]), glassPanel("cyan", [right]));
  return screenFrame({
    eyebrow: "Right Now",
    title: "Live Pulse",
    description: "Current activity and source-level signals Hexclave can verify.",
    tone: "cyan",
    icon: "activity",
    content: grid,
    highlight,
  });
}

function audienceScreen(screen, highlight) {
  const terminal = sourceState(screen);
  if (terminal != null) {
    return screenFrame({ eyebrow: terminal.eyebrow, title: "Audience Momentum", description: "Seven-day growth and returning-user momentum.", tone: "rose", icon: "audience", content: terminal.content, highlight });
  }
  const data = screen.data;
  const analytics = data.analytics;
  const unavailable = analytics.data == null;
  const analyticsDetail = analytics.sourceStatus === "unavailable"
    ? "Not Enabled"
    : analytics.sourceStatus === "error" ? "Temporarily Unavailable" : "Limited Data";
  const left = createElement("div", "tv-panel-stack");
  left.append(metric("Total Users · 7d", data.totalUsers.toLocaleString(), `${data.userGrowthPercent}% growth over the last 7 days`, true));
  const metrics = createElement("div", "tv-metric-grid tv-metric-grid-two");
  metrics.append(
    metric("New users · 7d", `+${data.newUsers}`, `${data.verificationRatePercent}% users verified`),
    metric("Monthly Active", formatCompact(data.monthlyActiveUsers)),
    metric("Signed-In Visitors", unavailable ? "—" : formatCompact(analytics.data.visitors), unavailable ? analyticsDetail : undefined),
    metric("Session Avg · 7d", unavailable
      ? "—"
      : analytics.data.averageSessionSeconds == null ? "No Sessions" : formatDuration(analytics.data.averageSessionSeconds), unavailable
      ? analyticsDetail
      : analytics.data.qualifyingSessions === 0 ? "No Sessions" : `${analytics.data.qualifyingSessions.toLocaleString()} ${analytics.data.qualifyingSessions === 1 ? "Session" : "Sessions"}`),
  );
  left.append(metrics, insight(screen, "violet"));
  const right = createElement("div", "tv-chart-stack");
  right.append(
    chartHeader("Audience Lifecycle", "Daily activity · trailing 7 days"),
    stackedBars(data.lifecycle, ["#a78bfa", "#7c3aed", "#c4b5fd"], ["New", "Retained", "Reactivated"]),
  );
  const grid = createElement("div", "tv-screen-grid tv-screen-grid-audience");
  grid.append(glassPanel("violet", [left]), glassPanel("violet", [right]));
  return screenFrame({
    eyebrow: "Seven-Day Audience",
    title: "Audience Momentum",
    description: "Whether new attention is becoming sustained, returning activity.",
    tone: "violet",
    icon: "audience",
    content: grid,
    highlight,
  });
}

function revenueScreen(screen, highlight) {
  const terminal = sourceState(screen);
  if (terminal != null) {
    return screenFrame({ eyebrow: terminal.eyebrow, title: "Revenue & Payments", description: "Thirty-day gross collected revenue and payment collection.", tone: "rose", icon: "revenue", content: terminal.content, highlight });
  }
  const data = screen.data;
  const exact = data.financials.visibility === "exact";
  const trend = exact
    ? data.financials.revenueTrend.map((point) => ({ ...point, value: point.value / 100 }))
    : data.financials.normalizedRevenueTrend;
  const left = createElement("div", "tv-panel-stack");
  left.append(metric(
    "Gross Collected Revenue · 30d",
    exact ? formatExactUsd(data.financials.paidRevenueCents) : "Hidden",
    `${formatSignedPercent(data.revenueChangePercent)} vs previous 30 days${exact ? "" : " · exact values off"}`,
    true,
  ));
  const metrics = createElement("div", "tv-metric-grid tv-metric-grid-two");
  metrics.append(
    metric("Payment Success", data.paymentSuccess.percent == null ? "Insufficient Data" : `${data.paymentSuccess.percent}%`, `${data.paymentSuccess.applicableAttempts} terminal outcomes`),
    metric("Active subscriptions", data.activeSubscriptions.toLocaleString()),
    metric("New subscriptions", `+${data.newSubscriptions}`),
    metric("Past Due", data.pastDueSubscriptions.toLocaleString()),
  );
  left.append(metrics, insight(screen, "emerald"));
  const right = createElement("div", "tv-chart-stack");
  right.append(
    chartHeader("Gross Collected Revenue Momentum", "Cumulative daily trend · trailing 30 days"),
    lineChart(trend, "#6ee7b7", exact ? "Daily gross collected revenue" : "Normalized gross collected revenue direction"),
  );
  const grid = createElement("div", "tv-screen-grid tv-screen-grid-revenue");
  grid.append(glassPanel("emerald", [left]), glassPanel("emerald", [right]));
  return screenFrame({
    eyebrow: "Trailing 30 Days",
    title: "Revenue & Payments",
    description: "Gross collected revenue and subscription collection health.",
    tone: "emerald",
    icon: "revenue",
    content: grid,
    highlight,
  });
}

function emailScreen(screen, highlight) {
  const terminal = sourceState(screen);
  if (terminal != null) {
    return screenFrame({ eyebrow: terminal.eyebrow, title: "Email Health", description: "Seven-day delivery reliability and sending volume.", tone: "rose", icon: "email", content: terminal.content, highlight });
  }
  const data = screen.data;
  const left = createElement("div", "tv-panel-stack");
  left.append(metric(
    "Delivery rate · 7d",
    data.deliveryRatePercent == null ? "Insufficient data" : `${data.deliveryRatePercent}%`,
    data.deliveryRatePercent == null ? "At least 20 confirmed outcomes required" : `${data.assessableSends.toLocaleString()} confirmed outcomes`,
    true,
  ));
  const metrics = createElement("div", "tv-metric-grid tv-metric-grid-two");
  metrics.append(
    metric("Delivered", formatCompact(data.delivered)),
    metric("Bounced", formatCompact(data.bounced)),
    metric("Errors", formatCompact(data.errors)),
    metric("In progress", formatCompact(data.inProgress)),
  );
  left.append(metrics, insight(screen, "amber"));
  const right = createElement("div", "tv-chart-stack");
  right.append(
    chartHeader("Email Delivery Volume", "Daily send status · trailing 7 days"),
    stackedBars(data.statusTrend, ["#fbbf24", "#fb7185", "#94a3b8"], ["Delivered", "Error", "In progress"]),
  );
  const grid = createElement("div", "tv-screen-grid tv-screen-grid-email");
  grid.append(glassPanel("amber", [left]), glassPanel("amber", [right]));
  return screenFrame({
    eyebrow: "Seven-Day Delivery",
    title: "Email Health",
    description: "Whether customer messages are reaching recipients reliably.",
    tone: "amber",
    icon: "email",
    content: grid,
    highlight,
  });
}

function renderTakeover(takeover) {
  const isCelebration = takeover.variant === "celebration";
  const isRecovery = takeover.variant === "recovery-confirmation";
  const isCritical = takeover.variant === "critical-incident";
  const tone = takeover.variant === "celebration"
    ? "amber"
    : takeover.variant === "recovery-confirmation" ? "emerald" : "rose";
  const stage = createElement("section", `tv-takeover tv-takeover-${tone}`);
  stage.append(createElement("div", `tv-takeover-orb tv-takeover-orb-${tone}`));
  if (isCelebration) {
    stage.append(
      createElement("div", "tv-takeover-side-glow tv-takeover-side-glow-left"),
      createElement("div", "tv-takeover-side-glow tv-takeover-side-glow-right"),
    );
  }
  const top = createElement("div", "tv-takeover-top");
  const kicker = createElement("p", `tv-takeover-kicker tv-tone-${tone}`);
  kicker.append(
    createIcon(isCelebration ? "confetti" : isRecovery ? "check" : "broadcast"),
    document.createTextNode(isCelebration ? "Company Milestone" : isRecovery ? "Recovery Confirmed" : isCritical ? "Critical Incident" : "Incident"),
  );
  top.append(kicker, createElement("p", "tv-takeover-source", takeover.event.sourceLabel));

  const center = createElement("div", "tv-takeover-center");
  center.append(
    iconMark(isCelebration ? "confetti" : isRecovery ? "check" : "warning", tone),
    createElement("h1", "tv-takeover-title", takeover.event.title),
    createElement("p", "tv-takeover-summary", takeover.event.summary),
  );
  const metricRow = createElement("div", `tv-takeover-metric tv-tone-${tone}`);
  metricRow.append(
    createElement("span", "tv-takeover-metric-label", takeover.event.metricLabel),
    createElement("strong", "tv-takeover-metric-value", takeover.event.metricValue),
  );
  if (takeover.event.expectedRange != null) {
    metricRow.append(createElement("span", "tv-takeover-expected", takeover.event.expectedRange));
  }
  center.append(metricRow);

  const bottom = createElement("div", "tv-takeover-bottom");
  bottom.append(
    createElement("span", null, "Returning to the playlist automatically"),
    createElement("span", null, `Observed ${formatTime(takeover.event.occurredAt)}`),
  );
  stage.append(top, center, bottom);
  return stage;
}

const SCREEN_RENDERERS = new Map([
  ["live-pulse", livePulseScreen],
  ["audience-momentum", audienceScreen],
  ["revenue-payments", revenueScreen],
  ["email-health", emailScreen],
]);

function presentationStatus(snapshot) {
  if (runtimeConfiguration.mode === "fixture-preview") return ["online", "Fixture Preview"];
  const status = getConnectionStatus(snapshot, navigator.onLine, currentTimeMilliseconds());
  if (status === "offline") return ["offline", "Offline · showing the last safe snapshot"];
  if (status === "stale") return ["stale", "Data is stale"];
  return ["online", `Updated ${formatTime(snapshot.generatedAt)}`];
}

function renderFooter(snapshot) {
  const footerKey = `${snapshot.profile.id}\0${snapshot.profile.playlist.join("\0")}`;
  if (footerRoot.dataset.footerKey !== footerKey) {
    const footer = createElement("footer", "tv-footer");
    const identity = createElement("div", "tv-footer-identity");
    const project = createElement("span", "tv-footer-project");
    project.dataset.footerProject = "";
    const profile = createElement("span", "tv-footer-profile");
    profile.dataset.footerProfile = "";
    identity.append(project, createElement("span", "tv-footer-separator"), profile);
    const connectionElement = createElement("div", "tv-footer-connection");
    connectionElement.dataset.connectionStatus = "";
    footer.append(identity, connectionElement);
    footerRoot.replaceChildren(footer);
    footerRoot.dataset.footerKey = footerKey;
  }

  const project = footerRoot.querySelector("[data-footer-project]");
  const profile = footerRoot.querySelector("[data-footer-profile]");
  if (!(project instanceof HTMLElement)
    || !(profile instanceof HTMLElement)) {
    throw new Error("TV Box footer is missing a required presentation element.");
  }
  project.textContent = snapshot.project.displayName;
  profile.textContent = snapshot.profile.displayName;

  const [connection, status] = presentationStatus(snapshot);
  const connectionElement = footerRoot.querySelector("[data-connection-status]");
  if (!(connectionElement instanceof HTMLElement)) {
    throw new Error("TV Box footer is missing its connection status.");
  }
  connectionElement.className = `tv-footer-connection tv-connection-${connection}`;
  connectionElement.replaceChildren(
    createIcon(connection === "offline" ? "offline" : connection === "stale" ? "warning" : "wifi"),
    document.createTextNode(status),
  );
  footerRoot.hidden = false;
}

function reducedMotionEnabled() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function updateCelebrationEffects() {
  if (state.snapshot == null) {
    backgroundEffects.update({ ambientActive: false, eventId: null, entryBurst: false, foreground: false, takeoverActive: false });
    foregroundEffects.update({ ambientActive: false, eventId: null, entryBurst: false, foreground: true, takeoverActive: false });
    return;
  }
  const effects = getCelebrationEffectState(state.snapshot, currentTimeMilliseconds(), reducedMotionEnabled());
  backgroundEffects.update({
    ambientActive: effects.backgroundAmbient,
    eventId: effects.eventId,
    entryBurst: false,
    foreground: false,
    takeoverActive: false,
  });
  foregroundEffects.update({
    ambientActive: effects.foregroundAmbient,
    eventId: effects.eventId,
    entryBurst: effects.entryBurst,
    foreground: true,
    takeoverActive: effects.takeoverActive,
  });
}

function currentView() {
  return state.snapshot == null
    ? null
    : selectPresentationView(state.snapshot, state.screenIndex, currentTimeMilliseconds());
}

function getViewKey(view) {
  if (view == null) return "unavailable";
  if (view.type === "takeover") {
    return ["takeover", view.takeover.event.id, view.takeover.variant, view.takeover.startedAt, view.takeover.endsAt].join("\0");
  }
  if (view.type === "screen") {
    return `screen\0${state.snapshot?.profile.playlist[view.screenIndex] ?? "missing"}`;
  }
  return view.type;
}

function renderControls() {
  controlsRoot.replaceChildren();
  const snapshot = state.snapshot;
  const view = currentView();
  if (snapshot == null || view?.type !== "screen") return;
  const controls = createElement("div", `tv-controls${state.controlsVisible ? " tv-controls-visible" : ""}`);
  const button = (label, iconName, action) => {
    const element = createElement("button", "tv-control-button");
    element.type = "button";
    element.tabIndex = state.controlsVisible ? 0 : -1;
    element.setAttribute("aria-label", label);
    element.append(createIcon(iconName));
    element.addEventListener("click", action);
    return element;
  };
  controls.append(
    button("Previous screen", "previous", () => navigateScreens(-1)),
    button(state.rotationPaused ? "Resume rotation" : "Pause rotation", state.rotationPaused ? "play" : "pause", toggleRotation),
    button("Next screen", "next", () => navigateScreens(1)),
  );
  if (state.fullscreenAvailable) {
    controls.append(
      createElement("span", "tv-control-divider"),
      button(state.isFullscreen ? "Exit fullscreen" : "Enter fullscreen", state.isFullscreen ? "fullscreen-exit" : "fullscreen-enter", toggleFullscreen),
    );
  }
  controlsRoot.append(controls);
}

function showControls() {
  if (!state.controlsVisible) {
    state.controlsVisible = true;
    renderControls();
  }
  if (state.controlsTimer != null) window.clearTimeout(state.controlsTimer);
  state.controlsTimer = window.setTimeout(() => {
    state.controlsVisible = false;
    state.controlsTimer = undefined;
    renderControls();
  }, 2_800);
}

function navigateScreens(direction) {
  const snapshot = state.snapshot;
  if (snapshot == null || currentView()?.type !== "screen") return;
  const length = snapshot.profile.playlist.length;
  state.screenIndex = direction < 0
    ? (state.screenIndex - 1 + length) % length
    : getNextScreenIndex(state.screenIndex, length);
  renderCurrent();
  scheduleRotation();
}

function toggleRotation() {
  state.rotationPaused = !state.rotationPaused;
  if (state.rotationPaused && state.rotationTimer != null) {
    window.clearTimeout(state.rotationTimer);
    state.rotationTimer = undefined;
  } else if (!state.rotationPaused) {
    scheduleRotation();
  }
  renderControls();
  showControls();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement == null) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (cause) {
    reportFailure("fullscreen-failed", cause);
  }
}

function renderCurrent() {
  const snapshot = state.snapshot;
  updateCelebrationEffects();
  if (snapshot == null) {
    if (state.unavailableReason === "offline") {
      renderMessage("error", "TV Mode Is Offline", "Check the connection. TV Mode will resume automatically when it is back online.");
    } else if (state.unavailableReason === "unauthorized") {
      renderMessage("error", "TV Mode Authorization Required", "This display is no longer authorized. Pair it again to resume TV Mode.");
    } else {
      renderMessage("error", "TV Mode Is Temporarily Unavailable", "We couldn’t load the latest presentation. Please try again shortly.");
    }
    renderControls();
    return;
  }
  const view = currentView();
  const nextViewKey = getViewKey(view);
  state.renderedViewKey = nextViewKey;
  if (view?.type === "fatal-error") {
    renderMessage("error", "TV Mode Is Temporarily Unavailable", view.message);
    renderControls();
    return;
  }
  if (view?.type === "empty") {
    renderMessage("empty", "Waiting for Activity", "This profile is ready. The presentation will update automatically when activity arrives.");
    renderControls();
    return;
  }
  if (view?.type === "takeover") {
    state.renderedHighlightKey = null;
    clearFooter();
    replaceRoot(renderTakeover(view.takeover));
    renderControls();
    return;
  }
  const screenId = snapshot.profile.playlist[state.screenIndex] ?? snapshot.profile.playlist[0];
  const screen = snapshot.screens.find((candidate) => candidate.id === screenId);
  const renderer = SCREEN_RENDERERS.get(screenId);
  if (screen == null || renderer == null) {
    renderMessage("empty", "Waiting for Activity", "This profile will update automatically when activity arrives.");
    renderControls();
    return;
  }
  const highlight = snapshot.presentation.highlight;
  const visibleHighlight = highlight != null
    && (highlight.expiresAt == null || Date.parse(highlight.expiresAt) > currentTimeMilliseconds())
    ? highlight
    : null;
  if (visibleHighlight == null) state.renderedHighlightKey = null;
  const stage = renderer(screen, visibleHighlight);
  renderFooter(snapshot);
  replaceRoot(stage);
  renderControls();
}

function updateFreshness() {
  const snapshot = state.snapshot;
  const statusElement = footerRoot.querySelector("[data-connection-status]");
  if (snapshot == null || !(statusElement instanceof HTMLElement)) return;
  const [connection, status] = presentationStatus(snapshot);
  statusElement.className = `tv-footer-connection tv-connection-${connection}`;
  statusElement.replaceChildren(
    createIcon(connection === "offline" ? "offline" : connection === "stale" ? "warning" : "wifi"),
    document.createTextNode(status),
  );
}

function scheduleRotation() {
  if (state.rotationTimer != null) window.clearTimeout(state.rotationTimer);
  const snapshot = state.snapshot;
  if (snapshot == null
    || snapshot.profile.playlist.length <= 1
    || state.rotationPaused
    || currentView()?.type !== "screen") return;
  const screenId = snapshot.profile.playlist[state.screenIndex] ?? snapshot.profile.playlist[0];
  const duration = getScreenDurationSeconds(snapshot, screenId);
  state.rotationTimer = window.setTimeout(() => {
    state.screenIndex = getNextScreenIndex(state.screenIndex, snapshot.profile.playlist.length);
    renderCurrent();
    scheduleRotation();
  }, duration * 1000);
}

function synchronizePresentationTimers() {
  if (state.presentationTimer != null) {
    window.clearTimeout(state.presentationTimer);
    state.presentationTimer = undefined;
  }
  const snapshot = state.snapshot;
  if (snapshot == null) return;
  const now = currentTimeMilliseconds();
  const takeoverDeadline = snapshot.presentation.takeover == null
    ? null
    : Date.parse(snapshot.presentation.takeover.endsAt);
  const takeoverActive = takeoverDeadline != null && takeoverDeadline > now;
  if (takeoverActive && state.rotationTimer != null) {
    window.clearTimeout(state.rotationTimer);
    state.rotationTimer = undefined;
  } else if (!takeoverActive && state.rotationTimer == null) {
    scheduleRotation();
  }
  const highlightDeadline = snapshot.presentation.highlight?.expiresAt == null
    ? null
    : Date.parse(snapshot.presentation.highlight.expiresAt);
  const animationDeadline = snapshot.presentation.highlight?.animationExpiresAt == null
    ? null
    : Date.parse(snapshot.presentation.highlight.animationExpiresAt);
  const futureDeadlines = [takeoverDeadline, highlightDeadline, animationDeadline]
    .filter((deadline) => deadline != null && Number.isFinite(deadline) && deadline > now);
  if (futureDeadlines.length === 0) return;
  const nextDeadline = Math.min(...futureDeadlines);
  state.presentationTimer = window.setTimeout(() => {
    state.presentationTimer = undefined;
    renderCurrent();
    synchronizePresentationTimers();
  }, nextDeadline - now);
}

async function refreshAccess() {
  const response = await requestWithTimeout("/tv-displays/auth/refresh", { method: "POST" }, PAIRING_REQUEST_TIMEOUT_MS);
  const disposition = classifyDisplayRefreshResponse(response.status);
  if (disposition === "invalid-credential") return null;
  if (disposition === "temporary-failure") {
    throw new Error(`TV display credential refresh is temporarily unavailable (${response.status}).`);
  }
  const body = await response.json();
  if (body == null || typeof body !== "object" || typeof body.accessToken !== "string") {
    throw new Error("TV display refresh response is invalid.");
  }
  state.accessToken = body.accessToken;
  return body.accessToken;
}

async function createChallenge() {
  state.authenticationState = "pairing";
  state.pairingError = false;
  state.challenge = null;
  renderPairing();
  const response = await requestWithTimeout("/tv-displays/pairing-challenges", { method: "POST" }, PAIRING_REQUEST_TIMEOUT_MS);
  if (!response.ok) throw new Error("TV display pairing challenge could not be created.");
  state.challenge = assertPairingChallenge(await response.json());
  state.pairingError = false;
  state.pairingRetryAttempt = 0;
  state.pairingPollFailureAttempt = 0;
  renderPairing();
  schedulePairingPoll(0);
}

function schedulePairingRetry() {
  if (state.pairingTimer != null) window.clearTimeout(state.pairingTimer);
  const delay = getDisplaySessionRetryDelay(state.pairingRetryAttempt);
  state.pairingRetryAttempt += 1;
  state.pairingTimer = window.setTimeout(() => {
    createChallenge().catch((cause) => {
      state.pairingError = true;
      reportFailure("pairing-challenge-failed", cause);
      renderPairing();
      schedulePairingRetry();
    });
  }, delay);
}

async function createChallengeOrRetry() {
  try {
    await createChallenge();
  } catch (cause) {
    state.pairingError = true;
    reportFailure("pairing-challenge-failed", cause);
    renderPairing();
    schedulePairingRetry();
  }
}

function schedulePairingPoll(delayMilliseconds) {
  if (state.pairingTimer != null) window.clearTimeout(state.pairingTimer);
  state.pairingTimer = window.setTimeout(() => {
    pollPairing().catch((cause) => {
      state.pairingError = true;
      reportFailure("pairing-status-failed", cause);
      renderPairing();
      if (state.challenge == null) {
        schedulePairingRetry();
      } else {
        const retryDelay = getDisplaySessionRetryDelay(state.pairingPollFailureAttempt);
        state.pairingPollFailureAttempt += 1;
        schedulePairingPoll(retryDelay);
      }
    });
  }, delayMilliseconds);
}

async function pollPairing() {
  const challenge = state.challenge;
  if (challenge == null || state.stopped) return;
  const response = await requestWithTimeout(
    `/tv-displays/pairing-challenges/${encodeURIComponent(challenge.challengeId)}/status`,
    { method: "POST", body: JSON.stringify({ deviceSecret: challenge.deviceSecret }) },
    PAIRING_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error("TV display pairing status could not be loaded.");
  const result = assertPairingStatus(await response.json());
  clearFailure();
  state.pairingError = false;
  state.pairingPollFailureAttempt = 0;
  if (result.status === "paired") {
    state.authenticationState = "paired";
    state.accessToken = result.accessToken;
    state.challenge = null;
    renderMessage("loading", "Preparing TV Mode", "Assembling the latest office-safe snapshot…");
    await refreshSnapshot();
    scheduleSnapshotPoll();
    return;
  }
  if (result.status !== "waiting") {
    await createChallenge();
    return;
  }
  schedulePairingPoll(challenge.pollingIntervalSeconds * 1000);
}

async function loadSnapshot(token, signal) {
  return await request("/tv-displays/snapshot", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
}

async function refreshSnapshot() {
  if (state.accessToken == null || state.activeRequest != null || state.stopped) return;
  const controller = new AbortController();
  state.activeRequest = controller;
  const timeout = window.setTimeout(() => controller.abort(), TV_SNAPSHOT_REQUEST_TIMEOUT_MS);
  try {
    let response = await loadSnapshot(state.accessToken, controller.signal);
    if (response.status === 401) {
      const refreshed = await refreshAccess();
      if (refreshed == null) {
        state.authenticationState = "pairing";
        state.accessToken = null;
        state.snapshot = null;
        state.unavailableReason = "unauthorized";
        renderCurrent();
        await createChallengeOrRetry();
        return;
      }
      response = await loadSnapshot(refreshed, controller.signal);
    }
    if (!response.ok) throw new Error(`TV display snapshot failed with ${response.status}.`);
    const next = assertTvSnapshot(await response.json());
    const nextProfileKey = `${next.profile.id}\0${next.profile.playlist.join("\0")}`;
    const profileChanged = state.profileKey !== null && state.profileKey !== nextProfileKey;
    state.profileKey = nextProfileKey;
    if (profileChanged) {
      state.screenIndex = 0;
      state.rotationPaused = false;
    }
    state.snapshot = next;
    state.unavailableReason = null;
    clearFailure();
    renderCurrent();
    if (profileChanged && state.rotationTimer != null) {
      window.clearTimeout(state.rotationTimer);
      state.rotationTimer = undefined;
    }
    synchronizePresentationTimers();
  } catch (cause) {
    if (controller.signal.aborted) {
      reportFailure("snapshot-timeout", new Error("TV snapshot request timed out."));
    } else {
      reportFailure("snapshot-refresh-failed", cause);
    }
    if (state.snapshot == null) {
      state.unavailableReason = navigator.onLine ? "error" : "offline";
      renderCurrent();
    } else {
      updateFreshness();
    }
  } finally {
    window.clearTimeout(timeout);
    if (state.activeRequest === controller) state.activeRequest = null;
  }
}

function scheduleSnapshotPoll() {
  if (state.snapshotTimer != null) window.clearTimeout(state.snapshotTimer);
  if (!shouldPollDisplaySnapshot(state.authenticationState, state.accessToken)) return;
  state.snapshotTimer = window.setTimeout(() => {
    refreshSnapshot().finally(() => {
      if (!state.stopped && shouldPollDisplaySnapshot(state.authenticationState, state.accessToken)) {
        scheduleSnapshotPoll();
      }
    });
  }, TV_SNAPSHOT_POLL_INTERVAL_MS);
}

function scheduleFreshnessUpdate() {
  if (state.freshnessTimer != null) window.clearTimeout(state.freshnessTimer);
  state.freshnessTimer = window.setTimeout(() => {
    updateFreshness();
    if (!state.stopped) scheduleFreshnessUpdate();
  }, TV_FRESHNESS_INTERVAL_MS);
}

function handleNetworkChange() {
  updateFreshness();
  if (!navigator.onLine) return;
  if (state.authenticationState === "restoring") {
    recoverDisplaySession().catch((cause) => reportFailure("session-reconnect-failed", cause));
  } else if (state.authenticationState === "pairing") {
    if (state.challenge == null) {
      createChallengeOrRetry().catch((cause) => reportFailure("pairing-reconnect-failed", cause));
    } else {
      schedulePairingPoll(0);
    }
  } else if (shouldPollDisplaySnapshot(state.authenticationState, state.accessToken)) {
    refreshSnapshot().catch((cause) => reportFailure("snapshot-reconnect-failed", cause));
  }
}

function handleKeyDown(event) {
  showControls();
  if (state.snapshot == null || currentView()?.type !== "screen") return;
  const target = event.target;
  const interactive = target instanceof HTMLElement
    && target.closest("button, a, input, select, textarea, [contenteditable='true']") != null;
  if (event.key === "ArrowLeft") {
    navigateScreens(-1);
  } else if (event.key === "ArrowRight") {
    navigateScreens(1);
  } else if (event.key === " " && !interactive) {
    event.preventDefault();
    toggleRotation();
  } else if (event.key.toLowerCase() === "f" && state.fullscreenAvailable) {
    toggleFullscreen();
  }
}

function handleFullscreenChange() {
  state.isFullscreen = document.fullscreenElement != null;
  renderControls();
}

function renderSessionUnavailable() {
  const offline = !navigator.onLine;
  renderMessage(
    "error",
    "TV Mode Temporarily Unavailable",
    offline
      ? "This display is offline. TV Mode will reconnect automatically when the network returns."
      : "This display could not reach Hexclave. TV Mode will retry automatically.",
  );
}

function scheduleDisplaySessionRetry() {
  if (state.sessionTimer != null) window.clearTimeout(state.sessionTimer);
  const delay = getDisplaySessionRetryDelay(state.sessionRetryAttempt);
  state.sessionRetryAttempt += 1;
  state.sessionTimer = window.setTimeout(() => {
    state.sessionTimer = undefined;
    recoverDisplaySession().catch((cause) => {
      reportFailure("session-recovery-failed", cause);
      renderSessionUnavailable();
      scheduleDisplaySessionRetry();
    });
  }, delay);
}

async function recoverDisplaySession() {
  if (state.stopped || state.sessionRecoveryInFlight || state.authenticationState !== "restoring") return;
  state.sessionRecoveryInFlight = true;
  if (state.sessionTimer != null) {
    window.clearTimeout(state.sessionTimer);
    state.sessionTimer = undefined;
  }
  try {
    let token;
    try {
      token = await refreshAccess();
    } catch (cause) {
      reportFailure("session-refresh-unavailable", cause);
      renderSessionUnavailable();
      scheduleDisplaySessionRetry();
      return;
    }
    if (token == null) {
      state.sessionRetryAttempt = 0;
      state.authenticationState = "pairing";
      await createChallengeOrRetry();
      return;
    }
    state.sessionRetryAttempt = 0;
    state.authenticationState = "paired";
    renderMessage("loading", "Preparing TV Mode", "Assembling the latest office-safe snapshot…");
    await refreshSnapshot();
    // refreshSnapshot can discover that an otherwise valid access token
    // belongs to a display that was deleted while the appliance was offline.
    // In that case it has already returned the UI to pairing, so do not leave
    // a second snapshot loop running behind the pairing flow.
    if (shouldPollDisplaySnapshot(state.authenticationState, state.accessToken)) {
      scheduleSnapshotPoll();
    }
  } finally {
    state.sessionRecoveryInFlight = false;
  }
}

async function start() {
  if (runtimeConfiguration.mode === "fixture-preview") {
    state.snapshot = runtimeConfiguration.snapshot;
    state.profileKey = `${state.snapshot.profile.id}\0${state.snapshot.profile.playlist.join("\0")}`;
    renderCurrent();
    synchronizePresentationTimers();
    return;
  }
  renderMessage("loading", "Connecting TV Mode", "Restoring this display’s secure connection…");
  scheduleFreshnessUpdate();
  await recoverDisplaySession();
}

if (runtimeConfiguration.mode === "live") {
  window.addEventListener("online", handleNetworkChange);
  window.addEventListener("offline", handleNetworkChange);
}
window.addEventListener("mousemove", showControls);
window.addEventListener("keydown", handleKeyDown);
document.addEventListener("fullscreenchange", handleFullscreenChange);
state.fullscreenAvailable = typeof document.documentElement.requestFullscreen === "function"
  && typeof document.exitFullscreen === "function";
window.addEventListener("pagehide", () => {
  state.stopped = true;
  state.activeRequest?.abort();
  for (const timer of [state.rotationTimer, state.presentationTimer, state.snapshotTimer, state.freshnessTimer, state.pairingTimer, state.sessionTimer, state.controlsTimer]) {
    if (timer != null) window.clearTimeout(timer);
  }
  backgroundEffects.destroy();
  foregroundEffects.destroy();
});

start().catch((cause) => {
  reportFailure("startup-failed", cause);
  if (runtimeConfiguration.mode === "fixture-preview") {
    renderMessage("error", "Fixture Preview Is Unavailable", "The selected synthetic presentation could not be rendered.");
    return;
  }
  state.authenticationState = "restoring";
  renderSessionUnavailable();
  scheduleDisplaySessionRetry();
});

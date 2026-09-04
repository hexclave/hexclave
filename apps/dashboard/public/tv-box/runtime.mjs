export const TV_SNAPSHOT_POLL_INTERVAL_MS = 15_000;
export const TV_SNAPSHOT_REQUEST_TIMEOUT_MS = 12_000;
export const TV_FRESHNESS_INTERVAL_MS = 5_000;
export const PAIRING_REQUEST_TIMEOUT_MS = 12_000;
export const DISPLAY_SESSION_RETRY_INITIAL_MS = 5_000;
export const DISPLAY_SESSION_RETRY_MAXIMUM_MS = 60_000;
const TV_MAXIMUM_TAKEOVER_DURATION_MS = 120_000;

export const TV_SCREEN_IDS = Object.freeze([
  "live-pulse",
  "audience-momentum",
  "revenue-payments",
  "email-health",
]);

const TV_SOURCE_STATUSES = new Set([
  "ready",
  "empty",
  "insufficient-data",
  "unavailable",
  "error",
  "stale",
]);
const TV_EVENT_TYPES = new Set([
  "email-delivery-degradation",
  "subscription-collection-degradation",
  "user-milestone",
]);
const TV_EVENT_PRESENTATION_CLASSES = new Set(["celebration", "incident", "critical-incident"]);
const TV_EVENT_STATUSES = new Set(["active", "resolved"]);
const TV_TAKEOVER_VARIANTS = new Set(["celebration", "incident", "critical-incident", "recovery-confirmation"]);
const TV_HIGHLIGHT_VARIANTS = new Set(["celebration", "active-incident", "resolved-incident"]);

export function classifyDisplayRefreshResponse(status) {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error("TV display refresh status must be a valid HTTP status code.");
  }
  if (status === 401) return "invalid-credential";
  if (status >= 200 && status < 300) return "refreshed";
  return "temporary-failure";
}

export function getDisplaySessionRetryDelay(attempt) {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error("TV display session retry attempt must be a non-negative integer.");
  }
  return Math.min(DISPLAY_SESSION_RETRY_INITIAL_MS * (2 ** Math.min(attempt, 16)), DISPLAY_SESSION_RETRY_MAXIMUM_MS);
}

export function shouldPollDisplaySnapshot(authenticationState, accessToken) {
  return authenticationState === "paired" && typeof accessToken === "string" && accessToken.length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasFiniteNumber(record, key) {
  return typeof record[key] === "number" && Number.isFinite(record[key]);
}

function hasString(record, key) {
  return typeof record[key] === "string";
}

function hasDateString(record, key) {
  return hasString(record, key) && Number.isFinite(Date.parse(record[key]));
}

function isTrendPoint(value) {
  return isRecord(value) && hasString(value, "label") && hasFiniteNumber(value, "value");
}

function isStackedTrendPoint(value) {
  return isRecord(value)
    && hasString(value, "label")
    && hasFiniteNumber(value, "primary")
    && hasFiniteNumber(value, "secondary")
    && hasFiniteNumber(value, "tertiary");
}

function hasScreenEnvelope(screen, id) {
  return isRecord(screen)
    && screen.id === id
    && typeof screen.sourceStatus === "string"
    && TV_SOURCE_STATUSES.has(screen.sourceStatus)
    && hasString(screen, "sourceLabel")
    && (screen.data === null || isRecord(screen.data));
}

function isLivePulseScreen(screen) {
  if (!hasScreenEnvelope(screen, "live-pulse")) return false;
  if (screen.data === null) return ["empty", "unavailable", "error"].includes(screen.sourceStatus);
  return hasFiniteNumber(screen.data, "liveUsers")
    && hasFiniteNumber(screen.data, "todayActiveUsers")
    && Array.isArray(screen.data.hourlyActivity)
    && screen.data.hourlyActivity.every(isTrendPoint)
    && Array.isArray(screen.data.sourceHealth)
    && screen.data.sourceHealth.every((fact) => isRecord(fact)
      && hasString(fact, "label")
      && hasString(fact, "status")
      && hasString(fact, "value")
      && hasString(fact, "detail"));
}

function isAudienceScreen(screen) {
  if (!hasScreenEnvelope(screen, "audience-momentum")) return false;
  if (screen.data === null) return ["empty", "unavailable", "error"].includes(screen.sourceStatus);
  const analytics = screen.data.analytics;
  return hasFiniteNumber(screen.data, "totalUsers")
    && hasFiniteNumber(screen.data, "userGrowthPercent")
    && hasFiniteNumber(screen.data, "newUsers")
    && hasFiniteNumber(screen.data, "monthlyActiveUsers")
    && hasFiniteNumber(screen.data, "verificationRatePercent")
    && Array.isArray(screen.data.lifecycle)
    && screen.data.lifecycle.every(isStackedTrendPoint)
    && isRecord(analytics)
    && hasString(analytics, "sourceStatus")
    && (analytics.data === null || (isRecord(analytics.data)
      && hasFiniteNumber(analytics.data, "visitors")
      && hasFiniteNumber(analytics.data, "qualifyingSessions")
      && (analytics.data.averageSessionSeconds === null || hasFiniteNumber(analytics.data, "averageSessionSeconds"))));
}

function isRevenueScreen(screen) {
  if (!hasScreenEnvelope(screen, "revenue-payments")) return false;
  if (screen.data === null) return ["empty", "unavailable", "error"].includes(screen.sourceStatus);
  const financials = screen.data.financials;
  const paymentSuccess = screen.data.paymentSuccess;
  if (!isRecord(financials) || !isRecord(paymentSuccess)) return false;
  const validFinancials = financials.visibility === "exact"
    ? hasFiniteNumber(financials, "paidRevenueCents")
      && Array.isArray(financials.revenueTrend)
      && financials.revenueTrend.every(isTrendPoint)
    : financials.visibility === "redacted"
      && Array.isArray(financials.normalizedRevenueTrend)
      && financials.normalizedRevenueTrend.every(isTrendPoint);
  return validFinancials
    && hasFiniteNumber(screen.data, "revenueChangePercent")
    && hasFiniteNumber(screen.data, "activeSubscriptions")
    && hasFiniteNumber(screen.data, "newSubscriptions")
    && hasFiniteNumber(screen.data, "pastDueSubscriptions")
    && hasFiniteNumber(paymentSuccess, "applicableAttempts")
    && (paymentSuccess.percent === null || hasFiniteNumber(paymentSuccess, "percent"));
}

function isEmailScreen(screen) {
  if (!hasScreenEnvelope(screen, "email-health")) return false;
  if (screen.data === null) return ["empty", "unavailable", "error"].includes(screen.sourceStatus);
  return hasFiniteNumber(screen.data, "sent")
    && (screen.data.deliveryRatePercent === null || hasFiniteNumber(screen.data, "deliveryRatePercent"))
    && hasFiniteNumber(screen.data, "assessableSends")
    && hasFiniteNumber(screen.data, "delivered")
    && hasFiniteNumber(screen.data, "bounced")
    && hasFiniteNumber(screen.data, "errors")
    && hasFiniteNumber(screen.data, "inProgress")
    && (screen.data.bounceRatePercent === null || hasFiniteNumber(screen.data, "bounceRatePercent"))
    && hasFiniteNumber(screen.data, "volumeChangePercent")
    && Array.isArray(screen.data.statusTrend)
    && screen.data.statusTrend.every(isStackedTrendPoint);
}

function isTvEvent(event) {
  if (!isRecord(event)
    || !hasString(event, "id")
    || !TV_EVENT_TYPES.has(event.type)
    || !TV_EVENT_PRESENTATION_CLASSES.has(event.presentationClass)
    || !TV_EVENT_STATUSES.has(event.status)
    || !hasString(event, "title")
    || !hasString(event, "summary")
    || !hasString(event, "metricLabel")
    || !hasString(event, "metricValue")
    || !(event.expectedRange === null || typeof event.expectedRange === "string")
    || !hasString(event, "sourceLabel")
    || !hasDateString(event, "occurredAt")
    || !hasDateString(event, "updatedAt")) return false;
  return event.type === "user-milestone"
    ? event.presentationClass === "celebration"
    : event.presentationClass === "incident" || event.presentationClass === "critical-incident";
}

function isPresentedTakeover(takeover) {
  if (takeover === null) return true;
  if (!isRecord(takeover)
    || !isTvEvent(takeover.event)
    || !TV_TAKEOVER_VARIANTS.has(takeover.variant)
    || !hasDateString(takeover, "startedAt")
    || !hasDateString(takeover, "endsAt")
    || Date.parse(takeover.endsAt) <= Date.parse(takeover.startedAt)
    || Date.parse(takeover.endsAt) - Date.parse(takeover.startedAt) > TV_MAXIMUM_TAKEOVER_DURATION_MS) return false;
  if (takeover.variant === "celebration") {
    return takeover.event.presentationClass === "celebration" && takeover.event.status === "active";
  }
  if (takeover.variant === "recovery-confirmation") {
    return takeover.event.presentationClass !== "celebration" && takeover.event.status === "resolved";
  }
  return takeover.event.presentationClass === takeover.variant && takeover.event.status === "active";
}

function isPresentedHighlight(highlight) {
  if (highlight === null) return true;
  if (!isRecord(highlight)
    || !isTvEvent(highlight.event)
    || !TV_HIGHLIGHT_VARIANTS.has(highlight.variant)
    || !(highlight.expiresAt === null || Number.isFinite(Date.parse(highlight.expiresAt)))
    || !(highlight.animationExpiresAt === null || Number.isFinite(Date.parse(highlight.animationExpiresAt)))) return false;
  if (highlight.variant === "celebration") {
    return highlight.event.presentationClass === "celebration"
      && highlight.event.status === "active"
      && highlight.expiresAt !== null
      && highlight.animationExpiresAt !== null
      && Date.parse(highlight.animationExpiresAt) <= Date.parse(highlight.expiresAt);
  }
  if (highlight.variant === "active-incident") {
    return highlight.event.presentationClass !== "celebration"
      && highlight.event.status === "active"
      && highlight.expiresAt === null
      && highlight.animationExpiresAt === null;
  }
  return highlight.event.presentationClass !== "celebration"
    && highlight.event.status === "resolved"
    && highlight.expiresAt !== null
    && highlight.animationExpiresAt === null;
}

const SCREEN_VALIDATORS = new Map([
  ["live-pulse", isLivePulseScreen],
  ["audience-momentum", isAudienceScreen],
  ["revenue-payments", isRevenueScreen],
  ["email-health", isEmailScreen],
]);

export function assertTvSnapshot(value) {
  if (!isRecord(value)) throw new Error("TV snapshot must be an object.");
  if (!hasString(value, "generatedAt") || !hasString(value, "staleAfter")) {
    throw new Error("TV snapshot freshness metadata is invalid.");
  }
  if (!isRecord(value.project) || !hasString(value.project, "displayName")) {
    throw new Error("TV snapshot project metadata is invalid.");
  }
  if (!isRecord(value.profile)
    || !hasString(value.profile, "id")
    || !hasString(value.profile, "displayName")
    || !hasFiniteNumber(value.profile, "defaultDurationSeconds")
    || !Array.isArray(value.profile.playlist)
    || value.profile.playlist.length === 0
    || !value.profile.playlist.every((screenId) => TV_SCREEN_IDS.includes(screenId))) {
    throw new Error("TV snapshot profile is invalid.");
  }
  if (!Array.isArray(value.screens) || value.screens.length !== TV_SCREEN_IDS.length) {
    throw new Error("TV snapshot screen collection is invalid.");
  }
  const byId = new Map(value.screens.map((screen) => [screen?.id, screen]));
  for (const screenId of TV_SCREEN_IDS) {
    const screen = byId.get(screenId);
    if (!SCREEN_VALIDATORS.get(screenId)(screen)) {
      throw new Error(`TV snapshot screen "${screenId}" is invalid.`);
    }
  }
  if (!isRecord(value.presentation)
    || !Object.hasOwn(value.presentation, "takeover")
    || !Object.hasOwn(value.presentation, "highlight")
    || !isPresentedTakeover(value.presentation.takeover)
    || !isPresentedHighlight(value.presentation.highlight)) {
    throw new Error("TV snapshot presentation state is invalid.");
  }
  return value;
}

export function assertPairingChallenge(value) {
  if (!isRecord(value)
    || !hasString(value, "challengeId")
    || !hasString(value, "deviceSecret")
    || !hasString(value, "pairingCode")
    || !hasFiniteNumber(value, "pollingIntervalSeconds")) {
    throw new Error("TV display pairing challenge is invalid.");
  }
  return value;
}

export function assertPairingStatus(value) {
  if (!isRecord(value) || !hasString(value, "status")) {
    throw new Error("TV display pairing status is invalid.");
  }
  if (value.status === "paired" && !hasString(value, "accessToken")) {
    throw new Error("Paired TV display response is missing its access token.");
  }
  if (!["waiting", "paired", "expired", "rejected", "used"].includes(value.status)) {
    throw new Error("TV display pairing status is unknown.");
  }
  return value;
}

export function resolveTvBoxRuntimeConfiguration(value, browserOrigin) {
  if (!isRecord(value)) throw new Error("TV Box runtime configuration must be an object.");
  if (value.mode === "fixture-preview") {
    return { mode: "fixture-preview", snapshot: assertTvSnapshot(value.snapshot) };
  }
  if (value.mode !== "live" || !isRecord(value.api)) {
    throw new Error("TV Box runtime configuration is invalid.");
  }
  const apiBaseUrl = value.api.mode === "browser-origin"
    ? browserOrigin
    : value.api.mode === "configured" && hasString(value.api, "apiBaseUrl")
      ? value.api.apiBaseUrl
      : null;
  if (apiBaseUrl === null) throw new Error("TV Box API configuration is invalid.");
  return { mode: "live", apiBaseUrl };
}

export function getFixturePreviewTime(generatedAt, monotonicStartedAt, monotonicNow) {
  const fixtureStartedAt = Date.parse(generatedAt);
  if (!Number.isFinite(fixtureStartedAt)
    || !Number.isFinite(monotonicStartedAt)
    || !Number.isFinite(monotonicNow)) {
    throw new Error("TV Box fixture preview clock is invalid.");
  }
  return fixtureStartedAt + Math.max(0, monotonicNow - monotonicStartedAt);
}

export function createApiUrl(apiBaseUrl, path) {
  return new URL(`/api/latest${path}`, apiBaseUrl).toString();
}

export function createRequestHeaders(options = {}) {
  const headers = new Headers(options.headers);
  if (options.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

export function replaceStage(root, content) {
  // TV Box deliberately uses a hard cut. Full-stage opacity and scale
  // transitions make embedded WPE composite two chart-heavy frames and can
  // stretch a sub-second animation into several seconds on constrained boxes.
  root.replaceChildren(content);
}

export function getNextScreenIndex(currentIndex, playlistLength) {
  return playlistLength <= 0 ? 0 : (currentIndex + 1) % playlistLength;
}

export function getScreenDurationSeconds(snapshot, screenId) {
  const configured = snapshot.profile.screenDurations?.find((entry) => entry.screenId === screenId);
  return configured?.durationSeconds ?? snapshot.profile.defaultDurationSeconds;
}

export function getConnectionStatus(snapshot, online, nowMilliseconds = Date.now()) {
  if (!online) return "offline";
  return nowMilliseconds >= Date.parse(snapshot.staleAfter) ? "stale" : "online";
}

export function selectPresentationView(snapshot, screenIndex, nowMilliseconds = Date.now()) {
  if (snapshot.fatalErrorMessage != null) {
    return { type: "fatal-error", message: snapshot.fatalErrorMessage };
  }
  const takeover = snapshot.presentation.takeover;
  if (takeover != null && Date.parse(takeover.endsAt) > nowMilliseconds) {
    return { type: "takeover", takeover };
  }
  const playlistScreens = snapshot.profile.playlist
    .map((screenId) => snapshot.screens.find((screen) => screen.id === screenId))
    .filter((screen) => screen != null);
  if (playlistScreens.length > 0 && playlistScreens.every((screen) => screen.sourceStatus === "empty")) {
    return { type: "empty" };
  }
  return {
    type: "screen",
    screenIndex: Math.min(screenIndex, snapshot.profile.playlist.length - 1),
  };
}

export function getCelebrationEffectState(snapshot, nowMilliseconds = Date.now(), reducedMotion = false) {
  const view = selectPresentationView(snapshot, 0, nowMilliseconds);
  const highlight = snapshot.presentation.highlight;
  const celebrationHighlightActive = highlight?.variant === "celebration"
    && highlight.expiresAt != null
    && Date.parse(highlight.expiresAt) > nowMilliseconds;
  const animationEligible = highlight?.variant === "celebration"
    && highlight.animationExpiresAt != null
    && Date.parse(highlight.animationExpiresAt) > nowMilliseconds;
  const celebrationTakeover = view.type === "takeover" && view.takeover.variant === "celebration";
  const blockedByOtherTakeover = view.type === "takeover" && !celebrationTakeover;
  const animationActive = !reducedMotion && animationEligible && !blockedByOtherTakeover;
  const highlightAccentActive = celebrationHighlightActive && view.type !== "takeover";
  return {
    eventId: celebrationTakeover ? view.takeover.event.id : highlight?.event.id ?? null,
    backgroundAmbient: highlightAccentActive,
    foregroundAmbient: celebrationTakeover ? animationActive : highlightAccentActive,
    entryBurst: animationActive && celebrationTakeover,
    takeoverActive: celebrationTakeover,
  };
}

export function formatCompact(value) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatSignedPercent(percent) {
  if (percent === 0) return "0%";
  return `${percent > 0 ? "↑" : "↓"} ${Math.abs(percent)}%`;
}

export function formatExactUsd(cents) {
  const fractionDigits = cents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(cents / 100);
}

export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function getNiceChartScale(maximumValue) {
  const roughStep = maximumValue / 3;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(roughStep, 1)));
  const normalizedStep = roughStep / magnitude;
  const multiplier = normalizedStep <= 1.5 ? 1 : normalizedStep <= 3 ? 2 : normalizedStep <= 7 ? 5 : 10;
  const step = multiplier * magnitude;
  const maximum = Math.ceil(maximumValue / step) * step;
  return {
    maximum,
    ticks: Array.from({ length: Math.round(maximum / step) + 1 }, (_, index) => maximum - index * step),
  };
}

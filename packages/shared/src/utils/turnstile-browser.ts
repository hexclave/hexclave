import { HexclaveAssertionError } from "./errors";
import { TurnstileAction } from "./turnstile";

export type TurnstileWidgetId = string;
export type TurnstileTheme = "auto" | "light" | "dark";
export type TurnstileAppearance = "always" | "execute" | "interaction-only";
export type TurnstileExecution = "render" | "execute";
export type TurnstileSize = "invisible" | "flexible" | "normal" | "compact";

export type TurnstileConfig = {
  sitekey: string,
  action: TurnstileAction,
  theme?: TurnstileTheme,
  appearance?: TurnstileAppearance,
  execution?: TurnstileExecution,
  size?: TurnstileSize,
  callback: (token: string) => void,
  "error-callback": (errorCode?: string) => void,
  "expired-callback": () => void,
  "timeout-callback"?: () => void,
};

export type TurnstileApi = {
  render: (container: HTMLElement, config: TurnstileConfig) => TurnstileWidgetId,
  execute?: (widgetId: TurnstileWidgetId) => void,
  remove: (widgetId: TurnstileWidgetId) => void,
  reset?: (widgetId: TurnstileWidgetId) => void,
};

const TURNSTILE_SCRIPT_BASE_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const TURNSTILE_SCRIPT_LOAD_TIMEOUT_MS = 30_000;

export function isTurnstileApi(value: unknown): value is TurnstileApi {
  return typeof value === "object"
    && value !== null
    && "render" in value
    && "remove" in value;
}

export function getTurnstileApi(): TurnstileApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const maybeTurnstile = window["turnstile"];
  return isTurnstileApi(maybeTurnstile) ? maybeTurnstile : undefined;
}

let turnstileScriptPromise: Promise<void> | null = null;

export function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new HexclaveAssertionError("Turnstile can only be loaded in the browser"));
  }

  if (getTurnstileApi()) {
    return Promise.resolve();
  }

  turnstileScriptPromise ??= new Promise<void>((resolve, reject) => {
    const rejectAndReset = (err: Error) => {
      turnstileScriptPromise = null;
      reject(err);
    };

    const timeout = setTimeout(() => {
      rejectAndReset(new Error("Turnstile script load timed out"));
    }, TURNSTILE_SCRIPT_LOAD_TIMEOUT_MS);

    const resolveAndClearTimeout = () => {
      clearTimeout(timeout);
      resolve();
    };

    const existingScript = document.querySelector<HTMLScriptElement>(`script[src^="${TURNSTILE_SCRIPT_BASE_URL}"]`);
    if (existingScript) {
      // If the Turnstile API is already available (script loaded before our loader ran),
      // resolve immediately — the load event may have already fired.
      if (getTurnstileApi()) {
        resolveAndClearTimeout();
        return;
      }
      existingScript.addEventListener("load", () => resolveAndClearTimeout(), { once: true });
      existingScript.addEventListener("error", () => {
        existingScript.remove();
        clearTimeout(timeout);
        rejectAndReset(new Error("Failed to load Turnstile"));
      }, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = `${TURNSTILE_SCRIPT_BASE_URL}?render=explicit`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolveAndClearTimeout();
    script.onerror = () => {
      script.remove();
      clearTimeout(timeout);
      rejectAndReset(new Error("Failed to load Turnstile"));
    };
    document.head.append(script);
  });

  return turnstileScriptPromise;
}

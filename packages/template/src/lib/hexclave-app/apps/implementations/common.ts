import { InternalSession } from "@hexclave/shared/dist/sessions";
import { AsyncCache } from "@hexclave/shared/dist/utils/caches";
import { isBrowserLike } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, captureError, concatStacktraces, throwErr } from "@hexclave/shared/dist/utils/errors";
import { createGlobal, getGlobal, setGlobal } from "@hexclave/shared/dist/utils/globals";
import { filterUndefined, isRecord, omit } from "@hexclave/shared/dist/utils/objects";
import { ReactPromise, runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { use } from "@hexclave/shared/dist/utils/react";
import { Result } from "@hexclave/shared/dist/utils/results";
import { Store } from "@hexclave/shared/dist/utils/stores";
import { deindent } from "@hexclave/shared/dist/utils/strings";
import { getDefaultApiUrls } from "@hexclave/shared/dist/utils/urls";
import React, { useCallback } from "react"; // THIS_LINE_PLATFORM react-like
import { envVars } from "../../../../generated/env";
import { suspendIfSsr } from "../../../../utils/react"; // THIS_LINE_PLATFORM next react
import { HandlerUrlOptions, ResolvedHandlerUrls, hexclaveAppInternalsSymbol } from "../../common";
import { resolveHandlerUrls } from "../../url-targets";

export const clientVersion = "STACK_COMPILE_TIME_CLIENT_PACKAGE_VERSION_SENTINEL";
if (clientVersion.startsWith("STACK_COMPILE_TIME")) {
  throw new HexclaveAssertionError("Client version was not replaced. Something went wrong during build!");
}

const replaceHexclavePortPrefix = <T extends string | undefined>(input: T): T => {
  if (!input) return input;
  const prefix = envVars.HEXCLAVE_PORT_PREFIX;
  return prefix ? input.replace(/\$\{NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX:-81\}/g, prefix) as T : input;
};

const showMissingConfigAlertInBrowser = (message: string) => {
  if (!isBrowserLike()) return;

  const global = globalThis as any;
  const alertAlreadyShownKey = "__hexclave_missing_config_alert_already_shown";
  if (global[alertAlreadyShownKey]) return;
  global[alertAlreadyShownKey] = true;

  const alertFn = global.alert;
  if (typeof alertFn === "function") {
    alertFn(message);
  }
};

const throwMissingProjectIdError = (): never => {
  const message = deindent`
    Welcome to Hexclave!
    
    It seems that you haven't provided a project ID.

    ${envVars.NODE_ENV?.includes("dev") ? deindent`
      You are running this app in development mode. Make sure that your start command is wrapped in a call to the Hexclave CLI: \`npx @hexclave/cli dev --config-file <file> -- <command>\`

      Alternatively, you can also connect to a Cloud project's environment variables instead by creating a project on the Hexclave dashboard at https://app.hexclave.com and put its information in the HEXCLAVE_PROJECT_ID environment variable.
    ` : envVars.NODE_ENV?.includes("prod") ? deindent`
      It seems you are running a project in production. Please create a project on the Hexclave dashboard at https://app.hexclave.com and put it in the HEXCLAVE_PROJECT_ID environment variable.
    ` : deindent`
      - If you are running a development project and would like to connect the local Hexclave dashboard, wrap your start command in: \`npx @hexclave/cli dev --config-file <file> -- <command>\`

      - If you are running a project in production and would like to connect to Hexclave Cloud, create a project on the Hexclave dashboard at https://app.hexclave.com and put its information in the HEXCLAVE_PROJECT_ID environment variable.
    `}
  `;
  showMissingConfigAlertInBrowser(message);
  return throwErr(new Error(message));
};


export const createCache = <D extends any[], T>(fetcher: (dependencies: D) => Promise<T>) => {
  return new AsyncCache<D, Result<T>>(
    async (dependencies) => await Result.fromThrowingAsync(async () => await fetcher(dependencies)),
    {},
  );
};

export const createCacheBySession = <D extends any[], T>(fetcher: (session: InternalSession, extraDependencies: D) => Promise<T> ) => {
  return new AsyncCache<[InternalSession, ...D], Result<T>>(
    async ([session, ...extraDependencies]) => await Result.fromThrowingAsync(async () => await fetcher(session, extraDependencies)),
    {
      onSubscribe: ([session], refresh) => {
        const handler = session.onInvalidate(() => refresh());
        return () => handler.unsubscribe();
      },
    },
  );
};


type AppLike = { [hexclaveAppInternalsSymbol]: { getConstructorOptions: () => any } };
export function resolveConstructorOptions<T extends { inheritsFrom?: AppLike }>(options: T): T & { inheritsFrom?: undefined } {
  return {
    ...options.inheritsFrom?.[hexclaveAppInternalsSymbol].getConstructorOptions() ?? {},
    ...filterUndefined(omit(options, ["inheritsFrom"])),
  };
}

export function getUrls(partial: HandlerUrlOptions, options: { projectId: string }): ResolvedHandlerUrls {
  return resolveHandlerUrls({
    urls: partial,
    projectId: options.projectId,
  });
}

export function getDefaultProjectId() {
  return envVars.HEXCLAVE_PROJECT_ID || throwMissingProjectIdError();
}

export function getDefaultPublishableClientKey() {
  return envVars.HEXCLAVE_PUBLISHABLE_CLIENT_KEY;
}

export function getDefaultSecretServerKey() {
  return envVars.HEXCLAVE_SECRET_SERVER_KEY || throwErr(new Error("No secret server key provided. Please copy your key from the Hexclave dashboard and put it in the HEXCLAVE_SECRET_SERVER_KEY environment variable."));
}

export function getDefaultSuperSecretAdminKey() {
  return envVars.HEXCLAVE_SUPER_SECRET_ADMIN_KEY || throwErr(new Error("No super secret admin key provided. Please copy your key from the Hexclave dashboard and put it in the HEXCLAVE_SUPER_SECRET_ADMIN_KEY environment variable."));
}

export function getDefaultExtraRequestHeaders() {
  return JSON.parse(envVars.HEXCLAVE_EXTRA_REQUEST_HEADERS || '{}');
}

/**
 * Returns the base URL for the Stack API.
 *
 * The URL can be specified in several ways, in order of precedence:
 * 1. Directly through userSpecifiedBaseUrl parameter as string or browser/server object
 * 2. Through environment variables:
 *    - Browser: NEXT_PUBLIC_HEXCLAVE_API_URL_BROWSER/VITE_HEXCLAVE_API_URL_BROWSER
 *    - Server: HEXCLAVE_API_URL_SERVER
 *    - Default: HEXCLAVE_API_URL
 * 3. Default base URL if none of the above are specified
 *
 * The function also ensures the URL doesn't end with a trailing slash
 * by removing it if present.
 *
 * @param userSpecifiedBaseUrl - Optional URL override as string or {browser, server} object
 * @returns The configured base URL without trailing slash

 */
export function getBaseUrl(userSpecifiedBaseUrl: string | { browser: string, server: string } | undefined) {
  let url;
  if (userSpecifiedBaseUrl) {
    if (typeof userSpecifiedBaseUrl === "string") {
      url = userSpecifiedBaseUrl;
    } else {
      if (isBrowserLike()) {
        url = userSpecifiedBaseUrl.browser;
      } else {
        url = userSpecifiedBaseUrl.server;
      }
    }
  } else {
    if (isBrowserLike()) {
      url = envVars.HEXCLAVE_API_URL_BROWSER;
    } else {
      url = envVars.HEXCLAVE_API_URL_SERVER;
    }
    url = url || envVars.HEXCLAVE_API_URL || defaultBaseUrl;
  }

  return replaceHexclavePortPrefix(url.endsWith('/') ? url.slice(0, -1) : url);
}

export const defaultBaseUrl = "https://api.hexclave.com";
export const defaultAnalyticsBaseUrl = "https://r.hexclave.com";

const analyticsBaseUrlsByApiBaseUrl = new Map<string, string>([
  [defaultBaseUrl, defaultAnalyticsBaseUrl],
  ["https://api.stack-auth.com", "https://r.stack-auth.com"],
]);

export function getAnalyticsBaseUrl(regularBaseUrl: string): string {
  return analyticsBaseUrlsByApiBaseUrl.get(regularBaseUrl) ?? regularBaseUrl;
}


function fetchBackendUrlsInBackground(primaryBaseUrl: string): void {
  if (getGlobal('__stack-fetch-backend-urls-started')) {
    return;
  }
  setGlobal('__stack-fetch-backend-urls-started', true);
  runAsynchronously(async () => {
    try {
      const res = await fetch(`${primaryBaseUrl}/api/v1/internal/backend-urls`);
      if (!res.ok) {
        return;
      }
      const data: unknown = await res.json();
      if (!isRecord(data) || !Array.isArray(data.urls)) {
        return;
      }
      const urls: string[] = [];
      for (const url of data.urls) {
        if (typeof url !== 'string') return;
        urls.push(url);
      }
      createGlobal('__stack-fetched-backend-urls', () => urls);
    } catch (e) {
      captureError('fetch-backend-urls-in-background', e);
    }
  });
}

export function resolveApiUrls(userExplicitBaseUrl: string | { browser: string, server: string } | undefined): () => string[] {
  return () => {
    if (userExplicitBaseUrl != null) {
      return [getBaseUrl(userExplicitBaseUrl)];
    }
    const primary = getBaseUrl(undefined);
    // Always try to fetch server-configured URLs (supports custom domains via
    // STACK_BACKEND_URLS_CONFIG). Hardcoded fallbacks are used as a default
    // until the background fetch completes.
    fetchBackendUrlsInBackground(primary);
    return getGlobal('__stack-fetched-backend-urls') ?? getDefaultApiUrls(primary);
  };
}

export type TokenObject = {
  accessToken: string | null,
  refreshToken: string | null,
};

export function createEmptyTokenStore() {
  return new Store<TokenObject>({
    refreshToken: null,
    accessToken: null,
  });
}


// IF_PLATFORM react-like
const cachePromiseByHookId = new Map<string, ReactPromise<Result<unknown>>>();
export function useAsyncCache<D extends any[], T>(cache: AsyncCache<D, Result<T>>, dependencies: D, caller: string): T {
  // we explicitly don't want to run this hook in SSR
  // IF_PLATFORM tanstack-start
  if (!isBrowserLike()) {
    const result = use(cache.getOrWait(dependencies, "read-write"));
    if (result.status === "error") {
      throw result.error;
    }
    return result.data;
  }
  // ELSE_PLATFORM
  suspendIfSsr(caller);
  // END_PLATFORM

  // on the dashboard, we do some perf monitoring for pre-fetching which should hook right in here
  const asyncCacheHooks: any[] = getGlobal("use-async-cache-execution-hooks") ?? [];
  for (const hook of asyncCacheHooks) {
    hook({ cache, caller, dependencies });
  }

  const id = React.useId();

  // whenever the dependencies change, we need to refresh the promise cache
  React.useEffect(() => {
    cachePromiseByHookId.delete(id);
  }, [...dependencies, id]);

  const subscribe = useCallback((cb: () => void) => {
    const { unsubscribe } = cache.onStateChange(dependencies, () => {
      cachePromiseByHookId.delete(id);
      cb();
    });
    return unsubscribe;
  }, [cache, ...dependencies]);

  const getSnapshot = useCallback(() => {
    // React checks whether a promise passed to `use` is still the same as the previous one by comparing the reference.
    // If we didn't cache here, this wouldn't work because the promise would be recreated every time the value changes.
    if (!cachePromiseByHookId.has(id)) {
      cachePromiseByHookId.set(id, cache.getOrWait(dependencies, "read-write"));
    }
    return cachePromiseByHookId.get(id) as ReactPromise<Result<T>>;
  }, [cache, ...dependencies]);

  // note: we must use React.useSyncExternalStore instead of importing the function directly, as it will otherwise
  // throw an error on Next.js ("can't import useSyncExternalStore from the server")
  const promise = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );

  const result = use(promise);
  if (result.status === "error") {
    const error = result.error;
    if (error instanceof Error && !(error as any).__stackHasConcatenatedStacktraces) {
      concatStacktraces(error, new Error());
      (error as any).__stackHasConcatenatedStacktraces = true;
    }
    throw error;
  }
  return result.data;
}
// END_PLATFORM

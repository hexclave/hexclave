import { context, createContextKey } from "@opentelemetry/api";
import { loadAsyncLocalStorage, type AsyncLocalStorageLike } from "@hexclave/shared/dist/utils/async-local-storage";
import type { ErrorAttachmentInput, ErrorBreadcrumb, ErrorEventProcessor, ErrorLevel, ErrorScope, ErrorScopeData, ErrorUser } from "../interfaces/error-capture";
import { cloneErrorAttachmentInput, cloneErrorAttachmentInputs, MAX_ERROR_ATTACHMENTS } from "./error-attachments";

const ACTIVE_ERROR_SCOPE = createContextKey("hexclave.error.scope");
const MAX_BREADCRUMBS = 100;
const MAX_EVENT_PROCESSORS = 20;
let fallbackActiveErrorScope: ErrorScopeState | null = null;
let asyncLocalStorage: AsyncLocalStorageLike<ErrorScopeState> | null = null;

export type ErrorScopeState = ErrorScope & {
  snapshot: () => ErrorScopeData,
};

function assertKey(key: string, field: string): void {
  if (key.trim() === "") throw new Error(`Hexclave error scope: ${field} key must not be empty`);
}

function copyScopeData(data: ErrorScopeData | undefined): ErrorScopeData {
  if (data === undefined) return {};
  return {
    ...data.user === undefined ? {} : { user: data.user === null ? null : { ...data.user } },
    ...data.tags === undefined ? {} : { tags: { ...data.tags } },
    ...data.contexts === undefined ? {} : { contexts: Object.fromEntries(Object.entries(data.contexts).map(([key, value]) => [key, { ...value }])) },
    ...data.extra === undefined ? {} : { extra: { ...data.extra } },
    ...data.breadcrumbs === undefined ? {} : { breadcrumbs: data.breadcrumbs.slice(-MAX_BREADCRUMBS).map((breadcrumb) => ({ ...breadcrumb, ...breadcrumb.data === undefined ? {} : { data: { ...breadcrumb.data } } })) },
    ...data.level === undefined ? {} : { level: data.level },
    ...data.fingerprint === undefined ? {} : { fingerprint: [...data.fingerprint] },
    ...data.eventProcessors === undefined ? {} : { eventProcessors: data.eventProcessors.slice(-MAX_EVENT_PROCESSORS) },
    ...data.attachments === undefined ? {} : { attachments: cloneErrorAttachmentInputs(data.attachments) },
  };
}

class MutableErrorScope implements ErrorScopeState {
  private _data: ErrorScopeData;

  constructor(initial?: ErrorScopeData) {
    this._data = copyScopeData(initial);
  }

  snapshot(): ErrorScopeData {
    return copyScopeData(this._data);
  }

  setUser(user: ErrorUser | null): ErrorScope {
    this._data = { ...this._data, user: user === null ? null : { ...user } };
    return this;
  }

  setTag(key: string, value: string): ErrorScope {
    assertKey(key, "tag");
    this._data = { ...this._data, tags: { ...this._data.tags, [key]: value } };
    return this;
  }

  setTags(tags: Record<string, string>): ErrorScope {
    for (const key of Object.keys(tags)) assertKey(key, "tag");
    this._data = { ...this._data, tags: { ...this._data.tags, ...tags } };
    return this;
  }

  setContext(key: string, value: Record<string, unknown>): ErrorScope {
    assertKey(key, "context");
    this._data = { ...this._data, contexts: { ...this._data.contexts, [key]: { ...value } } };
    return this;
  }

  setExtras(extras: Record<string, unknown>): ErrorScope {
    for (const key of Object.keys(extras)) assertKey(key, "extra");
    this._data = { ...this._data, extra: { ...this._data.extra, ...extras } };
    return this;
  }

  setExtra(key: string, value: unknown): ErrorScope {
    assertKey(key, "extra");
    this._data = { ...this._data, extra: { ...this._data.extra, [key]: value } };
    return this;
  }

  addBreadcrumb(breadcrumb: ErrorBreadcrumb): ErrorScope {
    const breadcrumbs = [...this._data.breadcrumbs ?? [], {
      ...breadcrumb,
      ...breadcrumb.data === undefined ? {} : { data: { ...breadcrumb.data } },
    }];
    this._data = { ...this._data, breadcrumbs: breadcrumbs.slice(-MAX_BREADCRUMBS) };
    return this;
  }

  addEventProcessor(processor: ErrorEventProcessor): ErrorScope {
    const processors = this._data.eventProcessors ?? [];
    if (processors.length >= MAX_EVENT_PROCESSORS) {
      throw new Error(`Hexclave error scope: at most ${MAX_EVENT_PROCESSORS} event processors are allowed`);
    }
    this._data = { ...this._data, eventProcessors: [...processors, processor] };
    return this;
  }

  addAttachment(attachment: ErrorAttachmentInput): ErrorScope {
    const attachments = this._data.attachments ?? [];
    if (attachments.length >= MAX_ERROR_ATTACHMENTS) {
      throw new Error(`Hexclave error scope: at most ${MAX_ERROR_ATTACHMENTS} attachments are allowed`);
    }
    this._data = { ...this._data, attachments: [...attachments, cloneErrorAttachmentInput(attachment)] };
    return this;
  }

  clearAttachments(): ErrorScope {
    this._data = { ...this._data, attachments: [] };
    return this;
  }

  setLevel(level: ErrorLevel): ErrorScope {
    this._data = { ...this._data, level };
    return this;
  }

  setFingerprint(fingerprint: readonly string[]): ErrorScope {
    this._data = { ...this._data, fingerprint: [...fingerprint] };
    return this;
  }

  clear(): ErrorScope {
    this._data = {};
    return this;
  }
}

export function createErrorScope(initial?: ErrorScopeData): ErrorScopeState {
  return new MutableErrorScope(initial);
}

export function getActiveErrorScope(): ErrorScopeState | null {
  const value = context.active().getValue(ACTIVE_ERROR_SCOPE);
  return value instanceof MutableErrorScope ? value : asyncLocalStorage?.getStore() ?? fallbackActiveErrorScope;
}

export function runWithErrorScope<T>(scope: ErrorScopeState, fn: () => T): T {
  const scopedContext = context.active().setValue(ACTIVE_ERROR_SCOPE, scope);
  const previousFallback = fallbackActiveErrorScope;
  const restoreFallback = () => {
    if (fallbackActiveErrorScope === scope) fallbackActiveErrorScope = previousFallback;
  };
  return context.with(scopedContext, () => {
    fallbackActiveErrorScope = scope;
    try {
      const result = fn();
      restoreFallback();
      return result;
    } catch (error) {
      restoreFallback();
      throw error;
    }
  });
}

/**
 * Async counterpart used by server/framework integrations. OTel's context
 * manager is the primary authority when one is installed; Node's
 * AsyncLocalStorage is the fallback for runtimes where OTel is deliberately
 * configured as a no-op. If neither mechanism exists, the callback still runs
 * but no ambient scope is exposed: a process-global async fallback would let
 * two overlapping requests cross-contaminate.
 */
export async function runWithErrorScopeAsync<T>(scope: ErrorScopeState, fn: () => Promise<T>): Promise<T> {
  asyncLocalStorage ??= await loadAsyncLocalStorage<ErrorScopeState>("error-scope");
  const scopedContext = context.active().setValue(ACTIVE_ERROR_SCOPE, scope);
  return await context.with(scopedContext, async () => {
    return await (asyncLocalStorage?.run(scope, fn) ?? fn());
  });
}

export function mergeErrorScopeData(base: ErrorScopeData | undefined, override: ErrorScopeData | undefined): ErrorScopeData {
  const left = copyScopeData(base);
  const right = copyScopeData(override);
  return {
    ...left,
    ...right.user === undefined ? {} : { user: right.user },
    ...left.tags === undefined && right.tags === undefined ? {} : { tags: { ...left.tags, ...right.tags } },
    ...left.contexts === undefined && right.contexts === undefined ? {} : {
      contexts: Object.fromEntries([...Object.entries(left.contexts ?? {}), ...Object.entries(right.contexts ?? {})].map(([key, value]) => [key, { ...(left.contexts?.[key] ?? {}), ...value }])),
    },
    ...left.extra === undefined && right.extra === undefined ? {} : { extra: { ...left.extra, ...right.extra } },
    ...left.breadcrumbs === undefined && right.breadcrumbs === undefined ? {} : { breadcrumbs: [...left.breadcrumbs ?? [], ...right.breadcrumbs ?? []].slice(-MAX_BREADCRUMBS) },
    ...right.level === undefined ? {} : { level: right.level },
    ...right.fingerprint === undefined ? {} : { fingerprint: right.fingerprint },
    ...left.eventProcessors === undefined && right.eventProcessors === undefined ? {} : {
      eventProcessors: [...left.eventProcessors ?? [], ...right.eventProcessors ?? []].slice(0, MAX_EVENT_PROCESSORS),
    },
    ...left.attachments === undefined && right.attachments === undefined ? {} : {
      attachments: [...left.attachments ?? [], ...right.attachments ?? []].slice(-MAX_ERROR_ATTACHMENTS),
    },
  };
}

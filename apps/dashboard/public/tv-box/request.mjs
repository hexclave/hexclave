export class TvRequestTimeoutError extends Error {
  constructor() {
    super("TV display request timed out.");
    this.name = "TvRequestTimeoutError";
  }
}

/**
 * Bound the whole operation, including response-body reads. Fetch resolves when
 * headers arrive, which is too early to release a display's recovery deadline.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} operation
 * @param {number} timeoutMilliseconds
 * @param {AbortSignal | null} [parentSignal]
 * @returns {Promise<T>}
 */
export async function withTvRequestDeadline(operation, timeoutMilliseconds, parentSignal = null) {
  const getAbortReason = (signal) => signal.reason === undefined
    ? new DOMException("Aborted", "AbortError")
    : signal.reason;
  if (parentSignal?.aborted) throw getAbortReason(parentSignal);
  const controller = new AbortController();
  let timeout;
  let cancel;
  /** @type {Promise<never>} */
  const deadline = new Promise((_resolve, reject) => {
    timeout = window.setTimeout(() => {
      reject(new TvRequestTimeoutError());
      controller.abort();
    }, timeoutMilliseconds);
    cancel = () => {
      const reason = getAbortReason(parentSignal);
      reject(reason);
      controller.abort(reason);
    };
    parentSignal?.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    window.clearTimeout(timeout);
    if (cancel != null) parentSignal?.removeEventListener("abort", cancel);
  }
}

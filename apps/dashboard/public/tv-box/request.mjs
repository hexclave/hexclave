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
  if (parentSignal?.aborted) throw new DOMException("TV display request was cancelled.", "AbortError");
  const controller = new AbortController();
  let timeout;
  let cancel;
  /** @type {Promise<never>} */
  const deadline = new Promise((_resolve, reject) => {
    timeout = window.setTimeout(() => {
      reject(new Error("TV display request timed out."));
      controller.abort();
    }, timeoutMilliseconds);
    cancel = () => {
      reject(new DOMException("TV display request was cancelled.", "AbortError"));
      controller.abort();
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

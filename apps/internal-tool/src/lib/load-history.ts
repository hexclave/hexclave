export type HistoryLoadOptions = { all?: boolean, signal?: AbortSignal };

export async function loadHistory({ loadOlder, hasMoreHistory, signal }: {
  loadOlder: () => Promise<void>,
  hasMoreHistory: () => boolean,
  signal?: AbortSignal,
}): Promise<void> {
  while (hasMoreHistory() && signal?.aborted !== true) {
    await loadOlder();
  }
}

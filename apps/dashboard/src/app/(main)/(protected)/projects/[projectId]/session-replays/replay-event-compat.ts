import { EventType, IncrementalSource, type eventWithTime } from "@rrweb/types";

// Fallback viewport for recordings that carry no sizing information at all.
// Distorted-but-visible playback beats a blank frame; a later real Meta event
// (subsequent segments usually have one) corrects the size mid-playback.
export const FALLBACK_REPLAY_VIEWPORT = { width: 1280, height: 720 } as const;

/**
 * Repairs recordings whose first FullSnapshot has no Meta event before it, by
 * inserting a synthetic Meta in place. Returns whether a repair happened.
 *
 * SDK builds before the rotation-gate fix dropped the Meta event that rrweb
 * emits immediately before every FullSnapshot (the gate only let type 2
 * through while a rotated segment waited for its fresh snapshot). The rrweb
 * Replayer keeps its iframe at `display: none` until the first Meta sizes it,
 * so those segments play back as a blank white frame — and a first chunk that
 * contains only the bare FullSnapshot even crashes the Replayer constructor
 * ("Replayer need at least 2 events"). Recorded data can't be fixed
 * server-side, so the player repairs the event list instead. Dimensions come
 * from the recording's own ViewportResize events when available, else a
 * generic fallback.
 *
 * Idempotent over the accumulated per-tab event list: once a Meta exists at or
 * before the first FullSnapshot (synthetic or real), this is a no-op — so it
 * is safe to call after every appended chunk.
 */
export function ensureMetaBeforeFirstFullSnapshot(events: eventWithTime[]): boolean {
  const firstSnapshotIndex = events.findIndex((event) => event.type === EventType.FullSnapshot);
  if (firstSnapshotIndex === -1) return false;
  const hasMetaBeforeSnapshot = events
    .slice(0, firstSnapshotIndex)
    .some((event) => event.type === EventType.Meta);
  if (hasMetaBeforeSnapshot) return false;

  let width: number = FALLBACK_REPLAY_VIEWPORT.width;
  let height: number = FALLBACK_REPLAY_VIEWPORT.height;
  for (const event of events) {
    if (event.type !== EventType.IncrementalSnapshot) continue;
    if (event.data.source !== IncrementalSource.ViewportResize) continue;
    width = event.data.width;
    height = event.data.height;
    break;
  }

  const snapshot = events[firstSnapshotIndex];
  events.splice(firstSnapshotIndex, 0, {
    type: EventType.Meta,
    // The recorded page URL is unrecoverable; the Replayer only reads href for
    // resolving relative URLs, where an empty base falls back to the document.
    data: { href: "", width, height },
    timestamp: snapshot.timestamp,
  });
  return true;
}

import { listGrowthActions } from "@/lib/growth/growth-api";
import type { GrowthActionItem } from "@/lib/growth/growth-types";

/**
 * The actions endpoint is cursor-paginated at 50 rows by default. Experiments promises the complete
 * active set, so keep following cursors instead of turning an API page boundary into an invisible UI
 * limit. Repeated cursors are rejected loudly because continuing would otherwise loop forever.
 */
export async function listAllActiveGrowthExperiments(app: object): Promise<GrowthActionItem[]> {
  const items: GrowthActionItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await listGrowthActions(app, { status: "active", cursor });
    items.push(...page.items);
    if (page.nextCursor == null) return items;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(`The active experiments endpoint repeated cursor "${page.nextCursor}".`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
}

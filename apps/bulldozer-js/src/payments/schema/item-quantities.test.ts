import { describe, expect, it } from "vitest";
import type { PiledriverObject } from "../../databases/piledriver/index.js";
import { createPaymentsSchema, itemQuantitiesLedgerUpperBoundAsOf, splitItemQuantityChangeWithExpiry } from "./index.js";
import { asRecord, balanceAt, collect, customerGroup, initializedSnapshot, MONTH_MS, product, rowsBySortKey, set, subscription, type Snapshot } from "./schema-test-helpers.js";

// Item-quantities parity suite: restores the ledger coverage from the retired bulldozer-server
// payments tests, driven through the real payments schema.
//
// Ledger model (consumption total): each item tracks its live grants (each with a quantity and an
// expiry), one reassigning `consumption` total (covered removals, always distributed soonest-
// expiring-first), and frozen `debt` (removals that had no grant to land on, baked into the first
// grant to arrive and never reassigned). A removal rides the soonest-expiring grant and reassigns to
// sooner grants that arrive later; a grant's share of consumption settles (disappears) when it
// expires. Every case below spells out its timeline and expected balances at specific times.

const DAY_MS = 86_400_000;

type ManualChange = {
  id: string,
  tenancyId: string,
  customerId: string,
  customerType: "user",
  itemId: string,
  quantity: number,
  description: null,
  expiresAtMillis: number | null,
  createdAtMillis: number,
};
const manualChange = (id: string, customerId: string, itemId: string, quantity: number, createdAtMillis: number, expiresAtMillis: number | null): ManualChange => ({
  id, tenancyId: "t1", customerId, customerType: "user", itemId, quantity, description: null, expiresAtMillis, createdAtMillis,
});
const setManualChange = async (snapshot: Snapshot, change: ManualChange) => {
  const schema = createPaymentsSchema();
  return await set(snapshot, schema.manualItemQuantityChanges, change.id, change as unknown as PiledriverObject);
};

describe("item quantities: ledger semantics", () => {
  it("keeps a grant with no expiry indefinitely", async () => {
    /*
     * t=1000  +100 coins (no expiry)
     *
     * Expected coins:
     *   t=1000       -> 100
     *   t=9,999,999  -> 100   (a grant with no expiry stays forever)
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("g", "u", "coins", 100, 1000, null));
    expect(await balanceAt(snapshot, customerGroup("u"), "coins", 1000)).toBe(100);
    expect(await balanceAt(snapshot, customerGroup("u"), "coins", 9_999_999)).toBe(100);
  });

  it("consumes a removal from the soonest-expiring grant first, then expires only what remains", async () => {
    /*
     * t=1000  +20 coins, expires at 3000   (grant A)
     * t=1000  +10 coins, expires at 5000   (grant B)
     * t=2000  -8 coins                     (consumption)
     *
     * The -8 comes out of the soonest-expiring grant first, so A drops 20 -> 12.
     *
     * Expected coins:
     *   t=2000  -> 22   (12 left in A + 10 in B)
     *   t=3100  -> 10   A expires; only its *remaining* 12 drops, leaving B's 10
     *   t=5100  -> 0    B expires
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("gA", "u", "coins", 20, 1000, 3000));
    snapshot = await setManualChange(snapshot, manualChange("gB", "u", "coins", 10, 1000, 5000));
    snapshot = await setManualChange(snapshot, manualChange("rem", "u", "coins", -8, 2000, null));
    const g = customerGroup("u");
    expect(await balanceAt(snapshot, g, "coins", 2000)).toBe(22);
    expect(await balanceAt(snapshot, g, "coins", 3100)).toBe(10);
    expect(await balanceAt(snapshot, g, "coins", 5100)).toBe(0);
  });

  it("applies a grant expiry and a later removal together", async () => {
    /*
     * t=1000  +20 coins, expires at 3000   (grant A)
     * t=1000  +10 coins, expires at 5000   (grant B)
     * t=3500  -8 coins                     (consumption, after A has already expired)
     *
     * Expected coins:
     *   t=2000  -> 30   both grants live
     *   t=3100  -> 10   A's full 20 expires (nothing was consumed from it)
     *   t=3600  -> 2    the -8 hits B (10 -> 2)
     *   t=5100  -> 0    B expires its remaining 2
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("gA", "u", "coins", 20, 1000, 3000));
    snapshot = await setManualChange(snapshot, manualChange("gB", "u", "coins", 10, 1000, 5000));
    snapshot = await setManualChange(snapshot, manualChange("rem", "u", "coins", -8, 3500, null));
    const g = customerGroup("u");
    expect(await balanceAt(snapshot, g, "coins", 2000)).toBe(30);
    expect(await balanceAt(snapshot, g, "coins", 3100)).toBe(10);
    expect(await balanceAt(snapshot, g, "coins", 3600)).toBe(2);
    expect(await balanceAt(snapshot, g, "coins", 5100)).toBe(0);
  });

  it("treats a removal as permanent (never reverses)", async () => {
    /*
     * t=1000  +100 coins (no expiry)
     * t=2000  -30 coins
     *
     * Expected coins:
     *   t=2500       -> 70
     *   t=9,999,999  -> 70   (removals don't come back later)
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("g", "u", "coins", 100, 1000, null));
    snapshot = await setManualChange(snapshot, manualChange("rem", "u", "coins", -30, 2000, null));
    const g = customerGroup("u");
    expect(await balanceAt(snapshot, g, "coins", 2500)).toBe(70);
    expect(await balanceAt(snapshot, g, "coins", 9_999_999)).toBe(70);
  });

  it("tracks multiple items independently", async () => {
    /*
     * t=1000  +100 coins (no expiry)
     * t=1000  +50 gems, expires at 5000
     * t=2000  -20 coins
     * t=2000  +20 gems (no expiry)
     *
     * Checked at t=2500 (before the gems grant expires) so the two items line up.
     * Expected:  coins -> 80,  gems -> 70   (neither item affects the other)
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("c1", "u", "coins", 100, 1000, null));
    snapshot = await setManualChange(snapshot, manualChange("g1", "u", "gems", 50, 1000, 5000));
    snapshot = await setManualChange(snapshot, manualChange("c2", "u", "coins", -20, 2000, null));
    snapshot = await setManualChange(snapshot, manualChange("g2", "u", "gems", 20, 2000, null));
    const g = customerGroup("u");
    expect(await balanceAt(snapshot, g, "coins", 2500)).toBe(80);
    expect(await balanceAt(snapshot, g, "gems", 2500)).toBe(70);
  });

  it("expires a grant with no removals", async () => {
    /*
     * t=1000  +50 coins, expires at 3000
     * t=1000  +30 coins (no expiry)
     *
     * Expected coins:
     *   t=2000 -> 80
     *   t=3100 -> 30   (the expiring grant is gone, the permanent one stays)
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("gExp", "u", "coins", 50, 1000, 3000));
    snapshot = await setManualChange(snapshot, manualChange("gPerm", "u", "coins", 30, 1000, null));
    const g = customerGroup("u");
    expect(await balanceAt(snapshot, g, "coins", 2000)).toBe(80);
    expect(await balanceAt(snapshot, g, "coins", 3100)).toBe(30);
  });

  it("lets a removal push the balance negative (debt)", async () => {
    /*
     * t=1000  +10 coins
     * t=2000  -25 coins
     *
     * Expected coins:  t=2500 -> -15   (a removal is allowed to overdraw into debt)
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("g", "u", "coins", 10, 1000, null));
    snapshot = await setManualChange(snapshot, manualChange("rem", "u", "coins", -25, 2000, null));
    expect(await balanceAt(snapshot, customerGroup("u"), "coins", 2500)).toBe(-15);
  });

  it("nets a sequence that dips negative before recovering", async () => {
    /*
     * t=1000  +10 coins
     * t=2000  -25 coins   (running total would be -15 here)
     * t=3000  +20 coins
     *
     * All three are non-expiring, so bulldozer merges them into one summed entry — only the final
     * net is observable, which is exactly what we assert here.
     * Expected coins:  net -> 5
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("g1", "u", "coins", 10, 1000, null));
    snapshot = await setManualChange(snapshot, manualChange("rem", "u", "coins", -25, 2000, null));
    snapshot = await setManualChange(snapshot, manualChange("g2", "u", "coins", 20, 3000, null));
    expect(await balanceAt(snapshot, customerGroup("u"), "coins", 9_999_999)).toBe(5);
  });

  it("handles the worked example: net grant/refill/removals then an expiry no-op", async () => {
    /*
     * t=0  +50 credits, expires at 1000
     * t=1  +30 credits
     * t=2  -40 credits
     * t=3  -60 credits
     * t=4  +25 credits
     *
     * The removals consume the soonest-expiring grant first, so they drain the 50@1000 grant to
     * nothing by t=3; the leftover debt is absorbed by the +25 into the permanent bucket.
     *
     * Expected credits:
     *   t=500   -> 5   before the grant's expiry time
     *   t=1001  -> 5   the 50@1000 grant is already fully consumed, so its expiry removes nothing
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("t0", "u", "credits", 50, 0, 1000));
    snapshot = await setManualChange(snapshot, manualChange("t1", "u", "credits", 30, 1, null));
    snapshot = await setManualChange(snapshot, manualChange("t2", "u", "credits", -40, 2, null));
    snapshot = await setManualChange(snapshot, manualChange("t3", "u", "credits", -60, 3, null));
    snapshot = await setManualChange(snapshot, manualChange("t4", "u", "credits", 25, 4, null));
    const g = customerGroup("u");
    expect(await balanceAt(snapshot, g, "credits", 500)).toBe(5);
    expect(await balanceAt(snapshot, g, "credits", 1001)).toBe(5);
  });

  it("handles multiple expiring grants plus a removal", async () => {
    /*
     * t=1000  +30 coins, expires at 2000   (early grant)
     * t=1000  +50 coins, expires at 4000   (late grant)
     * t=1500  -10 coins                    (consumption)
     *
     * The -10 consumes the soonest-expiring grant (early: 30 -> 20).
     *
     * Expected coins:
     *   t=1500 -> 70   (20 in early + 50 in late)
     *   t=2100 -> 50   early grant expires its remaining 20
     *   t=4100 -> 0    late grant expires
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("gEarly", "u", "coins", 30, 1000, 2000));
    snapshot = await setManualChange(snapshot, manualChange("gLate", "u", "coins", 50, 1000, 4000));
    snapshot = await setManualChange(snapshot, manualChange("rem", "u", "coins", -10, 1500, null));
    const g = customerGroup("u");
    expect(await balanceAt(snapshot, g, "coins", 1500)).toBe(70);
    expect(await balanceAt(snapshot, g, "coins", 2100)).toBe(50);
    expect(await balanceAt(snapshot, g, "coins", 4100)).toBe(0);
  });

  it("answers point-in-time queries across staggered expiries", async () => {
    /*
     * t=1000  +10 coins, expires at 2000
     * t=1000  +20 coins, expires at 3000
     * t=1000  +30 coins, expires at 4000
     *
     * Nothing is consumed, so each grant expires its full amount — this path is unaffected by the
     * regression and just checks the balance at several points as grants drop off one by one.
     *
     * Expected coins:
     *   t=1500 -> 60
     *   t=2100 -> 50   (first grant expired)
     *   t=3100 -> 30   (second expired)
     *   t=4100 -> 0    (third expired)
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("g1", "u", "coins", 10, 1000, 2000));
    snapshot = await setManualChange(snapshot, manualChange("g2", "u", "coins", 20, 1000, 3000));
    snapshot = await setManualChange(snapshot, manualChange("g3", "u", "coins", 30, 1000, 4000));
    const g = customerGroup("u");
    expect(await balanceAt(snapshot, g, "coins", 1500)).toBe(60);
    expect(await balanceAt(snapshot, g, "coins", 2100)).toBe(50);
    expect(await balanceAt(snapshot, g, "coins", 3100)).toBe(30);
    expect(await balanceAt(snapshot, g, "coins", 4100)).toBe(0);
  });
});

describe("item quantities: reassignment and frozen debt", () => {
  it("reassigns a removal to a later grant that expires sooner, then settles it on that grant's expiry", async () => {
    /*
     * coins timeline:
     *   t=1000  +10 coins, expires at 10000   (grant g1)
     *   t=2000  -5 coins                       (removal r1 — only g1 exists, so it rides g1)
     *   t=3000  +10 coins, expires at 8000    (grant g2, expires sooner than g1)
     *   t=4000  +10 coins, expires at 6000    (grant g3, expires soonest)
     *
     * A removal always rides the soonest-expiring live grant, so r1 reassigns g1 -> g2 -> g3 as the
     * sooner grants arrive. When g3 expires it settles r1 (its 5 disappears with g3); g2 and g1 then
     * expire untouched.
     *
     * Expected coins:
     *   t=5000  -> 25   (30 granted - 5 consumed; nothing expired yet)
     *   t=6001  -> 20   g3 expires and takes r1's 5 with it (NOT 15, which is what leaving r1 on g1 gives)
     *   t=8001  -> 10   g2 expires untouched
     *   t=10001 -> 0    g1 expires untouched
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("g1", "u", "coins", 10, 1000, 10000));
    snapshot = await setManualChange(snapshot, manualChange("r1", "u", "coins", -5, 2000, null));
    snapshot = await setManualChange(snapshot, manualChange("g2", "u", "coins", 10, 3000, 8000));
    snapshot = await setManualChange(snapshot, manualChange("g3", "u", "coins", 10, 4000, 6000));
    const g = customerGroup("u");
    expect(await balanceAt(snapshot, g, "coins", 5000)).toBe(25);
    expect(await balanceAt(snapshot, g, "coins", 6001)).toBe(20);
    expect(await balanceAt(snapshot, g, "coins", 8001)).toBe(10);
    expect(await balanceAt(snapshot, g, "coins", 10001)).toBe(0);
  });

  it("freezes debt onto the first grant to arrive and never reassigns it to a later, sooner-expiring grant", async () => {
    /*
     * coins timeline:
     *   t=1000  -10 coins             (removal with no grant yet -> becomes debt)
     *   t=2000  +10 coins (no expiry) (the first grant to arrive absorbs the debt -> frozen)
     *   t=3000  +10 coins, expires at 5000 (a later, sooner-expiring grant)
     *
     * Debt "can't look into the future": it sticks to the permanent grant that first covered it and
     * does NOT jump to the sooner-expiring grant. So when the expiring grant drops at 5000 it takes
     * nothing with it.
     *
     * Expected coins:
     *   t=2500  -> 0    (-10 debt fully absorbed by the +10 permanent grant)
     *   t=3500  -> 10   (the expiring grant adds 10)
     *   t=5001  -> 0    the expiring grant expires untouched (10 -> 0). If the debt had reassigned
     *                   here, the permanent grant would still hold 10 and this would read 10.
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("r1", "u", "coins", -10, 1000, null));
    snapshot = await setManualChange(snapshot, manualChange("gPerm", "u", "coins", 10, 2000, null));
    snapshot = await setManualChange(snapshot, manualChange("gExp", "u", "coins", 10, 3000, 5000));
    const g = customerGroup("u");
    expect(await balanceAt(snapshot, g, "coins", 2500)).toBe(0);
    expect(await balanceAt(snapshot, g, "coins", 3500)).toBe(10);
    expect(await balanceAt(snapshot, g, "coins", 5001)).toBe(0);
  });
});

describe("item quantities: split algorithm (expiring grants)", () => {
  // A grant with an absolute expiry is stored as the grant row (carrying a grantId and its expiry)
  // plus a zero-quantity *expire marker* at the expiry time that references that same grantId — so
  // expiry drops that specific grant's remaining rather than being a blind negative deduction.
  // splitChanges isn't stored in time order, so we sort by (effective time, then expiry).
  const splitRows = (entries: PiledriverObject[]) => {
    return entries
      .flatMap(splitItemQuantityChangeWithExpiry)
      .map(asRecord)
      .map(row => ({ quantity: Number(row.quantity), at: Number(row.txnEffectiveAtMillis), expiresAtMillis: row.expiresAtMillis, grantId: row.grantId ?? null, expireGrantId: row.expireGrantId ?? null }))
      .sort((a, b) => a.at - b.at || Number(a.expiresAtMillis ?? Infinity) - Number(b.expiresAtMillis ?? Infinity));
  };
  const itemChange = (id: string, quantity: number, at: number, expiresWhen: number | null, compacted = false): PiledriverObject => ({
    type: compacted ? "compacted-item-quantity-change" : "item-quantity-change",
    index: 0,
    txnId: `miqc:${id}`,
    txnEffectiveAtMillis: at,
    customerType: "user",
    customerId: "u",
    tenancyId: "t1",
    itemId: "coins",
    quantity,
    expiresWhen,
  });

  it("passes a non-expiring grant through as a single permanent row", async () => {
    /*
     * t=1000  +10 coins (no expiry)  ->  one row: +10 at 1000, no expiry, no expire marker.
     * A non-expiring grant is compacted, so it carries no grantId (nothing will ever expire it).
     */
    expect(splitRows([itemChange("g", 10, 1000, null, true)])).toEqual([{ quantity: 10, at: 1000, expiresAtMillis: null, grantId: null, expireGrantId: null }]);
  });

  it("splits an absolute-expiry grant into a grant row and a zero-quantity expire marker for that grant", async () => {
    /*
     * t=1000  +10 coins, expires at 5000
     *   ->  +10 at 1000 (exp 5000, grantId G),  then  an expire marker at 5000 targeting grant G
     */
    expect(splitRows([itemChange("g", 10, 1000, 5000)])).toEqual([
      { quantity: 10, at: 1000, expiresAtMillis: 5000, grantId: "miqc:g:0", expireGrantId: null },
      { quantity: 0, at: 5000, expiresAtMillis: null, grantId: null, expireGrantId: "miqc:g:0" },
    ]);
  });

  it("produces one grant + one expire marker per grant for staggered expiries of the same item", async () => {
    /*
     * t=100  +2 coins, expires at 200  (grant gA)
     * t=100  +3 coins, expires at 300  (grant gB)
     *   ->  the two grants, then an expire marker at 200 for gA and at 300 for gB
     */
    expect(splitRows([
      itemChange("gA", 2, 100, 200),
      itemChange("gB", 3, 100, 300),
    ])).toEqual([
      { quantity: 2, at: 100, expiresAtMillis: 200, grantId: "miqc:gA:0", expireGrantId: null },
      { quantity: 3, at: 100, expiresAtMillis: 300, grantId: "miqc:gB:0", expireGrantId: null },
      { quantity: 0, at: 200, expiresAtMillis: null, grantId: null, expireGrantId: "miqc:gA:0" },
      { quantity: 0, at: 300, expiresAtMillis: null, grantId: null, expireGrantId: "miqc:gB:0" },
    ]);
  });
});

describe("item quantities: compaction", () => {
  it("preserves the earliest row's txnEffectiveAtMillis in the compacted entry", async () => {
    /*
     * t=1000  +5 credits
     * t=2000  +7 credits
     *
     * The two non-expiring changes merge into one compacted entry of 12, stamped with the earliest
     * effective time (1000), not the last.
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("first", "u", "credits", 5, 1000, null));
    snapshot = await setManualChange(snapshot, manualChange("second", "u", "credits", 7, 2000, null));
    const compacted = (await rowsBySortKey(snapshot, schema.compactedItemQuantityChangeEntries, customerGroup("u"))).map(row => asRecord(row.rowData));
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({ type: "compacted-item-quantity-change", itemId: "credits", quantity: 12 });
    expect(Number(compacted[0].txnEffectiveAtMillis)).toBe(1000);
  });
});

describe("item quantities: compaction never merges across a grant arrival", () => {
  // The sign-split compaction merges same-sign non-expiring changes and restamps the merged change
  // at the earliest member's time. If it merged across a grant arrival (or any event that changes
  // the live-grant set), it would move the change relative to that grant and flip the ledger's
  // debt-vs-consumption split — permanently losing or gaining units. Grant arrivals must be walls.
  it("does not merge two spends across a grant arrival, preserving the final balance", async () => {
    /*
     * t=1  -1  coins (spend; becomes debt — no grant yet)
     * t=2  +10 coins (permanent top-up)
     * t=3  +10 coins, expires at 50 (expiring grant)
     * t=4  -10 coins (spend; rides the soonest-expiring grant = the expiring one, and settles when it
     *                 expires, so the permanent grant keeps its balance)
     *
     * Net grants - removals = 20 - 11 = 9. If the two spends (-1 and -10) were merged back to t=1
     * (before any grant), the combined -11 debt would zero the permanent grant and spill onto the
     * expiring grant, which then leaks 9 at t=50 -> a wrong final balance of 0. With grant arrivals
     * as boundaries they stay separate and the balance is correct throughout.
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("r0", "u", "coins", -1, 1, null));
    snapshot = await setManualChange(snapshot, manualChange("gp", "u", "coins", 10, 2, null));
    snapshot = await setManualChange(snapshot, manualChange("ge", "u", "coins", 10, 3, 50));
    snapshot = await setManualChange(snapshot, manualChange("r1", "u", "coins", -10, 4, null));
    const g = customerGroup("u");
    // Point-in-time (each step is exact, not collapsed to the earliest spend's time):
    expect(await balanceAt(snapshot, g, "coins", 2)).toBe(9); // -1 debt absorbed by +10 -> 9
    expect(await balanceAt(snapshot, g, "coins", 3)).toBe(19); // expiring +10 -> 19
    expect(await balanceAt(snapshot, g, "coins", 5)).toBe(9); // -10 rides the expiring grant -> 9
    // Final / as-of-now, after the expiring grant is gone: the permanent grant retains 9.
    expect(await balanceAt(snapshot, g, "coins", 51)).toBe(9);
  });

  it("keeps two spends separated by an expiring grant as distinct compacted entries", async () => {
    /*
     * t=1  -3 coins (spend)
     * t=2  +5 coins, expires at 100 (expiring grant -> a boundary at its arrival)
     * t=3  -4 coins (spend)
     *
     * The two spends must NOT merge into a single -7 entry, because the grant arrives between them.
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("r1", "u", "coins", -3, 1, null));
    snapshot = await setManualChange(snapshot, manualChange("ge", "u", "coins", 5, 2, 100));
    snapshot = await setManualChange(snapshot, manualChange("r2", "u", "coins", -4, 3, null));
    const compacted = (await rowsBySortKey(snapshot, schema.compactedItemQuantityChangeEntries, customerGroup("u"))).map(row => asRecord(row.rowData));
    // The expiring grant is non-compactable (passes through separately), so only the two spends show
    // up here — and they stay separate.
    const quantities = compacted.map(row => Number(row.quantity)).sort((a, b) => a - b);
    expect(quantities).toEqual([-4, -3]);
  });

  it("still merges a contiguous run of same-sign changes with nothing between them", async () => {
    /*
     * t=1  -3 coins
     * t=2  -4 coins
     *
     * Nothing changes the live-grant set between the two spends, so they still compact into one -7
     * entry (the perf win is preserved).
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("r1", "u", "coins", -3, 1, null));
    snapshot = await setManualChange(snapshot, manualChange("r2", "u", "coins", -4, 2, null));
    const compacted = (await rowsBySortKey(snapshot, schema.compactedItemQuantityChangeEntries, customerGroup("u"))).map(row => asRecord(row.rowData));
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({ type: "compacted-item-quantity-change", itemId: "coins", quantity: -7 });
    expect(Number(compacted[0].txnEffectiveAtMillis)).toBe(1);
  });
});

describe("item quantities: full-pipeline integration", () => {
  const setOtp = async (snapshot: Snapshot, id: string, customerId: string, productId: string, includedItems: Parameters<typeof product>[0], quantity: number, createdAtMillis: number) => {
    const schema = createPaymentsSchema();
    return await set(snapshot, schema.oneTimePurchases, id, {
      id,
      tenancyId: "t1",
      customerId,
      customerType: "user",
      productId,
      priceId: "p1",
      product: product(includedItems),
      quantity,
      stripePaymentIntentId: null,
      revokedAtMillis: null,
      refundedAtMillis: null,
      creationSource: "TEST_MODE",
      createdAtMillis,
    });
  };

  it("consumes a manual change against a subscription grant, leaving other items untouched", async () => {
    /*
     * t=1000  buy a one-time purchase: 100 coins x2 = 200 coins (no expiry)
     * t=2000  a subscription grants 500 credits (no expiry)
     * t=2500  -50 credits
     *
     * Expected at t=3000:  credits -> 450,  coins -> 200 (untouched)
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await setOtp(snapshot, "otp-coins", "u1", "prod-coins", { coins: { quantity: 100, expires: "never" } }, 2, 1000);
    snapshot = await set(snapshot, schema.subscriptions, "sub-pro", subscription("sub-pro", {
      customerId: "u1",
      productId: "prod-pro",
      product: product({ credits: { quantity: 500, expires: "never" } }),
      createdAtMillis: 2000,
    }) as unknown as PiledriverObject);
    snapshot = await setManualChange(snapshot, manualChange("consume", "u1", "credits", -50, 2500, null));
    const g = customerGroup("u1");
    expect(await balanceAt(snapshot, g, "credits", 3000)).toBe(450);
    expect(await balanceAt(snapshot, g, "coins", 3000)).toBe(200);
  });

  it("isolates item balances per customer", async () => {
    /*
     * t=10000  customer A buys 100 gems;  customer B buys 50 gems
     * t=11000  customer A spends -30 gems
     *
     * Expected at t=12000:  A -> 70,  B -> 50   (B is not affected by A's spend)
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setOtp(snapshot, "otp-a", "u-a", "prod-iso", { gems: { quantity: 100, expires: "never" } }, 1, 10000);
    snapshot = await setOtp(snapshot, "otp-b", "u-b", "prod-iso", { gems: { quantity: 50, expires: "never" } }, 1, 10000);
    snapshot = await setManualChange(snapshot, manualChange("burn-a", "u-a", "gems", -30, 11000, null));
    expect(await balanceAt(snapshot, customerGroup("u-a"), "gems", 12000)).toBe(70);
    expect(await balanceAt(snapshot, customerGroup("u-b"), "gems", 12000)).toBe(50);
  });

  it("nets owned-product quantity after a partial revocation", async () => {
    /*
     * t=20000  one-time purchase #1 of prod-complex (qty 1)
     * t=21000  one-time purchase #2 of prod-complex (qty 1)
     * t=22000  a refund revokes exactly purchase #1
     *
     * Expected owned quantity of prod-complex: 1  (not 0, not 2)
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await setOtp(snapshot, "otp-complex-1", "u-complex", "prod-complex", {}, 1, 20000);
    snapshot = await setOtp(snapshot, "otp-complex-2", "u-complex", "prod-complex", {}, 1, 21000);
    snapshot = await set(snapshot, schema.manualTransactions, "refund-complex", {
      txnId: "refund:otp-complex-1",
      tenancyId: "t1",
      effectiveAtMillis: 22000,
      type: "refund",
      entries: [{
        type: "product-revocation",
        customerType: "user",
        customerId: "u-complex",
        adjustedTransactionId: "otp:otp-complex-1",
        adjustedEntryIndex: 0,
        quantity: 1,
        productId: "prod-complex",
        productLineId: "line-main",
      }],
      customerType: "user",
      customerId: "u-complex",
      paymentProvider: "test_mode",
      createdAtMillis: 22000,
      renewalTargetSubscriptionId: null,
    });
    const owned = asRecord((await rowsBySortKey(snapshot, schema.ownedProducts, customerGroup("u-complex"))).at(-1)?.rowData ?? null);
    expect(asRecord(asRecord(owned.ownedProducts)["prod-complex"]).quantity).toBe(1);
  });

  it("handles consumption + staggered when-purchase-expires expiry across two subscriptions", async () => {
    /*
     * Two subscriptions grant the same item, each expiring when its purchase ends.
     *   grant A: 100 energy, subscription ends day 10
     *   grant B: 200 energy, subscription ends day 30
     * day 5:  -40 energy  (consumed from grant A, which was granted first)
     *
     * Expected energy:
     *   day 5       -> 260   (60 in A + 200 in B)
     *   day 10 + 1  -> 200   A expires its remaining 60
     *   day 30 + 1  -> 0     B expires
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.subscriptions, "sub-a", subscription("sub-a", {
      customerId: "u-energy",
      productId: "prod-a",
      product: product({ energy: { quantity: 100, expires: "when-purchase-expires" } }),
      status: "canceled",
      cancelAtPeriodEnd: true,
      canceledAtMillis: 5 * DAY_MS,
      endedAtMillis: 10 * DAY_MS,
      currentPeriodEndMillis: MONTH_MS,
      createdAtMillis: 0,
    }) as unknown as PiledriverObject);
    snapshot = await set(snapshot, schema.subscriptions, "sub-b", subscription("sub-b", {
      customerId: "u-energy",
      productId: "prod-b",
      product: product({ energy: { quantity: 200, expires: "when-purchase-expires" } }),
      status: "canceled",
      cancelAtPeriodEnd: true,
      canceledAtMillis: 15 * DAY_MS,
      endedAtMillis: 30 * DAY_MS,
      currentPeriodStartMillis: 1000,
      currentPeriodEndMillis: 1000 + MONTH_MS,
      createdAtMillis: 1000,
    }) as unknown as PiledriverObject);
    snapshot = await setManualChange(snapshot, manualChange("consume", "u-energy", "energy", -40, 5 * DAY_MS, null));
    const g = customerGroup("u-energy");
    expect(await balanceAt(snapshot, g, "energy", 5 * DAY_MS)).toBe(260);
    expect(await balanceAt(snapshot, g, "energy", 10 * DAY_MS + 1)).toBe(200);
    expect(await balanceAt(snapshot, g, "energy", 30 * DAY_MS + 1)).toBe(0);
  });

  it("does not stack when-repeated balances across a mid-period upgrade", async () => {
    /*
     * A "when-repeated" allowance must not carry over when the customer upgrades.
     *   free sub: 100 emails/month, ends day 10
     *   team sub: 500 emails/month, starts day 11
     * We tick past day 10 so the free grant expires before the upgrade lands.
     *
     * Expected emails right after the upgrade (day 11): 500, not 600.
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.subscriptions, "sub-free", subscription("sub-free", {
      customerId: "u-upgrade",
      productId: "prod-free",
      product: product({ emails: { quantity: 100, repeat: [1, "month"], expires: "when-repeated" } }),
      status: "canceled",
      canceledAtMillis: 10 * DAY_MS,
      endedAtMillis: 10 * DAY_MS,
      currentPeriodEndMillis: MONTH_MS,
      createdAtMillis: 0,
    }) as unknown as PiledriverObject);
    snapshot = await set(snapshot, schema.subscriptions, "sub-team", subscription("sub-team", {
      customerId: "u-upgrade",
      productId: "prod-team",
      product: product({ emails: { quantity: 500, repeat: [1, "month"], expires: "when-repeated" } }),
      status: "canceled",
      cancelAtPeriodEnd: true,
      canceledAtMillis: 20 * DAY_MS,
      endedAtMillis: 20 * DAY_MS,
      currentPeriodStartMillis: 11 * DAY_MS,
      currentPeriodEndMillis: 11 * DAY_MS + MONTH_MS,
      createdAtMillis: 11 * DAY_MS,
    }) as unknown as PiledriverObject);
    snapshot = (await snapshot.tick(new Date(11 * DAY_MS))).newSnapshot;
    expect(await balanceAt(snapshot, customerGroup("u-upgrade"), "emails", 11 * DAY_MS)).toBe(500);
  });

  it("ranks a resetting (when-repeated) grant ahead of a later-expiring grant so a removal rides the reset", async () => {
    /*
     * The stamped expiry lets a removal prefer a monthly-resetting grant over a grant that expires
     * later, even though the resetting grant reaches the ledger as a "when-repeated" string.
     *   t=0        subscription grants 100 emails/month (when-repeated; first reset at 1 month)
     *   t=1000     manual +100 emails, absolute expiry at 3 months (expires AFTER the reset)
     *   t=2000     -30 emails  (rides the resetting grant, which expires soonest)
     *   tick to 1 month: the resetting grant expires and re-grants 100.
     *
     * Because the -30 rode the resetting grant, it settles when that grant resets; the manual grant
     * keeps its full 100. Right after the reset: 100 (manual) + 100 (fresh reset) = 200.
     * If the removal had instead lingered on the manual grant (no stamped expiry), this would read 170.
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.subscriptions, "sub-reset", subscription("sub-reset", {
      customerId: "u-reset",
      productId: "prod-reset",
      product: product({ emails: { quantity: 100, repeat: [1, "month"], expires: "when-repeated" } }),
      currentPeriodEndMillis: 12 * MONTH_MS,
      createdAtMillis: 0,
    }) as unknown as PiledriverObject);
    snapshot = await setManualChange(snapshot, manualChange("manual-later", "u-reset", "emails", 100, 1000, 3 * MONTH_MS));
    snapshot = await setManualChange(snapshot, manualChange("spend", "u-reset", "emails", -30, 2000, null));
    const g = customerGroup("u-reset");
    expect(await balanceAt(snapshot, g, "emails", 5000)).toBe(170); // 100 + 100 - 30 before the reset
    // The first monthly reset off the epoch anchor is 1970-02-01 (calendar-anchored, not 30 days),
    // still well before the manual grant's 3-month absolute expiry, so the reset ranks soonest.
    const firstResetMillis = Date.UTC(1970, 1, 1);
    snapshot = (await snapshot.tick(new Date(firstResetMillis))).newSnapshot;
    expect(await balanceAt(snapshot, g, "emails", firstResetMillis)).toBe(200);
  });
});

describe("item quantities: row invariants", () => {
  it("accumulates the running net across transactions", async () => {
    /*
     * t=1000  +10 bonus
     * t=2000  -3 bonus
     *
     * The materialized row is the running net, not just the last change.
     * Expected at t=2500: 7
     */
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("grant", "u", "bonus", 10, 1000, null));
    snapshot = await setManualChange(snapshot, manualChange("adjust", "u", "bonus", -3, 2000, null));
    expect(await balanceAt(snapshot, customerGroup("u"), "bonus", 2500)).toBe(7);
  });

  it("materializes a future expiry in the final row, so 'as of now' must be read instead", async () => {
    /*
     * t=1000  +10 coins, expires at 5000
     *
     * The fold eagerly materializes the future-dated expire marker at 5000, so its ABSOLUTE FINAL
     * row already reports the grant as expired (0). Reading the balance "as of now" (t=2000, via
     * balanceAt) must instead see the live grant (10). This invariant is why the server reads the
     * latest row with txnEffectiveAtMillis <= now rather than the fold's final row.
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("g", "u", "coins", 10, 1000, 5000));
    const g = customerGroup("u");

    const finalRow = asRecord((await rowsBySortKey(snapshot, schema.itemQuantities, g)).at(-1)?.rowData ?? null);
    // Final row sits at the future expiry time and shows the grant already gone.
    expect(Number(finalRow.txnEffectiveAtMillis)).toBe(5000);
    expect(Number(asRecord(finalRow.itemQuantities).coins ?? 0)).toBe(0);

    // But as of now (before the expiry) the grant is still live.
    expect(await balanceAt(snapshot, g, "coins", 2000)).toBe(10);
  });

  it("seeks the 'as of now' row directly with a bounded reverse range, skipping future-dated rows", async () => {
    /*
     * t=1000  +10 coins, expires at 9000  (materializes a future-dated expire row at 9000)
     * t=2000  +5 gems,   expires at 8000  (materializes another future-dated expire row at 8000)
     *
     * The server reads the balance "as of now" with range { reverse, lt: upperBound(now), limit: 1 },
     * so the FIRST row returned must be the latest row effective <= now (t=2000, coins 10 + gems 5),
     * never one of the future-dated expire rows at 8000/9000. This mirrors latestItemQuantitiesRowAsOf.
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("g-coins", "u", "coins", 10, 1000, 9000));
    snapshot = await setManualChange(snapshot, manualChange("g-gems", "u", "gems", 5, 2000, 8000));
    const g = customerGroup("u");

    const seekAsOf = async (asOfMillis: number) => {
      const range = { reverse: true, lt: itemQuantitiesLedgerUpperBoundAsOf(asOfMillis), limit: 1 };
      const found = await collect(snapshot.listRowsInGroup({ tableId: schema.itemQuantities, groupKey: g, range }));
      return found.length === 0 ? null : asRecord(found[0].rowData);
    };

    const asOf5000 = await seekAsOf(5000);
    expect(Number(asOf5000?.txnEffectiveAtMillis)).toBe(2000);
    expect(Number(asRecord(asOf5000!.itemQuantities).coins ?? 0)).toBe(10);
    expect(Number(asRecord(asOf5000!.itemQuantities).gems ?? 0)).toBe(5);

    // Inclusive lower edge: exactly at the first grant's effective time it is already live.
    const asOf1000 = await seekAsOf(1000);
    expect(Number(asOf1000?.txnEffectiveAtMillis)).toBe(1000);
    expect(Number(asRecord(asOf1000!.itemQuantities).coins ?? 0)).toBe(10);

    // Before anything takes effect there is no row.
    expect(await seekAsOf(999)).toBeNull();
  });

  it("stamps every emitted row with the owning customer", async () => {
    /*
     * t=1000  +10 coins, expires at 5000
     *
     * Every emitted item-quantities row must carry the owning customer's tenancyId, customerType,
     * and customerId.
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await setManualChange(snapshot, manualChange("g", "u1", "coins", 10, 1000, 5000));
    const rows = (await rowsBySortKey(snapshot, schema.itemQuantities, customerGroup("u1"))).map(row => asRecord(row.rowData));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenancyId).toBe("t1");
      expect(row.customerType).toBe("user");
      expect(row.customerId).toBe("u1");
    }
  });
});

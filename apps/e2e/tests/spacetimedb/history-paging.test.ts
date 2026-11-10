import { describe } from "vitest";
import { it } from "../helpers";
import { callReducer, isSpacetimedbReachable, opt, signMemberToken, touchSession } from "./helpers";

const canRun = await isSpacetimedbReachable();

describe.skipIf(!canRun)("history index range encoding", () => {
  for (const procedure of [
    { name: "page_ai_query_log", filterCount: 6 },
    { name: "page_mcp_call_log", filterCount: 5 },
    { name: "page_feedback_log", filterCount: 0 },
  ]) {
    it(`${procedure.name} accepts both initial and resume range scans without a module trap`, async ({ expect }) => {
      const token = await signMemberToken();
      const session = await touchSession(token);
      expect(session.ok, session.body).toBe(true);
      const filters = Array.from({ length: procedure.filterCount }, () => opt(null));

      // The host decodes the range before scanning, so even an empty database
      // exercises the SDK's BSATN bounds and catches the former fatal error.
      const initial = await callReducer(token, procedure.name, [opt(null), opt(null), 1, ...filters]);
      expect(initial.ok, initial.body).toBe(true);
      const resumed = await callReducer(token, procedure.name, [opt(1_700_000_000_000_000n), opt(10n), 1, ...filters]);
      expect(resumed.ok, resumed.body).toBe(true);
    });
  }

  it("still rejects a member identity without an enrolled session", async ({ expect }) => {
    const token = await signMemberToken();
    const result = await callReducer(token, "page_feedback_log", [opt(null), opt(null), 1]);
    expect(result.ok).toBe(false);
    expect(result.body).not.toContain("Couldn't decode the BSATN");
  });
});

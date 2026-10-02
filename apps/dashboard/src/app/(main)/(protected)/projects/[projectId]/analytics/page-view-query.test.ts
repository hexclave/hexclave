import { describe, expect, it } from "vitest";
import { pageViewTelemetrySubquery } from "./page-view-query";

describe("pageViewTelemetrySubquery", () => {
  it("uses the time-ordered public page-view store", () => {
    expect(pageViewTelemetrySubquery()).toMatchInlineSnapshot(`
      "(
          SELECT
            user_id,
            started_at,
            data
          FROM default.page_views
        )"
    `);
  });
});

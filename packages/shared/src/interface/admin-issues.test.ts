import { describe, expect, it } from "vitest";
import {
  IssueMergeRequestSchema,
  IssueUpdateRequestSchema,
  MAX_ISSUE_TIMESTAMP_MILLIS,
} from "./admin-issues";

describe("IssueUpdateRequestSchema", () => {
  it("accepts a bounded snooze timestamp", async () => {
    await expect(IssueUpdateRequestSchema.validate({
      status: "ignored",
      ignored_until_millis: MAX_ISSUE_TIMESTAMP_MILLIS,
    })).resolves.toMatchObject({ ignored_until_millis: MAX_ISSUE_TIMESTAMP_MILLIS });
  });

  it("accepts an explicit null (ignore forever)", async () => {
    await expect(IssueUpdateRequestSchema.validate({
      status: "ignored",
      ignored_until_millis: null,
    })).resolves.toMatchObject({ ignored_until_millis: null });
  });

  it("rejects a snooze timestamp beyond the shared bound", async () => {
    await expect(IssueUpdateRequestSchema.validate({
      status: "ignored",
      ignored_until_millis: MAX_ISSUE_TIMESTAMP_MILLIS + 1,
    })).rejects.toThrow(/ignored_until_millis/);
  });

  it("rejects a negative snooze timestamp", async () => {
    await expect(IssueUpdateRequestSchema.validate({
      status: "ignored",
      ignored_until_millis: -1,
    })).rejects.toThrow(/ignored_until_millis/);
  });

  it("rejects a fractional snooze timestamp", async () => {
    await expect(IssueUpdateRequestSchema.validate({
      status: "ignored",
      ignored_until_millis: 1.5,
    })).rejects.toThrow(/ignored_until_millis/);
  });
});

describe("IssueMergeRequestSchema", () => {
  it("accepts two well-formed issue uuids", async () => {
    await expect(IssueMergeRequestSchema.validate({
      issue_ids: ["3241a285-8329-4d69-8f3d-316e08cf140c", "8f3d316e-08cf-4d69-8329-140c3241a285"],
    })).resolves.toBeDefined();
  });

  it("rejects non-uuid issue ids before they can reach a ::uuid cast", async () => {
    await expect(IssueMergeRequestSchema.validate({
      issue_ids: ["3241a285-8329-4d69-8f3d-316e08cf140c", "not-a-uuid"],
    })).rejects.toThrow(/issue_ids/);
  });

  it("rejects numeric short ids (merge is uuid-only, unlike bulk status)", async () => {
    await expect(IssueMergeRequestSchema.validate({
      issue_ids: ["3241a285-8329-4d69-8f3d-316e08cf140c", "42"],
    })).rejects.toThrow(/issue_ids/);
  });

  it("rejects fewer than two issues", async () => {
    await expect(IssueMergeRequestSchema.validate({
      issue_ids: ["3241a285-8329-4d69-8f3d-316e08cf140c"],
    })).rejects.toThrow(/issue_ids/);
  });
});

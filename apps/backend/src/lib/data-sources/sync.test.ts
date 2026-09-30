import { describe, expect, it } from "vitest";
import { getCursorSyncBatchLimit } from "./sync";

describe("cursor sync batch limits", () => {
  it("reads a keyless cursor stream to exhaustion so a large tie cannot strand later values", () => {
    expect(getCursorSyncBatchLimit([])).toBeNull();
  });

  it("keeps the fairness cap when a primary key provides a strict resume point", () => {
    expect(getCursorSyncBatchLimit(["id"])).toBe(50);
  });
});

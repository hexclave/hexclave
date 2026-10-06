import { describe, expect, it } from "vitest";
import { getErrorAttachmentEventId } from "./attachment-event-id";

const EVENT_ID = "0123456789abcdef0123456789abcdef";

describe("getErrorAttachmentEventId", () => {
  it("returns the occurrence id, which is the event id by construction", () => {
    expect(getErrorAttachmentEventId(EVENT_ID)).toBe(EVENT_ID);
    expect(getErrorAttachmentEventId("f".repeat(32))).toBe("f".repeat(32));
  });

  it("fails loudly on anything that is not a strict 32-hex id", () => {
    expect(() => getErrorAttachmentEventId("occurrence-1")).toThrow("not a 32-hex event id");
    expect(() => getErrorAttachmentEventId("")).toThrow("not a 32-hex event id");
    expect(() => getErrorAttachmentEventId(EVENT_ID.toUpperCase())).toThrow("not a 32-hex event id");
    expect(() => getErrorAttachmentEventId(EVENT_ID.slice(0, 31))).toThrow("not a 32-hex event id");
    expect(() => getErrorAttachmentEventId(`${EVENT_ID}0`)).toThrow("not a 32-hex event id");
  });
});

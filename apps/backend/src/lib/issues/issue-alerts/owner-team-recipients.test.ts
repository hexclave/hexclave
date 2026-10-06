import { describe, expect, it } from "vitest";
import { matchOwnerTeamRecipients } from "./owner-team-recipients";

describe("matchOwnerTeamRecipients", () => {
  it("returns emails in the requested order when every member has a primary email", () => {
    expect(matchOwnerTeamRecipients(
      ["user-b", "user-a"],
      new Map([
        ["user-a", "a@example.com"],
        ["user-b", "b@example.com"],
        ["user-c", "c@example.com"],
      ]),
    )).toEqual({
      status: "ok",
      emails: ["b@example.com", "a@example.com"],
    });
  });

  it("fails closed when a requested id is not on the owner team", () => {
    expect(matchOwnerTeamRecipients(
      ["user-a", "user-missing"],
      new Map([["user-a", "a@example.com"]]),
    )).toEqual({
      status: "missing_member",
      userId: "user-missing",
    });
  });

  it("fails closed when an owner-team member has no primary email", () => {
    expect(matchOwnerTeamRecipients(
      ["user-a"],
      new Map([["user-a", null]]),
    )).toEqual({
      status: "missing_email",
      userId: "user-a",
    });
    expect(matchOwnerTeamRecipients(
      ["user-a"],
      new Map([["user-a", ""]]),
    )).toEqual({
      status: "missing_email",
      userId: "user-a",
    });
  });
});

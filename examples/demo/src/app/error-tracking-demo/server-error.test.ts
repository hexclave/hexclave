import { describe, expect, it } from "vitest";
import { POST } from "./api/server-error/route";
import { SERVER_ERROR_MESSAGE } from "./server-error";

describe("error tracking demo server route", () => {
  it("throws a repeatable server-side error for Next to report", async () => {
    await expect(POST()).rejects.toMatchObject({
      message: SERVER_ERROR_MESSAGE,
      name: "HexclaveDemoServerError",
    });
  });
});

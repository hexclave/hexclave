import { expect, expectTypeOf, it } from "vitest";
import { cookies, headers } from "./index.react-server";
import { cookies as nextCookies, headers as nextHeaders } from "./next-static-analysis-workaround";

it("preserves the Next.js exports and their sync-or-async compatibility contracts", () => {
  expect(cookies).toBe(nextCookies);
  expect(headers).toBe(nextHeaders);
  expectTypeOf(cookies).toEqualTypeOf<typeof nextCookies | ((...args: Parameters<typeof nextCookies>) => Promise<ReturnType<typeof nextCookies>>) >();
  expectTypeOf(headers).toEqualTypeOf<typeof nextHeaders | ((...args: Parameters<typeof nextHeaders>) => Promise<ReturnType<typeof nextHeaders>>) >();
});

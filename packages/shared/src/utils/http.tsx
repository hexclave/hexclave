import { decodeBase64, encodeBase64, isBase64 } from "./bytes";

export const HTTP_METHODS = {
  "GET": {
    safe: true,
    idempotent: true,
  },
  "POST": {
    safe: false,
    idempotent: false,
  },
  "PUT": {
    safe: false,
    idempotent: true,
  },
  "DELETE": {
    safe: false,
    idempotent: true,
  },
  "PATCH": {
    safe: false,
    idempotent: false,
  },
  "OPTIONS": {
    safe: true,
    idempotent: true,
  },
  "HEAD": {
    safe: true,
    idempotent: true,
  },
  "TRACE": {
    safe: true,
    idempotent: true,
  },
  "CONNECT": {
    safe: false,
    idempotent: false,
  },
} as const;
export type HttpMethod = keyof typeof HTTP_METHODS;

export async function parseResponseJson<T>(response: Response): Promise<T> {
  // SAFETY: Each SDK call site supplies the response contract defined by its
  // endpoint schema; this centralizes the unavoidable Response.json() boundary.
  return await response.json() as T;
}

export function decodeBasicAuthorizationHeader(value: string): [string, string] | null {
  const [type, encoded, ...rest] = value.split(' ');
  if (rest.length > 0) return null;
  if (!encoded) return null;
  if (type !== 'Basic') return null;
  if (!isBase64(encoded)) return null;
  const decoded = new TextDecoder().decode(decodeBase64(encoded));
  const split = decoded.split(':');
  return [split[0], split.slice(1).join(':')];
}
import.meta.vitest?.test("decodeBasicAuthorizationHeader", ({ expect }) => {
  // Test with valid Basic Authorization header
  const username = "user";
  const password = "pass";
  const encoded = encodeBasicAuthorizationHeader(username, password);
  expect(decodeBasicAuthorizationHeader(encoded)).toEqual([username, password]);

  // Test with password containing colons
  const complexPassword = "pass:with:colons";
  const encodedComplex = encodeBasicAuthorizationHeader(username, complexPassword);
  expect(decodeBasicAuthorizationHeader(encodedComplex)).toEqual([username, complexPassword]);

  // Test with invalid headers
  expect(decodeBasicAuthorizationHeader("NotBasic dXNlcjpwYXNz")).toBe(null); // Wrong type
  expect(decodeBasicAuthorizationHeader("Basic")).toBe(null); // Missing encoded part
  expect(decodeBasicAuthorizationHeader("Basic not-base64")).toBe(null); // Not base64
  expect(decodeBasicAuthorizationHeader("Basic dXNlcjpwYXNz extra")).toBe(null); // Extra parts
});

export function encodeBasicAuthorizationHeader(id: string, password: string): string {
  if (id.includes(':')) throw new Error("Basic authorization header id cannot contain ':'");
  return `Basic ${encodeBase64(new TextEncoder().encode(`${id}:${password}`))}`;
}
import.meta.vitest?.test("encodeBasicAuthorizationHeader", ({ expect }) => {
  // Test with simple username and password
  const encoded = encodeBasicAuthorizationHeader("user", "pass");
  expect(encoded).toMatch(/^Basic [A-Za-z0-9+/=]+$/); // Should start with "Basic " followed by base64

  // Test with empty password
  const encodedEmptyPass = encodeBasicAuthorizationHeader("user", "");
  expect(encodedEmptyPass).toMatch(/^Basic [A-Za-z0-9+/=]+$/);

  // Test with password containing special characters
  const encodedSpecialChars = encodeBasicAuthorizationHeader("user", "p@ss!w0rd");
  expect(encodedSpecialChars).toMatch(/^Basic [A-Za-z0-9+/=]+$/);

  // Test with username containing colon should throw
  expect(() => encodeBasicAuthorizationHeader("user:name", "pass")).toThrow();
});

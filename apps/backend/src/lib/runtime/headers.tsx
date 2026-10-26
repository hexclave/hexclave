import { getRequestContext, parseCookieHeader, requestContextALS, ResponseCookieOptions, type RequestContext } from "./request-context";

export function serializeSetCookie(name: string, value: string, options: ResponseCookieOptions = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path ?? "/"}`);
  const expires = options.expires ?? (options.maxAge != null ? new Date(Date.now() + options.maxAge * 1000) : undefined);
  if (expires != null) {
    parts.push(`Expires=${expires.toUTCString()}`);
  }
  if (options.maxAge != null) {
    parts.push(`Max-Age=${Math.trunc(options.maxAge)}`);
  }
  // Emit Secure before HttpOnly to match the attribute order the pre-ElysiaJS
  // (Next.js) backend produced. Cookie attribute order is semantically irrelevant
  // per RFC 6265, but the e2e suite asserts the exact Set-Cookie string for the
  // oauth-inner cookies (`...; Max-Age=N;( Secure;)? HttpOnly`), so keeping this
  // order avoids a spurious regression there.
  if (options.secure === true) {
    parts.push("Secure");
  }
  if (options.httpOnly === true) {
    parts.push("HttpOnly");
  }
  if (options.sameSite != null) {
    parts.push(`SameSite=${options.sameSite[0].toUpperCase()}${options.sameSite.slice(1)}`);
  }

  return parts.join("; ");
}

export async function headers() {
  return getRequestContext().headers;
}

export async function cookies() {
  const context = getRequestContext();

  return {
    get(name: string) {
      // set()/delete() keep incomingCookies in sync, so it is the authoritative
      // read-view even for cookies written during this request.
      const value = context.incomingCookies.get(name);
      return value == null ? undefined : {
        name,
        value,
      };
    },

    set(name: string, value: string, options: ResponseCookieOptions = {}) {
      // Last write wins, matching the pre-ElysiaJS (Next.js) cookies() semantics: a
      // set() after a delete() of the same name must replace the deletion. Without
      // this, both Set-Cookie headers would be emitted with the deletion appended
      // last — so the deletion, not the set, would win in the browser.
      context.deletedCookies = context.deletedCookies.filter(c => c.name !== name);
      context.pendingSetCookies.push({ name, value, options });
      context.incomingCookies.set(name, value);
    },

    delete(name: string) {
      const cookie = {
        name,
        value: "",
        options: {
          expires: new Date(0),
          maxAge: 0,
          path: "/",
        },
      };
      context.pendingSetCookies = context.pendingSetCookies.filter(c => c.name !== name);
      context.deletedCookies.push(cookie);
      context.incomingCookies.delete(name);
    },
  };
}

const vitest = import.meta.vitest;
if (vitest != null) {
  const { test } = vitest;

  // cookies() reads the request context from AsyncLocalStorage, so tests provide a
  // fake context via requestContextALS.run — the same way app.ts provides the real one.
  const createFakeRequestContext = (): RequestContext => ({
    abortSignal: new AbortController().signal,
    headers: new Headers(),
    incomingCookies: new Map(),
    pendingSetCookies: [],
    deletedCookies: [],
    normalizedPath: "/api/latest/test",
  });

  test("cookie values containing spaces survive a serialize/parse roundtrip", ({ expect }) => {
    const serialized = serializeSetCookie("session-hint", "a b");
    // parseCookieHeader parses a Cookie request header; a browser echoes back only the
    // name=value pair of the Set-Cookie header, so strip the attributes before parsing.
    const nameValuePair = serialized.split(";")[0];
    expect(nameValuePair).toBe("session-hint=a%20b");
    expect(parseCookieHeader(nameValuePair)).toEqual(new Map([["session-hint", "a b"]]));
  });

  test("serializes the independent TV refresh cookie security attributes", ({ expect }) => {
    const serialized = serializeSetCookie("tv-refresh", "secret", {
      path: "/api/latest/tv-displays",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 60,
    });
    expect(serialized).toContain("Path=/api/latest/tv-displays");
    expect(serialized).toContain("Secure");
    expect(serialized).toContain("HttpOnly");
    expect(serialized).toContain("SameSite=Strict");
    expect(serialized).toContain("Max-Age=60");
  });

  test("set() after delete() clears the pending deletion (last write wins)", async ({ expect }) => {
    const context = createFakeRequestContext();
    await requestContextALS.run(context, async () => {
      const cookieStore = await cookies();
      cookieStore.set("foo", "initial");
      cookieStore.delete("foo");
      cookieStore.set("foo", "final");
      expect(cookieStore.get("foo")).toEqual({ name: "foo", value: "final" });
    });
    expect(context.deletedCookies).toEqual([]);
    expect(context.pendingSetCookies).toEqual([
      { name: "foo", value: "final", options: {} },
    ]);
  });

  test("delete() after set() still deletes (last write wins in both directions)", async ({ expect }) => {
    const context = createFakeRequestContext();
    await requestContextALS.run(context, async () => {
      const cookieStore = await cookies();
      cookieStore.set("foo", "value");
      cookieStore.delete("foo");
      expect(cookieStore.get("foo")).toBeUndefined();
    });
    expect(context.pendingSetCookies).toEqual([]);
    expect(context.deletedCookies).toEqual([
      { name: "foo", value: "", options: { expires: new Date(0), maxAge: 0, path: "/" } },
    ]);
  });
}

import { httpMethodNames, routeModules } from "@/generated/route-modules";
import { RoutePatternIndex } from "./route-pattern-index";

type HttpMethod = typeof httpMethodNames[number];
type RouteParams = Record<string, string | string[]>;
type RouteHandlerOptions = { params: Promise<RouteParams> };
type RouteHandler = (request: Request, options: RouteHandlerOptions) => Promise<Response> | Response;
export type UnknownRouteModule = Partial<Record<HttpMethod, RouteHandler>>;
type UnknownRouteFunction = RouteHandler;
export type RouteMethods = Map<HttpMethod, RouteHandler>;

type RouteEntry = {
  loadMethods: () => Promise<RouteMethods>,
  normalizedPath: string,
};

type RouteMatch = {
  methods: RouteMethods,
  normalizedPath: string,
  params: Record<string, string | string[]>,
};

const routeRegistry = buildRouteRegistry();
const routePatternIndex = new RoutePatternIndex(routeRegistry, (entry) => entry.normalizedPath);

export async function matchRoute(dispatchPath: string): Promise<RouteMatch | undefined> {
  return await findRouteMatch(dispatchPath, routePatternIndex);
}

async function findRouteMatch(dispatchPath: string, index: RoutePatternIndex<RouteEntry>): Promise<RouteMatch | undefined> {
  for (const entry of index.getStaticMatches(dispatchPath) ?? []) {
    const match = await loadRouteMatch(entry, {});
    if (match != null) {
      return match;
    }
  }
  for (const { params, value } of index.getDynamicMatches(dispatchPath)) {
    const match = await loadRouteMatch(value, params);
    if (match != null) {
      return match;
    }
  }
  return undefined;
}

async function loadRouteMatch(entry: RouteEntry, params: Record<string, string | string[]>): Promise<RouteMatch | undefined> {
  const methods = await entry.loadMethods();
  if (methods.size === 0) {
    return undefined;
  }
  return {
    methods,
    normalizedPath: entry.normalizedPath,
    params: decodeRouteParams(params),
  };
}

export class MalformedRouteParamError extends Error {
  constructor(param: string) {
    super(`Malformed percent-encoding in route parameter: ${param}`);
    this.name = "MalformedRouteParamError";
  }
}

function strictDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new MalformedRouteParamError(value);
  }
}

function decodeRouteParams(params: Record<string, string | string[]>): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(strictDecodeURIComponent) : strictDecodeURIComponent(value),
    ]),
  );
}

function buildRouteRegistry() {
  return routeModules
    .map((route) => {
      return {
        loadMethods: createRouteMethodsLoader(route.normalizedPath, route.load),
        normalizedPath: route.normalizedPath,
      };
    });
}

function createRouteMethodsLoader(
  normalizedPath: string,
  loadModule: () => Promise<UnknownRouteModule>,
) {
  let methodsPromise: Promise<RouteMethods> | undefined;
  return () => {
    // Cache the promise, not only the resolved module, so concurrent first requests
    // share one import and a deterministic initialization failure stays route-local.
    methodsPromise ??= loadModule().then((routeModule) => {
      const methods: RouteMethods = new Map();
      for (const method of httpMethodNames) {
        const handler = routeModule[method];
        if (isRouteFunction(handler)) {
          methods.set(method, createRouteHandler(normalizedPath, method, handler));
        }
      }
      return methods;
    });
    return methodsPromise;
  };
}

function isRouteFunction(value: unknown): value is UnknownRouteFunction {
  return typeof value === "function";
}

function createRouteHandler(normalizedPath: string, method: HttpMethod, handler: UnknownRouteFunction): RouteHandler {
  return async (request, options) => {
    const result = await handler(request, options);
    if (result instanceof Response) {
      return result;
    }
    throw new Error(`Route ${normalizedPath} ${method} did not return a Response`);
  };
}

import.meta.vitest?.test("route modules are loaded lazily and only once", async ({ expect }) => {
  let loadCount = 0;
  const loadMethods = createRouteMethodsLoader("/api/latest/test", async () => {
    loadCount++;
    return {
      GET: async () => new Response("ok"),
    };
  });

  expect(loadCount).toBe(0);
  const [firstMethods, secondMethods] = await Promise.all([loadMethods(), loadMethods()]);
  expect(loadCount).toBe(1);
  expect(firstMethods).toBe(secondMethods);
  const handler = firstMethods.get("GET");
  if (handler == null) {
    throw new Error("The test route should expose a GET handler");
  }
  const response = await handler(new Request("http://localhost/api/latest/test"), {
    params: Promise.resolve({}),
  });
  expect(await response.text()).toMatchInlineSnapshot(`"ok"`);
});

import.meta.vitest?.test("a failed route import stays isolated to its loader", async ({ expect }) => {
  const failingLoader = createRouteMethodsLoader("/failing", async () => {
    throw new Error("route import failed");
  });
  const healthyLoader = createRouteMethodsLoader("/healthy", async () => ({
    GET: async () => new Response("healthy"),
  }));

  await expect(failingLoader()).rejects.toThrowErrorMatchingInlineSnapshot(`
    [Error: route import failed]
  `);
  expect((await healthyLoader()).has("GET")).toBe(true);
});

import.meta.vitest?.test("a generated static API route resolves through the indexed registry", async ({ expect }) => {
  const match = await matchRoute("/api/latest/users/me");

  expect({
    hasGetHandler: match?.methods.has("GET"),
    normalizedPath: match?.normalizedPath,
  }).toEqual({
    hasGetHandler: true,
    normalizedPath: "/api/latest/users/me",
  });
});

import.meta.vitest?.test("an empty specific route does not shadow a valid fallback route", async ({ expect }) => {
  const match = await findRouteMatch("/test/value", new RoutePatternIndex([
    {
      loadMethods: async () => new Map(),
      normalizedPath: "/test/[id]",
    },
    {
      loadMethods: async () => new Map([["GET", async () => new Response("fallback")]]),
      normalizedPath: "/test/[...path]",
    },
  ], (entry) => entry.normalizedPath));

  expect(match?.normalizedPath).toBe("/test/[...path]");
});

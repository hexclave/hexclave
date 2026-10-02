import { describe, expect, it } from "vitest";
import { BROWSER_STACK_FIXTURES, MINIFIED_BUNDLE_STACK_FIXTURE, NODE_STACK_FIXTURE } from "./__fixtures__/browser-stacks";
import { deriveModule, hasUrlOrigin, normalizeFilenameForGrouping, parseStack, pathnameOf, stripContentHash } from "./stack-parser";
import type { StackFixture } from "./__fixtures__/browser-stacks";

function summarize(fixture: StackFixture): string[] {
  return parseStack(fixture.stack ?? "", fixture.platform).map((frame) =>
    `${frame.inApp ? "app" : "sys"} ${frame.function ?? "<none>"} @ ${frame.module ?? frame.filename ?? "<none>"} ${frame.lineno ?? "-"}:${frame.colno ?? "-"}`
  );
}

function fixture(name: string): StackFixture {
  const found = BROWSER_STACK_FIXTURES.get(name);
  if (found === undefined) throw new Error(`Missing stack fixture ${name}`);
  return found;
}

describe("parseStack — per-browser TraceKit fixtures", () => {
  it("parses a Chrome 15 stack oldest-first", () => {
    expect(summarize(fixture("chrome-15"))).toMatchInlineSnapshot(`
      [
        "app <none> @ to/file 24:4",
        "app foo @ to/file 20:5",
        "app bar @ to/file 16:5",
        "app bar @ to/file 13:17",
      ]
    `);
  });

  it("parses a Chrome stack with port numbers and bracketed aliases", () => {
    expect(summarize(fixture("chrome-36-with-ports"))).toMatchInlineSnapshot(`
      [
        "app I.e.fn.(anonymous function) [as index] @ file 10:3651",
        "app HTMLButtonElement.onclick @ file 107:146",
        "app dumpExceptionError @ file 41:27",
      ]
    `);
  });

  it("parses webpack `devtool: eval` URLs", () => {
    expect(summarize(fixture("chrome-webpack-eval-devtool"))).toMatchInlineSnapshot(`
      [
        "sys TESTTESTTEST.proxiedMethod @ ~/react-proxy/modules/createPrototypeProxy 44:30",
        "sys TESTTESTTEST.tryRender @ ~/react-transform-catch-errors/lib/index 34:31",
        "app TESTTESTTEST.render @ src/components/test/test 272:32",
        "app TESTTESTTEST.eval @ src/components/test/test 295:108",
      ]
    `);
  });

  it("parses Chrome 73 native-code frames", () => {
    expect(summarize(fixture("chrome-73-native-code"))).toMatchInlineSnapshot(`
      [
        "app <none> @ test 24:7",
        "app foo @ test 19:19",
        "sys Array.map @ <anonymous> -:-",
        "app fooIterator @ test 20:17",
      ]
    `);
  });

  it("unwraps webpack `(error: …)` rethrow markers", () => {
    expect(summarize(fixture("chrome-webpack-wrapped-chunk-load-error"))).toMatchInlineSnapshot(`
      [
        "sys Array.reduce @ <anonymous> -:-",
        "app ? @ webpack/runtime/ensure chunk 6:25",
        "app key @ webpack/runtime/jsonp chunk loading 27:18",
        "app <none> @ _static/dist/sentry/chunks/app_bootstrap_initializeLocale_tsx.abcdefg -:-",
        "app <none> @ _static/dist/sentry/chunks/app_bootstrap_initializeLocale_tsx.abcdefg -:-",
      ]
    `);
  });

  it("parses a Firefox 31 stack including a nested-closure frame", () => {
    expect(summarize(fixture("firefox-31"))).toMatchInlineSnapshot(`
      [
        "app .plugin/e.fn[c]/< @ to/file 1:1",
        "app bar @ to/file 1:1",
        "app foo @ to/file 41:13",
      ]
    `);
  });

  it("parses a Firefox NS_ERROR_FAILURE stack across file:// and http:// origins", () => {
    expect(summarize(fixture("firefox-44-ns-exception"))).toMatchInlineSnapshot(`
      [
        "app <none> @ path/to/index.html 23:1",
        "app bar @ path/to/file 20:3",
        "app App.prototype.foo @ path/to/file 15:2",
        "app [2]</Bar.prototype._baz/</< @ to/file 703:28",
      ]
    `);
  });

  it("parses Firefox resource:// URLs", () => {
    expect(summarize(fixture("firefox-50-resource-urls"))).toMatchInlineSnapshot(`
      [
        "app wrapped @ data/content/bundle 7270:25",
        "app dispatchEvent @ data/content/vendor.bundle 18:23028",
        "app render @ data/content/bundle 5529:16",
      ]
    `);
  });

  it("parses a Safari 6 stack ending in [native code]", () => {
    expect(summarize(fixture("safari-6"))).toMatchInlineSnapshot(`
      [
        "sys <none> @ [native code] -:-",
        "app onclick @ to/file 82:-",
        "app dumpException3 @ to/file 52:-",
        "app <none> @ to/file 48:-",
      ]
    `);
  });

  it("parses a Safari 8 frames-only stack", () => {
    expect(summarize(fixture("safari-8"))).toMatchInlineSnapshot(`
      [
        "app bar @ to/file 108:23",
        "app foo @ to/file 52:15",
        "app <none> @ to/file 47:22",
      ]
    `);
  });

  it("parses a minified React production stack", () => {
    expect(summarize(fixture("react-minified-invariant"))).toMatchInlineSnapshot(`
      [
        "app f @ / 1:980",
        "app ho @ static/js/foo.chunk 1:68735",
        "app a @ static/js/foo.chunk 1:21841",
        "app <none> @ static/js/foo.chunk 1:21738",
      ]
    `);
  });

  it("parses a Node stack and marks node_modules and builtins out-of-app", () => {
    expect(summarize(NODE_STACK_FIXTURE)).toMatchInlineSnapshot(`
      [
        "sys process.processTicksAndRejections @ node:internal/process/task_queues 95:5",
        "sys AppRouteRouteModule.handle @ /srv/app/node_modules/next/dist/server/route-modules/app-route/module.js 302:20",
        "sys <none> @ /srv/app/node_modules/next/dist/server/route-modules/app-route/module.js 207:37",
        "app getUser @ /srv/app/src/app/api/users/route.ts 42:23",
      ]
    `);
  });

  it("parses a minified single-line bundle and strips content hashes into the module", () => {
    expect(summarize(MINIFIED_BUNDLE_STACK_FIXTURE)).toMatchInlineSnapshot(`
      [
        "sys <none> @ _next/static/chunks/framework 1:71234",
        "app u @ _next/static/chunks/app/dashboard/page 1:1042",
        "app o @ _next/static/chunks/4711 1:24188",
      ]
    `);
  });
});

describe("parseStack — guards", () => {
  it("truncates every line to 1024 characters before regexing", () => {
    const padded = `    at ${"x".repeat(2000)} (https://example.com/app.js:1:2)`;
    const frames = parseStack(`Error: boom\n${padded}`, "javascript");
    expect(frames.map((frame) => frame.absPath)).toMatchInlineSnapshot(`
      [
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ]
    `);
  });

  it("caps output at 50 frames", () => {
    const lines = ["Error: deep"];
    for (let index = 0; index < 200; index++) {
      lines.push(`    at fn${index} (https://example.com/app.js:${index}:1)`);
    }
    expect(parseStack(lines.join("\n"), "javascript")).toHaveLength(50);
  });

  it("stops scanning after 500 lines even when nothing parses", () => {
    const lines = ["Error: noisy", ...Array.from({ length: 5000 }, () => "not a frame at all")];
    lines.push("    at realFrame (https://example.com/app.js:1:1)");
    expect(parseStack(lines.join("\n"), "javascript")).toMatchInlineSnapshot(`[]`);
  });

  it("does not turn a URL inside the header line into a frame", () => {
    const frames = parseStack(
      [
        "NetworkError: failed to fetch https://api.example.com/users/8f14e45f-ceea-467a-9e33-1c2b3d4e5f60",
        "    at fetchUser (https://app.example.com/app.js:1:1)",
      ].join("\n"),
      "javascript",
    );
    expect(frames.map((frame) => frame.absPath)).toMatchInlineSnapshot(`
      [
        "https://app.example.com/app.js",
      ]
    `);
  });

  it("skips a Node coded-error header rather than minting a frame from the message", () => {
    const frames = parseStack(
      [
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/dist/missing.js' imported from /app/dist/main.js",
        "    at finalizeResolution (node:internal/modules/esm/resolve:264:11)",
      ].join("\n"),
      "node",
    );
    expect(frames.map((frame) => frame.absPath)).toMatchInlineSnapshot(`
      [
        "node:internal/modules/esm/resolve",
      ]
    `);
  });

  it("returns frames oldest-first (crash site last)", () => {
    const frames = parseStack(
      ["Error: boom", "    at crashSite (https://example.com/a.js:3:1)", "    at caller (https://example.com/a.js:9:1)"].join("\n"),
      "javascript",
    );
    expect(frames.map((frame) => frame.function)).toMatchInlineSnapshot(`
      [
        "caller",
        "crashSite",
      ]
    `);
  });

  it("strips our own SDK frames off the top of the stack", () => {
    const frames = parseStack(
      [
        "Error",
        "    at normalizeCapturedError (https://example.com/node_modules/@hexclave/next/dist/index.js:1:100)",
        "    at capture (https://example.com/node_modules/@hexclave/next/dist/index.js:1:200)",
        "    at customerCode (https://example.com/app.js:5:1)",
      ].join("\n"),
      "javascript",
    );
    expect(frames.map((frame) => frame.function)).toMatchInlineSnapshot(`
      [
        "customerCode",
      ]
    `);
  });

  it("keeps a stack that is entirely SDK frames rather than returning nothing", () => {
    const frames = parseStack(
      [
        "Error",
        "    at normalizeCapturedError (https://example.com/node_modules/@hexclave/next/dist/index.js:1:100)",
        "    at buildErrorEventData (https://example.com/node_modules/@hexclave/next/dist/index.js:1:200)",
      ].join("\n"),
      "javascript",
    );
    expect(frames).toHaveLength(2);
  });

  it.each([
    ["empty string", ""],
    ["only newlines", "\n\n\n\n"],
    ["binary junk", " ￾ at (((((((("],
    ["lone surrogate", "Error: \uD800\uD800\uD800\n    at \uDC00 (\uD800:1:1)"],
    ["10k-char single line", `    at ${"a(".repeat(5000)}`],
    ["10k-char url", `    at fn (https://example.com/${"x".repeat(10000)}.js:1:1)`],
    ["nested parens", `    at ${"(".repeat(2000)}`],
    ["only separators", ":".repeat(5000)],
    ["at-signs", "@".repeat(5000)],
    ["backtracking bait", `    at ${"a b ".repeat(3000)}(x`],
  ])("never throws on garbage input: %s", (_name, garbage) => {
    expect(() => parseStack(garbage, "javascript")).not.toThrow();
    expect(() => parseStack(garbage, "node")).not.toThrow();
  });

  it("stays fast on adversarial input", () => {
    const start = performance.now();
    for (let index = 0; index < 200; index++) {
      parseStack(`    at ${"a b ".repeat(3000)}(x`, "javascript");
    }
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

describe("path normalization", () => {
  it("detects URL origins", () => {
    expect([
      hasUrlOrigin("https://example.com/a.js"),
      hasUrlOrigin("file:///a/b.js"),
      hasUrlOrigin("webpack:///./src/a.js"),
      hasUrlOrigin("/srv/app/a.js"),
      hasUrlOrigin("node:internal/process"),
    ]).toMatchInlineSnapshot(`
      [
        true,
        true,
        true,
        false,
        false,
      ]
    `);
  });

  it("reduces a URL to its pathname", () => {
    expect([
      pathnameOf("https://example.com/a/b.js?v=1#x"),
      pathnameOf("https://example.com"),
      pathnameOf("/srv/app/a.js"),
    ]).toMatchInlineSnapshot(`
      [
        "/a/b.js",
        "",
        "/srv/app/a.js",
      ]
    `);
  });

  it("strips webpack content hashes", () => {
    expect([
      stripContentHash("4711-a1b2c3d4"),
      stripContentHash("page-a1b2c3d4e5f6"),
      stripContentHash("framework-2c79e2a64abdb08b"),
      stripContentHash("main-app-1c0f0d3b9a7e4f21"),
      stripContentHash("_app-0011223344556677"),
    ]).toMatchInlineSnapshot(`
      [
        "4711",
        "page",
        "framework",
        "main-app",
        "_app",
      ]
    `);
  });

  it("strips Turbopack content hashes", () => {
    expect([
      stripContentHash("[root-of-the-server]__a1b2c3._"),
      stripContentHash("src_app_dashboard_page_tsx_1a2b3c._"),
      stripContentHash("[turbopack]_browser_dev_hmr-client_hmr-client_ts_4d5e6f._"),
      stripContentHash("[turbopack]_runtime._"),
    ]).toMatchInlineSnapshot(`
      [
        "[root-of-the-server]",
        "src_app_dashboard_page_tsx",
        "[turbopack]_browser_dev_hmr-client_hmr-client_ts",
        "[turbopack]_runtime",
      ]
    `);
  });

  it("leaves short hex-looking suffixes alone", () => {
    expect([stripContentHash("use-face"), stripContentHash("chunk-added"), stripContentHash("a-decade")]).toMatchInlineSnapshot(`
      [
        "use-face",
        "chunk-added",
        "a-decade",
      ]
    `);
  });

  it("collapses a chunk name that is nothing but a hash", () => {
    expect(stripContentHash("8a7b6c5d4e3f2109")).toMatchInlineSnapshot(`"<hash>"`);
  });

  it("keeps the extension on a grouping filename but drops the hash and `.min`", () => {
    expect([
      normalizeFilenameForGrouping("4711-a1b2c3d4.js"),
      normalizeFilenameForGrouping("vendor.min.js"),
      normalizeFilenameForGrouping("route.ts"),
      normalizeFilenameForGrouping("index.html"),
    ]).toMatchInlineSnapshot(`
      [
        "4711.js",
        "vendor.js",
        "route.ts",
        "index.html",
      ]
    `);
  });

  it("derives origin-independent modules and drops the Next build id", () => {
    expect([
      deriveModule("https://app.example.com/_next/static/chunks/4711-9f2c1ad3e4b57c60.js", "javascript"),
      deriveModule("http://localhost:3000/_next/static/chunks/4711-00ffaa1122334455.js", "javascript"),
      deriveModule("https://app.example.com/_next/static/aB3kD9fQzLm1pR7sT2uV/_buildManifest.js", "javascript"),
      deriveModule("https://app.example.com/_next/static/chunks/app/dashboard/page-b2c3d4e5f6a17890.js", "javascript"),
      deriveModule("<anonymous>", "javascript"),
      deriveModule("/srv/app/src/route.ts", "node"),
    ]).toMatchInlineSnapshot(`
      [
        "_next/static/chunks/4711",
        "_next/static/chunks/4711",
        "_next/static/_buildManifest",
        "_next/static/chunks/app/dashboard/page",
        null,
        null,
      ]
    `);
  });
});

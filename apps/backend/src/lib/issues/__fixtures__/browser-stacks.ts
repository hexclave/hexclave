import type { GroupingInput } from "../types";

/**
 * Real captured stack traces, ported from sentry-javascript's TraceKit corpus
 * (`packages/browser/test/tracekit/{chromium,firefox,safari,react}.test.ts`).
 *
 * These are the highest-value test data available for a stack parser: every one
 * of them was captured from a real browser, and several exist only because a
 * naive regex got them wrong in production. Do not "tidy" the strings — the
 * exact whitespace, the trailing `?` on webpack URLs and the `(error: …)`
 * wrappers are the point.
 *
 * Sentry is MIT licensed; see the attribution header in `../stack-parser.ts`.
 */

export type StackFixture = GroupingInput;

export const BROWSER_STACK_FIXTURES: ReadonlyMap<string, StackFixture> = new Map<string, StackFixture>([
  ["chrome-15", {
    type: "TypeError",
    message: "Object #<Object> has no method 'undef'",
    platform: "javascript",
    stack: [
      "TypeError: Object #<Object> has no method 'undef'",
      "    at bar (http://path/to/file.js:13:17)",
      "    at bar (http://path/to/file.js:16:5)",
      "    at foo (http://path/to/file.js:20:5)",
      "    at http://path/to/file.js:24:4",
    ].join("\n"),
  }],
  ["chrome-36-with-ports", {
    type: "Error",
    message: "Default error",
    platform: "javascript",
    stack: [
      "Error: Default error",
      "    at dumpExceptionError (http://localhost:8080/file.js:41:27)",
      "    at HTMLButtonElement.onclick (http://localhost:8080/file.js:107:146)",
      "    at I.e.fn.(anonymous function) [as index] (http://localhost:8080/file.js:10:3651)",
    ].join("\n"),
  }],
  ["chrome-webpack-eval-devtool", {
    type: "TypeError",
    message: "Cannot read property 'error' of undefined",
    platform: "javascript",
    stack: [
      "TypeError: Cannot read property 'error' of undefined",
      "   at TESTTESTTEST.eval(webpack:///./src/components/test/test.jsx?:295:108)",
      "   at TESTTESTTEST.render(webpack:///./src/components/test/test.jsx?:272:32)",
      "   at TESTTESTTEST.tryRender(webpack:///./~/react-transform-catch-errors/lib/index.js?:34:31)",
      "   at TESTTESTTEST.proxiedMethod(webpack:///./~/react-proxy/modules/createPrototypeProxy.js?:44:30)",
    ].join("\n"),
  }],
  ["chrome-73-native-code", {
    type: "Error",
    message: "test",
    platform: "javascript",
    stack: [
      "Error: test",
      "          at fooIterator (http://localhost:5000/test:20:17)",
      "          at Array.map (<anonymous>)",
      "          at foo (http://localhost:5000/test:19:19)",
      "          at http://localhost:5000/test:24:7",
    ].join("\n"),
  }],
  ["chrome-webpack-wrapped-chunk-load-error", {
    type: "ChunkLoadError",
    message: "Loading chunk app_bootstrap_initializeLocale_tsx failed.",
    platform: "javascript",
    stack: [
      "ChunkLoadError: Loading chunk app_bootstrap_initializeLocale_tsx failed.",
      "      (error: https://s1.sentry-cdn.com/_static/dist/sentry/chunks/app_bootstrap_initializeLocale_tsx.abcdefg.js)",
      "        at (error: (/_static/dist/sentry/chunks/app_bootstrap_initializeLocale_tsx.abcdefg.js))",
      "        at key(webpack/runtime/jsonp chunk loading:27:18)",
      "        at ? (webpack/runtime/ensure chunk:6:25)",
      "        at Array.reduce(<anonymous>)",
    ].join("\n"),
  }],
  ["firefox-31", {
    type: "Error",
    message: "Default error",
    platform: "javascript",
    stack: [
      "foo@http://path/to/file.js:41:13",
      "bar@http://path/to/file.js:1:1",
      ".plugin/e.fn[c]/<@http://path/to/file.js:1:1",
      "",
    ].join("\n"),
  }],
  ["firefox-44-ns-exception", {
    type: "NS_ERROR_FAILURE",
    message: "",
    platform: "javascript",
    stack: [
      "[2]</Bar.prototype._baz/</<@http://path/to/file.js:703:28",
      "App.prototype.foo@file:///path/to/file.js:15:2",
      "bar@file:///path/to/file.js:20:3",
      "@file:///path/to/index.html:23:1",
      "",
    ].join("\n"),
  }],
  ["firefox-50-resource-urls", {
    type: "TypeError",
    message: "this.props.raw[this.state.dataSource].rows is undefined",
    platform: "javascript",
    stack: [
      "render@resource://path/data/content/bundle.js:5529:16",
      "dispatchEvent@resource://path/data/content/vendor.bundle.js:18:23028",
      "wrapped@resource://path/data/content/bundle.js:7270:25",
    ].join("\n"),
  }],
  ["safari-6", {
    type: "TypeError",
    message: "'null' is not an object (evaluating 'x.undef')",
    platform: "javascript",
    stack: [
      "@http://path/to/file.js:48",
      "dumpException3@http://path/to/file.js:52",
      "onclick@http://path/to/file.js:82",
      "[native code]",
    ].join("\n"),
  }],
  ["safari-8", {
    type: "TypeError",
    message: "null is not an object (evaluating 'x.undef')",
    platform: "javascript",
    stack: [
      "http://path/to/file.js:47:22",
      "foo@http://path/to/file.js:52:15",
      "bar@http://path/to/file.js:108:23",
    ].join("\n"),
  }],
  ["react-minified-invariant", {
    type: "Invariant Violation",
    message: "Minified React error #31; visit https://reactjs.org/docs/error-decoder.html?invariant=31&args[]=object%20with%20keys%20%7B%7D&args[]= for the full message or use the non-minified dev environment for full errors and additional helpful warnings. ",
    platform: "javascript",
    stack: [
      "Invariant Violation: Minified React error #31; visit https://reactjs.org/docs/error-decoder.html?invariant=31&args[]=object%20with%20keys%20%7B%7D&args[]= for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
      "          at http://localhost:5000/static/js/foo.chunk.js:1:21738",
      "          at a (http://localhost:5000/static/js/foo.chunk.js:1:21841)",
      "          at ho (http://localhost:5000/static/js/foo.chunk.js:1:68735)",
      "          at f (http://localhost:5000/:1:980)",
    ].join("\n"),
  }],
]);

export const NODE_STACK_FIXTURE: StackFixture = {
  type: "TypeError",
  message: "Cannot read properties of undefined (reading 'id')",
  platform: "node",
  stack: [
    "TypeError: Cannot read properties of undefined (reading 'id')",
    "    at getUser (/srv/app/src/app/api/users/route.ts:42:23)",
    "    at async /srv/app/node_modules/next/dist/server/route-modules/app-route/module.js:207:37",
    "    at async AppRouteRouteModule.handle (/srv/app/node_modules/next/dist/server/route-modules/app-route/module.js:302:20)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  ].join("\n"),
};

export const MINIFIED_BUNDLE_STACK_FIXTURE: StackFixture = {
  type: "TypeError",
  message: "e.map is not a function",
  platform: "javascript",
  stack: [
    "TypeError: e.map is not a function",
    "    at o (https://app.example.com/_next/static/chunks/4711-9f2c1ad3e4b57c60.js:1:24188)",
    "    at u (https://app.example.com/_next/static/chunks/app/dashboard/page-b2c3d4e5f6a17890.js:1:1042)",
    "    at https://app.example.com/_next/static/chunks/framework-2c79e2a64abdb08b.js:1:71234",
  ].join("\n"),
};

export const ANONYMOUS_ONLY_STACK_FIXTURE: StackFixture = {
  type: "Error",
  message: "boom",
  platform: "javascript",
  stack: [
    "Error: boom",
    "    at <anonymous>:1:1",
    "    at Array.forEach (<anonymous>)",
  ].join("\n"),
};

export const SYNTHETIC_OBJECT_THROW_FIXTURE: StackFixture = {
  type: "Error",
  message: "Non-Error exception captured with keys: code",
  platform: "javascript",
  synthetic: true,
  stack: [
    "Error",
    "    at https://app.example.com/_next/static/chunks/main-app-1c0f0d3b9a7e4f21.js:1:9042",
  ].join("\n"),
};

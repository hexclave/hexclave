import createJsLibraryTsupConfig from '../../configs/tsdown/js-library.ts';

export default createJsLibraryTsupConfig({ barrelFiles: [
  "src/index.ts",
  "src/integrations/convex/component/convex.config.ts",
  "src/integrations/convex.ts",
  "src/integrations/trpc.ts",
  "src/integrations/orpc.ts",
  "src/integrations/elysia.ts",
  "src/integrations/next.ts", // THIS_LINE_PLATFORM next
  "src/integrations/otel.ts",
  "src/integrations/otel-browser.ts",
  "src/integrations/tanstack-start.ts", // THIS_LINE_PLATFORM tanstack-start
] });

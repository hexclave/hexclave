// Turbopack loads a `postcss.config.js` through a generated loader module that
// uses a top-level await, which requires the async-module helper in the shared
// `[turbopack]_runtime.js` chunk. Several independent chunk groups write that
// same runtime file and the ones that see no async modules strip the helper, so
// whichever emit wins the race decides whether the build fails with
// "__turbopack_context__.a is not a function" (next#96599). Non-`.js` configs
// skip the generated loader entirely, which keeps the build deterministic.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

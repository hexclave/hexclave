// Renamed from `.js` so Turbopack does not load it through its generated
// top-level-await loader module; see apps/dashboard/postcss.config.mjs.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

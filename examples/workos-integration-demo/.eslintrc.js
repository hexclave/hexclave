module.exports = {
  extends: [
    "../../configs/eslint/defaults.js",
    "../../configs/eslint/next.js",
  ],
  ignorePatterns: ["/*", "!/src"],
  rules: {
    "@typescript-eslint/no-misused-promises": [0],
    "@typescript-eslint/no-unnecessary-condition": [0],
  },
};

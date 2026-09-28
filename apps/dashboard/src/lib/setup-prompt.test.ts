import { describe, expect, it } from "vitest";

import {
  buildOnboardingConfigFile,
  estimatePromptTokenCount,
  formatApproximateTokenCountLabel,
  prependConfigChangesToSetupPrompt,
} from "./setup-prompt";

describe("estimatePromptTokenCount", () => {
  it("uses roughly one token per four characters", () => {
    expect(estimatePromptTokenCount("abcd")).toBe(1);
    expect(estimatePromptTokenCount("abcdefgh")).toBe(2);
    expect(estimatePromptTokenCount("a".repeat(401))).toBe(100);
  });

  it("never reports fewer than one token for non-empty text", () => {
    expect(estimatePromptTokenCount("a")).toBe(1);
  });
});

describe("formatApproximateTokenCountLabel", () => {
  it("formats with a tilde and thousands separators", () => {
    expect(formatApproximateTokenCountLabel("a".repeat(60_000))).toBe("~15,000 tokens");
  });
});

describe("configured onboarding setup", () => {
  it("renders enabled products into a copy-pasteable config file", () => {
    const configFile = buildOnboardingConfigFile({
      apps: {
        installed: {
          analytics: { enabled: true },
          emails: { enabled: true },
        },
      },
      auth: {
        password: { allowSignIn: false },
        otp: { allowSignIn: false },
        passkey: { allowSignIn: false },
        oauth: { providers: {} },
      },
      emails: {
        selectedThemeId: "theme-id",
      },
    });

    expect(configFile).toMatchInlineSnapshot(`
      "export const config = {
        "apps": {
          "installed": {
            "emails": {
              "enabled": true
            },
            "analytics": {
              "enabled": true
            }
          }
        },
        "emails": {
          "selectedThemeId": "theme-id"
        }
      };
      "
    `);
  });

  it("instructs the agent to preserve unrelated settings in an existing config", () => {
    expect(prependConfigChangesToSetupPrompt("SETUP", "export const config = {};"))
      .toMatchInlineSnapshot(`
        "IMPORTANT: Apply the selected products and settings from the \`hexclave.config.ts\` example below.

        - If \`hexclave.config.ts\` does not exist, create it with the exact contents shown.
        - If \`hexclave.config.ts\` already exists, update the existing config to apply the products and settings shown while preserving every unrelated existing setting.

        \`\`\`ts
        export const config = {};
        \`\`\`

        Below is the setup prompt for using Hexclave. Follow it carefully, while applying the \`hexclave.config.ts\` changes described above.

        SETUP"
      `);
  });
});

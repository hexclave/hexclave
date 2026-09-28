import { getPublicEnvVar } from "@/lib/env";
import { remindersPrompt } from "@hexclave/shared/dist/ai/unified-prompts/reminders";
import { ALL_APPS, getParentAppId, type AppId } from "@hexclave/shared/dist/apps/apps-config";
import type { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { deindent } from "@hexclave/shared/dist/utils/strings";

const PROD_DOCS_BASE_URL = "https://docs.hexclave.com";
const PROD_API_BASE_URL = "https://api.hexclave.com";

export function getSetupDocsBaseUrl(): string {
  return getPublicEnvVar("NEXT_PUBLIC_STACK_DOCS_BASE_URL") ?? PROD_DOCS_BASE_URL;
}

export function getManualSetupDocsUrl(): string {
  const docsBaseUrl = getSetupDocsBaseUrl().replace(/\/$/, "");
  return `${docsBaseUrl}/guides/getting-started/setup`;
}

export function getOnboardingRemindersPrompt(): string {
  const docsBaseUrl = getSetupDocsBaseUrl().replace(/\/$/, "");
  return remindersPrompt.replaceAll(PROD_DOCS_BASE_URL, docsBaseUrl);
}

/** Rough LLM estimate used for onboarding prompt previews (~1 token / 4 chars). */
export function estimatePromptTokenCount(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

export function formatApproximateTokenCountLabel(text: string): string {
  return `~${estimatePromptTokenCount(text).toLocaleString("en-US")} tokens`;
}

export function getSetupApiBaseUrl(): string {
  return getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL") ?? PROD_API_BASE_URL;
}

export function buildCloudSetupPrompt(options: {
  docsBaseUrl: string,
  projectId: string,
  apiBaseUrl: string,
}): string {
  const { docsBaseUrl, projectId, apiBaseUrl } = options;
  const normalizedDocsBaseUrl = docsBaseUrl.replace(/\/$/, "");
  const reminders = remindersPrompt.replaceAll(PROD_DOCS_BASE_URL, normalizedDocsBaseUrl);

  // The SDK already defaults to the production cloud API. Only tell the agent
  // to configure an API URL when this deployment actually uses a custom one.
  const isDefaultApiBaseUrl = apiBaseUrl === PROD_API_BASE_URL;
  const projectValues = isDefaultApiBaseUrl
    ? deindent`
      - Hexclave project ID: ${projectId}
    `
    : deindent`
      - Hexclave API URL: ${apiBaseUrl}
      - Hexclave project ID: ${projectId}
    `;
  const envVarInstructions = isDefaultApiBaseUrl
    ? deindent`
      Create the framework-specific public environment variable for the Hexclave project ID. For example, Next.js uses NEXT_PUBLIC_HEXCLAVE_PROJECT_ID, while Vite-based frameworks use VITE_HEXCLAVE_PROJECT_ID. If the Hexclave docs for this framework specify a different environment variable name, use the docs' framework-specific name with the value above.
    `
    : deindent`
      Create the framework-specific public environment variables for the Hexclave API URL and project ID. For example, Next.js uses NEXT_PUBLIC_HEXCLAVE_API_URL and NEXT_PUBLIC_HEXCLAVE_PROJECT_ID, while Vite-based frameworks use VITE_HEXCLAVE_API_URL and VITE_HEXCLAVE_PROJECT_ID. If the Hexclave docs for this framework specify different environment variable names, use the docs' framework-specific names with the values above.
    `;

  return deindent`
    Install and set up Hexclave in this project by following these instructions:

    Read https://skill.hexclave.com and follow the setup instructions it gives for this project's specific framework and language.

    Follow skill.hexclave.com as written, but make sure to use the cloud setup, not the local dashboard setup.

    Do not change the dev script in package.json. In cloud setup, there's no need for that.

    Use these Hexclave project values when creating environment variables:

    ${projectValues}

    ${envVarInstructions}

    After setup finishes, verify that the Hexclave MCP server is registered in your AI client config — name: \`hexclave\`, transport: \`http\`, URL: \`https://mcp.hexclave.com/mcp\`. If it is not registered, add it manually so future agents have live access to Hexclave docs and APIs.

    Once setup is done, tell me to add the Hexclave secret server key from the dashboard to my environment file. After that, setup is complete.

    ${reminders}
  `;
}

export function buildCliDevSetupPrompt(options: {
  docsBaseUrl: string,
}): string {
  const { docsBaseUrl } = options;
  const normalizedDocsBaseUrl = docsBaseUrl.replace(/\/$/, "");
  const reminders = remindersPrompt.replaceAll(PROD_DOCS_BASE_URL, normalizedDocsBaseUrl);

  return deindent`
    Install and set up Hexclave in this project by following these instructions:

    Read https://skill.hexclave.com and follow the setup instructions it gives for this project's specific framework and language.

    Follow skill.hexclave.com as written, but use the local dashboard / Hexclave CLI development setup. Do not use the cloud environment-variable setup for local development.

    Set up the app's dev command so Hexclave starts through the CLI:

    \`\`\`json
    {
      "scripts": {
        "dev": "hexclave dev --config-file ./hexclave.config.ts -- npm run dev:inner",
        "dev:inner": "<the app's previous dev command>"
      }
    }
    \`\`\`

    If the Hexclave CLI is not installed globally, use \`npx @hexclave/cli dev --config-file ./hexclave.config.ts -- npm run dev:inner\` instead.

    Do not create Hexclave project keys or ask for Hexclave environment variables for local development. The \`hexclave dev\` command automatically creates or links the local config project and injects the project ID and secret server key into the child app process.

    Keep project configuration in \`hexclave.config.ts\`. Once setup is done, run \`npm run dev\` and create the first user in the app.

    After setup finishes, verify that the Hexclave MCP server is registered in your AI client config — name: \`hexclave\`, transport: \`http\`, URL: \`https://mcp.hexclave.com/mcp\`. If it is not registered, add it manually so future agents have live access to Hexclave docs and APIs.

    ${reminders}
  `;
}

type OnboardingSetupConfig = {
  apps: {
    installed: CompleteConfig["apps"]["installed"],
  },
  auth: {
    password: Pick<CompleteConfig["auth"]["password"], "allowSignIn">,
    otp: Pick<CompleteConfig["auth"]["otp"], "allowSignIn">,
    passkey: Pick<CompleteConfig["auth"]["passkey"], "allowSignIn">,
    oauth: {
      providers: Partial<Record<string, { allowSignIn: boolean }>>,
    },
  },
  emails: Pick<CompleteConfig["emails"], "selectedThemeId">,
};

function getStandaloneAppIds(): AppId[] {
  return Object.keys(ALL_APPS)
    .filter((appId): appId is AppId => Object.prototype.hasOwnProperty.call(ALL_APPS, appId))
    .filter((appId) => getParentAppId(appId) == null);
}

export function buildOnboardingConfigFile(config: OnboardingSetupConfig): string {
  const selectedApps = getStandaloneAppIds().filter((appId) => config.apps.installed[appId]?.enabled === true);
  const selectedSharedOAuthProviders = ["google", "github", "microsoft"].filter((providerId) => (
    config.auth.oauth.providers[providerId]?.allowSignIn === true
  ));

  return buildSelectedOnboardingConfigFile({
    selectedApps,
    passwordEnabled: config.auth.password.allowSignIn,
    otpEnabled: config.auth.otp.allowSignIn,
    passkeyEnabled: config.auth.passkey.allowSignIn,
    sharedOAuthProviderIds: selectedSharedOAuthProviders,
    emailThemeId: config.emails.selectedThemeId,
  });
}

export function buildSelectedOnboardingConfigFile(options: {
  selectedApps: Iterable<AppId>,
  passwordEnabled: boolean,
  otpEnabled: boolean,
  passkeyEnabled: boolean,
  sharedOAuthProviderIds: Iterable<string>,
  emailThemeId: string,
}): string {
  const selectedApps = new Set(options.selectedApps);
  const installedApps = Object.fromEntries(
    getStandaloneAppIds()
      .filter((appId) => selectedApps.has(appId))
      .map((appId) => [appId, { enabled: true }]),
  );
  const sharedOAuthProviders = [...options.sharedOAuthProviderIds].map((providerId) => [providerId, {
    type: providerId,
    allowSignIn: true,
    allowConnectedAccounts: true,
  }]);
  const configValue = {
    apps: {
      installed: installedApps,
    },
    ...(selectedApps.has("authentication") ? {
      auth: {
        password: {
          allowSignIn: options.passwordEnabled,
        },
        otp: {
          allowSignIn: options.otpEnabled,
        },
        passkey: {
          allowSignIn: options.passkeyEnabled,
        },
        oauth: {
          providers: Object.fromEntries(sharedOAuthProviders),
        },
      },
    } : {}),
    ...(selectedApps.has("emails") ? {
      emails: {
        selectedThemeId: options.emailThemeId,
      },
    } : {}),
  };

  // Keep this framework-agnostic: every SDK accepts an exported config object,
  // while adding a type import would couple the copy-paste file to one package.
  return `export const config = ${JSON.stringify(configValue, null, 2)};\n`;
}

export function prependConfigChangesToSetupPrompt(setupPrompt: string, configFile: string): string {
  return deindent`
    IMPORTANT: Apply the selected products and settings from the \`hexclave.config.ts\` example below.

    - If \`hexclave.config.ts\` does not exist, create it with the exact contents shown.
    - If \`hexclave.config.ts\` already exists, update the existing config to apply the products and settings shown while preserving every unrelated existing setting.

    \`\`\`ts
    ${configFile.trim()}
    \`\`\`

    Below is the setup prompt for using Hexclave. Follow it carefully, while applying the \`hexclave.config.ts\` changes described above.

    ${setupPrompt}
  `;
}

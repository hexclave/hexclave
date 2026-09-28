// @vitest-environment jsdom

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockUpdateConfig = vi.hoisted(() => vi.fn(async () => true));
const mockPublicEnvVars = vi.hoisted(() => new Map<string, string>());

vi.mock("@/components/code-block", () => ({
  CodeBlock: ({ title, content }: { title: string, content: string }) => (
    <div>
      <div>{title}</div>
      <pre>{content}</pre>
    </div>
  ),
}));

vi.mock("@/components/design-components", () => ({
  DesignCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DesignPillToggle: () => <div />,
}));

vi.mock("@/components/design-components/alert", () => ({
  DesignAlert: ({ title, description }: { title: string, description: string }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
    </div>
  ),
}));

vi.mock("@/components/design-components/button", () => ({
  DesignButton: ({
    children,
    type,
    loading,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean, variant?: string }) => (
    <button type={type ?? "button"} data-loading={loading ? "true" : "false"} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/design-components/select", () => ({
  DesignSelectorDropdown: ({
    value,
    onValueChange,
    options,
  }: {
    value: string,
    onValueChange: (value: string) => void,
    options: Array<{ value: string, label: string }>,
  }) => (
    <select
      aria-label="selector"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

vi.mock("@/components/hosted-auth-preview", () => ({
  HostedAuthMethodPreview: () => <div>Hosted auth preview</div>,
}));

vi.mock("@/components/router", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("@/components/stripe-wordmark", () => ({
  StripeWordmark: () => <div>Stripe</div>,
}));

vi.mock("@/components/ui", () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BrowserFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: ({ children, type, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type ?? "button"} {...props}>{children}</button>
  ),
  Skeleton: ({ children, ...props }: { children?: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Switch: () => <button type="button">switch</button>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  cn: (...classNames: Array<string | false | null | undefined>) => classNames.filter(Boolean).join(" "),
}));

vi.mock("@/lib/env", () => ({
  getPublicEnvVar: (key: string) => mockPublicEnvVars.get(key) ?? "false",
}));

vi.mock("@/components/config-update", () => ({
  useUpdateConfig: () => mockUpdateConfig,
}));

vi.mock("@hexclave/next", () => ({
  AdminOwnedProject: class {},
}));

vi.mock("@hexclave/shared/dist/utils/oauth", () => ({
  allProviders: ["google", "github", "microsoft", "spotify"],
  sharedProviders: ["google", "github", "microsoft", "spotify"],
}));

vi.mock("@hexclave/shared/dist/utils/promises", () => ({
  runAsynchronously: (promiseOrFn: Promise<unknown> | (() => Promise<unknown>)) => (
    typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn
  ),
  runAsynchronouslyWithAlert: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("./components", () => ({
  DomainSetupTransitionState: () => <div>Domain setup transition</div>,
  ModeNotImplementedCard: () => <div>Mode not implemented</div>,
  OnboardingAppCard: () => <div>App card</div>,
  EmailThemePicker: () => <div>Email theme picker</div>,
  SetupNewProjectPage: ({ configFile }: { configFile?: string }) => (
    <div>
      <h1>Set up Hexclave in your project</h1>
      {configFile != null && <pre>{configFile}</pre>}
    </div>
  ),
  NewProjectEntryPage: ({ onSelect }: {
    onSelect: (choice: "setup-new" | "deploy") => void,
  }) => (
    <div>
      <button type="button" onClick={() => onSelect("setup-new")}>Add Hexclave to a project</button>
      <button type="button" onClick={() => onSelect("deploy")}>Deploy existing project</button>
    </div>
  ),
  OnboardingPage: ({
    title,
    subtitle,
    children,
    primaryAction,
    secondaryAction,
  }: {
    title: string,
    subtitle?: string,
    children: ReactNode,
    primaryAction: ReactNode,
    secondaryAction?: ReactNode,
  }) => (
    <div>
      <h1>{title}</h1>
      {subtitle != null && <p>{subtitle}</p>}
      <div>{children}</div>
      <div>{primaryAction}</div>
      <div>{secondaryAction}</div>
    </div>
  ),
  WelcomeSlide: ({ onFinish }: { onFinish: () => void }) => (
    <div>
      <h1>Welcome to Hexclave</h1>
      <button type="button" onClick={onFinish}>Get Started</button>
    </div>
  ),
}));

vi.mock("./link-existing-onboarding", () => ({
  LinkExistingOnboarding: () => <div>Link existing onboarding</div>,
}));

import { ProjectOnboardingWizard } from "./project-onboarding-wizard";
import { normalizeProjectOnboardingState, orderedAppIds, REQUIRED_APP_IDS } from "./shared";
import { ALL_APPS, getParentAppId, type AppId } from "@hexclave/shared/dist/apps/apps-config";

afterEach(() => {
  cleanup();
  mockUpdateConfig.mockClear();
  mockPublicEnvVars.clear();
});

function createDeferred<T>() {
  let resolveDeferred: (value: T | PromiseLike<T>) => void = () => {
    throw new Error("Deferred promise was resolved before initialization.");
  };
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return {
    promise,
    resolve: resolveDeferred,
  };
}

describe("ProjectOnboardingWizard", () => {
  it("offers the new first-time setup and production deployment paths", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(testDir, "project-onboarding-wizard.tsx"), "utf-8");
    const componentsSource = readFileSync(join(testDir, "components.tsx"), "utf-8");

    expect(componentsSource).toContain("Welcome to Hexclave!");
    expect(componentsSource).toContain("What would you like to do?");
    expect(componentsSource).toContain("Add Hexclave to a project");
    expect(componentsSource).toContain("What will you use Hexclave for?");
    expect(componentsSource).toContain("Do you want to install any other apps?");
    expect(componentsSource).toContain("Not sure / Decide later");
    expect(componentsSource).toContain("Search products...");
    expect(componentsSource).toContain("Choose the first app you want to install now");
    expect(componentsSource).toContain('["authentication", "analytics", "payments"]');
    expect(componentsSource).toContain("expandAppSoftRequirements([...installableApps, \"analytics\"])");
    expect(componentsSource).toContain("parseOnboardingAppSearchParam");
    expect(componentsSource).toContain("getInstallableAppId");
    expect(componentsSource).toContain("text-amber-500");
    expect(componentsSource).toContain("Deploy my existing Hexclave project to production");
    expect(componentsSource).toContain("I just want to look around");
    expect(componentsSource).toContain("https://preview.hexclave.com");
    expect(componentsSource).toContain("Where is your project currently?");
    expect(componentsSource).toContain("Set up the Hexclave SDK");
    expect(componentsSource).toContain("Install Hexclave in your local project, then continue.");
    expect(componentsSource).toContain("On my computer (local)");
    expect(componentsSource).toContain("On GitHub");
    expect(componentsSource).toContain('stepKey="post-install-deployment-location"');
    expect(componentsSource).toContain('title="Welcome to Hexclave"');
    expect(componentsSource).toContain("you can restart your dev command and access the local dashboard on");
    expect(componentsSource).toContain("http://localhost:26700");
    expect(componentsSource).toContain("Deploy my project to production");
    expect(componentsSource).toContain("Advanced");
    expect(componentsSource).toContain("Create plain production project");
    expect(componentsSource).toContain("Only recommended if you're an expert at using Hexclave");
    expect(source).toContain('source === "plain-production"');
    expect(source).toContain('status: "apps_selection"');
    expect(source).toContain("NewProjectEntryPage");
    expect(source).toContain("DeploymentChoicePage");
  });

  it("keeps the development environment start screen separate from deployment choices", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(testDir, "project-onboarding-wizard.tsx"), "utf-8");

    expect(source).toContain("if (isDevelopmentEnvironment)");
    expect(source).toContain("You are running Hexclave with the local dashboard.");
    expect(source).toContain("This local project is running locally and ready to get started.");
  });

  it("starts the configuration wizard when adding Hexclave to an existing onboarding project", async () => {
    const saveOnboardingProgress = vi.fn(async () => {});
    const setMode = vi.fn();

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: true },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
            listEmailThemes: vi.fn(async () => []),
            getStripeAccountInfo: vi.fn(async () => null),
            useEmailThemes: () => [],
            useStripeAccountInfo: () => null,
          },
        } as never}
        status="config_choice"
        onboardingState={null}
        mode={null}
        setMode={setMode}
        saveOnboardingProgress={saveOnboardingProgress}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Hexclave to a project" }));

    await waitFor(() => {
      expect(saveOnboardingProgress).toHaveBeenCalledWith({
        status: "apps_selection",
        onboardingState: expect.objectContaining({
          selected_config_choice: "create-new",
        }),
      });
    });
    expect(setMode).not.toHaveBeenCalledWith("setup-new");
  });

  it("uses manual GitHub setup without connecting a GitHub account", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(testDir, "link-existing-onboarding.tsx"), "utf-8");

    expect(source).toContain("No GitHub account connection is required.");
    expect(source).toContain("Set repository secrets");
    expect(source).toContain("Generate Hexclave secrets");
    expect(source).toContain("Create the workflow file");
    expect(source).toContain("Run the workflow & make sure it completes successfully");
    expect(source).toContain("Awaiting config");
    expect(source).toContain("Please run the GitHub workflow before proceeding");
    expect(source).toContain("Waiting for the GitHub workflow to push your config");
    expect(source).toContain("AI Prompt");
    expect(source).toContain("buildGithubWorkflowAiPrompt");
    expect(source).toContain("getOnboardingRemindersPrompt");
    expect(source).toContain("OnboardingAiPromptBlock");
    expect(source).toContain("githubPollingStartedRef");
    expect(source).not.toContain("Choose the workflow paths");
    expect(source).not.toContain("I've added the workflow");
    expect(source).not.toContain("getOrLinkConnectedAccount");
    expect(source).not.toContain("Connect GitHub account");
  });

  it("prefixes non-prod API and dashboard URLs into local CLI commands", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(testDir, "link-existing-onboarding.tsx"), "utf-8");

    expect(source).toContain("HEXCLAVE_API_URL=");
    expect(source).toContain("HEXCLAVE_DASHBOARD_URL=");
    expect(source).toContain("buildCliCommandEnvPrefix");
    expect(source).toContain('includeDashboardUrl: true');
  });

  it("shows an explicit Go back button on the first-time setup screen", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(testDir, "components.tsx"), "utf-8");

    expect(source).toContain('stepKey="setup-new-project"');
    expect(source).toContain("Go back");
  });

  it("uses the Mintlify docs setup prompt on the first-time setup screen", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(testDir, "components.tsx"), "utf-8");

    expect(source).toContain("aiSetupPrompt");
    expect(source).toContain("AI Prompt");
    expect(source).toContain("Manual Installation");
    expect(source).toContain("OnboardingAiPromptBlock");
    expect(source).toContain("formatApproximateTokenCountLabel");
    expect(source).toContain("ONBOARDING_AI_PROMPT_PREVIEW_HEIGHT_PX");
    expect(source).toContain("Open Getting Started guide");
    expect(source).not.toContain("buildCloudSetupPrompt");
  });

  it("keeps the hosted auth preview interactive", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(testDir, "project-onboarding-wizard.tsx"), "utf-8");

    const previewBlockMatch = source.match(/(<HostedAuthMethodPreview[^>]*\/>)/);
    expect(previewBlockMatch).not.toBeNull();
    const previewBlock = previewBlockMatch![1];

    expect(previewBlock).not.toContain("pointer-events-none");
    expect(previewBlock).not.toContain("inert");
    expect(previewBlock).not.toContain("bg-transparent");
  });

  it("scales the auth preview without squeezing its internal layout", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(testDir, "project-onboarding-wizard.tsx"), "utf-8");

    expect(source).toContain("scale-[0.6]");
    expect(source).toContain("origin-center");
    expect(source).toContain("md:grid-cols-[minmax(260px,2fr)_minmax(0,2fr)]");
    expect(source).not.toContain("md:w-[60%]");
  });

  it("keeps required apps when normalizing persisted onboarding state", () => {
    const normalizedState = normalizeProjectOnboardingState({
      selected_config_choice: "create-new",
      selected_apps: [],
      selected_sign_in_methods: [],
      selected_email_theme_id: null,
      selected_payments_country: "US",
    });

    expect(normalizedState.selected_apps).toEqual(REQUIRED_APP_IDS);
  });

  it("preserves OAuth sign-in methods in development environments", () => {
    const normalizedState = normalizeProjectOnboardingState({
      selected_config_choice: "create-new",
      selected_apps: [],
      selected_sign_in_methods: ["credential", "google", "github", "microsoft"],
      selected_email_theme_id: null,
      selected_payments_country: "US",
    }, { developmentEnvironment: true });

    expect(normalizedState.selected_sign_in_methods).toMatchInlineSnapshot(`
      [
        "credential",
        "google",
        "github",
        "microsoft",
      ]
    `);
  });

  it("does not offer alpha apps during app selection", () => {
    const alphaAppIds = Object.entries(ALL_APPS)
      .filter(([, app]) => app.stage === "alpha")
      .map(([appId]) => appId);

    for (const alphaAppId of alphaAppIds) {
      expect(orderedAppIds()).not.toContain(alphaAppId);
    }
  });

  it("does not offer sub-apps during app selection", () => {
    const subAppIds = (Object.keys(ALL_APPS) as AppId[]).filter((appId) => getParentAppId(appId) != null);

    for (const subAppId of subAppIds) {
      expect(orderedAppIds()).not.toContain(subAppId);
    }
  });

  it("does not call email theme APIs on early onboarding steps", () => {
    const useEmailThemes = vi.fn(() => {
      throw new Error("Email themes should not load on the app selection step.");
    });
    const useStripeAccountInfo = vi.fn(() => {
      throw new Error("Stripe account info should not load on the app selection step.");
    });
    const listEmailThemes = vi.fn(async () => []);
    const getEmailPreview = vi.fn(async () => "");
    const getStripeAccountInfo = vi.fn(async () => null);

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: true },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
            listEmailThemes,
            getEmailPreview,
            getStripeAccountInfo,
            useEmailThemes,
            useStripeAccountInfo,
          },
        } as never}
        status="apps_selection"
        onboardingState={null}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={vi.fn(async () => {})}
        onComplete={vi.fn()}
      />,
    );

    expect(listEmailThemes).not.toHaveBeenCalled();
    expect(getEmailPreview).not.toHaveBeenCalled();
    expect(getStripeAccountInfo).not.toHaveBeenCalled();
    expect(useEmailThemes).not.toHaveBeenCalled();
    expect(useStripeAccountInfo).not.toHaveBeenCalled();
  });

  it("saves app selection state and status in one request", async () => {
    const saveOnboardingProgress = vi.fn(async () => {});

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: true },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
            listEmailThemes: vi.fn(async () => []),
            getStripeAccountInfo: vi.fn(async () => null),
            useEmailThemes: () => [],
            useStripeAccountInfo: () => null,
          },
        } as never}
        status="apps_selection"
        onboardingState={null}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={saveOnboardingProgress}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(saveOnboardingProgress).toHaveBeenCalledOnce();
    });
    expect(saveOnboardingProgress).toHaveBeenCalledWith({
      status: "auth_setup",
      onboardingState: expect.objectContaining({
        selected_apps: expect.arrayContaining(["authentication", "emails", "payments"]),
      }),
    });
  });

  it("saves auth setup state and status in one request", async () => {
    const saveOnboardingProgress = vi.fn(async () => {});

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: false },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
            listEmailThemes: vi.fn(async () => []),
            getStripeAccountInfo: vi.fn(async () => null),
            useEmailThemes: () => [],
            useStripeAccountInfo: () => null,
          },
        } as never}
        status="auth_setup"
        onboardingState={null}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={saveOnboardingProgress}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(saveOnboardingProgress).toHaveBeenCalledOnce();
    });
    expect(saveOnboardingProgress).toHaveBeenCalledWith({
      status: "email_theme_setup",
      onboardingState: expect.objectContaining({
        selected_sign_in_methods: expect.arrayContaining(["credential"]),
      }),
    });
  });

  it("saves email theme state and status in one request", async () => {
    const saveOnboardingProgress = vi.fn(async () => {});

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: true },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
            listEmailThemes: vi.fn(async () => []),
            getStripeAccountInfo: vi.fn(async () => null),
            useEmailThemes: () => [{ id: "default", displayName: "Default" }],
            useStripeAccountInfo: () => null,
          },
        } as never}
        status="email_theme_setup"
        onboardingState={null}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={saveOnboardingProgress}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(saveOnboardingProgress).toHaveBeenCalledOnce();
    });
    expect(saveOnboardingProgress).toHaveBeenCalledWith({
      status: "payments_setup",
      onboardingState: expect.objectContaining({
        selected_email_theme_id: "default",
      }),
    });
  });

  it("prefetches Stripe account info on the email theme step without mounting the payments hook", () => {
    const getStripeAccountInfo = vi.fn(async () => null);
    const useStripeAccountInfo = vi.fn(() => {
      throw new Error("Stripe account info should not load before the payments step.");
    });

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: true },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
            listEmailThemes: vi.fn(async () => []),
            getStripeAccountInfo,
            useEmailThemes: () => [{ id: "default", displayName: "Default" }],
            useStripeAccountInfo,
          },
        } as never}
        status="email_theme_setup"
        onboardingState={null}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={vi.fn(async () => {})}
        onComplete={vi.fn()}
      />,
    );

    expect(getStripeAccountInfo).toHaveBeenCalledOnce();
    expect(useStripeAccountInfo).not.toHaveBeenCalled();
  });

  it("renders the static email theme picker without waiting on project theme APIs", () => {
    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: true },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
            getStripeAccountInfo: vi.fn(async () => null),
            useStripeAccountInfo: () => null,
          },
        } as never}
        status="email_theme_setup"
        onboardingState={null}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={vi.fn(async () => {})}
        onComplete={vi.fn()}
      />,
    );

    expect(screen.getByText("Select an email theme")).toBeTruthy();
    expect(screen.getByText("Email theme picker")).toBeTruthy();
  });

  it("shows a payments shimmer instead of the page spinner while Stripe status loads", () => {
    const pendingStripeAccountInfo = new Promise<never>(() => {});

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: true },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
            listEmailThemes: vi.fn(async () => []),
            getStripeAccountInfo: vi.fn(async () => null),
            useEmailThemes: () => [],
            useStripeAccountInfo: () => {
              throw pendingStripeAccountInfo;
            },
          },
        } as never}
        status="payments_setup"
        onboardingState={null}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={vi.fn(async () => {})}
        onComplete={vi.fn()}
      />,
    );

    expect(screen.getByText("Set up payments")).toBeTruthy();
    expect(screen.getByTestId("payments-setup-step-skeleton")).toBeTruthy();
  });

  it("completes onboarding automatically after Stripe setup returns successfully", async () => {
    const saveOnboardingProgress = vi.fn(async () => {});
    const onComplete = vi.fn();

    const project = {
      id: "proj_123",
      config: {
        credentialEnabled: true,
        magicLinkEnabled: false,
        passkeyEnabled: false,
        oauthProviders: [],
      },
      useConfig: () => ({
        apps: {
          installed: {
            authentication: { enabled: true },
            emails: { enabled: true },
            payments: { enabled: true },
          },
        },
        domains: {
          trustedDomains: {},
        },
        emails: {
          selectedThemeId: "default",
          server: {},
        },
      }),
      app: {
        setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
        listEmailThemes: vi.fn(async () => []),
        getStripeAccountInfo: vi.fn(async () => null),
        useEmailThemes: () => [],
        useStripeAccountInfo: () => ({
          account_id: "acct_123",
          charges_enabled: true,
          details_submitted: true,
          payouts_enabled: true,
        }),
      },
    };

    render(
      <ProjectOnboardingWizard
        project={project as never}
        status="payments_setup"
        onboardingState={null}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={saveOnboardingProgress}
        onComplete={onComplete}
      />,
    );

    await waitFor(() => {
      expect(saveOnboardingProgress).toHaveBeenCalledWith({
        status: "welcome",
        onboardingState: expect.objectContaining({
          selected_payments_country: "US",
        }),
      });
    });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("creates a deferred Stripe account when payments setup is deferred for a US project", async () => {
    const saveOnboardingProgress = vi.fn(async () => {});
    const setupPayments = vi.fn(async () => ({ url: "https://example.com" }));

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: true },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments,
            listEmailThemes: vi.fn(async () => []),
            getStripeAccountInfo: vi.fn(async () => null),
            useEmailThemes: () => [],
            useStripeAccountInfo: () => null,
          },
        } as never}
        status="payments_setup"
        onboardingState={null}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={saveOnboardingProgress}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Do Later"));

    await waitFor(() => {
      expect(setupPayments).toHaveBeenCalledOnce();
    });
    expect(saveOnboardingProgress).toHaveBeenCalledWith({
      status: "welcome",
      onboardingState: expect.objectContaining({
        selected_payments_country: "US",
      }),
    });
  });

  it("does not create a Stripe account when payments setup is deferred for an unsupported country", async () => {
    const saveOnboardingProgress = vi.fn(async () => {});
    const setupPayments = vi.fn(async () => ({ url: "https://example.com" }));

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: true },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments,
            listEmailThemes: vi.fn(async () => []),
            getStripeAccountInfo: vi.fn(async () => null),
            useEmailThemes: () => [],
            useStripeAccountInfo: () => null,
          },
        } as never}
        status="payments_setup"
        onboardingState={{
          selected_config_choice: "create-new",
          selected_apps: ["authentication", "emails", "payments"],
          selected_sign_in_methods: ["credential"],
          selected_email_theme_id: "default",
          selected_payments_country: "OTHER",
        }}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={saveOnboardingProgress}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Do Later"));

    await waitFor(() => {
      expect(saveOnboardingProgress).toHaveBeenCalledWith({
        status: "welcome",
        onboardingState: expect.objectContaining({
          selected_payments_country: "OTHER",
        }),
      });
    });
    expect(setupPayments).not.toHaveBeenCalled();
  });

  it("only shows a loading indicator on the deferred payments action while disabling connect", async () => {
    const setupPayments = vi.fn(() => new Promise<{ url: string }>(() => {}));

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: true },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments,
            listEmailThemes: vi.fn(async () => []),
            getStripeAccountInfo: vi.fn(async () => null),
            useEmailThemes: () => [],
            useStripeAccountInfo: () => null,
          },
        } as never}
        status="payments_setup"
        onboardingState={null}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={vi.fn(async () => {})}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Do Later" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Do Later" }).getAttribute("data-loading")).toBe("true");
    });
    expect(screen.getByRole("button", { name: "Do Later" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Connect" }).getAttribute("data-loading")).toBe("false");
  });

  it("only shows a loading indicator on the connect payments action while disabling defer", async () => {
    const setupPayments = vi.fn(() => new Promise<{ url: string }>(() => {}));

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: true },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app: {
            setupPayments,
            listEmailThemes: vi.fn(async () => []),
            getStripeAccountInfo: vi.fn(async () => null),
            useEmailThemes: () => [],
            useStripeAccountInfo: () => null,
          },
        } as never}
        status="payments_setup"
        onboardingState={null}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={vi.fn(async () => {})}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Connect" }).getAttribute("data-loading")).toBe("true");
    });
    expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Do Later" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Do Later" }).getAttribute("data-loading")).toBe("false");
  });

  it("persists shared OAuth providers selected during onboarding before completing", async () => {
    const saveOnboardingProgress = vi.fn(async () => {});
    const onComplete = vi.fn();
    const app = {
      setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
      listEmailThemes: vi.fn(async () => []),
      getStripeAccountInfo: vi.fn(async () => null),
      useEmailThemes: () => [],
      useStripeAccountInfo: () => null,
    };
    const project = {
      id: "proj_123",
      config: {
        credentialEnabled: true,
        magicLinkEnabled: false,
        passkeyEnabled: false,
        oauthProviders: [],
      },
      useConfig: () => ({
        apps: {
          installed: {
            authentication: { enabled: true },
            emails: { enabled: true },
            payments: { enabled: false },
          },
        },
        domains: {
          trustedDomains: {},
        },
        emails: {
          selectedThemeId: "default",
          server: {},
        },
      }),
      app,
      getPushedConfigSource: vi.fn(async () => ({ type: "unlinked" })),
    };

    render(
      <ProjectOnboardingWizard
        project={project as never}
        status="welcome"
        onboardingState={{
          selected_config_choice: "create-new",
          selected_apps: ["authentication", "emails", "payments", "analytics"],
          selected_sign_in_methods: ["credential", "magicLink", "google"],
          selected_email_theme_id: "default",
          selected_payments_country: "US",
        }}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={saveOnboardingProgress}
        onComplete={onComplete}
      />,
    );

    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalledTimes(2);
      expect(mockUpdateConfig).toHaveBeenNthCalledWith(1, {
        adminApp: app,
        configUpdate: {
          "auth.password.allowSignIn": true,
          "auth.otp.allowSignIn": true,
          "emails.selectedThemeId": "default",
          "apps.installed.authentication.enabled": true,
          "apps.installed.emails.enabled": true,
          "apps.installed.payments.enabled": true,
          "apps.installed.analytics.enabled": true,
        },
        pushable: true,
      });
      expect(mockUpdateConfig).toHaveBeenNthCalledWith(2, {
        adminApp: app,
        configUpdate: {
          "auth.oauth.providers.google": {
            type: "google",
            isShared: true,
            allowSignIn: true,
            allowConnectedAccounts: true,
          },
          "auth.oauth.providers.github": null,
          "auth.oauth.providers.microsoft": null,
        },
        pushable: false,
      });
    });
    expect(saveOnboardingProgress).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Get Started" }));

    await waitFor(() => {
      expect(saveOnboardingProgress).toHaveBeenCalledWith({ status: "completed", onboardingState: null });
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it("waits for Get Started before applying RDE onboarding config", async () => {
    mockPublicEnvVars.set("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT", "true");
    const saveOnboardingProgress = vi.fn(async () => {});
    const onComplete = vi.fn();
    const getPushedConfigSource = vi.fn(async () => ({ type: "unlinked" }));
    const app = {
      setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
      listEmailThemes: vi.fn(async () => []),
      getStripeAccountInfo: vi.fn(async () => null),
      useEmailThemes: () => [],
      useStripeAccountInfo: () => null,
    };

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: false },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app,
          getPushedConfigSource,
        } as never}
        status="welcome"
        onboardingState={{
          selected_config_choice: "create-new",
          selected_apps: ["authentication", "emails", "analytics"],
          selected_sign_in_methods: ["credential", "google"],
          selected_email_theme_id: "default",
          selected_payments_country: "US",
        }}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={saveOnboardingProgress}
        onComplete={onComplete}
      />,
    );

    await Promise.resolve();

    expect(getPushedConfigSource).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Get Started" }));

    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        adminApp: app,
        configUpdate: {
          "auth.password.allowSignIn": true,
          "emails.selectedThemeId": "default",
          "apps.installed.authentication.enabled": true,
          "apps.installed.emails.enabled": true,
          "apps.installed.analytics.enabled": true,
          "auth.oauth.providers.google": {
            type: "google",
            allowSignIn: true,
            allowConnectedAccounts: true,
          },
          "auth.oauth.providers.github": null,
          "auth.oauth.providers.microsoft": null,
        },
        pushable: true,
      });
      expect(saveOnboardingProgress).toHaveBeenCalledWith({ status: "completed", onboardingState: null });
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it("waits for the in-flight welcome config save before marking onboarding completed", async () => {
    const saveOnboardingProgress = vi.fn(async () => {});
    const onComplete = vi.fn();
    const branchConfigSave = createDeferred<boolean>();
    const environmentConfigSave = createDeferred<boolean>();
    mockUpdateConfig.mockImplementationOnce(async () => await branchConfigSave.promise);
    mockUpdateConfig.mockImplementationOnce(async () => await environmentConfigSave.promise);
    const app = {
      setupPayments: vi.fn(async () => ({ url: "https://example.com" })),
      listEmailThemes: vi.fn(async () => []),
      getStripeAccountInfo: vi.fn(async () => null),
      useEmailThemes: () => [],
      useStripeAccountInfo: () => null,
    };

    render(
      <ProjectOnboardingWizard
        project={{
          id: "proj_123",
          config: {
            credentialEnabled: true,
            magicLinkEnabled: false,
            passkeyEnabled: false,
            oauthProviders: [],
          },
          useConfig: () => ({
            apps: {
              installed: {
                authentication: { enabled: true },
                emails: { enabled: true },
                payments: { enabled: false },
              },
            },
            domains: {
              trustedDomains: {},
            },
            emails: {
              selectedThemeId: "default",
              server: {},
            },
          }),
          app,
          getPushedConfigSource: vi.fn(async () => ({ type: "unlinked" })),
        } as never}
        status="welcome"
        onboardingState={{
          selected_config_choice: "create-new",
          selected_apps: ["authentication", "emails"],
          selected_sign_in_methods: ["credential"],
          selected_email_theme_id: "default",
          selected_payments_country: "US",
        }}
        mode={null}
        setMode={vi.fn()}
        saveOnboardingProgress={saveOnboardingProgress}
        onComplete={onComplete}
      />,
    );

    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalledOnce();
    });

    fireEvent.click(screen.getByRole("button", { name: "Get Started" }));

    await Promise.resolve();
    expect(saveOnboardingProgress).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();

    branchConfigSave.resolve(true);

    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalledTimes(2);
    });
    expect(saveOnboardingProgress).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();

    environmentConfigSave.resolve(true);

    await waitFor(() => {
      expect(saveOnboardingProgress).toHaveBeenCalledWith({ status: "completed", onboardingState: null });
      expect(onComplete).toHaveBeenCalled();
    });
  });
});

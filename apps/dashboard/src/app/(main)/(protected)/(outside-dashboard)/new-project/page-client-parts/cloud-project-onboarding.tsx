"use client";

import { useUpdateConfig } from "@/components/config-update";
import { DesignButton, DesignCard, DesignPillToggle } from "@/components/design-components";
import { HostedAuthMethodPreview } from "@/components/hosted-auth-preview";
import { BrowserFrame, Switch, Typography, cn } from "@/components/ui";
import { buildSelectedOnboardingConfigFile } from "@/lib/setup-prompt";
import { type AdminOwnedProject } from "@hexclave/next";
import { ALL_APPS, expandAppSoftRequirements, type AppId } from "@hexclave/shared/dist/apps/apps-config";
import { type EnvironmentConfigOverrideOverride } from "@hexclave/shared/dist/config/schema";
import { DEFAULT_EMAIL_THEME_ID } from "@hexclave/shared/dist/helpers/emails";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useState } from "react";

import {
  DeploymentChoicePage,
  EmailThemePicker,
  NewProjectEntryPage,
  OnboardingPage,
  ProductSelectionPage,
  SetupNewProjectPage,
  WelcomeSlide,
} from "./components";
import { LinkExistingOnboarding } from "./link-existing-onboarding";
import {
  ALL_APP_IDS,
  SHARED_OAUTH_SIGN_IN_METHODS,
  SIGN_IN_METHODS,
  type ProjectOnboardingStatus,
  type SignInMethod,
  type TimelineStep,
} from "./shared";

export const CLOUD_ONBOARDING_STEPS = [
  "welcome-to-hexclave",
  "select-primary-app",
  "select-additional-apps",
  "configure-authentication",
  "select-email-theme",
  "setup-sdk",
  "development-setup-complete",
  "where-is-project",
  "cli-push",
  "setup-github-workflow",
  "onboarding-complete",
] as const;

export type CloudOnboardingStep = (typeof CLOUD_ONBOARDING_STEPS)[number];
export type CloudOnboardingJourney = "add" | "deploy-existing";
export type CloudProjectLocation = "local" | "github";

export type CloudProjectOnboardingState = {
  version: 1,
  step: CloudOnboardingStep,
  journey: CloudOnboardingJourney,
  primary_app_id: AppId | null,
  additional_app_ids: AppId[],
  selected_apps: AppId[],
  selected_sign_in_methods: SignInMethod[],
  selected_email_theme_id: string | null,
  project_location: CloudProjectLocation | null,
};

type LegacyOnboardingState = {
  selected_config_choice: "create-new" | "link-existing",
  selected_apps: AppId[],
  selected_sign_in_methods: SignInMethod[],
  selected_email_theme_id: string | null,
};

const ENTRY_TIMELINE: TimelineStep[] = [{ id: "config_choice", label: "Setup" }];
const AUTH_TIMELINE: TimelineStep[] = [{ id: "auth_setup", label: "Authentication" }];
const EMAIL_TIMELINE: TimelineStep[] = [{ id: "email_theme_setup", label: "Email theme" }];
const SDK_TIMELINE: TimelineStep[] = [{ id: "welcome", label: "SDK" }];
const COMPLETION_TIMELINE: TimelineStep[] = [{ id: "welcome", label: "Finish" }];
const DEFAULT_SIGN_IN_METHODS: SignInMethod[] = ["credential", "magicLink", "google", "github"];

function isAppId(value: unknown): value is AppId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ALL_APPS, value);
}

function isSignInMethod(value: unknown): value is SignInMethod {
  return typeof value === "string" && SIGN_IN_METHODS.some((method) => method.id === value);
}

function isCloudOnboardingStep(value: unknown): value is CloudOnboardingStep {
  return typeof value === "string" && CLOUD_ONBOARDING_STEPS.some((step) => step === value);
}

function isCloudOnboardingJourney(value: unknown): value is CloudOnboardingJourney {
  return value === "add" || value === "deploy-existing";
}

function isCloudProjectLocation(value: unknown): value is CloudProjectLocation {
  return value === "local" || value === "github";
}

function uniqueOrderedApps(values: Iterable<AppId>): AppId[] {
  const selected = new Set(values);
  return ALL_APP_IDS.filter((appId) => selected.has(appId));
}

function uniqueOrderedSignInMethods(values: Iterable<SignInMethod>): SignInMethod[] {
  const selected = new Set(values);
  return SIGN_IN_METHODS.map((method) => method.id).filter((method) => selected.has(method));
}

export function createInitialCloudOnboardingState(): CloudProjectOnboardingState {
  return {
    version: 1,
    step: "welcome-to-hexclave",
    journey: "add",
    primary_app_id: null,
    additional_app_ids: [],
    selected_apps: [],
    selected_sign_in_methods: DEFAULT_SIGN_IN_METHODS,
    selected_email_theme_id: DEFAULT_EMAIL_THEME_ID,
    project_location: null,
  };
}

export function isCloudProjectOnboardingState(value: unknown): value is CloudProjectOnboardingState {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const version = value["version"];
  const step = value["step"];
  const journey = value["journey"];
  const primaryAppId = value["primary_app_id"];
  const additionalAppIds = value["additional_app_ids"];
  const selectedApps = value["selected_apps"];
  const selectedSignInMethods = value["selected_sign_in_methods"];
  const selectedEmailThemeId = value["selected_email_theme_id"];
  const projectLocation = value["project_location"];
  return (
    version === 1
    && isCloudOnboardingStep(step)
    && isCloudOnboardingJourney(journey)
    && (primaryAppId === null || isAppId(primaryAppId))
    && Array.isArray(additionalAppIds)
    && additionalAppIds.every(isAppId)
    && Array.isArray(selectedApps)
    && selectedApps.every(isAppId)
    && Array.isArray(selectedSignInMethods)
    && selectedSignInMethods.every(isSignInMethod)
    && (selectedEmailThemeId === null || typeof selectedEmailThemeId === "string")
    && (projectLocation === null || isCloudProjectLocation(projectLocation))
  );
}

function readLegacyOnboardingState(value: unknown): LegacyOnboardingState | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const configChoice = value["selected_config_choice"];
  const apps = value["selected_apps"];
  const methods = value["selected_sign_in_methods"];
  const emailThemeId = value["selected_email_theme_id"];
  if (
    (configChoice !== "create-new" && configChoice !== "link-existing")
    || !Array.isArray(apps)
    || !apps.every(isAppId)
    || !Array.isArray(methods)
    || !methods.every(isSignInMethod)
    || (emailThemeId !== null && typeof emailThemeId !== "string")
  ) {
    return null;
  }
  return {
    selected_config_choice: configChoice,
    selected_apps: uniqueOrderedApps(apps),
    selected_sign_in_methods: uniqueOrderedSignInMethods(methods),
    selected_email_theme_id: emailThemeId,
  };
}

function legacyStep(status: ProjectOnboardingStatus, legacy: LegacyOnboardingState | null): CloudOnboardingStep {
  if (status === "completed") return "onboarding-complete";
  if (status === "apps_selection") return "select-primary-app";
  if (status === "auth_setup") return "configure-authentication";
  if (status === "domain_setup" || status === "email_theme_setup") return "select-email-theme";
  if (status === "payments_setup" || status === "welcome") return "setup-sdk";
  if (legacy?.selected_config_choice === "link-existing") return "where-is-project";
  return "welcome-to-hexclave";
}

export function normalizeCloudProjectOnboardingState(
  value: unknown,
  status: ProjectOnboardingStatus,
): CloudProjectOnboardingState {
  if (isCloudProjectOnboardingState(value)) {
    return {
      ...value,
      additional_app_ids: uniqueOrderedApps(value.additional_app_ids),
      selected_apps: uniqueOrderedApps(value.selected_apps),
      selected_sign_in_methods: uniqueOrderedSignInMethods(value.selected_sign_in_methods),
    };
  }
  const legacy = readLegacyOnboardingState(value);
  const initial = createInitialCloudOnboardingState();
  return {
    ...initial,
    step: legacyStep(status, legacy),
    journey: legacy?.selected_config_choice === "link-existing" ? "deploy-existing" : "add",
    additional_app_ids: [],
    selected_apps: legacy?.selected_apps ?? initial.selected_apps,
    selected_sign_in_methods: legacy?.selected_sign_in_methods ?? initial.selected_sign_in_methods,
    selected_email_theme_id: legacy?.selected_email_theme_id ?? initial.selected_email_theme_id,
  };
}

function nextConfigurationStep(selectedApps: readonly AppId[], completedStep: "apps" | "authentication"): CloudOnboardingStep {
  const selected = new Set(selectedApps);
  if (completedStep === "apps" && selected.has("authentication")) {
    return "configure-authentication";
  }
  if (selected.has("emails")) {
    return "select-email-theme";
  }
  return "setup-sdk";
}

function previousConfigurationStep(state: CloudProjectOnboardingState): CloudOnboardingStep {
  const selected = new Set(state.selected_apps);
  if (state.step === "select-email-theme" && selected.has("authentication")) {
    return "configure-authentication";
  }
  if (state.step === "setup-sdk") {
    if (selected.has("emails")) return "select-email-theme";
    if (selected.has("authentication")) return "configure-authentication";
    if (state.primary_app_id != null) return "select-additional-apps";
    return "select-primary-app";
  }
  return "select-additional-apps";
}

function buildConfigFile(state: CloudProjectOnboardingState): string | undefined {
  if (state.journey !== "add" || state.selected_apps.length === 0) {
    return undefined;
  }
  const methods = new Set(state.selected_sign_in_methods);
  return buildSelectedOnboardingConfigFile({
    selectedApps: state.selected_apps,
    passwordEnabled: methods.has("credential"),
    otpEnabled: methods.has("magicLink"),
    passkeyEnabled: methods.has("passkey"),
    sharedOAuthProviderIds: SHARED_OAUTH_SIGN_IN_METHODS.filter((provider) => methods.has(provider)),
    emailThemeId: state.selected_email_theme_id ?? DEFAULT_EMAIL_THEME_ID,
  });
}

function buildBranchConfigUpdate(state: CloudProjectOnboardingState): EnvironmentConfigOverrideOverride {
  const selectedApps = new Set(state.selected_apps);
  const methods = new Set(state.selected_sign_in_methods);
  const update: EnvironmentConfigOverrideOverride = {};
  for (const appId of ALL_APP_IDS) {
    update[`apps.installed.${appId}.enabled`] = selectedApps.has(appId);
  }
  update["auth.password.allowSignIn"] = selectedApps.has("authentication") && methods.has("credential");
  update["auth.otp.allowSignIn"] = selectedApps.has("authentication") && methods.has("magicLink");
  update["auth.passkey.allowSignIn"] = selectedApps.has("authentication") && methods.has("passkey");
  if (selectedApps.has("emails")) {
    update["emails.selectedThemeId"] = state.selected_email_theme_id ?? DEFAULT_EMAIL_THEME_ID;
  }
  return update;
}

function buildEnvironmentConfigUpdate(state: CloudProjectOnboardingState): EnvironmentConfigOverrideOverride {
  const selectedApps = new Set(state.selected_apps);
  const methods = new Set(state.selected_sign_in_methods);
  const update: EnvironmentConfigOverrideOverride = {};
  for (const providerId of SHARED_OAUTH_SIGN_IN_METHODS) {
    update[`auth.oauth.providers.${providerId}`] = (
      selectedApps.has("authentication") && methods.has(providerId)
    ) ? {
        type: providerId,
        isShared: true,
        allowSignIn: true,
        allowConnectedAccounts: true,
      } : null;
  }
  return update;
}

function AuthenticationStep(props: {
  projectName: string,
  initialMethods: SignInMethod[],
  saving: boolean,
  onBack: () => void,
  onContinue: (methods: SignInMethod[]) => void,
}) {
  const [methods, setMethods] = useState(() => new Set(props.initialMethods));
  const [mobileTab, setMobileTab] = useState<"methods" | "preview">("methods");
  const previewProject = {
    displayName: props.projectName,
    config: {
      signUpEnabled: true,
      credentialEnabled: methods.has("credential"),
      magicLinkEnabled: methods.has("magicLink"),
      passkeyEnabled: methods.has("passkey"),
      oauthProviders: SHARED_OAUTH_SIGN_IN_METHODS
        .filter((providerId) => methods.has(providerId))
        .map((providerId) => ({ id: providerId, type: "shared" as const })),
    },
  };
  return (
    <OnboardingPage
      stepKey="cloud-configure-authentication"
      title="Configure authentication"
      subtitle="Choose which sign-in methods to include in your config."
      steps={AUTH_TIMELINE}
      currentStep="auth_setup"
      onBack={props.onBack}
      disabled={props.saving}
      wide
      primaryAction={(
        <DesignButton
          className="w-full rounded-full"
          loading={props.saving}
          disabled={methods.size === 0}
          onClick={() => props.onContinue(uniqueOrderedSignInMethods(methods))}
        >
          Continue
        </DesignButton>
      )}
    >
      <DesignCard
        glassmorphic={false}
        contentClassName="overflow-hidden p-0"
        className="border-0 bg-white/90 ring-1 ring-black/[0.06] dark:bg-white/[0.06] dark:ring-white/[0.10]"
      >
        <div className="flex justify-center border-b border-black/[0.12] px-4 py-3 dark:border-white/[0.06] md:hidden">
          <DesignPillToggle
            options={[{ id: "methods", label: "Sign-in methods" }, { id: "preview", label: "Preview" }]}
            selected={mobileTab}
            onSelect={(id) => setMobileTab(id === "preview" ? "preview" : "methods")}
            size="sm"
            gradient="default"
            className="flex w-full max-w-md justify-center"
          />
        </div>
        <div className="grid md:grid-cols-[minmax(260px,2fr)_minmax(0,2fr)]">
          <div className={cn(
            "flex flex-col justify-center border-b border-black/[0.12] dark:border-white/[0.06] md:border-b-0 md:border-r",
            mobileTab !== "methods" && "max-md:hidden",
          )}>
            <div className="p-4 md:p-6">
              <Typography className="mb-3 text-sm font-medium text-muted-foreground md:mb-4">Sign-in methods</Typography>
              <div className="overflow-hidden rounded-xl bg-white/90 ring-1 ring-black/[0.06] dark:bg-foreground/[0.04] dark:ring-white/[0.06]">
                {SIGN_IN_METHODS.map((method, index) => (
                  <label
                    key={method.id}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-4 px-4 py-3",
                      index !== SIGN_IN_METHODS.length - 1 && "border-b border-black/[0.06] dark:border-white/[0.06]",
                    )}
                  >
                    <span className="text-sm">{method.label}</span>
                    <Switch
                      checked={methods.has(method.id)}
                      onCheckedChange={(checked) => {
                        setMethods((previous) => {
                          const next = new Set(previous);
                          if (checked) next.add(method.id);
                          else next.delete(method.id);
                          return next;
                        });
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div
            aria-hidden="true"
            inert
            className={cn(
              "pointer-events-none flex items-center justify-center bg-foreground/[0.02] px-3 py-3 select-none md:px-4 md:py-4 lg:px-6",
              mobileTab !== "preview" && "max-md:hidden",
            )}
          >
            <div className="relative my-[-20%] w-full origin-center scale-[0.6] transform-gpu">
              <BrowserFrame url="your-website.com/signin" className="w-full">
                <div className="flex min-h-[180px] items-center justify-center px-4 py-3">
                  <HostedAuthMethodPreview project={previewProject} />
                </div>
              </BrowserFrame>
            </div>
          </div>
        </div>
      </DesignCard>
    </OnboardingPage>
  );
}

function EmailThemeStep(props: {
  initialThemeId: string | null,
  saving: boolean,
  onBack: () => void,
  onContinue: (themeId: string) => void,
}) {
  const [themeId, setThemeId] = useState(props.initialThemeId ?? DEFAULT_EMAIL_THEME_ID);
  return (
    <OnboardingPage
      stepKey="cloud-select-email-theme"
      title="Select an email theme"
      subtitle="Pick the built-in theme to include in your config."
      steps={EMAIL_TIMELINE}
      currentStep="email_theme_setup"
      onBack={props.onBack}
      disabled={props.saving}
      wide
      primaryAction={(
        <DesignButton
          className="w-full rounded-full"
          loading={props.saving}
          onClick={() => props.onContinue(themeId)}
        >
          Continue
        </DesignButton>
      )}
    >
      <EmailThemePicker selectedEmailThemeId={themeId} setSelectedEmailThemeId={setThemeId} disabled={props.saving} />
    </OnboardingPage>
  );
}

export function CloudProjectOnboarding(props: {
  project: AdminOwnedProject,
  status: ProjectOnboardingStatus,
  onboardingState: unknown,
  primaryAppFromQuery: AppId | null,
  saveProgress: (update: {
    status?: ProjectOnboardingStatus,
    onboardingState: CloudProjectOnboardingState,
  }) => Promise<void>,
  onComplete: () => void,
}) {
  const state = normalizeCloudProjectOnboardingState(props.onboardingState, props.status);
  const [saving, setSaving] = useState(false);
  const updateConfig = useUpdateConfig();

  const save = async (nextState: CloudProjectOnboardingState, status?: ProjectOnboardingStatus) => {
    setSaving(true);
    try {
      await props.saveProgress({ status, onboardingState: nextState });
    } finally {
      setSaving(false);
    }
  };
  const transition = (nextState: CloudProjectOnboardingState) => {
    return runAsynchronouslyWithAlert(save(nextState));
  };
  const changeStep = (step: CloudOnboardingStep, updates?: Partial<CloudProjectOnboardingState>) => {
    transition({ ...state, ...updates, step });
  };

  if (state.step === "welcome-to-hexclave") {
    return (
      <NewProjectEntryPage
        steps={ENTRY_TIMELINE}
        currentStep="config_choice"
        disabled={saving}
        onSelect={(choice) => {
          if (choice === "setup-new") {
            const primaryApp = props.primaryAppFromQuery;
            changeStep(primaryApp == null ? "select-primary-app" : "select-additional-apps", {
              journey: "add",
              primary_app_id: primaryApp,
              additional_app_ids: [],
              selected_apps: primaryApp == null ? [] : [primaryApp],
              project_location: null,
            });
          } else {
            changeStep("where-is-project", {
              journey: "deploy-existing",
              primary_app_id: null,
              additional_app_ids: [],
              selected_apps: [],
              project_location: null,
            });
          }
        }}
      />
    );
  }

  if (state.step === "select-primary-app" || state.step === "select-additional-apps") {
    const primaryAppId = state.step === "select-primary-app" ? null : state.primary_app_id;
    return (
      <ProductSelectionPage
        key={`${state.step}:${primaryAppId ?? "none"}`}
        steps={ENTRY_TIMELINE}
        currentStep="config_choice"
        disabled={saving}
        initialPrimaryAppId={primaryAppId}
        initialSelectedAppIds={[
          ...(state.primary_app_id == null ? [] : [state.primary_app_id]),
          ...state.additional_app_ids,
        ]}
        onBack={() => changeStep("welcome-to-hexclave")}
        onPrimaryAppSelected={(appId) => changeStep("select-additional-apps", {
          primary_app_id: appId,
          additional_app_ids: [],
          selected_apps: [appId],
        })}
        onClearPrimaryApp={() => changeStep("select-primary-app", {
          primary_app_id: null,
          additional_app_ids: [],
          selected_apps: [],
        })}
        onLetAiDecide={() => changeStep("setup-sdk", {
          primary_app_id: null,
          additional_app_ids: [],
          selected_apps: [],
        })}
        onContinue={(appIds) => {
          const effectiveApps = uniqueOrderedApps(expandAppSoftRequirements([...appIds, "analytics"]));
          const additionalApps = uniqueOrderedApps(appIds).filter((appId) => (
            appId !== state.primary_app_id && appId !== "analytics"
          ));
          changeStep(nextConfigurationStep(effectiveApps, "apps"), {
            additional_app_ids: additionalApps,
            selected_apps: effectiveApps,
          });
        }}
      />
    );
  }

  if (state.step === "configure-authentication") {
    return (
      <AuthenticationStep
        projectName={props.project.displayName}
        initialMethods={state.selected_sign_in_methods}
        saving={saving}
        onBack={() => changeStep("select-additional-apps")}
        onContinue={(methods) => changeStep(nextConfigurationStep(state.selected_apps, "authentication"), {
          selected_sign_in_methods: methods,
        })}
      />
    );
  }

  if (state.step === "select-email-theme") {
    return (
      <EmailThemeStep
        initialThemeId={state.selected_email_theme_id}
        saving={saving}
        onBack={() => changeStep(previousConfigurationStep(state))}
        onContinue={(themeId) => changeStep("setup-sdk", { selected_email_theme_id: themeId })}
      />
    );
  }

  if (state.step === "setup-sdk") {
    return (
      <SetupNewProjectPage
        steps={SDK_TIMELINE}
        currentStep="welcome"
        disabled={saving}
        onBack={() => changeStep(previousConfigurationStep(state))}
        configFile={buildConfigFile(state)}
        onComplete={() => changeStep("development-setup-complete")}
        completionLabel="Continue"
      />
    );
  }

  if (state.step === "development-setup-complete") {
    return (
      <OnboardingPage
        stepKey="development-setup-complete"
        title="Development setup complete!"
        steps={SDK_TIMELINE}
        currentStep="welcome"
        onBack={() => changeStep("setup-sdk")}
        disabled={saving}
        primaryAction={(
          <DesignButton
            className="w-full rounded-full"
            loading={saving}
            onClick={() => changeStep("where-is-project")}
          >
            Continue
          </DesignButton>
        )}
      >
        <DesignCard
          glassmorphic
          className="border-0 bg-white/70 dark:bg-background/60"
          contentClassName="space-y-4 p-6"
        >
          <Typography className="text-sm leading-relaxed">
            After the SDK has been installed, you can restart your dev command. Hexclave is now running locally for development and can be accessed on{" "}
            <a
              href="http://localhost:26700"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-blue-600 underline underline-offset-2 transition-colors hover:text-blue-700 hover:transition-none dark:text-blue-400 dark:hover:text-blue-300"
            >
              http://localhost:26700
            </a>
            .
          </Typography>
          <Typography variant="secondary" className="text-sm leading-relaxed">
            Local development uses the local dashboard, but for production deployments you will need environment variables for Hexclave Cloud. Once you&apos;re ready for this, you can continue on this page.
          </Typography>
        </DesignCard>
      </OnboardingPage>
    );
  }

  if (state.step === "where-is-project") {
    return (
      <DeploymentChoicePage
        stepKey="cloud-project-location"
        steps={ENTRY_TIMELINE}
        currentStep="config_choice"
        disabled={saving}
        showAdvancedProductionOption
        onBack={() => changeStep(state.journey === "add" ? "development-setup-complete" : "welcome-to-hexclave")}
        onSelect={(source) => {
          if (source === "local") {
            changeStep("cli-push", { project_location: "local" });
          } else if (source === "github") {
            changeStep("setup-github-workflow", { project_location: "github" });
          } else {
            runAsynchronouslyWithAlert((async () => {
              setSaving(true);
              try {
                if (state.journey === "add" && state.selected_apps.length > 0) {
                  const branchUpdated = await updateConfig({
                    adminApp: props.project.app,
                    configUpdate: buildBranchConfigUpdate(state),
                    pushable: true,
                  });
                  if (!branchUpdated) throw new Error("Failed to save the project config.");
                  const environmentUpdated = await updateConfig({
                    adminApp: props.project.app,
                    configUpdate: buildEnvironmentConfigUpdate(state),
                    pushable: false,
                  });
                  if (!environmentUpdated) throw new Error("Failed to save the project environment config.");
                }
                await props.saveProgress({
                  onboardingState: { ...state, step: "onboarding-complete", project_location: null },
                });
              } finally {
                setSaving(false);
              }
            })());
          }
        }}
      />
    );
  }

  if (state.step === "cli-push" || state.step === "setup-github-workflow") {
    return (
      <LinkExistingOnboarding
        project={props.project}
        steps={ENTRY_TIMELINE}
        disabled={saving}
        currentStep="config_choice"
        deploymentSource={state.step === "cli-push" ? "local" : "github"}
        onStepClick={() => {}}
        onBack={() => changeStep("where-is-project", { project_location: null })}
        onContinueAfterLink={async () => {
          await save({ ...state, step: "onboarding-complete" });
        }}
      />
    );
  }

  return (
    <WelcomeSlide
      steps={COMPLETION_TIMELINE}
      saving={saving}
      enabledApps={{}}
      onFinish={() => runAsynchronouslyWithAlert((async () => {
        await save(state, "completed");
        props.onComplete();
      })())}
    />
  );
}

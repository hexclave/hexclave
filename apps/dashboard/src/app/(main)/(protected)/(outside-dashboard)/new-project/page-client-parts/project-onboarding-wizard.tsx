"use client";

import { DesignCard, DesignPillToggle } from "@/components/design-components";
import { DesignAlert } from "@/components/design-components/alert";
import { DesignButton } from "@/components/design-components/button";
import { DesignSelectorDropdown } from "@/components/design-components/select";
import { HostedAuthMethodPreview } from "@/components/hosted-auth-preview";
import { useRouter } from "@/components/router";
import { StripeWordmark } from "@/components/stripe-wordmark";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  BrowserFrame,
  Button,
  Skeleton,
  cn,
  Switch,
  TooltipProvider,
  Typography,
} from "@/components/ui";
import { getPublicEnvVar } from "@/lib/env";
import { buildSelectedOnboardingConfigFile } from "@/lib/setup-prompt";
import { useUpdateConfig } from "@/components/config-update";
import {
  ArrowsClockwiseIcon,
  ChartBarIcon,
  CheckCircleIcon,
  ShieldCheckIcon,
  WarningCircleIcon,
  WebhooksLogoIcon,
} from "@phosphor-icons/react";
import { type AdminOwnedProject } from "@hexclave/next";
import { expandAppSoftRequirements, type AppId } from "@hexclave/shared/dist/apps/apps-config";
import { type EnvironmentConfigOverrideOverride } from "@hexclave/shared/dist/config/schema";
import { runAsynchronously, runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DeploymentChoicePage,
  DomainSetupTransitionState,
  EmailThemePicker,
  NewProjectEntryPage,
  OnboardingAppCard,
  OnboardingPage,
  SetupNewProjectPage,
  WelcomeSlide,
} from "./components";
import {
  ALL_APP_IDS,
  buildLinkExistingTimeline,
  buildTimeline,
  deriveInitialApps,
  deriveInitialSignInMethods,
  getStepIndex,
  normalizeProjectOnboardingState,
  createProjectOnboardingState,
  type OnboardingConfigChoice,
  type OnboardingPaymentsCountry,
  type OnboardingProgressUpdate,
  orderedAppIds,
  PAYMENT_COUNTRY_OPTIONS,
  PRIMARY_APP_IDS,
  type ProjectOnboardingState,
  type ProjectOnboardingStatus,
  REQUIRED_APP_IDS,
  SHARED_OAUTH_SIGN_IN_METHODS,
  SIGN_IN_METHODS,
  type SignInMethod,
} from "./shared";
import { LinkExistingOnboarding } from "./link-existing-onboarding";

export function ProjectOnboardingWizard(props: {
  project: AdminOwnedProject,
  status: ProjectOnboardingStatus,
  onboardingState: ProjectOnboardingState | null,
  mode: string | null,
  setMode: (mode: string | null) => void,
  saveOnboardingProgress: (update: OnboardingProgressUpdate) => Promise<void>,
  onComplete: () => void,
}) {
  const router = useRouter();
  const { project, status, onboardingState, setMode, saveOnboardingProgress, onComplete } = props;
  const isRemoteDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";
  const isDevelopmentEnvironment = isRemoteDevelopmentEnvironment;
  const completeConfig = project.useConfig();
  const updateConfig = useUpdateConfig();
  const finishProjectOnboarding = onComplete;
  const deriveCurrentOnboardingState = useCallback((onboardingStatus: ProjectOnboardingStatus): ProjectOnboardingState => {
    const defaultState = createProjectOnboardingState({
      selectedConfigChoice: "create-new",
      selectedApps: deriveInitialApps(completeConfig, onboardingStatus),
      selectedSignInMethods: deriveInitialSignInMethods(project, onboardingStatus),
      selectedEmailThemeId: completeConfig.emails.selectedThemeId,
      selectedPaymentsCountry: "US",
      developmentEnvironment: isDevelopmentEnvironment,
    });
    if (onboardingState == null) {
      return defaultState;
    }
    return normalizeProjectOnboardingState(onboardingState, { developmentEnvironment: isDevelopmentEnvironment });
  }, [completeConfig, isDevelopmentEnvironment, onboardingState, project]);
  const initialOnboardingState = deriveCurrentOnboardingState(status);
  const [saving, setSaving] = useState(false);
  const [selectedApps, setSelectedApps] = useState<Set<AppId>>(() => new Set(initialOnboardingState.selected_apps));
  const [signInMethods, setSignInMethods] = useState<Set<SignInMethod>>(() => new Set(initialOnboardingState.selected_sign_in_methods));
  const [trustedDomain, setTrustedDomain] = useState("");
  const [domainHandlerPath, setDomainHandlerPath] = useState("/handler");
  const [managedSubdomain, setManagedSubdomain] = useState("");
  const [managedSenderLocalPart, setManagedSenderLocalPart] = useState("");
  const [managedDomainSetupStatus, setManagedDomainSetupStatus] = useState<string | null>(null);
  const [selectedEmailThemeId, setSelectedEmailThemeId] = useState<string | null>(initialOnboardingState.selected_email_theme_id);
  const [selectedPaymentsCountry, setSelectedPaymentsCountry] = useState<OnboardingPaymentsCountry>(initialOnboardingState.selected_payments_country);
  const [selectedConfigChoice, setSelectedConfigChoice] = useState<OnboardingConfigChoice>(initialOnboardingState.selected_config_choice);
  const [authSetupMobileTab, setAuthSetupMobileTab] = useState<"methods" | "preview">("methods");
  const [domainSetupAutoAdvanceError, setDomainSetupAutoAdvanceError] = useState<string | null>(null);
  const [domainSetupAutoAdvancing, setDomainSetupAutoAdvancing] = useState(false);
  const [paymentsSetupAction, setPaymentsSetupAction] = useState<"defer" | "connect" | null>(null);
  const previousProjectId = useRef<string | null>(null);
  const finalConfigSavePromiseRef = useRef<Promise<boolean> | null>(null);
  // Soft requirements stay out of the picker UI, but still drive timeline/config.
  const effectiveSelectedApps = useMemo(
    () => expandAppSoftRequirements(selectedApps),
    [selectedApps],
  );

  const runWithSaving = useCallback(async (fn: () => Promise<void>) => {
    setSaving(true);
    try {
      await fn();
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    if (previousProjectId.current === project.id) {
      return;
    }
    previousProjectId.current = project.id;

    const onboardingState = deriveCurrentOnboardingState(status);
    setSelectedApps(new Set(onboardingState.selected_apps));
    setSignInMethods(new Set(onboardingState.selected_sign_in_methods));

    const trustedDomains = Object.values(completeConfig.domains.trustedDomains)
      .filter((entry) => entry.baseUrl != null)
      .map((entry) => ({ baseUrl: entry.baseUrl, handlerPath: entry.handlerPath }));

    if (trustedDomains[0]) {
      const trustedDomainEntry = trustedDomains[0];
      if (trustedDomainEntry.baseUrl == null) {
        throw new Error("Invariant violated: trusted domain entry is missing a baseUrl.");
      }
      setTrustedDomain(trustedDomainEntry.baseUrl);
      setDomainHandlerPath(trustedDomainEntry.handlerPath);
    } else {
      setTrustedDomain("");
      setDomainHandlerPath("/handler");
    }

    const serverConfig = completeConfig.emails.server;
    setManagedSubdomain(serverConfig.managedSubdomain ?? "");
    setManagedSenderLocalPart(serverConfig.managedSenderLocalPart ?? "");
    setSelectedEmailThemeId(onboardingState.selected_email_theme_id);
    setManagedDomainSetupStatus(null);
    setSelectedConfigChoice(onboardingState.selected_config_choice);
    setSelectedPaymentsCountry(onboardingState.selected_payments_country);
    setAuthSetupMobileTab("methods");
    setDomainSetupAutoAdvanceError(null);
    setDomainSetupAutoAdvancing(false);
    setPaymentsSetupAction(null);
    finalConfigSavePromiseRef.current = null;
  }, [completeConfig, deriveCurrentOnboardingState, project, project.id, status]);

  const isLinkExistingMode = !isDevelopmentEnvironment && (
    props.mode === "deploy-local"
    || props.mode === "deploy-github"
  );
  const isDeploymentMode = !isDevelopmentEnvironment && (
    props.mode === "deploy"
    || isLinkExistingMode
  );
  const isPreselectedProductMode = props.mode === "setup-products";
  const paymentsAppEnabledInConfig = completeConfig.apps.installed.payments?.enabled === true;
  const includePayments = (
    status === "payments_setup"
    || paymentsAppEnabledInConfig
    || (!isLinkExistingMode && effectiveSelectedApps.has("payments"))
  );
  const timelineSteps = useMemo(
    () => isDeploymentMode
      ? buildLinkExistingTimeline(includePayments)
      : buildTimeline({
        includeInitialSteps: !isPreselectedProductMode,
        selectedApps: effectiveSelectedApps,
      }),
    [effectiveSelectedApps, includePayments, isDeploymentMode, isPreselectedProductMode],
  );
  const currentTimelineIndex = useMemo(() => getStepIndex(timelineSteps, status), [status, timelineSteps]);
  const getNextTimelineStep = useCallback((currentStep: ProjectOnboardingStatus): ProjectOnboardingStatus => {
    const currentIndex = getStepIndex(timelineSteps, currentStep);
    return timelineSteps[currentIndex + 1]?.id ?? "welcome";
  }, [timelineSteps]);

  useEffect(() => {
    if (status !== "email_theme_setup" || !includePayments) {
      return;
    }

    runAsynchronously(async () => {
      await project.app.getStripeAccountInfo();
    }, { noErrorLogging: true });
  }, [includePayments, project.app, status]);

  const handleTimelineStepClick = useCallback((step: ProjectOnboardingStatus) => {
    const targetIndex = getStepIndex(timelineSteps, step);
    if (targetIndex < 0 || targetIndex >= currentTimelineIndex) {
      return;
    }

    runAsynchronouslyWithAlert(async () => {
      if (step === "config_choice" && !isDevelopmentEnvironment) {
        setMode(null);
      }
      await saveOnboardingProgress({ status: step });
    });
  }, [currentTimelineIndex, isDevelopmentEnvironment, saveOnboardingProgress, setMode, timelineSteps]);

  const handleBack = useMemo(() => {
    if (currentTimelineIndex <= 0) {
      return undefined;
    }
    const previousStep = timelineSteps[currentTimelineIndex - 1].id;
    return () => handleTimelineStepClick(previousStep);
  }, [currentTimelineIndex, handleTimelineStepClick, timelineSteps]);

  const advanceFromDomainSetup = useCallback(() => {
    return runAsynchronouslyWithAlert(async () => {
      setDomainSetupAutoAdvanceError(null);
      setDomainSetupAutoAdvancing(true);
      try {
        await saveOnboardingProgress({ status: "email_theme_setup" });
      } catch (error) {
        setDomainSetupAutoAdvanceError(error instanceof Error ? error.message : "Failed to continue to the email theme step.");
        throw error;
      } finally {
        setDomainSetupAutoAdvancing(false);
      }
    });
  }, [saveOnboardingProgress]);

  useEffect(() => {
    if (status !== "domain_setup") {
      return;
    }

    advanceFromDomainSetup();
  }, [advanceFromDomainSetup, status]);

  const authPreviewProject = useMemo(() => {
    return {
      displayName: project.displayName,
      config: {
        signUpEnabled: true,
        credentialEnabled: signInMethods.has("credential"),
        magicLinkEnabled: signInMethods.has("magicLink"),
        passkeyEnabled: signInMethods.has("passkey"),
        oauthProviders: SHARED_OAUTH_SIGN_IN_METHODS
          .filter((providerId) => signInMethods.has(providerId))
          .map((providerId) => ({ id: providerId, type: "shared" as const })),
      },
    };
  }, [project.displayName, signInMethods]);

  const toggleSignInMethod = (method: SignInMethod, enabled: boolean) => {
    setSignInMethods((previous) => {
      const next = new Set(previous);
      if (enabled) {
        next.add(method);
      } else {
        next.delete(method);
      }
      return next;
    });
  };

  const toggleApp = (appId: AppId) => {
    setSelectedApps((previous) => {
      const next = new Set(previous);
      if (REQUIRED_APP_IDS.includes(appId)) {
        next.add(appId);
        return next;
      }

      if (next.has(appId)) {
        next.delete(appId);
      } else {
        // Soft requirements are expanded via effectiveSelectedApps, not as visible
        // picker selections — same silent pattern as always-on analytics.
        next.add(appId);
      }
      return next;
    });
  };

  const buildOnboardingState = useCallback((): ProjectOnboardingState => {
    return createProjectOnboardingState({
      selectedConfigChoice,
      selectedApps: effectiveSelectedApps,
      selectedSignInMethods: signInMethods,
      selectedEmailThemeId: selectedEmailThemeId ?? completeConfig.emails.selectedThemeId,
      selectedPaymentsCountry,
      developmentEnvironment: isDevelopmentEnvironment,
    });
  }, [completeConfig.emails.selectedThemeId, effectiveSelectedApps, isDevelopmentEnvironment, selectedConfigChoice, selectedEmailThemeId, selectedPaymentsCountry, signInMethods]);

  const saveCurrentOnboardingProgress = useCallback(async (nextStatus: ProjectOnboardingStatus) => {
    await saveOnboardingProgress({
      status: nextStatus,
      onboardingState: buildOnboardingState(),
    });
  }, [buildOnboardingState, saveOnboardingProgress]);

  const buildBranchConfigUpdate = useCallback(() => {
    const emailThemeId = selectedEmailThemeId ?? completeConfig.emails.selectedThemeId;
    const configUpdate: EnvironmentConfigOverrideOverride = {
      "auth.password.allowSignIn": signInMethods.has("credential"),
      "emails.selectedThemeId": emailThemeId,
    };
    if (signInMethods.has("magicLink")) {
      configUpdate["auth.otp.allowSignIn"] = true;
    }
    if (signInMethods.has("passkey")) {
      configUpdate["auth.passkey.allowSignIn"] = true;
    }
    for (const appId of ALL_APP_IDS) {
      if (effectiveSelectedApps.has(appId)) {
        configUpdate[`apps.installed.${appId}.enabled`] = true;
      }
    }
    if (isDevelopmentEnvironment) {
      for (const providerId of SHARED_OAUTH_SIGN_IN_METHODS) {
        configUpdate[`auth.oauth.providers.${providerId}`] = signInMethods.has(providerId) ? {
          type: providerId,
          allowSignIn: true,
          allowConnectedAccounts: true,
        } : null;
      }
    }
    return configUpdate;
  }, [completeConfig.emails.selectedThemeId, effectiveSelectedApps, isDevelopmentEnvironment, selectedEmailThemeId, signInMethods]);

  const buildEnvironmentOAuthConfigUpdate = useCallback(() => {
    const configUpdate: EnvironmentConfigOverrideOverride = {};
    for (const providerId of SHARED_OAUTH_SIGN_IN_METHODS) {
      configUpdate[`auth.oauth.providers.${providerId}`] = signInMethods.has(providerId) ? {
        type: providerId,
        isShared: true,
        allowSignIn: true,
        allowConnectedAccounts: true,
      } : null;
    }
    return configUpdate;
  }, [signInMethods]);

  const saveFinalConfig = useCallback(async (): Promise<boolean> => {
    if (isLinkExistingMode) {
      return true;
    }

    const branchConfigUpdated = await updateConfig({
      adminApp: props.project.app,
      configUpdate: buildBranchConfigUpdate(),
      pushable: true,
    });
    if (!branchConfigUpdated) {
      return false;
    }

    if (!isDevelopmentEnvironment) {
      const providersUpdated = await updateConfig({
        adminApp: props.project.app,
        configUpdate: buildEnvironmentOAuthConfigUpdate(),
        pushable: false,
      });
      if (!providersUpdated) {
        return false;
      }
    }

    return true;
  }, [
    buildBranchConfigUpdate,
    buildEnvironmentOAuthConfigUpdate,
    isDevelopmentEnvironment,
    isLinkExistingMode,
    props.project.app,
    updateConfig,
  ]);

  useEffect(() => {
    if (status !== "welcome" || isLinkExistingMode || isDevelopmentEnvironment || finalConfigSavePromiseRef.current != null) {
      return;
    }

    // Cloud onboarding can quietly pre-save unlinked config. In a development
    // environment that same save opens the visible local config apply dialog, so
    // it must only start from the final user action.
    finalConfigSavePromiseRef.current = (async () => {
      const pushedConfigSource = await props.project.getPushedConfigSource();
      if (pushedConfigSource.type !== "unlinked") {
        return false;
      }
      return await saveFinalConfig();
    })();
    runAsynchronously(finalConfigSavePromiseRef.current, { noErrorLogging: true });
  }, [isDevelopmentEnvironment, isLinkExistingMode, props.project, saveFinalConfig, status]);

  const finalizeOnboarding = useCallback(async () => {
    await runWithSaving(async () => {
      const backgroundConfigSave = finalConfigSavePromiseRef.current;
      let configSaved: boolean;
      try {
        configSaved = backgroundConfigSave != null
          ? await backgroundConfigSave
          : await saveFinalConfig();
      } catch {
        finalConfigSavePromiseRef.current = null;
        configSaved = false;
      }

      if (!configSaved) {
        finalConfigSavePromiseRef.current = null;
        configSaved = await saveFinalConfig();
      }

      if (!configSaved) {
        throw new Error("Failed to save project configuration. Please try again.");
      }

      await saveOnboardingProgress({ status: "completed", onboardingState: null });
      finishProjectOnboarding();
    });
  }, [
    finishProjectOnboarding,
    runWithSaving,
    saveFinalConfig,
    saveOnboardingProgress,
  ]);

  const deferPaymentsSetup = useCallback(async () => {
    await runWithSaving(async () => {
      setPaymentsSetupAction("defer");
      try {
        if (selectedPaymentsCountry === "US") {
          await props.project.app.setupPayments();
        }
        await saveCurrentOnboardingProgress("welcome");
      } finally {
        setPaymentsSetupAction(null);
      }
    });
  }, [props.project.app, runWithSaving, saveCurrentOnboardingProgress, selectedPaymentsCountry]);

  const connectPaymentsSetup = useCallback(async () => {
    await runWithSaving(async () => {
      setPaymentsSetupAction("connect");
      try {
        const setup = await props.project.app.setupPayments();
        const redirectUrl = new URL(setup.url);
        if (redirectUrl.protocol !== "https:") {
          throw new Error("Payments setup redirect URL must use HTTPS.");
        }
        window.location.href = redirectUrl.toString();
      } finally {
        setPaymentsSetupAction(null);
      }
    });
  }, [props.project.app, runWithSaving]);

  const openDeploymentSource = async (mode: "deploy-local" | "deploy-github") => {
    await runWithSaving(async () => {
      const nextOnboardingState = createProjectOnboardingState({
        selectedConfigChoice: "link-existing",
        selectedApps: effectiveSelectedApps,
        selectedSignInMethods: signInMethods,
        selectedEmailThemeId: selectedEmailThemeId ?? completeConfig.emails.selectedThemeId,
        selectedPaymentsCountry,
        developmentEnvironment: false,
      });
      await saveOnboardingProgress({ onboardingState: nextOnboardingState });
      setSelectedConfigChoice("link-existing");
      setMode(mode);
    });
  };

  const openDashboardManagedOnboarding = useCallback(async () => {
    await runWithSaving(async () => {
      const nextOnboardingState = createProjectOnboardingState({
        selectedConfigChoice: "create-new",
        selectedApps: effectiveSelectedApps,
        selectedSignInMethods: signInMethods,
        selectedEmailThemeId: selectedEmailThemeId ?? completeConfig.emails.selectedThemeId,
        selectedPaymentsCountry,
        developmentEnvironment: false,
      });
      await saveOnboardingProgress({
        status: "apps_selection",
        onboardingState: nextOnboardingState,
      });
      setSelectedConfigChoice("create-new");
      setMode(null);
    });
  }, [
    completeConfig.emails.selectedThemeId,
    effectiveSelectedApps,
    runWithSaving,
    saveOnboardingProgress,
    selectedEmailThemeId,
    selectedPaymentsCountry,
    setMode,
    signInMethods,
  ]);

  if (props.status === "welcome") {
    if (isPreselectedProductMode) {
      const configFile = buildSelectedOnboardingConfigFile({
        selectedApps: effectiveSelectedApps,
        passwordEnabled: signInMethods.has("credential"),
        otpEnabled: signInMethods.has("magicLink"),
        passkeyEnabled: signInMethods.has("passkey"),
        sharedOAuthProviderIds: SHARED_OAUTH_SIGN_IN_METHODS.filter((providerId) => signInMethods.has(providerId)),
        emailThemeId: selectedEmailThemeId ?? completeConfig.emails.selectedThemeId,
      });
      return (
        <SetupNewProjectPage
          steps={timelineSteps}
          currentStep="welcome"
          disabled={saving}
          onBack={handleBack ?? (() => {
            runAsynchronouslyWithAlert(async () => {
              await saveCurrentOnboardingProgress("apps_selection");
              setMode(null);
            });
          })}
          configFile={configFile}
          onComplete={() => runAsynchronouslyWithAlert(finalizeOnboarding)}
        />
      );
    }
    return (
      <WelcomeSlide
        steps={timelineSteps}
        saving={saving}
        enabledApps={completeConfig.apps.installed}
        onFinish={() => runAsynchronouslyWithAlert(finalizeOnboarding)}
      />
    );
  }

  if (
    props.status === "completed"
    && !isDevelopmentEnvironment
    && (
      props.mode === "link-existing"
      || props.mode === "deploy-local"
      || props.mode === "deploy-github"
    )
  ) {
    // Re-linking an already-onboarded project (initiated from the project
    // settings page). The project's onboarding status must stay "completed",
    // so both back and continue simply return to the settings page instead of
    // saving onboarding progress. Full page load so the config source and
    // config caches are refetched after the link.
    const returnToProjectSettings = () => {
      window.location.href = `/projects/${encodeURIComponent(props.project.id)}/project-settings`;
    };

    if (props.mode === "link-existing") {
      return (
        <DeploymentChoicePage
          stepKey="relink-deployment-location"
          steps={[{ id: "config_choice", label: "Config" }]}
          currentStep="config_choice"
          onBack={returnToProjectSettings}
          disabled={saving}
          onSelect={(source) => props.setMode(source === "local" ? "deploy-local" : "deploy-github")}
        />
      );
    }

    return (
      <LinkExistingOnboarding
        project={props.project}
        steps={[{ id: "config_choice", label: "Config" }]}
        disabled={saving}
        currentStep="config_choice"
        deploymentSource={props.mode === "deploy-local" ? "local" : "github"}
        onStepClick={() => {}}
        onBack={() => props.setMode("link-existing")}
        onContinueAfterLink={async () => {
          returnToProjectSettings();
        }}
      />
    );
  }

  if (props.status === "config_choice" && isLinkExistingMode) {
    return (
      <LinkExistingOnboarding
        project={props.project}
        steps={timelineSteps}
        disabled={saving}
        currentStep="config_choice"
        progressIndex={2}
        progressTotal={3}
        deploymentSource={props.mode === "deploy-local" ? "local" : "github"}
        onStepClick={handleTimelineStepClick}
        onBack={() => {
          props.setMode("deploy");
        }}
        onContinueAfterLink={async () => {
          const latestConfig = await props.project.getConfig();
          const paymentsEnabledInLatestConfig = latestConfig.apps.installed.payments?.enabled === true;
          if (paymentsEnabledInLatestConfig) {
            await saveOnboardingProgress({ status: "payments_setup" });
          } else {
            await saveOnboardingProgress({ status: "welcome" });
          }
        }}
      />
    );
  }

  if (props.status === "config_choice") {
    if (isDevelopmentEnvironment) {
      return (
        <OnboardingPage
          stepKey="config-choice"
          title="Welcome to Hexclave!"
          subtitle={`You are running Hexclave with the local dashboard.`}
          steps={timelineSteps}
          currentStep="config_choice"
          onStepClick={handleTimelineStepClick}
          disabled={saving}
          primaryAction={
            <DesignButton
              className="w-full rounded-full"
              loading={saving}
              onClick={() => runAsynchronouslyWithAlert(() => runWithSaving(async () => {
                await saveCurrentOnboardingProgress("apps_selection");
              }))}
            >
              Continue
            </DesignButton>
          }
        >
          <div className="mx-auto max-w-xl rounded-2xl bg-white/70 p-6 text-center ring-1 ring-black/[0.06] dark:bg-background/60 dark:ring-white/[0.06]">
            <Typography className="text-base leading-relaxed">
              This local project is running locally and ready to get started.
            </Typography>
            <Typography variant="secondary" className="mt-3 text-sm leading-relaxed">
              Next, we will guide you through the onboarding flow to set up your hexclave.config.ts file.
            </Typography>
          </div>
        </OnboardingPage>
      );
    }

    if (props.mode === "deploy") {
      return (
        <DeploymentChoicePage
          stepKey="deployment-location"
          steps={timelineSteps}
          currentStep="config_choice"
          progressIndex={1}
          onStepClick={handleTimelineStepClick}
          onBack={() => setMode(null)}
          disabled={saving}
          showAdvancedProductionOption
          onSelect={(source) => {
            if (source === "plain-production") {
              runAsynchronouslyWithAlert(openDashboardManagedOnboarding);
              return;
            }
            runAsynchronouslyWithAlert(() => openDeploymentSource(source === "local" ? "deploy-local" : "deploy-github"));
          }}
        />
      );
    }

    return (
      <NewProjectEntryPage
        steps={timelineSteps}
        currentStep="config_choice"
        onBack={handleBack}
        disabled={saving}
        onSelect={(choice) => {
          if (choice === "setup-new") {
            runAsynchronouslyWithAlert(openDashboardManagedOnboarding);
          } else {
            setMode(choice);
          }
        }}
      />
    );
  }

  if (props.status === "apps_selection") {
    const orderedIds = orderedAppIds();
    const primaryAppIds = orderedIds.filter((appId) => PRIMARY_APP_IDS.includes(appId));
    const secondaryAppIds = orderedIds.filter((appId) => !PRIMARY_APP_IDS.includes(appId));
    const moreAppsSplitIndex = secondaryAppIds.length >= 10 ? Math.floor(secondaryAppIds.length / 2) : secondaryAppIds.length;
    const moreAppsFirstRow = secondaryAppIds.slice(0, moreAppsSplitIndex);
    const moreAppsSecondRow = secondaryAppIds.slice(moreAppsSplitIndex);

    return (
      <OnboardingPage
        stepKey="apps-selection"
        title="Select apps"
        subtitle="Choose the apps to include in this project."
        steps={timelineSteps}
        currentStep="apps_selection"
        onStepClick={handleTimelineStepClick}
        onBack={handleBack}
        disabled={saving}
        wide
        primaryAction={
          <DesignButton
            className="w-full rounded-full"
            loading={saving}
            onClick={() => runAsynchronouslyWithAlert(() => runWithSaving(async () => {
              await saveCurrentOnboardingProgress(getNextTimelineStep("apps_selection"));
            }))}
          >
            Continue
          </DesignButton>
        }
      >
        <TooltipProvider delayDuration={0}>
          <div className="space-y-6">
            <div className="space-y-3">
              <Typography className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Core apps
              </Typography>
              <div className="flex flex-wrap items-start justify-center gap-x-2 gap-y-2">
                {primaryAppIds.map((appId) => (
                  <OnboardingAppCard
                    key={appId}
                    appId={appId}
                    selected={selectedApps.has(appId)}
                    required={REQUIRED_APP_IDS.includes(appId)}
                    primary
                    disabled={saving}
                    onToggle={() => toggleApp(appId)}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <Typography className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                More apps
              </Typography>
              {secondaryAppIds.length >= 10 ? (
                <div className="flex flex-col items-stretch gap-y-3">
                  <div className="flex flex-wrap items-start justify-center gap-x-1 gap-y-1">
                    {moreAppsFirstRow.map((appId) => (
                      <OnboardingAppCard
                        key={appId}
                        appId={appId}
                        selected={selectedApps.has(appId)}
                        required={REQUIRED_APP_IDS.includes(appId)}
                        primary={false}
                        disabled={saving}
                        onToggle={() => toggleApp(appId)}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap items-start justify-center gap-x-1 gap-y-1">
                    {moreAppsSecondRow.map((appId) => (
                      <OnboardingAppCard
                        key={appId}
                        appId={appId}
                        selected={selectedApps.has(appId)}
                        required={REQUIRED_APP_IDS.includes(appId)}
                        primary={false}
                        disabled={saving}
                        onToggle={() => toggleApp(appId)}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-start justify-center gap-x-1 gap-y-1">
                  {secondaryAppIds.map((appId) => (
                    <OnboardingAppCard
                      key={appId}
                      appId={appId}
                      selected={selectedApps.has(appId)}
                      required={REQUIRED_APP_IDS.includes(appId)}
                      primary={false}
                      disabled={saving}
                      onToggle={() => toggleApp(appId)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </TooltipProvider>
      </OnboardingPage>
    );
  }

  if (props.status === "auth_setup") {
    return (
      <OnboardingPage
        stepKey="auth-setup"
        title="Configure authentication"
        subtitle="Choose which sign-in methods to enable."
        steps={timelineSteps}
        currentStep="auth_setup"
        onStepClick={handleTimelineStepClick}
        onBack={handleBack}
        disabled={saving}
        wide
        primaryAction={
          <DesignButton
            className="w-full rounded-full"
            loading={saving}
            onClick={() => runAsynchronouslyWithAlert(() => runWithSaving(async () => {
              if (signInMethods.size === 0) {
                throw new Error("Select at least one sign-in method before continuing.");
              }
              await saveCurrentOnboardingProgress(getNextTimelineStep("auth_setup"));
            }))}
          >
            Continue
          </DesignButton>
        }
      >
        <DesignCard
          glassmorphic={false}
          contentClassName="p-0 overflow-hidden"
          className="border-0 bg-white/90 ring-1 ring-black/[0.06] dark:bg-white/[0.06] dark:ring-white/[0.10]"
        >
          <div className="flex justify-center border-b border-black/[0.12] px-4 py-3 dark:border-white/[0.06] md:hidden">
            <DesignPillToggle
              options={[
                { id: "methods", label: "Sign-in methods" },
                { id: "preview", label: "Preview" },
              ]}
              selected={authSetupMobileTab}
              onSelect={(id) => { setAuthSetupMobileTab(id === "preview" ? "preview" : "methods"); }}
              size="sm"
              gradient="default"
              className="flex w-full max-w-md justify-center"
            />
          </div>
          <div className="grid md:grid-cols-[minmax(260px,2fr)_minmax(0,2fr)]">
            <div
              className={cn(
                "flex flex-col justify-center border-b border-black/[0.12] dark:border-white/[0.06] md:border-b-0 md:border-r",
                authSetupMobileTab !== "methods" && "max-md:hidden",
              )}
            >
              <div className="p-4 md:p-6">
                <Typography className="mb-3 text-sm font-medium text-muted-foreground md:mb-4">
                  Sign-in methods
                </Typography>
                <div className="overflow-hidden rounded-xl bg-white/90 ring-1 ring-black/[0.06] dark:bg-foreground/[0.04] dark:ring-white/[0.06]">
                  {SIGN_IN_METHODS.map((method, index) => {
                    const checked = signInMethods.has(method.id);
                    return (
                      <label
                        key={method.id}
                        className={cn(
                          "flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 md:gap-4 md:px-4 md:py-3",
                          index !== SIGN_IN_METHODS.length - 1 && "border-b border-black/[0.06] dark:border-white/[0.06]",
                        )}
                      >
                        <span className="text-sm">{method.label}</span>
                        <Switch
                          checked={checked}
                          onCheckedChange={(nextChecked) => toggleSignInMethod(method.id, nextChecked)}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div
              aria-hidden="true"
              inert
              className={cn(
                "pointer-events-none flex items-center justify-center bg-foreground/[0.02] px-3 py-3 select-none md:px-4 md:py-4 lg:px-6",
                authSetupMobileTab !== "preview" && "max-md:hidden",
              )}
            >
              <div className="relative flex w-full items-center justify-center">
                {/* Transform keeps the browser mockup's proportions; negative margins reclaim the
                    unscaled flow space because CSS transforms do not affect layout dimensions. */}
                <div className="relative my-[-20%] w-full origin-center scale-[0.6] transform-gpu">
                  <BrowserFrame url="your-website.com/signin" className="w-full">
                    <div className="flex min-h-[180px] items-center justify-center px-4 py-3 md:px-5 md:py-4">
                      <div className="relative flex w-full items-center justify-center">
                        <HostedAuthMethodPreview project={authPreviewProject} />
                      </div>
                    </div>
                  </BrowserFrame>
                  <div
                    aria-hidden
                    className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 -rotate-[18deg] text-center text-4xl font-black tracking-[0.2em] text-red-500/50"
                  >
                    [PREVIEW]
                  </div>
                </div>
              </div>
            </div>
          </div>
        </DesignCard>
      </OnboardingPage>
    );
  }

  if (props.status === "domain_setup") {
    return (
      <DomainSetupTransitionState
        advancing={domainSetupAutoAdvancing}
        errorMessage={domainSetupAutoAdvanceError}
        onRetry={advanceFromDomainSetup}
        onOpenProject={() => router.push(`/projects/${encodeURIComponent(project.id)}`)}
      />
    );
  }

  if (props.status === "email_theme_setup") {
    return (
      <OnboardingPage
        stepKey="email-theme-setup"
        title="Select an email theme"
        subtitle="Pick a theme for your transactional emails, or keep the default."
        steps={timelineSteps}
        currentStep="email_theme_setup"
        onStepClick={handleTimelineStepClick}
        onBack={handleBack}
        disabled={saving}
        wide
        primaryAction={
          <DesignButton
            className="w-full rounded-full"
            loading={saving}
            onClick={() => runAsynchronouslyWithAlert(() => runWithSaving(async () => {
              if (includePayments) {
                await saveCurrentOnboardingProgress("payments_setup");
              } else {
                await saveCurrentOnboardingProgress("welcome");
              }
            }))}
          >
            {includePayments ? "Continue" : "Finish"}
          </DesignButton>
        }
      >
        <EmailThemePicker
          selectedEmailThemeId={selectedEmailThemeId}
          setSelectedEmailThemeId={setSelectedEmailThemeId}
          disabled={saving}
        />
      </OnboardingPage>
    );
  }

  if (props.status === "payments_setup") {
    return (
      <OnboardingPage
        stepKey="payments-setup"
        title="Set up payments"
        subtitle="Connect bank account to start accepting payments from your users."
        steps={timelineSteps}
        currentStep="payments_setup"
        onStepClick={handleTimelineStepClick}
        onBack={handleBack}
        disabled={saving}
        actionsLayout="inline"
        primaryAction={selectedPaymentsCountry === "US" ? (
          <DesignButton
            className="rounded-full px-6"
            disabled={saving || paymentsSetupAction != null}
            loading={paymentsSetupAction === "connect"}
            onClick={() => runAsynchronouslyWithAlert(connectPaymentsSetup)}
          >
            Connect
          </DesignButton>
        ) : (
          <DesignButton
            className="rounded-full px-6"
            disabled={saving || paymentsSetupAction != null}
            loading={paymentsSetupAction === "defer"}
            onClick={() => runAsynchronouslyWithAlert(deferPaymentsSetup)}
          >
            Do Later
          </DesignButton>
        )}
        secondaryAction={selectedPaymentsCountry === "US" ? (
          <DesignButton
            className="rounded-full px-6"
            variant="outline"
            disabled={saving || paymentsSetupAction != null}
            loading={paymentsSetupAction === "defer"}
            onClick={() => runAsynchronouslyWithAlert(deferPaymentsSetup)}
          >
            Do Later
          </DesignButton>
        ) : undefined}
      >
        <Suspense fallback={<PaymentsSetupStepSkeleton />}>
          <PaymentsSetupAutoComplete
            project={props.project}
            buildOnboardingState={buildOnboardingState}
            saveOnboardingProgress={saveOnboardingProgress}
          />
          <PaymentsSetupStepContent
            selectedPaymentsCountry={selectedPaymentsCountry}
            setSelectedPaymentsCountry={setSelectedPaymentsCountry}
          />
        </Suspense>
      </OnboardingPage>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
      <Alert>
        <WarningCircleIcon className="h-4 w-4" />
        <AlertTitle>Unknown onboarding step</AlertTitle>
        <AlertDescription>
          This project has an unknown onboarding state. Open the project directly and continue from the dashboard.
        </AlertDescription>
      </Alert>
      <div className="mt-4 flex justify-end">
        <Button onClick={() => router.push(`/projects/${encodeURIComponent(props.project.id)}`)}>Open Project</Button>
      </div>
    </div>
  );
}

function PaymentsSetupStepSkeleton() {
  return (
    <div className="mx-auto w-full max-w-sm" data-testid="payments-setup-step-skeleton">
      <div className="rounded-2xl bg-white/90 p-6 ring-1 ring-black/[0.06] dark:bg-white/[0.06] dark:ring-white/[0.10] md:p-7">
        <div className="flex flex-col items-center gap-6 md:gap-7">
          <Skeleton className="h-7 w-40" />
          <div className="flex w-full flex-col gap-3 rounded-xl bg-foreground/[0.03] px-5 py-4">
            {["feature-skeleton-one", "feature-skeleton-two", "feature-skeleton-three"].map((id) => (
              <div key={id} className="flex items-center gap-2.5">
                <Skeleton className="h-3.5 w-3.5 rounded-full" />
                <Skeleton className="h-4 w-full max-w-[220px]" />
              </div>
            ))}
          </div>
          <div className="w-full space-y-2.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-10 w-full rounded-xl" />
            <div className="flex items-center justify-center gap-1.5">
              <Skeleton className="h-3.5 w-3.5 rounded-full" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PaymentsSetupStepContent({
  selectedPaymentsCountry,
  setSelectedPaymentsCountry,
}: {
  selectedPaymentsCountry: OnboardingPaymentsCountry,
  setSelectedPaymentsCountry: (country: OnboardingPaymentsCountry) => void,
}) {
  return (
    <div className="mx-auto w-full max-w-sm">
      <DesignCard
        glassmorphic={false}
        className="border-0 bg-white/90 ring-1 ring-black/[0.06] dark:bg-white/[0.06] dark:ring-white/[0.10]"
        contentClassName="!p-6 md:!p-7"
      >
        <div className="flex flex-col items-center gap-6 md:gap-7">
          <Typography type="h2" className="text-center tracking-tight text-balance">
            Built-in Billing
          </Typography>

          <div className="flex w-full flex-col gap-3 rounded-xl bg-foreground/[0.03] px-5 py-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2.5">
              <WebhooksLogoIcon className="h-3.5 w-3.5 shrink-0 text-foreground/50" />
              <span>No webhooks or syncing required</span>
            </div>
            <div className="flex items-center gap-2.5">
              <ArrowsClockwiseIcon className="h-3.5 w-3.5 shrink-0 text-foreground/50" />
              <span>One-time and recurring payments</span>
            </div>
            <div className="flex items-center gap-2.5">
              <ChartBarIcon className="h-3.5 w-3.5 shrink-0 text-foreground/50" />
              <span>Usage-based billing support</span>
            </div>
          </div>

          <div className="w-full space-y-2.5">
            <Typography className="text-xs font-medium text-muted-foreground">Country of residence</Typography>
            <DesignSelectorDropdown
              value={selectedPaymentsCountry}
              onValueChange={(value) => {
                if (value !== "US" && value !== "OTHER") {
                  throw new Error(`Invalid payments country: ${value}`);
                }
                setSelectedPaymentsCountry(value);
              }}
              options={PAYMENT_COUNTRY_OPTIONS.map((country) => ({ value: country.value, label: country.label }))}
              size="md"
            />
            <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-center text-xs text-muted-foreground">
              <ShieldCheckIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span>Powered by</span>
              <StripeWordmark className="h-3 w-auto shrink-0 translate-y-px text-[#635BFF] dark:text-[#8b87ff]" />
            </div>
            {selectedPaymentsCountry !== "US" && (
              <Typography className="text-center text-xs text-amber-600 dark:text-amber-400">
                Payments is currently only available in the United States.
              </Typography>
            )}
          </div>
        </div>
      </DesignCard>
    </div>
  );
}

function PaymentsSetupAutoComplete({
  project,
  buildOnboardingState,
  saveOnboardingProgress,
}: {
  project: AdminOwnedProject,
  buildOnboardingState: () => ProjectOnboardingState,
  saveOnboardingProgress: (update: OnboardingProgressUpdate) => Promise<void>,
}) {
  const stripeAccountInfo = project.app.useStripeAccountInfo();
  const autoCompletingRef = useRef(false);

  useEffect(() => {
    if (stripeAccountInfo?.details_submitted !== true || autoCompletingRef.current) {
      return;
    }

    autoCompletingRef.current = true;
    runAsynchronouslyWithAlert(async () => {
      try {
        await saveOnboardingProgress({
          status: "welcome",
          onboardingState: buildOnboardingState(),
        });
      } catch (error) {
        autoCompletingRef.current = false;
        throw error;
      }
    });
  }, [buildOnboardingState, saveOnboardingProgress, stripeAccountInfo?.details_submitted]);

  return null;
}

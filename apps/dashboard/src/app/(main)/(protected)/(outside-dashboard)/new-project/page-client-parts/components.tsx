"use client";

import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";

import { AppIcon } from "@/components/app-square";
import { CodeBlock } from "@/components/code-block";
import { DesignPillToggle } from "@/components/design-components";
import { DesignAlert } from "@/components/design-components/alert";
import { DesignBadge } from "@/components/design-components/badge";
import { DesignButton } from "@/components/design-components/button";
import { DesignCard } from "@/components/design-components/card";
import { DesignInput } from "@/components/design-components/input";
import { buildSelectedOnboardingConfigFile, formatApproximateTokenCountLabel, getManualSetupDocsUrl, prependConfigChangesToSetupPrompt } from "@/lib/setup-prompt";
import { getAppIdsForListing } from "@/lib/apps-utils";
import { HostedAuthMethodPreview } from "@/components/hosted-auth-preview";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  BrowserFrame,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Typography,
  cn,
} from "@/components/ui";
import { ArrowLeftIcon, BookIcon, CaretDownIcon, CheckCircleIcon, CompassIcon, GithubLogoIcon, LaptopIcon, MagicWandIcon, MagnifyingGlassIcon, RocketLaunchIcon, SparkleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { aiSetupPrompt } from "@hexclave/shared/dist/ai/unified-prompts/skill-site-prompt-parts/ai-setup-prompt";
import { ALL_APPS, expandAppSoftRequirements, getParentAppId, type AppId } from "@hexclave/shared/dist/apps/apps-config";
import { DEFAULT_EMAIL_THEMES, DEFAULT_EMAIL_THEME_ID } from "@hexclave/shared/dist/helpers/emails";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

import { SHARED_OAUTH_SIGN_IN_METHODS, SIGN_IN_METHODS, type SignInMethod, type TimelineStep } from "./shared";

export type OnboardingPageProps = {
  stepKey: string,
  title: string,
  subtitle?: ReactNode,
  steps: TimelineStep[],
  currentStep: TimelineStep["id"],
  progressIndex?: number,
  progressTotal?: number,
  onStepClick?: (step: TimelineStep["id"]) => void,
  disabled?: boolean,
  primaryAction: ReactNode,
  secondaryAction?: ReactNode,
  onBack?: () => void,
  wide?: boolean,
  actionsLayout?: "stacked" | "inline",
  children: ReactNode,
};

/** Half the previous preview height — enough to hint at length without dominating the card. */
export const ONBOARDING_AI_PROMPT_PREVIEW_HEIGHT_PX = 110;

export function OnboardingAiPromptBlock(props: {
  title: string,
  content: string,
  previewHeightPx?: number,
}) {
  const previewHeightPx = props.previewHeightPx ?? ONBOARDING_AI_PROMPT_PREVIEW_HEIGHT_PX;

  return (
    <div className="space-y-2">
      <Typography variant="secondary" className="text-sm">
        Copy-paste the following prompt into your coding agent:
      </Typography>
      <div className="relative">
        <CodeBlock
          title={props.title}
          icon="code"
          language="text"
          content={props.content}
          compact
          maxHeight={previewHeightPx}
          customRender={(
            <pre
              className="overflow-y-auto whitespace-pre-wrap break-words px-3 pb-8 pt-2.5 font-mono text-[11px] leading-4 text-foreground"
              style={{ maxHeight: previewHeightPx }}
            >
              {props.content}
            </pre>
          )}
        />
        {/* Fade + token hint sit over the prompt body so truncated content is obvious. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-xl bg-gradient-to-t from-white/95 via-white/80 to-transparent dark:from-background/95 dark:via-background/80"
        />
        <Typography
          variant="secondary"
          className="pointer-events-none absolute inset-x-0 bottom-2 z-[1] text-center text-[11px] tabular-nums"
        >
          {formatApproximateTokenCountLabel(props.content)}
        </Typography>
      </div>
    </div>
  );
}

/**
 * Fixed step dots / back control. Gradient fade softens the overlap when page
 * content scrolls underneath — solid bars look harsh on the lavender ambient bg.
 */
function OnboardingBottomChrome(props: {
  children: ReactNode,
}) {
  return (
    <div
      className="onboarding-cascade pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center bg-gradient-to-t from-background from-35% via-background/80 to-transparent pb-6 pt-14"
      style={{ "--cascade-i": 3 } as CSSProperties}
    >
      <div className="pointer-events-auto">
        {props.children}
      </div>
    </div>
  );
}

export function OnboardingPage(props: OnboardingPageProps) {
  const currentTimelineIndex = props.steps.findIndex((step) => step.id === props.currentStep);
  const currentIndex = props.progressIndex ?? currentTimelineIndex;
  const progressTotal = props.progressTotal ?? props.steps.length;
  const progressSteps: Array<TimelineStep | undefined> = Array.from(
    { length: progressTotal },
    (_, index) => index < props.steps.length ? props.steps[index] : undefined,
  );

  return (
    <div className="flex w-full flex-grow flex-col items-center justify-center px-4 pb-28 pt-8">
      <div
        key={props.stepKey}
        className={cn(
          "flex w-full flex-col items-center gap-8",
          props.wide ? "max-w-5xl" : "max-w-[560px]",
        )}
      >
        <div className="onboarding-cascade space-y-2 text-center" style={{ "--cascade-i": 0 } as CSSProperties}>
          <Typography className="text-3xl font-semibold tracking-tight">
            {props.title}
          </Typography>
          {props.subtitle != null && (
            <Typography variant="secondary" className="mx-auto max-w-md text-sm leading-relaxed">
              {props.subtitle}
            </Typography>
          )}
        </div>

        <div className="onboarding-cascade w-full" style={{ "--cascade-i": 1 } as CSSProperties}>
          {props.children}
        </div>

        <div className="onboarding-cascade" style={{ "--cascade-i": 2 } as CSSProperties}>
          {props.actionsLayout === "inline" ? (
            <div className="flex items-center gap-3">
              {props.primaryAction}
              {props.secondaryAction != null && props.secondaryAction}
            </div>
          ) : (
            <div className="flex w-full max-w-[280px] flex-col items-center gap-3">
              {props.primaryAction}
              {props.secondaryAction != null && (
                <div className="flex justify-center">
                  {props.secondaryAction}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <OnboardingBottomChrome>
        <div className="flex flex-col items-center gap-2.5">
          <Typography variant="secondary" className="text-center text-xs">
            Need help?{" "}
            <a
              href="https://cal.com/team/hexclave/onboarding-call"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 transition-colors hover:text-foreground hover:transition-none"
            >
              Book an onboarding call
            </a>
          </Typography>
          <div className="relative flex h-5 w-[150px] items-center justify-center">
            {props.onBack != null && (
              <button
                type="button"
                onClick={props.onBack}
                disabled={props.disabled}
                aria-label="Go back to previous step"
                className="absolute left-0 inline-flex h-5 w-5 items-center justify-center rounded-full text-foreground/40 transition-colors hover:text-foreground/80 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowLeftIcon className="h-3.5 w-3.5" weight="bold" />
              </button>
            )}
            <span className="flex items-center gap-[5px]">
              {progressSteps.map((step, index) => {
                const isComplete = index < currentIndex;
                const isCurrent = index === currentIndex;
                const isClickable = step != null && isComplete && !props.disabled && props.onStepClick != null;
                const stepLabel = step?.label ?? `Step ${index + 1}`;

                return (
                  <button
                    key={step?.id ?? `progress-step-${index}`}
                    type="button"
                    disabled={!isClickable}
                    onClick={() => { if (isClickable) props.onStepClick?.(step.id); }}
                    aria-label={isClickable ? `Go to step: ${stepLabel}` : stepLabel}
                    aria-current={isCurrent ? "step" : undefined}
                    className={cn(
                        "rounded-full transition-colors duration-300 hover:transition-none",
                        isCurrent
                          ? "h-[6px] w-5 bg-foreground"
                          : isComplete
                            ? "h-[6px] w-[6px] cursor-pointer bg-foreground/60 hover:bg-foreground/80"
                            : "h-[6px] w-[6px] cursor-default bg-foreground/20",
                      )}
                    title={stepLabel}
                  />
                );
              })}
            </span>
          </div>
        </div>
      </OnboardingBottomChrome>
    </div>
  );
}

export function OnboardingChoiceCard(props: {
  icon: ReactNode,
  title: string,
  description: string,
  disabled: boolean,
  onClick: () => void,
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="group flex w-full items-center gap-4 rounded-xl bg-white/70 p-4 text-left ring-1 ring-black/[0.06] transition-[background-color,box-shadow] duration-150 hover:bg-white hover:shadow-sm hover:transition-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-background/60 dark:ring-white/[0.08] dark:hover:bg-background"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground transition-colors duration-150 group-hover:bg-blue-500/10 group-hover:text-blue-500 group-hover:transition-none">
        {props.icon}
      </div>
      <div className="min-w-0 flex-1">
        <Typography className="text-sm font-semibold">{props.title}</Typography>
        <Typography variant="secondary" className="mt-0.5 text-xs leading-relaxed">{props.description}</Typography>
      </div>
      <span className="text-lg text-muted-foreground/50" aria-hidden>›</span>
    </button>
  );
}

export function DeploymentChoicePage(props: {
  stepKey: string,
  steps: TimelineStep[],
  currentStep: TimelineStep["id"],
  progressIndex?: number,
  progressTotal?: number,
  disabled: boolean,
  onBack?: () => void,
  onStepClick?: (step: TimelineStep["id"]) => void,
  onSelect: (source: "local" | "github" | "plain-production") => void,
  showAdvancedProductionOption?: boolean,
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <OnboardingPage
      stepKey={props.stepKey}
      title="Where is your project currently?"
      steps={props.steps}
      currentStep={props.currentStep}
      progressIndex={props.progressIndex}
      progressTotal={props.progressTotal}
      onStepClick={props.onStepClick}
      onBack={props.onBack}
      disabled={props.disabled}
      primaryAction={null}
    >
      <div className="space-y-3">
        <OnboardingChoiceCard
          icon={<LaptopIcon className="h-5 w-5" />}
          title="On my computer (local)"
          description="Push your existing config from the Hexclave CLI."
          disabled={props.disabled}
          onClick={() => props.onSelect("local")}
        />
        <OnboardingChoiceCard
          icon={<GithubLogoIcon className="h-5 w-5" />}
          title="On GitHub"
          description="Add repository secrets and a config-sync workflow manually."
          disabled={props.disabled}
          onClick={() => props.onSelect("github")}
        />
        {props.showAdvancedProductionOption === true && (
          <div className="pt-1">
            <button
              type="button"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
              disabled={props.disabled}
              className="mx-auto flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:transition-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>Advanced</span>
              <CaretDownIcon className={cn("h-3 w-3 transition-transform duration-150", advancedOpen && "rotate-180")} />
            </button>
            {advancedOpen && (
              <div className="mt-2">
                <OnboardingChoiceCard
                  icon={<RocketLaunchIcon className="h-5 w-5" />}
                  title="Create plain production project"
                  description="Only recommended if you're an expert at using Hexclave"
                  disabled={props.disabled}
                  onClick={() => props.onSelect("plain-production")}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </OnboardingPage>
  );
}

export function NewProjectEntryPage(props: {
  steps: TimelineStep[],
  currentStep: TimelineStep["id"],
  disabled: boolean,
  onBack?: () => void,
  onSelect: (choice: "setup-new" | "deploy") => void,
}) {
  return (
    <OnboardingPage
      stepKey="new-project-entry"
      title="Welcome to Hexclave!"
      subtitle="What would you like to do?"
      steps={props.steps}
      currentStep={props.currentStep}
      onBack={props.onBack}
      disabled={props.disabled}
      primaryAction={null}
    >
      <div className="space-y-3">
        <OnboardingChoiceCard
          icon={<SparkleIcon className="h-5 w-5" />}
          title="Add Hexclave to a project"
          description="If you haven't installed Hexclave yet, this is the way to get started."
          disabled={props.disabled}
          onClick={() => props.onSelect("setup-new")}
        />
        <OnboardingChoiceCard
          icon={<RocketLaunchIcon className="h-5 w-5" />}
          title="Deploy my existing Hexclave project to production"
          description="Link your config file from your computer and deploy to Hexclave Cloud."
          disabled={props.disabled}
          onClick={() => props.onSelect("deploy")}
        />
        <div className="flex items-center gap-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/60">
          <span className="h-px flex-1 bg-foreground/[0.10]" />
          <span>OR</span>
          <span className="h-px flex-1 bg-foreground/[0.10]" />
        </div>
        <OnboardingChoiceCard
          icon={<CompassIcon className="h-5 w-5" />}
          title="I just want to look around"
          description="Explore a live Hexclave project without creating one."
          disabled={props.disabled}
          onClick={() => window.open("https://preview.hexclave.com", "_blank", "noopener,noreferrer")}
        />
      </div>
    </OnboardingPage>
  );
}

const POPULAR_PRODUCT_IDS = ["authentication", "analytics", "payments"] satisfies AppId[];

function isKnownAppId(value: string): value is AppId {
  return Object.prototype.hasOwnProperty.call(ALL_APPS, value);
}

/** Sub-apps install via their parent; standalones install as themselves. */
function getInstallableAppId(appId: AppId): AppId {
  return getParentAppId(appId) ?? appId;
}

function toInstallableAppIds(appIds: Iterable<AppId>): Set<AppId> {
  return new Set([...appIds].map(getInstallableAppId));
}

function allSelectableAppIds(): AppId[] {
  return getAppIdsForListing();
}

function productMatchesSearch(appId: AppId, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const app = ALL_APPS[appId];
  const haystack = `${app.displayName} ${app.subtitle} ${appId}`.toLowerCase();
  return haystack.includes(query);
}

function orderedMatchingAppIds(query: string): {
  popularIds: AppId[],
  regularIds: AppId[],
} {
  const popularIds = POPULAR_PRODUCT_IDS.filter((appId) => productMatchesSearch(appId, query));
  const popularSet = new Set<AppId>(popularIds);
  const regularIds = allSelectableAppIds()
    .filter((appId) => !popularSet.has(appId))
    .filter((appId) => productMatchesSearch(appId, query))
    .sort((a, b) => stringCompare(ALL_APPS[a].displayName, ALL_APPS[b].displayName));
  return { popularIds, regularIds };
}

function ProductPickerTile(props: {
  appId: AppId,
  popular: boolean,
  selected: boolean,
  locked?: boolean,
  disabled: boolean,
  onToggle: () => void,
}) {
  const app = ALL_APPS[props.appId];
  const locked = props.locked === true;

  return (
    <button
      type="button"
      aria-pressed={props.selected}
      aria-disabled={locked || undefined}
      disabled={props.disabled}
      onClick={() => {
        if (locked) {
          return;
        }
        props.onToggle();
      }}
      className={cn(
        "flex h-[3.5rem] items-center gap-2 rounded-lg px-2 text-left ring-1 transition-[background-color,box-shadow] duration-150 hover:transition-none",
        props.popular ? "col-span-2" : "col-span-1",
        locked
          ? "bg-amber-500/[0.08] ring-amber-500/35"
          : props.selected
            ? "bg-blue-500/[0.06] ring-blue-500/35"
            : "bg-foreground/[0.02] ring-black/[0.06] hover:bg-foreground/[0.04] dark:ring-white/[0.08]",
        locked && "cursor-default",
      )}
    >
      <AppIcon appId={props.appId} enabled={props.selected || locked} className="h-7 w-7 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Typography className="truncate text-[13px] font-semibold leading-none">{app.displayName}</Typography>
          {props.popular && <DesignBadge label="Popular" color="blue" size="sm" />}
        </div>
        <Typography variant="secondary" className="mt-1 truncate text-[11px] leading-none">
          {app.subtitle}
        </Typography>
      </div>
      {(props.selected || locked) && (
        <CheckCircleIcon
          className={cn("h-4 w-4 shrink-0", locked ? "text-amber-500" : "text-emerald-600")}
          weight="fill"
        />
      )}
    </button>
  );
}

function PrimaryAppListItem(props: {
  appId: AppId,
  popular: boolean,
  disabled: boolean,
  onSelect: () => void,
}) {
  const app = ALL_APPS[props.appId];

  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onSelect}
      className="group flex w-full items-center gap-3 rounded-xl bg-foreground/[0.02] px-3 py-2.5 text-left ring-1 ring-black/[0.06] transition-[background-color,box-shadow] duration-150 hover:bg-foreground/[0.04] hover:transition-none disabled:cursor-not-allowed disabled:opacity-50 dark:ring-white/[0.08]"
    >
      <AppIcon appId={props.appId} enabled className="h-8 w-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Typography className="truncate text-sm font-semibold">{app.displayName}</Typography>
          {props.popular && <DesignBadge label="Popular" color="blue" size="sm" />}
        </div>
        <Typography variant="secondary" className="mt-0.5 truncate text-xs leading-relaxed">
          {app.subtitle}
        </Typography>
      </div>
      <span className="text-lg text-muted-foreground/50" aria-hidden>›</span>
    </button>
  );
}

export function parseOnboardingAppSearchParam(value: string | null): AppId | null {
  if (value == null || value.length === 0) {
    return null;
  }
  return isKnownAppId(value) && getAppIdsForListing().some((appId) => appId === value) ? value : null;
}

export function ProductSelectionPage(props: {
  steps: TimelineStep[],
  currentStep: TimelineStep["id"],
  disabled: boolean,
  /**
   * When set (e.g. from `?app=`), skip the primary-app screen and lock this app
   * on the additional-apps multiselect.
   */
  initialPrimaryAppId?: AppId | null,
  initialSelectedAppIds?: Iterable<AppId>,
  onBack?: () => void,
  onPrimaryAppSelected: (appId: AppId) => void,
  onClearPrimaryApp: () => void,
  onLetAiDecide: () => void,
  onContinue: (appIds: Set<AppId>) => void,
}) {
  const primaryAppId = props.initialPrimaryAppId ?? null;
  const [selectedApps, setSelectedApps] = useState<Set<AppId>>(() => {
    const selected = new Set(props.initialSelectedAppIds ?? []);
    if (primaryAppId != null) {
      selected.add(primaryAppId);
    }
    return selected;
  });
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const { popularIds: matchingPopularIds, regularIds: matchingRegularIds } = orderedMatchingAppIds(normalizedSearchQuery);
  const hasMatches = matchingPopularIds.length > 0 || matchingRegularIds.length > 0;

  const toggleApp = (appId: AppId) => {
    if (primaryAppId != null && appId === primaryAppId) {
      return;
    }
    setSelectedApps((previous) => {
      const next = new Set(previous);
      if (primaryAppId != null) {
        next.add(primaryAppId);
      }
      if (next.has(appId)) {
        next.delete(appId);
      } else {
        // Soft requirements (and analytics) are applied silently on Continue,
        // not as visible picker selections — same pattern as always-on analytics.
        next.add(appId);
      }
      return next;
    });
  };

  if (primaryAppId == null) {
    return (
      <OnboardingPage
        stepKey="primary-product-selection"
        title="What will you use Hexclave for?"
        subtitle="Hexclave products are grouped into apps. Choose the first app you want to install now — don't worry, you can install more later."
        steps={props.steps}
        currentStep={props.currentStep}
        progressIndex={1}
        progressTotal={2}
        onBack={props.onBack}
        disabled={props.disabled}
        wide
        primaryAction={null}
      >
        <div className="mx-auto w-full max-w-3xl space-y-3">
          <DesignCard
            glassmorphic
            className={cn("border-0 bg-white/70 dark:bg-background/60", props.disabled && "pointer-events-none opacity-50")}
            contentClassName="flex flex-col gap-0 p-0"
          >
            <div className="shrink-0 space-y-2 border-b border-black/[0.05] px-2.5 py-2.5 dark:border-white/[0.06]">
              <DesignInput
                type="search"
                size="sm"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search products..."
                leadingIcon={<MagnifyingGlassIcon className="h-3.5 w-3.5" />}
                disabled={props.disabled}
                aria-label="Search products"
              />
            </div>

            {/* Fixed height so filtering doesn't collapse the card. */}
            <div className="h-[20rem] overflow-y-auto p-2">
              {!hasMatches ? (
                <div className="flex h-full items-center justify-center">
                  <Typography variant="secondary" className="text-center text-sm">
                    No products match “{searchQuery.trim()}”.
                  </Typography>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {[...matchingPopularIds, ...matchingRegularIds].map((appId) => (
                    <PrimaryAppListItem
                      key={appId}
                      appId={appId}
                      popular={matchingPopularIds.some((popularAppId) => popularAppId === appId)}
                      disabled={props.disabled}
                      onSelect={() => {
                        setSelectedApps(new Set([appId]));
                        setSearchQuery("");
                        props.onPrimaryAppSelected(appId);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </DesignCard>

          <div className="flex items-center justify-center">
            <div className="h-px flex-1 bg-foreground/[0.06]" />
            <span className="mx-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">or</span>
            <div className="h-px flex-1 bg-foreground/[0.06]" />
          </div>

          <OnboardingChoiceCard
            icon={<MagicWandIcon className="h-5 w-5" />}
            title="Not sure / Decide later"
            description="Use the setup prompt to choose and configure the right products for your project."
            disabled={props.disabled}
            onClick={props.onLetAiDecide}
          />
        </div>
      </OnboardingPage>
    );
  }

  return (
    <OnboardingPage
      stepKey="additional-product-selection"
      title="Do you want to install any other apps?"
      subtitle="If there are other Hexclave apps you want to use, you can enable them now."
      steps={props.steps}
      currentStep={props.currentStep}
      progressIndex={2}
      progressTotal={2}
      onBack={() => {
        setSelectedApps(new Set());
        setSearchQuery("");
        props.onClearPrimaryApp();
      }}
      disabled={props.disabled}
      wide
      primaryAction={
        <DesignButton
          className="w-full rounded-full"
          disabled={props.disabled}
          onClick={() => {
            const installableApps = toInstallableAppIds([...selectedApps, primaryAppId]);
            props.onContinue(expandAppSoftRequirements([...installableApps, "analytics"]));
          }}
        >
          Continue
        </DesignButton>
      }
    >
      <div className="mx-auto w-full max-w-3xl space-y-3">
        <DesignCard
          glassmorphic
          className={cn("border-0 bg-white/70 dark:bg-background/60", props.disabled && "pointer-events-none opacity-50")}
          contentClassName="flex flex-col gap-0 p-0"
        >
          <div className="shrink-0 space-y-2 border-b border-black/[0.05] px-2.5 py-2.5 dark:border-white/[0.06]">
            <DesignInput
              type="search"
              size="sm"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search products..."
              leadingIcon={<MagnifyingGlassIcon className="h-3.5 w-3.5" />}
              disabled={props.disabled}
              aria-label="Search products"
            />
          </div>

          {/* Fixed height so filtering doesn't collapse the card and shift Continue. */}
          <div className="h-[20rem] overflow-y-auto p-2">
            {!hasMatches ? (
              <div className="flex h-full items-center justify-center">
                <Typography variant="secondary" className="text-center text-sm">
                  No products match “{searchQuery.trim()}”.
                </Typography>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
                {/* Popular tiles first so double-width cards fill cleanly: 2+2, then 2+1+1. */}
                {matchingPopularIds.map((appId) => (
                  <ProductPickerTile
                    key={appId}
                    appId={appId}
                    popular
                    selected={selectedApps.has(appId) || appId === primaryAppId}
                    locked={appId === primaryAppId}
                    disabled={props.disabled}
                    onToggle={() => toggleApp(appId)}
                  />
                ))}
                {matchingRegularIds.map((appId) => (
                  <ProductPickerTile
                    key={appId}
                    appId={appId}
                    popular={false}
                    selected={selectedApps.has(appId) || appId === primaryAppId}
                    locked={appId === primaryAppId}
                    disabled={props.disabled}
                    onToggle={() => toggleApp(appId)}
                  />
                ))}
              </div>
            )}
          </div>
        </DesignCard>
      </div>
    </OnboardingPage>
  );
}

export function ProductConfigurationWizard(props: {
  selectedApps: Set<AppId>,
  onBack: () => void,
  onDeploy: (source: "local" | "github") => void,
}) {
  const [signInMethods, setSignInMethods] = useState<Set<SignInMethod>>(
    new Set(["credential", "magicLink", "google", "github"]),
  );
  const [selectedEmailThemeId, setSelectedEmailThemeId] = useState<string>(DEFAULT_EMAIL_THEME_ID);
  const [authSetupMobileTab, setAuthSetupMobileTab] = useState<"methods" | "preview">("methods");
  const configurationSteps: TimelineStep[] = [];
  if (props.selectedApps.has("authentication")) {
    configurationSteps.push({ id: "auth_setup", label: "Authentication" });
  }
  if (props.selectedApps.has("emails")) {
    configurationSteps.push({ id: "email_theme_setup", label: "Email theme" });
  }
  configurationSteps.push({ id: "welcome", label: "Setup" });
  const [stepIndex, setStepIndex] = useState(0);
  const currentStep = configurationSteps[stepIndex];

  const goBack = () => {
    if (stepIndex === 0) {
      props.onBack();
    } else {
      setStepIndex((previous) => previous - 1);
    }
  };

  if (currentStep.id === "auth_setup") {
    const authPreviewProject = {
      displayName: "My Project",
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

    return (
      <OnboardingPage
        stepKey="draft-auth-setup"
        title="Configure authentication"
        subtitle="Choose which sign-in methods to include in your config."
        steps={configurationSteps}
        currentStep={currentStep.id}
        onBack={goBack}
        wide
        primaryAction={
          <DesignButton
            className="w-full rounded-full"
            disabled={signInMethods.size === 0}
            onClick={() => setStepIndex((previous) => previous + 1)}
          >
            Continue
          </DesignButton>
        }
      >
        <DesignCard
          glassmorphic={false}
          contentClassName="overflow-hidden p-0"
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
                        checked={signInMethods.has(method.id)}
                        onCheckedChange={(checked) => {
                          setSignInMethods((previous) => {
                            const next = new Set(previous);
                            if (checked) {
                              next.add(method.id);
                            } else {
                              next.delete(method.id);
                            }
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
                authSetupMobileTab !== "preview" && "max-md:hidden",
              )}
            >
              <div className="relative flex w-full items-center justify-center">
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

  if (currentStep.id === "email_theme_setup") {
    return (
      <OnboardingPage
        stepKey="draft-email-theme-setup"
        title="Select an email theme"
        subtitle="Pick the built-in theme to include in your config."
        steps={configurationSteps}
        currentStep={currentStep.id}
        onBack={goBack}
        wide
        primaryAction={
          <DesignButton className="w-full rounded-full" onClick={() => setStepIndex((previous) => previous + 1)}>
            Continue
          </DesignButton>
        }
      >
        <EmailThemePicker
          selectedEmailThemeId={selectedEmailThemeId}
          setSelectedEmailThemeId={setSelectedEmailThemeId}
        />
      </OnboardingPage>
    );
  }

  const configFile = buildSelectedOnboardingConfigFile({
    selectedApps: props.selectedApps,
    passwordEnabled: signInMethods.has("credential"),
    otpEnabled: signInMethods.has("magicLink"),
    passkeyEnabled: signInMethods.has("passkey"),
    sharedOAuthProviderIds: SHARED_OAUTH_SIGN_IN_METHODS.filter((providerId) => signInMethods.has(providerId)),
    emailThemeId: selectedEmailThemeId,
  });
  return (
    <PreProjectSetupFlow
      steps={configurationSteps}
      currentStep="welcome"
      disabled={false}
      onBack={goBack}
      configFile={configFile}
      onDeploy={props.onDeploy}
    />
  );
}

export function PreProjectSetupFlow(props: {
  steps: TimelineStep[],
  currentStep: TimelineStep["id"],
  disabled: boolean,
  onBack: () => void,
  configFile?: string,
  onDeploy: (source: "local" | "github") => void,
}) {
  const [phase, setPhase] = useState<"installation" | "location" | "local-welcome">("installation");

  if (phase === "location") {
    return (
      <DeploymentChoicePage
        stepKey="post-install-deployment-location"
        steps={props.steps}
        currentStep={props.currentStep}
        disabled={props.disabled}
        onBack={() => setPhase("installation")}
        onSelect={(source) => {
          if (source === "local") {
            setPhase("local-welcome");
            return;
          }
          if (source === "github") {
            props.onDeploy("github");
            return;
          }
          throw new Error("Plain production is not available after local project setup.");
        }}
      />
    );
  }

  if (phase === "local-welcome") {
    return (
      <OnboardingPage
        stepKey="local-project-welcome"
        title="Welcome to Hexclave"
        steps={props.steps}
        currentStep={props.currentStep}
        onBack={() => setPhase("location")}
        disabled={props.disabled}
        primaryAction={(
          <DesignButton
            className="w-full rounded-full"
            disabled={props.disabled}
            onClick={() => props.onDeploy("local")}
          >
            Deploy my project to production
          </DesignButton>
        )}
      >
        <DesignCard
          glassmorphic
          className="border-0 bg-white/70 dark:bg-background/60"
          contentClassName="space-y-4 p-6"
        >
          <Typography className="text-sm leading-relaxed">
            Once the SDK has been installed, you can restart your dev command and access the local dashboard on{" "}
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
            Since you specified your project is locally on your computer, the Hexclave dashboard is running locally on your computer, and no Hexclave Cloud project has been created. When you&apos;re ready to deploy your project to production, you can come back here.
          </Typography>
        </DesignCard>
      </OnboardingPage>
    );
  }

  return (
    <SetupNewProjectPage
      steps={props.steps}
      currentStep={props.currentStep}
      disabled={props.disabled}
      onBack={props.onBack}
      configFile={props.configFile}
      onComplete={() => setPhase("location")}
      completionLabel="Continue"
    />
  );
}

export function SetupNewProjectPage(props: {
  steps: TimelineStep[],
  currentStep: TimelineStep["id"],
  disabled: boolean,
  onBack: () => void,
  configFile?: string,
  onComplete?: () => void | Promise<void>,
  completionLabel?: string,
  title?: string,
  subtitle?: ReactNode,
}) {
  const [setupTab, setSetupTab] = useState<"ai-prompt" | "manual">("ai-prompt");
  const manualSetupDocsUrl = getManualSetupDocsUrl();
  const setupPrompt = props.configFile == null
    ? aiSetupPrompt
    : prependConfigChangesToSetupPrompt(aiSetupPrompt, props.configFile);

  return (
    <OnboardingPage
      stepKey="setup-new-project"
      title={props.title ?? "Set up the Hexclave SDK"}
      subtitle={props.subtitle ?? "Install Hexclave in your local project, then continue."}
      steps={props.steps}
      currentStep={props.currentStep}
      onBack={props.onBack}
      disabled={props.disabled}
      primaryAction={props.onComplete == null ? (
        <DesignButton
          variant="outline"
          className="w-full rounded-full"
          onClick={props.onBack}
        >
          Go back
        </DesignButton>
      ) : (
        <DesignButton
          className="w-full rounded-full"
          onClick={props.onComplete}
        >
          {props.completionLabel ?? "Finish"}
        </DesignButton>
      )}
      secondaryAction={props.onComplete != null ? (
        <DesignButton variant="ghost" onClick={props.onBack}>Back</DesignButton>
      ) : undefined}
    >
      <div className="space-y-4">
        <div className="flex justify-center">
          <DesignPillToggle
            options={[
              { id: "ai-prompt", label: "AI Prompt" },
              { id: "manual", label: "Manual Installation" },
            ]}
            selected={setupTab}
            onSelect={(id) => setSetupTab(id === "manual" ? "manual" : "ai-prompt")}
            size="sm"
            gradient="default"
          />
        </div>

        {setupTab === "ai-prompt" ? (
          <OnboardingAiPromptBlock title="Setup prompt" content={setupPrompt} />
        ) : props.configFile != null ? (
          <div className="space-y-4 rounded-2xl bg-white/70 p-5 ring-1 ring-black/[0.06] dark:bg-background/60 dark:ring-white/[0.08]">
            <div className="grid gap-3 sm:grid-cols-[2rem_minmax(0,1fr)]">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground/[0.06] text-sm font-semibold">1</div>
              <div className="space-y-3">
                <Typography className="font-semibold">Follow the manual setup steps in the documentation</Typography>
                <DesignButton
                  variant="outline"
                  onClick={() => {
                    window.open(manualSetupDocsUrl, "_blank", "noopener,noreferrer");
                  }}
                >
                  <BookIcon className="mr-2 h-4 w-4" />
                  Open manual setup docs
                </DesignButton>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[2rem_minmax(0,1fr)]">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground/[0.06] text-sm font-semibold">2</div>
              <div className="min-w-0 space-y-3">
                <Typography className="font-semibold">Replace the hexclave.config.ts file</Typography>
                <CodeBlock
                  title="hexclave.config.ts"
                  icon="code"
                  language="typescript"
                  content={props.configFile}
                  maxHeight={320}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 rounded-2xl bg-white/70 px-6 py-10 text-center ring-1 ring-black/[0.06] dark:bg-background/60 dark:ring-white/[0.08]">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400">
              <BookIcon className="h-6 w-6" />
            </div>
            <div className="space-y-1.5">
              <Typography className="text-base font-semibold">
                Follow the Getting Started guide
              </Typography>
              <Typography variant="secondary" className="mx-auto max-w-sm text-sm leading-relaxed">
                Manual setup steps live in the docs so they stay up to date with every framework and SDK change.
              </Typography>
            </div>
            <DesignButton
              onClick={() => {
                window.open(manualSetupDocsUrl, "_blank", "noopener,noreferrer");
              }}
            >
              <BookIcon className="mr-2 h-4 w-4" />
              Open Getting Started guide
            </DesignButton>
          </div>
        )}
      </div>
    </OnboardingPage>
  );
}

export type OnboardingAppCardProps = {
  appId: AppId,
  selected: boolean,
  required: boolean,
  primary: boolean,
  disabled?: boolean,
  onToggle: () => void,
};

export function OnboardingAppCard(props: OnboardingAppCardProps) {
  const app = ALL_APPS[props.appId];

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={props.required ? undefined : props.onToggle}
          disabled={props.disabled}
          aria-disabled={props.required ? true : undefined}
          tabIndex={props.required ? -1 : undefined}
          className={cn(
            "group flex flex-col items-center gap-1.5 rounded-xl p-1 transition-opacity duration-150 hover:transition-none",
            props.primary ? "w-[100px]" : "w-[90px]",
            props.required ? "cursor-default opacity-100" : props.selected ? "opacity-100" : "opacity-70 hover:opacity-100",
            props.disabled && "pointer-events-none opacity-40",
            !props.required && "active:scale-[0.97]",
          )}
        >
          <div className="relative">
            <AppIcon appId={props.appId} enabled={props.selected} className={props.primary ? "w-20 h-20" : "w-16 h-16"} />
            {props.selected && (
              <div className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-white shadow-sm">
                <CheckCircleIcon className="h-4 w-4" weight="fill" />
              </div>
            )}
          </div>
          <Typography className={cn(
            "text-center leading-tight",
            props.primary ? "text-sm font-semibold" : "text-[11px] font-medium",
          )}>
            {app.displayName}
          </Typography>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="z-50 max-w-[240px] rounded-xl border-0 bg-white p-3 shadow-lg ring-1 ring-black/[0.06] dark:bg-background dark:ring-white/[0.06]"
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Typography className="text-sm font-semibold text-foreground">{app.displayName}</Typography>
            {props.required && (
              <DesignBadge label="Required" color="orange" size="sm" />
            )}
          </div>
          <Typography className="text-xs leading-relaxed text-muted-foreground">
            {app.subtitle}
          </Typography>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export type DomainSetupTransitionStateProps = {
  advancing: boolean,
  errorMessage: string | null,
  onRetry: () => void,
  onOpenProject: () => void,
};

export function DomainSetupTransitionState(props: DomainSetupTransitionStateProps) {
  if (props.errorMessage == null) {
    return (
      <div className="flex w-full min-h-[320px] items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center justify-center px-4 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>We couldn&apos;t continue onboarding</CardTitle>
          <CardDescription>
            Retry the automatic transition to email setup, or open the project and continue from there.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <WarningCircleIcon className="h-4 w-4" />
            <AlertTitle>Domain setup transition failed</AlertTitle>
            <AlertDescription>{props.errorMessage}</AlertDescription>
          </Alert>
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={props.onOpenProject}>
              Open Project
            </Button>
            <Button onClick={props.onRetry} disabled={props.advancing}>
              {props.advancing ? "Retrying..." : "Retry"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const ONBOARDING_EMAIL_THEME_PREVIEW_IMAGES = {
  [DEFAULT_EMAIL_THEME_ID]: "/assets/onboarding/email-theme-light.png",
  "a0172b5d-cff0-463b-83bb-85124697373a": "/assets/onboarding/email-theme-dark.png",
  "c7e2d94f-8a1b-4e6d-b3f5-9d0a2e7c1b8f": "/assets/onboarding/email-theme-colorful.png",
} as const satisfies Record<keyof typeof DEFAULT_EMAIL_THEMES, string>;

export function OnboardingEmailThemePreview(props: {
  themeId: string,
}) {
  const previewImageSrc = ONBOARDING_EMAIL_THEME_PREVIEW_IMAGES[props.themeId];
  if (typeof previewImageSrc !== "string") {
    throw new Error(`Missing static onboarding preview image for email theme ${props.themeId}.`);
  }

  return (
    // Static screenshots avoid per-onboarding email render/iframe work.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={previewImageSrc}
      alt=""
      className="h-full w-full object-cover object-top"
      draggable={false}
    />
  );
}

export function EmailThemePicker(props: {
  selectedEmailThemeId: string | null,
  setSelectedEmailThemeId: (themeId: string) => void,
  disabled?: boolean,
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {Object.entries(DEFAULT_EMAIL_THEMES).map(([themeId, theme]) => {
        const isSelected = props.selectedEmailThemeId === themeId;
        return (
          <button
            key={themeId}
            type="button"
            onClick={() => props.setSelectedEmailThemeId(themeId)}
            disabled={props.disabled}
            aria-pressed={isSelected}
            className={cn(
              "relative flex flex-col overflow-hidden rounded-2xl text-left transition-[box-shadow,background-color] duration-150 hover:transition-none",
              "disabled:cursor-not-allowed disabled:opacity-60",
              isSelected
                ? cn(
                    "bg-blue-500/[0.06] dark:bg-blue-500/[0.04] ring-1 ring-blue-500/40",
                    "shadow-[0_12px_40px_-8px_rgba(59,130,246,0.45),0_0_1px_rgba(59,130,246,0.2)]",
                    "dark:shadow-[0_14px_48px_-10px_rgba(96,165,250,0.38),0_0_1px_rgba(96,165,250,0.25)]",
                  )
                : cn(
                    "bg-white/90 dark:bg-white/[0.06]",
                    "ring-1 ring-black/[0.06] hover:ring-black/[0.10] dark:ring-white/[0.10] dark:hover:ring-white/[0.14]",
                  ),
            )}
          >
            <div
              className={cn(
                "aspect-[4/3] overflow-hidden border-b border-black/[0.06] bg-background transition-opacity duration-150 dark:border-white/[0.06]",
                !isSelected && "opacity-[0.65]",
              )}
            >
              <OnboardingEmailThemePreview themeId={themeId} />
            </div>
            <div className="flex items-center justify-between gap-2 p-3">
              <Typography
                className={cn(
                  "min-w-0 flex-1 text-sm font-medium transition-colors duration-150",
                  isSelected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {theme.displayName}
              </Typography>
              {isSelected && (
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow-sm">
                  <CheckCircleIcon className="h-4 w-4" weight="fill" />
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function WelcomeIllustration() {
  return (
    <div className="relative h-[280px] w-full sm:h-[320px] md:h-[360px] overflow-hidden">
      {/* Central shield — authentication */}
      <div className={cn(
        "absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2",
        "w-20 h-24 md:w-28 md:h-32 lg:w-32 lg:h-36",
        "rounded-2xl",
        "bg-gradient-to-br from-blue-500/20 via-indigo-500/15 to-violet-500/20",
        "backdrop-blur-xl",
        "ring-1 ring-white/20 dark:ring-white/10",
        "shadow-[0_0_60px_rgba(99,102,241,0.2)]",
        "flex flex-col items-center justify-center gap-1.5 md:gap-2",
      )}>
        <div className="w-7 h-7 md:w-9 md:h-9 lg:w-10 lg:h-10 rounded-full bg-gradient-to-br from-blue-400/40 to-indigo-500/30 ring-1 ring-blue-400/20 flex items-center justify-center">
          <div className="w-3 h-3.5 md:w-4 md:h-4.5 border-2 border-blue-400/60 rounded-sm" />
        </div>
        <div className="space-y-1">
          <div className="h-1 md:h-1.5 bg-white/15 rounded-full w-12 md:w-16 mx-auto" />
          <div className="h-1 md:h-1.5 bg-white/10 rounded-full w-8 md:w-10 mx-auto" />
        </div>
      </div>

      {/* Envelope — emails, top left */}
      <div className={cn(
        "absolute z-20",
        "top-[15%] left-[12%] md:left-[18%] lg:left-[22%]",
        "w-14 h-10 md:w-20 md:h-14 lg:w-24 lg:h-16",
        "rounded-xl",
        "bg-gradient-to-br from-emerald-500/18 to-teal-500/12",
        "ring-1 ring-emerald-500/20",
        "shadow-[0_0_24px_rgba(16,185,129,0.15)]",
        "rotate-[-8deg]",
        "flex items-center justify-center overflow-hidden",
      )}>
        <div className="relative w-full h-full">
          <div className="absolute inset-x-0 top-0 h-[45%] bg-gradient-to-b from-emerald-400/15 to-transparent" style={{ clipPath: "polygon(0 0, 50% 80%, 100% 0)" }} />
          <div className="absolute bottom-1.5 left-1.5 right-1.5 space-y-0.5 md:space-y-1 md:bottom-2 md:left-2.5 md:right-2.5">
            <div className="h-0.5 md:h-1 bg-emerald-500/15 rounded-full w-3/4" />
            <div className="h-0.5 md:h-1 bg-emerald-500/10 rounded-full w-1/2" />
          </div>
        </div>
      </div>

      {/* Credit card — payments, bottom right */}
      <div className={cn(
        "absolute z-20",
        "bottom-[18%] right-[10%] md:right-[16%] lg:right-[20%]",
        "w-16 h-10 md:w-24 md:h-14 lg:w-28 lg:h-16",
        "rounded-xl",
        "bg-gradient-to-br from-violet-500/18 to-purple-500/12",
        "ring-1 ring-violet-500/20",
        "shadow-[0_0_24px_rgba(139,92,246,0.15)]",
        "rotate-[6deg]",
        "flex flex-col justify-between p-2 md:p-3",
      )}>
        <div className="flex justify-between items-start">
          <div className="w-4 h-3 md:w-6 md:h-4 rounded-sm bg-gradient-to-br from-amber-400/50 to-amber-600/30 ring-1 ring-amber-500/20" />
          <div className="flex gap-0.5">
            <div className="w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-violet-400/30 -mr-1" />
            <div className="w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-purple-400/30" />
          </div>
        </div>
        <div className="h-0.5 md:h-1 bg-white/10 rounded-full w-2/3" />
      </div>

      {/* Bar chart — analytics, top right */}
      <div className={cn(
        "absolute z-10",
        "top-[20%] right-[14%] md:right-[20%] lg:right-[24%]",
        "w-12 h-12 md:w-16 md:h-16 lg:w-20 lg:h-20",
        "rounded-xl",
        "bg-gradient-to-br from-cyan-500/15 to-blue-500/10",
        "ring-1 ring-cyan-500/20",
        "shadow-[0_0_20px_rgba(6,182,212,0.12)]",
        "rotate-[5deg]",
        "flex items-end justify-center gap-0.5 md:gap-1 p-2 md:p-2.5 lg:p-3",
      )}>
        <div className="w-1.5 md:w-2 h-[30%] bg-cyan-400/40 rounded-full" />
        <div className="w-1.5 md:w-2 h-[55%] bg-cyan-400/50 rounded-full" />
        <div className="w-1.5 md:w-2 h-[80%] bg-cyan-400/60 rounded-full" />
        <div className="w-1.5 md:w-2 h-[45%] bg-cyan-400/40 rounded-full" />
      </div>

      {/* People — teams, bottom left */}
      <div className={cn(
        "absolute z-10",
        "bottom-[20%] left-[12%] md:left-[18%] lg:left-[22%]",
        "w-14 h-11 md:w-20 md:h-14 lg:w-24 lg:h-16",
        "rounded-xl",
        "bg-gradient-to-br from-amber-500/15 to-orange-500/10",
        "ring-1 ring-amber-500/18",
        "shadow-[0_0_20px_rgba(245,158,11,0.12)]",
        "rotate-[-4deg]",
        "flex items-center justify-center gap-1 md:gap-1.5",
      )}>
        <div className="flex flex-col items-center">
          <div className="w-2.5 h-2.5 md:w-3.5 md:h-3.5 rounded-full bg-amber-400/40" />
          <div className="w-4 h-2 md:w-5 md:h-2.5 rounded-t-full bg-amber-400/25 mt-0.5" />
        </div>
        <div className="flex flex-col items-center -ml-0.5">
          <div className="w-2.5 h-2.5 md:w-3.5 md:h-3.5 rounded-full bg-orange-400/40" />
          <div className="w-4 h-2 md:w-5 md:h-2.5 rounded-t-full bg-orange-400/25 mt-0.5" />
        </div>
        <div className="flex flex-col items-center -ml-0.5">
          <div className="w-2.5 h-2.5 md:w-3.5 md:h-3.5 rounded-full bg-amber-400/30" />
          <div className="w-4 h-2 md:w-5 md:h-2.5 rounded-t-full bg-amber-400/20 mt-0.5" />
        </div>
      </div>

      {/* Key — API keys, floating small */}
      <div className={cn(
        "absolute z-20",
        "top-[40%] right-[6%] md:right-[10%] lg:right-[14%]",
        "w-8 h-8 md:w-11 md:h-11 lg:w-14 lg:h-14",
        "rounded-lg md:rounded-xl",
        "bg-gradient-to-br from-rose-500/15 to-pink-500/10",
        "ring-1 ring-rose-500/18",
        "shadow-[0_0_16px_rgba(244,63,94,0.1)]",
        "rotate-[15deg]",
        "flex items-center justify-center",
      )}>
        <div className="w-3 h-3 md:w-4 md:h-4 lg:w-5 lg:h-5 rounded-full border-2 border-rose-400/40 relative">
          <div className="absolute left-full top-1/2 -translate-y-1/2 w-1.5 md:w-2 lg:w-2.5 h-0.5 bg-rose-400/30 rounded-full" />
        </div>
      </div>

      {/* Webhook/automation icon — left mid */}
      <div className={cn(
        "absolute z-10 hidden md:flex",
        "top-[48%] left-[6%] lg:left-[12%]",
        "w-10 h-10 lg:w-14 lg:h-14",
        "rounded-xl",
        "bg-gradient-to-br from-sky-500/12 to-indigo-500/8",
        "ring-1 ring-sky-500/15",
        "rotate-[-12deg]",
        "items-center justify-center",
        "opacity-60",
      )}>
        <div className="flex flex-col gap-0.5 lg:gap-1">
          <div className="h-0.5 lg:h-1 w-4 lg:w-6 bg-sky-400/30 rounded-full" />
          <div className="h-0.5 lg:h-1 w-3 lg:w-4 bg-sky-400/20 rounded-full" />
        </div>
      </div>

      {/* Decorative ring — top center */}
      <div className={cn(
        "absolute",
        "top-[6%] left-[42%] md:left-[44%]",
        "w-6 h-6 md:w-8 md:h-8 rounded-full",
        "ring-1 ring-blue-500/15",
        "opacity-40",
      )} />

      {/* Decorative dot — bottom center right */}
      <div className={cn(
        "absolute",
        "bottom-[10%] right-[35%] md:right-[38%]",
        "w-2.5 h-2.5 md:w-3 md:h-3 rounded-full",
        "bg-indigo-500/15",
        "ring-1 ring-indigo-500/10",
      )} />

      {/* Decorative dot — top left */}
      <div className={cn(
        "absolute hidden lg:block",
        "top-[10%] left-[8%]",
        "w-2 h-2 rounded-full",
        "bg-emerald-500/15",
      )} />

      {/* Decorative ring — bottom right */}
      <div className={cn(
        "absolute hidden md:block",
        "bottom-[8%] right-[8%] lg:right-[12%]",
        "w-5 h-5 lg:w-7 lg:h-7 rounded-full",
        "ring-1 ring-purple-500/12",
        "opacity-30",
      )} />

      {/* Decorative dot — right edge */}
      <div className={cn(
        "absolute hidden lg:block",
        "top-[60%] right-[6%]",
        "w-1.5 h-1.5 rounded-full",
        "bg-rose-400/20",
      )} />

      {/* Soft radial glow behind the center */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 md:w-80 md:h-80 rounded-full pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(99,102,241,0.06) 0%, transparent 70%)" }}
      />
    </div>
  );
}

export type WelcomeSlideProps = {
  steps: TimelineStep[],
  saving: boolean,
  enabledApps: Record<string, { enabled?: boolean } | undefined>,
  onFinish: () => void,
};

export function WelcomeSlide(props: WelcomeSlideProps) {
  const currentIndex = props.steps.findIndex((step) => step.id === "welcome");

  return (
    <div className="flex w-full flex-grow flex-col items-center justify-center px-4 pb-28 pt-8">
      <div
        key="welcome"
        className="flex w-full max-w-xl flex-col items-center"
      >
        <div className="onboarding-cascade w-full" style={{ "--cascade-i": 0 } as CSSProperties}>
          <WelcomeIllustration />
        </div>

        <div className="onboarding-cascade flex flex-col items-center gap-3 text-center" style={{ "--cascade-i": 1 } as CSSProperties}>
          <Typography className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Welcome to Hexclave
          </Typography>
          <Typography variant="secondary" className="mx-auto max-w-sm text-sm leading-relaxed text-balance">
            Your project is ready. Start building with authentication, emails, payments, and more — all in one place.
          </Typography>
        </div>

        <div className="onboarding-cascade mt-8" style={{ "--cascade-i": 2 } as CSSProperties}>
          <DesignButton
            className="min-w-[200px] rounded-full"
            loading={props.saving}
            onClick={props.onFinish}
          >
            Get Started
          </DesignButton>
        </div>
      </div>

      <OnboardingBottomChrome>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-[5px]">
            {props.steps.map((step, index) => {
              const isComplete = index < currentIndex;
              const isCurrent = index === currentIndex;

              return (
                <div
                  key={step.id}
                  aria-label={step.label}
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "rounded-full",
                    isCurrent
                      ? "h-[6px] w-5 bg-foreground"
                      : isComplete
                        ? "h-[6px] w-[6px] bg-foreground/60"
                        : "h-[6px] w-[6px] bg-foreground/20",
                  )}
                  title={step.label}
                />
              );
            })}
          </div>
        </div>
      </OnboardingBottomChrome>
    </div>
  );
}

export function ModeNotImplementedCard(props: { onBack: () => void }) {
  return (
    <div className="mx-auto flex min-h-[260px] w-full max-w-2xl flex-col items-center justify-center gap-6 text-center">
      <DesignAlert
        variant="warning"
        title="Not available yet"
        description="Linking an existing config into onboarding is not available yet."
      />
      <div className="flex justify-center">
        <DesignButton variant="outline" className="rounded-full px-8" onClick={props.onBack}>
          Go Back
        </DesignButton>
      </div>
    </div>
  );
}

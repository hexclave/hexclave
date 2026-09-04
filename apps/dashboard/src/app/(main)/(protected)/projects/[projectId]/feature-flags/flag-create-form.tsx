"use client";

import {
  DesignAlert,
  DesignButton,
  DesignCard,
  DesignDialog,
  DesignDialogClose,
  DesignInput,
  DesignPillToggle,
} from "@/components/design-components";
import { cn } from "@/components/ui";
import {
  changeFlagDraftType,
  describeCurrentRollout,
  formatBps,
  suggestFlagKey,
  validateFlagConfig,
  validateFlagKey,
  type FeatureFlagsSection,
  type FlagConfig,
  type FlagValueType,
} from "@/lib/feature-flags/config";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import {
  CaretRightIcon,
  PencilSimpleIcon,
  PlusIcon,
  PowerIcon,
  RocketLaunchIcon,
} from "@phosphor-icons/react";
import { useId, useMemo, useState } from "react";
import {
  FlagPrerequisitesCard,
  FlagRulesCard,
  FlagSafetyCard,
  FlagServingCard,
  FlagVariantsCard,
} from "./flag-editor";
import { generateShortId } from "./shared";

/**
 * Blank draft for the create form: a boolean release flag with auto-generated
 * On/Off variants, fallback and default both Off, and disabled at creation.
 * This is deliberately the safest possible flag — creating it changes nothing
 * for any user until it is explicitly turned on.
 */
export function createEmptyFlagDraft(nowMillis: number): FlagConfig {
  const enabledVariantId = generateShortId("variant");
  const disabledVariantId = generateShortId("variant");
  return {
    internalId: generateShortId("flag"),
    displayName: "",
    description: "",
    type: "boolean",
    enabled: false,
    killed: false,
    archived: false,
    variants: [
      { id: enabledVariantId, label: "On", jsonValue: "true" },
      { id: disabledVariantId, label: "Off", jsonValue: "false" },
    ],
    fallbackVariantId: disabledVariantId,
    defaultServe: { type: "variant", variantId: disabledVariantId },
    rules: [],
    prerequisites: [],
    holdoutBps: 0,
    mutualExclusionGroup: null,
    createdAtMillis: nowMillis,
  };
}

const FLAG_VALUE_TYPES: readonly FlagValueType[] = ["boolean", "string", "number", "json"];

const FLAG_TYPE_OPTIONS = [
  // "On/Off" instead of "Boolean": the plain-language framing of the
  // recommended release-flag path. The other three are named after what the
  // SDK returns, which is the mental model a developer picks them by.
  { id: "boolean", label: "On/Off" },
  { id: "string", label: "String" },
  { id: "number", label: "Number" },
  { id: "json", label: "JSON" },
];

export type FlagCreateFormProps = {
  initialFlag: FlagConfig,
  section: FeatureFlagsSection,
  /** Called once validation passed (and, for enabled flags, the review was confirmed). */
  onCreate: (flagKey: string, flag: FlagConfig) => Promise<void>,
};

/**
 * Deliberately minimal creation flow: name → auto-generated key → Create flag.
 * The full evaluator model (variants, serving, targeting, prerequisites,
 * holdouts) stays available behind a single "Customize before creating"
 * disclosure, reusing the same section cards as the edit-mode `FlagEditor` —
 * but the common path never has to see it, because the draft is created
 * disabled and therefore safe by construction.
 */
export function FlagCreateForm(props: FlagCreateFormProps) {
  const [draft, setDraft] = useState<FlagConfig>(props.initialFlag);
  // null = key follows the display name via suggestFlagKey; a string means the
  // developer took over and the name no longer drives the key.
  const [manualKey, setManualKey] = useState<string | null>(null);
  const [keyEditing, setKeyEditing] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  // Validation is only surfaced after the first create attempt so an empty
  // fresh form doesn't greet the developer with errors; once shown, the list
  // live-updates (and disappears) as problems are fixed.
  const [showErrors, setShowErrors] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const nameId = useId();
  const keyId = useId();
  const descriptionId = useId();
  const customizePanelId = useId();

  const flagKey = manualKey ?? suggestFlagKey(draft.displayName);
  const update = (patch: Partial<FlagConfig>) => setDraft((current) => ({ ...current, ...patch }));

  const keyError = flagKey.length > 0 ? validateFlagKey(flagKey) : null;
  const keyTakenError = props.section.flags.has(flagKey) ? "A flag with this key already exists." : null;

  const validationErrors = useMemo(() => {
    const errors = validateFlagConfig(flagKey, draft, props.section);
    if (keyTakenError != null) errors.push(keyTakenError);
    return errors;
  }, [draft, flagKey, keyTakenError, props.section]);

  const fallbackLabel = draft.variants.find((variant) => variant.id === draft.fallbackVariantId)?.label
    ?? throwErr("The draft's fallback variant is missing — the create form must keep the draft internally consistent");

  const handleCreate = async () => {
    if (validationErrors.length > 0) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    if (draft.enabled) {
      // Only an enabled flag affects traffic at creation time, so only that
      // path gets a review step; the disabled default creates in one click.
      setReviewOpen(true);
      return;
    }
    await props.onCreate(flagKey, draft);
  };

  return (
    <div className="flex flex-col gap-4">
      <DesignCard>
        <div className="flex w-full max-w-2xl flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground">Name</label>
            <DesignInput
              id={nameId}
              autoFocus
              placeholder="Checkout redesign"
              value={draft.displayName}
              aria-invalid={showErrors && draft.displayName.trim().length === 0}
              onChange={(event) => update({ displayName: event.target.value })}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={keyId} className="text-xs font-medium text-muted-foreground">SDK key</label>
            {keyEditing ? (
              <>
                <div className="flex max-w-md items-center gap-2">
                  <DesignInput
                    id={keyId}
                    size="sm"
                    className="font-mono"
                    autoFocus
                    placeholder="checkout-redesign"
                    value={flagKey}
                    aria-invalid={keyError != null || keyTakenError != null}
                    onChange={(event) => setManualKey(event.target.value)}
                  />
                  {manualKey != null && (
                    <DesignButton
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setManualKey(null)}
                    >
                      Use suggestion
                    </DesignButton>
                  )}
                </div>
                <span className={cn("text-xs", (keyError ?? keyTakenError) != null ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                  {keyError ?? keyTakenError ?? "Lowercase letters, digits, and dashes. This is the key your code looks up."}
                </span>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  {flagKey.length > 0 ? (
                    <code className="rounded-lg bg-foreground/[0.04] px-2 py-1 font-mono text-xs" aria-label={`SDK key: ${flagKey}`}>
                      {flagKey}
                    </code>
                  ) : (
                    <span className="py-1 text-xs text-muted-foreground/70">Generated from the name as you type</span>
                  )}
                  <DesignButton
                    variant="ghost"
                    size="sm"
                    aria-label="Edit SDK key"
                    onClick={() => setKeyEditing(true)}
                  >
                    <PencilSimpleIcon className="mr-1 h-3.5 w-3.5" />
                    Edit
                  </DesignButton>
                </div>
                {keyTakenError != null && (
                  <span className="text-xs text-red-600 dark:text-red-400">{keyTakenError}</span>
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={descriptionId} className="text-xs font-medium text-muted-foreground">
              Description <span className="font-normal text-muted-foreground/70">(optional)</span>
            </label>
            <DesignInput
              id={descriptionId}
              size="sm"
              placeholder="What does this flag control?"
              value={draft.description}
              onChange={(event) => update({ description: event.target.value })}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Type</span>
            <div className="self-start">
              <DesignPillToggle
                size="sm"
                options={FLAG_TYPE_OPTIONS}
                selected={draft.type}
                onSelect={(id) => {
                  const type = FLAG_VALUE_TYPES.find((candidate) => candidate === id);
                  if (type != null) setDraft((current) => changeFlagDraftType(current, type));
                }}
              />
            </div>
            <span className="text-xs text-muted-foreground">
              {draft.type === "boolean"
                ? "Two variants, On and Off — right for releases, kill switches, and gradual rollouts."
                : "Serves typed values instead of on/off — define them below. The type can't change after creation."}
            </span>
          </div>

          {draft.enabled ? (
            <DesignAlert
              variant="warning"
              title="Goes live immediately"
              description={`This flag is set to be on at creation: ${describeCurrentRollout(draft)}. You'll review it before creating.`}
            />
          ) : (
            <DesignAlert
              variant="info"
              title="Created off — safe to create now"
              description={`Everyone receives ${fallbackLabel} until you turn the flag on and choose a rollout.`}
            />
          )}
        </div>
      </DesignCard>

      {/* Non-boolean flags need their values defined before creation, so this
          is the one advanced card that surfaces on the primary path. It moves
          into the customize panel for boolean flags, where On/Off just works. */}
      {draft.type !== "boolean" && <FlagVariantsCard draft={draft} onChange={update} />}

      <DesignButton
        variant="ghost"
        size="sm"
        className="self-start"
        aria-expanded={customizeOpen}
        aria-controls={customizePanelId}
        onClick={() => setCustomizeOpen(!customizeOpen)}
      >
        <CaretRightIcon className={cn("mr-1.5 h-3.5 w-3.5 transition-transform duration-150", customizeOpen && "rotate-90")} />
        Customize before creating
        <span className="ml-2 hidden font-normal text-muted-foreground sm:inline">
          launch state · variants · rollout · targeting · dependencies
        </span>
      </DesignButton>

      {customizeOpen && (
        <div id={customizePanelId} className="flex flex-col gap-4">
          <DesignCard
            title="Launch state"
            subtitle="Whether the flag starts serving traffic right away"
            icon={PowerIcon}
            gradient="default"
          >
            <div className="flex flex-col gap-2">
              <div className="self-start">
                <DesignPillToggle
                  size="sm"
                  options={[
                    { id: "disabled", label: "Off at creation" },
                    { id: "enabled", label: "On at creation" },
                  ]}
                  selected={draft.enabled ? "enabled" : "disabled"}
                  onSelect={(id) => update({ enabled: id === "enabled" })}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {draft.enabled
                  ? "Traffic starts receiving this flag the moment it is created."
                  : "Recommended — create the flag now, turn it on once your code has shipped."}
              </span>
            </div>
          </DesignCard>
          {draft.type === "boolean" && <FlagVariantsCard draft={draft} onChange={update} />}
          <FlagServingCard draft={draft} onChange={update} />
          <FlagRulesCard draft={draft} onChange={update} section={props.section} />
          <FlagPrerequisitesCard draft={draft} onChange={update} section={props.section} ownFlagKey={flagKey} />
          <FlagSafetyCard draft={draft} onChange={update} />
        </div>
      )}

      {showErrors && validationErrors.length > 0 && (
        <DesignAlert
          variant="error"
          title="Fix these to create the flag"
          description={
            <ul className="list-disc space-y-1 pl-4">
              {validationErrors.map((error, index) => <li key={index}>{error}</li>)}
            </ul>
          }
        />
      )}

      <div className="flex items-center justify-end gap-3">
        <span className="text-xs text-muted-foreground">
          {draft.enabled ? "Live immediately after creation" : `Created off — everyone receives ${fallbackLabel}`}
        </span>
        <DesignButton size="sm" onClick={handleCreate}>
          <PlusIcon className="mr-1 h-4 w-4" />
          Create flag
        </DesignButton>
      </div>

      <DesignDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        size="lg"
        icon={RocketLaunchIcon}
        title="This flag goes live immediately"
        description="It is set to be on at creation, so traffic starts receiving it right away."
        footer={
          <>
            <DesignDialogClose asChild>
              <DesignButton variant="secondary" size="sm">Keep editing</DesignButton>
            </DesignDialogClose>
            <DesignButton
              size="sm"
              onClick={async () => {
                await props.onCreate(flagKey, draft);
                setReviewOpen(false);
              }}
            >
              Create flag
            </DesignButton>
          </>
        }
      >
        <ul className="space-y-1.5 text-sm">
          {summarizeCreateDraft(draft).map((line, index) => (
            <li key={index} className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/40" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </DesignDialog>
    </div>
  );
}

function summarizeCreateDraft(flag: FlagConfig): string[] {
  const lines = [
    `${flag.type} flag with ${flag.variants.length} variant${flag.variants.length === 1 ? "" : "s"}.`,
    `Serving: ${describeCurrentRollout(flag)}.`,
  ];
  if (flag.rules.length > 0) lines.push(`${flag.rules.length} targeting rule${flag.rules.length === 1 ? "" : "s"} evaluated before the default.`);
  if (flag.holdoutBps > 0) lines.push(`Holdout: ${formatBps(flag.holdoutBps)} of traffic always receives the fallback.`);
  if (flag.prerequisites.length > 0) lines.push(`${flag.prerequisites.length} prerequisite${flag.prerequisites.length === 1 ? "" : "s"} must be met before evaluation.`);
  if (flag.mutualExclusionGroup != null) lines.push(`In mutual exclusion group "${flag.mutualExclusionGroup}".`);
  return lines;
}

"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignDialog,
  DesignDialogClose,
  DesignInput,
  DesignPillToggle,
  DesignSelectorDropdown,
} from "@/components/design-components";
import {
  BPS_TOTAL,
  defaultVariantJsonValue,
  FLAG_OPERATORS,
  formatBps,
  getOperatorMetadataOrThrow,
  validateFlagConfig,
  validateFlagKey,
  validateVariantJsonValue,
  type FeatureFlagsSection,
  type FlagCondition,
  type FlagConfig,
  type FlagRule,
  type FlagServe,
  type FlagValueType,
  type FlagVariant,
} from "@/lib/feature-flags/config";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FlagIcon,
  GitBranchIcon,
  LinkIcon,
  PlusIcon,
  RocketLaunchIcon,
  ShieldCheckIcon,
  SlidersIcon,
  StackIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { getInputDatetimeLocalString } from "@hexclave/shared/dist/utils/dates";
import { isJsonSerializable, type Json } from "@hexclave/shared/dist/utils/json";
import { useId, useMemo, useState } from "react";
import { generateShortId, PercentField } from "./shared";

/**
 * Common evaluation-context attributes offered in the condition editor. Rules
 * can also target any custom attribute via the "Custom attribute…" option —
 * the backend contract namespaces those under `custom.<name>`.
 */
const COMMON_ATTRIBUTES = [
  { value: "user.id", label: "User ID" },
  { value: "user.email", label: "User email" },
  { value: "user.signedUpAt", label: "User signed up at" },
  { value: "team.id", label: "Team ID" },
  { value: "environment", label: "Environment" },
  { value: "app.version", label: "App version" },
] as const;

const CUSTOM_ATTRIBUTE_OPTION = "__custom__";

export type FlagEditorProps = {
  /** The flag's current public key. The editor allows renaming it. */
  fixedFlagKey: string,
  initialFlag: FlagConfig,
  section: FeatureFlagsSection,
  /** Called after the publish review is confirmed and validation passed. */
  onPublish: (flagKey: string, flag: FlagConfig) => Promise<void>,
};

/**
 * Full management surface for an existing flag. Creating a flag deliberately
 * does NOT use this editor — it goes through the much smaller
 * `FlagCreateForm` (flag-create-form.tsx). This editor exposes the entire
 * evaluator model, which is the right altitude for managing a live rollout
 * but overwhelming when all you want is a new flag.
 */
export function FlagEditor(props: FlagEditorProps) {
  const [flagKey, setFlagKey] = useState(props.fixedFlagKey);
  const [draft, setDraft] = useState<FlagConfig>(props.initialFlag);
  const [reviewOpen, setReviewOpen] = useState(false);
  const displayNameId = useId();
  const keyId = useId();
  const descriptionId = useId();

  const update = (patch: Partial<FlagConfig>) => setDraft((current) => ({ ...current, ...patch }));

  const keyError = flagKey.length > 0 ? validateFlagKey(flagKey) : null;
  const keyTakenError = props.section.flags.has(flagKey) && flagKey !== props.fixedFlagKey
    ? "A flag with this key already exists." : null;

  const validationErrors = useMemo(() => {
    const errors = validateFlagConfig(flagKey, draft, props.section);
    if (keyTakenError != null) errors.push(keyTakenError);
    return errors;
  }, [draft, flagKey, keyTakenError, props.section]);

  const changeSummary = useMemo(
    () => summarizeChanges(props.initialFlag, draft),
    [props.initialFlag, draft],
  );

  const hasChanges = changeSummary.length > 0 || flagKey !== props.fixedFlagKey;

  return (
    <div className="flex flex-col gap-4">
      <DesignCard title="Metadata" icon={FlagIcon} gradient="default">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor={displayNameId} className="text-xs font-medium text-muted-foreground">Display name</label>
            <DesignInput
              id={displayNameId}
              size="sm"
              placeholder="Checkout redesign"
              value={draft.displayName}
              onChange={(event) => update({ displayName: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={keyId} className="text-xs font-medium text-muted-foreground">Key</label>
            <DesignInput
              id={keyId}
              size="sm"
              className="font-mono"
              placeholder="checkout-redesign"
              value={flagKey}
              aria-invalid={keyError != null || keyTakenError != null}
              onChange={(event) => setFlagKey(event.target.value)}
            />
            {(keyError ?? keyTakenError) != null ? (
              <span className="text-xs text-red-600 dark:text-red-400">{keyError ?? keyTakenError}</span>
            ) : (
              <span className="text-xs text-muted-foreground">Lowercase letters, digits, and dashes. Renaming changes the SDK lookup key but preserves the flag&apos;s history.</span>
            )}
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label htmlFor={descriptionId} className="text-xs font-medium text-muted-foreground">Description</label>
            <DesignInput
              id={descriptionId}
              size="sm"
              placeholder="What does this flag control?"
              value={draft.description}
              onChange={(event) => update({ description: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Value type</span>
            <div className="flex items-center gap-2">
              <DesignBadge label={draft.type} color="cyan" size="sm" />
              <span className="text-xs text-muted-foreground">The value type cannot change after creation.</span>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">State</span>
            <div className="self-start">
              <DesignPillToggle
                size="sm"
                options={[
                  { id: "enabled", label: "Enabled" },
                  { id: "disabled", label: "Disabled" },
                ]}
                selected={draft.enabled ? "enabled" : "disabled"}
                onSelect={(id) => update({ enabled: id === "enabled" })}
              />
            </div>
            <span className="text-xs text-muted-foreground">Disabled flags serve the fallback variant to everyone.</span>
          </div>
        </div>
      </DesignCard>

      <FlagVariantsCard draft={draft} onChange={update} />

      <FlagServingCard draft={draft} onChange={update} />

      <FlagRulesCard draft={draft} onChange={update} section={props.section} />

      <FlagPrerequisitesCard draft={draft} onChange={update} section={props.section} ownFlagKey={props.fixedFlagKey} />

      <FlagSafetyCard draft={draft} onChange={update} />

      <div className="flex items-center justify-end gap-2">
        {!hasChanges && (
          <span className="text-xs text-muted-foreground">No unpublished changes</span>
        )}
        <DesignButton
          size="sm"
          disabled={!hasChanges}
          onClick={() => setReviewOpen(true)}
        >
          <RocketLaunchIcon className="h-4 w-4 mr-1" />
          Review & publish
        </DesignButton>
      </div>

      <DesignDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        size="2xl"
        icon={RocketLaunchIcon}
        title="Review changes"
        description="Changes apply to live traffic as soon as they are published."
        footer={
          <>
            <DesignDialogClose asChild>
              <DesignButton variant="secondary" size="sm">Keep editing</DesignButton>
            </DesignDialogClose>
            <DesignButton
              size="sm"
              disabled={validationErrors.length > 0}
              onClick={async () => {
                await props.onPublish(flagKey, draft);
                setReviewOpen(false);
              }}
            >
              Publish changes
            </DesignButton>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {validationErrors.length > 0 && (
            <DesignAlert
              variant="error"
              title="Fix these before publishing"
              description={
                <ul className="list-disc pl-4 space-y-1">
                  {validationErrors.map((error, index) => <li key={index}>{error}</li>)}
                </ul>
              }
            />
          )}
          <ul className="text-sm space-y-1.5">
            {changeSummary.map((line, index) => (
              <li key={index} className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 rounded-full bg-foreground/40 shrink-0" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          {!draft.enabled && (
            <DesignAlert
              variant="info"
              title="Flag is disabled"
              description="It will publish in the disabled state and serve the fallback variant until enabled."
            />
          )}
        </div>
      </DesignDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advanced section cards
//
// Each card edits one aspect of a FlagConfig draft via partial patches. They
// are shared between the full editor above and the create form's "Customize
// before creating" disclosure (flag-create-form.tsx), so the create path
// exposes the exact same controls without duplicating them.
// ---------------------------------------------------------------------------

export type FlagDraftSectionProps = {
  draft: FlagConfig,
  /** Merges a partial update into the draft. */
  onChange: (patch: Partial<FlagConfig>) => void,
};

export function FlagVariantsCard(props: FlagDraftSectionProps) {
  const { draft, onChange } = props;
  return (
    <DesignCard
      title="Variants"
      subtitle="The typed values this flag can serve"
      icon={StackIcon}
      gradient="default"
    >
      <div className="flex flex-col gap-3">
        {draft.variants.map((variant, index) => (
          <VariantCard
            key={variant.id}
            variant={variant}
            flagType={draft.type}
            isFallback={variant.id === draft.fallbackVariantId}
            isOnlyVariant={draft.variants.length === 1}
            onChange={(updated) => onChange({
              variants: draft.variants.map((other, otherIndex) => otherIndex === index ? updated : other),
            })}
            onRemove={() => {
              // Removing a variant that other parts reference would corrupt
              // the flag; validation also catches it, but blocking here is
              // clearer.
              onChange({ variants: draft.variants.filter((_, otherIndex) => otherIndex !== index) });
            }}
            removeDisabledReason={
              draft.variants.length === 1 ? "A flag needs at least one variant."
                : variant.id === draft.fallbackVariantId ? "This variant is the fallback — pick a different fallback first."
                  : isVariantServed(draft, variant.id) ? "This variant is referenced by a rule or the default — update those first."
                    : null
            }
          />
        ))}
        <div>
          <DesignButton
            variant="outline"
            size="sm"
            onClick={() => onChange({
              variants: [...draft.variants, {
                id: generateShortId("variant"),
                label: `Variant ${draft.variants.length + 1}`,
                jsonValue: defaultVariantJsonValue(draft.type, draft.variants.length),
              }],
            })}
          >
            <PlusIcon className="h-3.5 w-3.5 mr-1" />
            Add variant
          </DesignButton>
        </div>
      </div>
    </DesignCard>
  );
}

export function FlagServingCard(props: FlagDraftSectionProps) {
  const { draft, onChange } = props;
  return (
    <DesignCard
      title="Serving"
      subtitle="What users receive by default, and when things go wrong"
      icon={SlidersIcon}
      gradient="default"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Fallback variant</span>
          <div className="max-w-xs">
            <DesignSelectorDropdown
              size="sm"
              value={draft.fallbackVariantId}
              onValueChange={(value) => onChange({ fallbackVariantId: value })}
              options={draft.variants.map((variant) => ({ value: variant.id, label: variant.label }))}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            Served when the flag is disabled or killed, the user is held out, or evaluation fails. SDK callers also pass a local fallback for network failures.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Default rule (no targeting rule matched)</span>
          <ServeEditor
            serve={draft.defaultServe}
            variants={draft.variants}
            onChange={(serve) => onChange({ defaultServe: serve })}
          />
        </div>
      </div>
    </DesignCard>
  );
}

export function FlagRulesCard(props: FlagDraftSectionProps & { section: FeatureFlagsSection }) {
  const { draft, onChange } = props;
  return (
    <DesignCard
      title="Targeting rules"
      subtitle="Evaluated top to bottom; the first matching rule wins"
      icon={GitBranchIcon}
      gradient="default"
    >
      <div className="flex flex-col gap-3">
        {draft.rules.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No targeting rules — everyone gets the default rule above. Add a rule to target specific users, teams, or environments.
          </p>
        )}
        {draft.rules.map((rule, index) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            index={index}
            ruleCount={draft.rules.length}
            variants={draft.variants}
            section={props.section}
            onChange={(updated) => onChange({ rules: draft.rules.map((other, otherIndex) => otherIndex === index ? updated : other) })}
            onRemove={() => onChange({ rules: draft.rules.filter((_, otherIndex) => otherIndex !== index) })}
            onMove={(direction) => {
              const target = index + (direction === "up" ? -1 : 1);
              if (target < 0 || target >= draft.rules.length) return;
              const reordered = [...draft.rules];
              const [moved] = reordered.splice(index, 1);
              reordered.splice(target, 0, moved);
              onChange({ rules: reordered });
            }}
          />
        ))}
        <div>
          <DesignButton
            variant="outline"
            size="sm"
            onClick={() => onChange({
              rules: [...draft.rules, {
                id: generateShortId("rule"),
                label: `Rule ${draft.rules.length + 1}`,
                enabled: true,
                conditions: [{ attribute: "user.email", operator: "ends_with", value: "" }],
                serve: { type: "variant", variantId: draft.variants[0]?.id ?? draft.fallbackVariantId },
                rolloutBps: BPS_TOTAL,
              }],
            })}
          >
            <PlusIcon className="h-3.5 w-3.5 mr-1" />
            Add rule
          </DesignButton>
        </div>
      </div>
    </DesignCard>
  );
}

export function FlagPrerequisitesCard(props: FlagDraftSectionProps & {
  section: FeatureFlagsSection,
  /** This flag's own public key, excluded from the prerequisite choices. */
  ownFlagKey: string,
}) {
  const { draft, onChange } = props;
  const candidateKeys = [...props.section.flags.keys()].filter((key) => key !== props.ownFlagKey);
  return (
    <DesignCard
      title="Prerequisites"
      subtitle="Only evaluate this flag when other flags serve specific variants"
      icon={LinkIcon}
      gradient="default"
    >
      <div className="flex flex-col gap-3">
        {draft.prerequisites.length === 0 && (
          <p className="text-sm text-muted-foreground">No prerequisites — this flag evaluates independently.</p>
        )}
        {draft.prerequisites.map((prerequisite, index) => {
          const prerequisiteFlag = props.section.flags.get(prerequisite.flagKey);
          return (
            <div key={`${prerequisite.flagKey}-${index}`} className="flex flex-wrap items-center gap-2">
              <DesignSelectorDropdown
                size="sm"
                className="w-56"
                value={prerequisite.flagKey}
                placeholder="Select flag"
                onValueChange={(value) => {
                  const targetFlag = props.section.flags.get(value);
                  onChange({
                    prerequisites: draft.prerequisites.map((other, otherIndex) => otherIndex === index ? {
                      flagKey: value,
                      requiredVariantId: targetFlag?.variants[0]?.id ?? "",
                    } : other),
                  });
                }}
                options={candidateKeys.map((key) => ({ value: key, label: props.section.flags.get(key)?.displayName ?? key }))}
              />
              <span className="text-xs text-muted-foreground">must serve</span>
              <DesignSelectorDropdown
                size="sm"
                className="w-44"
                value={prerequisite.requiredVariantId}
                placeholder="Select variant"
                disabled={prerequisiteFlag == null}
                onValueChange={(value) => onChange({
                  prerequisites: draft.prerequisites.map((other, otherIndex) => otherIndex === index ? { ...other, requiredVariantId: value } : other),
                })}
                options={(prerequisiteFlag?.variants ?? []).map((variant) => ({ value: variant.id, label: variant.label }))}
              />
              <DesignButton
                variant="ghost"
                size="icon"
                aria-label="Remove prerequisite"
                onClick={() => onChange({ prerequisites: draft.prerequisites.filter((_, otherIndex) => otherIndex !== index) })}
              >
                <TrashIcon className="h-4 w-4" />
              </DesignButton>
            </div>
          );
        })}
        <div>
          <DesignButton
            variant="outline"
            size="sm"
            disabled={candidateKeys.length === 0}
            onClick={() => onChange({ prerequisites: [...draft.prerequisites, { flagKey: "", requiredVariantId: "" }] })}
          >
            <PlusIcon className="h-3.5 w-3.5 mr-1" />
            Add prerequisite
          </DesignButton>
        </div>
      </div>
    </DesignCard>
  );
}

export function FlagSafetyCard(props: FlagDraftSectionProps) {
  const { draft, onChange } = props;
  const exclusionGroupId = useId();
  return (
    <DesignCard
      title="Holdout & mutual exclusion"
      subtitle="Keep a control group out, and keep overlapping tests apart"
      icon={ShieldCheckIcon}
      gradient="default"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <PercentField
            label="Global holdout"
            bps={draft.holdoutBps}
            onBpsChange={(bps) => onChange({ holdoutBps: bps })}
          />
          <span className="text-xs text-muted-foreground">
            This share of traffic always receives the fallback variant and is excluded from all targeting and experiments.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={exclusionGroupId} className="text-xs font-medium text-muted-foreground">Mutual exclusion group</label>
          <DesignInput
            id={exclusionGroupId}
            size="sm"
            placeholder="e.g. checkout-tests"
            value={draft.mutualExclusionGroup ?? ""}
            onChange={(event) => onChange({ mutualExclusionGroup: event.target.value.trim().length > 0 ? event.target.value : null })}
          />
          <span className="text-xs text-muted-foreground">
            Flags and experiments in the same group never target the same user simultaneously.
          </span>
        </div>
      </div>
    </DesignCard>
  );
}

function isVariantServed(flag: FlagConfig, variantId: string): boolean {
  const serves = [flag.defaultServe, ...flag.rules.map((rule) => rule.serve)];
  return serves.some((serve) => serve.type === "variant"
    ? serve.variantId === variantId
    : serve.split.some((entry) => entry.variantId === variantId));
}

// ---------------------------------------------------------------------------
// Variant cards
// ---------------------------------------------------------------------------

function VariantCard(props: {
  variant: FlagVariant,
  flagType: FlagValueType,
  isFallback: boolean,
  isOnlyVariant: boolean,
  removeDisabledReason: string | null,
  onChange: (variant: FlagVariant) => void,
  onRemove: () => void,
}) {
  const labelId = useId();
  const valueId = useId();
  const valueError = validateVariantJsonValue(props.flagType, props.variant.jsonValue);

  return (
    <div className="rounded-xl bg-foreground/[0.03] ring-1 ring-black/[0.05] dark:ring-white/[0.05] p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex-1 flex flex-col gap-1">
          <label htmlFor={labelId} className="text-xs font-medium text-muted-foreground">Label</label>
          <DesignInput
            id={labelId}
            size="sm"
            value={props.variant.label}
            onChange={(event) => props.onChange({ ...props.variant, label: event.target.value })}
          />
        </div>
        <div className="flex items-center gap-1 self-start pt-5">
          {props.isFallback && <DesignBadge label="Fallback" color="orange" size="sm" />}
          <DesignButton
            variant="ghost"
            size="icon"
            aria-label={`Remove variant ${props.variant.label}`}
            disabled={props.removeDisabledReason != null}
            title={props.removeDisabledReason ?? undefined}
            onClick={props.onRemove}
          >
            <TrashIcon className="h-4 w-4" />
          </DesignButton>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={valueId} className="text-xs font-medium text-muted-foreground">
          Value <span className="font-mono text-muted-foreground/70">({props.flagType})</span>
        </label>
        <VariantValueInput
          inputId={valueId}
          flagType={props.flagType}
          jsonValue={props.variant.jsonValue}
          onJsonValueChange={(jsonValue) => props.onChange({ ...props.variant, jsonValue })}
        />
        {valueError != null && (
          <span className="text-xs text-red-600 dark:text-red-400">{capitalize(valueError)}</span>
        )}
      </div>
    </div>
  );
}

function VariantValueInput(props: {
  inputId: string,
  flagType: FlagValueType,
  jsonValue: string,
  onJsonValueChange: (jsonValue: string) => void,
}) {
  switch (props.flagType) {
    case "boolean": {
      return (
        <DesignSelectorDropdown
          size="sm"
          triggerId={props.inputId}
          value={props.jsonValue === "true" || props.jsonValue === "false" ? props.jsonValue : ""}
          placeholder="Select value"
          onValueChange={props.onJsonValueChange}
          options={[
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ]}
        />
      );
    }
    case "string": {
      return (
        <DesignInput
          id={props.inputId}
          size="sm"
          value={decodeJsonString(props.jsonValue)}
          onChange={(event) => props.onJsonValueChange(JSON.stringify(event.target.value))}
        />
      );
    }
    case "number": {
      return (
        <DesignInput
          id={props.inputId}
          size="sm"
          inputMode="decimal"
          className="font-mono"
          // A valid number literal IS valid JSON, so the raw text doubles as
          // the stored encoding; invalid text surfaces through validation.
          value={props.jsonValue}
          onChange={(event) => props.onJsonValueChange(event.target.value)}
        />
      );
    }
    case "json": {
      return (
        <StructuredJsonEditor
          jsonValue={props.jsonValue}
          onJsonValueChange={props.onJsonValueChange}
        />
      );
    }
  }
}

type JsonValueKind = "object" | "array" | "string" | "number" | "boolean" | "null";

function jsonValueKind(value: Json): JsonValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  throw new Error("A structured feature flag value contained a non-JSON primitive.");
}

function defaultJsonForKind(kind: JsonValueKind): Json {
  switch (kind) {
    case "object": { return {}; }
    case "array": { return []; }
    case "string": { return ""; }
    case "number": { return 0; }
    case "boolean": { return false; }
    case "null": { return null; }
  }
}

function parseStructuredJson(value: string): { valid: true, value: Json } | { valid: false } {
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonSerializable(parsed) ? { valid: true, value: parsed } : { valid: false };
  } catch {
    return { valid: false };
  }
}

function StructuredJsonEditor(props: { jsonValue: string, onJsonValueChange: (value: string) => void }) {
  const parsed = parseStructuredJson(props.jsonValue);
  if (!parsed.valid) {
    return (
      <DesignAlert
        variant="error"
        title="This saved value is not valid JSON"
        description={
          <DesignButton size="sm" variant="secondary" onClick={() => props.onJsonValueChange("{}")}>Reset to an empty object</DesignButton>
        }
      />
    );
  }
  return (
    <div className="rounded-xl border border-black/[0.06] bg-white/50 p-2 dark:border-white/[0.06] dark:bg-foreground/[0.02]">
      <JsonValueEditor
        value={parsed.value}
        depth={0}
        onChange={(value) => props.onJsonValueChange(JSON.stringify(value))}
      />
    </div>
  );
}

function JsonValueEditor(props: { value: Json, depth: number, onChange: (value: Json) => void }) {
  const kind = jsonValueKind(props.value);
  const objectValue = props.value != null && typeof props.value === "object" && !Array.isArray(props.value) ? props.value : null;
  const arrayValue = Array.isArray(props.value) ? props.value : null;
  const allowedKinds: JsonValueKind[] = props.depth >= 4
    ? ["string", "number", "boolean", "null"]
    : ["object", "array", "string", "number", "boolean", "null"];
  return (
    <div className="flex flex-col gap-2">
      <DesignSelectorDropdown
        size="sm"
        className="w-32"
        value={kind}
        onValueChange={(nextKind) => {
          const selectedKind = allowedKinds.find((candidate) => candidate === nextKind);
          if (selectedKind != null) props.onChange(defaultJsonForKind(selectedKind));
        }}
        options={allowedKinds.map((value) => ({ value, label: capitalize(value) }))}
      />
      {kind === "string" && typeof props.value === "string" && (
        <DesignInput size="sm" value={props.value} onChange={(event) => props.onChange(event.target.value)} />
      )}
      {kind === "number" && typeof props.value === "number" && (
        <DesignInput
          size="sm"
          type="number"
          inputMode="decimal"
          value={String(props.value)}
          onChange={(event) => {
            if (!Number.isNaN(event.target.valueAsNumber)) props.onChange(event.target.valueAsNumber);
          }}
        />
      )}
      {kind === "boolean" && typeof props.value === "boolean" && (
        <DesignPillToggle
          size="sm"
          options={[{ id: "true", label: "true" }, { id: "false", label: "false" }]}
          selected={props.value ? "true" : "false"}
          onSelect={(value) => props.onChange(value === "true")}
        />
      )}
      {kind === "null" && <span className="text-xs text-muted-foreground">No value</span>}
      {kind === "object" && objectValue != null && (
        <div className="flex flex-col gap-2 border-l border-black/[0.06] pl-2 dark:border-white/[0.06]">
          {Object.entries(objectValue).map(([key, value], index) => (
            <div key={`${key}-${index}`} className="flex items-start gap-2">
              <DesignInput
                size="sm"
                className="w-32 font-mono"
                aria-label="JSON property name"
                value={key}
                onChange={(event) => {
                  const entries = Object.entries(objectValue).map(([candidateKey, candidateValue]) => candidateKey === key ? [event.target.value, candidateValue] : [candidateKey, candidateValue]);
                  props.onChange(Object.fromEntries(entries));
                }}
              />
              <div className="min-w-0 flex-1">
                <JsonValueEditor
                  value={value}
                  depth={props.depth + 1}
                  onChange={(nextValue) => props.onChange(Object.fromEntries(Object.entries(objectValue).map(([candidateKey, candidateValue]) => [candidateKey, candidateKey === key ? nextValue : candidateValue])))}
                />
              </div>
              <DesignButton size="icon" variant="ghost" aria-label={`Remove JSON property ${key}`} onClick={() => props.onChange(Object.fromEntries(Object.entries(objectValue).filter(([candidateKey]) => candidateKey !== key)))}>
                <TrashIcon className="h-4 w-4" />
              </DesignButton>
            </div>
          ))}
          <div>
            <DesignButton size="sm" variant="ghost" onClick={() => props.onChange({ ...objectValue, [`property_${Object.keys(objectValue).length + 1}`]: "" })}>
              <PlusIcon className="mr-1 h-3.5 w-3.5" /> Add property
            </DesignButton>
          </div>
        </div>
      )}
      {kind === "array" && arrayValue != null && (
        <div className="flex flex-col gap-2 border-l border-black/[0.06] pl-2 dark:border-white/[0.06]">
          {arrayValue.map((value, index) => (
            <div key={index} className="flex items-start gap-2">
              <span className="w-5 pt-2 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <JsonValueEditor value={value} depth={props.depth + 1} onChange={(nextValue) => props.onChange(arrayValue.map((candidate, candidateIndex) => candidateIndex === index ? nextValue : candidate))} />
              </div>
              <DesignButton size="icon" variant="ghost" aria-label={`Remove JSON item ${index + 1}`} onClick={() => props.onChange(arrayValue.filter((_, candidateIndex) => candidateIndex !== index))}>
                <TrashIcon className="h-4 w-4" />
              </DesignButton>
            </div>
          ))}
          <div>
            <DesignButton size="sm" variant="ghost" onClick={() => props.onChange([...arrayValue, ""])}>
              <PlusIcon className="mr-1 h-3.5 w-3.5" /> Add item
            </DesignButton>
          </div>
        </div>
      )}
    </div>
  );
}

function decodeJsonString(jsonValue: string): string {
  try {
    const parsed: unknown = JSON.parse(jsonValue);
    return typeof parsed === "string" ? parsed : jsonValue;
  } catch {
    // Not yet valid JSON (e.g. mid-edit); show the raw text so typing works.
    return jsonValue;
  }
}

function capitalize(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// Serve editor (single variant vs. percentage split)
// ---------------------------------------------------------------------------

function ServeEditor(props: {
  serve: FlagServe,
  variants: FlagVariant[],
  onChange: (serve: FlagServe) => void,
}) {
  const splitTotal = props.serve.type === "split"
    ? props.serve.split.reduce((sum, entry) => sum + entry.weightBps, 0)
    : BPS_TOTAL;

  return (
    <div className="flex flex-col gap-2">
      <DesignPillToggle
        size="sm"
        options={[
          { id: "variant", label: "Single variant" },
          { id: "split", label: "Percentage split" },
        ]}
        selected={props.serve.type}
        onSelect={(id) => {
          if (id === props.serve.type) return;
          if (id === "variant") {
            props.onChange({ type: "variant", variantId: props.variants[0]?.id ?? "" });
          } else {
            // Seed an even split so the total starts at exactly 100%.
            const weights = evenSplitBps(props.variants.length);
            props.onChange({
              type: "split",
              split: props.variants.map((variant, index) => ({ variantId: variant.id, weightBps: weights[index] })),
            });
          }
        }}
      />
      {props.serve.type === "variant" ? (
        <div className="max-w-xs">
          <DesignSelectorDropdown
            size="sm"
            value={props.serve.variantId}
            placeholder="Select variant"
            onValueChange={(value) => props.onChange({ type: "variant", variantId: value })}
            options={props.variants.map((variant) => ({ value: variant.id, label: variant.label }))}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-4">
            {props.serve.split.map((entry, index) => (
              <PercentField
                key={entry.variantId}
                label={props.variants.find((variant) => variant.id === entry.variantId)?.label ?? entry.variantId}
                bps={entry.weightBps}
                onBpsChange={(bps) => {
                  if (props.serve.type !== "split") return;
                  props.onChange({
                    type: "split",
                    split: props.serve.split.map((other, otherIndex) => otherIndex === index ? { ...other, weightBps: bps } : other),
                  });
                }}
              />
            ))}
          </div>
          <span className={splitTotal === BPS_TOTAL ? "text-xs text-muted-foreground" : "text-xs text-red-600 dark:text-red-400"}>
            Total: {formatBps(splitTotal)}{splitTotal !== BPS_TOTAL && " — must add up to exactly 100%"}
          </span>
        </div>
      )}
    </div>
  );
}

function evenSplitBps(count: number): number[] {
  if (count === 0) return [];
  const base = Math.floor(BPS_TOTAL / count);
  // Give the remainder to the first entries so the sum is exactly 100%.
  const remainder = BPS_TOTAL - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Targeting rule cards
// ---------------------------------------------------------------------------

function RuleCard(props: {
  rule: FlagRule,
  index: number,
  ruleCount: number,
  variants: FlagVariant[],
  section: FeatureFlagsSection,
  onChange: (rule: FlagRule) => void,
  onRemove: () => void,
  onMove: (direction: "up" | "down") => void,
}) {
  const labelId = useId();

  return (
    <div className="rounded-xl bg-foreground/[0.03] ring-1 ring-black/[0.05] dark:ring-white/[0.05] p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <DesignBadge label={`#${props.index + 1}`} color="blue" size="sm" />
        <DesignInput
          id={labelId}
          size="sm"
          aria-label="Rule name"
          className="max-w-xs"
          value={props.rule.label}
          onChange={(event) => props.onChange({ ...props.rule, label: event.target.value })}
        />
        {!props.rule.enabled && <DesignBadge label="Off" color="orange" size="sm" />}
        <div className="ml-auto flex items-center gap-1">
          <DesignButton
            variant="ghost"
            size="icon"
            aria-label="Move rule up"
            disabled={props.index === 0}
            onClick={() => props.onMove("up")}
          >
            <ArrowUpIcon className="h-4 w-4" />
          </DesignButton>
          <DesignButton
            variant="ghost"
            size="icon"
            aria-label="Move rule down"
            disabled={props.index === props.ruleCount - 1}
            onClick={() => props.onMove("down")}
          >
            <ArrowDownIcon className="h-4 w-4" />
          </DesignButton>
          <DesignButton
            variant="ghost"
            size="sm"
            onClick={() => props.onChange({ ...props.rule, enabled: !props.rule.enabled })}
          >
            {props.rule.enabled ? "Disable" : "Enable"}
          </DesignButton>
          <DesignButton
            variant="ghost"
            size="icon"
            aria-label={`Remove rule ${props.rule.label}`}
            onClick={props.onRemove}
          >
            <TrashIcon className="h-4 w-4" />
          </DesignButton>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {props.rule.conditions.map((condition, index) => (
          <FlagConditionEditor
            key={index}
            condition={condition}
            isFirst={index === 0}
            section={props.section}
            onChange={(updated) => props.onChange({
              ...props.rule,
              conditions: props.rule.conditions.map((other, otherIndex) => otherIndex === index ? updated : other),
            })}
            onRemove={() => props.onChange({
              ...props.rule,
              conditions: props.rule.conditions.filter((_, otherIndex) => otherIndex !== index),
            })}
            removeDisabled={props.rule.conditions.length === 1}
          />
        ))}
        <div>
          <DesignButton
            variant="ghost"
            size="sm"
            onClick={() => props.onChange({
              ...props.rule,
              conditions: [...props.rule.conditions, { attribute: "user.email", operator: "eq", value: "" }],
            })}
          >
            <PlusIcon className="h-3.5 w-3.5 mr-1" />
            And…
          </DesignButton>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-black/[0.05] dark:border-white/[0.05] pt-3">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Serve</span>
            <ServeEditor
              serve={props.rule.serve}
              variants={props.variants}
              onChange={(serve) => props.onChange({ ...props.rule, serve })}
            />
          </div>
          <PercentField
            label="Rollout (of matched traffic)"
            bps={props.rule.rolloutBps}
            onBpsChange={(bps) => props.onChange({ ...props.rule, rolloutBps: bps })}
          />
        </div>
        {props.rule.rolloutBps < BPS_TOTAL && (
          <span className="text-xs text-muted-foreground">
            {formatBps(props.rule.rolloutBps)} of matching traffic gets this rule; the rest continues to the next rule.
          </span>
        )}
      </div>
    </div>
  );
}

export function FlagConditionEditor(props: {
  condition: FlagCondition,
  isFirst: boolean,
  section: FeatureFlagsSection,
  removeDisabled: boolean,
  onChange: (condition: FlagCondition) => void,
  onRemove: () => void,
}) {
  const isCommonAttribute = COMMON_ATTRIBUTES.some((attribute) => attribute.value === props.condition.attribute);
  const [customMode, setCustomMode] = useState(!isCommonAttribute && props.condition.attribute.length > 0);
  const metadata = getOperatorMetadataOrThrow(props.condition.operator);
  const segmentOptions = [...props.section.segments.entries()]
    .map(([id, segment]) => ({ value: id, label: segment.displayName }));

  const setOperator = (operatorText: string) => {
    const operator = FLAG_OPERATORS.find((candidate) => candidate === operatorText);
    if (operator == null) return;
    const newMetadata = getOperatorMetadataOrThrow(operator);
    const next: FlagCondition = { attribute: props.condition.attribute, operator };
    if (newMetadata.arity === "single") {
      next.value = props.condition.value ?? "";
    } else if (newMetadata.arity === "list") {
      next.values = props.condition.values ?? (props.condition.value != null && props.condition.value.length > 0 ? [props.condition.value] : []);
    }
    props.onChange(next);
  };

  return (
    <div className="flex items-start gap-2 rounded-xl bg-foreground/[0.025] p-2 ring-1 ring-black/[0.05] dark:ring-white/[0.05]">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.04] text-[11px] font-medium text-muted-foreground">
        {props.isFirst ? "If" : "and"}
      </span>
      <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-3">
        {customMode ? (
          <DesignInput
            size="sm"
            className="min-w-0 w-full font-mono"
            aria-label="Custom attribute"
            placeholder="custom.plan"
            value={props.condition.attribute}
            onChange={(event) => props.onChange({ ...props.condition, attribute: event.target.value })}
          />
        ) : (
          <DesignSelectorDropdown
            size="sm"
            className="min-w-0 w-full"
            value={isCommonAttribute ? props.condition.attribute : ""}
            placeholder="Attribute"
            onValueChange={(value) => {
              if (value === CUSTOM_ATTRIBUTE_OPTION) {
                setCustomMode(true);
                props.onChange({ ...props.condition, attribute: "custom." });
                return;
              }
              props.onChange({ ...props.condition, attribute: value });
            }}
            options={[
              ...COMMON_ATTRIBUTES.map((attribute) => ({ value: attribute.value, label: attribute.label })),
              { value: CUSTOM_ATTRIBUTE_OPTION, label: "Custom attribute…" },
            ]}
          />
        )}
        <DesignSelectorDropdown
          size="sm"
          className="min-w-0 w-full"
          value={props.condition.operator}
          onValueChange={setOperator}
          options={FLAG_OPERATORS.map((operator) => ({
            value: operator,
            label: getOperatorMetadataOrThrow(operator).label,
          }))}
        />
        {metadata.arity === "single" && metadata.valueKind === "segment" && (
          segmentOptions.length > 0 ? (
            <DesignSelectorDropdown
              size="sm"
              className="min-w-0 w-full"
              value={props.condition.value ?? ""}
              placeholder="Segment"
              onValueChange={(value) => props.onChange({ ...props.condition, value })}
              options={segmentOptions}
            />
          ) : (
            <span className="flex min-h-8 items-center text-xs text-muted-foreground">No segments defined yet.</span>
          )
        )}
        {metadata.arity === "single" && metadata.valueKind !== "segment" && (
          <DesignInput
            size="sm"
            className="min-w-0 w-full"
            aria-label="Condition value"
            type={metadata.valueKind === "datetime" ? "datetime-local" : "text"}
            inputMode={metadata.valueKind === "number" ? "decimal" : undefined}
            placeholder={metadata.valueKind === "semver" ? "1.2.3" : metadata.valueKind === "number" ? "42" : "value"}
            value={metadata.valueKind === "datetime" && props.condition.value != null
              ? getInputDatetimeLocalString(new Date(props.condition.value))
              : props.condition.value ?? ""}
            onChange={(event) => props.onChange({
              ...props.condition,
              value: metadata.valueKind === "datetime" && event.target.value.length > 0
                ? new Date(event.target.value).toISOString()
                : event.target.value,
            })}
          />
        )}
        {metadata.arity === "list" && (
          <DesignInput
            size="sm"
            className="min-w-0 w-full"
            aria-label="Condition values (comma-separated)"
            placeholder="value-a, value-b, value-c"
            value={(props.condition.values ?? []).join(", ")}
            onChange={(event) => props.onChange({
              ...props.condition,
              values: event.target.value.split(",").map((value) => value.trim()).filter((value) => value.length > 0),
            })}
          />
        )}
      </div>
      <DesignButton
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-label="Remove condition"
        disabled={props.removeDisabled}
        onClick={props.onRemove}
      >
        <TrashIcon className="h-4 w-4" />
      </DesignButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Publish review summary
// ---------------------------------------------------------------------------

function summarizeChanges(before: FlagConfig, after: FlagConfig): string[] {
  const lines: string[] = [];
  const compare = (label: string, beforeValue: unknown, afterValue: unknown) => {
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) lines.push(label);
  };
  compare("Metadata (name, description, or type) changed.", [before.displayName, before.description, before.type], [after.displayName, after.description, after.type]);
  compare(`Enabled state: ${before.enabled ? "enabled" : "disabled"} → ${after.enabled ? "enabled" : "disabled"}.`, before.enabled, after.enabled);
  compare("Variants changed.", before.variants, after.variants);
  compare("Fallback variant changed.", before.fallbackVariantId, after.fallbackVariantId);
  compare("Default rule changed.", before.defaultServe, after.defaultServe);
  compare("Targeting rules changed.", before.rules, after.rules);
  compare("Prerequisites changed.", before.prerequisites, after.prerequisites);
  compare(`Holdout: ${formatBps(before.holdoutBps)} → ${formatBps(after.holdoutBps)}.`, before.holdoutBps, after.holdoutBps);
  compare("Mutual exclusion group changed.", before.mutualExclusionGroup, after.mutualExclusionGroup);
  return lines;
}

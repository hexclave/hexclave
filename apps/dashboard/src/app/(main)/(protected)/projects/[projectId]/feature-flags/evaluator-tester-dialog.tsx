"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignDialog,
  DesignDialogClose,
  DesignInput,
} from "@/components/design-components";
import {
  evaluateFlagWithoutExposure,
  FeatureFlagsBackendUnavailableError,
  type FlagEvaluationResult,
} from "@/lib/feature-flags/admin-adapter";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { FlaskIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { useAdminApp } from "../use-admin-app";
import { useFeatureFlagsSection } from "./shared";

type TesterResultState =
  | { status: "idle" }
  | { status: "unavailable" }
  | { status: "error", message: string }
  | { status: "ok", result: FlagEvaluationResult };

type CustomAttributeRow = { id: number, name: string, value: string };

/**
 * Dry-run evaluator for a single flag. Evaluation happens on the backend (the
 * dashboard never re-implements evaluation semantics) with exposure recording
 * explicitly disabled, so testing here can never skew experiment statistics.
 */
export function EvaluatorTesterDialog(props: {
  flagKey: string,
  open: boolean,
  onOpenChange: (open: boolean) => void,
}) {
  const adminApp = useAdminApp();
  const section = useFeatureFlagsSection();
  const flag = section.flags.get(props.flagKey);

  const [userId, setUserId] = useState("");
  const [email, setEmail] = useState("");
  const [teamId, setTeamId] = useState("");
  const [environment, setEnvironment] = useState("");
  const [customAttributes, setCustomAttributes] = useState<CustomAttributeRow[]>([]);
  const [nextRowId, setNextRowId] = useState(0);
  const [resultState, setResultState] = useState<TesterResultState>({ status: "idle" });

  const runTest = async () => {
    try {
      const result = await evaluateFlagWithoutExposure(adminApp, props.flagKey, {
        userId: userId.trim().length > 0 ? userId.trim() : null,
        email: email.trim().length > 0 ? email.trim() : null,
        teamId: teamId.trim().length > 0 ? teamId.trim() : null,
        environment: environment.trim().length > 0 ? environment.trim() : null,
        customAttributes: new Map(
          customAttributes
            .filter((row) => row.name.trim().length > 0)
            .map((row): [string, string] => [row.name.trim(), row.value]),
        ),
      });
      setResultState({ status: "ok", result });
    } catch (error) {
      if (error instanceof FeatureFlagsBackendUnavailableError) {
        setResultState({ status: "unavailable" });
        return;
      }
      captureError("feature-flags-tester", error);
      setResultState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const matchedRuleLabel = resultState.status === "ok" && resultState.result.matchedRuleId != null
    ? flag?.rules.find((rule) => rule.id === resultState.result.matchedRuleId)?.label ?? resultState.result.matchedRuleId
    : null;

  return (
    <DesignDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      size="3xl"
      icon={FlaskIcon}
      title={`Test "${flag?.displayName ?? props.flagKey}"`}
      description="Evaluate the flag against a simulated context. Test runs never record exposures, so experiments are unaffected."
      footer={
        <>
          <DesignDialogClose asChild>
            <DesignButton variant="secondary" size="sm">Close</DesignButton>
          </DesignDialogClose>
          <DesignButton size="sm" onClick={runTest}>Run test</DesignButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <TesterField label="User ID" placeholder="usr_… (leave empty for anonymous)" value={userId} onChange={setUserId} />
          <TesterField label="Email" placeholder="jamie@example.com" value={email} onChange={setEmail} />
          <TesterField label="Team ID" placeholder="team_…" value={teamId} onChange={setTeamId} />
          <TesterField label="Environment" placeholder="production" value={environment} onChange={setEnvironment} />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Custom attributes</span>
            <DesignButton
              variant="ghost"
              size="sm"
              onClick={() => {
                setCustomAttributes((rows) => [...rows, { id: nextRowId, name: "", value: "" }]);
                setNextRowId((id) => id + 1);
              }}
            >
              <PlusIcon className="h-3.5 w-3.5 mr-1" />
              Add attribute
            </DesignButton>
          </div>
          {customAttributes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Match rules on <span className="font-mono">custom.&lt;name&gt;</span> attributes by adding them here.
            </p>
          ) : (
            customAttributes.map((row) => (
              <div key={row.id} className="flex items-center gap-2">
                <DesignInput
                  size="sm"
                  placeholder="Name (e.g. plan)"
                  aria-label="Attribute name"
                  value={row.name}
                  onChange={(event) => setCustomAttributes((rows) =>
                    rows.map((other) => other.id === row.id ? { ...other, name: event.target.value } : other))}
                />
                <DesignInput
                  size="sm"
                  placeholder="Value"
                  aria-label="Attribute value"
                  value={row.value}
                  onChange={(event) => setCustomAttributes((rows) =>
                    rows.map((other) => other.id === row.id ? { ...other, value: event.target.value } : other))}
                />
                <DesignButton
                  variant="ghost"
                  size="icon"
                  aria-label="Remove attribute"
                  onClick={() => setCustomAttributes((rows) => rows.filter((other) => other.id !== row.id))}
                >
                  <TrashIcon className="h-4 w-4" />
                </DesignButton>
              </div>
            ))
          )}
        </div>

        {resultState.status === "unavailable" && (
          <DesignAlert
            variant="info"
            title="Evaluation endpoint not available yet"
            description="This server does not expose the feature-flags evaluation endpoint yet, so test runs cannot be performed. Flag configuration itself is unaffected."
          />
        )}
        {resultState.status === "error" && (
          <DesignAlert variant="error" title="Test run failed" description={resultState.message} />
        )}
        {resultState.status === "ok" && (
          <div className="rounded-xl bg-foreground/[0.03] p-4 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Result</span>
              <DesignBadge
                label={flag?.variants.find((variant) => variant.id === resultState.result.variantId)?.label ?? resultState.result.variantId}
                color="green"
                size="sm"
              />
            </div>
            <div className="text-sm font-mono break-all">{resultState.result.jsonValue}</div>
            <div className="text-xs text-muted-foreground">
              {resultState.result.reason}
              {matchedRuleLabel != null && <> · matched rule: <span className="font-medium">{matchedRuleLabel}</span></>}
            </div>
          </div>
        )}
      </div>
    </DesignDialog>
  );
}

function TesterField(props: { label: string, placeholder: string, value: string, onChange: (value: string) => void }) {
  const inputId = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">{props.label}</label>
      <DesignInput
        id={inputId}
        size="sm"
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

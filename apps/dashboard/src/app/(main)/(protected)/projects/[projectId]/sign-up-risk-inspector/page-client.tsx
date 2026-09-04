"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignTable,
  DesignTableBody,
  DesignTableCell,
  DesignTableHead,
  DesignTableHeader,
  DesignTableRow,
} from "@/components/design-components";
import { Skeleton } from "@/components/ui";
import { Textarea } from "@/components/ui/textarea";
import { sendInternalUserRequest } from "@/lib/hexclave-app-internals";
import { emailSchema } from "@hexclave/shared/dist/schema-fields";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { isIpAddress } from "@hexclave/shared/dist/utils/ips";
import { useStackApp, useUser } from "@hexclave/next";
import {
  yupArray,
  yupMixed,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";
import * as yup from "yup";
import { ChartLineUpIcon, EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { Fragment, Suspense, useState } from "react";
import { PageLayout } from "../page-layout";
import { useProjectId } from "../use-admin-app";

const signUpRiskSignalIds = ["emailable", "same_ip", "same_email", "similar_email", "turnstile", "blacklist", "country", "public_email_provider", "connected_account_age"] as const;
type InspectorEntry = {
  email: string,
  ipAddress: string | null,
  countryCode: string | null,
  invalidToken?: string,
};

const breakdownSchema = yupObject({
  signal: yupString().oneOf([...signUpRiskSignalIds]).defined(),
  factor: yupObject({
    bot: yupNumber().min(0).max(1).defined(),
    free_trial_abuse: yupNumber().min(0).max(1).defined(),
  }).defined(),
  details: yupMixed<Record<string, Json>>().defined(),
}).defined();

const responseSchema = yupObject({
  results: yupArray(yupObject({
    email: emailSchema.defined(),
    ip_address: yupString().nullable().defined(),
    country_code: yupString().nullable().defined(),
    scores: yupObject({
      bot: yupNumber().integer().min(0).max(100).defined(),
      free_trial_abuse: yupNumber().integer().min(0).max(100).defined(),
    }).defined(),
    heuristic_facts: yupObject({
      email_normalized: yupString().nullable().defined(),
      email_base: yupString().nullable().defined(),
    }).defined(),
    breakdown: yupArray(breakdownSchema).defined(),
  }).defined()).defined(),
}).defined();

type InspectorResponse = yup.InferType<typeof responseSchema>;
type InspectorState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error", message: string }
  | { status: "ok", data: InspectorResponse };

export default function PageClient() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <AuthenticatedPage />
    </Suspense>
  );
}

function AuthenticatedPage() {
  const projectId = useProjectId();
  useUser({ or: "redirect", projectIdMustMatch: "internal" });

  if (projectId !== "internal") {
    return null;
  }

  return (
    <PageLayout
      title="Sign-up Risk Inspector"
      description="Inspect sign-up risk signals for a batch of emails. Internal platform tool."
    >
      <InspectorContent />
    </PageLayout>
  );
}

function InspectorContent() {
  const app = useStackApp();
  const [entries, setEntries] = useState<InspectorEntry[]>([]);
  const [bulkInput, setBulkInput] = useState("");
  const [limitExceeded, setLimitExceeded] = useState(false);
  const [expandedEmail, setExpandedEmail] = useState<string | null>(null);
  const [state, setState] = useState<InspectorState>({ status: "idle" });
  const isLoading = state.status === "loading";

  const invalidEntries = entries.filter((entry) => entry.invalidToken != null || !emailSchema.isValidSync(entry.email));
  const entryKey = (entry: Pick<InspectorEntry, "email" | "ipAddress" | "countryCode">) =>
    `${entry.email}|${entry.ipAddress ?? ""}|${entry.countryCode ?? ""}`;
  const addEntries = (values: InspectorEntry[]) => {
    if (isLoading) return;
    const combined = [...entries, ...values].filter((entry, index, allEntries) =>
      allEntries.findIndex((candidate) => entryKey(candidate) === entryKey(entry)) === index
    );
    setLimitExceeded(combined.length > 50);
    setEntries(combined.slice(0, 50));
  };
  const addBulkEntries = () => {
    if (isLoading) return;
    const parsedEntries: InspectorEntry[] = [];
    for (const line of bulkInput.split(/\r?\n/)) {
      const tokens = line.split(/[\s,;]+/).filter((token) => token.length > 0);
      let currentEntry: InspectorEntry | null = null;
      for (const token of tokens) {
        const normalizedToken = token.trim();
        if (emailSchema.isValidSync(normalizedToken)) {
          currentEntry = {
            email: normalizedToken.toLowerCase(),
            ipAddress: null,
            countryCode: null,
          };
          parsedEntries.push(currentEntry);
        } else if (isIpAddress(normalizedToken) && currentEntry != null) {
          currentEntry.ipAddress = normalizedToken;
        } else if (/^[a-z]{2}$/i.test(normalizedToken) && currentEntry != null) {
          currentEntry.countryCode = token.toUpperCase();
        } else if (currentEntry == null) {
          currentEntry = {
            email: normalizedToken,
            ipAddress: null,
            countryCode: null,
            invalidToken: normalizedToken,
          };
          parsedEntries.push(currentEntry);
        } else if (currentEntry.invalidToken == null) {
          currentEntry.invalidToken = normalizedToken;
        }
      }
    }
    addEntries(parsedEntries);
    setBulkInput("");
  };
  const removeEntry = (entryToRemove: InspectorEntry) => {
    if (isLoading) return;
    setEntries((current) => current.filter((entry) => entryKey(entry) !== entryKey(entryToRemove)));
    setLimitExceeded(false);
  };
  const clearEntries = () => {
    if (isLoading) return;
    setEntries([]);
    setLimitExceeded(false);
  };
  const calculate = async () => {
    if (entries.length === 0 || invalidEntries.length > 0 || limitExceeded) return;
    setState({ status: "loading" });
    try {
      const response = await sendInternalUserRequest(app, "/internal/sign-up-risk-inspector", {
        method: "POST",
        body: JSON.stringify({
          entries: entries.map((entry) => ({
            email: entry.email,
            ip_address: entry.ipAddress,
            country_code: entry.countryCode,
          })),
        }),
        headers: { "content-type": "application/json" },
      });
      if (response.status === 403) {
        setState({ status: "forbidden" });
        return;
      }
      if (!response.ok) {
        setState({ status: "error", message: `Request failed (${response.status})` });
        return;
      }
      const data = await responseSchema.validate(await response.json());
      setState({ status: "ok", data });
    } catch (error) {
      captureError("sign-up-risk-inspector", error);
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <DesignCard
        title="Emails"
        subtitle="Paste one entry per line, or comma-separated emails"
        icon={EnvelopeSimpleIcon}
        contentClassName="p-4"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Email, optional IP, optional country</span>
              <Textarea
                value={bulkInput}
                onChange={(event) => setBulkInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    addBulkEntries();
                  }
                }}
                placeholder="One entry per line: email [ip] [country]. Plain comma-separated emails also work."
                rows={3}
                disabled={isLoading}
              />
            </label>
            <DesignButton variant="secondary" size="sm" onClick={addBulkEntries} disabled={isLoading}>Add</DesignButton>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {entries.map((entry) => (
              <span key={entryKey(entry)} className="hexclave-sensitive inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
                {entry.invalidToken == null && emailSchema.isValidSync(entry.email) ? (
                  <DesignBadge label={entry.email} color="blue" size="sm" />
                ) : (
                  <DesignBadge label={`${entry.email} · invalid`} color="red" size="sm" />
                )}
                {entry.ipAddress != null ? <span className="text-muted-foreground">· {entry.ipAddress}</span> : null}
                {entry.countryCode != null ? <span className="text-muted-foreground">· {entry.countryCode}</span> : null}
                <button
                  type="button"
                  className="rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={`Remove ${entry.email}`}
                  onClick={() => removeEntry(entry)}
                  disabled={isLoading}
                >
                  ×
                </button>
              </span>
            ))}
            <span className="text-xs text-muted-foreground">{entries.length}/50</span>
            {entries.length > 0 ? (
              <DesignButton variant="ghost" size="sm" onClick={clearEntries} disabled={isLoading}>Clear</DesignButton>
            ) : null}
          </div>
          {invalidEntries.length > 0 ? (
            <DesignAlert variant="error">
              Invalid entr{invalidEntries.length === 1 ? "y" : "ies"}: {invalidEntries.map((entry) =>
                entry.invalidToken == null ? entry.email : `${entry.email} (${entry.invalidToken})`
              ).join(", ")}
            </DesignAlert>
          ) : null}
          {limitExceeded ? (
            <DesignAlert variant="error">Maximum 50 emails per calculation.</DesignAlert>
          ) : null}
          <div>
            <DesignButton
              onClick={calculate}
              disabled={entries.length === 0 || invalidEntries.length > 0 || limitExceeded || isLoading}
            >
              Calculate risk scores
            </DesignButton>
          </div>
        </div>
      </DesignCard>

      {state.status === "forbidden" ? (
        <DesignAlert variant="error">Restricted to the platform team (owner team of the internal project).</DesignAlert>
      ) : null}
      {state.status === "error" ? <DesignAlert variant="error">{state.message}</DesignAlert> : null}
      {state.status === "loading" ? <Skeleton className="h-96 w-full rounded-xl" /> : null}
      {state.status === "ok" ? (
        <ResultsCard
          data={state.data}
          expandedEmail={expandedEmail}
          onToggleEmail={(email) => setExpandedEmail((current) => current === email ? null : email)}
        />
      ) : null}
    </div>
  );
}

function scoreClass(score: number): string {
  if (score >= 70) return "text-red-600 dark:text-red-400";
  if (score >= 40) return "text-amber-600 dark:text-amber-400";
  return "text-foreground";
}

function ResultsCard(props: {
  data: InspectorResponse,
  expandedEmail: string | null,
  onToggleEmail: (email: string) => void,
}) {
  return (
    <DesignCard
      title="Risk results"
      subtitle={`${props.data.results.length} email${props.data.results.length === 1 ? "" : "s"}`}
      icon={ChartLineUpIcon}
      contentClassName="p-3"
    >
      <DesignTable>
        <DesignTableHeader>
          <DesignTableRow>
            <DesignTableHead>Email</DesignTableHead>
            <DesignTableHead>IP</DesignTableHead>
            <DesignTableHead>Country</DesignTableHead>
            <DesignTableHead>Bot</DesignTableHead>
            <DesignTableHead>FTA</DesignTableHead>
            <DesignTableHead>Normalized</DesignTableHead>
            <DesignTableHead>Base</DesignTableHead>
            {signUpRiskSignalIds.map((signal) => (
              <DesignTableHead key={signal}>{signal.replaceAll("_", " ")}</DesignTableHead>
            ))}
          </DesignTableRow>
        </DesignTableHeader>
        <DesignTableBody>
          {props.data.results.map((result) => {
            const resultKey = `${result.email}|${result.ip_address ?? ""}|${result.country_code ?? ""}`;
            const expanded = props.expandedEmail === resultKey;
            return (
              <Fragment key={resultKey}>
                <DesignTableRow
                  className="cursor-pointer"
                  onClick={() => props.onToggleEmail(resultKey)}
                >
                  <DesignTableCell><code className="hexclave-sensitive text-xs">{result.email}</code></DesignTableCell>
                  <DesignTableCell><code className="hexclave-sensitive text-xs">{result.ip_address ?? "—"}</code></DesignTableCell>
                  <DesignTableCell>{result.country_code ?? "—"}</DesignTableCell>
                  <DesignTableCell><span className={scoreClass(result.scores.bot)}>{result.scores.bot}</span></DesignTableCell>
                  <DesignTableCell><span className={scoreClass(result.scores.free_trial_abuse)}>{result.scores.free_trial_abuse}</span></DesignTableCell>
                  <DesignTableCell><code className="hexclave-sensitive text-xs">{result.heuristic_facts.email_normalized ?? "—"}</code></DesignTableCell>
                  <DesignTableCell><code className="hexclave-sensitive text-xs">{result.heuristic_facts.email_base ?? "—"}</code></DesignTableCell>
                  {signUpRiskSignalIds.map((signal) => {
                    const breakdown = result.breakdown.find((entry) => entry.signal === signal);
                    const bot = Math.round((breakdown?.factor.bot ?? 0) * 100);
                    const fta = Math.round((breakdown?.factor.free_trial_abuse ?? 0) * 100);
                    return (
                      <DesignTableCell key={signal} className={bot === 0 && fta === 0 ? "text-muted-foreground" : undefined}>
                        {bot === 0 && fta === 0 ? "—" : `${bot}% / ${fta}%`}
                      </DesignTableCell>
                    );
                  })}
                </DesignTableRow>
                {expanded ? (
                  <DesignTableRow key={`${resultKey}-details`}>
                    <DesignTableCell colSpan={7 + signUpRiskSignalIds.length}>
                      <div className="grid gap-1 text-xs">
                        {result.breakdown.map((entry) => (
                          <div key={entry.signal} className="flex gap-2">
                            <span className="w-48 shrink-0 font-medium">{entry.signal}</span>
                            <code className="hexclave-sensitive break-all text-muted-foreground">{JSON.stringify(entry.details)}</code>
                          </div>
                        ))}
                      </div>
                    </DesignTableCell>
                  </DesignTableRow>
                ) : null}
              </Fragment>
            );
          })}
        </DesignTableBody>
      </DesignTable>
      <p className="pt-3 text-xs text-muted-foreground">
        score = round(100 × (1 − Π(1 − factor))) per dimension
      </p>
    </DesignCard>
  );
}

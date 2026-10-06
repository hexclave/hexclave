"use client";

import {
  createIssueAlertEmailPreviewValues,
  interpolateIssueAlertEmailTemplate,
  ISSUE_ALERT_EMAIL_PLACEHOLDERS,
} from "./issue-alert-email-template";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import {
  BellRingingIcon,
  CheckCircleIcon,
  PauseIcon,
  PencilSimpleIcon,
  PaperPlaneTiltIcon,
  PlayIcon,
  PlusIcon,
  SpinnerGapIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignDialog,
  DesignInput,
  type DesignListItemButton,
  DesignListItemRow,
  DesignMenu,
  DesignSelectorDropdown,
} from "@/components/design-components";
import { Label, Textarea, Typography } from "@/components/ui";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import { useAdminApp } from "../../../use-admin-app";
import { getErrorMessage } from "../../format";
import {
  buildIssueAlertRule,
  DEFAULT_ALERT_RULE_DRAFT,
  getSupportedAlertRuleDraft,
  issueAlertRuleToPayload,
  issueAlertTriggerLabel,
  type AlertRuleDraft,
  type AlertRuleTrigger,
} from "./alert-rule-form";
import {
  ISSUE_ALERT_DELIVERY_LIMIT,
  fetchIssueAlertDeliveries,
  fetchIssueAlertRules,
  replayIssueAlertDelivery,
  saveIssueAlertRule,
  type IssueAlertDelivery,
  type IssueAlertRulePayload,
  type IssueAlertRuleResponse,
} from "./issue-alerts-data";

type AlertRecipient = {
  id: string,
  displayName: string | null,
};

const TRIGGER_OPTIONS: { value: AlertRuleTrigger, label: string }[] = [
  { value: "new_or_regression", label: "New or regressed issue" },
  { value: "new", label: "New issue" },
  { value: "regression", label: "Regression" },
  { value: "frequency", label: "Frequency threshold" },
];

const COOLDOWN_OPTIONS: { value: AlertRuleDraft["cooldownKeyBy"], label: string }[] = [
  { value: "issue", label: "Per issue" },
  { value: "issue_environment", label: "Per issue + environment" },
  { value: "issue_release", label: "Per issue + release" },
  { value: "issue_environment_release", label: "Per issue + environment + release" },
];

function recipientLabel(user: AlertRecipient): string {
  return user.displayName ?? user.id;
}

function teamMemberRecipient(member: {
  id: string,
  teamProfile?: { displayName?: string | null } | null,
}): AlertRecipient {
  const displayName = member.teamProfile?.displayName;
  return {
    id: member.id,
    displayName: displayName != null && displayName.trim() !== "" ? displayName : null,
  };
}

function deliveryStatusLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase());
}

function deliveryBadgeColor(state: string): "blue" | "green" | "orange" | "red" | "zinc" {
  if (state === "delivered") return "green";
  if (state === "failed" || state === "dropped") return "red";
  if (state === "suppressed") return "orange";
  if (state === "claimed" || state === "enqueued") return "blue";
  return "zinc";
}

function deliveryTimestamp(millis: number): string {
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) throw new Error("Issue alert delivery returned an invalid timestamp");
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function insertAtSelection(element: HTMLInputElement | HTMLTextAreaElement, text: string): { value: string, cursor: number } {
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  return {
    value: `${element.value.slice(0, start)}${text}${element.value.slice(end)}`,
    cursor: start + text.length,
  };
}

function issueAlertEmailPreviewDocument(html: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:12px;background:#fff;color:#111827;}</style></head><body>${html}</body></html>`;
}

function EmailTemplateFields(props: {
  projectId: string,
  subject: string,
  html: string,
  onSubjectChange: (value: string) => void,
  onHtmlChange: (value: string) => void,
}) {
  const subjectRef = useRef<HTMLInputElement>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<"subject" | "html">("html");
  const [dashboardOrigin] = useState(() => typeof window === "undefined" ? "https://app.hexclave.com" : window.location.origin);
  const previewValues = useMemo(
    () => createIssueAlertEmailPreviewValues({
      projectId: props.projectId,
      dashboardOrigin,
    }),
    [dashboardOrigin, props.projectId],
  );
  const previewSubject = interpolateIssueAlertEmailTemplate(props.subject, previewValues, { escapeHtml: false });
  const previewHtml = interpolateIssueAlertEmailTemplate(props.html, previewValues, { escapeHtml: true });

  const insertPlaceholder = (token: typeof ISSUE_ALERT_EMAIL_PLACEHOLDERS[number]["token"]) => {
    const snippet = `{{${token}}}`;
    const target = lastFocused.current === "subject" ? subjectRef.current : htmlRef.current;
    if (target == null) {
      props.onHtmlChange(`${props.html}${snippet}`);
      return;
    }
    const next = insertAtSelection(target, snippet);
    if (lastFocused.current === "subject") props.onSubjectChange(next.value);
    else props.onHtmlChange(next.value);
    requestAnimationFrame(() => {
      target.focus();
      target.setSelectionRange(next.cursor, next.cursor);
    });
  };

  return (
    <div className="space-y-4">
      <FormField
        label="Email subject"
        htmlFor="issue-alert-subject"
        description="Placeholders are filled from the triggering issue when the email is sent."
      >
        <DesignInput
          ref={subjectRef}
          id="issue-alert-subject"
          size="sm"
          value={props.subject}
          placeholder="[{{kind}}] {{short_id}}: {{summary}}"
          onFocus={() => {
            lastFocused.current = "subject";
          }}
          onChange={(event) => props.onSubjectChange(event.target.value)}
        />
      </FormField>

      <div className="space-y-1.5">
        <Label htmlFor="issue-alert-html" className="text-xs font-medium">Email HTML</Label>
        <Typography variant="secondary" className="text-xs">
          Write HTML for the email body. Click a placeholder to insert it at the cursor. The preview on the right uses a sample issue.
        </Typography>
        <div className="flex flex-wrap gap-1.5">
          {ISSUE_ALERT_EMAIL_PLACEHOLDERS.map((placeholder) => (
            <DesignButton
              key={placeholder.token}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-1.5 font-mono text-[11px] transition-colors duration-150 hover:transition-none"
              title={placeholder.hint}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertPlaceholder(placeholder.token)}
            >
              {`{{${placeholder.token}}}`}
            </DesignButton>
          ))}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <Textarea
            ref={htmlRef}
            id="issue-alert-html"
            value={props.html}
            placeholder={'<p><strong>{{type}}</strong> {{short_id}}</p>\n<p>{{summary}}</p>\n<p><a href="{{issue_url}}">Open in Hexclave</a></p>'}
            onFocus={() => {
              lastFocused.current = "html";
            }}
            onChange={(event) => props.onHtmlChange(event.target.value)}
            rows={12}
            className="min-h-[16rem] resize-y font-mono text-xs"
          />
          <div className="flex min-h-[16rem] flex-col overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-sm ring-1 ring-black/[0.08] dark:border-white/[0.06] dark:ring-white/[0.06]">
            <div className="border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.06]">
              <Typography variant="secondary" className="text-[10px] font-medium uppercase tracking-wider">Preview</Typography>
              <Typography className="mt-0.5 truncate text-xs font-medium">{previewSubject.trim() === "" ? "Subject will appear here" : previewSubject}</Typography>
            </div>
            {props.html.trim() === "" ? (
              <div className="flex flex-1 items-center justify-center px-4 text-center">
                <Typography variant="secondary" className="text-xs">The HTML preview of the email will show here.</Typography>
              </div>
            ) : (
              <iframe
                title="Issue alert email preview"
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={issueAlertEmailPreviewDocument(previewHtml)}
                className="min-h-0 w-full flex-1 bg-white"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FormField(props: { label: string, htmlFor?: string, description?: string, children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.htmlFor} className="text-xs font-medium">{props.label}</Label>
      {props.description != null && <Typography variant="secondary" className="text-xs">{props.description}</Typography>}
      {props.children}
    </div>
  );
}

function DeliveryStatusRow(props: {
  delivery: IssueAlertDelivery,
  ruleLabel: string,
  replaying: boolean,
  onReplay: () => Promise<void>,
}) {
  const { delivery } = props;
  const canReplay = delivery.state === "failed" || delivery.state === "dropped";
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-foreground/[0.02] p-2.5">
      <div className="min-w-0">
        <Typography className="truncate text-xs font-medium">{props.ruleLabel}</Typography>
        <Typography variant="secondary" className="mt-0.5 text-[11px]">
          {deliveryStatusLabel(delivery.event_kind)} · {deliveryTimestamp(delivery.updated_at_millis)} · {delivery.attempt_count} attempt{delivery.attempt_count === 1 ? "" : "s"}
        </Typography>
        {delivery.last_error != null && (
          <Typography variant="secondary" className="mt-1 line-clamp-2 text-[11px] text-red-600 dark:text-red-400">
            {delivery.last_error}
          </Typography>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <DesignBadge label={deliveryStatusLabel(delivery.state)} color={deliveryBadgeColor(delivery.state)} size="sm" />
        <Typography variant="secondary" className="text-right text-[10px]">{deliveryStatusLabel(delivery.outcome)}</Typography>
        {canReplay && (
          <DesignButton size="sm" variant="ghost" loading={props.replaying} onClick={props.onReplay}>
            Replay
          </DesignButton>
        )}
      </div>
    </div>
  );
}

type RuleEditorDialogProps = {
  open: boolean,
  onOpenChange: (open: boolean) => void,
  projectId: string,
  existingRule: IssueAlertRuleResponse | null,
  initialDraft: AlertRuleDraft,
  recipients: readonly AlertRecipient[],
  onSave: (rule: IssueAlertRulePayload) => Promise<void>,
};

function RuleEditorDialog(props: RuleEditorDialogProps) {
  const [draft, setDraft] = useState<AlertRuleDraft>(props.initialDraft);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setDraft(props.initialDraft);
    setFormError(null);
  }, [props.initialDraft, props.open]);

  const recipientOptions = useMemo(
    () => {
      const seen = new Set<string>();
      const options: { id: string, label: string, checked: boolean }[] = [];
      for (const user of props.recipients) {
        seen.add(user.id);
        options.push({
          id: user.id,
          label: recipientLabel(user),
          checked: draft.userIds.includes(user.id),
        });
      }
      for (const userId of draft.userIds) {
        if (seen.has(userId)) continue;
        options.push({
          id: userId,
          label: `Unknown user ${userId}`,
          checked: true,
        });
      }
      return options;
    },
    [draft.userIds, props.recipients],
  );
  const recipientById = useMemo(
    () => new Map(props.recipients.map((user) => [user.id, user])),
    [props.recipients],
  );

  const { existingRule, onOpenChange, onSave } = props;
  const submit = useCallback(async () => {
    setFormError(null);
    const result = buildIssueAlertRule(draft, existingRule);
    if (result.status === "error") {
      setFormError(result.message);
      return;
    }
    setSaving(true);
    try {
      await onSave(result.rule);
      onOpenChange(false);
    } catch (error) {
      setFormError(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [draft, existingRule, onOpenChange, onSave]);

  const selectedRecipientLabels = draft.userIds.map((userId) => {
    const user = recipientById.get(userId);
    return user == null ? `Unknown user ${userId}` : recipientLabel(user);
  });

  return (
    <DesignDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      size="4xl"
      icon={BellRingingIcon}
      title={props.existingRule == null ? "Create issue-alert rule" : `Update ${props.existingRule.id}`}
      description="Email team members when a new, regressed, or high-frequency issue matches this rule."
      footer={(
        <div className="flex w-full justify-end gap-2">
          <DesignButton variant="secondary" size="sm" type="button" onClick={() => props.onOpenChange(false)}>
            Cancel
          </DesignButton>
          <DesignButton variant="default" size="sm" type="button" loading={saving} onClick={submit}>
            {props.existingRule == null ? "Create rule" : "Save changes"}
          </DesignButton>
        </div>
      )}
    >
      <div className="space-y-5">
        {formError != null && <DesignAlert variant="error" title="Rule was not saved" description={formError} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Rule key"
            htmlFor="issue-alert-rule-id"
            description="Stable lowercase key used for versioned updates."
          >
            <DesignInput
              id="issue-alert-rule-id"
              size="sm"
              value={draft.id}
              disabled={props.existingRule != null}
              onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
            />
          </FormField>
          <FormField label="Trigger">
            <DesignSelectorDropdown
              value={draft.trigger}
              onValueChange={(value) => {
                const next = TRIGGER_OPTIONS.find((option) => option.value === value)?.value;
                if (next == null) throw new Error(`Unknown issue alert trigger: ${value}`);
                setDraft((current) => ({ ...current, trigger: next }));
              }}
              options={TRIGGER_OPTIONS}
              size="sm"
            />
          </FormField>
        </div>

        {draft.trigger === "frequency" && (
          <div className="grid gap-4 rounded-xl border border-border/60 bg-foreground/[0.02] p-3 sm:grid-cols-2">
            <FormField label="Minimum events" htmlFor="issue-alert-frequency-count">
              <DesignInput
                id="issue-alert-frequency-count"
                size="sm"
                type="number"
                min={1}
                inputMode="numeric"
                value={draft.frequencyCount}
                onChange={(event) => setDraft((current) => ({ ...current, frequencyCount: event.target.value }))}
              />
            </FormField>
            <FormField label="Window (seconds)" htmlFor="issue-alert-frequency-window">
              <DesignInput
                id="issue-alert-frequency-window"
                size="sm"
                type="number"
                min={1}
                inputMode="numeric"
                value={draft.frequencyWindowSeconds}
                onChange={(event) => setDraft((current) => ({ ...current, frequencyWindowSeconds: event.target.value }))}
              />
            </FormField>
          </div>
        )}

        <div className="grid gap-4 rounded-xl border border-border/60 bg-foreground/[0.02] p-3 sm:grid-cols-2">
          <FormField label="Cooldown (seconds)" htmlFor="issue-alert-cooldown">
            <DesignInput
              id="issue-alert-cooldown"
              size="sm"
              type="number"
              min={0}
              inputMode="numeric"
              value={draft.cooldownDurationSeconds}
              onChange={(event) => setDraft((current) => ({ ...current, cooldownDurationSeconds: event.target.value }))}
            />
          </FormField>
          <FormField label="Cooldown scope">
            <DesignSelectorDropdown
              value={draft.cooldownKeyBy}
              onValueChange={(value) => {
                const next = COOLDOWN_OPTIONS.find((option) => option.value === value)?.value;
                if (next == null) throw new Error(`Unknown issue alert cooldown scope: ${value}`);
                setDraft((current) => ({ ...current, cooldownKeyBy: next }));
              }}
              options={COOLDOWN_OPTIONS}
              size="sm"
            />
          </FormField>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <Typography className="text-xs font-medium">Recipients</Typography>
              <Typography variant="secondary" className="text-xs">Team members who can access this project.</Typography>
            </div>
            {recipientOptions.length > 0 && (
              <DesignMenu
                variant="toggles"
                trigger="button"
                triggerLabel={draft.userIds.length === 0 ? "Choose recipients" : `${draft.userIds.length} selected`}
                label="Team members"
                options={recipientOptions}
                onToggleChange={(id, checked) => setDraft((current) => ({
                  ...current,
                  userIds: checked
                    ? (current.userIds.includes(id) ? current.userIds : [...current.userIds, id])
                    : current.userIds.filter((userId) => userId !== id),
                }))}
              />
            )}
          </div>
          {props.recipients.length === 0 && (
            <DesignAlert
              variant="warning"
              title="No team members found"
              description="Invite people to this project's team to receive issue-alert email."
            />
          )}
          {selectedRecipientLabels.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {selectedRecipientLabels.map((label, index) => (
                <DesignBadge key={`${label}-${index}`} label={label} color="zinc" size="sm" />
              ))}
            </div>
          ) : (
            <Typography variant="secondary" className="text-xs">No recipients selected.</Typography>
          )}
        </div>

        <FormField
          label="Notification category (optional)"
          htmlFor="issue-alert-category"
          description="Used by the existing notification preference system."
        >
          <DesignInput
            id="issue-alert-category"
            size="sm"
            value={draft.notificationCategoryName}
            onChange={(event) => setDraft((current) => ({ ...current, notificationCategoryName: event.target.value }))}
          />
        </FormField>

        <EmailTemplateFields
          projectId={props.projectId}
          subject={draft.subject}
          html={draft.html}
          onSubjectChange={(subject) => setDraft((current) => ({ ...current, subject }))}
          onHtmlChange={(html) => setDraft((current) => ({ ...current, html }))}
        />
      </div>
    </DesignDialog>
  );
}

function updateRuleInList(rules: readonly IssueAlertRuleResponse[], saved: IssueAlertRuleResponse): IssueAlertRuleResponse[] {
  const existing = rules.find((rule) => rule.id === saved.id);
  if (existing == null) return [...rules, saved].sort((left, right) => stringCompare(left.id, right.id));
  return rules.map((rule) => rule.id === saved.id ? saved : rule);
}

type IssueAlertsDialogProps = {
  open: boolean,
  onOpenChange: (open: boolean) => void,
};

export function IssueAlertsDialog(props: IssueAlertsDialogProps) {
  const adminApp = useAdminApp();
  const dashboardUser = useDashboardInternalUser();
  const project = adminApp.useProject();
  const userTeams = dashboardUser.useTeams();
  const ownerTeam = useMemo(
    () => userTeams.find((team) => team.id === project.ownerTeamId) ?? throwErr(`Owner team for project "${project.id}" was not found in the current user's teams.`),
    [project.id, project.ownerTeamId, userTeams],
  );
  const teamMembers = ownerTeam.useUsers();
  const recipients = useMemo(
    () => [...teamMembers]
      .map(teamMemberRecipient)
      .sort((left, right) => stringCompare(recipientLabel(left), recipientLabel(right))),
    [teamMembers],
  );
  const [rules, setRules] = useState<IssueAlertRuleResponse[]>([]);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [rulesTruncated, setRulesTruncated] = useState(false);
  const [rulesReloadToken, setRulesReloadToken] = useState(0);
  const [deliveries, setDeliveries] = useState<IssueAlertDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(true);
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const [deliveriesTruncated, setDeliveriesTruncated] = useState(false);
  const [deliveriesReloadToken, setDeliveriesReloadToken] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<IssueAlertRuleResponse | null>(null);
  const [editorDraft, setEditorDraft] = useState<AlertRuleDraft>(DEFAULT_ALERT_RULE_DRAFT);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replayingDeliveryId, setReplayingDeliveryId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRulesLoading(true);
    setRulesError(null);
    runAsynchronously(async () => {
      try {
        const nextRules = await fetchIssueAlertRules(adminApp);
        if (cancelled) return;
        setRules(nextRules.rules);
        setRulesTruncated(nextRules.truncated);
      } catch (error) {
        if (cancelled) return;
        setRulesError(getErrorMessage(error));
      } finally {
        if (!cancelled) setRulesLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [adminApp, rulesReloadToken]);

  useEffect(() => {
    let cancelled = false;
    setDeliveriesLoading(true);
    setDeliveriesError(null);
    runAsynchronously(async () => {
      try {
        const page = await fetchIssueAlertDeliveries(adminApp);
        if (cancelled) return;
        setDeliveries(page.deliveries);
        setDeliveriesTruncated(page.truncated);
      } catch (error) {
        if (cancelled) return;
        setDeliveriesError(getErrorMessage(error));
      } finally {
        if (!cancelled) setDeliveriesLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [adminApp, deliveriesReloadToken]);

  const activeRuleCount = rules.filter((rule) => rule.enabled).length;
  const ruleLabelByDatabaseId = useMemo(
    () => new Map(rules.map((rule) => [rule.database_id, rule.id])),
    [rules],
  );
  const supportedEditorDraft = useMemo(
    () => editingRule == null ? editorDraft : getSupportedAlertRuleDraft(editingRule),
    [editingRule, editorDraft],
  );

  const openCreate = useCallback(() => {
    setOperationError(null);
    setNotice(null);
    setEditingRule(null);
    setEditorDraft({ ...DEFAULT_ALERT_RULE_DRAFT });
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((rule: IssueAlertRuleResponse) => {
    const draft = getSupportedAlertRuleDraft(rule);
    if (draft == null) {
      setOperationError(`Rule "${rule.id}" uses conditions this concise editor cannot round-trip safely. It remains visible but read-only.`);
      return;
    }
    setOperationError(null);
    setNotice(null);
    setEditingRule(rule);
    setEditorDraft(draft);
    setEditorOpen(true);
  }, []);

  const saveRule = useCallback(async (rule: IssueAlertRulePayload) => {
    setOperationError(null);
    setNotice(null);
    try {
      const saved = await saveIssueAlertRule(adminApp, rule);
      setRules((current) => updateRuleInList(current, saved));
      setNotice(`${saved.id} saved as version ${saved.version}.`);
    } catch (error) {
      setOperationError(getErrorMessage(error));
      throw error;
    }
  }, [adminApp]);

  const toggleRule = useCallback(async (rule: IssueAlertRuleResponse) => {
    if (rule.version >= Number.MAX_SAFE_INTEGER) {
      setOperationError(`Rule "${rule.id}" has reached the maximum supported version and cannot be toggled safely.`);
      return;
    }
    setOperationError(null);
    setNotice(null);
    const nextRule: IssueAlertRuleResponse = {
      ...rule,
      version: rule.version + 1,
      enabled: !rule.enabled,
    };
    const saved = await saveIssueAlertRule(adminApp, issueAlertRuleToPayload(nextRule));
    setRules((current) => updateRuleInList(current, saved));
    setNotice(`${saved.id} ${saved.enabled ? "enabled" : "disabled"}.`);
  }, [adminApp]);

  const closeEditor = useCallback((open: boolean) => {
    setEditorOpen(open);
    if (!open) setEditingRule(null);
  }, []);

  const replayDelivery = useCallback(async (deliveryId: string) => {
    setOperationError(null);
    setNotice(null);
    setReplayingDeliveryId(deliveryId);
    try {
      const result = await replayIssueAlertDelivery(adminApp, deliveryId);
      setNotice(result.replayed ? "Delivery replayed." : "Replay was already in flight.");
      setDeliveriesReloadToken((current) => current + 1);
    } catch (error) {
      setOperationError(getErrorMessage(error));
    } finally {
      setReplayingDeliveryId(null);
    }
  }, [adminApp]);

  return (
    <DesignDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      size="7xl"
      icon={BellRingingIcon}
      title="Alert rules"
      description="Route new, regressed, or high-frequency issues to team members through the durable email workflow."
      headerContent={(
        <div className="flex justify-end">
          <DesignButton variant="default" size="sm" onClick={openCreate}>
            <PlusIcon className="mr-1.5 h-3.5 w-3.5" /> New rule
          </DesignButton>
        </div>
      )}
      bodyClassName="space-y-4"
    >
      <>
        {operationError != null && (
          <DesignAlert variant="error" title="Alert rule action failed" description={operationError} />
        )}
        {notice != null && (
          <DesignAlert variant="success" title="Alert rule updated" description={notice} />
        )}
        {rulesTruncated && (
          <DesignAlert
            variant="warning"
            title="Rule list is truncated"
            description="This project has more issue-alert rules than the list returns. Narrow or archive unused rules so every rule is visible here."
          />
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)]">
          <DesignCard
            title="Rules"
            subtitle={`${activeRuleCount} active${rules.length === activeRuleCount ? "" : ` · ${rules.length} visible`}`}
            icon={BellRingingIcon}
            gradient="default"
          >
            {rulesLoading && rules.length === 0 && (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <SpinnerGapIcon className="h-4 w-4 animate-spin" /> Loading active rules…
              </div>
            )}
            {rulesError != null && (
              <DesignAlert variant="error" title="Couldn't load alert rules" description={rulesError}>
                <DesignButton
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={() => setRulesReloadToken((current) => current + 1)}
                >
                  Retry
                </DesignButton>
              </DesignAlert>
            )}
            {!rulesLoading && rulesError == null && rules.length === 0 && (
              <div className="py-8 text-center">
                <Typography className="text-sm font-medium">No active issue-alert rules</Typography>
                <Typography variant="secondary" className="mt-1 text-xs">Create one to route the next issue signal through the Workflows delivery boundary.</Typography>
              </div>
            )}
            {rules.length > 0 && (
              <div className="-mx-2 divide-y divide-border/50">
                {rules.map((rule) => {
                  const editable = getSupportedAlertRuleDraft(rule) != null;
                  const statusLabel = rule.action.type === "webhook"
                    ? "Unsupported"
                    : rule.enabled ? "Active" : "Disabled";
                  const trigger = issueAlertTriggerLabel(rule);
                  let destination: string;
                  if (rule.action.type === "webhook") {
                    destination = `webhook ${rule.action.integrationId}`;
                  } else if (rule.action.userIds !== undefined) {
                    destination = `${rule.action.userIds.length} recipient${rule.action.userIds.length === 1 ? "" : "s"}`;
                  } else {
                    destination = rule.action.routing.type === "team" ? "team routing" : "issue-owner routing";
                  }
                  const subtitle = `${statusLabel} · ${trigger} · ${destination} · v${rule.version}`;
                  const toggleButton: DesignListItemButton = {
                    id: "toggle",
                    label: rule.enabled ? "Disable" : "Enable",
                    icon: rule.enabled ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />,
                    display: "text",
                    onClick: async () => {
                      try {
                        await toggleRule(rule);
                      } catch (error) {
                        setOperationError(getErrorMessage(error));
                      }
                    },
                  };
                  const buttons: DesignListItemButton[] = editable
                    ? [{
                      id: "edit",
                      label: "Edit",
                      icon: <PencilSimpleIcon className="h-3.5 w-3.5" />,
                      display: "text",
                      onClick: () => openEdit(rule),
                    }, toggleButton]
                    : [toggleButton];
                  return (
                    <DesignListItemRow
                      key={`${rule.id}-${rule.version}`}
                      size="sm"
                      icon={rule.enabled ? CheckCircleIcon : BellRingingIcon}
                      title={rule.id}
                      subtitle={editable ? subtitle : `${subtitle} · advanced / read-only`}
                      buttons={buttons}
                    />
                  );
                })}
              </div>
            )}
          </DesignCard>

          <DesignCard
            title="Recent delivery status"
            subtitle="Workflow and email-outbox outcomes"
            icon={PaperPlaneTiltIcon}
            gradient="default"
          >
            {deliveriesLoading && deliveries.length === 0 && (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <SpinnerGapIcon className="h-4 w-4 animate-spin" /> Loading recent deliveries…
              </div>
            )}
            {deliveriesError != null && (
              <DesignAlert variant="error" title="Couldn't load delivery history" description={deliveriesError}>
                <DesignButton
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={() => setDeliveriesReloadToken((current) => current + 1)}
                >
                  Retry
                </DesignButton>
              </DesignAlert>
            )}
            {deliveriesLoading && deliveries.length > 0 && (
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <SpinnerGapIcon className="h-3.5 w-3.5 animate-spin" /> Refreshing delivery history…
              </div>
            )}
            {!deliveriesLoading && deliveriesError == null && deliveries.length === 0 && (
              <div className="py-8 text-center">
                <Typography className="text-sm font-medium">No delivery attempts yet</Typography>
                <Typography variant="secondary" className="mt-1 text-xs">Delivery outcomes will appear here after an issue-alert rule matches.</Typography>
              </div>
            )}
            {deliveries.length > 0 && (
              <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                {deliveries.map((delivery) => (
                  <DeliveryStatusRow
                    key={delivery.id}
                    delivery={delivery}
                    ruleLabel={ruleLabelByDatabaseId.get(delivery.rule_id) ?? `Rule ${delivery.rule_id}`}
                    replaying={replayingDeliveryId === delivery.id}
                    onReplay={() => replayDelivery(delivery.id)}
                  />
                ))}
              </div>
            )}
            {deliveriesTruncated && (
              <Typography variant="secondary" className="mt-2 text-[11px]">
                Showing the latest {ISSUE_ALERT_DELIVERY_LIMIT} deliveries.
              </Typography>
            )}
          </DesignCard>
        </div>

        <RuleEditorDialog
          open={editorOpen}
          onOpenChange={closeEditor}
          projectId={adminApp.projectId}
          existingRule={editingRule}
          initialDraft={supportedEditorDraft ?? DEFAULT_ALERT_RULE_DRAFT}
          recipients={recipients}
          onSave={saveRule}
        />
      </>
    </DesignDialog>
  );
}

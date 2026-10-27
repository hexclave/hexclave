"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { UserPickerTable } from "@/components/data-table/user-picker-table";
import { useRouter } from "@/components/router";
import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignCategoryTabs,
  DesignDialog,
  DesignDialogClose,
  DesignInput,
  DesignSelectorDropdown,
} from "@/components/design-components";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Spinner,
  Textarea,
  Typography,
  cn,
} from "@/components/ui";
import {
  appendConversationUpdate,
  createConversation,
  getConversation,
  listConversations,
} from "@/lib/conversations";
import {
  type ConversationDetailResponse,
  type ConversationPriority,
  type ConversationSource,
  type ConversationStatus,
  type ConversationSummary,
} from "@/lib/conversation-types";
import { useUser } from "@hexclave/next";
import { computeSlaUrgency, type SlaUrgency } from "@hexclave/shared/dist/helpers/support-sla";
import { fromNow } from "@hexclave/shared/dist/utils/dates";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  ChatCircleDotsIcon,
  HeadsetIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  UsersThreeIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useSearchParams } from "next/navigation";
import { type Dispatch, type SetStateAction, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";

const EMPTY_USER_ID = "00000000-0000-4000-8000-000000000000";

const PRIORITY_OPTIONS: Array<{ id: ConversationPriority, label: string, color: "blue" | "orange" | "red" | "purple" }> = [
  { id: "low", label: "Low", color: "purple" },
  { id: "normal", label: "Normal", color: "blue" },
  { id: "high", label: "High", color: "orange" },
  { id: "urgent", label: "Urgent", color: "red" },
];

const STATUS_FILTER_OPTIONS = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "pending", label: "Pending" },
  { id: "closed", label: "Closed" },
] as const;

function getPriorityMeta(priority: ConversationPriority) {
  return PRIORITY_OPTIONS.find((option) => option.id === priority) ?? PRIORITY_OPTIONS[1];
}

function getStatusBadge(status: ConversationStatus) {
  if (status === "open") {
    return { label: "Open", color: "green" as const };
  }
  if (status === "pending") {
    return { label: "Pending", color: "orange" as const };
  }
  return { label: "Closed", color: "red" as const };
}

function getSourceBadge(source: ConversationSource) {
  if (source === "chat") {
    return { label: "Chat", color: "blue" as const };
  }
  if (source === "email") {
    return { label: "Email", color: "orange" as const };
  }
  if (source === "api") {
    return { label: "API", color: "green" as const };
  }
  return { label: "Manual", color: "purple" as const };
}

function getConversationQueueLabel(status: ConversationStatus) {
  if (status === "pending") {
    return "Waiting on user";
  }
  if (status === "closed") {
    return "Resolved";
  }
  return "Needs support";
}

function formatSupportTimestamp(value: string) {
  return fromNow(new Date(value));
}

function formatAbsoluteTimestamp(value: string | null) {
  if (value == null) {
    return "Not set";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Invalid date";
  }
  return date.toLocaleString();
}

function entryPointChannelLabel(channelType: string): string {
  const known: ConversationSource[] = ["chat", "email", "api", "manual"];
  if (known.includes(channelType as ConversationSource)) {
    return getSourceBadge(channelType as ConversationSource).label;
  }
  return channelType;
}

function getConversationStartedFromLine(detail: ConversationDetailResponse): string {
  if (detail.entryPoints.length === 0) {
    return getSourceBadge(detail.conversation.source).label;
  }
  const ordered = [...detail.entryPoints].sort((a, b) => Number(b.isEntryPoint) - Number(a.isEntryPoint));
  const primary = ordered[0];
  return `${entryPointChannelLabel(primary.channelType)} · ${primary.adapterKey}`;
}

function useTickingNow(intervalMs: number = 30_000): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function getSlaUrgencyFor(
  at: string | null,
  now: Date,
  windowStartedAt?: string | null,
): SlaUrgency | null {
  const date = parseOptionalDate(at);
  if (date == null) return null;
  return computeSlaUrgency(date, now, { windowStartedAt: parseOptionalDate(windowStartedAt) });
}

function getSlaUrgencyTextClass(urgency: SlaUrgency | null): string | null {
  if (urgency === "overdue" || urgency === "urgent") {
    return "text-red-600 dark:text-red-400";
  }
  if (urgency === "warning") {
    return "text-amber-600 dark:text-amber-400";
  }
  return null;
}

function SlaUrgencyDot(props: { urgency: SlaUrgency | null, className?: string }) {
  if (props.urgency == null || props.urgency === "ok") {
    return null;
  }
  const bgClass = props.urgency === "warning"
    ? "bg-amber-500"
    : "bg-red-500";
  const animateClass = props.urgency === "overdue" ? "animate-pulse" : "";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        bgClass,
        animateClass,
        props.className,
      )}
    />
  );
}

function getSlaUrgencyAriaLabel(urgency: SlaUrgency | null): string | null {
  if (urgency === "overdue") return "SLA overdue";
  if (urgency === "urgent") return "SLA due very soon";
  if (urgency === "warning") return "SLA approaching";
  return null;
}

function CompactSlaRow(props: {
  label: string,
  at: string | null,
  empty: string,
  now?: Date,
  isDue?: boolean,
  windowStartedAt?: string | null,
}) {
  if (props.at == null) {
    return (
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <Typography variant="secondary" className="shrink-0">{props.label}</Typography>
        <Typography className="text-muted-foreground">{props.empty}</Typography>
      </div>
    );
  }
  const date = new Date(props.at);
  if (Number.isNaN(date.getTime())) {
    return (
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <Typography variant="secondary" className="shrink-0">{props.label}</Typography>
        <Typography className="text-muted-foreground">Invalid</Typography>
      </div>
    );
  }
  const urgency = props.isDue === true && props.now != null
    ? computeSlaUrgency(date, props.now, { windowStartedAt: parseOptionalDate(props.windowStartedAt) })
    : null;
  const urgencyClass = getSlaUrgencyTextClass(urgency);
  const ariaLabel = getSlaUrgencyAriaLabel(urgency);
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <Typography variant="secondary" className="shrink-0">{props.label}</Typography>
      <div className="flex min-w-0 items-center gap-1.5">
        <SlaUrgencyDot urgency={urgency} />
        <Typography
          aria-label={ariaLabel ?? undefined}
          className={cn(
            "min-w-0 text-right font-medium tabular-nums",
            urgencyClass ?? "text-foreground/90",
          )}
        >
          {fromNow(date)}
        </Typography>
      </div>
    </div>
  );
}

function ConversationTeamSlaSidebar(props: {
  detail: ConversationDetailResponse,
  assignedToDraft: { userId: string | null, displayName: string | null },
  setAssignedToDraft: Dispatch<SetStateAction<{ userId: string | null, displayName: string | null }>>,
  priorityDraft: ConversationPriority,
  setPriorityDraft: Dispatch<SetStateAction<ConversationPriority>>,
  tagsDraft: string,
  setTagsDraft: Dispatch<SetStateAction<string>>,
  assigneeOptions: Array<{ value: string, label: string }>,
  settingsSaving: boolean,
  settingsError: string | null,
  onSave: () => Promise<void>,
  now: Date,
}) {
  const md = props.detail.conversation.metadata;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Typography className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Team
        </Typography>
        <div className="mt-2 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Typography variant="secondary" className="text-[11px] uppercase tracking-wider">
              Assignee
            </Typography>
            <DesignSelectorDropdown
              value={props.assignedToDraft.userId ?? "unassigned"}
              onValueChange={(value) => {
                if (value === "unassigned") {
                  props.setAssignedToDraft({ userId: null, displayName: null });
                  return;
                }
                const assigneeOption = props.assigneeOptions.find((option) => option.value === value)
                  ?? throwErr(`Assignee option "${value}" was not found.`);
                props.setAssignedToDraft({
                  userId: assigneeOption.value,
                  displayName: assigneeOption.label,
                });
              }}
              options={[
                { value: "unassigned", label: "Unassigned" },
                ...props.assigneeOptions,
              ]}
              size="sm"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Typography variant="secondary" className="text-[11px] uppercase tracking-wider">
              Priority
            </Typography>
            <DesignSelectorDropdown
              value={props.priorityDraft}
              onValueChange={(value) => {
                if (value !== "low" && value !== "normal" && value !== "high" && value !== "urgent") {
                  throwErr(`Unknown priority value "${value}"`);
                }
                props.setPriorityDraft(value);
              }}
              options={PRIORITY_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
              size="sm"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Typography variant="secondary" className="text-[11px] uppercase tracking-wider">
              Tags
            </Typography>
            <DesignInput
              value={props.tagsDraft}
              onChange={(event) => props.setTagsDraft(event.target.value)}
              placeholder="vip, billing, bug-report"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => props.setAssignedToDraft({ userId: null, displayName: null })}
            >
              Unassign
            </Button>
            <Button size="sm" disabled={props.settingsSaving} onClick={() => runAsynchronouslyWithAlert(props.onSave)}>
              {props.settingsSaving ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Save
            </Button>
          </div>
        </div>
      </div>

      <div>
        <Typography className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          SLA
        </Typography>
        <div className="mt-2 space-y-1.5 rounded-lg border border-border/50 bg-foreground/[0.02] px-2.5 py-2">
          <CompactSlaRow
            label="First response due"
            at={md.firstResponseDueAt}
            empty="None"
            isDue={md.firstResponseAt == null}
            now={props.now}
            windowStartedAt={props.detail.conversation.createdAt}
          />
          <CompactSlaRow label="First response sent" at={md.firstResponseAt} empty="Not yet" />
          <CompactSlaRow
            label="Next response due"
            at={md.nextResponseDueAt}
            empty="None"
            isDue
            now={props.now}
            windowStartedAt={md.lastCustomerReplyAt}
          />
          <CompactSlaRow label="Last customer reply" at={md.lastCustomerReplyAt} empty="None" />
          <CompactSlaRow label="Last agent reply" at={md.lastAgentReplyAt} empty="None" />
        </div>
      </div>

      {props.settingsError != null && (
        <Typography className="text-xs text-red-500">{props.settingsError}</Typography>
      )}
    </div>
  );
}

function parseTagInput(value: string) {
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  return Array.from(new Set(tags));
}

function getTeamMemberDisplayName(member: {
  id: string,
  teamProfile?: { displayName?: string | null } | null,
  primaryEmail?: string | null,
}) {
  const teamProfileDisplayName = member.teamProfile?.displayName;
  if (teamProfileDisplayName != null && teamProfileDisplayName.trim() !== "") {
    return teamProfileDisplayName;
  }
  if (member.primaryEmail != null && member.primaryEmail.trim() !== "") {
    return member.primaryEmail;
  }
  return member.id;
}

function getStatusChangeTarget(message: ConversationDetailResponse["messages"][number]) {
  if (typeof message.metadata !== "object" || message.metadata == null || !("status" in message.metadata)) {
    return message.status;
  }
  const nextStatus = message.metadata.status;
  return typeof nextStatus === "string" ? nextStatus : message.status;
}

function getConversationSenderLabel(message: ConversationDetailResponse["messages"][number]) {
  return message.sender.displayName ?? message.sender.primaryEmail ?? (
    message.sender.type === "user" ? "Customer" : message.sender.type === "agent" ? "Support" : "System"
  );
}

function SupportChatMessage(props: {
  message: ConversationDetailResponse["messages"][number],
  conversation: ConversationSummary,
}) {
  const trimmedBody = props.message.body?.trim() ?? "";
  const attachmentCount = props.message.attachments.length;
  const hasAttachments = attachmentCount > 0;
  if (props.message.messageType !== "status-change" && trimmedBody === "" && !hasAttachments) {
    return null;
  }

  const senderLabel = getConversationSenderLabel(props.message);
  const timestampLabel = formatSupportTimestamp(props.message.createdAt);

  if (props.message.messageType === "status-change") {
    const statusText = trimmedBody !== "" ? trimmedBody : `Conversation marked ${getStatusChangeTarget(props.message)}`;
    return (
      <div className="flex w-full min-w-0 justify-center py-2">
        <div className="inline-flex max-w-[92%] items-center gap-2 rounded-full border border-border/60 bg-foreground/[0.02] px-3 py-1.5">
          <ArrowsClockwiseIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <Typography className="text-[12px] leading-snug text-foreground/90">{statusText}</Typography>
          <Typography variant="secondary" className="text-[11px] tabular-nums">
            {timestampLabel}
          </Typography>
        </div>
      </div>
    );
  }

  const customerName = props.conversation.userDisplayName ?? props.conversation.userPrimaryEmail ?? "Customer";
  const bodyContent = trimmedBody !== "" ? trimmedBody : `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;

  if (props.message.messageType === "internal-note") {
    return (
      <div className="w-full min-w-0 py-1">
        <div className="flex w-full min-w-0 gap-3 rounded-md border border-dashed border-purple-400/35 bg-purple-500/[0.04] px-3 py-2.5">
          <div className="flex shrink-0 flex-col items-center pt-0.5">
            <NotePencilIcon className="h-3.5 w-3.5 text-purple-300/90" aria-hidden />
            <div className="mt-1.5 w-px flex-1 min-h-[1.25rem] bg-purple-400/25" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <Typography className="text-[10px] font-semibold uppercase tracking-wide text-purple-200/90">
                  Internal note
                </Typography>
                <Typography variant="secondary" className="text-[11px] text-foreground/55">
                  {senderLabel}
                </Typography>
              </div>
              <Typography variant="secondary" className="shrink-0 text-[11px] tabular-nums text-foreground/45">
                {timestampLabel}
              </Typography>
            </div>
            <Typography className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/85">
              {bodyContent}
            </Typography>
          </div>
        </div>
      </div>
    );
  }

  const isCustomer = props.message.sender.type === "user";
  /** Reserve avatar (2rem) + gap (gap-2 = 0.5rem) so %/calc max-widths resolve against the full row width. */
  const bubbleMaxClass = "max-w-[min(720px,calc(100%-2.5rem))]";
  const bubble = (
    <div
      className={cn(
        "rounded-2xl px-3.5 py-2.5",
        isCustomer ? "rounded-bl-md border border-white/10 bg-background/45" : "rounded-br-md bg-blue-500/10",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Typography variant="secondary" className="text-[11px]">
          {isCustomer ? customerName : senderLabel}
        </Typography>
        <Typography variant="secondary" className="text-[11px] tabular-nums">
          {timestampLabel}
        </Typography>
      </div>
      <Typography className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{bodyContent}</Typography>
    </div>
  );

  if (isCustomer) {
    const initialsSource = props.conversation.userDisplayName ?? props.conversation.userPrimaryEmail ?? "??";
    return (
      <div className="flex w-full min-w-0 justify-start">
        <div className="flex w-full min-w-0 items-end justify-start gap-2">
          <div className="shrink-0 pb-0.5">
            <Avatar className="h-8 w-8">
              <AvatarImage src={props.conversation.userProfileImageUrl ?? undefined} alt={customerName} />
              <AvatarFallback>{initialsSource.slice(0, 2)}</AvatarFallback>
            </Avatar>
          </div>
          <div className={cn("min-w-0", bubbleMaxClass)}>
            {bubble}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 justify-end">
      <div className="flex w-full min-w-0 items-end justify-end gap-2">
        <div className={cn("min-w-0", bubbleMaxClass)}>
          {bubble}
        </div>
        <div className="shrink-0 pb-0.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-foreground/[0.03]">
            <HeadsetIcon className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SupportUserHeader(props: {
  displayName: string | null,
  primaryEmail: string | null,
  profileImageUrl: string | null,
  size?: "default" | "compact",
}) {
  const name = props.displayName ?? props.primaryEmail ?? "Unknown user";
  const size = props.size ?? "default";
  return (
    <div className="flex items-center gap-3">
      <Avatar className={cn(size === "compact" ? "h-9 w-9" : "h-11 w-11")}>
        <AvatarImage src={props.profileImageUrl ?? undefined} alt={name} />
        <AvatarFallback>{name.slice(0, 2)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <Typography className={cn("truncate font-medium", size === "compact" ? "text-xs" : "text-sm")}>{name}</Typography>
        <Typography variant="secondary" className={cn("truncate", size === "compact" ? "text-[11px]" : "text-xs")}>
          {props.primaryEmail ?? "No primary email"}
        </Typography>
      </div>
    </div>
  );
}

function NewConversationDialog(props: {
  open: boolean,
  onOpenChange: (open: boolean) => void,
  currentUser: { getAccessToken: () => Promise<string | null> } | null,
  projectId: string,
  initialUserId?: string | null,
  initialUserLabel?: string | null,
  onCreated: (conversationId: string, userId: string) => void,
}) {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(props.initialUserId ?? null);
  const [selectedUserLabel, setSelectedUserLabel] = useState<string | null>(props.initialUserLabel ?? null);
  const [subject, setSubject] = useState("");
  const [initialMessage, setInitialMessage] = useState("");
  const [priority, setPriority] = useState<ConversationPriority>("normal");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setSelectedUserId(props.initialUserId ?? null);
    setSelectedUserLabel(props.initialUserLabel ?? null);
    setSubject("");
    setInitialMessage("");
    setPriority("normal");
    setErrorMessage(null);
  }, [props.initialUserId, props.initialUserLabel, props.open]);

  const canSubmit = subject.trim() !== "" && initialMessage.trim() !== "";

  return (
    <DesignDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      size="2xl"
      icon={ChatCircleDotsIcon}
      title="Create conversation"
      description="Start a support conversation for a user and keep replies, notes, and context in one place."
      className="max-h-[min(100dvh-2rem,52rem)]"
      bodyClassName="px-6 py-6"
      footerClassName="px-6 py-4"
      footer={(
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DesignDialogClose asChild>
            <DesignButton variant="secondary" size="sm">
              Cancel
            </DesignButton>
          </DesignDialogClose>
          <DesignButton
            size="sm"
            disabled={selectedUserId == null || !canSubmit}
            onClick={async () => {
              if (!canSubmit) {
                return;
              }
              const nextUserId = selectedUserId ?? throwErr("A support conversation must be attached to a selected user.");

              setErrorMessage(null);
              const result = await createConversation(props.currentUser, {
                projectId: props.projectId,
                userId: nextUserId,
                subject: subject.trim(),
                initialMessage: initialMessage.trim(),
                priority,
              });
              props.onCreated(result.conversationId, nextUserId);
              props.onOpenChange(false);
            }}
          >
            <PlusIcon className="mr-2 h-4 w-4" />
            Create Conversation
          </DesignButton>
        </div>
      )}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Typography className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            User
          </Typography>
          {selectedUserLabel != null ? (
            <div className="flex items-center justify-between rounded-xl border border-black/[0.08] bg-zinc-50/80 px-3 py-2 dark:border-white/[0.06] dark:bg-foreground/[0.03]">
              <Typography className="text-sm">{selectedUserLabel}</Typography>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => {
                  setSelectedUserId(null);
                  setSelectedUserLabel(null);
                }}
              >
                <XIcon className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl ring-1 ring-black/[0.06] dark:ring-white/[0.06]">
              <UserPickerTable
                action={(user) => (
                  <Button
                    size="sm"
                    onClick={() => {
                      setSelectedUserId(user.id);
                      setSelectedUserLabel(user.displayName ?? user.primaryEmail ?? user.id);
                    }}
                  >
                    Select
                  </Button>
                )}
              />
            </div>
          )}
        </div>

        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_160px]">
          <div className="flex flex-col gap-2">
            <Typography className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Subject
            </Typography>
            <DesignInput
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Password reset loop on mobile"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Typography className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Priority
            </Typography>
            <Select value={priority} onValueChange={(value: ConversationPriority) => setPriority(value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITY_OPTIONS.map((option) => (
                  <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Typography className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Initial message
          </Typography>
          <Textarea
            value={initialMessage}
            onChange={(event) => setInitialMessage(event.target.value)}
            placeholder="Describe the issue, customer context, and what support should do next."
            className="min-h-32"
          />
        </div>

        {errorMessage != null && (
          <DesignAlert
            variant="error"
            title="Could not create conversation"
            description={errorMessage}
          />
        )}
      </div>
    </DesignDialog>
  );
}

const REPLY_DISABLED_MESSAGE = "Customer-visible replies are disabled until inbound email is available. Please respond to the customer by email (use their address from the header).";

function SupportComposer(props: {
  detail: ConversationDetailResponse,
  onUpdated: (detail: ConversationDetailResponse) => void,
  currentUser: { getAccessToken: () => Promise<string | null> } | null,
  projectId: string,
}) {
  const [mode, setMode] = useState<"reply" | "internal-note">("internal-note");
  const [body, setBody] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setBody("");
    setErrorMessage(null);
    setMode("internal-note");
  }, [props.detail.conversation.conversationId]);

  const submit = async () => {
    if (mode === "reply" || body.trim() === "" || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const nextDetail = await appendConversationUpdate(props.currentUser, {
        projectId: props.projectId,
        conversationId: props.detail.conversation.conversationId,
        type: "internal-note",
        body: body.trim(),
      });
      props.onUpdated(nextDetail);
      setBody("");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className={cn(
        "shrink-0 border-t border-border/50 px-2 pb-2 pt-1.5 sm:px-3 sm:pb-2.5 sm:pt-2",
        "bg-gradient-to-b from-muted/25 to-muted/40 dark:from-white/[0.04] dark:to-white/[0.07]",
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1 sm:gap-1.5">
        <div
          className="inline-flex h-7 w-full max-w-[13rem] rounded-full bg-foreground/[0.06] p-0.5 dark:bg-white/[0.08] sm:h-7 sm:max-w-[14rem]"
          role="tablist"
          aria-label="Message type"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "reply"}
            className={cn(
              "min-h-0 flex-1 rounded-full px-2.5 text-[11px] font-medium transition-colors duration-150 sm:px-3 sm:text-xs",
              mode === "reply"
                ? "bg-background text-foreground shadow-sm dark:bg-background/90"
                : "text-muted-foreground hover:text-foreground/80",
            )}
            onClick={() => {
              setMode("reply");
              setBody("");
            }}
          >
            Reply
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "internal-note"}
            className={cn(
              "min-h-0 flex-1 rounded-full px-2.5 text-[11px] font-medium transition-colors duration-150 sm:px-3 sm:text-xs",
              mode === "internal-note"
                ? "bg-background text-foreground shadow-sm dark:bg-background/90"
                : "text-muted-foreground hover:text-foreground/80",
            )}
            onClick={() => setMode("internal-note")}
          >
            Note
          </button>
        </div>

        <Typography variant="secondary" className="text-[10px] leading-tight text-muted-foreground sm:text-[11px]">
          {mode === "reply"
            ? "Read-only — use email to reach the customer."
            : "Team only — not sent to the customer."}
        </Typography>

        {mode === "reply" && (
          <DesignAlert variant="info" title="Reply unavailable" description={REPLY_DISABLED_MESSAGE} />
        )}

        {errorMessage != null && (
          <div className="px-0.5">
            <DesignAlert
              variant="error"
              title="Could not send"
              description={errorMessage}
            />
          </div>
        )}

        <div
          className={cn(
            "flex items-end gap-1 rounded-2xl border px-1 py-0.5 shadow-sm backdrop-blur-md transition-colors duration-150 sm:gap-1.5 sm:rounded-[22px] sm:px-1.5 sm:py-1",
            mode === "internal-note"
              ? "border-purple-400/25 bg-purple-500/[0.06] dark:border-purple-400/20 dark:bg-purple-500/[0.08]"
              : "border-border/60 bg-muted/40 opacity-90 dark:bg-background/40",
          )}
        >
          <Textarea
            value={mode === "reply" ? "" : body}
            onChange={(event) => setBody(event.target.value)}
            readOnly={mode === "reply"}
            disabled={mode === "reply"}
            placeholder={mode === "reply" ? REPLY_DISABLED_MESSAGE : "Internal note…"}
            rows={mode === "reply" ? 2 : 1}
            className={cn(
              "max-h-[min(7rem,22vh)] min-h-[36px] flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-sm leading-snug sm:min-h-[40px] sm:px-2.5 sm:py-2 sm:text-[15px]",
              "shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 focus-visible:ring-offset-0",
              mode === "reply" && "cursor-not-allowed text-muted-foreground",
            )}
            onKeyDown={(event) => {
              if (mode === "reply") {
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                runAsynchronouslyWithAlert(submit);
              }
            }}
          />
          <Button
            type="button"
            size="icon"
            disabled={mode === "reply" || body.trim() === "" || isSubmitting}
            className={cn(
              "mb-0.5 h-8 w-8 shrink-0 rounded-full text-white shadow-md transition-transform duration-150 active:scale-95 sm:mb-1 sm:h-9 sm:w-9",
              mode === "internal-note"
                ? "bg-purple-600 hover:bg-purple-600/90"
                : "bg-blue-500 hover:bg-blue-500/90",
            )}
            aria-label={mode === "reply" ? "Send reply (disabled)" : "Add note"}
            onClick={() => runAsynchronouslyWithAlert(submit)}
          >
            {isSubmitting ? (
              <Spinner className="h-4 w-4 text-white" />
            ) : mode === "reply" ? (
              <PaperPlaneRightIcon className="h-5 w-5" weight="fill" aria-hidden />
            ) : (
              <NotePencilIcon className="h-5 w-5" weight="fill" aria-hidden />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const currentUser = useUser({ or: "redirect", projectIdMustMatch: "internal" });
  const project = adminApp.useProject();
  const router = useRouter();
  const searchParams = useSearchParams();

  const projectId = project.id;
  const selectedConversationId = searchParams.get("conversationId") ?? searchParams.get("threadId");
  const selectedUserId = searchParams.get("userId");

  const [searchInput, setSearchInput] = useState("");
  const deferredQuery = useDeferredValue(searchInput.trim());
  const [statusFilter, setStatusFilter] = useState<"all" | ConversationStatus>("open");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [conversationDetail, setConversationDetail] = useState<ConversationDetailResponse | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [assignedToDraft, setAssignedToDraft] = useState<{ userId: string | null, displayName: string | null }>({
    userId: null,
    displayName: null,
  });
  const [tagsDraft, setTagsDraft] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [priorityDraft, setPriorityDraft] = useState<ConversationPriority>("normal");
  const [teamSheetOpen, setTeamSheetOpen] = useState(false);
  const [isLgViewport, setIsLgViewport] = useState(false);
  const now = useTickingNow();

  const resolvedSelectedUserId = selectedUserId ?? conversationDetail?.conversation.userId ?? EMPTY_USER_ID;
  const selectedUser = adminApp.useUser(resolvedSelectedUserId);
  const currentOwnerTeam = currentUser.useTeam(project.ownerTeamId ?? throwErr(`Project "${project.id}" has no owner team.`)) ?? throwErr(`Owner team for project "${project.id}" was not found in current user's teams.`);
  const assignableTeamMembers = currentOwnerTeam.useUsers();

  const assigneeOptions = useMemo(() => {
    return assignableTeamMembers.map((member) => ({
      value: member.id,
      label: getTeamMemberDisplayName(member),
    }));
  }, [assignableTeamMembers]);

  const selectedUserLabel = selectedUser?.displayName ?? selectedUser?.primaryEmail ?? selectedUserId;

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const apply = () => setIsLgViewport(mediaQuery.matches);
    apply();
    mediaQuery.addEventListener("change", apply);
    return () => mediaQuery.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (isLgViewport) {
      setTeamSheetOpen(false);
    }
  }, [isLgViewport]);

  const saveTeamSettings = useCallback(async () => {
    if (conversationDetail == null) {
      return;
    }
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const nextDetail = await appendConversationUpdate(currentUser, {
        projectId,
        conversationId: conversationDetail.conversation.conversationId,
        type: "metadata",
        assignedToUserId: assignedToDraft.userId,
        assignedToDisplayName: assignedToDraft.displayName,
        priority: priorityDraft,
        tags: parseTagInput(tagsDraft),
      });
      setConversationDetail(nextDetail);
      setConversations((current) => current.map((conversation) => (
        conversation.conversationId === nextDetail.conversation.conversationId ? nextDetail.conversation : conversation
      )));
      setTeamSheetOpen(false);
    } finally {
      setSettingsSaving(false);
    }
  }, [assignedToDraft, conversationDetail, currentUser, priorityDraft, projectId, tagsDraft]);

  const updateSelection = useCallback((next: { conversationId?: string | null, userId?: string | null }) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("threadId");

    if (next.conversationId == null) {
      params.delete("conversationId");
    } else {
      params.set("conversationId", next.conversationId);
    }

    if (next.userId == null) {
      params.delete("userId");
    } else {
      params.set("userId", next.userId);
    }

    const basePath = urlString`/projects/${projectId}/conversations`;
    const nextPath = params.toString() ? `${basePath}?${params.toString()}` : basePath;
    router.replace(nextPath);
  }, [projectId, router, searchParams]);

  useEffect(() => {
    let cancelled = false;
    setConversationsLoading(true);
    setConversationsError(null);
    const conversationListRequest = listConversations(currentUser, {
      projectId,
      query: deferredQuery || undefined,
      status: statusFilter === "all" ? undefined : statusFilter,
      userId: selectedUserId ?? undefined,
    });
    conversationListRequest.then((result) => {
      if (cancelled) return;
      setConversations(result.conversations);
    }).catch((error) => {
      if (cancelled) return;
      setConversationsError(error instanceof Error ? error.message : "Unknown error");
      setConversations([]);
    }).finally(() => {
      if (cancelled) return;
      setConversationsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [currentUser, deferredQuery, projectId, refreshKey, selectedUserId, statusFilter]);

  useEffect(() => {
    if (selectedConversationId == null) {
      setConversationDetail(null);
      setConversationError(null);
      setConversationLoading(false);
      return;
    }

    let cancelled = false;
    setConversationLoading(true);
    setConversationError(null);
    const conversationDetailRequest = getConversation(currentUser, {
      projectId,
      conversationId: selectedConversationId,
    });
    conversationDetailRequest.then((result) => {
      if (cancelled) return;
      setConversationDetail(result);
    }).catch((error) => {
      if (cancelled) return;
      setConversationError(error instanceof Error ? error.message : "Unknown error");
      setConversationDetail(null);
    }).finally(() => {
      if (cancelled) return;
      setConversationLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [currentUser, projectId, selectedConversationId]);

  useEffect(() => {
    if (selectedConversationId == null && selectedUserId != null && conversations.length > 0) {
      updateSelection({ conversationId: conversations[0].conversationId, userId: selectedUserId });
    }
  }, [selectedConversationId, selectedUserId, conversations, updateSelection]);

  const selectedConversationSummary = useMemo(() => {
    return selectedConversationId == null
      ? null
      : conversations.find((conversation) => conversation.conversationId === selectedConversationId) ?? null;
  }, [selectedConversationId, conversations]);
  const selectedConversationDetailId = conversationDetail?.conversation.conversationId;
  const isConversationSelected = selectedConversationId != null;

  useEffect(() => {
    if (conversationDetail == null) {
      setAssignedToDraft({ userId: null, displayName: null });
      setTagsDraft("");
      setSettingsError(null);
      return;
    }
    setAssignedToDraft({
      userId: conversationDetail.conversation.metadata.assignedToUserId,
      displayName: conversationDetail.conversation.metadata.assignedToDisplayName,
    });
    setTagsDraft(conversationDetail.conversation.metadata.tags.join(", "));
    setPriorityDraft(conversationDetail.conversation.priority);
    setSettingsError(null);
  }, [conversationDetail, selectedConversationDetailId]);

  return (
    <AppEnabledGuard appId="support">
      <PageLayout
        {...(!isConversationSelected ? {
          title: "Conversations",
          description: "Unified inbox for customer messages, team replies, and internal notes",
          actions: (
            <Button onClick={() => setNewConversationOpen(true)}>
              <PlusIcon className="mr-2 h-4 w-4" />
              New Conversation
            </Button>
          ),
        } : { fillWidth: true as const })}
      >
        <div className={cn("relative isolate", isConversationSelected && "flex min-h-0 flex-1 flex-col")}>
          <div className={cn(isConversationSelected ? "flex min-h-0 flex-1 flex-col gap-3" : "grid gap-6")}>
            {!isConversationSelected && (
              <DesignCard
                title="Unified inbox"
                subtitle="Search conversations by subject or user and jump straight into the full history."
                icon={HeadsetIcon}
                gradient="default"
                className="h-fit"
                contentClassName="overflow-hidden !p-0"
                actions={selectedUserId != null ? (
                  <Button variant="ghost" size="sm" onClick={() => updateSelection({ userId: null, conversationId: null })}>
                    Clear Filter
                  </Button>
                ) : undefined}
              >
                <div className="flex flex-col gap-4 px-5 pt-4 pb-4">
                  <DesignInput
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    placeholder="Search subject, message, or email..."
                    leadingIcon={<MagnifyingGlassIcon className="h-4 w-4" />}
                  />

                  <DesignCategoryTabs
                    categories={STATUS_FILTER_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
                    selectedCategory={statusFilter}
                    onSelect={(id) => id === "closed" ? setStatusFilter("closed") : id === "pending" ? setStatusFilter("pending") : id === "open" ? setStatusFilter("open") : setStatusFilter("all")}
                    showBadge={false}
                    size="sm"
                    gradient="default"
                    glassmorphic={false}
                  />
                </div>

                <div className="flex max-h-[760px] flex-col overflow-y-auto border-t border-black/[0.06] px-2 py-2 dark:border-white/[0.06]">
                  {conversationsLoading && (
                    <div className="flex items-center justify-center py-10">
                      <Spinner className="h-5 w-5" />
                    </div>
                  )}

                  {!conversationsLoading && conversationsError != null && (
                    <div className="p-4">
                      <DesignAlert variant="error" title="Could not load conversations" description={conversationsError} />
                    </div>
                  )}

                  {!conversationsLoading && conversationsError == null && conversations.length === 0 && (
                    <div className="p-4">
                      <DesignAlert
                        variant="info"
                        title="No conversations yet"
                        description={selectedUserId != null ? "This user does not have any conversations yet. Start one from the main panel." : "Create the first conversation to start building the inbox."}
                      />
                    </div>
                  )}

                  {conversations.map((conversation, index) => {
                    const statusBadge = getStatusBadge(conversation.status);
                    const priorityMeta = getPriorityMeta(conversation.priority);
                    const sourceBadge = getSourceBadge(conversation.source);
                    const isActive = selectedConversationSummary?.conversationId === conversation.conversationId;
                    const assigneeLabel = conversation.metadata.assignedToDisplayName ?? "Unassigned";
                    const queueLabel = getConversationQueueLabel(conversation.status);
                    const firstDueLabel = formatAbsoluteTimestamp(conversation.metadata.firstResponseDueAt);
                    const nextDueLabel = formatAbsoluteTimestamp(conversation.metadata.nextResponseDueAt);
                    const firstDueUrgency = conversation.metadata.firstResponseAt == null
                      ? getSlaUrgencyFor(conversation.metadata.firstResponseDueAt, now, conversation.createdAt)
                      : null;
                    const nextDueUrgency = getSlaUrgencyFor(
                      conversation.metadata.nextResponseDueAt,
                      now,
                      conversation.metadata.lastCustomerReplyAt,
                    );
                    const firstDueClass = getSlaUrgencyTextClass(firstDueUrgency);
                    const nextDueClass = getSlaUrgencyTextClass(nextDueUrgency);
                    return (
                      <div
                        key={conversation.conversationId}
                      >
                        <button
                          className={cn(
                          "w-full rounded-2xl border border-transparent px-2 py-2 text-left",
                          "transition-colors duration-150 hover:transition-none",
                          isActive
                            ? "border-black/[0.08] bg-zinc-50 ring-1 ring-black/[0.06] dark:border-white/[0.08] dark:bg-white/[0.06] dark:ring-white/[0.06]"
                            : "hover:bg-zinc-50 dark:hover:bg-foreground/[0.03]",
                        )}
                          onClick={() => updateSelection({ conversationId: conversation.conversationId, userId: conversation.userId })}
                        >
                          <div className="flex flex-col gap-2 px-2.5 py-1">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <Typography className="line-clamp-1 text-sm font-semibold leading-tight">{conversation.subject}</Typography>
                                <Typography variant="secondary" className="line-clamp-1 text-[11px] leading-tight">
                                  {conversation.userDisplayName ?? conversation.userPrimaryEmail ?? "Unknown user"}
                                </Typography>
                              </div>
                              <Typography variant="secondary" className="shrink-0 text-[11px] tabular-nums">
                                {formatSupportTimestamp(conversation.lastActivityAt)}
                              </Typography>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              <DesignBadge label={statusBadge.label} color={statusBadge.color} size="sm" />
                              <DesignBadge label={priorityMeta.label} color={priorityMeta.color} size="sm" />
                              <DesignBadge label={sourceBadge.label} color={sourceBadge.color} size="sm" />
                              <Typography variant="secondary" className="ml-1 text-[11px]">
                                Owner: {assigneeLabel}
                              </Typography>
                              <Typography variant="secondary" className="text-[11px]">
                                Queue: {queueLabel}
                              </Typography>
                            </div>

                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1",
                                  firstDueClass ?? "text-muted-foreground",
                                )}
                                aria-label={getSlaUrgencyAriaLabel(firstDueUrgency) ?? undefined}
                              >
                                <SlaUrgencyDot urgency={firstDueUrgency} />
                                First due {firstDueLabel}
                              </span>
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1",
                                  nextDueClass ?? "text-muted-foreground",
                                )}
                                aria-label={getSlaUrgencyAriaLabel(nextDueUrgency) ?? undefined}
                              >
                                <SlaUrgencyDot urgency={nextDueUrgency} />
                                Next due {nextDueLabel}
                              </span>
                            </div>

                            <div className="rounded-md border border-black/[0.06] bg-zinc-50/80 px-2 py-1.5 dark:border-white/[0.06] dark:bg-foreground/[0.03]">
                              <Typography variant="secondary" className="text-[10px] uppercase tracking-wider">
                                Last message
                              </Typography>
                              <Typography className="mt-0.5 line-clamp-1 text-xs leading-relaxed text-foreground/90">
                                &quot;{conversation.preview ?? "No recent message"}&quot;
                              </Typography>
                            </div>
                          </div>
                        </button>
                        {index < conversations.length - 1 && (
                          <div className="mx-3 my-1 border-b border-border/60" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </DesignCard>
            )}

            {isConversationSelected && (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
                <button
                  type="button"
                  onClick={() => updateSelection({ conversationId: null })}
                  className={cn(
                    "inline-flex items-center gap-1.5 self-start rounded-md px-1 py-1 text-sm text-muted-foreground",
                    "transition-colors duration-150 hover:transition-none hover:text-foreground",
                  )}
                >
                  <ArrowLeftIcon className="h-4 w-4" />
                  <span>Back to inbox</span>
                </button>

                {conversationLoading && (
                  <DesignCard gradient="default" contentClassName="flex items-center justify-center p-10">
                    <Spinner className="h-5 w-5" />
                  </DesignCard>
                )}

                {!conversationLoading && conversationError != null && (
                  <DesignAlert variant="error" title="Could not load conversation" description={conversationError} />
                )}

                {!conversationLoading && conversationDetail != null && (
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 lg:flex-row lg:items-stretch lg:gap-5">
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
                      <div className="shrink-0 rounded-xl bg-white/90 px-3 py-2.5 shadow-sm ring-1 ring-black/[0.06] backdrop-blur-xl dark:bg-background/50 dark:ring-white/[0.06]">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <SupportUserHeader
                            size="compact"
                            displayName={conversationDetail.conversation.userDisplayName}
                            primaryEmail={conversationDetail.conversation.userPrimaryEmail}
                            profileImageUrl={conversationDetail.conversation.userProfileImageUrl}
                          />
                          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                            {!isLgViewport && (
                              <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5" onClick={() => setTeamSheetOpen(true)}>
                                <UsersThreeIcon className="h-4 w-4" />
                                Team
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8"
                              onClick={async () => {
                                const nextDetail = await appendConversationUpdate(currentUser, {
                                  projectId,
                                  conversationId: conversationDetail.conversation.conversationId,
                                  type: "status",
                                  status: conversationDetail.conversation.status === "closed" ? "open" : "closed",
                                });
                                setConversationDetail(nextDetail);
                                setConversations((current) => current.map((conversation) => (
                                  conversation.conversationId === nextDetail.conversation.conversationId ? nextDetail.conversation : conversation
                                )));
                                setRefreshKey((current) => current + 1);
                              }}
                            >
                              {conversationDetail.conversation.status === "closed" ? "Reopen" : "Close"}
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              disabled={conversationDetail.conversation.userId == null}
                              onClick={() => {
                                const userId = conversationDetail.conversation.userId;
                                if (userId == null) {
                                  return;
                                }
                                router.push(urlString`/projects/${projectId}/users/${userId}`);
                              }}
                            >
                              <ArrowSquareOutIcon className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                        <Typography className="mt-2 text-base font-semibold leading-snug tracking-tight sm:text-lg">
                          {conversationDetail.conversation.subject}
                        </Typography>
                        <Typography variant="secondary" className="mt-1 text-xs leading-snug">
                          <span className="text-muted-foreground">Started from</span>
                          {" "}
                          {getConversationStartedFromLine(conversationDetail)}
                        </Typography>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <DesignBadge label={getStatusBadge(conversationDetail.conversation.status).label} color={getStatusBadge(conversationDetail.conversation.status).color} size="sm" />
                          <Typography variant="secondary" className="text-xs">
                            Last active {formatSupportTimestamp(conversationDetail.conversation.lastActivityAt)}
                          </Typography>
                        </div>
                      </div>

                      <DesignCard
                        gradient="default"
                        className={cn(
                          "relative flex min-h-0 flex-1 flex-col overflow-hidden",
                          "min-h-[min(520px,calc(100dvh-14rem))] lg:min-h-0",
                        )}
                        contentClassName="flex min-h-0 flex-1 flex-col overflow-hidden !p-0"
                      >
                        <div className="flex min-h-0 flex-1 flex-col">
                          <div
                            className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4"
                            style={{ scrollbarGutter: "stable" }}
                          >
                            <div className="flex flex-col gap-3">
                              {conversationDetail.messages.map((message) => (
                                <SupportChatMessage key={message.id} message={message} conversation={conversationDetail.conversation} />
                              ))}
                            </div>
                          </div>
                          <SupportComposer
                            detail={conversationDetail}
                            currentUser={currentUser}
                            projectId={projectId}
                            onUpdated={(nextDetail) => {
                              setConversationDetail(nextDetail);
                              setConversations((current) => {
                                const existing = current.find((conversation) => conversation.conversationId === nextDetail.conversation.conversationId);
                                if (existing == null) {
                                  return [nextDetail.conversation, ...current];
                                }
                                return current.map((conversation) => (
                                  conversation.conversationId === nextDetail.conversation.conversationId ? nextDetail.conversation : conversation
                                ));
                              });
                              setRefreshKey((current) => current + 1);
                            }}
                          />
                        </div>
                      </DesignCard>
                    </div>

                    {isLgViewport && (
                      <aside className="flex w-full max-w-[18rem] shrink-0 flex-col">
                        <div className="rounded-xl border border-border/60 bg-foreground/[0.02] p-4">
                          <Typography className="text-sm font-semibold">Team & SLA</Typography>
                          <div className="mt-4">
                            <ConversationTeamSlaSidebar
                              detail={conversationDetail}
                              assignedToDraft={assignedToDraft}
                              setAssignedToDraft={setAssignedToDraft}
                              priorityDraft={priorityDraft}
                              setPriorityDraft={setPriorityDraft}
                              tagsDraft={tagsDraft}
                              setTagsDraft={setTagsDraft}
                              assigneeOptions={assigneeOptions}
                              settingsSaving={settingsSaving}
                              settingsError={settingsError}
                              onSave={saveTeamSettings}
                              now={now}
                            />
                          </div>
                        </div>
                      </aside>
                    )}

                    {!isLgViewport && (
                      <Sheet open={teamSheetOpen} onOpenChange={setTeamSheetOpen}>
                        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
                          <SheetHeader className="text-left">
                            <SheetTitle>Team & SLA</SheetTitle>
                          </SheetHeader>
                          <div className="mt-4 flex-1">
                            <ConversationTeamSlaSidebar
                              detail={conversationDetail}
                              assignedToDraft={assignedToDraft}
                              setAssignedToDraft={setAssignedToDraft}
                              priorityDraft={priorityDraft}
                              setPriorityDraft={setPriorityDraft}
                              tagsDraft={tagsDraft}
                              setTagsDraft={setTagsDraft}
                              assigneeOptions={assigneeOptions}
                              settingsSaving={settingsSaving}
                              settingsError={settingsError}
                              onSave={saveTeamSettings}
                              now={now}
                            />
                          </div>
                        </SheetContent>
                      </Sheet>
                    )}
                  </div>
                )}

                {!conversationLoading && conversationDetail == null && selectedUserId != null && selectedUser != null && (
                  <DesignCard gradient="default" contentClassName="p-7">
                    <div className="flex flex-col gap-6">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="flex flex-col gap-3">
                          <SupportUserHeader
                            displayName={selectedUser.displayName}
                            primaryEmail={selectedUser.primaryEmail}
                            profileImageUrl={selectedUser.profileImageUrl}
                          />
                          <div>
                            <Typography className="text-xl font-semibold">No conversation selected</Typography>
                            <Typography variant="secondary" className="text-sm">
                              This user is selected from Conversations. Start a new conversation or pick an existing one from the inbox.
                            </Typography>
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" onClick={() => router.push(urlString`/projects/${projectId}/users/${selectedUser.id}`)}>
                            <ArrowSquareOutIcon className="mr-2 h-4 w-4" />
                            Open User
                          </Button>
                          <Button onClick={() => setNewConversationOpen(true)}>
                            <PlusIcon className="mr-2 h-4 w-4" />
                            Create Conversation
                          </Button>
                        </div>
                      </div>

                      <div className="grid gap-4 md:grid-cols-3">
                        <DesignCard gradient="default" contentClassName="p-4">
                          <Typography className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Primary Email</Typography>
                          <Typography className="mt-2 text-sm">{selectedUser.primaryEmail ?? "Not set"}</Typography>
                        </DesignCard>
                        <DesignCard gradient="default" contentClassName="p-4">
                          <Typography className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Signed Up</Typography>
                          <Typography className="mt-2 text-sm">{fromNow(selectedUser.signedUpAt)}</Typography>
                        </DesignCard>
                        <DesignCard gradient="default" contentClassName="p-4">
                          <Typography className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Last Active</Typography>
                          <Typography className="mt-2 text-sm">{fromNow(selectedUser.lastActiveAt)}</Typography>
                        </DesignCard>
                      </div>
                    </div>
                  </DesignCard>
                )}

                {!conversationLoading && conversationDetail == null && selectedUserId == null && (
                  <DesignCard
                    title="Pick a conversation or open a user"
                    subtitle="This inbox is the single place to investigate a user, add internal context, and reply in the same conversation the user sees."
                    icon={ChatCircleDotsIcon}
                    gradient="default"
                    contentClassName="flex justify-center p-10"
                  >
                    <Button onClick={() => setNewConversationOpen(true)}>
                      <PlusIcon className="mr-2 h-4 w-4" />
                      Create First Conversation
                    </Button>
                  </DesignCard>
                )}
              </div>
            )}
          </div>
        </div>

        <NewConversationDialog
          open={newConversationOpen}
          onOpenChange={setNewConversationOpen}
          currentUser={currentUser}
          projectId={projectId}
          initialUserId={selectedUserId}
          initialUserLabel={selectedUserLabel}
          onCreated={(conversationId, userId) => {
            updateSelection({ conversationId, userId });
            setRefreshKey((current) => current + 1);
          }}
        />
      </PageLayout>
    </AppEnabledGuard>
  );
}

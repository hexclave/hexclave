"use client";

import { CodeBlock } from "@/components/code-block";
import { StyledLink } from "@/components/link";
import {
  DesignAlert,
  DesignButton,
  DesignCard,
  DesignCardTint,
  DesignCategoryTabs,
  DesignEmptyState,
  DesignMetricCard,
  DesignPillToggle,
  DesignTable,
  DesignTableBody,
  DesignTableCell,
  DesignTableHead,
  DesignTableHeader,
  DesignTableRow,
} from "@/components/design-components";
import { CopyButton, CopyPromptButton } from "@/components/ui";
import {
  ArrowSquareOutIcon,
  CodeIcon,
  EnvelopeSimpleIcon,
  FileTextIcon,
  GearIcon,
  KeyIcon,
  MailboxIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import type { AdminEmailOutbox } from "@hexclave/next";
import {
  DataGrid,
  useDataGridUrlState,
  type DataGridColumnDef,
} from "@hexclave/dashboard-ui-components";
import { useCallback, useMemo, useState } from "react";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { ALL_APPS_FRONTEND, getAppPath, getItemPath } from "@/lib/apps-frontend";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";
import { STATUS_LABELS } from "../email-sent/email-status-utils";
import { SentEmailsView } from "../email-sent/sent-emails-view";
import {
  countEmailsSince,
  getDeliverySuccessRate,
  groupEmailsBySource,
  isEmailApiEmail,
  type EmailApiSource,
} from "./email-api-logic";

const DAY = 24 * 60 * 60 * 1000;

type SendMode = "typescript" | "rest";
type SendFlavor = "html" | "template" | "emails";

type StatTile = {
  label: string,
  value: number | string,
};

function formatDate(date: Date | null): string {
  return date == null
    ? "Never"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function selectSendMode(id: string): SendMode {
  if (id === "typescript" || id === "rest") return id;
  return throwErr(`Unknown send mode: ${id}`);
}

function selectSendFlavor(id: string): SendFlavor {
  if (id === "html" || id === "template" || id === "emails") return id;
  return throwErr(`Unknown send flavor: ${id}`);
}

const sourceColumns: DataGridColumnDef<EmailApiSource>[] = [
  { id: "source", header: "Source", flex: 1, minWidth: 150, type: "string", accessor: (row) => row.displayName },
  { id: "count", header: "Sends", width: 90, type: "number", accessor: (row) => row.count },
  { id: "lastSentAt", header: "Last sent", width: 190, type: "string", accessor: (row) => formatDate(row.lastSentAt) },
  {
    id: "status",
    header: "Status",
    flex: 1,
    minWidth: 180,
    type: "string",
    accessor: (row) => [...row.statuses.entries()]
      .map(([status, count]) => `${STATUS_LABELS[status]}: ${count}`)
      .join(" · "),
  },
];

function ApiStatsAndSources({ emails, templateNames }: {
  emails: AdminEmailOutbox[],
  templateNames: ReadonlyMap<string, string>,
}) {
  const now = new Date();
  const sources = useMemo(() => groupEmailsBySource(emails, templateNames), [emails, templateNames]);
  const [gridState, setGridState] = useDataGridUrlState(sourceColumns, {
    paramPrefix: "emailsource",
    initial: { sorting: [{ columnId: "count", direction: "desc" }] },
  });
  const rate = getDeliverySuccessRate(emails);
  const stats: StatTile[] = [
    { label: "Sent · last 24h", value: countEmailsSince(emails, now, DAY) },
    { label: "Sent · last 7d", value: countEmailsSince(emails, now, 7 * DAY) },
    { label: "Sent · last 30d", value: countEmailsSince(emails, now, 30 * DAY) },
    { label: "Delivery success", value: rate == null ? "—" : `${Math.round(rate * 100)}%` },
  ];

  if (emails.length === 0) {
    return (
      <DesignCard glassmorphic contentClassName="p-1">
        <DesignEmptyState
          icon={MailboxIcon}
          title="No API sends yet"
          description="Use the quickstart below to send your first message, then return here to inspect delivery."
        />
      </DesignCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map(({ label, value }) => <DesignMetricCard key={label} label={label} value={value} />)}
      </div>
      <DesignCard title="By source" subtitle="Raw HTML and template sends" icon={MailboxIcon} glassmorphic contentClassName="p-3">
        <DataGrid<EmailApiSource>
          columns={sourceColumns}
          rows={sources}
          getRowId={(row) => row.id}
          totalRowCount={sources.length}
          state={gridState}
          onChange={setGridState}
          fillHeight={false}
          footer={false}
        />
      </DesignCard>
    </div>
  );
}

function PromptCard({ title, prompt }: { title: string, prompt: string }) {
  return (
    <DesignCard contentClassName="p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 text-sm font-medium">{title}</div>
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{prompt}</p>
        </div>
        <CopyPromptButton content={prompt} aria-label={`Copy ${title} prompt`} className="shrink-0" />
      </div>
    </DesignCard>
  );
}

function ReferenceTable() {
  return (
    <DesignCard title="SendEmail reference" subtitle="Choose exactly one recipient selector and one content source" icon={FileTextIcon} glassmorphic>
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-2">
          <DesignCardTint gradient="blue" className="p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide">Exactly one recipient</div>
            <div className="text-sm"><code>userIds</code> <span className="text-muted-foreground">Known users</span></div>
            <div className="text-sm"><code>allUsers</code> <span className="text-muted-foreground">Every user</span></div>
            <div className="text-sm"><code>emails</code> <span className="text-muted-foreground">Transactional addresses; no unsubscribe</span></div>
          </DesignCardTint>
          <DesignCardTint gradient="purple" className="p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide">Exactly one content source</div>
            <div className="text-sm"><code>html</code> <span className="text-muted-foreground">Inline markup</span></div>
            <div className="text-sm"><code>templateId</code> <span className="text-muted-foreground">Email Templates app</span></div>
            <div className="text-sm"><code>draftId</code> <span className="text-muted-foreground">Email Drafts app</span></div>
          </DesignCardTint>
        </div>
        <DesignTable>
          <DesignTableHeader><DesignTableRow><DesignTableHead>Optional field</DesignTableHead><DesignTableHead>Meaning</DesignTableHead></DesignTableRow></DesignTableHeader>
          <DesignTableBody>
            <DesignTableRow><DesignTableCell><code>subject</code></DesignTableCell><DesignTableCell>Override the message subject.</DesignTableCell></DesignTableRow>
            <DesignTableRow><DesignTableCell><code>variables</code></DesignTableCell><DesignTableCell>Values used when rendering a template.</DesignTableCell></DesignTableRow>
            <DesignTableRow><DesignTableCell><code>themeId</code></DesignTableCell><DesignTableCell>Apply a project email theme, or disable it with <code>false</code>.</DesignTableCell></DesignTableRow>
            <DesignTableRow><DesignTableCell><code>notificationCategoryName</code></DesignTableCell><DesignTableCell>Use <code>Transactional</code> or <code>Marketing</code>; marketing sends respect unsubscribes.</DesignTableCell></DesignTableRow>
            <DesignTableRow><DesignTableCell><code>scheduledAt</code></DesignTableCell><DesignTableCell>Queue the send for a future date.</DesignTableCell></DesignTableRow>
          </DesignTableBody>
        </DesignTable>
        <DesignCard gradient="default" contentClassName="p-3 text-sm">
          <div className="font-medium">REST endpoint</div>
          <code className="text-xs">POST https://api.hexclave.com/api/v1/emails/send-email</code>
          <p className="mt-2 text-xs text-muted-foreground">Required headers: <code>X-Stack-Access-Type: server</code>, <code>X-Stack-Project-Id</code>, and <code>X-Stack-Secret-Server-Key</code>.</p>
        </DesignCard>
      </div>
    </DesignCard>
  );
}

function TemplatesCard({ templates, templatesHref }: {
  templates: { id: string, displayName: string }[],
  templatesHref: string,
}) {
  return (
    <DesignCard
      title="Templates"
      subtitle={<span>Reusable content from the Emails app · <StyledLink href={templatesHref}>Manage templates</StyledLink></span>}
      icon={FileTextIcon}
      glassmorphic
    >
      {templates.length === 0 ? (
        <DesignEmptyState
          icon={FileTextIcon}
          title="No templates yet"
          description="Create a template in the Emails app, then use its exact ID in templateId."
        >
          <DesignButton asChild size="sm" variant="outline"><a href={templatesHref}>Create a template</a></DesignButton>
        </DesignEmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {templates.map((template) => (
            <DesignCard key={template.id} gradient="default" contentClassName="p-3">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="truncate text-sm">{template.displayName}</span>
                <div className="flex min-w-0 shrink-0 items-center gap-1">
                  <code className="max-w-[min(24rem,50vw)] truncate text-xs text-muted-foreground">{template.id}</code>
                  <CopyButton content={template.id} variant="ghost" />
                </div>
              </div>
            </DesignCard>
          ))}
        </div>
      )}
    </DesignCard>
  );
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const templates = adminApp.useEmailTemplates();
  const emailServer = project.useConfig().emails.server;
  const [sendMode, setSendMode] = useState<SendMode>("typescript");
  const [sendFlavor, setSendFlavor] = useState<SendFlavor>("html");
  const templateNames = useMemo(() => new Map(templates.map((template) => [template.id, template.displayName])), [templates]);
  const templateId = templates[0]?.id ?? "replace-with-template-id";
  const emailSettingsItem = ALL_APPS_FRONTEND.emails.navigationItems.find((item) => item.displayName === "Email Settings")
    ?? throwErr("Email Settings navigation item is missing from the emails app registry");
  const templatesItem = ALL_APPS_FRONTEND.emails.navigationItems.find((item) => item.displayName === "Templates")
    ?? throwErr("Templates navigation item is missing from the emails app registry");
  const sentItem = ALL_APPS_FRONTEND.emails.navigationItems.find((item) => item.displayName === "Sent")
    ?? throwErr("Sent navigation item is missing from the emails app registry");
  const draftsItem = ALL_APPS_FRONTEND.emails.navigationItems.find((item) => item.displayName === "Drafts")
    ?? throwErr("Drafts navigation item is missing from the emails app registry");
  const emailSettingsHref = getItemPath(project.id, ALL_APPS_FRONTEND.emails, emailSettingsItem);
  const templatesHref = getItemPath(project.id, ALL_APPS_FRONTEND.emails, templatesItem);
  const sentHref = getItemPath(project.id, ALL_APPS_FRONTEND.emails, sentItem);
  const draftsHref = getItemPath(project.id, ALL_APPS_FRONTEND.emails, draftsItem);
  const apiKeysHref = getAppPath(project.id, ALL_APPS_FRONTEND["api-keys"]);
  const filterFn = useCallback((email: AdminEmailOutbox) => isEmailApiEmail(email), []);
  const snippets = useMemo(() => ({
    setup: `pnpm add @hexclave/next\n\n# .env\nNEXT_PUBLIC_HEXCLAVE_PROJECT_ID=${project.id}\nHEXCLAVE_SECRET_SERVER_KEY=your_server_key`,
    html: `import { hexclaveServerApp } from "@/hexclave/server";\n\nawait hexclaveServerApp.sendEmail({\n  userIds: ["user-id"],\n  subject: "Welcome to Acme",\n  html: "<h1>Welcome!</h1><p>Thanks for joining.</p>",\n});`,
    template: `await hexclaveServerApp.sendEmail({\n  userIds: ["user-id"],\n  templateId: "${templateId}",\n  variables: { firstName: "Ada", plan: "Pro" },\n});`,
    emails: `await hexclaveServerApp.sendEmail({\n  emails: ["customer@example.com"],\n  subject: "Your receipt",\n  html: "<p>Thanks for your purchase.</p>",\n});\n// Arbitrary addresses cannot unsubscribe; use this for transactional mail only.`,
    curl: `curl -X POST https://api.hexclave.com/api/v1/emails/send-email \\\n  -H "Content-Type: application/json" \\\n  -H "X-Stack-Access-Type: server" \\\n  -H "X-Stack-Project-Id: ${project.id}" \\\n  -H "X-Stack-Secret-Server-Key: $HEXCLAVE_SECRET_SERVER_KEY" \\\n  -d '${JSON.stringify({ user_ids: ["user-id"], template_id: templateId, variables: { firstName: "Ada" } })}'`,
  }), [project.id, templateId]);
  const prompts = [
    ["Welcome on signup", `In project ${project.id}, send a server-side transactional welcome email to a newly created user with hexclaveServerApp.sendEmail. Keep the key private and include a test.`],
    ["Templated notification", `In project ${project.id}, send template ${templateId} with firstName and plan variables. Validate the payload and show the exact server-only TypeScript implementation.`],
    ["Scheduled announcement", `For project ${project.id}, schedule a future announcement to all users with a template, then explain how to inspect the outbox and retry failures safely.`],
    ["Unsubscribe-aware marketing", `Design a ${project.id} marketing send using notificationCategoryName: "Marketing", user IDs, consent checks, and a verification checklist. Never send marketing to arbitrary emails.`],
    ["Read delivery status", `Add an admin-only ${project.id} diagnostic that paginates the email outbox and summarizes queued, sent, bounced, and error statuses without exposing secrets or internal errors.`],
  ];
  const activeContent = sendMode === "rest" ? snippets.curl : snippets[sendFlavor];
  const activeTitle = sendMode === "rest"
    ? "REST / curl"
    : sendFlavor === "html" ? "Raw HTML" : sendFlavor === "template" ? "Email template" : "Arbitrary address";

  return (
    <AppEnabledGuard appId="email-api">
      <PageLayout
        title="Email API"
        description="Send from your server, connect to the Emails app, and observe delivery."
        actions={
          <div className="flex flex-wrap gap-2">
            <DesignButton asChild size="sm" variant="outline"><a href={emailSettingsHref}><GearIcon className="mr-1.5 h-4 w-4" />Email Settings</a></DesignButton>
            <DesignButton asChild size="sm" variant="outline"><a href={apiKeysHref}><KeyIcon className="mr-1.5 h-4 w-4" />API Keys</a></DesignButton>
            <DesignButton asChild size="sm" variant="ghost"><a href="https://docs.hexclave.com/guides/apps/emails/overview" target="_blank" rel="noreferrer"><ArrowSquareOutIcon className="mr-1.5 h-4 w-4" />Docs</a></DesignButton>
          </div>
        }
      >
        <DesignAlert
          variant={emailServer.isShared ? "info" : "success"}
          title={emailServer.isShared ? "Shared development server" : "Custom email server connected"}
          description={
            <div className="space-y-1">
              <p>The Email API is server-side only. Keep your server key private.</p>
              {emailServer.isShared ? (
                <p>Custom email content receives a [Hexclave dev email] subject prefix and an injected development notice. <StyledLink href={emailSettingsHref}>Configure Email Settings</StyledLink> for unbranded delivery.</p>
              ) : (
                <p>Sends go from your project&apos;s own domain through the configured email server.</p>
              )}
            </div>
          }
        />

        <section className="flex flex-col gap-3">
          <div className="flex items-end justify-between gap-3">
            <div><h2 className="text-lg font-semibold">Delivery</h2><p className="text-sm text-muted-foreground">See whether API-attributed sends reached a terminal delivery state.</p></div>
            <StyledLink href={sentHref}>Open full sent view</StyledLink>
          </div>
          <SentEmailsView stickyTop={0} filterFn={filterFn} renderActions={(emails) => <ApiStatsAndSources emails={emails} templateNames={templateNames} />} />
        </section>

        <DesignCard title="Quickstart" subtitle="Choose a transport and send shape; every example uses this project’s credentials." icon={CodeIcon} glassmorphic>
          <div className="flex flex-col gap-3">
            <CodeBlock language="bash" title="Install and configure once" content={snippets.setup} icon="terminal" compact />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <DesignPillToggle options={[{ id: "typescript", label: "TypeScript SDK", icon: CodeIcon }, { id: "rest", label: "REST / curl", icon: ArrowSquareOutIcon }]} selected={sendMode} onSelect={(id) => setSendMode(selectSendMode(id))} size="sm" />
              {sendMode === "typescript" && <DesignCategoryTabs categories={[{ id: "html", label: "Raw HTML" }, { id: "template", label: "Template" }, { id: "emails", label: "Arbitrary address" }]} selectedCategory={sendFlavor} onSelect={(id) => setSendFlavor(selectSendFlavor(id))} size="sm" />}
            </div>
            <CodeBlock language={sendMode === "rest" ? "bash" : "typescript"} title={activeTitle} content={activeContent} icon={sendMode === "rest" ? "terminal" : "code"} />
            {sendFlavor === "template" && templates.length === 0 && sendMode === "typescript" && <p className="text-xs text-muted-foreground">No template exists yet. Create one below before replacing the placeholder ID.</p>}
            {sendFlavor === "emails" && sendMode === "typescript" && <p className="text-xs text-muted-foreground">Arbitrary addresses cannot unsubscribe, so use this shape for transactional mail only.</p>}
          </div>
        </DesignCard>

        <ReferenceTable />
        <TemplatesCard templates={templates} templatesHref={templatesHref} />

        <DesignCard title="Related Emails surfaces" subtitle="Keep content, settings, and delivery close to your integration." icon={EnvelopeSimpleIcon} glassmorphic>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <StyledLink href={templatesHref}>Templates</StyledLink>
            <StyledLink href={draftsHref}>Drafts</StyledLink>
            <StyledLink href={sentHref}>Sent emails</StyledLink>
            <StyledLink href={emailSettingsHref}>Email Settings</StyledLink>
          </div>
        </DesignCard>

        <DesignCard title="Prompts" subtitle="Compact starting points for your coding agent." icon={SparkleIcon} glassmorphic>
          <div className="grid gap-2 md:grid-cols-2">
            {prompts.map(([title, prompt]) => <PromptCard key={title} title={title} prompt={prompt} />)}
          </div>
        </DesignCard>
      </PageLayout>
    </AppEnabledGuard>
  );
}

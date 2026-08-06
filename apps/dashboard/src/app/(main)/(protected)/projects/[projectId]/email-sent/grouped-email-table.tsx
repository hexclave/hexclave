"use client";

import { useRouter } from "@/components/router";
import { Spinner, Typography } from "@/components/ui";
import { AdminEmailOutbox, AdminEmailOutboxStatus } from "@hexclave/next";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import {
  DataGrid,
  useDataGridUrlState,
  useDataSource,
  type DataGridColumnDef,
} from "@hexclave/dashboard-ui-components";
import { useEffect, useMemo, useState } from "react";
import { useAdminApp, useProjectId } from "../use-admin-app";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { StatsBar, StatsBarData } from "./stats-bar";

type GroupedEmailRow = {
  // Unique key for the group
  groupKey: string,
  // Display name for the template/draft
  displayName: string,
  // Type of source
  sourceType: "draft" | "template" | "none",
  // ID of the source (draft or template)
  sourceId: string | null,
  // Number of recipients (emails) in this group
  recipientCount: number,
  // Stats for the bar
  stats: StatsBarData,
};

// Map status to stats category
function getStatsCategory(status: AdminEmailOutboxStatus): keyof StatsBarData {
  switch (status) {
    case "sent":
    case "opened":
    case "clicked":
    case "delivery-delayed": {
      return "sent";
    }
    case "skipped": {
      return "cancelled";
    }
    case "bounced": {
      return "bounced";
    }
    case "marked-as-spam": {
      return "spam";
    }
    case "render-error":
    case "server-error": {
      return "errors";
    }
    case "paused":
    case "preparing":
    case "rendering":
    case "scheduled":
    case "queued":
    case "sending": {
      return "inProgress";
    }
    default: {
      return "inProgress";
    }
  }
}

function groupEmails(
  emails: AdminEmailOutbox[],
  drafts: Map<string, string>,
  templates: Map<string, string>
): GroupedEmailRow[] {
  // Group emails by their source
  const groups = new Map<string, {
    displayName: string,
    sourceType: "draft" | "template" | "none",
    sourceId: string | null,
    emails: AdminEmailOutbox[],
  }>();

  for (const email of emails) {
    let groupKey: string;
    let displayName: string;
    let sourceType: "draft" | "template" | "none";
    let sourceId: string | null;

    if (email.createdWith === "draft" && email.emailDraftId) {
      groupKey = `draft:${email.emailDraftId}`;
      displayName = drafts.get(email.emailDraftId) ?? `Draft (${email.emailDraftId.slice(0, 8)}...)`;
      sourceType = "draft";
      sourceId = email.emailDraftId;
    } else if (email.createdWith === "programmatic-call" && email.emailProgrammaticCallTemplateId) {
      groupKey = `template:${email.emailProgrammaticCallTemplateId}`;
      displayName = templates.get(email.emailProgrammaticCallTemplateId) ?? `Template (${email.emailProgrammaticCallTemplateId.slice(0, 8)}...)`;
      sourceType = "template";
      sourceId = email.emailProgrammaticCallTemplateId;
    } else {
      groupKey = "none";
      displayName = "(No template/draft)";
      sourceType = "none";
      sourceId = null;
    }

    const existing = groups.get(groupKey);
    if (existing) {
      existing.emails.push(email);
    } else {
      groups.set(groupKey, {
        displayName,
        sourceType,
        sourceId,
        emails: [email],
      });
    }
  }

  // Convert to rows with stats
  const rows: GroupedEmailRow[] = [];
  for (const [groupKey, group] of groups) {
    const stats: StatsBarData = {
      sent: 0,
      bounced: 0,
      spam: 0,
      errors: 0,
      cancelled: 0,
      inProgress: 0,
    };

    for (const email of group.emails) {
      const category = getStatsCategory(email.status);
      stats[category]++;
    }

    rows.push({
      groupKey,
      displayName: group.displayName,
      sourceType: group.sourceType,
      sourceId: group.sourceId,
      recipientCount: group.emails.length,
      stats,
    });
  }

  // Sort by recipient count descending
  rows.sort((a, b) => b.recipientCount - a.recipientCount);

  return rows;
}

const groupedEmailGridColumns: DataGridColumnDef<GroupedEmailRow>[] = [
  {
    id: "displayName",
    header: "Template/Draft",
    accessor: "displayName",
    width: 200,
    flex: 1,
    type: "string",
    renderCell: ({ value }) => <span className="font-medium">{String(value)}</span>,
  },
  {
    id: "recipientCount",
    header: "Recipients",
    accessor: "recipientCount",
    width: 120,
    type: "number",
    align: "right",
    renderCell: ({ value }) => (
      <span className="text-sm tabular-nums">{Number(value).toLocaleString()}</span>
    ),
  },
  {
    id: "stats",
    header: "Stats",
    accessor: (row) => row.stats,
    width: 220,
    sortable: false,
    renderCell: ({ row }) => <StatsBar data={row.stats} />,
  },
];

export function GroupedEmailTable() {
  const hexclaveAdminApp = useAdminApp();
  const projectId = useProjectId();
  const router = useRouter();
  const [emails, setEmails] = useState<AdminEmailOutbox[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch drafts and templates for display names
  const drafts = hexclaveAdminApp.useEmailDrafts();
  const templates = hexclaveAdminApp.useEmailTemplates();

  // Create maps for quick lookup
  const draftsMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const draft of drafts) {
      map.set(draft.id, draft.displayName);
    }
    return map;
  }, [drafts]);

  const templatesMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const template of templates) {
      map.set(template.id, template.displayName);
    }
    return map;
  }, [templates]);

  // Fetch all emails. Kept as a single bulk fetch (rather than
  // cursor-paginated via `dataSource`) because grouping-by-template needs
  // access to the full set — page boundaries would split groups.
  // TODO: if the outbox grows past a few thousand rows this will need a
  // server-side "group and count" endpoint instead.
  useEffect(() => {
    let cancelled = false;
    runAsynchronouslyWithAlert(async () => {
      setLoading(true);
      try {
        const result = await hexclaveAdminApp.listOutboxEmails();
        if (cancelled) return;
        setEmails(result.items);
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hexclaveAdminApp]);

  // Group emails by template/draft
  const groupedRows = useMemo(
    () => groupEmails(emails, draftsMap, templatesMap),
    [emails, draftsMap, templatesMap]
  );

  const [gridState, setGridState] = useDataGridUrlState(groupedEmailGridColumns, {
    paramPrefix: "sentgroup",
    initial: { sorting: [{ columnId: "recipientCount", direction: "desc" }] },
  });

  const gridData = useDataSource({
    data: groupedRows,
    columns: groupedEmailGridColumns,
    getRowId: (row) => row.groupKey,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    // Must stay client-mode: grouping needs the full data set in memory.
    paginationMode: "client",
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8">
        <Spinner size={16} />
        <Typography variant="secondary">Loading emails...</Typography>
      </div>
    );
  }

  return (
    <DataGrid
      columns={groupedEmailGridColumns}
      rows={gridData.rows}
      getRowId={(row) => row.groupKey}
      totalRowCount={gridData.totalRowCount}
      isLoading={gridData.isLoading}
      state={gridState}
      onChange={setGridState}
      fillHeight={false}
      onRowClick={(row, _rowId, _event) => {
        if (row.sourceType === "draft" && row.sourceId) {
          router.push(`email-drafts/${row.sourceId}?stage=sent`);
        } else if (row.sourceType === "template" && row.sourceId) {
          router.push(urlString`/projects/${projectId}/app-configuration/emails/templates/${row.sourceId}/sent`);
        } else {
          router.push(`email-sent/no-source`);
        }
      }}
    />
  );
}

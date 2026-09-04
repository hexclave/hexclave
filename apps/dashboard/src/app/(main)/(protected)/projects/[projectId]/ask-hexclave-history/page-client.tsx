"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignDialog,
  DesignInput,
  DesignSelectorDropdown,
} from "@/components/design-components";
import { Skeleton, Typography } from "@/components/ui";
import { sendInternalUserRequest } from "@/lib/hexclave-app-internals";
import {
  yupArray,
  yupMixed,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { use } from "@hexclave/shared/dist/utils/react";
import { useStackApp, useUser, type StackClientApp } from "@hexclave/next";
import {
  createDefaultDataGridState,
  DataGrid,
  useDataSource,
  type DataGridColumnDef,
} from "@hexclave/dashboard-ui-components";
import { ChatCircleTextIcon } from "@phosphor-icons/react";
import { Suspense, useCallback, useMemo, useState } from "react";
import { PageLayout } from "../page-layout";
import { useProjectId } from "../use-admin-app";

type AskTransport = "all" | "skill-ask" | "mcp-ask-hexclave";

type AskCall = {
  id: string,
  created_at: string,
  transport: Exclude<AskTransport, "all">,
  conversation_id: string,
  question: string,
  response: string,
  reason: string,
  user_prompt: string,
  context: string | null,
  user: string | null,
  project: string | null,
  request_ip: string | null,
  request_ip_source: string | null,
  user_agent: string | null,
  request_host: string | null,
  mcp_protocol_version: string | null,
  model_id: string,
  step_count: number,
  duration_ms: number,
  inner_tool_calls: Exclude<Json, null>,
};

type HistoryResponse = {
  calls: AskCall[],
  next_cursor: string | null,
};

type HistoryState =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error", message: string }
  | { status: "ok", data: HistoryResponse };

type Filters = {
  query: string,
  transport: AskTransport,
};

const DEFAULT_FILTERS: Filters = {
  query: "",
  transport: "all",
};

const CallSchema = yupObject({
  id: yupString().defined(),
  created_at: yupString().defined(),
  transport: yupString().oneOf(["skill-ask", "mcp-ask-hexclave"]).defined(),
  conversation_id: yupString().defined(),
  question: yupString().defined(),
  response: yupString().defined(),
  reason: yupString().defined(),
  user_prompt: yupString().defined(),
  context: yupString().nullable().defined(),
  user: yupString().nullable().defined(),
  project: yupString().nullable().defined(),
  request_ip: yupString().nullable().defined(),
  request_ip_source: yupString().nullable().defined(),
  user_agent: yupString().nullable().defined(),
  request_host: yupString().nullable().defined(),
  mcp_protocol_version: yupString().nullable().defined(),
  model_id: yupString().defined(),
  step_count: yupNumber().integer().defined(),
  duration_ms: yupNumber().integer().defined(),
  inner_tool_calls: yupMixed<Exclude<Json, null>>().defined(),
}).defined();

const HistoryResponseSchema = yupObject({
  calls: yupArray(CallSchema).defined(),
  next_cursor: yupString().nullable().defined(),
}).defined();

const columns: DataGridColumnDef<AskCall>[] = [
  {
    id: "created_at",
    header: "Time",
    accessor: (row) => new Date(row.created_at),
    type: "dateTime",
    width: 170,
  },
  {
    id: "transport",
    header: "Transport",
    accessor: "transport",
    width: 150,
    renderCell: ({ row }) => (
      <DesignBadge
        label={row.transport === "skill-ask" ? "Skill /ask" : "MCP"}
        color={row.transport === "skill-ask" ? "blue" : "purple"}
        size="sm"
      />
    ),
  },
  {
    id: "question",
    header: "Question",
    accessor: "question",
    type: "string",
    minWidth: 220,
    flex: 1,
  },
  {
    id: "response",
    header: "Response",
    accessor: "response",
    type: "string",
    minWidth: 260,
    flex: 1,
  },
  {
    id: "request_ip",
    header: "IP",
    accessor: (row) => row.request_ip ?? "—",
    type: "string",
    width: 140,
  },
  {
    id: "duration_ms",
    header: "Duration",
    accessor: "duration_ms",
    type: "number",
    width: 100,
    renderCell: ({ row }) => `${row.duration_ms.toLocaleString()} ms`,
  },
];

const sessionComponentKeys = new WeakMap<object, number>();
let nextSessionComponentKey = 0;

function getSessionComponentKey<T extends object>(session: T): number {
  const existing = sessionComponentKeys.get(session);
  if (existing != null) return existing;
  const created = nextSessionComponentKey++;
  sessionComponentKeys.set(session, created);
  return created;
}

async function fetchHistoryState(
  app: StackClientApp,
  filters: Filters,
  cursor: string | null = null,
): Promise<HistoryState> {
  const search = new URLSearchParams({
    query: filters.query,
    transport: filters.transport,
    limit: "100",
  });
  if (cursor != null) {
    search.set("cursor", cursor);
  }

  try {
    const response = await sendInternalUserRequest(
      app,
      `/internal/ask-hexclave-history?${search.toString()}`,
    );
    if (response.status === 403) return { status: "forbidden" };
    if (!response.ok) {
      return { status: "error", message: `Request failed (${response.status})` };
    }
    const data = await HistoryResponseSchema.validate(await response.json());
    return { status: "ok", data };
  } catch (error) {
    captureError("ask-hexclave-history", error);
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function fetchInitialHistoryState(app: StackClientApp, _session: object): Promise<HistoryState> {
  return fetchHistoryState(app, DEFAULT_FILTERS);
}

export default function PageClient() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <AuthenticatedPage />
    </Suspense>
  );
}

function AuthenticatedPage() {
  const projectId = useProjectId();
  const app = useStackApp();
  const user = useUser({ or: "redirect", projectIdMustMatch: "internal" });
  const initialStatePromise = useMemo(
    () => fetchInitialHistoryState(app, user._internalSession),
    [app, user._internalSession],
  );

  if (projectId !== "internal") {
    return null;
  }

  return (
    <PageLayout
      title="Ask Hexclave History"
      description="Questions and responses from the public skill endpoint and MCP tool. Internal only."
    >
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <HistoryContent
          key={getSessionComponentKey(user._internalSession)}
          app={app}
          initialStatePromise={initialStatePromise}
        />
      </Suspense>
    </PageLayout>
  );
}

function HistoryContent(props: {
  app: StackClientApp,
  initialStatePromise: Promise<HistoryState>,
}) {
  const initialState = use(props.initialStatePromise);
  const [query, setQuery] = useState("");
  const [transport, setTransport] = useState<AskTransport>("all");
  const [appliedFilters, setAppliedFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [state, setState] = useState<HistoryState>(initialState);
  const [selectedCall, setSelectedCall] = useState<AskCall | null>(null);

  const applyFilters = async () => {
    const filters = { query, transport };
    setAppliedFilters(filters);
    setState({ status: "loading" });
    setState(await fetchHistoryState(props.app, filters));
  };

  const loadMore = async () => {
    if (state.status !== "ok" || state.data.next_cursor == null) return;
    const nextState = await fetchHistoryState(props.app, appliedFilters, state.data.next_cursor);
    if (nextState.status !== "ok") {
      setState(nextState);
      return;
    }
    setState({
      status: "ok",
      data: {
        calls: [...state.data.calls, ...nextState.data.calls],
        next_cursor: nextState.data.next_cursor,
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <DesignCard className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Search</span>
            <DesignInput
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Question, response, conversation, IP, or user agent"
            />
          </label>
          <label className="flex min-w-44 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Transport</span>
            <DesignSelectorDropdown
              value={transport}
              onValueChange={(value) => {
                if (value === "all" || value === "skill-ask" || value === "mcp-ask-hexclave") {
                  setTransport(value);
                }
              }}
              options={[
                { value: "all", label: "All transports" },
                { value: "skill-ask", label: "Skill /ask" },
                { value: "mcp-ask-hexclave", label: "MCP ask_hexclave" },
              ]}
            />
          </label>
          <DesignButton variant="secondary" onClick={applyFilters}>
            Apply filters
          </DesignButton>
        </div>
      </DesignCard>

      {state.status === "forbidden" ? (
        <DesignAlert variant="error">
          Restricted to the platform team (owner team of the internal project).
        </DesignAlert>
      ) : null}
      {state.status === "error" ? (
        <DesignAlert variant="error">{state.message}</DesignAlert>
      ) : null}
      {state.status === "loading" ? <Skeleton className="h-96 w-full rounded-xl" /> : null}
      {state.status === "ok" ? (
        <HistoryTable
          calls={state.data.calls}
          hasMore={state.data.next_cursor != null}
          onLoadMore={loadMore}
          onSelectCall={setSelectedCall}
        />
      ) : null}

      <CallDetail
        call={selectedCall}
        onClose={() => setSelectedCall(null)}
      />
    </div>
  );
}

function HistoryTable(props: {
  calls: AskCall[],
  hasMore: boolean,
  onLoadMore: () => Promise<void>,
  onSelectCall: (call: AskCall) => void,
}) {
  const [gridState, setGridState] = useState(() => createDefaultDataGridState(columns));
  const getRowId = useCallback((row: AskCall) => row.id, []);
  const gridData = useDataSource({
    data: props.calls,
    columns,
    getRowId,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    paginationMode: "client",
  });

  return (
    <DesignCard
      title="Query history"
      subtitle={`${props.calls.length.toLocaleString()} loaded`}
      icon={ChatCircleTextIcon}
      contentClassName="p-3"
    >
      {props.calls.length === 0 ? (
        <div className="py-10 text-center">
          <Typography variant="secondary">No queries match these filters.</Typography>
        </div>
      ) : (
        <DataGrid
          columns={columns}
          rows={gridData.rows}
          getRowId={getRowId}
          totalRowCount={gridData.totalRowCount}
          isLoading={gridData.isLoading}
          state={gridState}
          onChange={setGridState}
          onRowClick={props.onSelectCall}
          maxHeight={600}
        />
      )}
      {props.hasMore ? (
        <div className="flex justify-center border-t pt-3">
          <DesignButton variant="secondary" size="sm" onClick={props.onLoadMore}>
            Load older queries
          </DesignButton>
        </div>
      ) : null}
    </DesignCard>
  );
}

function DetailField(props: { label: string, value: string | number | null }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{props.label}</div>
      <div className="hexclave-sensitive break-words text-sm">{props.value ?? "—"}</div>
    </div>
  );
}

function CallDetail(props: { call: AskCall | null, onClose: () => void }) {
  const call = props.call;
  return (
    <DesignDialog
      open={call != null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      size="4xl"
      icon={ChatCircleTextIcon}
      title="Ask Hexclave query"
      description={call == null ? undefined : new Date(call.created_at).toLocaleString()}
    >
      {call == null ? null : (
        <div className="flex flex-col gap-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <DetailField label="Transport" value={call.transport} />
            <DetailField label="Conversation" value={call.conversation_id} />
            <DetailField label="Model" value={call.model_id} />
            <DetailField label="Duration" value={`${call.duration_ms.toLocaleString()} ms`} />
            <DetailField label="Steps" value={call.step_count} />
            <DetailField label="Request IP" value={call.request_ip} />
            <DetailField label="IP source" value={call.request_ip_source} />
            <DetailField label="Request host" value={call.request_host} />
            <DetailField label="MCP protocol" value={call.mcp_protocol_version} />
            <DetailField label="User" value={call.user} />
          </div>
          <DetailField label="User agent" value={call.user_agent} />
          <section>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Project</div>
            <pre className="hexclave-sensitive whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{call.project ?? "—"}</pre>
          </section>
          <section>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Context</div>
            <pre className="hexclave-sensitive max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{call.context ?? "—"}</pre>
          </section>
          <section>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Original user prompt</div>
            <pre className="hexclave-sensitive max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{call.user_prompt}</pre>
          </section>
          <section>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Question</div>
            <pre className="hexclave-sensitive max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{call.question}</pre>
          </section>
          <section>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Response</div>
            <pre className="hexclave-sensitive max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{call.response}</pre>
          </section>
          <section>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Reason</div>
            <pre className="hexclave-sensitive whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{call.reason}</pre>
          </section>
          <section>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Tool calls</div>
            <pre className="hexclave-sensitive max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
              {JSON.stringify(call.inner_tool_calls, null, 2)}
            </pre>
          </section>
        </div>
      )}
    </DesignDialog>
  );
}

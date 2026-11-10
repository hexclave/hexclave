"use client";

import type { DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../components/design/cn";
import { DEFAULT_SQL, formatSqlCell, SQL_MAX_ROWS, SQL_TABLES, sqlResultSchema, validateConsoleSql, type SqlResult } from "../../../lib/sql-console";
import { PageHeader } from "../../shell/Page";
import { Icon } from "../../ui/icons";
import { Badge, Button, Callout, Card, CardHeader, EmptyState, Kbd } from "../../ui/primitives";
import { ConsoleTable, useConsoleTableState } from "../../ui/table";
import { CopyButton } from "../shared/detail";

/**
 * Same contract as components/SqlConsole.tsx (which keeps this helper private): validate locally
 * for fast feedback, let /api/sql re-validate and run it with the caller's SpacetimeDB identity,
 * and schema-check the response before rendering it.
 */
async function querySql(sql: string, signal: AbortSignal): Promise<SqlResult> {
  const response = await fetch("/api/sql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql: validateConsoleSql(sql) }),
    signal,
  });
  if (!response.ok) throw new Error(await response.text());
  const validated = sqlResultSchema.safeParse(await response.json());
  if (!validated.success) throw new Error("The server returned an invalid SQL result.");
  return validated.data;
}

/** SpacetimeDB accepts lowercase snake_case identifiers unquoted; anything else must be double-quoted. */
function sqlIdentifier(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

type ResultRow = { id: string, cells: unknown[] };

export function SqlConsolePage() {
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [submittedSql, setSubmittedSql] = useState<string | null>(null);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  // Caret to restore after an insert re-renders the controlled textarea (React moves it to the end).
  const pendingCaretRef = useRef<number | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    const editor = editorRef.current;
    if (caret == null || editor == null) return;
    pendingCaretRef.current = null;
    editor.focus();
    editor.setSelectionRange(caret, caret);
  }, [sql]);

  function insertAtCaret(text: string) {
    const editor = editorRef.current ?? throwErr("The SQL editor must be mounted while the schema browser is visible");
    pendingCaretRef.current = editor.selectionStart + text.length;
    setSql(sql.slice(0, editor.selectionStart) + text + sql.slice(editor.selectionEnd));
  }

  async function run() {
    if (controllerRef.current != null) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setError(null);
    setNotice(null);
    setResult(null);
    setSubmittedSql(sql);
    const outcome = await Result.fromPromise(querySql(sql, controller.signal));
    controllerRef.current = null;
    setRunning(false);
    if (controller.signal.aborted) {
      setNotice("Query cancelled.");
    } else if (outcome.status === "error") {
      // The server already appends the private-table hint (lib/server/sql-console.ts) when relevant.
      setError(outcome.error instanceof Error ? outcome.error.message : "Query failed.");
    } else {
      setResult(outcome.data);
    }
  }

  return (
    <>
      <PageHeader pageId="sql" meta={<Badge>Read-only</Badge>} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside aria-label="Schema" className="hx-scroll hidden w-64 shrink-0 overflow-y-auto border-r border-border bg-card/50 lg:block">
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <p className="text-xs font-semibold text-foreground">Schema</p>
            <span className="text-[11px] text-muted-foreground">{SQL_TABLES.length} views</span>
          </div>
          <div className="px-2 pb-4">
            {SQL_TABLES.map(table => (
              <SchemaTable
                key={table.name}
                name={table.name}
                label={table.label}
                disabled={running}
                onQuery={() => setSql(`SELECT *\nFROM ${table.name}\nLIMIT 100`)}
                onInsert={insertAtCaret}
              />
            ))}
          </div>
        </aside>

        <main className="hx-scroll min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1400px] space-y-4 px-6 py-5">
            <Card>
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
                <span className="text-xs font-medium text-foreground">Query</span>
                <a className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:transition-none" href="https://spacetimedb.com/docs/reference/sql/" target="_blank" rel="noreferrer">
                  SQL reference <Icon name="external" size="xs" />
                </a>
              </div>
              <textarea
                ref={editorRef}
                aria-label="SQL query"
                value={sql}
                onChange={event => setSql(event.target.value)}
                rows={9}
                spellCheck={false}
                disabled={running}
                onKeyDown={event => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    runAsynchronously(run());
                  }
                }}
                className="block w-full resize-y bg-card px-4 py-3 font-mono text-[12.5px] leading-6 text-foreground focus:outline-none disabled:opacity-60"
              />
              <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/40 px-4 py-2">
                <Button variant="primary" icon="play" loading={running} disabled={sql.trim() === ""} onClick={run} shortcut="⌘↵">Run</Button>
                {running && <Button onClick={() => controllerRef.current?.abort()}>Cancel</Button>}
                <span className="ml-auto text-[11px] text-muted-foreground">
                  Single SELECT · max {SQL_MAX_ROWS.toLocaleString()} rows (LIMIT added if omitted) · 15s timeout
                </span>
              </div>
            </Card>

            {error != null && <Callout title="Query failed"><p className="whitespace-pre-wrap font-mono text-[11.5px]">{error}</p></Callout>}
            {notice != null && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
            {result != null && <Results result={result} stale={submittedSql !== sql} />}
            {result == null && error == null && !running && (
              <Card>
                <EmptyState
                  icon="database"
                  title="Run a query to see results"
                  description={<>Pick a view from the schema, or write a SELECT and press <Kbd>⌘</Kbd> <Kbd>↵</Kbd>.</>}
                />
              </Card>
            )}
          </div>
        </main>
      </div>
    </>
  );
}

function Results({ result, stale }: { result: SqlResult, stale: boolean }) {
  const columns = useMemo<readonly DataGridColumnDef<ResultRow>[]>(() => result.columns.map((name, index) => ({
    id: String(index),
    header: name,
    accessor: row => formatSqlCell(row.cells[index]),
    width: 200,
    minWidth: 90,
    renderCell: ({ row }) => {
      const text = formatSqlCell(row.cells[index]);
      return <span className={cn("truncate font-mono text-[11.5px]", text === "NULL" ? "text-muted-foreground/60" : "text-foreground")}>{text}</span>;
    },
  })), [result.columns]);
  const rows = useMemo(() => result.rows.map((cells, index) => ({ id: String(index), cells })), [result.rows]);
  const [state, setState] = useConsoleTableState(columns, { resetKey: String(result.elapsedMs) });

  return (
    <Card>
      <CardHeader
        title={`${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? "" : "s"}`}
        description={`${Math.round(result.elapsedMs)} ms${stale ? " · results are from the previous query" : ""}`}
        actions={<CopyButton getText={() => JSON.stringify(result, null, 2)} label="Copy JSON" />}
      />
      <ConsoleTable
        columns={columns}
        rows={rows}
        getRowId={row => row.id}
        state={state}
        onStateChange={setState}
        searchPlaceholder="Filter results…"
        history={null}
        rowHeight={36}
        exportFilename="sql-results"
        emptyState={<EmptyState title="No rows matched" />}
      />
    </Card>
  );
}

type SchemaColumns = { status: "idle" } | { status: "loading" } | { status: "loaded", columns: string[] } | { status: "error", message: string };

/**
 * One view in the schema browser. Columns load lazily on first expand by selecting one row through
 * the same endpoint as the editor: SpacetimeDB returns the column schema even for an empty view, so
 * the list can't drift from the module.
 */
function SchemaTable({ name, label, disabled, onQuery, onInsert }: {
  name: string,
  label: string,
  disabled: boolean,
  onQuery: () => void,
  onInsert: (text: string) => void,
}) {
  const [open, setOpen] = useState(false);
  const [columns, setColumns] = useState<SchemaColumns>({ status: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  async function loadColumns() {
    const controller = new AbortController();
    controllerRef.current = controller;
    setColumns({ status: "loading" });
    const outcome = await Result.fromPromise(querySql(`SELECT * FROM ${name} LIMIT 1`, controller.signal));
    controllerRef.current = null;
    if (controller.signal.aborted) return;
    setColumns(outcome.status === "ok"
      ? { status: "loaded", columns: outcome.data.columns }
      : { status: "error", message: outcome.error instanceof Error ? outcome.error.message : "Could not load columns." });
  }

  return (
    <div>
      <div className="group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-muted hover:transition-none">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && (columns.status === "idle" || columns.status === "error")) runAsynchronously(loadColumns());
          }}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size="xs" className="text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-[11.5px] text-foreground">{name}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{label}</span>
          </span>
        </button>
        <Button size="xs" variant="ghost" disabled={disabled} onClick={onQuery} title={`SELECT * FROM ${name}`}>Query</Button>
      </div>
      {open && (
        <div className="mb-1 ml-5 border-l border-border pl-2">
          {columns.status === "loading" && <p className="px-2 py-1 text-[11px] text-muted-foreground">Loading columns…</p>}
          {columns.status === "error" && <p role="alert" className="px-2 py-1 text-[11px] text-red-600 dark:text-red-400">{columns.message}</p>}
          {columns.status === "loaded" && columns.columns.map(column => (
            <button
              key={column}
              type="button"
              disabled={disabled}
              title="Insert at cursor"
              onClick={() => onInsert(sqlIdentifier(column))}
              className="block w-full truncate rounded px-2 py-0.5 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground hover:transition-none disabled:opacity-50"
            >
              {column}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { createDefaultDataGridState, DataGrid, useDataSource, type DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { runAsynchronously, runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SQL, formatSqlCell, SQL_MAX_ROWS, SQL_TABLES, sqlResultSchema, validateConsoleSql, type SqlResult } from "../lib/sql-console";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { Alert, Button, cn, EmptyState, FieldLabel, Panel, PanelRow, Textarea } from "./design";

async function querySql(sql: string, signal: AbortSignal): Promise<SqlResult> {
  const validatedSql = validateConsoleSql(sql);
  const response = await fetch("/api/sql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql: validatedSql }),
    signal,
  });
  if (!response.ok) throw new Error(await response.text());
  const parsed: unknown = await response.json();
  const validated = sqlResultSchema.safeParse(parsed);
  if (!validated.success) throw new Error("The server returned an invalid SQL result.");
  return validated.data;
}

type ResultRow = { id: string, cells: unknown[] };

function SqlResults({ result }: { result: SqlResult }) {
  const columns = useMemo<ReadonlyArray<DataGridColumnDef<ResultRow>>>(() =>
    result.columns.map((name, index) => ({
      id: String(index),
      header: name,
      accessor: row => formatSqlCell(row.cells[index]),
      width: 220,
      minWidth: 100,
      cellOverflow: "wrap",
    })), [result.columns]);
  const rows = useMemo(() => result.rows.map((cells, index) => ({ id: String(index), cells })), [result.rows]);
  const [state, setState] = useState(() => createDefaultDataGridState(columns));
  const data = useDataSource({
    data: rows, columns, getRowId: row => row.id,
    sorting: state.sorting, quickSearch: state.quickSearch, pagination: state.pagination, paginationMode: "client",
  });
  return <DataGrid
    columns={columns} rows={data.rows} getRowId={row => row.id} totalRowCount={data.totalRowCount}
    state={state} onChange={setState} selectionMode="none"
    fillHeight={false} maxHeight={600} rowHeight={48} headerHeight={36}
    exportFilename="sql-results" className="internal-data-grid"
  />;
}

type SchemaColumns =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded", columns: string[] }
  | { status: "error", message: string };

/** Identifiers SpacetimeDB accepts unquoted; anything else (eg. camelCase) must be double-quoted. */
function sqlIdentifier(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/**
 * One relation in the schema browser. Columns load lazily on first expand by selecting a single
 * row through the same endpoint the editor uses — SpacetimeDB returns the column schema even when
 * the view is empty, so this stays accurate without hardcoding column lists.
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
      <div className="group flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-foreground/[0.04] hover:transition-none"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && (columns.status === "idle" || columns.status === "error")) runAsynchronously(loadColumns());
          }}
        >
          <span className={cn("text-[8px] text-muted-foreground transition-transform", open && "rotate-90")}>▶</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-[11px] text-foreground">{name}</span>
            <span className="block truncate text-[10px] text-muted-foreground">{label}</span>
          </span>
        </button>
        <Button size="xs" variant="ghost" disabled={disabled} onClick={onQuery} title={`SELECT * FROM ${name}`}>Query</Button>
      </div>
      {open && (
        <div className="pb-2 pl-7 pr-2">
          {columns.status === "loading" && <p className="py-1 text-[10px] text-muted-foreground">Loading columns…</p>}
          {columns.status === "error" && <p role="alert" className="py-1 text-[10px] text-red-600 dark:text-red-400">{columns.message}</p>}
          {columns.status === "loaded" && columns.columns.map(column => (
            <button
              key={column}
              type="button"
              disabled={disabled}
              title="Insert at cursor"
              className="block w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-[10px] text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground hover:transition-none disabled:opacity-50"
              onClick={() => onInsert(sqlIdentifier(column))}
            >
              {column}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SqlConsole() {
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [submittedSql, setSubmittedSql] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  // Caret position to restore after an insert re-renders the controlled textarea (React resets it to the end).
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
    const editor = editorRef.current ?? throwErr("SQL editor ref must be attached while the console is mounted");
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    pendingCaretRef.current = start + text.length;
    setSql(sql.slice(0, start) + text + sql.slice(end));
  }

  async function runQuery() {
    if (controllerRef.current != null) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    setNotice(null);
    setResult(null);
    setSubmittedSql(sql);
    const outcome = await Result.fromPromise(querySql(sql, controller.signal));
    controllerRef.current = null;
    setLoading(false);
    if (controller.signal.aborted) {
      setNotice("Query cancelled.");
    } else if (outcome.status === "error") {
      setError(outcome.error instanceof Error ? outcome.error.message : "Query failed. Try again.");
    } else {
      setResult(outcome.data);
    }
  }

  return <div className="grid grid-cols-[15rem_minmax(0,1fr)] items-start gap-4">
    <Panel className="sticky top-0">
      <PanelRow className="justify-between">
        <FieldLabel>Schema</FieldLabel>
        <span className="text-[10px] text-muted-foreground">Click a column to insert</span>
      </PanelRow>
      <div className="py-1">
        {SQL_TABLES.map(table => (
          <SchemaTable
            key={table.name}
            name={table.name}
            label={table.label}
            disabled={loading}
            onQuery={() => setSql(`SELECT *\nFROM ${table.name}\nLIMIT 100`)}
            onInsert={insertAtCaret}
          />
        ))}
      </div>
    </Panel>

    <div className="min-w-0 space-y-4">
      <Panel>
        <PanelRow className="justify-between">
          <label htmlFor="sql-query"><FieldLabel>SQL query</FieldLabel></label>
          <a className="text-[10px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline hover:transition-none" href="https://spacetimedb.com/docs/reference/sql/" target="_blank" rel="noreferrer">SQL reference ↗</a>
        </PanelRow>
        <div className="p-3">
          <Textarea id="sql-query" ref={editorRef} value={sql} onChange={event => setSql(event.target.value)}
            rows={10} spellCheck={false} className="font-mono text-xs leading-6" disabled={loading}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                runAsynchronously(runQuery());
              }
            }} />
        </div>
        <PanelRow className="gap-x-2">
          <Button variant="default" disabled={loading || sql.trim() === ""} onClick={() => runAsynchronously(runQuery())}>
            {loading ? "Running…" : "Run query"}
          </Button>
          {loading && <Button onClick={() => controllerRef.current?.abort()}>Cancel</Button>}
          <span className="ml-auto text-[10px] text-muted-foreground">⌘/Ctrl + Enter · Read-only · Max {SQL_MAX_ROWS.toLocaleString()} rows (LIMIT added if omitted) · 15s timeout</span>
        </PanelRow>
      </Panel>

      {error != null && <Alert><p role="alert">{error}</p></Alert>}
      {notice != null && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
      {result != null && <section aria-label="Query results" className="space-y-2">
        <div className="flex items-center gap-3">
          <p role="status" className="text-xs tabular-nums text-muted-foreground">{result.rows.length.toLocaleString()} rows · {Math.round(result.elapsedMs)} ms</p>
          <Button size="xs" onClick={() => runAsynchronouslyWithAlert(navigator.clipboard.writeText(JSON.stringify(result, null, 2)))}>Copy JSON</Button>
          {sql !== submittedSql && <span className="text-xs text-muted-foreground">Results from the previous query</span>}
        </div>
        {result.rows.length === 0 ? <Panel><EmptyState>No rows matched.</EmptyState></Panel> : <SqlResults result={result} />}
      </section>}
    </div>
  </div>;
}

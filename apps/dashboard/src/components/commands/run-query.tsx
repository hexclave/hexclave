"use client";

import {
  FolderWithId,
  isDateValue,
  isJsonValue,
  JsonValue,
  parseClickHouseDate,
  RowData,
  RowDetailDialog,
  VirtualizedFlatTable
} from "@/app/(main)/(protected)/projects/[projectId]/analytics/shared";
import { useAdminAppIfExists, useServerAppIfExists } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { useRouter } from "@/components/router";
import { Button } from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SimpleTooltip } from "@/components/ui/simple-tooltip";
import { Textarea } from "@/components/ui/textarea";
import { useDebouncedAction } from "@/hooks/use-debounced-action";
import { useFromNow } from "@/hooks/use-from-now";
import { useUpdateConfig } from "@/components/config-update";
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  FloppyDiskIcon,
  PlayIcon,
  PlusIcon,
  SpinnerGapIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { memo, useCallback, useMemo, useState } from "react";
import { CmdKPreviewProps } from "../cmdk-commands";

const DEBOUNCE_MS = 1000;

// Component for displaying dates with relative time (specific to command palette)
function DateValue({ value }: { value: string }) {
  const date = parseClickHouseDate(value);
  const fromNow = useFromNow(date);

  return (
    <SimpleTooltip tooltip={date.toLocaleString()}>
      <span className="cursor-help">{fromNow}</span>
    </SimpleTooltip>
  );
}

// Format a cell value for display with relative dates (specific to command palette)
function CellValueWithRelativeDates({ value, truncate = true }: { value: unknown, truncate?: boolean }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/50">—</span>;
  }

  if (isDateValue(value)) {
    return <DateValue value={value} />;
  }

  if (isJsonValue(value)) {
    return <JsonValue value={value} truncate={truncate} />;
  }

  const str = String(value);
  if (truncate && str.length > 100) {
    return (
      <SimpleTooltip tooltip={str}>
        <span className="cursor-help">{str.slice(0, 97)}...</span>
      </SimpleTooltip>
    );
  }

  return <span>{str}</span>;
}

// Error display component for this file (uses relative dates display)
function ErrorDisplay({ error, onRetry }: { error: unknown, onRetry: () => void }) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center">
        <WarningCircleIcon className="h-7 w-7 text-red-500" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">Query Error</h3>
        <p className="text-xs text-muted-foreground max-w-md break-words font-mono whitespace-pre-wrap">
          {message}
        </p>
      </div>
      <button
        onClick={onRetry}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-foreground/[0.06] hover:bg-foreground/[0.1] transition-colors hover:transition-none"
      >
        <ArrowClockwiseIcon className="h-3 w-3" />
        Retry
      </button>
    </div>
  );
}

// Empty state component
function EmptyQueryState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-6 text-center h-full">
      <div className="w-14 h-14 rounded-2xl bg-amber-500/10 flex items-center justify-center">
        <PlayIcon className="h-7 w-7 text-amber-500" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">Run Query</h3>
        <p className="text-xs text-muted-foreground max-w-xs">
          Enter a ClickHouse SQL query above to see results here.
        </p>
      </div>
      <div className="mt-2 p-3 rounded-lg bg-muted/30 border border-border/50 max-w-sm">
        <p className="text-[10px] text-muted-foreground/70 font-mono">
          SELECT * FROM default.events<br />
          ORDER BY event_at DESC<br />
          LIMIT 100
        </p>
      </div>
    </div>
  );
}

// No results state
function NoResultsState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-6 text-center h-full">
      <div className="w-12 h-12 rounded-xl bg-muted/50 flex items-center justify-center">
        <CheckCircleIcon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <h3 className="text-sm font-medium text-foreground mb-0.5">No Results</h3>
        <p className="text-xs text-muted-foreground">
          Query executed successfully but returned no rows.
        </p>
      </div>
    </div>
  );
}

// Loading state component
function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-6 h-full">
      <SpinnerGapIcon className="h-6 w-6 text-amber-500 animate-spin" />
      <p className="text-xs text-muted-foreground">Running query...</p>
    </div>
  );
}

// Save query dialog for the command palette
// Note: This component requires adminApp to be non-null to avoid conditional hook calls
function SaveQueryDialog({
  open,
  onOpenChange,
  adminApp,
  sqlQuery,
}: {
  open: boolean,
  onOpenChange: (open: boolean) => void,
  adminApp: NonNullable<ReturnType<typeof useAdminAppIfExists>>,
  sqlQuery: string,
}) {
  const updateConfig = useUpdateConfig();
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  const config = adminApp.useProject().useConfig();
  const folders = useMemo((): FolderWithId[] => {
    const queryFolders = config.warehouse.queryFolders;

    return Object.entries(queryFolders)
      .map(([id, folder]) => ({
        id,
        displayName: folder.displayName,
        sortOrder: folder.sortOrder,
        queries: Object.entries(folder.queries).map(([queryId, q]) => ({
          id: queryId,
          displayName: q.displayName,
          sqlQuery: q.sqlQuery,
          description: q.description,
        })),
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [config]);

  const handleSave = async () => {
    if (!displayName.trim() || !sqlQuery.trim() || !selectedFolderId) return;
    setLoading(true);
    try {
      const queryId = generateSecureRandomString();
      await updateConfig({
        adminApp,
        configUpdate: {
          [`warehouse.queryFolders.${selectedFolderId}.queries.${queryId}`]: {
            displayName: displayName.trim(),
            sqlQuery,
            ...(description.trim() ? { description: description.trim() } : {}),
          },
        },
        pushable: false,
      });
      setDisplayName("");
      setDescription("");
      setSelectedFolderId("");
      onOpenChange(false);
      // Navigate to the queries page after saving
      router.push(`/projects/${encodeURIComponent(adminApp.projectId)}/warehouse/queries`);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    setCreatingFolder(true);
    try {
      const folderId = generateSecureRandomString();
      await updateConfig({
        adminApp,
        configUpdate: {
          [`warehouse.queryFolders.${folderId}`]: {
            displayName: newFolderName.trim(),
            sortOrder: folders.length,
            queries: {},
          },
        },
        pushable: false,
      });
      // Auto-select the newly created folder
      setSelectedFolderId(folderId);
      setNewFolderName("");
      setShowCreateFolder(false);
    } finally {
      setCreatingFolder(false);
    }
  };

  const canSave = displayName.trim() && selectedFolderId && sqlQuery.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save Query</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="query-name">Query Name</Label>
              <Input
                id="query-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="My Query"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="query-folder">Folder</Label>
                {!showCreateFolder && (
                  <button
                    onClick={() => setShowCreateFolder(true)}
                    className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-400 transition-colors hover:transition-none"
                  >
                    <PlusIcon className="h-3 w-3" />
                    New folder
                  </button>
                )}
              </div>
              {showCreateFolder ? (
                <div className="flex gap-2">
                  <Input
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="Folder name"
                    className="flex-1"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        runAsynchronouslyWithAlert(handleCreateFolder);
                      } else if (e.key === "Escape") {
                        setShowCreateFolder(false);
                        setNewFolderName("");
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={() => runAsynchronouslyWithAlert(handleCreateFolder)}
                    disabled={!newFolderName.trim() || creatingFolder}
                  >
                    {creatingFolder ? "..." : "Create"}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setShowCreateFolder(false);
                      setNewFolderName("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <select
                  id="query-folder"
                  className="w-full h-10 px-3 border rounded-md text-sm bg-background"
                  value={selectedFolderId}
                  onChange={(e) => {
                    if (e.target.value === "__create_new__") {
                      setShowCreateFolder(true);
                    } else {
                      setSelectedFolderId(e.target.value);
                    }
                  }}
                >
                  <option value="">Select a folder...</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.displayName}
                    </option>
                  ))}
                  <option value="__create_new__">Create new...</option>
                </select>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="query-description">Description (optional)</Label>
              <Textarea
                id="query-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this query does..."
                rows={2}
              />
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => runAsynchronouslyWithAlert(handleSave)} disabled={!canSave || loading}>
            {loading ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Main Run Query Preview Component - wrapper that resets state on query change
export function RunQueryPreview({ query, ...rest }: CmdKPreviewProps) {
  return <RunQueryPreviewInner key={query} query={query} {...rest} />;
}

// Inner component that handles the actual query execution
const RunQueryPreviewInner = memo(function RunQueryPreviewInner({
  query,
}: CmdKPreviewProps) {
  const adminApp = useAdminAppIfExists();
  const serverApp = useServerAppIfExists();
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<RowData[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [hasQueried, setHasQueried] = useState(false);
  const [selectedRow, setSelectedRow] = useState<RowData | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);

  const trimmedQuery = query.trim();

  const runQuery = useCallback(async () => {
    if (!serverApp) {
      setError(new Error("Not connected to a project"));
      return;
    }

    if (!trimmedQuery) {
      return;
    }

    setLoading(true);
    setError(null);
    setHasQueried(true);

    try {
      const response = await serverApp.queryAnalytics({
        query: trimmedQuery,
        include_all_branches: false,
        timeout_ms: 30000,
      });

      const newRows = response.result as RowData[];
      const newColumns = newRows.length > 0 ? Object.keys(newRows[0]) : [];

      setColumns(newColumns);
      setRows(newRows);
    } catch (e: unknown) {
      setError(e);
      setColumns([]);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [serverApp, trimmedQuery]);

  // Run query on mount with debounce
  useDebouncedAction({
    action: runQuery,
    delayMs: DEBOUNCE_MS,
    skip: !trimmedQuery,
  });

  const handleRowClick = (row: RowData) => {
    setSelectedRow(row);
    setDetailDialogOpen(true);
  };

  const handleRetry = useCallback(() => {
    runAsynchronouslyWithAlert(runQuery);
  }, [runQuery]);

  // No admin app available
  if (!adminApp) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-6 text-center h-full">
        <div className="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
          <WarningCircleIcon className="h-5 w-5 text-amber-500" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-foreground mb-0.5">No Project Selected</h3>
          <p className="text-xs text-muted-foreground">
            Select a project to run queries.
          </p>
        </div>
      </div>
    );
  }

  // Loading state - show during debounce (before query starts) or while query is running
  // If we have a query but haven't queried yet, we're in the debounce period
  const isWaitingToRun = trimmedQuery && !hasQueried;
  if (loading || isWaitingToRun) {
    return <LoadingState />;
  }

  // Error state
  if (error) {
    return <ErrorDisplay error={error} onRetry={handleRetry} />;
  }

  // Empty state - no query provided
  if (!trimmedQuery) {
    return <EmptyQueryState />;
  }

  // No results
  if (rows.length === 0) {
    return <NoResultsState />;
  }

  // Results table
  return (
    <div className="flex flex-col h-full w-full">
      {/* Header with row count and save button */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 shrink-0">
        <span className="text-[10px] text-muted-foreground">
          {rows.length.toLocaleString()} row{rows.length !== 1 ? "s" : ""}
        </span>
        <button
          onClick={() => setSaveDialogOpen(true)}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors hover:transition-none"
        >
          <FloppyDiskIcon className="h-3 w-3" />
          Save Query
        </button>
      </div>

      {/* Table */}
      <VirtualizedFlatTable
        columns={columns}
        rows={rows}
        onRowClick={handleRowClick}
      />

      <RowDetailDialog
        row={selectedRow}
        columns={columns}
        open={detailDialogOpen}
        onOpenChange={setDetailDialogOpen}
      />

      <SaveQueryDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        adminApp={adminApp}
        sqlQuery={trimmedQuery}
      />
    </div>
  );
});

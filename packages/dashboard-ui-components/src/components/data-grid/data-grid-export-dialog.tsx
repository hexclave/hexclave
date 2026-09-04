"use client";

import { DownloadSimpleIcon } from "@phosphor-icons/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DesignButton } from "../button";
import { DesignDialog } from "../dialog";
import { formatGridDate, resolveColumnValue } from "./state";
import type {
  DataGridColumnDef,
  DataGridCellValue,
  DataGridExportField,
  DataGridExportFormat,
  DataGridExportOptions,
  DataGridExportScope,
} from "./types";

type ExportProgress = {
  phase: "idle" | "fetching" | "generating" | "complete";
  fetched: number;
};

type ExportCellValue = string | number | boolean | null | undefined;
type ExportTable = {
  csvHeaders: string[];
  jsonKeys: string[];
  rows: ExportCellValue[][];
};

type DataGridExportDialogProps<TRow> = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: readonly TRow[];
  columns: readonly DataGridColumnDef<TRow>[];
  exportFilename: string;
  exportOptions?: DataGridExportOptions<TRow>;
};

const idleExportProgress: ExportProgress = {
  phase: "idle",
  fetched: 0,
};
const exportCompletionDisplayMs = 800;

export function DataGridExportDialog<TRow>({
  open,
  onOpenChange,
  rows,
  columns,
  exportFilename,
  exportOptions,
}: DataGridExportDialogProps<TRow>) {
  const hasServerExport = exportOptions?.fetchRows != null;
  const resolvedFields = useMemo(
    () => exportOptions?.fields ?? buildColumnExportFields(columns),
    [exportOptions?.fields, columns],
  );
  const [format, setFormat] = useState<DataGridExportFormat>("csv");
  const [scope, setScope] = useState<DataGridExportScope>(exportOptions?.defaultScope ?? "all");
  const [fields, setFields] = useState<readonly DataGridExportField<TRow>[]>(resolvedFields);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress>(idleExportProgress);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isExporting) {
      setFields(resolvedFields);
    }
  }, [isExporting, resolvedFields]);

  // Reset the scope to its default each time the dialog opens. The dialog stays
  // mounted between opens, so without this the scope would retain whatever the
  // user last picked instead of honoring `defaultScope` on every open. We track
  // the previous `open` value with a ref so the reset only fires on a genuine
  // closed->open transition -- not on every render that flips other state (e.g.
  // `isExporting` going false after a failed/empty export would otherwise wipe
  // the user's current selection while the dialog is still open).
  const defaultScope = exportOptions?.defaultScope ?? "all";
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setScope(defaultScope);
    }
    wasOpenRef.current = open;
  }, [open, defaultScope]);

  const entityName = exportOptions?.entityName ?? "row";
  const entityNamePlural = exportOptions?.entityNamePlural ?? "rows";
  const filenamePrefix = exportOptions?.filenamePrefix ?? exportFilename;
  const title = exportOptions?.title ?? "Export data";
  const description = exportOptions?.description ?? (
    hasServerExport
      ? "Configure and download data from this table"
      : "Configure and download the rows currently loaded in this table"
  );
  const allScopeLabel = exportOptions?.allScopeLabel ?? `Export all ${entityNamePlural} in the project`;
  const filteredScopeLabel = exportOptions?.filteredScopeLabel ?? `Export only filtered/searched ${entityNamePlural}`;
  const progressSubjectLabel = exportOptions?.progressSubjectLabel ?? entityNamePlural;
  const progressTitle = progress.phase === "complete" ? "Export complete" : `Exporting ${progressSubjectLabel}`;
  const fetchExportRows = exportOptions?.fetchRows;

  const closeDialog = useCallback(() => {
    onOpenChange(false);
    setErrorMessage(null);
  }, [onOpenChange]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (isExporting && !nextOpen) {
      return;
    }
    if (nextOpen) {
      onOpenChange(true);
    } else {
      closeDialog();
    }
  }, [closeDialog, isExporting, onOpenChange]);

  const toggleField = useCallback((key: string) => {
    setFields((prev) =>
      prev.map((field) =>
        field.key === key ? { ...field, enabled: !field.enabled } : field
      )
    );
  }, []);

  const selectAllFields = useCallback(() => {
    setFields((prev) => prev.map((field) => ({ ...field, enabled: true })));
  }, []);

  const deselectAllFields = useCallback(() => {
    setFields((prev) => prev.map((field) => ({ ...field, enabled: false })));
  }, []);

  const fetchRows = useCallback(async () => {
    if (fetchExportRows != null) {
      return await fetchExportRows({
        scope,
        onProgress: (fetched) => setProgress({ phase: "fetching", fetched }),
      });
    }

    setProgress({ phase: "fetching", fetched: rows.length });
    return rows;
  }, [fetchExportRows, rows, scope]);

  const handleExport = async () => {
    const enabledFields = fields.filter((field) => field.enabled);
    if (enabledFields.length === 0) {
      setErrorMessage("Select at least one field to export.");
      return;
    }

    setErrorMessage(null);
    setIsExporting(true);
    setProgress({ phase: "fetching", fetched: 0 });
    try {
      const exportRows = await fetchRows();

      if (exportRows.length === 0) {
        setErrorMessage(
          exportOptions?.emptyExportDescription
          ?? `There are no ${entityNamePlural} to export.`,
        );
        setIsExporting(false);
        setProgress(idleExportProgress);
        return;
      }

      setProgress({ phase: "generating", fetched: exportRows.length });
      const transformedData = buildExportTable(exportRows, enabledFields);

      if (format === "csv") {
        exportToCsv(transformedData, filenamePrefix);
      } else {
        exportToJson(transformedData, filenamePrefix);
      }

      setProgress({ phase: "complete", fetched: exportRows.length });
      await new Promise<void>((resolve) => setTimeout(resolve, exportCompletionDisplayMs));
      closeDialog();
    } catch {
      setErrorMessage("Something went wrong while exporting. Please try again.");
    } finally {
      setIsExporting(false);
      setProgress(idleExportProgress);
    }
  };

  return (
    <DesignDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={isExporting ? progressTitle : title}
      description={isExporting ? `Preparing export for ${progressSubjectLabel}.` : description}
      size="2xl"
      variant="plain"
      headerClassName={isExporting ? "sr-only" : undefined}
      hideTopCloseButton={isExporting}
    >
      {isExporting ? (
        <ExportProgressContent
          progress={progress}
          format={format}
          subjectLabel={progressSubjectLabel}
        />
      ) : (
        <div className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor={`${filenamePrefix}-export-format`}>
              Export Format
            </label>
            <select
              id={`${filenamePrefix}-export-format`}
              value={format}
              onChange={(event) => setFormat(event.currentTarget.value === "json" ? "json" : "csv")}
              className="h-9 w-full rounded-md border border-input bg-white px-3 text-sm dark:bg-background"
            >
              <option value="csv">CSV (Comma-separated values)</option>
              <option value="json">JSON (JavaScript Object Notation)</option>
            </select>
          </div>

          {hasServerExport ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Export Scope</legend>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${filenamePrefix}-export-scope`}
                  value="all"
                  checked={scope === "all"}
                  onChange={() => setScope("all")}
                />
                <span>{allScopeLabel}</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${filenamePrefix}-export-scope`}
                  value="filtered"
                  checked={scope === "filtered"}
                  onChange={() => setScope("filtered")}
                />
                <span>{filteredScopeLabel}</span>
              </label>
            </fieldset>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium">Fields to Export</label>
              <div className="flex gap-2">
                <DesignButton type="button" variant="ghost" size="sm" onClick={selectAllFields} className="h-7 text-xs">
                  Select All
                </DesignButton>
                <DesignButton type="button" variant="ghost" size="sm" onClick={deselectAllFields} className="h-7 text-xs">
                  Deselect All
                </DesignButton>
              </div>
            </div>
            <div className="grid max-h-[300px] grid-cols-1 gap-3 overflow-y-auto rounded-lg border border-border p-4 sm:grid-cols-2">
              {fields.map((field) => (
                <label key={field.key} className="flex cursor-pointer items-center gap-2 text-sm font-normal">
                  <input
                    type="checkbox"
                    checked={field.enabled}
                    onChange={() => toggleField(field.key)}
                  />
                  <span>{field.label}</span>
                </label>
              ))}
            </div>
          </div>

          {errorMessage != null ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <div className="font-medium">{exportOptions?.emptyExportTitle ?? "Export unavailable"}</div>
              <div>{errorMessage}</div>
            </div>
          ) : null}

          <div className="flex justify-end gap-3 pt-2">
            <DesignButton variant="outline" onClick={closeDialog}>
              Cancel
            </DesignButton>
            <DesignButton onClick={handleExport}>
              <DownloadSimpleIcon className="mr-2 h-4 w-4" />
              Export {titleCase(entityNamePlural)}
            </DesignButton>
          </div>
        </div>
      )}
    </DesignDialog>
  );
}

function ExportProgressContent(props: {
  progress: ExportProgress;
  format: DataGridExportFormat;
  subjectLabel: string;
}) {
  const { progress, format, subjectLabel } = props;
  const fileLabel = format.toUpperCase();
  const isComplete = progress.phase === "complete";
  const title = isComplete ? "Export complete" : `Exporting ${subjectLabel}`;
  const description = isComplete
    ? `Your ${fileLabel} is ready and the download should begin automatically.`
    : `Your ${fileLabel} is being prepared from matching ${subjectLabel}.`;
  const statusLabel = progress.phase === "complete"
    ? "Download ready"
    : progress.phase === "generating"
      ? `Preparing ${fileLabel}`
      : `Fetching ${subjectLabel}`;
  const countLabel = `${progress.fetched.toLocaleString()} ${isComplete ? "exported" : "fetched"}`;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold leading-snug">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      <div className="rounded-xl border border-border bg-muted/35 p-4">
        <div className="mb-3 flex items-center justify-between gap-4 text-sm">
          <span className="font-medium text-foreground">{statusLabel}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {countLabel}
          </span>
        </div>
        <div className="relative h-2 overflow-hidden rounded-full bg-foreground/10">
          {isComplete ? (
            <div className="h-full w-full rounded-full bg-emerald-500/80" />
          ) : (
            <div className="data-grid-export-progress-shimmer absolute inset-y-0 left-0 w-2/5 rounded-full bg-gradient-to-r from-transparent via-foreground/65 to-transparent" />
          )}
        </div>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        Do not reload this page until the export finishes. The download will start automatically.
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <DesignButton variant="outline" disabled>
          Cancel
        </DesignButton>
      </div>
    </div>
  );
}

function buildColumnExportFields<TRow>(
  columns: readonly DataGridColumnDef<TRow>[],
): readonly DataGridExportField<TRow>[] {
  const fields: DataGridExportField<TRow>[] = [];

  for (const column of columns) {
    const label = typeof column.header === "string" ? column.header.trim() : column.id;
    if (label.length === 0) {
      continue;
    }

    fields.push({
      key: column.id,
      label,
      enabled: true,
      getValue: (row) => formatColumnExportValue(column, row),
    });
  }

  return fields;
}

function formatColumnExportValue<TRow, TValue extends DataGridCellValue = DataGridCellValue>(
  column: DataGridColumnDef<TRow, TValue>,
  row: TRow,
): DataGridCellValue {
  const value = resolveColumnValue(column, row);
  if (column.formatValue != null) {
    return column.formatValue(value, row);
  }
  if (column.type === "date" || column.type === "dateTime") {
    return formatGridDate(value, "absolute", {
      parseValue: column.parseValue,
      dateFormat: column.dateFormat,
    }).display ?? "";
  }
  return value;
}

function buildExportTable<TRow>(
  rows: readonly TRow[],
  enabledFields: readonly DataGridExportField<TRow>[],
): ExportTable {
  return {
    csvHeaders: enabledFields.map((field) => field.label),
    jsonKeys: buildJsonKeys(enabledFields),
    rows: rows.map((row) => enabledFields.map((field) => toExportCellValue(field.getValue(row)))),
  };
}

function buildJsonKeys<TRow>(
  fields: readonly DataGridExportField<TRow>[],
): string[] {
  const labelCounts = new Map<string, number>();
  for (const field of fields) {
    labelCounts.set(field.label, (labelCounts.get(field.label) ?? 0) + 1);
  }

  const usedKeys = new Map<string, true>();
  const keys: string[] = [];
  for (const field of fields) {
    const baseKey = labelCounts.get(field.label) === 1 ? field.label : `${field.label} (${field.key})`;
    let key = baseKey;
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${baseKey} ${suffix}`;
      suffix++;
    }
    usedKeys.set(key, true);
    keys.push(key);
  }

  return keys;
}

function toExportCellValue(value: unknown): ExportCellValue {
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function exportToCsv(data: ExportTable, filenamePrefix: string) {
  const csvContent = "\uFEFF" + [
    data.csvHeaders.map(escapeCsvCell).join(","),
    ...data.rows.map((row) => row.map(escapeCsvCell).join(",")),
  ].join("\n");
  downloadFile(csvContent, `${buildExportFilename(filenamePrefix)}.csv`, "text/csv;charset=utf-8;");
}

function escapeCsvCell(value: ExportCellValue): string {
  const rawText = String(value ?? "");
  const text = typeof value === "string" && /^[=+\-@\t\r]/.test(rawText.trimStart()) ? `'${rawText}` : rawText;
  if (text.includes(",") || text.includes('"') || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function exportToJson(data: ExportTable, filenamePrefix: string) {
  const rows = data.rows.map((row) => {
    const jsonRow: Record<string, ExportCellValue> = {};
    for (let i = 0; i < data.jsonKeys.length; i++) {
      jsonRow[data.jsonKeys[i]] = row[i] ?? "";
    }
    return jsonRow;
  });
  const jsonString = JSON.stringify(rows, null, 2);
  downloadFile(jsonString, `${buildExportFilename(filenamePrefix)}.json`, "application/json");
}

function downloadFile(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

function buildExportFilename(prefix: string) {
  return `${prefix}-${new Date().toISOString().split("T")[0]}`;
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

"use client";

import { DesignButton, DesignSelectorDropdown } from "@/components/design-components";
import { Card, Checkbox, SimpleTooltip, Typography } from "@/components/ui";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { DataSourceCatalogJson, DataSourceCatalogTableJson, DataSourceStreamConfig } from "@hexclave/shared/dist/interface/admin-interface";
import { isTemporalCursorType, type DataSourceSyncMode } from "@hexclave/shared/dist/data-sources/modes";
import { useMemo, useState } from "react";

/**
 * Human-facing description of each mode. Kept next to the availability verdict
 * rather than on each table row: the concept only needs explaining once, and the
 * per-table exceptions live in the mode dropdown, where the choice is made.
 */
const MODE_INFO: Record<DataSourceSyncMode, { label: string, description: string }> = {
  cdc: {
    label: "CDC",
    description: "Reads your write-ahead log. Near real-time, and the only mode that sees deleted rows.",
  },
  cursor: {
    label: "Cursor",
    description: "Re-reads rows whose cursor column moved past the last sync. Cannot see deleted rows.",
  },
};

const MODE_ORDER: DataSourceSyncMode[] = ["cdc", "cursor"];

const NON_TEMPORAL_CURSOR_WARNING =
  "This column only changes when a row is inserted, so edits to existing rows will never be synced. "
  + "Pick a timestamp your application updates on every write — usually updated_at — unless this table is append-only.";

function replicationSlotsAreFull(slotsUsed: number, slotsMax: number | null): boolean {
  return slotsMax != null && slotsUsed >= slotsMax;
}

/** Concrete remediation for the specific reason CDC is off, not generic advice. */
function getCdcRemediation(capabilities: DataSourceCatalogJson["capabilities"]): string | null {
  if (capabilities.wal_level !== "logical") {
    return "Set wal_level to logical on your server (on RDS, set rds.logical_replication = 1 in the parameter group), then restart it.";
  }
  if (!capabilities.has_replication) {
    return "Grant the REPLICATION attribute to the role you gave us: ALTER ROLE <user> REPLICATION.";
  }
  if (capabilities.in_recovery) {
    return "Replication slots cannot live on a read replica. Point Hexclave at the primary instead.";
  }
  if (replicationSlotsAreFull(capabilities.slots_used, capabilities.slots_max)) {
    return "Every replication slot on the server is in use. Free one, or raise max_replication_slots.";
  }
  return null;
}

type Selection = { on: boolean, mode: DataSourceSyncMode | null, cursorColumn: string | null };

export function buildInitialSelection(
  catalog: DataSourceCatalogJson,
  existing: DataSourceStreamConfig[] | undefined,
): Record<string, Selection | undefined> {
  const existingByKey = new Map((existing ?? []).map(s => [`${s.schema_name}.${s.table_name}`, s]));
  const selection: Record<string, Selection | undefined> = {};
  for (const table of catalog.tables) {
    const key = `${table.schema_name}.${table.table_name}`;
    const prior = existingByKey.get(key);
    selection[key] = prior != null
      ? { on: true, mode: prior.mode, cursorColumn: prior.cursor_column ?? table.default_cursor_column }
      // Recommendations are defaults only during initial setup. While editing,
      // newly discovered tables must require an explicit opt-in.
      : { on: existing == null && table.recommended_mode != null, mode: table.recommended_mode, cursorColumn: table.default_cursor_column };
  }
  return selection;
}

/** True when the chosen cursor moves on insert but not on update. */
function selectedCursorIsInsertOnly(table: DataSourceCatalogTableJson, column: string | null): boolean {
  if (column == null) return false;
  const candidate = table.cursor_candidates.find(c => c.column === column);
  return candidate != null && !isTemporalCursorType(candidate.data_type);
}

function modeOptions(table: DataSourceCatalogTableJson) {
  return MODE_ORDER.map(mode => {
    const availability = table.available_modes.find(m => m.mode === mode);
    const unavailable = availability == null || !availability.available;
    return {
      value: mode,
      // The reason rides on the option itself, so an unavailable mode explains
      // itself where the customer looks for it.
      label: unavailable ? `${MODE_INFO[mode].label} — ${availability?.reason ?? "unavailable"}` : MODE_INFO[mode].label,
      disabled: unavailable,
    };
  });
}

export function StreamPicker(props: {
  catalog: DataSourceCatalogJson,
  existingStreams?: DataSourceStreamConfig[],
  submitLabel: string,
  onCancel?: () => void,
  onSubmit: (streams: DataSourceStreamConfig[]) => Promise<void>,
}) {
  const [selection, setSelection] = useState(() => buildInitialSelection(props.catalog, props.existingStreams));
  const [saving, setSaving] = useState(false);

  const cdcAvailability = useMemo(() => {
    // The server-level verdict is whatever a table with a primary key gets; a
    // per-table "needs a primary key" is not a reason to tell everyone CDC is off.
    const withKey = props.catalog.tables.find(t => t.primary_key_columns.length > 0);
    return withKey?.available_modes.find(m => m.mode === "cdc") ?? { mode: "cdc" as const, available: false, reason: null };
  }, [props.catalog]);

  const selected = props.catalog.tables.filter(t => selection[`${t.schema_name}.${t.table_name}`]?.on);
  const hasKeylessSelection = selected.some(t => t.primary_key_columns.length === 0);
  const selectedUsesCursor = selected.some(t => selection[`${t.schema_name}.${t.table_name}`]?.mode === "cursor");
  const remediation = cdcAvailability.available ? null : getCdcRemediation(props.catalog.capabilities);

  // Falls back to the same defaults the row renders with, so ticking a table that
  // the catalog grew after mount submits its recommended mode rather than null.
  const defaultSelectionFor = (key: string): Selection => {
    const table = props.catalog.tables.find(t => `${t.schema_name}.${t.table_name}` === key);
    return { on: false, mode: table?.recommended_mode ?? null, cursorColumn: table?.default_cursor_column ?? null };
  };
  const update = (key: string, patch: Partial<Selection>) => {
    setSelection(prev => ({ ...prev, [key]: { ...defaultSelectionFor(key), ...prev[key], ...patch } }));
  };

  const submit = async () => {
    setSaving(true);
    try {
      await props.onSubmit(selected.map(table => {
        const current = selection[`${table.schema_name}.${table.table_name}`];
        return {
          schema_name: table.schema_name,
          table_name: table.table_name,
          mode: current!.mode!,
          cursor_column: current!.mode === "cursor" ? current!.cursorColumn : null,
        };
      }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <Typography type="label" className="mb-3 block">Sync modes</Typography>
        <div className="flex flex-col">
          {MODE_ORDER.map((mode, index) => {
            const availableOn = props.catalog.tables.filter(
              t => t.available_modes.find(m => m.mode === mode)?.available,
            ).length;
            const isAvailable = mode === "cdc" ? cdcAvailability.available : availableOn > 0;
            return (
              <div
                key={mode}
                className={`flex items-start gap-3 py-3 ${index > 0 ? "border-t border-border-in-card" : "pt-0"}`}
              >
                <span className="w-28 shrink-0 font-medium">{MODE_INFO[mode].label}</span>
                <span className="flex-1 text-muted-foreground">{MODE_INFO[mode].description}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className={`h-1.5 w-1.5 rounded-full ${isAvailable ? "bg-green-500" : "bg-amber-500"}`} />
                  {mode === "cdc"
                    ? (cdcAvailability.available ? "Available" : cdcAvailability.reason ?? "Unavailable")
                    : `Available on ${availableOn} of ${props.catalog.tables.length} tables`}
                </span>
              </div>
            );
          })}
        </div>
        {remediation != null && (
          <p className="mt-3 border-t border-border-in-card pt-3 text-xs text-muted-foreground">
            To enable CDC: {remediation}
          </p>
        )}
        {selectedUsesCursor && (
          <p className="mt-3 border-t border-border-in-card pt-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Choosing a cursor column.</span>{" "}
            Pick a timestamp your application sets on every write, such as <code>updated_at</code> — that way
            edits are picked up as well as new rows. An id or a <code>created_at</code> only moves when a row is
            inserted, so it suits an append-only table and nothing else.
          </p>
        )}
        {hasKeylessSelection && (
          <p className="mt-2 text-xs text-muted-foreground">
            Tables without a primary key are written append-only: every version of a row is kept, because there is no key to deduplicate on.
          </p>
        )}
      </Card>

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="w-10 px-4 pb-2 pt-4" />
              <th className="px-4 pb-2 pt-4 text-left font-medium">Table</th>
              <th className="px-4 pb-2 pt-4 text-left font-medium">Rows</th>
              <th className="px-4 pb-2 pt-4 text-left font-medium">Sync mode</th>
              <th className="px-4 pb-2 pt-4 text-left font-medium">Cursor column</th>
            </tr>
          </thead>
          <tbody>
            {props.catalog.tables.map(table => {
              const key = `${table.schema_name}.${table.table_name}`;
              // A table the catalog grew since this component mounted has no
              // entry yet; it renders unselected rather than crashing the page.
              const current = selection[key] ?? defaultSelectionFor(key);
              const syncable = table.recommended_mode != null;
              return (
                <tr key={key} className={`border-t border-border-in-card ${current.on ? "" : "opacity-50"}`}>
                  <td className="px-4 py-2.5">
                    <Checkbox
                      checked={current.on}
                      // Only turning a table on needs a usable mode. A selected table
                      // that lost its last one (say, its primary key was dropped) must
                      // stay uncheckable, or its failing stream could never be removed.
                      disabled={!syncable && !current.on}
                      onCheckedChange={checked => update(key, { on: checked === true })}
                    />
                  </td>
                  <td className="px-4 py-2.5 font-medium">
                    <span className="font-normal text-muted-foreground">{table.schema_name}.</span>{table.table_name}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{formatRowCount(table.approx_rows)}</td>
                  <td className="px-4 py-2.5">
                    {syncable ? (
                      <DesignSelectorDropdown
                        size="sm"
                        value={current.mode ?? ""}
                        options={modeOptions(table)}
                        onValueChange={value => update(key, { mode: value as DataSourceSyncMode })}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">No mode available</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {current.mode === "cursor" && table.cursor_candidates.length > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <DesignSelectorDropdown
                          size="sm"
                          value={current.cursorColumn ?? ""}
                          options={table.cursor_candidates.map(candidate => ({
                            value: candidate.column,
                            // An unindexed cursor works but scans the table, which is
                            // the kind of thing to know before picking it.
                            label: candidate.indexed ? candidate.column : `${candidate.column} — no index`,
                          }))}
                          onValueChange={value => update(key, { cursorColumn: value })}
                        />
                        {selectedCursorIsInsertOnly(table, current.cursorColumn) && (
                          <SimpleTooltip tooltip={NON_TEMPORAL_CURSOR_WARNING}>
                            <WarningCircleIcon className="h-4 w-4 shrink-0 text-amber-500" weight="fill" />
                          </SimpleTooltip>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <div className="flex items-center gap-3">
        {props.onCancel && <DesignButton variant="ghost" onClick={props.onCancel}>Cancel</DesignButton>}
        <div className="flex-1" />
        <Typography type="label" variant="secondary">
          {selected.length} of {props.catalog.tables.length} selected
        </Typography>
        <DesignButton onClick={submit} disabled={selected.length === 0} loading={saving}>
          {props.submitLabel}
        </DesignButton>
      </div>
    </div>
  );
}

export function formatRowCount(rows: number | null): string {
  if (rows == null) return "unknown";
  if (rows >= 1e9) return `${(rows / 1e9).toFixed(1)}B`;
  if (rows >= 1e6) return `${(rows / 1e6).toFixed(rows >= 1e7 ? 0 : 1)}M`;
  if (rows >= 1e3) return `${Math.round(rows / 1e3)}k`;
  return String(rows);
}

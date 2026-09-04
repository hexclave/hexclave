"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignDialog,
  DesignDialogClose,
  DesignInput,
  DesignPillToggle,
} from "@/components/design-components";
import { useUpdateConfig } from "@/components/config-update";
import {
  segmentConfigUpdates,
  validateFlagCondition,
  validateFlagKey,
  type FeatureFlagsSection,
  type FlagCondition,
  type FlagSegment,
} from "@/lib/feature-flags/config";
import { PlusIcon, TrashIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { FlagConditionEditor } from "./flag-editor";
import { useAdminApp } from "../use-admin-app";

type SegmentEditorState = {
  originalId: string | null,
  id: string,
  segment: FlagSegment,
};

function emptySegment(): SegmentEditorState {
  return {
    originalId: null,
    id: "",
    segment: {
      displayName: "",
      match: "all",
      conditions: [{ attribute: "user.email", operator: "ends_with", value: "" }],
    },
  };
}

function segmentReferenceCount(section: FeatureFlagsSection, segmentId: string): number {
  const flagReferences = [...section.flags.values()].flatMap((flag) => flag.rules)
    .flatMap((rule) => rule.conditions)
    .filter((condition) => (condition.operator === "in_segment" || condition.operator === "not_in_segment") && condition.value === segmentId)
    .length;
  const segmentReferences = [...section.segments.entries()]
    .filter(([candidateId]) => candidateId !== segmentId)
    .flatMap(([, segment]) => segment.conditions)
    .filter((condition) => (condition.operator === "in_segment" || condition.operator === "not_in_segment") && condition.value === segmentId)
    .length;
  return flagReferences + segmentReferences;
}

export function SegmentsManager({ section }: { section: FeatureFlagsSection }) {
  const adminApp = useAdminApp();
  const updateConfig = useUpdateConfig();
  const [editor, setEditor] = useState<SegmentEditorState | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const validationErrors = useMemo(() => {
    if (editor == null) return [];
    const errors: string[] = [];
    const idError = validateFlagKey(editor.id);
    if (idError != null) errors.push(`Segment key: ${idError}`);
    if (editor.originalId == null && section.segments.has(editor.id)) errors.push("A segment with this key already exists.");
    if (editor.segment.displayName.trim().length === 0) errors.push("Segment name is required.");
    if (editor.segment.conditions.length === 0) errors.push("A segment needs at least one condition.");
    for (const [index, condition] of editor.segment.conditions.entries()) {
      errors.push(...validateFlagCondition(condition, section).map((error) => `Condition ${index + 1}: ${error}`));
    }
    return errors;
  }, [editor, section]);

  const save = async (): Promise<void> => {
    if (editor == null || validationErrors.length > 0) return;
    const updated = await updateConfig({
      adminApp,
      configUpdate: segmentConfigUpdates(editor.id, editor.segment),
      pushable: true,
    });
    if (updated) setEditor(null);
  };

  const remove = async (): Promise<void> => {
    if (pendingDeleteId == null) return;
    const updated = await updateConfig({
      adminApp,
      configUpdate: { [`featureFlags.segments.${pendingDeleteId}`]: null },
      pushable: true,
    });
    if (updated) setPendingDeleteId(null);
  };

  return (
    <>
      <DesignCard>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <UsersThreeIcon className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">Reusable segments</h2>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Define an audience once, then use it across targeting rules.</p>
            </div>
            <DesignButton size="sm" variant="secondary" onClick={() => setEditor(emptySegment())}>
              <PlusIcon className="mr-1 h-3.5 w-3.5" />
              New segment
            </DesignButton>
          </div>

          {section.segments.size === 0 ? (
            <div className="rounded-xl border border-dashed border-black/[0.08] px-4 py-5 text-center text-xs text-muted-foreground dark:border-white/[0.08]">
              No reusable segments yet. Flags can still target attributes directly.
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {[...section.segments.entries()].map(([segmentId, segment]) => {
                const referenceCount = segmentReferenceCount(section, segmentId);
                return (
                  <div key={segmentId} className="flex items-center gap-3 rounded-xl border border-black/[0.06] px-3 py-2.5 dark:border-white/[0.06]">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{segment.displayName}</span>
                        <DesignBadge label={`${segment.match === "all" ? "All" : "Any"} · ${segment.conditions.length}`} color="blue" size="sm" />
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">{segmentId}</span>
                    </div>
                    <DesignButton
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditor({ originalId: segmentId, id: segmentId, segment })}
                    >
                      Edit
                    </DesignButton>
                    <DesignButton
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete segment ${segment.displayName}`}
                      disabled={referenceCount > 0}
                      onClick={() => setPendingDeleteId(segmentId)}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </DesignButton>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DesignCard>

      <DesignDialog
        open={editor != null}
        onOpenChange={(open) => { if (!open) setEditor(null); }}
        size="2xl"
        icon={UsersThreeIcon}
        title={editor?.originalId == null ? "New reusable segment" : "Edit reusable segment"}
        description="Compose an audience visually. Segment membership is evaluated deterministically with the flag."
        footer={
          <>
            <DesignDialogClose asChild><DesignButton size="sm" variant="secondary">Cancel</DesignButton></DesignDialogClose>
            <DesignButton size="sm" disabled={validationErrors.length > 0} onClick={save}>Publish segment</DesignButton>
          </>
        }
      >
        {editor != null && (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Segment name</span>
                <DesignInput size="sm" value={editor.segment.displayName} onChange={(event) => setEditor({ ...editor, segment: { ...editor.segment, displayName: event.target.value } })} />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Segment key</span>
                <DesignInput size="sm" className="font-mono" disabled={editor.originalId != null} value={editor.id} onChange={(event) => setEditor({ ...editor, id: event.target.value })} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">A visitor belongs when:</span>
              <DesignPillToggle
                size="sm"
                options={[{ id: "all", label: "All conditions match" }, { id: "any", label: "Any condition matches" }]}
                selected={editor.segment.match}
                onSelect={(match) => setEditor({ ...editor, segment: { ...editor.segment, match: match === "any" ? "any" : "all" } })}
              />
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-black/[0.06] p-3 dark:border-white/[0.06]">
              {editor.segment.conditions.map((condition, index) => (
                <FlagConditionEditor
                  key={index}
                  condition={condition}
                  isFirst={index === 0}
                  section={section}
                  removeDisabled={editor.segment.conditions.length === 1}
                  onChange={(nextCondition: FlagCondition) => setEditor({
                    ...editor,
                    segment: { ...editor.segment, conditions: editor.segment.conditions.map((candidate, candidateIndex) => candidateIndex === index ? nextCondition : candidate) },
                  })}
                  onRemove={() => setEditor({ ...editor, segment: { ...editor.segment, conditions: editor.segment.conditions.filter((_, candidateIndex) => candidateIndex !== index) } })}
                />
              ))}
              <div>
                <DesignButton size="sm" variant="ghost" onClick={() => setEditor({ ...editor, segment: { ...editor.segment, conditions: [...editor.segment.conditions, { attribute: "user.email", operator: "eq", value: "" }] } })}>
                  <PlusIcon className="mr-1 h-3.5 w-3.5" />
                  Add condition
                </DesignButton>
              </div>
            </div>
            {validationErrors.length > 0 && <DesignAlert variant="error" title="Fix before publishing" description={validationErrors.join(" ")} />}
          </div>
        )}
      </DesignDialog>

      <DesignDialog
        open={pendingDeleteId != null}
        onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}
        size="md"
        icon={TrashIcon}
        title="Delete reusable segment"
        description={pendingDeleteId == null ? undefined : `Segment: ${section.segments.get(pendingDeleteId)?.displayName ?? pendingDeleteId}`}
        footer={
          <>
            <DesignDialogClose asChild><DesignButton size="sm" variant="secondary">Cancel</DesignButton></DesignDialogClose>
            <DesignButton size="sm" variant="destructive" onClick={remove}>Delete segment</DesignButton>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">This removes the segment definition. Segments referenced by a flag or another segment must be unlinked first.</p>
      </DesignDialog>
    </>
  );
}

"use client";

import { DesignAlert, DesignBadge, DesignButton, DesignCard } from "@/components/design-components";
import { CopyPromptButton } from "@/components/ui";
import { parseGrowthPageResponse } from "@/lib/growth/growth-page-response";
import type { GrowthDocument } from "@/lib/growth/growth-document";
import type { GrowthAdminDocumentDraft } from "@/lib/growth/growth-types";
import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import { ArticleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { GrowthDocumentRenderer } from "../components/growth-document";

type SaveInput = {
  sourceMdx: string,
  data: unknown[],
  expectedDraftUpdatedAtMillis: number | null,
};

function editorSeed(draft: GrowthAdminDocumentDraft | null, liveDocument: GrowthDocument | null): { mdx: string, dataJson: string } {
  if (draft?.source != null) return { mdx: draft.source.sourceMdx, dataJson: JSON.stringify(draft.source.data, null, 2) };
  return liveDocument == null
    ? { mdx: "", dataJson: "[]" }
    : { mdx: liveDocument.sourceMdx, dataJson: JSON.stringify(liveDocument.data, null, 2) };
}

export function GrowthAdminDocumentEditor(props: {
  contentKey: string,
  noun: "action page" | "evidence page" | "note page",
  prompt: string,
  promptButtonLabel: string,
  subtitle: string,
  liveDocument: GrowthDocument | null,
  initialDraft: GrowthAdminDocumentDraft | null,
  publishedAtMillis: number | null,
  saveDraft: (input: SaveInput) => Promise<GrowthAdminDocumentDraft | null>,
  publishDraft: (expectedDraftUpdatedAtMillis: number) => Promise<void>,
  discardDraft: () => Promise<void>,
}) {
  const initial = editorSeed(props.initialDraft, props.liveDocument);
  const [mdx, setMdx] = useState(initial.mdx);
  const [dataJson, setDataJson] = useState(initial.dataJson);
  const [draft, setDraft] = useState(props.initialDraft);
  const [seededKey, setSeededKey] = useState(props.contentKey);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (seededKey === props.contentKey) return;
    const seed = editorSeed(props.initialDraft, props.liveDocument);
    setMdx(seed.mdx);
    setDataJson(seed.dataJson);
    setDraft(props.initialDraft);
    setSeededKey(props.contentKey);
    setError(null);
  }, [props.contentKey, props.initialDraft, props.liveDocument, seededKey]);

  const run = async (label: string, operation: () => Promise<void>) => {
    setError(null);
    const result = await Result.fromThrowingAsync(operation);
    if (result.status === "error") {
      captureError(label, result.error);
      setError(result.error instanceof Error ? result.error.message : String(result.error));
    }
  };

  const capitalizedNoun = props.noun[0].toUpperCase() + props.noun.slice(1);
  const previewDocument = draft?.document ?? props.liveDocument;

  return (
    <div className="space-y-6">
      {error != null && <DesignAlert variant="error">{error}</DesignAlert>}
      <DesignCard title={capitalizedNoun} subtitle={props.subtitle} icon={ArticleIcon}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <DesignBadge label={draft == null ? "No saved draft" : "Draft saved"} color={draft == null ? "orange" : "cyan"} size="sm" />
            <DesignBadge label={props.publishedAtMillis == null ? "Generated page live" : "Admin version live"} color="green" size="sm" />
            <CopyPromptButton content={props.prompt} size="sm" variant="outline">{props.promptButtonLabel}</CopyPromptButton>
          </div>
          <p className="text-xs text-muted-foreground">Paste the complete model response below. Fenced MDX and JSON blocks are separated automatically.</p>
          <label className="block text-xs font-medium">
            {capitalizedNoun} source (growth-mdx-v1)
            <textarea
              className="mt-1 min-h-72 w-full rounded-xl border bg-background p-3 font-mono text-xs"
              value={mdx}
              onChange={(event) => setMdx(event.target.value)}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData("text");
                try {
                  const parsed = parseGrowthPageResponse(pasted);
                  if (parsed == null) return;
                  event.preventDefault();
                  setMdx(parsed.sourceMdx);
                  setDataJson(parsed.evidenceDataJson);
                  setError(null);
                } catch (caught) {
                  event.preventDefault();
                  setError(caught instanceof Error ? caught.message : String(caught));
                }
              }}
            />
          </label>
          <label className="block text-xs font-medium">
            Evidence data JSON
            <textarea
              className="mt-1 min-h-32 w-full rounded-xl border bg-background p-3 font-mono text-xs"
              value={dataJson}
              onChange={(event) => setDataJson(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <DesignButton size="sm" disabled={mdx.trim().length === 0} onClick={async () => await run(`growth-admin-${props.noun}-save`, async () => {
              const parsed = parseGrowthPageResponse(mdx);
              const sourceMdx = parsed?.sourceMdx ?? mdx;
              const evidenceDataJson = parsed?.evidenceDataJson ?? dataJson;
              const evidenceData: unknown = JSON.parse(evidenceDataJson);
              if (!Array.isArray(evidenceData)) throw new Error("Evidence data must be a JSON array.");
              const saved = await props.saveDraft({ sourceMdx, data: evidenceData, expectedDraftUpdatedAtMillis: draft?.updatedAtMillis ?? null });
              if (saved == null) throw new Error(`The backend saved the ${props.noun} draft but returned no draft.`);
              setMdx(sourceMdx);
              setDataJson(evidenceDataJson);
              setDraft(saved);
            })}>Save draft</DesignButton>
            <DesignButton size="sm" variant="outline" disabled={draft == null} onClick={async () => await run(`growth-admin-${props.noun}-publish`, async () => {
              await props.publishDraft(draft?.updatedAtMillis ?? throwErr(`Publish was clicked without a saved ${props.noun} draft.`));
              setDraft(null);
            })}>Publish {props.noun}</DesignButton>
            <DesignButton size="sm" variant="outline" disabled={draft == null} onClick={async () => await run(`growth-admin-${props.noun}-discard`, async () => {
              await props.discardDraft();
              const seed = editorSeed(null, props.liveDocument);
              setMdx(seed.mdx);
              setDataJson(seed.dataJson);
              setDraft(null);
            })}>Discard draft</DesignButton>
          </div>
        </div>
      </DesignCard>

      <section className="rounded-2xl border border-foreground/[0.08] bg-background p-5">
        <p className="text-xs font-medium text-muted-foreground">{draft?.document != null ? "Preview of the saved draft" : "Current customer page"}</p>
        <div className="mt-4">
          {previewDocument == null
            ? <p className="text-sm text-muted-foreground">Save a draft to preview this {props.noun}.</p>
            : <GrowthDocumentRenderer document={previewDocument} />}
        </div>
      </section>
    </div>
  );
}

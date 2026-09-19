"use client";

import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { format } from "date-fns";
import { usePublishedQa } from "../../hooks/useSpacetimeDB";
import { toDate } from "../../utils";
import { Alert } from "../../components/design";
import { markdownComponents } from "../../components/markdown-components";

export default function QuestionsPage() {
  const { rows, connectionState } = usePublishedQa();

  const publishedQa = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aTime = a.publishedAt ? Number(toDate(a.publishedAt)) : 0;
      const bTime = b.publishedAt ? Number(toDate(b.publishedAt)) : 0;
      return bTime - aTime;
    });
  }, [rows]);

  if (connectionState === "connecting") {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (connectionState === "error") {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <Alert>Failed to connect to database.</Alert>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="mb-2 text-2xl font-bold text-foreground">Hexclave Q&A</h1>
      <p className="mb-8 text-sm text-muted-foreground">
        Curated questions and answers about Hexclave, reviewed by humans.
      </p>

      {publishedQa.length === 0 ? (
        <p className="text-sm text-muted-foreground">No published Q&A yet.</p>
      ) : (
        <div className="space-y-8">
          {publishedQa.map(row => (
            <article key={String(row.id)} className="border-b border-black/[0.06] pb-8 last:border-b-0 dark:border-white/[0.06]">
              <h2 className="mb-3 text-lg font-semibold text-foreground">{row.question}</h2>
              <div className="prose prose-sm max-w-none text-foreground dark:prose-invert">
                <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {row.answer}
                </Markdown>
              </div>
              {row.publishedAt && (
                <div className="mt-3 text-xs text-muted-foreground">
                  {format(toDate(row.publishedAt), "MMM d, yyyy")}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

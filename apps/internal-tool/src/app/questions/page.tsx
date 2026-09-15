"use client";

import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { format } from "date-fns";
import { usePublishedQa } from "../../hooks/useSpacetimeDB";
import { toDate } from "../../utils";
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
        <p className="text-gray-500 text-sm">Loading...</p>
      </div>
    );
  }

  if (connectionState === "error") {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <p className="text-red-600 text-sm">Failed to connect to database.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Hexclave Q&A</h1>
      <p className="text-sm text-gray-500 mb-8">
        Curated questions and answers about Hexclave, reviewed by humans.
      </p>

      {publishedQa.length === 0 ? (
        <p className="text-gray-400 text-sm">No published Q&A yet.</p>
      ) : (
        <div className="space-y-8">
          {publishedQa.map(row => (
            <article key={String(row.id)} className="border-b border-gray-200 pb-8 last:border-b-0">
              <h2 className="text-lg font-semibold text-gray-900 mb-3">{row.question}</h2>
              <div className="prose prose-sm max-w-none text-gray-700">
                <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {row.answer}
                </Markdown>
              </div>
              {row.publishedAt && (
                <div className="mt-3 text-xs text-gray-400">
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

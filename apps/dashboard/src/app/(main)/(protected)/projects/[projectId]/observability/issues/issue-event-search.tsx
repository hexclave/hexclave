"use client";

import { DesignAlert, DesignButton, DesignCard, DesignInput } from "@/components/design-components";
import { Link } from "@/components/link";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { getErrorMessage } from "../format";
import { issueDetailHref } from "./issue-links";
import { searchPublicIssues, type IssuePublicSearchRecord, type IssuePublicSearchRequest } from "./issues-data";
import type { IssueFilters } from "./issue-filters";

type IssueEventSearchFilters = Omit<IssuePublicSearchRequest, "cursor">;

export function IssueEventSearch({
  adminApp,
  projectId,
  filters,
}: {
  adminApp: object,
  projectId: string,
  filters: IssueFilters,
}) {
  const [level, setLevel] = useState("");
  const [release, setRelease] = useState("");
  const [userId, setUserId] = useState("");
  const [tagKey, setTagKey] = useState("");
  const [tagValue, setTagValue] = useState("");
  const [items, setItems] = useState<IssuePublicSearchRecord[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorFilters, setCursorFilters] = useState<IssueEventSearchFilters | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runSearch = async (cursor: string | null) => {
    setBusy(true);
    setError(null);
    const currentFilters: IssueEventSearchFilters = {
      hours: filters.hours,
      status: filters.status,
      service: filters.service,
      environment: filters.environment,
      handled: filters.handled === "all" ? "all" : filters.handled === "handled",
      search: filters.search,
      level: level.trim() === "" ? null : level.trim(),
      release: release.trim() === "" ? null : release.trim(),
      userId: userId.trim() === "" ? null : userId.trim(),
      tagKey: tagKey.trim() === "" ? null : tagKey.trim(),
      tagValue: tagValue.trim() === "" ? null : tagValue.trim(),
    };
    const requestFilters = cursor == null || cursorFilters == null ? currentFilters : cursorFilters;
    try {
      const result = await searchPublicIssues(adminApp, {
        ...requestFilters,
        cursor,
      });
      setItems((current) => cursor == null || current == null ? result.items : [...current, ...result.items]);
      setNextCursor(result.nextCursor);
      setCursorFilters(result.nextCursor == null ? null : requestFilters);
    } catch (caught) {
      if (cursor == null) {
        setItems(null);
        setNextCursor(null);
        setCursorFilters(null);
      }
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DesignCard title="Event search" subtitle="Search issues by level, release, user, or tag — dimensions the list filter bar does not cover" icon={MagnifyingGlassIcon}>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <DesignInput size="sm" value={level} onChange={(event) => setLevel(event.target.value)} placeholder="Level" aria-label="Search level" />
        <DesignInput size="sm" value={release} onChange={(event) => setRelease(event.target.value)} placeholder="Release" aria-label="Search release" />
        <DesignInput size="sm" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="User ID" aria-label="Search user ID" />
        <DesignInput size="sm" value={tagKey} onChange={(event) => setTagKey(event.target.value)} placeholder="Tag key" aria-label="Search tag key" />
        <DesignInput size="sm" value={tagValue} onChange={(event) => setTagValue(event.target.value)} placeholder="Tag value" aria-label="Search tag value" />
      </div>
      <div className="mt-2">
        <DesignButton size="sm" variant="secondary" loading={busy} onClick={() => runSearch(null)} className="gap-1.5">
          <MagnifyingGlassIcon className="h-3.5 w-3.5" />
          Search events
        </DesignButton>
      </div>
      {error != null && (
        <div className="mt-3">
          <DesignAlert variant="error" title="Couldn't search issues" description={error} />
        </div>
      )}
      {items != null && items.length === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">No matching issue records in this range.</p>
      )}
      {items != null && items.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {items.map((item, index) => {
            const href = item.issue_id == null ? null : issueDetailHref(projectId, item.issue_id);
            const title = item.issue_type == null ? item.message : `${item.issue_type}: ${item.issue_value ?? item.message}`;
            return (
              <li key={`${item.issue_id ?? "none"}-${item.event_id ?? item.occurrence_id ?? index}`} className="rounded-lg bg-foreground/[0.03] px-3 py-2 text-xs ring-1 ring-foreground/[0.06]">
                {href == null ? <span>{title}</span> : <Link href={href} className="hover:underline">{title}</Link>}
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {item.level}
                  {item.release != null ? ` · ${item.release}` : ""}
                  {item.matched_tag != null ? ` · ${item.matched_tag.key}=${item.matched_tag.value}` : ""}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {items != null && items.length > 0 && nextCursor != null && (
        <div className="mt-2">
          <DesignButton size="sm" variant="ghost" loading={busy} onClick={() => runSearch(nextCursor)}>
            Load more
          </DesignButton>
        </div>
      )}
    </DesignCard>
  );
}

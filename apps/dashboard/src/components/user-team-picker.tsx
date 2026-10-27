"use client";

import { DesignButton } from "@/components/design-components";
import { Spinner, Typography, cn } from "@/components/ui";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type CurrentUser, type Team } from "@hexclave/next";
import { useTeamPages } from "@hexclave/shared/dist/hooks/use-team-pages";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { CaretSortIcon, CheckIcon } from "@radix-ui/react-icons";
import { Suspense, useState } from "react";

type TeamSource = Pick<CurrentUser, "useTeams" | "listTeams">;

const loadMoreValue = "__load-more-teams__";

/**
 * Picks one of the current user's teams. `useTeams()` returns at most one page (200 teams), so a plain dropdown
 * over it hides the rest; this searches server-side and loads further pages on demand.
 *
 * The selection is held by the caller as a `Team` object rather than an ID, because the selected team may not be
 * in any page loaded here (e.g. it was found via search, or the search was cleared since).
 */
export function UserTeamPicker(props: {
  user: TeamSource,
  value: Team | null,
  onChange: (team: Team) => void,
  placeholder?: string,
  disabled?: boolean,
  triggerId?: string,
  className?: string,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={props.triggerId}
          type="button"
          disabled={props.disabled}
          className={cn(
            "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-xl",
            "border border-black/[0.08] bg-white/80 px-3 py-2 text-sm shadow-sm ring-1 ring-black/[0.08]",
            "transition-all duration-150 hover:transition-none hover:ring-black/[0.12]",
            "focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/30",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "dark:border-white/[0.06] dark:bg-background/60 dark:ring-white/[0.06] dark:hover:ring-white/[0.1]",
            props.className,
          )}
        >
          <span className={cn("truncate text-left", props.value == null && "text-muted-foreground")}>
            {props.value?.displayName ?? props.placeholder ?? "Select a team"}
          </span>
          <CaretSortIcon className="ml-2 h-4 w-4 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[240px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search teams..." value={query} onValueChange={setQuery} />
          <CommandList>
            <Suspense fallback={<LoadingRow label="Loading teams..." />}>
              <TeamOptions
                user={props.user}
                query={query}
                selectedTeamId={props.value?.id ?? null}
                onSelect={(team) => {
                  props.onChange(team);
                  setOpen(false);
                  setQuery("");
                }}
              />
            </Suspense>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function TeamOptions(props: {
  user: TeamSource,
  query: string,
  selectedTeamId: string | null,
  onSelect: (team: Team) => void,
}) {
  const pages = useTeamPages(props.user, props.query);

  if (pages.searchFailed) {
    return (
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <Typography variant="secondary" className="text-sm text-destructive">Could not search teams.</Typography>
        <DesignButton type="button" size="sm" variant="outline" onClick={pages.retrySearch}>Retry</DesignButton>
      </div>
    );
  }

  return (
    <>
      {pages.isSearchPending && <LoadingRow label="Searching..." />}
      {!pages.isSearchPending && pages.teams.length === 0 && (
        <CommandEmpty>{pages.activeQuery !== "" ? "No matching teams." : "You are not a member of any team."}</CommandEmpty>
      )}
      {pages.teams.length > 0 && (
        <CommandGroup>
          {pages.teams.map((team) => (
            <CommandItem key={team.id} value={team.id} onSelect={() => props.onSelect(team)}>
              <CheckIcon
                className={cn("mr-2 h-4 w-4 shrink-0", props.selectedTeamId === team.id ? "opacity-100" : "opacity-0")}
              />
              <span className="min-w-0 flex-1 truncate text-sm">{team.displayName}</span>
            </CommandItem>
          ))}
          {pages.hasMore && (
            <CommandItem
              value={loadMoreValue}
              disabled={pages.isLoadingMore}
              onSelect={() => runAsynchronouslyWithAlert(pages.loadMore())}
              className="justify-center text-muted-foreground"
            >
              {pages.isLoadingMore ? <Spinner size={14} /> : "Load more teams"}
            </CommandItem>
          )}
        </CommandGroup>
      )}
    </>
  );
}

function LoadingRow(props: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-3">
      <Spinner size={14} />
      <Typography variant="secondary" className="text-sm">{props.label}</Typography>
    </div>
  );
}

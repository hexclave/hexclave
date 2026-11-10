"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../components/design/cn";
import { setTheme } from "../../lib/theme";
import { Icon, type IconName } from "../ui/icons";
import { Kbd } from "../ui/primitives";
import { CONSOLE_PAGES } from "./nav";

type Command = {
  id: string,
  group: "Pages" | "Actions",
  label: string,
  hint?: string,
  icon: IconName,
  keywords?: string,
  run: () => void,
};

/**
 * ⌘K launcher: jump to any page or run a global action. Opened from the sidebar button or the
 * shortcut (registered by ConsoleShell). Built on the native <dialog> for focus trapping.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog == null) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const commands = useMemo<Command[]>(() => [
    ...CONSOLE_PAGES.map(page => ({
      id: `page-${page.id}`,
      group: "Pages" as const,
      label: page.label,
      hint: page.description,
      icon: page.icon,
      keywords: page.section ?? "",
      run: () => router.push(page.href),
    })),
    { id: "add-qa", group: "Actions", label: "Add Q&A entry", icon: "plus", keywords: "knowledge new create", run: () => router.push("/console/knowledge?new=1") },
    { id: "review-queue", group: "Actions", label: "Open review queue", hint: "Calls flagged for human review", icon: "review", keywords: "needs review queue", run: () => router.push("/console/mcp?view=needs-review") },
    { id: "theme-light", group: "Actions", label: "Switch to light theme", icon: "sun", keywords: "appearance", run: () => setTheme("light") },
    { id: "theme-dark", group: "Actions", label: "Switch to dark theme", icon: "moon", keywords: "appearance", run: () => setTheme("dark") },
    { id: "theme-system", group: "Actions", label: "Use system theme", icon: "monitor", keywords: "appearance", run: () => setTheme("system") },
    { id: "legacy", group: "Actions", label: "Open legacy interface", icon: "external", keywords: "old classic", run: () => router.push("/") },
  ], [router]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return commands;
    return commands.filter(command => `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`.toLowerCase().includes(needle));
  }, [commands, query]);
  const boundedIndex = Math.min(activeIndex, Math.max(0, results.length - 1));

  function execute(command: Command) {
    onClose();
    command.run();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label="Command palette"
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-2xl backdrop:bg-black/30 backdrop:backdrop-blur-[2px]"
    >
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <Icon name="search" className="text-muted-foreground" />
        <input
          autoFocus
          aria-label="Search pages and actions"
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={event => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex(Math.min(boundedIndex + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex(Math.max(boundedIndex - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const command = results.at(boundedIndex);
              if (command != null) execute(command);
            }
          }}
          placeholder="Search pages and actions…"
          className="h-12 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <Kbd>Esc</Kbd>
      </div>
      <div role="listbox" aria-label="Results" className="hx-scroll max-h-[min(24rem,60vh)] overflow-y-auto p-1.5">
        {results.length === 0 && <p className="px-3 py-8 text-center text-xs text-muted-foreground">No results for “{query}”</p>}
        {(["Pages", "Actions"] as const).map(group => {
          const groupResults = results.filter(command => command.group === group);
          if (groupResults.length === 0) return null;
          return (
            <div key={group} className="pb-1">
              <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{group}</p>
              {groupResults.map(command => {
                const index = results.indexOf(command);
                const active = index === boundedIndex;
                return (
                  <button
                    key={command.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => execute(command)}
                    className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left", active ? "bg-muted" : "")}
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-card text-muted-foreground">
                      <Icon name={command.icon} size="sm" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{command.label}</span>
                      {command.hint != null && <span className="block truncate text-[11px] text-muted-foreground">{command.hint}</span>}
                    </span>
                    {active && <Icon name="arrowRight" size="sm" className="text-muted-foreground" />}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 border-t border-border bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
        <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
      </div>
    </dialog>
  );
}

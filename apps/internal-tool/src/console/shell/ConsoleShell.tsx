"use client";

import { useUser } from "@hexclave/next";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../../components/design/cn";
import { readLocalStorage, writeLocalStorage } from "../../lib/browser-storage";
import { ConsoleDataProvider } from "../data/console-data";
import { IconButton } from "../ui/primitives";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import "../console.css";

const COLLAPSED_STORAGE_KEY = "hx-console-sidebar-collapsed";
/** Applied to <body> as well as the shell root so portalled UI (DataGrid menus, dialogs) gets console tokens too. */
const CONSOLE_SCOPE_CLASS = "hx-console";

export function ConsoleShell({ children }: { children: ReactNode }) {
  // Any signed-in member of the project may use the tool; resolving the user before mounting the
  // data provider means the SpacetimeDB token mint never runs (and fails) for a signed-out visitor.
  useUser({ or: "redirect" });
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(() => typeof window !== "undefined" && readLocalStorage(COLLAPSED_STORAGE_KEY) === "true");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    writeLocalStorage(COLLAPSED_STORAGE_KEY, String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    document.body.classList.add(CONSOLE_SCOPE_CLASS);
    return () => document.body.classList.remove(CONSOLE_SCOPE_CLASS);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(previous => !previous);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // A navigation from the mobile drawer lands on a new page; the drawer shouldn't stay over it.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  return (
    <ConsoleDataProvider>
      <div className={cn(CONSOLE_SCOPE_CLASS, "flex h-dvh overflow-hidden")}>
        <div className="hidden md:flex">
          <Sidebar collapsed={collapsed} onToggleCollapsed={() => setCollapsed(previous => !previous)} onOpenPalette={() => setPaletteOpen(true)} />
        </div>

        {mobileNavOpen && (
          <div className="fixed inset-0 z-40 flex md:hidden">
            <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-black/40" onClick={() => setMobileNavOpen(false)} />
            <div className="relative h-full shadow-2xl">
              <Sidebar
                collapsed={false}
                onToggleCollapsed={() => setMobileNavOpen(false)}
                onOpenPalette={() => {
                  setMobileNavOpen(false);
                  setPaletteOpen(true);
                }}
                onNavigate={() => setMobileNavOpen(false)}
              />
            </div>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3 md:hidden">
            <IconButton icon="sidebar" label="Open navigation" onClick={() => setMobileNavOpen(true)} />
            <span className="text-[13px] font-semibold">AI Operations</span>
            <IconButton icon="search" label="Search" className="ml-auto" onClick={() => setPaletteOpen(true)} />
          </div>
          {children}
        </div>

        {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      </div>
    </ConsoleDataProvider>
  );
}

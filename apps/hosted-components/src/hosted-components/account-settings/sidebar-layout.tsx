import { Button, cn } from "~/components/ui";
import { useLocation } from "@tanstack/react-router";
import { XIcon } from 'lucide-react';
import React, { ReactNode } from 'react';

export type SidebarItem = {
  title: React.ReactNode,
  type: 'item' | 'divider',
  description?: React.ReactNode,
  id?: string,
  icon?: React.ReactNode,
  content?: React.ReactNode,
  contentTitle?: React.ReactNode,
}

/** The current location hash without the leading `#`, which is the `id` of the selected sidebar item. */
export function useHash() {
  return useLocation({
    select: (location) => location.hash.startsWith("#") ? location.hash.slice(1) : location.hash,
  });
}

export function SidebarLayout(props: { items: SidebarItem[], title?: ReactNode, className?: string }) {
  const hash = useHash();
  const selectedIndex = props.items.findIndex(item => item.id && (item.id === hash));
  return (
    <>
      <div className={cn("hidden sm:flex flex-1 min-h-full", props.className)}>
        <DesktopLayout items={props.items} title={props.title} selectedIndex={selectedIndex} />
      </div>
      <div className={cn("sm:hidden flex-1 min-h-full", props.className)}>
        <MobileLayout items={props.items} title={props.title} selectedIndex={selectedIndex} />
      </div>
    </>
  );
}

export function setHash(hash: string) {
  if (window.location.hash === hash) {
    return;
  }
  window.location.hash = hash;
}

function Items(props: { items: SidebarItem[], selectedIndex: number }) {
  const activeItemIndex = props.selectedIndex === -1 ? 0 : props.selectedIndex;

  return props.items.map((item, index) => (
    item.type === 'item' ? (
      <Button
        key={index}
        variant='ghost'
        size='sm'
        className={cn(
          "justify-start px-3 py-2 rounded-lg text-sm font-medium transition-colors hover:transition-none text-foreground/75 hover:text-foreground hover:bg-zinc-200/45 dark:hover:bg-zinc-800/45 gap-2",
          activeItemIndex === index ? "bg-white/80 dark:bg-zinc-800/65 ring-1 ring-black/[0.04] dark:ring-white/[0.06] text-foreground font-semibold" : ""
        )}
        onClick={() => {
          if (item.id) {
            setHash('#' + item.id);
          }
        }}
      >
        {item.icon}
        {item.title}
      </Button>
    ) : (
      <div key={index} className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-widest mt-5 px-3 mb-1">
        {item.title}
      </div>
    )
  ));
}

function DesktopLayout(props: { items: SidebarItem[], title?: ReactNode, selectedIndex: number }) {
  const selectedItem = props.items[props.selectedIndex === -1 ? 0 : props.selectedIndex];

  return (
    <div className="flex w-full flex-1 max-w-full items-stretch">
      {/* Full-height rail flush with the viewport's left edge. `sticky top-0 h-screen` keeps it
          pinned while the page scrolls with the document. Slightly darker than the page in light
          mode, slightly lighter in dark mode, so it reads as a distinct surface. */}
      <aside className="sticky top-0 h-screen flex flex-col items-stretch gap-1 overflow-y-auto shrink-0 w-[260px] border-r border-black/[0.06] dark:border-white/[0.06] bg-zinc-100/70 dark:bg-zinc-900/45 px-4 py-6">
        {props.title && (
          <div className="ml-3 mb-4">
            <h2 className="font-semibold text-xl tracking-tight text-foreground">
              {props.title}
            </h2>
          </div>
        )}

        <Items items={props.items} selectedIndex={props.selectedIndex} />
      </aside>
      <main className="flex-1 w-0 flex justify-center gap-4 py-8 px-6 md:px-10">
        <div className="flex flex-col max-w-[800px] w-full gap-5">
          <div className="mb-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {selectedItem.contentTitle || selectedItem.title}
            </h1>
            {selectedItem.description && (
              <p className="text-muted-foreground text-sm mt-1">
                {selectedItem.description}
              </p>
            )}
          </div>
          <div className="flex-1">
            {selectedItem.content}
          </div>
        </div>
      </main>
    </div>
  );
}

function MobileLayout(props: { items: SidebarItem[], title?: ReactNode, selectedIndex: number }) {
  const selectedItem = props.items[props.selectedIndex];

  if (props.selectedIndex === -1) {
    return (
      <div className="flex flex-col gap-2 p-2">
        {props.title && (
          <div className="mb-2 ml-2">
            <h2 className="text-lg font-semibold text-foreground">{props.title}</h2>
          </div>
        )}

        <Items items={props.items} selectedIndex={props.selectedIndex} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <Button
        variant="ghost"
        size="sm"
        className="justify-start gap-2 w-fit -ml-2 text-muted-foreground"
        onClick={() => setHash('')}
      >
        <XIcon className="h-4 w-4" />
        Back
      </Button>
      <div>
        <h1 className="text-xl font-bold tracking-tight text-foreground">
          {selectedItem.contentTitle || selectedItem.title}
        </h1>
        {selectedItem.description && (
          <p className="text-muted-foreground text-sm mt-1">
            {selectedItem.description}
          </p>
        )}
      </div>
      {selectedItem.content}
    </div>
  );
}

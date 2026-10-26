'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { X } from '@phosphor-icons/react';
import React, { ReactNode, useSyncExternalStore } from 'react';
import { useStackApp } from '@hexclave/next';

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
  return useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("hashchange", onStoreChange);
      return () => window.removeEventListener("hashchange", onStoreChange);
    },
    () => window.location.hash.slice(1),
    () => "",
  );
}

export function SidebarLayout(props: { items: SidebarItem[], title?: ReactNode, className?: string }) {
  const hash = useHash();
  const selectedIndex = props.items.findIndex(item => item.id && (item.id === hash));
  return (
    <>
      <div className={cn("hidden sm:flex h-full", props.className)}>
        <DesktopLayout items={props.items} title={props.title} selectedIndex={selectedIndex} />
      </div>
      <div className={cn("sm:hidden h-full", props.className)}>
        <MobileLayout items={props.items} title={props.title} selectedIndex={selectedIndex} />
      </div>
    </>
  );
}

function Items(props: { items: SidebarItem[], selectedIndex: number }) {
  const app = useStackApp();
  const navigate = app.useNavigate();

  const activeItemIndex = props.selectedIndex === -1 ? 0 : props.selectedIndex;

  return props.items.map((item, index) => (
    item.type === 'item' ? (
      <Button
        key={index}
        variant='ghost'
        size='sm'
        className={cn(
          "justify-start px-3 py-2 rounded-xl text-sm font-medium transition-all duration-150 hover:transition-none text-foreground/85 hover:text-foreground hover:bg-zinc-100/60 dark:hover:bg-zinc-900/60 gap-2",
          activeItemIndex === index ? "bg-white dark:bg-zinc-800/80 shadow-sm ring-1 ring-black/[0.04] text-foreground font-semibold" : ""
        )}
        onClick={() => {
          if (item.id) {
            navigate('#' + item.id);
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
    <div className="flex w-full h-full max-w-full relative items-stretch">
      <div className="flex flex-col items-stretch gap-1.5 p-2 overflow-y-auto shrink-0 max-w-[240px] min-w-[240px] border-r border-black/[0.06] dark:border-white/[0.06] bg-transparent py-4 pr-4">
        {props.title && (
          <div className="ml-3 mb-4">
            <h2 className="font-semibold text-xl tracking-tight text-foreground">
              {props.title}
            </h2>
          </div>
        )}

        <Items items={props.items} selectedIndex={props.selectedIndex} />
      </div>
      <div className="flex-1 w-0 flex justify-center gap-4 py-4 px-6 md:px-8">
        <div className="flex flex-col max-w-[800px] w-full gap-6">
          <div className="mb-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
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
      </div>
    </div>
  );
}

function MobileLayout(props: { items: SidebarItem[], title?: ReactNode, selectedIndex: number }) {
  const selectedItem = props.items[props.selectedIndex];
  const app = useStackApp();
  const navigate = app.useNavigate();

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
  } else {
    return (
      <div className="flex-1 flex flex-col gap-4 py-2 px-4">
        <div className="flex flex-col">
          <div className="flex justify-between">
            <h4 className="font-semibold text-lg">{selectedItem.title}</h4>
            <Button
              variant='ghost'
              size='icon'
              onClick={() => { navigate('#'); }}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
          {selectedItem.description && <p className="text-muted-foreground text-sm mt-1">{selectedItem.description}</p>}
        </div>
        <div className="flex-1">
          {selectedItem.content}
        </div>
      </div>
    );
  }
}

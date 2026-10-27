'use client';

import { Button, Typography, cn } from '@hexclave/ui';
import { useLocation } from '@tanstack/react-router'; // THIS_LINE_PLATFORM tanstack-start
import { XIcon } from 'lucide-react';
import React, { ReactNode } from 'react';
import { useStackApp } from '../..';
import { suspendIfSsr } from '../../utils/react';

export type SidebarItem = {
  title: React.ReactNode,
  type: 'item' | 'divider',
  description?: React.ReactNode,
  id?: string,
  icon?: React.ReactNode,
  content?: React.ReactNode,
  contentTitle?: React.ReactNode,
}

function normalizeHash(hash: string) {
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

/** The current location hash without the leading `#`, which is the `id` of the selected sidebar item. */
export function useHash() {
  // IF_PLATFORM tanstack-start
  return useLocation({ select: (location) => normalizeHash(location.hash) });
  // ELSE_PLATFORM
  suspendIfSsr();
  return React.useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("hashchange", onStoreChange);
      return () => window.removeEventListener("hashchange", onStoreChange);
    },
    () => normalizeHash(window.location.hash),
  );
  // END_PLATFORM
}

export function SidebarLayout(props: { items: SidebarItem[], title?: ReactNode, className?: string }) {
  const hash = useHash();
  const selectedIndex = props.items.findIndex(item => item.id && (item.id === hash));
  return (
    <>
      <div className={cn("hidden sm:flex stack-scope h-full", props.className)}>
        <DesktopLayout items={props.items} title={props.title} selectedIndex={selectedIndex} />
      </div>
      <div className={cn("sm:hidden stack-scope h-full", props.className)}>
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
    item.type === 'item' ?
      <Button
        key={index}
        variant='ghost'
        size='sm'
        className={cn(
          activeItemIndex === index && "sm:bg-muted",
          "justify-start text-md text-zinc-800 dark:text-zinc-300 px-2 text-left",
        )}
        onClick={() => {
          if (item.id) {
            navigate('#' + item.id);
          }
        }}
      >
        {item.icon}
        {item.title}
      </Button> :
      <Typography key={index}>
        {item.title}
      </Typography>
  ));

}

function DesktopLayout(props: { items: SidebarItem[], title?: ReactNode, selectedIndex: number }) {
  const selectedItem = props.items[props.selectedIndex === -1 ? 0 : props.selectedIndex];

  return (
    <div className="stack-scope flex w-full h-full max-w-full relative">
      <div className="flex max-w-[200px] min-w-[200px] border-r flex-col items-stretch gap-2 p-2 overflow-y-auto">
        {props.title && <div className='mb-2 ml-2'>
          <Typography type='h2' className="text-lg font-semibold text-zinc-800 dark:text-zinc-300">{props.title}</Typography>
        </div>}

        <Items items={props.items} selectedIndex={props.selectedIndex} />
      </div>
      <div className="flex-1 w-0 flex justify-center gap-4 py-2 px-4">
        <div className='flex flex-col max-w-[800px] w-[800px]'>
          <div className='mt-4 mb-6'>
            <Typography type='h4' className='font-semibold'>{selectedItem.title}</Typography>
            {selectedItem.description && <Typography variant='secondary' type='label'>{selectedItem.description}</Typography>}
          </div>
          <div className='flex-1'>
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
        {props.title && <div className='mb-2 ml-2'>
          <Typography type='h2' className="text-lg font-semibold text-zinc-800 dark:text-zinc-300">{props.title}</Typography>
        </div>}

        <Items items={props.items} selectedIndex={props.selectedIndex} />
      </div>
    );
  } else {
    return (
      <div className="flex-1 flex flex-col gap-4 py-2 px-4">
        <div className='flex flex-col'>
          <div className='flex justify-between'>
            <Typography type='h4' className='font-semibold'>{selectedItem.title}</Typography>
            <Button
              variant='ghost'
              size='icon'
              onClick={() => { navigate('#'); }}
            >
              <XIcon className='h-5 w-5' />
            </Button>
          </div>
          {selectedItem.description && <Typography variant='secondary' type='label'>{selectedItem.description}</Typography>}
        </div>
        <div className='flex-1'>
          {selectedItem.content}
        </div>
      </div>
    );
  }
}

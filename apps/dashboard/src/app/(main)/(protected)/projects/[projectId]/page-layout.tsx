"use client";

import { cn, Typography } from "@/components/ui";
import React from "react";

const PageLayoutContext = React.createContext(false);

export function PageLayout(props: {
  children?: React.ReactNode,
  title?: string,
  description?: string | React.ReactNode,
  actions?: React.ReactNode,
  fillWidth?: boolean,
  noPadding?: boolean,
  allowContentOverflow?: boolean,
  containedHeight?: boolean,
  fullBleed?: boolean,
  wrapHeaderInCard?: boolean,
} & ({
  fillWidth: true,
} | {
  width?: number,
})) {
  const isNested = React.useContext(PageLayoutContext);
  // Only the outermost PageLayout may control the shell's scroll model; nested
  // layouts are content and must not change how the page itself scrolls.
  const exposesShellAttributes = !isNested;

  const pageLayout = (
    <div
      className={cn("flex flex-1 min-h-0 flex-col", !props.noPadding && "py-4 px-4 sm:py-6 sm:px-6")}
      data-contained-height={exposesShellAttributes && props.containedHeight ? "true" : undefined}
      data-full-bleed={exposesShellAttributes && props.fullBleed ? "true" : undefined}
    >
      <div
        className={cn(
          "mx-auto flex min-h-0 w-full min-w-0 flex-1 flex-col",
          !props.fillWidth && "max-w-7xl",
        )}
        style={{
          maxWidth: props.fillWidth ? undefined : (props.width ?? 1250),
          // Always `100%` so narrow viewports don’t inherit a fixed 1250px width (which
          // clips the whole page on mobile). `maxWidth` caps the content column on desktop.
          width: "100%",
        }}
      >
        {(props.title || props.description || props.actions) && (
          <div
            className={cn(
              "mb-6",
              props.noPadding && "px-4 pt-4 sm:px-6 sm:pt-6",
              props.wrapHeaderInCard && "rounded-2xl border border-black/[0.06] bg-white/90 p-4 shadow-[0_2px_12px_rgba(0,0,0,0.04)] backdrop-blur-xl sm:p-5 dark:border-0 dark:bg-transparent dark:shadow-none dark:backdrop-blur-none dark:rounded-none dark:p-0 dark:sm:p-0"
            )}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center">
              <div className="space-y-1">
                {props.title && (
                  <Typography type="h2" className="text-xl sm:text-2xl font-semibold tracking-tight">
                    {props.title}
                  </Typography>
                )}
                {props.description && (
                  <Typography type={typeof props.description === "string" ? "p" : "div"} variant="secondary" className="text-sm">
                    {props.description}
                  </Typography>
                )}
              </div>
              {props.actions && (
                <div className="flex-shrink-0">
                  {props.actions}
                </div>
              )}
            </div>
          </div>
        )}
        <div className={cn(
          "flex flex-col gap-4",
          !props.allowContentOverflow && "flex-1 min-h-0",
        )}>
          {props.children}
        </div>
      </div>
    </div>
  );

  return (
    <PageLayoutContext.Provider value={true}>
      {pageLayout}
    </PageLayoutContext.Provider>
  );
}

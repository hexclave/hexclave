import React from "react";

import { Button, Spinner, Typography, cn } from "~/components/ui";

export const authFooterClassName = "mt-6 border-t border-black/[0.06] pt-5 text-center text-sm dark:border-white/[0.10]";
export const authFooterLinkClassName = "font-medium text-foreground/90 underline-offset-4 transition-colors hover:text-foreground hover:underline";

export function HostedAuthShell(props: {
  children: React.ReactNode,
  fullPage?: boolean,
  paddedFullPage?: boolean,
}) {
  const content = (
    <div
      className={cn(
        "stack-scope relative z-10 flex w-full max-w-[400px] flex-col items-stretch text-foreground",
        props.fullPage && props.paddedFullPage !== false ? "p-4 sm:p-6" : "p-0",
      )}
    >
      {props.children}
    </div>
  );

  if (!props.fullPage) {
    return content;
  }

  return (
    <div
      data-hexclave-handler-page
      className="stack-scope relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-background p-4 sm:p-6"
    >
      {content}
    </div>
  );
}

export function HostedAuthHeading(props: {
  title: string,
  children?: React.ReactNode,
}) {
  return (
    <div className="mb-6 text-center">
      <Typography type="h2" className="mb-1 text-xl font-semibold tracking-tight">{props.title}</Typography>
      {props.children != null && (
        <Typography className="text-sm text-muted-foreground">{props.children}</Typography>
      )}
    </div>
  );
}

type HostedAuthMessageAction = () => Promise<void> | void;
type HostedAuthMessageSecondaryActionProps =
  | {
    secondaryAction: HostedAuthMessageAction,
    secondaryText: string,
  }
  | {
    secondaryAction?: never,
    secondaryText?: never,
  };
type HostedAuthMessageActionProps =
  | ({
    primaryAction: HostedAuthMessageAction,
    primaryText: string,
  } & HostedAuthMessageSecondaryActionProps)
  | {
    primaryAction?: never,
    primaryText?: never,
    secondaryAction?: never,
    secondaryText?: never,
  };

export function HostedAuthMessage(props: {
  title: string,
  children: React.ReactNode,
  fullPage?: boolean,
} & HostedAuthMessageActionProps) {
  const hasPrimaryAction = props.primaryAction != null;
  const hasSecondaryAction = props.secondaryAction != null;

  return (
    <HostedAuthShell fullPage={props.fullPage}>
      <div className="text-center">
        <Typography type="h2" className="mb-2 text-xl font-semibold tracking-tight">{props.title}</Typography>
        <Typography className="text-sm text-muted-foreground">{props.children}</Typography>
      </div>
      {(hasPrimaryAction || hasSecondaryAction) && (
        <div className="mt-6 flex flex-col gap-2.5">
          {hasPrimaryAction && (
            <Button onClick={props.primaryAction} className="h-10 rounded-xl font-semibold shadow-sm hover:shadow">
              {props.primaryText}
            </Button>
          )}
          {hasSecondaryAction && (
            <Button variant="secondary" onClick={props.secondaryAction} className="h-10 rounded-xl font-semibold">
              {props.secondaryText}
            </Button>
          )}
        </div>
      )}
    </HostedAuthShell>
  );
}

/**
 * "Something is asking for access to your account — allow it?" card, shared by
 * every device-style authorization (CLI login, agent sign-in). Keeps the
 * icon/title/details/warning/two-button shape identical across flows so users
 * learn it once; callers only supply the words and the handlers.
 */
export function HostedAuthConsentCard(props: {
  icon: React.ReactNode,
  title: React.ReactNode,
  details?: React.ReactNode,
  warningTitle: string,
  warning: React.ReactNode,
  primaryText: string,
  primaryAction: HostedAuthMessageAction,
  secondaryText: string,
  secondaryAction: HostedAuthMessageAction,
  disabled?: boolean,
  fullPage?: boolean,
}) {
  return (
    <HostedAuthShell fullPage={props.fullPage}>
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          {props.icon}
        </div>
        <Typography type="h2" className="mb-2 text-xl font-semibold tracking-tight">
          {props.title}
        </Typography>
        {props.details}
      </div>

      <div className="mt-6 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-left">
        <Typography className="text-xs font-semibold text-destructive mb-1 uppercase tracking-wider">
          {props.warningTitle}
        </Typography>
        <Typography className="text-xs text-muted-foreground leading-relaxed">
          {props.warning}
        </Typography>
      </div>

      <div className="mt-6 flex flex-col gap-2.5">
        <Button
          onClick={props.primaryAction}
          disabled={props.disabled}
          className="h-10 rounded-xl font-semibold shadow-sm hover:shadow"
        >
          {props.primaryText}
        </Button>
        <Button
          variant="secondary"
          onClick={props.secondaryAction}
          disabled={props.disabled}
          className="h-10 rounded-xl font-semibold"
        >
          {props.secondaryText}
        </Button>
      </div>
    </HostedAuthShell>
  );
}

/** Error body used by the confirmation pages: a one-line summary plus a monospace detail box. */
export function HostedAuthErrorDetails(props: {
  summary: string,
  detail: string,
}) {
  return (
    <div className="flex flex-col gap-1 text-center">
      <Typography className="text-sm text-destructive">
        {props.summary}
      </Typography>
      <Typography className="text-xs text-muted-foreground font-mono bg-muted p-2 rounded-lg break-all">
        {props.detail}
      </Typography>
    </div>
  );
}

export function HostedAuthLoading(props: {
  fullPage?: boolean,
}) {
  return (
    <HostedAuthShell fullPage={props.fullPage}>
      <div className="flex min-h-24 items-center justify-center">
        <Spinner size={24} className="text-muted-foreground" />
      </div>
    </HostedAuthShell>
  );
}

export function HostedAuthFallback(props: {
  fullPage?: boolean,
}) {
  const content = (
    <div className="stack-scope flex w-full max-w-[400px] flex-col items-stretch p-4 sm:p-6">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="hosted-skeleton h-6 w-40 rounded-lg" />
        <div className="hosted-skeleton mt-2 h-3 w-56 rounded-full" />
      </div>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="hosted-skeleton h-3 w-16 rounded-full" />
          <div className="hosted-skeleton h-10 w-full rounded-xl" />
        </div>
        <div className="space-y-1.5">
          <div className="hosted-skeleton h-3 w-24 rounded-full" />
          <div className="hosted-skeleton h-10 w-full rounded-xl" />
        </div>
        <div className="hosted-skeleton h-10 w-full rounded-xl" />
      </div>
    </div>
  );

  if (!props.fullPage) {
    return content;
  }

  return (
    <div
      data-hexclave-handler-page
      className="stack-scope flex min-h-screen w-full items-center justify-center bg-background p-4 sm:p-6"
    >
      {content}
    </div>
  );
}

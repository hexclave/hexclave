import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useStackApp, useUser } from "@hexclave/react";
import { CircleUser, LogIn, LogOut, UserPlus, UserRound } from "lucide-react";
import React, { Suspense } from "react";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
} from "~/components/ui";

type HostedUser = {
  displayName?: string | null,
  primaryEmail?: string | null,
  profileImageUrl?: string | null,
};

function HostedUserAvatar(props: {
  user?: HostedUser | null,
  size?: number,
}) {
  const user = props.user;
  const size = props.size ?? 34;
  const fallbackText = (user?.displayName || user?.primaryEmail)?.slice(0, 2).toUpperCase();

  return (
    <Avatar
      className="ring-0 dark:ring-0"
      style={{ height: size, width: size }}
    >
      <AvatarImage src={user?.profileImageUrl || ""} />
      <AvatarFallback>
        {user != null ? (
          <div className="font-medium" style={{ fontSize: size * 0.4 }}>
            {fallbackText}
          </div>
        ) : (
          <UserRound className="text-zinc-500" size={size * 0.6} />
        )}
      </AvatarFallback>
    </Avatar>
  );
}

function HostedMenuItem(props: {
  text: string,
  icon: React.ReactNode,
  onClick: () => void | Promise<void>,
}) {
  return (
    <DropdownMenuItem
      onClick={() => runAsynchronouslyWithAlert(props.onClick())}
      className="group cursor-pointer rounded-lg px-2.5 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-foreground focus:bg-zinc-100 focus:text-foreground dark:text-zinc-300 dark:hover:bg-zinc-800/60 dark:focus:bg-zinc-800/60"
    >
      <div className="flex w-full items-center gap-2.5">
        {props.icon}
        <span>{props.text}</span>
      </div>
    </DropdownMenuItem>
  );
}

function HostedUserButtonInner() {
  const user = useUser();
  const app = useStackApp();
  const iconClassName = "h-4 w-4 text-zinc-500 transition-colors group-hover:text-foreground dark:text-zinc-400 dark:group-hover:text-foreground";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="stack-scope rounded-lg p-1.5 outline-none transition-colors hover:bg-muted/50 hover:transition-none">
        <HostedUserAvatar user={user} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="stack-scope w-64 rounded-xl border border-black/[0.08] bg-white/95 p-1.5 shadow-lg ring-1 ring-black/[0.06] backdrop-blur-md dark:border-white/[0.08] dark:bg-popover/95 dark:ring-white/[0.08]"
      >
        <DropdownMenuLabel className="px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <HostedUserAvatar user={user} size={36} />
            <div className="flex min-w-0 flex-col">
              {user != null ? (
                user.displayName ? (
                  <>
                    <span className="max-w-[160px] truncate text-sm font-semibold text-foreground">
                      {user.displayName}
                    </span>
                    <span className="mt-0.5 max-w-[160px] truncate text-xs font-normal text-zinc-500 dark:text-zinc-400">
                      {user.primaryEmail}
                    </span>
                  </>
                ) : (
                  <span className="max-w-[160px] truncate text-sm font-semibold text-foreground">
                    {user.primaryEmail}
                  </span>
                )
              ) : (
                <span className="text-sm font-medium">Not signed in</span>
              )}
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-1.5" />
        {user != null ? (
          <>
            <HostedMenuItem
              text="Account settings"
              onClick={() => app.redirectToAccountSettings()}
              icon={<CircleUser className={iconClassName} />}
            />
            <HostedMenuItem
              text="Sign out"
              onClick={() => user.signOut()}
              icon={<LogOut className={iconClassName} />}
            />
          </>
        ) : (
          <>
            <HostedMenuItem
              text="Sign in"
              onClick={() => app.redirectToSignIn()}
              icon={<LogIn className={iconClassName} />}
            />
            <HostedMenuItem
              text="Sign up"
              onClick={() => app.redirectToSignUp()}
              icon={<UserPlus className={iconClassName} />}
            />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function HostedUserButton() {
  return (
    <Suspense fallback={<Skeleton className="stack-scope h-[34px] w-[34px] rounded-full" />}>
      <HostedUserButtonInner />
    </Suspense>
  );
}

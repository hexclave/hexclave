"use client";

import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useState } from "react";
import { Button } from "./design";

// Shown to signed-in users who aren't approved reviewers. It must offer a way
// out: `useUser({ or: "redirect" })` only redirects when there is NO session,
// so a user signed in with the wrong account would otherwise be stuck here with
// no way to reach the sign-in page and pick a different account.
export function AccessDenied({
  accountLabel,
  onSignOut,
}: {
  accountLabel: string,
  onSignOut: () => Promise<void>,
}) {
  const [isSigningOut, setIsSigningOut] = useState(false);

  return (
    <div className="flex h-dvh items-center justify-center bg-background p-6">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-lg font-semibold text-foreground">Access denied</h1>
        <p className="text-sm text-muted-foreground">
          You are signed in as <span className="font-medium text-foreground">{accountLabel}</span>, but your account is not approved as a reviewer.
        </p>
        <Button
          variant="default"
          className="mt-5"
          disabled={isSigningOut}
          onClick={() => {
            setIsSigningOut(true);
            runAsynchronouslyWithAlert(onSignOut().finally(() => setIsSigningOut(false)));
          }}
        >
          {isSigningOut ? "Signing out…" : "Sign out and switch account"}
        </Button>
      </div>
    </div>
  );
}

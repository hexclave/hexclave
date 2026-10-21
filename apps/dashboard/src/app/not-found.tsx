"use client";

import ErrorPage from "@/components/error-page";
import { Link } from "@/components/link";
import { Button } from "@/components/ui";
import { useUser } from "@hexclave/next";

export default function NotFound() {
  const user = useUser();

  return <ErrorPage
    title="Oh no! 404"
    description="Page not found."
    redirectUrl="/"
    secondaryDescription={user == null ? <>
      Did you mean to <Link href="/handler/sign-in" className="underline">log in</Link>?
    </> : <>
      Signed in as {user.primaryEmail ?? user.displayName ?? user.id}. Wrong account?{" "}
      <Button variant="link" className="h-auto p-0 underline" onClick={async () => await user.signOut()}>
        Sign out
      </Button>
    </>}
    redirectText="Go home"
  />;
}

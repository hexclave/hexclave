'use client';

import Loading from "@/app/loading";
import { DesignAlert } from "@/components/design-components/alert";
import { useRouter } from "@/components/router";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import { useStackApp, useUser } from "@hexclave/next";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useMemo, useRef, useState } from "react";

export default function PreviewProjectRedirect() {
  const app = useStackApp();
  const user = useUser();
  const router = useRouter();
  const appInternals = useMemo(() => {
    const internals = app as any[hexclaveAppInternalsSymbol];
    if (
      !internals ||
      typeof internals.sendRequest !== "function" ||
      typeof internals.refreshOwnedProjects !== "function"
    ) {
      throw new Error("The Stack client app cannot send internal requests.");
    }
    return internals as {
      sendRequest: (path: string, options: RequestInit, type: string) => Promise<Response>,
      refreshOwnedProjects: () => Promise<void>,
    };
  }, [app]);
  const creating = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || creating.current) return;
    creating.current = true;

    runAsynchronously(
      async () => {
        const response = await appInternals.sendRequest(
          "/internal/preview/create-project",
          { method: "POST" },
          "client",
        );

        if (!response.ok) {
          const text = await response.text();
          throw new HexclaveAssertionError(`Failed to create preview project: ${response.status} ${text}`);
        }

        const body = await response.json();
        // Refresh the client-side owned-projects cache before navigating —
        // otherwise the [projectId] route's `useAdminApp` reads a stale list
        // that doesn't include the just-created project and calls `notFound()`.
        // (The normal create-project flow in page-client.tsx does the same.)
        await appInternals.refreshOwnedProjects();
        router.push(`/projects/${encodeURIComponent(body.project_id)}`);
      },
      {
        onError: () => {
          setError("The preview could not be opened. Reload the page to try again.");
        },
      },
    );
  }, [user, appInternals, router]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <DesignAlert
          variant="error"
          title="Preview unavailable"
          description={error}
          className="max-w-lg"
        />
      </main>
    );
  }

  return <Loading />;
}

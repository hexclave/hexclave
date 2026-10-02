"use client";

import { useRouter } from "@/components/router";
import { Spinner } from "@/components/ui";
import { useEffect, useRef } from "react";

export default function Page() {
  const router = useRouter();
  const hasRedirected = useRef(false);

  useEffect(() => {
    if (hasRedirected.current) return;
    hasRedirected.current = true;
    // A server redirect drops browser action IDs before the SDK can consume them.
    // Keep navigation in the client so the SDK initializes on the original URL.
    const destination = new URL(window.location.href);
    destination.pathname = "/projects";
    router.replace(destination.toString());
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner />
    </div>
  );
}

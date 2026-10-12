"use client";

import { Suspense, useEffect, useState } from "react";
import { HexclaveProvider, HexclaveTheme } from "@hexclave/next";
import { getHexclaveClientApp } from "../hexclave";
import Loading from "./loading";
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The Hexclave client app reads NEXT_PUBLIC_HEXCLAVE_* config that is injected at container
  // startup via the sentinel-replacement model. Construct it on the client (after the real values
  // have replaced the REPLACE_ME placeholders) rather than during build-time prerender, where the
  // SDK's eager projectId validation would reject the sentinel. This keeps the routes statically
  // prerenderable while deferring the "must be configured" check to first runtime use.
  const [app, setApp] = useState<ReturnType<typeof getHexclaveClientApp> | null>(null);
  useEffect(() => {
    setApp(getHexclaveClientApp());
  }, []);

  return (
    <html lang="en">
      <head>
        <title>Hexclave — MCP Review Tool</title>
      </head>
      <body>
        {app == null ? (
          <Loading />
        ) : (
          <HexclaveProvider app={app}>
            <HexclaveTheme>
              <Suspense fallback={<Loading />}>
                {children}
              </Suspense>
            </HexclaveTheme>
          </HexclaveProvider>
        )}
      </body>
    </html>
  );
}

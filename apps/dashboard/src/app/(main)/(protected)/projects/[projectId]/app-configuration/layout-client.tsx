"use client";

import { ConfigurationSourceBanner } from "@/components/configuration-source-banner";
import { Typography } from "@/components/ui";
import { AppConfigurationHubNav } from "./hub-nav";

export function AppConfigurationLayoutClient(props: {
  children: React.ReactNode,
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="mx-auto w-full min-w-0 px-4 pt-4 sm:px-6 sm:pt-6"
        style={{ maxWidth: 1250 }}
      >
        <header className="mb-4 space-y-1">
          <Typography type="h2" className="text-xl font-semibold tracking-tight sm:text-2xl">
            App Configuration
          </Typography>
        </header>
        <ConfigurationSourceBanner />
        <AppConfigurationHubNav />
      </div>
      {props.children}
    </div>
  );
}

"use client";

import { DesignAlert } from "@/components/design-components";
import { Typography } from "@/components/ui";
import { getPublicEnvVar } from "@/lib/env";
import { EnvironmentHubNav } from "./hub-nav";

export function EnvironmentLayoutClient(props: {
  children: React.ReactNode,
}) {
  const isDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="mx-auto w-full min-w-0 px-4 pt-4 sm:px-6 sm:pt-6"
        style={{ maxWidth: 1250 }}
      >
        <header className="mb-4 space-y-1">
          <Typography type="h2" className="text-xl font-semibold tracking-tight sm:text-2xl">
            Environment
          </Typography>
          <Typography type="p" variant="secondary" className="text-sm">
            Secrets, domains, and provider credentials for this environment.
          </Typography>
        </header>
        {isDevelopmentEnvironment && (
          <DesignAlert
            className="mb-4"
            variant="warning"
            title="Environment is read-only in development environments"
            description="Edit secrets, domains, and provider credentials in the production dashboard. Development environments sync versioned App Configuration from hexclave.config.ts instead."
          />
        )}
        <EnvironmentHubNav />
      </div>
      {props.children}
    </div>
  );
}

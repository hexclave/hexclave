"use client";

import { DesignAlert } from "@/components/design-components";
import { Typography } from "@/components/ui";
import { getPublicEnvVar } from "@/lib/env";
import { usePathname } from "next/navigation";
import { ProjectSettingsHubNav } from "./hub-nav";

const ENV_LOCKED_PATH_SUFFIXES = ["/domains", "/oauth", "/deployments"] as const;

export function ProjectSettingsLayoutClient(props: {
  children: React.ReactNode,
}) {
  const pathname = usePathname();
  const isDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";
  const isEnvLockedSection = ENV_LOCKED_PATH_SUFFIXES.some((suffix) => pathname.endsWith(suffix) || pathname.includes(`${suffix}/`));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="mx-auto w-full min-w-0 px-4 pt-4 sm:px-6 sm:pt-6"
        style={{ maxWidth: 1250 }}
      >
        <header className="mb-4 space-y-1">
          <Typography type="h2" className="text-xl font-semibold tracking-tight sm:text-2xl">
            Project Settings
          </Typography>
        </header>
        {isDevelopmentEnvironment && isEnvLockedSection && (
          <DesignAlert
            className="mb-4"
            variant="warning"
            title="Read-only in development environments"
            description="Edit domains, OAuth credentials, and deployment secrets in production. This environment syncs App Configuration from hexclave.config.ts."
          />
        )}
        <ProjectSettingsHubNav />
      </div>
      {props.children}
    </div>
  );
}

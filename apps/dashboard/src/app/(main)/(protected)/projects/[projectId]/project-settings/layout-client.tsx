"use client";

import { Typography } from "@/components/ui";
import { getPublicEnvVar } from "@/lib/env";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useProjectId } from "../use-admin-app";
import { isProjectSettingsEnvSectionPath } from "./env-sections";
import { ProjectSettingsHubNav } from "./hub-nav";

export function ProjectSettingsLayoutClient(props: {
  children: React.ReactNode,
}) {
  const pathname = usePathname();
  const router = useRouter();
  const projectId = useProjectId();
  const isDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";
  const isEnvSection = isProjectSettingsEnvSectionPath(pathname);
  const shouldHideEnvSection = isDevelopmentEnvironment && isEnvSection;

  useEffect(() => {
    if (!shouldHideEnvSection) {
      return;
    }
    // Deep links / old /domains redirects still hit these URLs on RDE — send them
    // to General rather than leaving a dead tab with a read-only warning.
    router.replace(urlString`/projects/${projectId}/project-settings`);
  }, [projectId, router, shouldHideEnvSection]);

  if (shouldHideEnvSection) {
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
            <Typography variant="secondary" className="text-sm">
              Environment-specific settings for this project&apos;s deployments.
            </Typography>
          </header>
          <ProjectSettingsHubNav />
        </div>
        <div className="flex flex-1 items-center justify-center p-8">
          <Typography variant="secondary" className="text-sm">
            Redirecting…
          </Typography>
        </div>
      </div>
    );
  }

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
          <Typography variant="secondary" className="text-sm">
            Environment-specific settings for this project&apos;s deployments.
          </Typography>
        </header>
        <ProjectSettingsHubNav />
      </div>
      {props.children}
    </div>
  );
}

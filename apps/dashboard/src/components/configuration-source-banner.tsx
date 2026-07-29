"use client";

import { Link } from "@/components/link";
import { DesignButton } from "@/components/design-components";
import { ActionDialog, useToast } from "@/components/ui";
import { getPublicEnvVar } from "@/lib/env";
import type { PushedConfigSource } from "@hexclave/next";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { ArrowSquareOutIcon, GithubLogoIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";

function ConnectionRow(props: {
  icon: ReactNode,
  title: ReactNode,
  subtitle: ReactNode,
  action: ReactNode,
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-black/[0.08] bg-zinc-50 px-4 py-3.5 dark:border-foreground/10 dark:bg-zinc-900/60">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center text-foreground">
          {props.icon}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {props.title}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {props.subtitle}
          </div>
        </div>
      </div>
      <div className="shrink-0">{props.action}</div>
    </div>
  );
}

function ConnectedGitSection(props: {
  children: ReactNode,
  description: string,
}) {
  // Plain solid panel — not DesignCard. DesignCard/bg-card stay transparent
  // (glassmorphic or not), so the page wash shows through as a blue tint.
  return (
    <section className="mb-4 space-y-4 rounded-xl border border-black/[0.08] bg-white p-5 dark:border-foreground/10 dark:bg-zinc-950">
      <div className="space-y-1">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          Connected Git repository
        </h3>
        <p className="text-sm text-muted-foreground">
          {props.description}
        </p>
      </div>
      {props.children}
    </section>
  );
}

export function ConfigurationSourceBanner() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const [configSource, setConfigSource] = useState<PushedConfigSource | null>(null);
  const [isLoadingSource, setIsLoadingSource] = useState(true);
  const { toast } = useToast();
  const isDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";

  useEffect(() => {
    runAsynchronouslyWithAlert(async () => {
      try {
        const source = await project.getPushedConfigSource();
        setConfigSource(source);
      } finally {
        setIsLoadingSource(false);
      }
    });
  }, [project]);

  const handleUnlinkSource = useCallback(async () => {
    await project.unlinkPushedConfigSource();
    setConfigSource({ type: "unlinked" });
    toast({ title: "Disconnected", description: "You can edit configuration directly on this dashboard." });
  }, [project, toast]);

  if (isLoadingSource) {
    return (
      <ConnectedGitSection description="Push commits to update App Configuration from your config file.">
        <div className="h-[58px] animate-pulse rounded-lg border border-black/[0.06] bg-foreground/[0.03] dark:border-foreground/10" />
      </ConnectedGitSection>
    );
  }

  if (configSource?.type === "pushed-from-github") {
    const repoHref = `https://github.com/${encodeURIComponent(configSource.owner)}/${encodeURIComponent(configSource.repo)}`;
    return (
      <ConnectedGitSection description="Seamlessly update App Configuration for any commits pushed to your Git repository.">
        <ConnectionRow
          icon={<GithubLogoIcon className="h-5 w-5" weight="fill" />}
          title={
            <a
              href={repoHref}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 transition-colors duration-150 hover:text-foreground/80 hover:transition-none"
            >
              {configSource.owner}/{configSource.repo}
              <ArrowSquareOutIcon className="h-3.5 w-3.5 text-muted-foreground" />
            </a>
          }
          subtitle={
            <>
              <span className="font-mono">{configSource.configFilePath}</span>
              {" · "}
              {configSource.branch}
              {" · "}
              <span className="font-mono">{configSource.commitHash.substring(0, 7)}</span>
            </>
          }
          action={
            <ActionDialog
              trigger={
                <DesignButton variant="secondary" size="sm">
                  Disconnect
                </DesignButton>
              }
              title="Disconnect GitHub"
              okButton={{
                label: "Disconnect",
                onClick: handleUnlinkSource,
              }}
              cancelButton
            >
              <p className="text-sm text-foreground">
                Disconnect this project from GitHub?
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                You can edit config on the dashboard again. Pushing from GitHub will not update this project until you reconnect.
              </p>
            </ActionDialog>
          }
        />
      </ConnectedGitSection>
    );
  }

  if (configSource?.type === "pushed-from-unknown") {
    return (
      <ConnectedGitSection description="Config is updated when you push via the Hexclave CLI.">
        <ConnectionRow
          icon={<TerminalWindowIcon className="h-5 w-5" weight="duotone" />}
          title="CLI"
          subtitle={<span className="font-mono">hexclave.config.ts</span>}
          action={
            <ActionDialog
              trigger={
                <DesignButton variant="secondary" size="sm">
                  Disconnect
                </DesignButton>
              }
              title="Disconnect CLI"
              okButton={{
                label: "Disconnect",
                onClick: handleUnlinkSource,
              }}
              cancelButton
            >
              <p className="text-sm text-foreground">
                Disconnect this project from the CLI?
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                You can edit config on the dashboard again. CLI pushes will not update this project until you reconnect.
              </p>
            </ActionDialog>
          }
        />
      </ConnectedGitSection>
    );
  }

  return (
    <ConnectedGitSection description="Connect a repository to update App Configuration from hexclave.config.ts on every push.">
      <ConnectionRow
        icon={<GithubLogoIcon className="h-5 w-5" weight="fill" />}
        title="No repository connected"
        subtitle="Config is edited on this dashboard until you connect GitHub."
        action={
          !isDevelopmentEnvironment ? (
            <DesignButton asChild variant="secondary" size="sm" className="gap-1.5 border border-input">
              <Link href={urlString`/new-project?project_id=${project.id}&mode=link-existing`}>
                <GithubLogoIcon className="h-3.5 w-3.5" />
                <span>Connect</span>
              </Link>
            </DesignButton>
          ) : (
            <span className="text-xs text-muted-foreground">Connect from production</span>
          )
        }
      />
    </ConnectedGitSection>
  );
}

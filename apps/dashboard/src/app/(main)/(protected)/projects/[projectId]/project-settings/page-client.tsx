"use client";
import { CopyableText } from "@/components/copyable-text";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import { SmartFormDialog } from "@/components/form-dialog";
import { Link, StyledLink } from "@/components/link";
import { LogoUpload } from "@/components/logo-upload";
import {
  DesignAlert,
  DesignButton,
  DesignCard,
  DesignEditableGrid,
  type DesignEditableGridItem,
} from "@/components/design-components";
import { ActionDialog, Avatar, AvatarFallback, AvatarImage, SimpleTooltip, Switch, useToast } from "@/components/ui";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import { getPublicEnvVar } from "@/lib/env";
import type { PushedConfigSource } from "@hexclave/next";
import { TeamSwitcher } from "@hexclave/next";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { ArrowsLeftRightIcon, BuildingsIcon, GearIcon, GithubLogoIcon, GlobeHemisphereWestIcon, ImageIcon, WarningIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as yup from "yup";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";

const projectInformationSchema = yup.object().shape({
  displayName: yup.string().defined(),
  description: yup.string(),
});

function TeamMemberItem({ member }: { member: any }) {
  const displayName = member.teamProfile.displayName?.trim() || "Name not set";
  const avatarFallback = displayName === "Name not set"
    ? "?"
    : displayName.charAt(0).toUpperCase();

  return (
    <li className="flex items-center gap-3 p-3">
      <Avatar className="h-10 w-10">
        <AvatarImage src={member.teamProfile.profileImageUrl || undefined} alt={displayName} />
        <AvatarFallback>{avatarFallback}</AvatarFallback>
      </Avatar>
      <div className="flex flex-col">
        <span className="text-sm font-medium text-foreground">{displayName}</span>
        {displayName === "Name not set" && (
          <span className="text-xs text-muted-foreground">
            Display name not set
          </span>
        )}
      </div>
    </li>
  );
}

export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const productionModeErrors = project.useProductionModeErrors();
  const user = useDashboardInternalUser();
  const teams = user.useTeams();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [isTransferring, setIsTransferring] = useState(false);
  const [configSource, setConfigSource] = useState<PushedConfigSource | null>(null);
  const [isLoadingSource, setIsLoadingSource] = useState(true);
  const [isProjectDetailsDialogOpen, setIsProjectDetailsDialogOpen] = useState(false);
  const { toast } = useToast();

  // Fetch config source on mount
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
    toast({ title: "Configuration source unlinked", description: "You can now edit the configuration directly on this dashboard." });
  }, [project, toast]);

  const baseApiUrl = getPublicEnvVar('NEXT_PUBLIC_STACK_API_URL');
  const isDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";

  // Memoize computed URLs
  const jwksUrl = useMemo(
    () => `${baseApiUrl}/api/v1/projects/${project.id}/.well-known/jwks.json`,
    [baseApiUrl, project.id]
  );

  const restrictedJwksUrl = useMemo(
    () => `${jwksUrl}?include_restricted=true`,
    [jwksUrl]
  );

  const allJwksUrl = useMemo(
    () => `${jwksUrl}?include_anonymous=true`,
    [jwksUrl]
  );

  // Memoize current owner team lookup
  const currentOwnerTeam = useMemo(
    () => teams.find(team => team.id === project.ownerTeamId) ?? throwErr(`Owner team of project ${project.id} not found in user's teams?`, { projectId: project.id, teams }),
    [teams, project.ownerTeamId, project.id]
  );

  // Check if user has team_admin permission for the current team
  const hasAdminPermissionForCurrentTeam = user.usePermission(currentOwnerTeam, "team_admin");

  // Memoize selected team lookup
  const selectedTeam = useMemo(
    () => teams.find(team => team.id === selectedTeamId),
    [teams, selectedTeamId]
  );

  const currentTeamMembers = currentOwnerTeam.useUsers();

  // Memoize team settings path
  const teamSettingsPath = useMemo(
    () => `/projects?team_settings=${encodeURIComponent(currentOwnerTeam.id)}`,
    [currentOwnerTeam.id]
  );

  const handleTransfer = useCallback(async () => {
    if (!selectedTeamId || selectedTeamId === project.ownerTeamId) return;
    if (isTransferring) return;

    setIsTransferring(true);
    try {
      await user.transferProject(project.id, selectedTeamId);

      toast({
        title: 'Project transferred successfully',
        variant: 'success'
      });

      // Reload the page to reflect changes
      // we don't actually need this, but it's a nicer UX as it clearly indicates to the user that a "big" change was made
      window.location.reload();
    } finally {
      setIsTransferring(false);
    }
  }, [selectedTeamId, project.ownerTeamId, project.id, user, toast, isTransferring]);

  // Memoize logo update callbacks
  const handleLogoChange = useCallback(async (logoUrl: string | null) => {
    await project.update({ logoUrl });
  }, [project]);

  const handleFullLogoChange = useCallback(async (logoFullUrl: string | null) => {
    await project.update({ logoFullUrl });
  }, [project]);

  // Memoize production mode change callback
  const handleProductionModeChange = useCallback(async (checked: boolean) => {
    await project.update({ isProductionMode: checked });
  }, [project]);

  // Memoize team switcher change callback
  const handleTeamSwitcherChange = useCallback(async (team: any) => {
    setSelectedTeamId(team.id);
  }, []);

  // Memoize project details submit callback
  const handleProjectDetailsSubmit = useCallback(async (values: any) => {
    await project.update(values);
  }, [project]);

  const projectDetailsDefaultValues = useMemo(() => ({
    displayName: project.displayName,
    description: project.description || undefined,
  }), [project.displayName, project.description]);

  const handleProjectDeleted = useCallback(async () => {
    await hexclaveAdminApp.redirectToHome();
  }, [hexclaveAdminApp]);

  const productionModeItems: DesignEditableGridItem[] = [
    {
      itemKey: "production-mode",
      type: "custom",
      icon: <GearIcon className="h-3.5 w-3.5" />,
      name: "Enable production mode",
      children: (
        <Switch
          checked={project.isProductionMode}
          disabled={!project.isProductionMode && productionModeErrors.length > 0}
          onCheckedChange={(checked) => {
            runAsynchronouslyWithAlert(handleProductionModeChange(checked));
          }}
        />
      ),
    },
  ];

  return (
    <PageLayout title="Project Settings" description="Manage your project" allowContentOverflow>
      <DesignCard
        title="Project Information"
        subtitle="Core identifiers and verification URLs for this project."
        icon={GlobeHemisphereWestIcon}
        glassmorphic
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Project ID</p>
            <CopyableText value={project.id} />
          </div>
          <DesignAlert
            variant="info"
            description={<>
              Looking for project API keys? Head over to the <StyledLink href={`/projects/${project.id}/project-keys`}>Project Keys</StyledLink> page.
            </>}
          />

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-foreground">JWKS URLs</p>
              <SimpleTooltip type="info" tooltip="Use these URLs to allow other services to verify Hexclave-issued sessions for this project.">
                <span className="sr-only">More info about JWKS URLs</span>
              </SimpleTooltip>
            </div>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 items-center text-sm">
              <span className="text-muted-foreground whitespace-nowrap">Standard</span>
              <CopyableText value={jwksUrl} />

              <div className="flex items-center gap-1 text-muted-foreground whitespace-nowrap">
                <span>+ Restricted</span>
                <SimpleTooltip type="info" tooltip="Includes keys for sessions of restricted users (e.g., unverified emails).">
                  <span className="sr-only">Info about restricted JWKS</span>
                </SimpleTooltip>
              </div>
              <CopyableText value={restrictedJwksUrl} />

              <div className="flex items-center gap-1 text-muted-foreground whitespace-nowrap">
                <span>+ Anonymous</span>
                <SimpleTooltip type="info" tooltip="Includes keys for anonymous sessions.">
                  <span className="sr-only">Info about anonymous JWKS</span>
                </SimpleTooltip>
              </div>
              <CopyableText value={allJwksUrl} />
            </div>
          </div>
        </div>
      </DesignCard>
      <DesignCard
        title="Project Details"
        subtitle="Display metadata shown to your users."
        icon={BuildingsIcon}
        glassmorphic
        actions={(
          <DesignButton size="sm" variant="secondary" onClick={() => setIsProjectDetailsDialogOpen(true)}>
            Edit
          </DesignButton>
        )}
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Display Name</p>
            <p className="text-sm text-foreground">{project.displayName}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Description</p>
            <p className="text-sm text-foreground/80">{project.description || "-"}</p>
          </div>
          <p className="text-xs text-muted-foreground">
            The display name and description may be publicly visible to the users of your app.
          </p>
        </div>
      </DesignCard>
      <SmartFormDialog
        open={isProjectDetailsDialogOpen}
        onOpenChange={setIsProjectDetailsDialogOpen}
        title="Edit Project Details"
        formSchema={projectInformationSchema}
        defaultValues={projectDetailsDefaultValues}
        onSubmit={handleProjectDetailsSubmit}
        okButton={{ label: "Save" }}
        cancelButton
      />

      <DesignCard
        title="Project Logo"
        subtitle="Configure branding assets for light and dark themes."
        icon={ImageIcon}
        glassmorphic
      >
        <div className="space-y-4">
          <LogoUpload
            label="Logo"
            value={project.logoUrl}
            onValueChange={handleLogoChange}
            description="Upload a logo for your project. Recommended size: 200x200px"
            type="logo"
          />

          <LogoUpload
            label="Full Logo"
            value={project.logoFullUrl}
            onValueChange={handleFullLogoChange}
            description="Upload a full logo with text. Recommended size: At least 100px tall, landscape format"
            type="full-logo"
          />

          <LogoUpload
            label="Logo (Dark Mode)"
            value={project.logoDarkModeUrl}
            onValueChange={async (logoDarkModeUrl) => {
              await project.update({ logoDarkModeUrl });
            }}
            description="Upload a dark mode version of your logo. Recommended size: 200x200px"
            type="logo"
          />

          <LogoUpload
            label="Full Logo (Dark Mode)"
            value={project.logoFullDarkModeUrl}
            onValueChange={async (logoFullDarkModeUrl) => {
              await project.update({ logoFullDarkModeUrl });
            }}
            description="Upload a dark mode version of your full logo. Recommended size: At least 100px tall, landscape format"
            type="full-logo"
          />

          <p className="text-xs text-muted-foreground">
            Logo images will be displayed in your application (e.g. login page) and emails. The logo should be a square image, while the full logo can include text and be wider.
          </p>
        </div>
      </DesignCard>

      <DesignCard
        title="Project Access"
        subtitle="See who can manage this project and transfer ownership if needed."
        icon={ArrowsLeftRightIcon}
        glassmorphic
      >
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <p className="text-base font-semibold text-foreground">
              {currentOwnerTeam.displayName || "Unnamed team"}
            </p>
            <p className="text-xs text-muted-foreground">
              Everyone in this team can access and manage the project.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Team members
              </p>
              <DesignButton asChild variant="secondary" size="sm">
                <Link href={teamSettingsPath}>
                  Manage team members
                </Link>
              </DesignButton>
            </div>
            {currentTeamMembers.length === 0 ? (
              <div className="rounded-lg border border-border/50 bg-muted/40 p-4">
                <p className="text-xs text-muted-foreground">
                  This team has no members yet.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-card">
                <ul className="divide-y divide-border/60">
                  {currentTeamMembers.map((member) => (
                    <TeamMemberItem key={member.id} member={member} />
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Invite new people or adjust roles in the team settings page.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Transfer to a different team
            </p>
            {!hasAdminPermissionForCurrentTeam ? (
              <DesignAlert variant="error">
                {`You need to be a team admin of "${currentOwnerTeam.displayName || 'the current team'}" to transfer this project.`}
              </DesignAlert>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-2">
                <TeamSwitcher
                  triggerClassName="w-full sm:w-96"
                  teamId={selectedTeamId || ""}
                  onChange={handleTeamSwitcherChange}
                />
                <ActionDialog
                  trigger={
                    <DesignButton
                      variant="secondary"
                      disabled={
                        !selectedTeam ||
                        selectedTeam.id === project.ownerTeamId ||
                        isTransferring
                      }
                    >
                      Transfer
                    </DesignButton>
                  }
                  title="Transfer Project"
                  okButton={{
                    label: "Transfer Project",
                    onClick: handleTransfer
                  }}
                  cancelButton
                >
                  <p className="text-sm text-foreground">
                    {`Are you sure you want to transfer "${project.displayName}" to ${selectedTeam?.displayName}?`}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    This will change the ownership of the project. Only team admins of the new team will be able to manage project settings.
                  </p>
                </ActionDialog>
              </div>
            )}
          </div>
        </div>
      </DesignCard>

      <DesignCard
        title="Production mode"
        subtitle="Production mode disallows development shortcuts considered unsafe for production."
        icon={GearIcon}
        glassmorphic
      >
        <div className="space-y-4">
          <DesignEditableGrid
            items={productionModeItems}
            columns={1}
            deferredSave={false}
          />

          {productionModeErrors.length === 0 ? (
            <DesignAlert
              variant="success"
              description="Your configuration is ready for production and production mode can be enabled."
            />
          ) : (
            <DesignAlert variant="error" title="Configuration not ready for production">
              <p className="text-sm text-foreground/80">
                Please fix the following issues:
              </p>
              <ul className="mt-2 list-disc pl-5">
                {productionModeErrors.map((error) => (
                  <li key={error.message}>
                    {error.message} (<StyledLink href={error.relativeFixUrl}>show configuration</StyledLink>)
                  </li>
                ))}
              </ul>
            </DesignAlert>
          )}
        </div>
      </DesignCard>

      <DesignCard
        title="Configuration Source"
        subtitle="Manage where your project configuration is managed from."
        icon={GlobeHemisphereWestIcon}
        glassmorphic
      >
        {isLoadingSource ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : configSource?.type === "unlinked" ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="text-sm font-semibold text-foreground">Dashboard</p>
              <p className="text-xs text-muted-foreground">
                Your configuration is managed directly on this dashboard. Changes take effect immediately when saved.
              </p>
            </div>
            {!isDevelopmentEnvironment && (
              <div>
                <DesignButton asChild variant="secondary" size="sm">
                  <Link href={urlString`/new-project?project_id=${project.id}&mode=link-existing`}>
                    <GithubLogoIcon className="mr-2 h-4 w-4" />
                    Link to GitHub
                  </Link>
                </DesignButton>
              </div>
            )}
          </div>
        ) : configSource?.type === "pushed-from-github" ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="text-sm font-semibold text-foreground">GitHub</p>
              <p className="text-xs text-muted-foreground">
                Your configuration is managed via GitHub. Changes made on this dashboard will be overwritten when you push from GitHub again.
              </p>
              <div className="mt-2 p-3 bg-muted rounded-md text-sm space-y-1">
                <div><strong>Repository:</strong> {configSource.owner}/{configSource.repo}</div>
                <div><strong>Branch:</strong> {configSource.branch}</div>
                <div><strong>Config file:</strong> {configSource.configFilePath}</div>
                {configSource.workflowPath ? (
                  <div>
                    <strong>Workflow file:</strong>{" "}
                    <a
                      className="underline"
                      target="_blank"
                      rel="noreferrer noopener"
                      href={`https://github.com/${encodeURIComponent(configSource.owner)}/${encodeURIComponent(configSource.repo)}/blob/${configSource.branch.split("/").map(encodeURIComponent).join("/")}/${configSource.workflowPath.split("/").map(encodeURIComponent).join("/")}`}
                    >
                      {configSource.workflowPath}
                    </a>
                  </div>
                ) : null}
                <div><strong>Last commit:</strong> <code className="text-xs">{configSource.commitHash.substring(0, 7)}</code></div>
              </div>
            </div>
            <div>
              <ActionDialog
                trigger={
                  <DesignButton variant="secondary" size="sm">
                    Unlink from GitHub
                  </DesignButton>
                }
                title="Unlink Configuration Source"
                okButton={{
                  label: "Unlink",
                  onClick: handleUnlinkSource,
                }}
                cancelButton
              >
                <p className="text-sm text-foreground">
                  Are you sure you want to unlink your configuration from GitHub?
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  After unlinking, you can edit the configuration directly on this dashboard. However, pushing from GitHub will no longer update your configuration until you reconnect.
                </p>
              </ActionDialog>
            </div>
          </div>
        ) : configSource?.type === "pushed-from-unknown" ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="text-sm font-semibold text-foreground">CLI</p>
              <p className="text-xs text-muted-foreground">
                Your configuration was pushed via the Hexclave CLI. Changes made on this dashboard will be overwritten when you push from the CLI again.
              </p>
            </div>
            <div>
              <ActionDialog
                trigger={
                  <DesignButton variant="secondary" size="sm">
                    Unlink from CLI
                  </DesignButton>
                }
                title="Unlink Configuration Source"
                okButton={{
                  label: "Unlink",
                  onClick: handleUnlinkSource,
                }}
                cancelButton
              >
                <p className="text-sm text-foreground">
                  Are you sure you want to unlink your configuration from the CLI?
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  After unlinking, you can edit the configuration directly on this dashboard. However, pushing from the CLI will no longer update your configuration until you reconnect.
                </p>
              </ActionDialog>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Unknown configuration source</p>
        )}
      </DesignCard>

      <DesignCard
        title="Danger Zone"
        subtitle="Irreversible and destructive actions."
        icon={WarningIcon}
        className="border-destructive/40 ring-1 ring-destructive/20"
        glassmorphic
      >
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-2 text-sm text-muted-foreground">
              Once you delete a project, there is no going back. All data will be permanently removed.
            </p>
            <DeleteProjectDialog
              project={project}
              onDeleted={handleProjectDeleted}
              trigger={
                <DesignButton variant="destructive" size="sm">
                  Delete Project
                </DesignButton>
              }
            />
          </div>
        </div>
      </DesignCard>
    </PageLayout>
  );
}

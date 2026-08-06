"use client";

import { CopyableText } from "@/components/copyable-text";
import { SmartFormDialog } from "@/components/form-dialog";
import { Link } from "@/components/link";
import { LogoUpload } from "@/components/logo-upload";
import {
  DesignAlert,
  DesignButton,
  DesignCard,
} from "@/components/design-components";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  ActionDialog,
  Avatar,
  AvatarFallback,
  AvatarImage,
  SimpleTooltip,
  useToast,
} from "@/components/ui";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import { getPublicEnvVar } from "@/lib/env";
import { TeamSwitcher } from "@hexclave/next";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { ArrowsLeftRightIcon, BuildingsIcon, WarningIcon } from "@phosphor-icons/react";
import { useCallback, useMemo, useState } from "react";
import * as yup from "yup";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";
import { ProductionModeCard } from "./production-mode-card";

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
  const user = useDashboardInternalUser();
  const teams = user.useTeams();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [isTransferring, setIsTransferring] = useState(false);
  const [isProjectDetailsDialogOpen, setIsProjectDetailsDialogOpen] = useState(false);
  const { toast } = useToast();

  const baseApiUrl = getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL");

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

  const currentOwnerTeam = useMemo(
    () => teams.find(team => team.id === project.ownerTeamId) ?? throwErr(`Owner team of project ${project.id} not found in user's teams?`, { projectId: project.id, teams }),
    [teams, project.ownerTeamId, project.id]
  );
  const hasAdminPermissionForCurrentTeam = user.usePermission(currentOwnerTeam, "team_admin");
  const selectedTeam = useMemo(
    () => teams.find(team => team.id === selectedTeamId),
    [teams, selectedTeamId]
  );
  const currentTeamMembers = currentOwnerTeam.useUsers();
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
        title: "Project transferred successfully",
        variant: "success",
      });
      window.location.reload();
    } finally {
      setIsTransferring(false);
    }
  }, [selectedTeamId, project.ownerTeamId, project.id, user, toast, isTransferring]);

  const handleLogoChange = useCallback(async (logoUrl: string | null) => {
    await project.update({ logoUrl });
  }, [project]);

  const handleFullLogoChange = useCallback(async (logoFullUrl: string | null) => {
    await project.update({ logoFullUrl });
  }, [project]);

  const handleTeamSwitcherChange = useCallback(async (team: any) => {
    setSelectedTeamId(team.id);
  }, []);

  const handleProjectDetailsSubmit = useCallback(async (values: any) => {
    await project.update(values);
  }, [project]);

  const projectDetailsDefaultValues = useMemo(() => ({
    displayName: project.displayName,
    description: project.description || undefined,
  }), [project.displayName, project.description]);

  const handleProjectDelete = useCallback(async () => {
    await project.delete();
    await hexclaveAdminApp.redirectToHome();
  }, [project, hexclaveAdminApp]);

  // Hub already provides the page title — avoid a second "General" header.
  return (
    <PageLayout allowContentOverflow>
      <DesignCard
        title="Project"
        subtitle="Identity and branding shown to your users."
        icon={BuildingsIcon}
        glassmorphic
        actions={(
          <DesignButton size="sm" variant="secondary" onClick={() => setIsProjectDetailsDialogOpen(true)}>
            Edit details
          </DesignButton>
        )}
      >
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Display name</p>
              <p className="text-sm text-foreground">{project.displayName}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Project ID</p>
              <CopyableText value={project.id} />
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Description</p>
            <p className="text-sm text-foreground/80">{project.description || "—"}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <LogoUpload
              label="Logo"
              value={project.logoUrl}
              onValueChange={handleLogoChange}
              description="Square, ~200×200px"
              type="logo"
            />
            <LogoUpload
              label="Full logo"
              value={project.logoFullUrl}
              onValueChange={handleFullLogoChange}
              description="Landscape with text"
              type="full-logo"
            />
            <LogoUpload
              label="Logo (dark)"
              value={project.logoDarkModeUrl}
              onValueChange={async (logoDarkModeUrl) => {
                await project.update({ logoDarkModeUrl });
              }}
              description="Square, ~200×200px"
              type="logo"
            />
            <LogoUpload
              label="Full logo (dark)"
              value={project.logoFullDarkModeUrl}
              onValueChange={async (logoFullDarkModeUrl) => {
                await project.update({ logoFullDarkModeUrl });
              }}
              description="Landscape with text"
              type="full-logo"
            />
          </div>

          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="jwks" className="border-border/60">
              <AccordionTrigger className="py-2 text-sm hover:no-underline">
                <span className="flex items-center gap-1.5">
                  JWKS URLs
                  <SimpleTooltip type="info" tooltip="Use these URLs to verify Hexclave-issued sessions for this project.">
                    <span className="sr-only">More info about JWKS URLs</span>
                  </SimpleTooltip>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 items-center text-sm pb-1">
                  <span className="text-muted-foreground whitespace-nowrap">Standard</span>
                  <CopyableText value={jwksUrl} />
                  <span className="text-muted-foreground whitespace-nowrap">+ Restricted</span>
                  <CopyableText value={restrictedJwksUrl} />
                  <span className="text-muted-foreground whitespace-nowrap">+ Anonymous</span>
                  <CopyableText value={allJwksUrl} />
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
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

      {/* Lived on Domains during the hub WIP; General is the right home so it
          stays reachable when Domains is hidden on development environments. */}
      <ProductionModeCard />

      <DesignCard
        title="Access"
        subtitle="Who can manage this project."
        icon={ArrowsLeftRightIcon}
        glassmorphic
        actions={(
          <DesignButton asChild variant="secondary" size="sm">
            <Link href={teamSettingsPath}>
              Manage team
            </Link>
          </DesignButton>
        )}
      >
        <div className="flex flex-col gap-5">
          <div>
            <p className="text-sm font-medium text-foreground">
              {currentOwnerTeam.displayName || "Unnamed team"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Owner team — members can access and manage this project.
            </p>
          </div>

          {currentTeamMembers.length === 0 ? (
            <p className="text-xs text-muted-foreground">This team has no members yet.</p>
          ) : (
            <div className="overflow-hidden rounded-xl ring-1 ring-black/[0.06] dark:ring-white/[0.06]">
              <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.06] bg-foreground/[0.02]">
                {currentTeamMembers.map((member) => (
                  <TeamMemberItem key={member.id} member={member} />
                ))}
              </ul>
            </div>
          )}

          <div className="border-t border-black/[0.06] pt-4 dark:border-white/[0.06]">
            <p className="mb-2 text-sm text-muted-foreground">Transfer ownership</p>
            {!hasAdminPermissionForCurrentTeam ? (
              <DesignAlert variant="error">
                {`You need to be a team admin of "${currentOwnerTeam.displayName || "the current team"}" to transfer this project.`}
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
                    onClick: handleTransfer,
                  }}
                  cancelButton
                >
                  <p className="text-sm text-foreground">
                    {`Transfer "${project.displayName}" to ${selectedTeam?.displayName}?`}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Only team admins of the new team will be able to manage project settings.
                  </p>
                </ActionDialog>
              </div>
            )}
          </div>
        </div>
      </DesignCard>

      <DesignCard
        title="Danger zone"
        subtitle="Irreversible actions."
        icon={WarningIcon}
        gradient="orange"
        glassmorphic
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Delete this project and all associated data permanently.
          </p>
          <ActionDialog
            trigger={
              <DesignButton variant="destructive" size="sm">
                Delete project
              </DesignButton>
            }
            title="Delete Project"
            danger
            okButton={{
              label: "Delete Project",
              onClick: handleProjectDelete,
            }}
            cancelButton
            confirmText="I understand this action is IRREVERSIBLE and will delete ALL associated data."
          >
            <p className="text-sm text-foreground">
              {`Delete "${project.displayName}" (${project.id})?`}
            </p>
            <p className="mt-2 text-sm text-foreground">
              This permanently deletes users, teams, API keys, configuration, and OAuth settings.
            </p>
          </ActionDialog>
        </div>
      </DesignCard>
    </PageLayout>
  );
}

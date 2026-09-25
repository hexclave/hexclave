"use client";

import { DesignDialog } from "@/components/design-components";
import { DesignButton } from "@/components/design-components/button";
import { DesignInput } from "@/components/design-components/input";
import { DesignSelectorDropdown } from "@/components/design-components/select";
import { useRouter } from "@/components/router";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Spinner,
  Typography,
} from "@/components/ui";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import { getPublicEnvVar } from "@/lib/env";
import { PlusCircleIcon } from "@phosphor-icons/react";
import { type AdminOwnedProject } from "@hexclave/next";
import { runAsynchronouslyWithAlert, wait } from "@hexclave/shared/dist/utils/promises";
import { useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  parseOnboardingAppSearchParam,
} from "./components";
import {
  CloudProjectOnboarding,
  createInitialCloudOnboardingState,
  type CloudProjectOnboardingState,
} from "./cloud-project-onboarding";
import { ProjectOnboardingWizard } from "./project-onboarding-wizard";
import {
  beginPendingAction,
  endPendingAction,
  getStackAppInternals,
  isProjectOnboardingState,
  type ProjectOnboardingStatus,
} from "./shared";

type PersistedOnboardingUpdate = {
  status?: ProjectOnboardingStatus,
  onboardingState?: unknown,
};

export default function PageClient() {
  return (
    <Suspense
      fallback={
        <div className="flex w-full flex-grow items-center justify-center">
          <Spinner size={24} />
        </div>
      }
    >
      <PageClientInner />
    </Suspense>
  );
}

function PageClientInner() {
  const user = useDashboardInternalUser();
  const teams = user.useTeams();
  const projects = user.useOwnedProjects();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isRemoteDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";
  const isDevelopmentEnvironment = isRemoteDevelopmentEnvironment;

  const selectedProjectId = searchParams.get("project_id");
  const displayNameFromSearch = searchParams.get("display_name");
  const redirectToNeonConfirmWith = searchParams.get("redirect_to_neon_confirm_with");
  const redirectToConfirmWith = searchParams.get("redirect_to_confirm_with");
  const mode = searchParams.get("mode");
  const primaryAppFromSearch = parseOnboardingAppSearchParam(searchParams.get("app"));

  const [projectStatuses, setProjectStatuses] = useState<Map<string, ProjectOnboardingStatus>>(new Map());
  const [projectOnboardingStates, setProjectOnboardingStates] = useState<Map<string, unknown>>(new Map());
  const [projectName, setProjectName] = useState(displayNameFromSearch ?? "");
  const hasProjectName = projectName.trim().length > 0;
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(() => user.selectedTeam?.id ?? teams.at(0)?.id ?? null);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [isCreateTeamOpen, setIsCreateTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const creatingTeamRef = useRef(false);
  const creatingProjectRef = useRef(false);

  const updateSearchParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(updates)) {
      if (value == null || value.length === 0) {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }

    const query = params.toString();
    router.replace(query.length > 0 ? `/new-project?${query}` : "/new-project");
  }, [router, searchParams]);

  const createProject = useCallback(async () => {
    if (!beginPendingAction(creatingProjectRef, setCreatingProject)) {
      return;
    }

    try {
      const trimmedProjectName = projectName.trim();
      if (trimmedProjectName.length === 0) {
        throw new Error("Project name is required.");
      }
      const firstTeam = teams.at(0);
      const teamId = selectedTeamId ?? user.selectedTeam?.id ?? firstTeam?.id;
      if (teamId === undefined) {
        throw new Error("Select a team before creating the project.");
      }

      const newProject = await user.createProject({
        displayName: trimmedProjectName,
        teamId,
        onboardingStatus: "config_choice",
      });
      const initialOnboardingState = createInitialCloudOnboardingState();
      const projectInternals = getStackAppInternals(newProject.app);
      const onboardingResponse = await projectInternals.sendRequest(
        "/internal/projects/current",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            onboarding_status: "config_choice",
            onboarding_state: initialOnboardingState,
          }),
        },
        "admin",
      );
      if (!onboardingResponse.ok) {
        throw new Error(`Failed to initialize onboarding: ${onboardingResponse.status} ${await onboardingResponse.text()}`);
      }

      setProjectStatuses((previous) => {
        const next = new Map(previous);
        next.set(newProject.id, "config_choice");
        return next;
      });
      setProjectOnboardingStates((previous) => {
        const next = new Map(previous);
        next.set(newProject.id, initialOnboardingState);
        return next;
      });

      if (redirectToNeonConfirmWith != null) {
        const confirmSearchParams = new URLSearchParams(redirectToNeonConfirmWith);
        confirmSearchParams.set("default_selected_project_id", newProject.id);
        router.push(`/integrations/neon/confirm?${confirmSearchParams.toString()}`);
        await wait(2000);
        return;
      }

      if (redirectToConfirmWith != null) {
        const confirmSearchParams = new URLSearchParams(redirectToConfirmWith);
        confirmSearchParams.set("default_selected_project_id", newProject.id);
        router.push(`/integrations/custom/confirm?${confirmSearchParams.toString()}`);
        await wait(2000);
        return;
      }

      const nextSearchParams = new URLSearchParams({ project_id: newProject.id });
      if (primaryAppFromSearch != null) {
        nextSearchParams.set("app", primaryAppFromSearch);
      }
      router.replace(`/new-project?${nextSearchParams.toString()}`);
    } finally {
      endPendingAction(creatingProjectRef, setCreatingProject);
    }
  }, [primaryAppFromSearch, projectName, redirectToConfirmWith, redirectToNeonConfirmWith, router, selectedTeamId, teams, user]);

  const handleCreateProjectSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hasProjectName || creatingProject) {
      return;
    }

    runAsynchronouslyWithAlert(createProject());
  }, [createProject, creatingProject, hasProjectName]);

  const selectedProject = useMemo(() => {
    if (selectedProjectId == null) {
      return null;
    }
    return projects.find((project) => project.id === selectedProjectId) ?? null;
  }, [projects, selectedProjectId]);

  const selectedProjectStatus = useMemo(() => {
    if (selectedProjectId == null || selectedProject == null) {
      return null;
    }
    return projectStatuses.get(selectedProjectId) ?? selectedProject.onboardingStatus;
  }, [projectStatuses, selectedProject, selectedProjectId]);

  const selectedProjectOnboardingState = useMemo(() => {
    if (selectedProjectId == null || selectedProject == null) {
      return null;
    }
    if (projectOnboardingStates.has(selectedProjectId)) {
      return projectOnboardingStates.get(selectedProjectId) ?? null;
    }
    return selectedProject.onboardingState ?? null;
  }, [projectOnboardingStates, selectedProject, selectedProjectId]);

  const isCompletedProjectRelinking = selectedProjectStatus === "completed" && (
    mode === "link-existing"
    || mode === "deploy-local"
    || mode === "deploy-github"
  );

  useEffect(() => {
    if (selectedProject == null || selectedProjectStatus !== "completed") {
      return;
    }
    // Re-linking starts in link-existing mode, then switches to a deployment-
    // specific mode. Keep every stage on this page for completed projects.
    if (isCompletedProjectRelinking) {
      return;
    }

    router.replace(`/projects/${encodeURIComponent(selectedProject.id)}`);
  }, [isCompletedProjectRelinking, router, selectedProject, selectedProjectStatus]);

  const saveSelectedProjectOnboardingProgress = async (project: AdminOwnedProject, update: PersistedOnboardingUpdate) => {
    const projectInternals = getStackAppInternals(project.app);
    const body: Record<string, unknown> = {};
    if (update.status !== undefined) {
      body.onboarding_status = update.status;
    }
    if ("onboardingState" in update) {
      body.onboarding_state = update.onboardingState ?? null;
    }

    const response = await projectInternals.sendRequest(
      "/internal/projects/current",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      "admin",
    );

    if (!response.ok) {
      throw new Error(`Failed to update onboarding progress: ${response.status} ${await response.text()}`);
    }

    const nextStatus = update.status;
    if (nextStatus !== undefined) {
      setProjectStatuses((previous) => {
        const next = new Map(previous);
        next.set(project.id, nextStatus);
        return next;
      });
    }

    if ("onboardingState" in update) {
      const nextOnboardingState = update.onboardingState ?? null;
      setProjectOnboardingStates((previous) => {
        const next = new Map(previous);
        next.set(project.id, nextOnboardingState);
        return next;
      });
    }
  };

  if (isDevelopmentEnvironment && selectedProjectId == null) {
    const developmentEnvironmentName = "development environment";
    return (
      <div className="w-full flex-grow flex items-center justify-center p-4">
        <div className="max-w-lg w-full rounded-lg border border-border p-6 space-y-4">
          <Typography type="h2">Project creation is disabled in development environment mode</Typography>
          <Typography variant="secondary">
            Use the Projects page to open the project created for this {developmentEnvironmentName}.
          </Typography>
          <div className="flex justify-end">
            <Button onClick={async () => {
              router.push("/projects");
              await wait(2000);
            }}>
              Go to Projects
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (selectedProjectId != null && selectedProject == null) {
    return (
      <div className="w-full flex-grow flex items-center justify-center p-4">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>Project not found</CardTitle>
            <CardDescription>We could not find the project in your account.</CardDescription>
          </CardHeader>
          <CardContent className="flex justify-end">
            <Button variant="outline" onClick={() => router.push("/projects")}>Go to Projects</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (selectedProject != null && selectedProjectStatus === "completed" && !isCompletedProjectRelinking) {
    return (
      <div className="flex w-full flex-grow items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  if (selectedProject != null && selectedProjectStatus == null) {
    throw new Error(`Missing onboarding status for project ${selectedProject.id}.`);
  }

  if (selectedProject == null) {
    return (
      <div className="flex w-full flex-grow justify-center">
        <DesignDialog
          open
          onOpenChange={(open) => {
            if (open || creatingProjectRef.current) {
              return;
            }
            if (projects.length > 0) {
              router.push("/projects");
            }
          }}
          size="lg"
          icon={PlusCircleIcon}
          title="Name your project"
          description="Choose a name and the team that will own this Hexclave project."
          hideTopCloseButton={creatingProject || projects.length === 0}
          footer={(
            <>
              {projects.length > 0 && (
                <DesignButton
                  type="button"
                  variant="outline"
                  onClick={() => router.push("/projects")}
                  disabled={creatingProject}
                >
                  Back
                </DesignButton>
              )}
              <DesignButton
                type="submit"
                form="create-project-form"
                disabled={!hasProjectName || selectedTeamId == null || creatingProject}
                loading={creatingProject}
              >
                Continue
              </DesignButton>
            </>
          )}
        >
          <form id="create-project-form" onSubmit={handleCreateProjectSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="project-name">Project name</Label>
              <DesignInput
                id="project-name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="My Project"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="team-id">Team</Label>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <DesignSelectorDropdown
                  value={selectedTeamId ?? ""}
                  onValueChange={setSelectedTeamId}
                  placeholder="Select a team"
                  size="md"
                  className="w-full"
                  options={teams.map((team) => ({ value: team.id, label: team.displayName }))}
                />
                <DesignButton type="button" variant="outline" onClick={() => setIsCreateTeamOpen(true)} className="sm:min-w-[140px]">
                  <PlusCircleIcon className="mr-2 h-4 w-4" />
                  New team
                </DesignButton>
              </div>
            </div>
          </form>
        </DesignDialog>

        <DesignDialog
          open={isCreateTeamOpen}
          onOpenChange={(open) => {
            if (!creatingTeam) {
              setIsCreateTeamOpen(open);
            }
          }}
          size="md"
          icon={PlusCircleIcon}
          title="Create a team"
          description="The new team will be selected as this project's owner."
          hideTopCloseButton={creatingTeam}
          footer={(
            <>
              <DesignButton variant="outline" onClick={() => setIsCreateTeamOpen(false)} disabled={creatingTeam}>
                Cancel
              </DesignButton>
              <DesignButton
                loading={creatingTeam}
                onClick={() => {
                  if (!beginPendingAction(creatingTeamRef, setCreatingTeam)) {
                    return;
                  }

                  return runAsynchronouslyWithAlert(async () => {
                    const trimmedTeamName = newTeamName.trim();
                    if (trimmedTeamName.length === 0) {
                      throw new Error("Team name is required.");
                    }

                    try {
                      const createdTeam = await user.createTeam({
                        displayName: trimmedTeamName,
                      });
                      await user.setSelectedTeam(createdTeam.id);
                      setSelectedTeamId(createdTeam.id);
                      setNewTeamName("");
                      setIsCreateTeamOpen(false);
                    } finally {
                      endPendingAction(creatingTeamRef, setCreatingTeam);
                    }
                  });
                }}
              >
                Create Team
              </DesignButton>
            </>
          )}
        >
          <div className="space-y-2">
            <Label htmlFor="new-team-name">Team name</Label>
            <DesignInput
              id="new-team-name"
              value={newTeamName}
              onChange={(event) => setNewTeamName(event.target.value)}
              placeholder="Acme Team"
              autoFocus
            />
          </div>
        </DesignDialog>
      </div>
    );
  }

  if (!isDevelopmentEnvironment && !isCompletedProjectRelinking) {
    return (
      <div className="flex w-full flex-grow justify-center">
        <CloudProjectOnboarding
          project={selectedProject}
          status={selectedProjectStatus ?? "config_choice"}
          onboardingState={selectedProjectOnboardingState}
          primaryAppFromQuery={primaryAppFromSearch}
          saveProgress={(update: {
            status?: ProjectOnboardingStatus,
            onboardingState: CloudProjectOnboardingState,
          }) => saveSelectedProjectOnboardingProgress(selectedProject, update)}
          onComplete={() => router.push(`/projects/${encodeURIComponent(selectedProject.id)}`)}
        />
      </div>
    );
  }

  // Completed-project relinking is independent from first-time onboarding and
  // does not need the retained cloud completion state.
  const legacyOnboardingState = isCompletedProjectRelinking ? null : selectedProjectOnboardingState;
  if (legacyOnboardingState != null && !isProjectOnboardingState(legacyOnboardingState)) {
    throw new Error(`Project ${selectedProject.id} returned an invalid development-environment onboarding state.`);
  }

  return (
    <div className="flex w-full flex-grow justify-center">
      <ProjectOnboardingWizard
        project={selectedProject}
        status={selectedProjectStatus ?? "config_choice"}
        onboardingState={legacyOnboardingState}
        mode={mode}
        setMode={(nextMode) => updateSearchParams({ mode: nextMode })}
        saveOnboardingProgress={(update) => saveSelectedProjectOnboardingProgress(selectedProject, update)}
        onComplete={() => {
          const projectUrl = `/projects/${encodeURIComponent(selectedProject.id)}`;
          if (mode === "deploy-local" || mode === "deploy-github") {
            window.location.href = projectUrl;
            return;
          }
          router.push(projectUrl);
        }}
      />
    </div>
  );
}

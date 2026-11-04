"use client";

import { DesignButton, DesignCard } from "@/components/design-components";
import { Link } from "@/components/link";
import { Skeleton, Typography } from "@/components/ui";
import { UserTeamPicker } from "@/components/user-team-picker";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import { getPlanUpgradeLabel, getPlanUpgradeSummary, parseTargetPlanId, startPlanCheckout } from "@/lib/plan-upgrade";
import { type Team } from "@hexclave/next";
import { PLAN_DISPLAY_NAMES, isPlanUpgrade, resolvePlanId, type PaidPlanId } from "@hexclave/shared/dist/plans";
import { useQueryState } from "@hexclave/shared/dist/utils/react";
import { RocketLaunchIcon } from "@phosphor-icons/react";
import { Suspense, useState } from "react";

function TeamUpgradeAction({ team, targetPlanId }: { team: Team, targetPlanId: PaidPlanId }) {
  const currentPlanId = resolvePlanId(team.useProducts());

  if (!isPlanUpgrade(currentPlanId, targetPlanId)) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Typography variant="secondary" className="text-sm">
          {team.displayName} is already on the {PLAN_DISPLAY_NAMES[currentPlanId]} plan.
        </Typography>
        <DesignButton variant="secondary" asChild>
          <Link href="/projects">Go to your projects</Link>
        </DesignButton>
      </div>
    );
  }

  return (
    <DesignButton
      className="w-full sm:w-auto"
      onClick={() => startPlanCheckout({
        team,
        planId: targetPlanId,
        returnUrl: new URL("/projects", window.location.origin).toString(),
      })}
    >
      {getPlanUpgradeLabel(targetPlanId)}
    </DesignButton>
  );
}

/**
 * Where the pricing page's paid "Get started" buttons land
 * (`/upgrade?plan=team` or `/upgrade?plan=growth`): pick a team and go
 * straight to the checkout for that plan.
 */
export default function PageClient() {
  const user = useDashboardInternalUser();
  const [planParam] = useQueryState("plan");
  const targetPlanId = parseTargetPlanId(planParam);
  const teams = user.useTeams();
  const [team, setTeam] = useState<Team | null>(user.selectedTeam ?? teams.at(0) ?? null);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4 py-12">
      <DesignCard
        title={`Upgrade to ${PLAN_DISPLAY_NAMES[targetPlanId]}`}
        subtitle={getPlanUpgradeSummary(targetPlanId)}
        icon={RocketLaunchIcon}
      >
        {team == null ? (
          <div className="flex flex-col gap-3">
            <Typography variant="secondary" className="text-sm">
              Plans belong to a team, and you don&apos;t have one yet. Create a project first; it comes with a team you can upgrade.
            </Typography>
            <DesignButton asChild className="w-full sm:w-auto">
              <Link href="/new-project">Create a project</Link>
            </DesignButton>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {teams.length > 1 && (
              <div className="flex flex-col gap-2">
                <Typography className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Team to upgrade
                </Typography>
                <UserTeamPicker user={user} value={team} onChange={setTeam} />
              </div>
            )}
            <Suspense key={team.id} fallback={<Skeleton className="h-9 w-56 rounded-md" />}>
              <TeamUpgradeAction team={team} targetPlanId={targetPlanId} />
            </Suspense>
          </div>
        )}
      </DesignCard>
    </div>
  );
}

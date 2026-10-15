"use client";

import { useDashboardInternalUser } from "@/lib/dashboard-user";
import type { Team } from "@hexclave/next";
import type { ReactNode } from "react";

/**
 * Renders `children` with one of the dashboard user's own teams, or null if `teamId` is null or the user isn't a
 * member. Use this (rather than searching `user.useTeams()`, which only holds the first 200 teams) for optional
 * lookups such as a project's owner team; `useTeam` is a hook, so it can't be skipped when there's no team ID.
 */
export function WithDashboardUserTeam(props: { teamId: string | null, children: (team: Team | null) => ReactNode }) {
  if (props.teamId == null) {
    return <>{props.children(null)}</>;
  }
  return <WithDashboardUserTeamById teamId={props.teamId}>{props.children}</WithDashboardUserTeamById>;
}

function WithDashboardUserTeamById(props: { teamId: string, children: (team: Team | null) => ReactNode }) {
  const team = useDashboardInternalUser().useTeam(props.teamId);
  return <>{props.children(team)}</>;
}

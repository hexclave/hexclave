
import { useEffect, useState } from "react";
import { Team } from "@hexclave/react";
import { useUser } from "@hexclave/react";
import { PageLayout } from "../page-layout";
import { PaymentsPanel } from "./payments-panel";
import { DashboardTeamSwitcher } from "../supporting/dashboard-team-switcher";

const emptyTeams: Team[] = [];

export function PaymentsPage(props: { mockMode?: boolean, availableTeams?: Team[], allowPersonal?: boolean }) {
  const user = useUser({ or: props.mockMode ? "return-null" : "redirect" });
  const userTeams = user?.useTeams() ?? emptyTeams;
  const teams = props.availableTeams ?? userTeams;
  const allowPersonal = props.allowPersonal ?? true;
  const hasTeams = teams.length > 0;
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const effectiveSelectedTeam = selectedTeam ?? (!allowPersonal ? (teams[0] ?? null) : null);
  const customer = effectiveSelectedTeam ?? (allowPersonal ? user : null);
  const customerType = effectiveSelectedTeam ? "team" : "user";

  useEffect(() => {
    if (props.mockMode) {
      return;
    }
    if (!allowPersonal && !selectedTeam && teams.length > 0) {
      setSelectedTeam(teams[0]);
      return;
    }
    if (selectedTeam && !teams.some(team => team.id === selectedTeam.id)) {
      setSelectedTeam(allowPersonal ? null : (teams[0] ?? null));
    }
  }, [allowPersonal, props.mockMode, selectedTeam, teams]);

  if (props.mockMode) {
    return (
      <PageLayout>
        <PaymentsPanel
          mockMode
        />
      </PageLayout>
    );
  }

  if (!customer) {
    return null;
  }

  return (
    <PageLayout>
      {hasTeams ? (
        <div className="flex flex-col gap-1.5 max-w-[240px]">
          <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Account Billing context</span>
          <DashboardTeamSwitcher
            team={effectiveSelectedTeam ?? undefined}
            teams={teams}
            allowNull={allowPersonal}
            nullLabel="Personal Account"
            onChange={async (team) => {
              setSelectedTeam(team);
            }}
          />
        </div>
      ) : null}
      <PaymentsPanel
        customer={customer}
        customerType={customerType}
      />
    </PageLayout>
  );
}

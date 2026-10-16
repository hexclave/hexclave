'use client';

import { useEffect, useState } from "react";
import { Team, TeamSwitcher } from "../../..";
import { useUser } from "../../../lib/hooks";
import { useTranslation } from "../../../lib/translations";
import { PageLayout } from "../page-layout";
import { PaymentsPanel } from "./payments-panel";

export function PaymentsPage(props: {
  mockMode?: boolean,
  /** Teams the user can manage billing for; computed by the caller, since `useTeams()` is capped at one page. */
  availableTeams: Team[],
  allowPersonal?: boolean,
}) {
  const { t } = useTranslation();
  const user = useUser({ or: props.mockMode ? "return-null" : "redirect" });
  const teams = props.availableTeams;
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
        <TeamSwitcher
          team={effectiveSelectedTeam ?? undefined}
          teams={teams}
          allowNull={allowPersonal}
          nullLabel={t("Personal")}
          onChange={async (team) => {
            setSelectedTeam(team);
          }}
        />
      ) : null}
      <PaymentsPanel
        customer={customer}
        customerType={customerType}
      />
    </PageLayout>
  );
}

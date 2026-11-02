"use client";

import { EntityKpiCards } from "@/components/entity-kpi-cards";
import type { MetricsEntityKpis } from "@/lib/hexclave-app-internals";

export function UsersKpiCards(props: {
  kpis: MetricsEntityKpis | null,
  error?: unknown,
}) {
  return (
    <EntityKpiCards
      errorTag="users-kpi-cards-error-boundary"
      kpis={props.kpis}
      error={props.error}
      labels={{
        newCard: { label: "New Sign-ups", comparisonLabel: "signups" },
        activeCard: { label: "Daily Active Users", comparisonLabel: "DAU" },
        returningCard: { label: "Returning User Rate" },
        totalCard: { label: "Total Users", comparisonLabel: "total users" },
      }}
    />
  );
}

"use client";

import { EntityKpiCards } from "@/components/entity-kpi-cards";
import { fetchEntityKpisOrThrow, type MetricsEntityKpis } from "@/lib/hexclave-app-internals";
import { useEffect, useState } from "react";
import { useAdminApp } from "../use-admin-app";

export function TeamsKpiCards() {
  const hexclaveAdminApp = useAdminApp();
  const [kpis, setKpis] = useState<MetricsEntityKpis | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setKpis(null);
    setError(null);
    fetchEntityKpisOrThrow(hexclaveAdminApp, "teams").then(
      (result) => {
        if (!cancelled) setKpis(result);
      },
      (e: unknown) => {
        if (!cancelled) setError(e);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [hexclaveAdminApp]);

  return (
    <EntityKpiCards
      errorTag="teams-kpi-cards-error-boundary"
      kpis={kpis}
      error={error}
      labels={{
        newCard: { label: "New Active Teams", comparisonLabel: "new teams" },
        activeCard: { label: "Daily Active Teams", comparisonLabel: "DAT" },
        returningCard: { label: "Returning Team Rate" },
        totalCard: { label: "Total Teams", comparisonLabel: "total teams" },
      }}
    />
  );
}

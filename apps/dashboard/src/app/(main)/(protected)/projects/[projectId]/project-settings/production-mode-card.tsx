"use client";

import { DesignAlert, DesignCard, DesignEditableGrid, type DesignEditableGridItem } from "@/components/design-components";
import { StyledLink } from "@/components/link";
import { Switch } from "@/components/ui";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { GearIcon } from "@phosphor-icons/react";
import { useCallback, useMemo } from "react";
import { useAdminApp } from "../use-admin-app";

export function ProductionModeCard() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const productionModeErrors = project.useProductionModeErrors();

  const handleProductionModeChange = useCallback(async (checked: boolean) => {
    await project.update({ isProductionMode: checked });
  }, [project]);

  const productionModeItems: DesignEditableGridItem[] = useMemo(() => [
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
  ], [project.isProductionMode, productionModeErrors.length, handleProductionModeChange]);

  return (
    <DesignCard
      title="Production mode"
      subtitle="Disallows development shortcuts considered unsafe for production."
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
            description="Ready for production — you can enable production mode."
          />
        ) : (
          <DesignAlert variant="error" title="Not ready for production">
            <ul className="mt-1 list-disc pl-5">
              {productionModeErrors.map((error) => (
                <li key={error.message}>
                  {error.message} (<StyledLink href={error.relativeFixUrl}>fix</StyledLink>)
                </li>
              ))}
            </ul>
          </DesignAlert>
        )}
      </div>
    </DesignCard>
  );
}

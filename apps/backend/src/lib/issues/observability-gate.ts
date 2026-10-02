import type { Tenancy } from "@/lib/tenancies";
import { KnownErrors } from "@hexclave/shared";

export function isObservabilityAppEnabled(tenancy: Tenancy): boolean {
  return tenancy.config.apps.installed["observability"]?.enabled === true;
}

export function assertObservabilityEnabled(tenancy: Tenancy): void {
  if (!isObservabilityAppEnabled(tenancy)) {
    throw new KnownErrors.ObservabilityNotEnabled();
  }
}

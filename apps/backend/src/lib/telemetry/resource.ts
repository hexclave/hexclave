import type { TelemetryResource } from "@hexclave/shared/dist/utils/analytics-wire";
import { stripLoneSurrogates } from "@/lib/clickhouse";

export function buildTelemetryResourceFields(resource: TelemetryResource) {
  return {
    service_namespace: resource.service.namespace ?? null,
    service_name: resource.service.name,
    service_version: resource.service.version ?? null,
    service_instance_id: resource.service.instanceId ?? null,
    deployment_environment_name: resource.deploymentEnvironmentName ?? null,
    resource_attributes: JSON.stringify(stripLoneSurrogates(resource.attributes ?? {})),
  };
}

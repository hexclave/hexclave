import type { RowData } from "../analytics/shared";

export type ServiceIdentity = {
  namespace: string,
  name: string,
};

const ALL_SERVICES_SELECT_VALUE = "all";
const SERVICE_SELECT_VALUE_PREFIX = "service:";

export function namespacedSelectValue(value: string | null, prefix: string): string {
  return value == null ? ALL_SERVICES_SELECT_VALUE : `${prefix}${encodeURIComponent(value)}`;
}

export function selectValueToNamespacedValue(value: string, prefix: string): string | null {
  if (value === ALL_SERVICES_SELECT_VALUE) return null;
  if (!value.startsWith(prefix)) throw new Error(`Unexpected namespaced select value: ${value}`);
  return decodeURIComponent(value.slice(prefix.length));
}

export function serviceIdentityEquals(left: ServiceIdentity, right: ServiceIdentity): boolean {
  return left.namespace === right.namespace && left.name === right.name;
}

export function serviceIdentityLabel(identity: ServiceIdentity): string {
  return identity.namespace === "" ? identity.name : `${identity.namespace}/${identity.name}`;
}

export function serviceIdentityToSelectValue(identity: ServiceIdentity | null): string {
  if (identity == null) return ALL_SERVICES_SELECT_VALUE;
  if (identity.name === "") {
    throw new Error("A service identity must have a non-empty name");
  }
  return `${SERVICE_SELECT_VALUE_PREFIX}${encodeURIComponent(identity.namespace)}/${encodeURIComponent(identity.name)}`;
}

export function selectValueToServiceIdentity(value: string): ServiceIdentity | null {
  if (value === ALL_SERVICES_SELECT_VALUE) return null;
  if (!value.startsWith(SERVICE_SELECT_VALUE_PREFIX)) {
    throw new Error(`Unexpected service select value: ${value}`);
  }
  const encodedIdentity = value.slice(SERVICE_SELECT_VALUE_PREFIX.length);
  const separator = encodedIdentity.indexOf("/");
  if (separator < 0) {
    throw new Error(`Malformed service select value: ${value}`);
  }
  const identity = {
    namespace: decodeURIComponent(encodedIdentity.slice(0, separator)),
    name: decodeURIComponent(encodedIdentity.slice(separator + 1)),
  };
  if (identity.name === "") {
    throw new Error("A service identity must have a non-empty name");
  }
  return identity;
}

export function parseServiceIdentityRow(row: RowData): ServiceIdentity {
  const namespaceValue = row.service_namespace;
  const nameValue = row.service_name;
  if (namespaceValue != null && typeof namespaceValue !== "string") {
    throw new Error("Analytics service_namespace must be a string or null");
  }
  if (typeof nameValue !== "string" || nameValue === "") {
    throw new Error("Analytics service_name must be a non-empty string");
  }
  return {
    namespace: namespaceValue ?? "",
    name: nameValue,
  };
}

export function serviceIdentitiesFromTraceRow(row: RowData): ServiceIdentity[] {
  const namespaces = row.trace_service_namespaces;
  const names = row.trace_service_names;
  if (!Array.isArray(namespaces) || !Array.isArray(names) || namespaces.length !== names.length) {
    throw new Error("Trace service identity arrays must be present and have equal lengths");
  }
  return names.map((name, index) => parseServiceIdentityRow({
    service_namespace: namespaces[index],
    service_name: name,
  }));
}

export function conciseServiceIdentitySummary(identities: readonly ServiceIdentity[]): string {
  if (identities.length === 0) return "No reported service";
  const first = serviceIdentityLabel(identities[0]);
  return identities.length === 1 ? first : `${first} +${identities.length - 1}`;
}

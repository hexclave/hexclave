import { describe, expect, it } from "vitest";
import {
  conciseServiceIdentitySummary,
  namespacedSelectValue,
  parseServiceIdentityRow,
  selectValueToNamespacedValue,
  selectValueToServiceIdentity,
  serviceIdentitiesFromTraceRow,
  serviceIdentityLabel,
  serviceIdentityToSelectValue,
} from "./service-identity";

describe("observability service identities", () => {
  it("shares the namespaced codec with scalar filters", () => {
    const value = "production/eu-west:1";
    const encoded = namespacedSelectValue(value, "env:");
    expect(encoded).toBe("env:production%2Feu-west%3A1");
    expect(selectValueToNamespacedValue(encoded, "env:")).toBe(value);
    expect(selectValueToNamespacedValue("all", "env:")).toBeNull();
    expect(() => selectValueToNamespacedValue("service:web/app", "env:")).toThrow("Unexpected namespaced select value");
  });

  it("keeps equal names in different namespaces distinct", () => {
    const dashboard = { namespace: "web", name: "app" };
    const backend = { namespace: "api", name: "app" };

    expect(serviceIdentityLabel(dashboard)).toBe("web/app");
    expect(serviceIdentityLabel(backend)).toBe("api/app");
    expect(serviceIdentityToSelectValue(dashboard)).not.toBe(serviceIdentityToSelectValue(backend));
    expect(selectValueToServiceIdentity(serviceIdentityToSelectValue(dashboard))).toEqual(dashboard);
    expect(selectValueToServiceIdentity(serviceIdentityToSelectValue(backend))).toEqual(backend);
  });

  it("labels an unnamespaced service by name without inventing a product service", () => {
    expect(serviceIdentityLabel({ namespace: "", name: "stack-dashboard" })).toBe("stack-dashboard");
    expect(() => parseServiceIdentityRow({
      service_namespace: null,
      service_name: "",
    })).toThrow("Analytics service_name must be a non-empty string");
    expect(() => serviceIdentityToSelectValue({ namespace: "", name: "" }))
      .toThrow("A service identity must have a non-empty name");
  });

  it("summarizes multi-service traces while preserving the complete set for a tooltip", () => {
    const services = serviceIdentitiesFromTraceRow({
      trace_service_namespaces: ["browser", "server"],
      trace_service_names: ["stack-dashboard", "stack-backend"],
    });

    expect(services).toEqual([
      { namespace: "browser", name: "stack-dashboard" },
      { namespace: "server", name: "stack-backend" },
    ]);
    expect(conciseServiceIdentitySummary(services)).toBe("browser/stack-dashboard +1");
    expect(services.map(serviceIdentityLabel).join(", ")).toBe(
      "browser/stack-dashboard, server/stack-backend",
    );
  });
});

import { it, niceFetch, STACK_BACKEND_BASE_URL, STACK_DASHBOARD_BASE_URL } from "../../../../helpers";

it("permits credentialed TV preflights only from the configured dashboard on both route aliases", async ({ expect }) => {
  const dashboardOrigin = new URL(STACK_DASHBOARD_BASE_URL).origin;
  for (const alias of ["latest", "v1"]) {
    for (const origin of [dashboardOrigin, "https://untrusted-tv.example.com"]) {
      const response = await niceFetch(new URL(`/api/${alias}/tv-displays/auth/refresh`, STACK_BACKEND_BASE_URL), {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin === dashboardOrigin ? origin : "*");
      expect(response.headers.get("access-control-allow-credentials")).toBe(origin === dashboardOrigin ? "true" : null);
      expect(response.headers.get("vary")).toContain("Origin");
    }
  }
});

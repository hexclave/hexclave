import { StackClientApp } from "@hexclave/js";
import type { CurrentInternalUser, AdminOwnedProject } from "@hexclave/js";
import { createUrlIfValid } from "@hexclave/shared/dist/utils/urls";
import { AuthError } from "./errors.js";
import type { SessionAuth, ProjectAuthWithRefreshToken } from "./auth.js";

function onboardingUrlFor(dashboardUrl: string): string {
  const parsedDashboardUrl = createUrlIfValid(dashboardUrl);
  if (parsedDashboardUrl == null) {
    // Configured dashboard URLs are unvalidated, so this fallback must not throw.
    return `${dashboardUrl.replace(/\/+$/, "")}/onboarding`;
  }
  parsedDashboardUrl.pathname = `${parsedDashboardUrl.pathname.replace(/\/+$/, "")}/onboarding`;
  parsedDashboardUrl.search = "";
  parsedDashboardUrl.hash = "";
  return parsedDashboardUrl.toString();
}

export function getInternalApp(auth: SessionAuth): StackClientApp<true, "internal"> {
  return new StackClientApp({
    projectId: "internal",
    publishableClientKey: auth.publishableClientKey,
    baseUrl: auth.apiUrl,
    tokenStore: {
      accessToken: "",
      refreshToken: auth.refreshToken,
    },
    noAutomaticPrefetch: true,
  });
}

export async function getInternalUser(auth: SessionAuth): Promise<CurrentInternalUser> {
  const app = getInternalApp(auth);
  // Avoid `or: "throw"` here: its internal error message leaked to CLI users
  // and was reported as a fatal Sentry event instead of a normal auth error.
  const user = await app.getUser({ includeRestricted: true });
  if (user == null) {
    throw new AuthError("Your session is invalid or expired. Run `hexclave login` again.");
  }
  if (user.isRestricted) {
    throw new AuthError(`Finish setting up your account at ${onboardingUrlFor(auth.dashboardUrl)} before using the CLI.`);
  }
  if (!("listOwnedProjects" in user)) {
    throw new AuthError("Your session is not authorized for internal projects. Run `hexclave login` again.");
  }
  return user;
}

export async function getAdminProject(auth: ProjectAuthWithRefreshToken): Promise<AdminOwnedProject> {
  const user = await getInternalUser(auth);
  const projects = await user.listOwnedProjects();
  const project = projects.find((p) => p.id === auth.projectId);
  if (!project) {
    throw new AuthError(`Project '${auth.projectId}' not found. Make sure you own this project.`);
  }
  return project;
}

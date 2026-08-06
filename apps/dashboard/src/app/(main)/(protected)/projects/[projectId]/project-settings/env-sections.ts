export const PROJECT_SETTINGS_ENV_SECTION_IDS = ["domains", "oauth", "deployments", "payments", "email"] as const;

export type ProjectSettingsEnvSectionId = (typeof PROJECT_SETTINGS_ENV_SECTION_IDS)[number];

export function isProjectSettingsEnvSectionId(id: string): boolean {
  for (const sectionId of PROJECT_SETTINGS_ENV_SECTION_IDS) {
    if (sectionId === id) {
      return true;
    }
  }
  return false;
}

export function isProjectSettingsEnvSectionPath(pathname: string): boolean {
  // Only match under /project-settings so app routes like /payments/* do not count.
  return PROJECT_SETTINGS_ENV_SECTION_IDS.some((id) => (
    pathname.endsWith(`/project-settings/${id}`)
    || pathname.includes(`/project-settings/${id}/`)
  ));
}

import { urlString } from "@hexclave/shared/dist/utils/urls";

export function navigateToTvProfiles(projectId: string): void {
  window.location.assign(urlString`/projects/${projectId}/tv-mode`);
}

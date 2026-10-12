import {
  CLICKMAP_OVERLAY_TOKEN_STORAGE_KEY,
  CLICKMAP_OVERLAY_TOKEN_UPDATED_EVENT,
} from "./analytics-clickmap-overlay";
import { deindent } from "./strings";

export const BROWSER_ACTION_QUERY_PARAM = "hexclave_action_id";

export function createClickmapOverlaySnippet(token: string): string {
  return [
    `sessionStorage.setItem(${JSON.stringify(CLICKMAP_OVERLAY_TOKEN_STORAGE_KEY)}, ${JSON.stringify(token)});`,
    `window.dispatchEvent(new Event(${JSON.stringify(CLICKMAP_OVERLAY_TOKEN_UPDATED_EVENT)}));`,
  ].join("\n");
}

export function generateImpersonateSnippet(
  projectId: string,
  refreshToken: string,
  expiresAtDate: Date,
): string {
  const pid = encodeURIComponent(projectId);
  return deindent`
    var impersonationValue = encodeURIComponent(JSON.stringify({ refresh_token: ${JSON.stringify(refreshToken)}, updated_at_millis: Date.now() }));
    var impersonationAttributes = '; expires=${expiresAtDate.toUTCString()}; path=/' + (location.protocol === 'https:' ? '; secure' : '');
    document.cookie = (location.protocol === 'https:' ? '__Host-' : '') + 'hexclave-refresh-${pid}--default=' + impersonationValue + impersonationAttributes;
    document.cookie = 'stack-refresh-${pid}--default=' + impersonationValue + impersonationAttributes;
    document.cookie = 'stack-refresh-${pid}=' + encodeURIComponent(${JSON.stringify(refreshToken)}) + impersonationAttributes;
    window.location.reload();
  `;
}

export const turnstileActionValues = [
  "sign_up_with_credential",
  "send_magic_link_email",
  "send_sms_sign_in_code",
  "oauth_authenticate",
] as const;

export type TurnstileAction = typeof turnstileActionValues[number];

export const turnstilePhaseValues = [
  "invisible",
  "visible",
] as const;

export type TurnstilePhase = typeof turnstilePhaseValues[number];

export const turnstileResultValues = [
  "ok",
  "invalid",
  "error",
] as const;

export type TurnstileResult = typeof turnstileResultValues[number];

export const turnstileDevelopmentKeys = {
  visibleSiteKey: "1x00000000000000000000AA",
  invisibleSiteKey: "1x00000000000000000000BB",
  secretKey: "1x0000000000000000000000000000000AA",
  forcedChallengeSiteKey: "3x00000000000000000000FF",
} as const;


export function isTurnstileResult(value: unknown): value is TurnstileResult {
  return typeof value === "string" && turnstileResultValues.some((status) => status === value);
}

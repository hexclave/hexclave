export type PlatformDomainState = {
  ns: string,
  key: string,
  hostname: string,
  ready: boolean,
  nextAttemptAt: number,
  error: "pending" | "rate_limited" | "provider_error" | null,
};

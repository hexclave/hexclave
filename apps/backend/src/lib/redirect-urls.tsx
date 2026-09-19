import { getEnvVariable, getProcessEnv } from "@hexclave/shared/dist/utils/env";
import { getHostedHandlerTrustedDomain as getHostedHandlerTrustedDomainFromConfig, isAcceptedNativeAppUrl, validateRedirectUrl as validateRedirectUrlAgainstTrustedDomains } from "@hexclave/shared/dist/utils/redirect-urls";
import { Tenancy } from "./tenancies";

export { isAcceptedNativeAppUrl };

const currentCloudHostedHandlerDomainSuffix = ".built-with-hexclave.com";
const legacyCloudHostedHandlerDomainSuffix = ".built-with-stack-auth.com";

export function getHostedHandlerTrustedDomain(projectId: string): string {
  return getHostedHandlerTrustedDomainFromConfig({
    projectId,
    hostedHandlerDomainSuffix: getProcessEnv("NEXT_PUBLIC_HEXCLAVE_HOSTED_HANDLER_DOMAIN_SUFFIX"),
    hostedHandlerUrlTemplate: getProcessEnv("NEXT_PUBLIC_HEXCLAVE_HOSTED_HANDLER_URL_TEMPLATE"),
    hexclavePortPrefix: getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81"),
  });
}

export function getHostedHandlerTrustedDomains(projectId: string): string[] {
  const configuredOrigin = getHostedHandlerTrustedDomain(projectId);
  const currentCloudOrigin = getHostedHandlerTrustedDomainFromConfig({
    projectId,
    hostedHandlerDomainSuffix: currentCloudHostedHandlerDomainSuffix,
  });
  const legacyCloudOrigin = getHostedHandlerTrustedDomainFromConfig({
    projectId,
    hostedHandlerDomainSuffix: legacyCloudHostedHandlerDomainSuffix,
  });

  // Old SDKs have the Stack Auth hostname compiled into their default hosted
  // URLs. Trust both cloud origins during the domain migration, regardless of
  // which one is configured as canonical, but do not add cloud origins to a
  // custom/self-hosted handler configuration.
  if (configuredOrigin === currentCloudOrigin || configuredOrigin === legacyCloudOrigin) {
    return [...new Set([configuredOrigin, currentCloudOrigin, legacyCloudOrigin])];
  }
  return [configuredOrigin];
}

export function getTrustedDomainsForTenancy(tenancy: Tenancy): string[] {
  return [
    ...Object.values(tenancy.config.domains.trustedDomains)
      .map(domain => domain.baseUrl)
      .filter((baseUrl): baseUrl is string => baseUrl != null),
    ...getHostedHandlerTrustedDomains(tenancy.project.id),
  ];
}

export function getOAuthRedirectUrisForTenancy(tenancy: Tenancy): string[] {
  return [
    ...Object.values(tenancy.config.domains.trustedDomains)
      .map((domain) => domain.baseUrl == null
        ? null
        : new URL(domain.handlerPath, domain.baseUrl.replace(/^(https?:\/\/[^/?#\\\s]+):\*(?=[/?#]|$)/i, "$1")).toString())
      .filter((uri): uri is string => uri != null),
    ...getHostedHandlerTrustedDomains(tenancy.project.id)
      .map((domain) => new URL("/handler/oauth-callback", domain).toString()),
  ];
}

export function validateRedirectUrl(
  urlOrString: string | URL,
  tenancy: Tenancy,
): boolean {
  return validateRedirectUrlAgainstTrustedDomains(urlOrString, {
    allowLocalhost: tenancy.config.domains.allowLocalhost,
    trustedDomains: getTrustedDomainsForTenancy(tenancy),
  });
}

export function validateRedirectHostname(hostname: string, tenancy: Tenancy): boolean {
  return validateRedirectUrlAgainstTrustedDomains(`https://${hostname}`, {
    allowLocalhost: tenancy.config.domains.allowLocalhost,
    trustedDomains: getTrustedDomainsForTenancy(tenancy),
  }) || validateRedirectUrlAgainstTrustedDomains(`http://${hostname}`, {
    allowLocalhost: tenancy.config.domains.allowLocalhost,
    trustedDomains: getTrustedDomainsForTenancy(tenancy),
  });
}

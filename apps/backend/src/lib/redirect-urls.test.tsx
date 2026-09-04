import { describe, expect, it } from 'vitest';
import { getHostedHandlerTrustedDomains, getOAuthRedirectUrisForTenancy, validateRedirectHostname, isAcceptedNativeAppUrl, validateRedirectUrl } from './redirect-urls';
import { Tenancy } from './tenancies';

describe('validateRedirectUrl', () => {
  const withHostedHandlerEnv = <T,>(
    values: {
      hostedHandlerUrlTemplate?: string,
      hostedHandlerDomainSuffix?: string,
      hexclavePortPrefix?: string,
    },
    callback: () => T,
  ): T => {
    const processEnv = process["env"];
    // Hexclave rebrand: getEnvVariable() in stack-shared/utils/env.tsx prefers the
    // HEXCLAVE_*-prefixed sibling of each STACK_* var. CI sets only the HEXCLAVE_*
    // variant (e.g. NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX), so writing only the STACK_*
    // key here would be silently overridden. Mirror every STACK_* key to its
    // HEXCLAVE_* sibling so both representations resolve to the same value.
    const stackKeys = [
      "NEXT_PUBLIC_STACK_HOSTED_HANDLER_URL_TEMPLATE",
      "NEXT_PUBLIC_STACK_HOSTED_HANDLER_DOMAIN_SUFFIX",
      "NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX",
    ] as const;
    const hexclaveOf = (name: string) => name.replace("STACK_", "HEXCLAVE_");
    const allKeys = [...stackKeys, ...stackKeys.map(hexclaveOf)];
    const oldValues = Object.fromEntries(allKeys.map((k) => [k, processEnv[k]]));
    const newValues: Record<string, string | undefined> = {
      NEXT_PUBLIC_STACK_HOSTED_HANDLER_URL_TEMPLATE: values.hostedHandlerUrlTemplate,
      NEXT_PUBLIC_STACK_HOSTED_HANDLER_DOMAIN_SUFFIX: values.hostedHandlerDomainSuffix,
      NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX: values.hexclavePortPrefix,
    };
    for (const stackKey of stackKeys) {
      newValues[hexclaveOf(stackKey)] = newValues[stackKey];
    }
    const applyValues = (entries: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(entries)) {
        if (value == null) {
          Reflect.deleteProperty(processEnv, key);
        } else {
          Reflect.set(processEnv, key, value);
        }
      }
    };
    try {
      applyValues(newValues);
      return callback();
    } finally {
      applyValues(oldValues);
    }
  };

  const createMockTenancy = (config: Partial<Tenancy['config']>): Tenancy => {
    return {
      config: {
        domains: {
          allowLocalhost: false,
          trustedDomains: {},
          ...config.domains,
        },
        ...config,
      },
      project: {
        id: "12345678-1234-4234-8234-123456789abc",
      },
    } as Tenancy;
  };

  describe('exact domain matching', () => {
    it('should implicitly validate hosted handler domains for the project', () => {
      withHostedHandlerEnv({
        hostedHandlerUrlTemplate: "http://{projectId}.localhost:${NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX:-81}09/{hostedPath}",
        hexclavePortPrefix: "92",
      }, () => {
        const tenancy = createMockTenancy({
          domains: {
            allowLocalhost: false,
            trustedDomains: {},
          },
        });

        expect(validateRedirectUrl('http://12345678-1234-4234-8234-123456789abc.localhost:9209/anything', tenancy)).toBe(true);
        expect(validateRedirectUrl('http://other-project.localhost:9209/anything', tenancy)).toBe(false);
        expect(validateRedirectUrl('https://12345678-1234-4234-8234-123456789abc.built-with-hexclave.com/anything', tenancy)).toBe(false);
        expect(validateRedirectUrl('https://12345678-1234-4234-8234-123456789abc.built-with-stack-auth.com/anything', tenancy)).toBe(false);
      });
    });

    it('should reject hosted handler URL templates that put the project ID in the path', () => {
      withHostedHandlerEnv({
        hostedHandlerUrlTemplate: "http://localhost:9209/{projectId}/{hostedPath}",
      }, () => {
        const tenancy = createMockTenancy({
          domains: {
            allowLocalhost: false,
            trustedDomains: {},
          },
        });

        expect(() => validateRedirectUrl('http://localhost:9209/anything', tenancy))
          .toThrowErrorMatchingInlineSnapshot(`
            [HexclaveAssertionError: The hosted handler URL template must put {projectId} in the hostname.

            This is likely an error in Hexclave. Please make sure you are running the newest version and report it.]
          `);
      });
    });

    it('should include the implicit hosted callback in OAuth redirect URIs', () => {
      withHostedHandlerEnv({}, () => {
        const tenancy = createMockTenancy({
          domains: {
            allowLocalhost: false,
            trustedDomains: {
              '1': { baseUrl: 'https://example.com', handlerPath: '/handler' },
            },
          },
        });

        expect(getOAuthRedirectUrisForTenancy(tenancy)).toMatchInlineSnapshot(`
          [
            "https://example.com/handler",
            "https://12345678-1234-4234-8234-123456789abc.built-with-hexclave.com/handler/oauth-callback",
            "https://12345678-1234-4234-8234-123456789abc.built-with-stack-auth.com/handler/oauth-callback",
          ]
        `);
      });
    });

    it('should trust both current and legacy cloud hosted handler domains', () => {
      withHostedHandlerEnv({}, () => {
        const tenancy = createMockTenancy({
          domains: {
            allowLocalhost: false,
            trustedDomains: {
              '1': { baseUrl: 'https://*.example.com', handlerPath: '/handler' },
            },
          },
        });

        expect(validateRedirectHostname('app.example.com', tenancy)).toBe(true);
        expect(validateRedirectHostname('12345678-1234-4234-8234-123456789abc.built-with-hexclave.com', tenancy)).toBe(true);
        expect(validateRedirectHostname('12345678-1234-4234-8234-123456789abc.built-with-stack-auth.com', tenancy)).toBe(true);
        expect(validateRedirectHostname('other-project.built-with-hexclave.com', tenancy)).toBe(false);
        expect(validateRedirectHostname('other-project.built-with-stack-auth.com', tenancy)).toBe(false);
        expect(validateRedirectHostname('evil.example.test', tenancy)).toBe(false);
      });
    });

    it('should trust both cloud domains while the legacy domain is still configured as canonical', () => {
      withHostedHandlerEnv({
        hostedHandlerDomainSuffix: ".built-with-stack-auth.com",
      }, () => {
        expect(getHostedHandlerTrustedDomains("12345678-1234-4234-8234-123456789abc")).toEqual([
          "https://12345678-1234-4234-8234-123456789abc.built-with-stack-auth.com",
          "https://12345678-1234-4234-8234-123456789abc.built-with-hexclave.com",
        ]);
      });
    });

    it('should validate exact domain matches', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://example.com', handlerPath: '/handler' },
          },
        },
      });

      expect(validateRedirectUrl('https://example.com/handler', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://example.com/handler/callback', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://example.com/other', tenancy)).toBe(true); // Any path on trusted domain is valid
      expect(validateRedirectUrl('https://example.com/', tenancy)).toBe(true); // Root path is also valid
      expect(validateRedirectUrl('https://other.com/handler', tenancy)).toBe(false); // Different domain is not trusted
      expect(validateRedirectUrl('https://example.com.other.com/handler', tenancy)).toBe(false); // Similar different domain is also not trusted
    });

    it('should validate protocol matching', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://example.com', handlerPath: '/handler' },
          },
        },
      });

      expect(validateRedirectUrl('https://example.com/handler', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://example.com/any/path', tenancy)).toBe(true); // Any path is valid
      expect(validateRedirectUrl('http://example.com/handler', tenancy)).toBe(false); // Wrong protocol
    });
  });

  describe('wildcard domain matching', () => {
    it('should validate single wildcard subdomain patterns', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://*.example.com', handlerPath: '/handler' },
          },
        },
      });

      expect(validateRedirectUrl('https://api.example.com/handler', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.example.com/any/path', tenancy)).toBe(true); // Any path is valid
      expect(validateRedirectUrl('https://www.example.com/', tenancy)).toBe(true); // Root path is valid
      expect(validateRedirectUrl('https://staging.example.com/other', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://example.com/handler', tenancy)).toBe(false); // Not a subdomain
      expect(validateRedirectUrl('https://api.v2.example.com/handler', tenancy)).toBe(false); // Too many subdomains for single *
    });

    it('should validate double wildcard patterns', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://**.example.com', handlerPath: '/handler' },
          },
        },
      });

      expect(validateRedirectUrl('https://api.example.com/handler', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.example.com/', tenancy)).toBe(true); // Root path is valid
      expect(validateRedirectUrl('https://api.v2.example.com/other/path', tenancy)).toBe(true); // Any path is valid
      expect(validateRedirectUrl('https://a.b.c.example.com/deep/nested/path', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://example.com/handler', tenancy)).toBe(false); // Not a subdomain
    });

    it('should validate wildcard patterns with prefixes', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://api-*.example.com', handlerPath: '/handler' },
          },
        },
      });

      expect(validateRedirectUrl('https://api-v1.example.com/handler', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api-v2.example.com/any/path', tenancy)).toBe(true); // Any path is valid
      expect(validateRedirectUrl('https://api-prod.example.com/', tenancy)).toBe(true); // Root path is valid
      expect(validateRedirectUrl('https://api.example.com/handler', tenancy)).toBe(false); // Missing prefix
      expect(validateRedirectUrl('https://v1-api.example.com/handler', tenancy)).toBe(false); // Wrong prefix position
    });

    it('should validate multiple wildcard patterns', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://*.*.org', handlerPath: '/handler' },
          },
        },
      });

      expect(validateRedirectUrl('https://mail.example.org/handler', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://mail.example.org/any/path', tenancy)).toBe(true); // Any path is valid
      expect(validateRedirectUrl('https://api.company.org/', tenancy)).toBe(true); // Root path is valid
      expect(validateRedirectUrl('https://example.org/handler', tenancy)).toBe(false); // Not enough subdomain levels
      expect(validateRedirectUrl('https://a.b.c.org/handler', tenancy)).toBe(false); // Too many subdomain levels
    });
  });

  describe('localhost handling', () => {
    it('should allow localhost when configured', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: true,
          trustedDomains: {},
        },
      });

      expect(validateRedirectUrl('http://localhost/callback', tenancy)).toBe(true);
      expect(validateRedirectUrl('http://localhost:3000/callback', tenancy)).toBe(true);
      expect(validateRedirectUrl('http://127.0.0.1/callback', tenancy)).toBe(true);
      expect(validateRedirectUrl('http://sub.localhost/callback', tenancy)).toBe(true);
    });

    it('should reject localhost when not configured', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {},
        },
      });

      expect(validateRedirectUrl('http://localhost/callback', tenancy)).toBe(false);
      expect(validateRedirectUrl('http://127.0.0.1/callback', tenancy)).toBe(false);
    });
  });

  describe('path validation', () => {
    it('should allow any path on trusted domains (handlerPath is only a default)', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://example.com', handlerPath: '/auth/handler' },
          },
        },
      });

      // All paths on the trusted domain should be valid
      expect(validateRedirectUrl('https://example.com/auth/handler', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://example.com/auth/handler/callback', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://example.com/auth', tenancy)).toBe(true); // Any path is valid
      expect(validateRedirectUrl('https://example.com/other/handler', tenancy)).toBe(true); // Any path is valid
      expect(validateRedirectUrl('https://example.com/', tenancy)).toBe(true); // Root is valid
    });

    it('should work with wildcard domains (any path is valid)', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://*.example.com', handlerPath: '/api/auth' },
          },
        },
      });

      // All paths on matched domains should be valid
      expect(validateRedirectUrl('https://api.example.com/api/auth', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://app.example.com/api/auth/callback', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.example.com/api', tenancy)).toBe(true); // Any path is valid
      expect(validateRedirectUrl('https://api.example.com/other/auth', tenancy)).toBe(true); // Any path is valid
      expect(validateRedirectUrl('https://api.example.com/', tenancy)).toBe(true); // Root is valid
    });
  });

  describe('port number handling with wildcards', () => {
    it('should handle exact domain without port (defaults to standard ports)', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://localhost', handlerPath: '/' },
          },
        },
      });

      // https://localhost should match https://localhost:443 (default HTTPS port)
      expect(validateRedirectUrl('https://localhost/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://localhost:443/', tenancy)).toBe(true);

      // Should NOT match other ports
      expect(validateRedirectUrl('https://localhost:3000/', tenancy)).toBe(false);
      expect(validateRedirectUrl('https://localhost:8080/', tenancy)).toBe(false);
    });

    it('should handle http domain without port (defaults to port 80)', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'http://localhost', handlerPath: '/' },
          },
        },
      });

      // http://localhost should match http://localhost:80 (default HTTP port)
      expect(validateRedirectUrl('http://localhost/', tenancy)).toBe(true);
      expect(validateRedirectUrl('http://localhost:80/', tenancy)).toBe(true);

      // Should NOT match other ports
      expect(validateRedirectUrl('http://localhost:3000/', tenancy)).toBe(false);
      expect(validateRedirectUrl('http://localhost:8080/', tenancy)).toBe(false);
    });

    it('should handle wildcard with port pattern to match any port', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://localhost:*', handlerPath: '/' },
          },
        },
      });

      // Should match localhost on any port
      expect(validateRedirectUrl('https://localhost/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://localhost:443/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://localhost:3000/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://localhost:8080/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://localhost:12345/', tenancy)).toBe(true);

      // Should NOT match different hostnames
      expect(validateRedirectUrl('https://example.com:3000/', tenancy)).toBe(false);
    });

    it('should handle subdomain wildcard without affecting port matching', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://*.localhost', handlerPath: '/' },
          },
        },
      });

      // Should match subdomains on default port only
      expect(validateRedirectUrl('https://api.localhost/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.localhost:443/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://app.localhost/', tenancy)).toBe(true);

      // Should NOT match subdomains on other ports
      expect(validateRedirectUrl('https://api.localhost:3000/', tenancy)).toBe(false);
      expect(validateRedirectUrl('https://app.localhost:8080/', tenancy)).toBe(false);

      // Should NOT match the base domain (no subdomain)
      expect(validateRedirectUrl('https://localhost/', tenancy)).toBe(false);
    });

    it('should handle subdomain wildcard WITH port wildcard', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://*.localhost:*', handlerPath: '/' },
          },
        },
      });

      // Should match subdomains on any port
      expect(validateRedirectUrl('https://api.localhost/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.localhost:3000/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://app.localhost:8080/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://staging.localhost:12345/', tenancy)).toBe(true);

      // Should NOT match the base domain (no subdomain)
      expect(validateRedirectUrl('https://localhost:3000/', tenancy)).toBe(false);
    });

    it('should handle TLD wildcard without affecting port', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://localhost.*', handlerPath: '/' },
          },
        },
      });

      // Should match different TLDs on default port
      expect(validateRedirectUrl('https://localhost.de/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://localhost.com/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://localhost.org/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://localhost.de:443/', tenancy)).toBe(true);

      // Should NOT match different TLDs on other ports
      expect(validateRedirectUrl('https://localhost.de:3000/', tenancy)).toBe(false);
      expect(validateRedirectUrl('https://localhost.com:8080/', tenancy)).toBe(false);

      // Should NOT match without TLD
      expect(validateRedirectUrl('https://localhost/', tenancy)).toBe(false);
    });

    it('should handle specific port in wildcard pattern', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://*.example.com:8080', handlerPath: '/' },
          },
        },
      });

      // Should match subdomains only on port 8080
      expect(validateRedirectUrl('https://api.example.com:8080/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://app.example.com:8080/', tenancy)).toBe(true);

      // Should NOT match on other ports
      expect(validateRedirectUrl('https://api.example.com/', tenancy)).toBe(false);
      expect(validateRedirectUrl('https://api.example.com:443/', tenancy)).toBe(false);
      expect(validateRedirectUrl('https://api.example.com:3000/', tenancy)).toBe(false);
    });

    it('should handle double wildcard with port patterns', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://**.example.com:*', handlerPath: '/' },
          },
        },
      });

      // Should match any subdomain depth on any port
      expect(validateRedirectUrl('https://api.example.com:3000/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.v2.example.com:8080/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://staging.api.v2.example.com:12345/', tenancy)).toBe(true);

      // Should NOT match base domain
      expect(validateRedirectUrl('https://example.com:3000/', tenancy)).toBe(false);
    });

    it('should handle single wildcard (*:*) pattern correctly', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'http://*:*', handlerPath: '/' },
          },
        },
      });

      // * matches single level (no dots), so should match simple hostnames on any port
      expect(validateRedirectUrl('http://localhost:3000/', tenancy)).toBe(true);
      expect(validateRedirectUrl('http://localhost:8080/', tenancy)).toBe(true);
      expect(validateRedirectUrl('http://app:12345/', tenancy)).toBe(true);

      // Should NOT match hostnames with dots (need ** for that)
      expect(validateRedirectUrl('http://example.com:8080/', tenancy)).toBe(false);
      expect(validateRedirectUrl('http://api.test.com:12345/', tenancy)).toBe(false);

      // Should NOT match https (different protocol)
      expect(validateRedirectUrl('https://localhost:3000/', tenancy)).toBe(false);
    });

    it('should handle double wildcard (**:*) pattern to match any hostname on any port', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'http://**:*', handlerPath: '/' },
          },
        },
      });

      // ** matches any characters including dots, so should match any hostname on any port
      expect(validateRedirectUrl('http://localhost:3000/', tenancy)).toBe(true);
      expect(validateRedirectUrl('http://example.com:8080/', tenancy)).toBe(true);
      expect(validateRedirectUrl('http://api.test.com:12345/', tenancy)).toBe(true);
      expect(validateRedirectUrl('http://192.168.1.1:80/', tenancy)).toBe(true);
      expect(validateRedirectUrl('http://deeply.nested.subdomain.example.com:9999/', tenancy)).toBe(true);

      // Should NOT match https (different protocol)
      expect(validateRedirectUrl('https://localhost:3000/', tenancy)).toBe(false);
    });

    it('should correctly distinguish between port wildcard and subdomain wildcard', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://app-*.example.com', handlerPath: '/' },
            '2': { baseUrl: 'https://api.example.com:*', handlerPath: '/' },
          },
        },
      });

      // First pattern should match app-* subdomains on default port
      expect(validateRedirectUrl('https://app-v1.example.com/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://app-staging.example.com/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://app-v1.example.com:3000/', tenancy)).toBe(false);

      // Second pattern should match api.example.com on any port
      expect(validateRedirectUrl('https://api.example.com/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.example.com:3000/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.example.com:8080/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api-v1.example.com:3000/', tenancy)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle invalid URLs', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://example.com', handlerPath: '/handler' },
          },
        },
      });

      expect(validateRedirectUrl('not-a-url', tenancy)).toBe(false);
      expect(validateRedirectUrl('', tenancy)).toBe(false);
      expect(validateRedirectUrl('javascript:alert(1)', tenancy)).toBe(false);
    });

    it('should handle missing baseUrl in domain config', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: undefined as any, handlerPath: '/handler' },
          },
        },
      });

      expect(validateRedirectUrl('https://example.com/handler', tenancy)).toBe(false);
    });

    it('should handle multiple trusted domains with wildcards', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {
            '1': { baseUrl: 'https://example.com', handlerPath: '/handler' },
            '2': { baseUrl: 'https://*.staging.com', handlerPath: '/auth' },
            '3': { baseUrl: 'https://**.production.com', handlerPath: '/callback' },
          },
        },
      });

      // Any path on trusted domains should be valid
      expect(validateRedirectUrl('https://example.com/handler', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://example.com/any/path', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.staging.com/auth', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.staging.com/different/path', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.v2.production.com/callback', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://api.v2.production.com/', tenancy)).toBe(true);
      expect(validateRedirectUrl('https://other.com/handler', tenancy)).toBe(false);
    });
  });

  describe('native app SDK URLs', () => {
    it('should not accept native app URLs in validateRedirectUrl (handled separately in OAuth model)', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {},
        },
      });

      // Native app URLs are handled by isAcceptedNativeAppUrl in the OAuth model,
      // not by validateRedirectUrl. This keeps native app URL acceptance scoped to OAuth only.
      expect(validateRedirectUrl('stack-auth-mobile-oauth-url://success', tenancy)).toBe(false);
      expect(validateRedirectUrl('stack-auth-mobile-oauth-url://error', tenancy)).toBe(false);
      expect(validateRedirectUrl('stack-auth-mobile-oauth-url://oauth-callback', tenancy)).toBe(false);
      expect(validateRedirectUrl('hexclave-mobile-oauth-url://success', tenancy)).toBe(false);
      expect(validateRedirectUrl('hexclave-mobile-oauth-url://error', tenancy)).toBe(false);
      expect(validateRedirectUrl('hexclave-mobile-oauth-url://oauth-callback', tenancy)).toBe(false);
    });

    it('should not accept other custom schemes without trusted domain config', () => {
      const tenancy = createMockTenancy({
        domains: {
          allowLocalhost: false,
          trustedDomains: {},
        },
      });

      // Other custom schemes require explicit trusted domain configuration
      expect(validateRedirectUrl('myapp://callback', tenancy)).toBe(false);
      expect(validateRedirectUrl('stackauth-myapp://callback', tenancy)).toBe(false);
      expect(validateRedirectUrl('stack-auth-custom://callback', tenancy)).toBe(false);
    });
  });
});

describe('isAcceptedNativeAppUrl', () => {
  it('should accept the legacy native app OAuth URL scheme', () => {
    expect(isAcceptedNativeAppUrl('stack-auth-mobile-oauth-url://success')).toBe(true);
    expect(isAcceptedNativeAppUrl('stack-auth-mobile-oauth-url://error')).toBe(true);
  });

  it('should accept the canonical Hexclave native app OAuth URL scheme', () => {
    expect(isAcceptedNativeAppUrl('hexclave-mobile-oauth-url://success')).toBe(true);
    expect(isAcceptedNativeAppUrl('hexclave-mobile-oauth-url://error')).toBe(true);
    expect(isAcceptedNativeAppUrl('hexclave-mobile-oauth-url://oauth-callback')).toBe(true);
  });

  it('should reject other custom schemes', () => {
    expect(isAcceptedNativeAppUrl('myapp://callback')).toBe(false);
    expect(isAcceptedNativeAppUrl('stackauth-myapp://callback')).toBe(false);
    expect(isAcceptedNativeAppUrl('stack-auth://callback')).toBe(false);
    expect(isAcceptedNativeAppUrl('hexclave://callback')).toBe(false);
    expect(isAcceptedNativeAppUrl('hexclave-mobile-oauth-url-extra://callback')).toBe(false);
    expect(isAcceptedNativeAppUrl('https://example.com/callback')).toBe(false);
    expect(isAcceptedNativeAppUrl('http://localhost:3000/callback')).toBe(false);
  });

  it('should reject invalid URLs', () => {
    expect(isAcceptedNativeAppUrl('not-a-url')).toBe(false);
    expect(isAcceptedNativeAppUrl('')).toBe(false);
  });
});

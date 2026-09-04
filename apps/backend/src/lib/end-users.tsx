import { normalizeCountryCode } from "@hexclave/shared/dist/utils/country-codes";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { isIpAddress } from "@hexclave/shared/dist/utils/ips";
import { pick } from "@hexclave/shared/dist/utils/objects";
import { headers } from "@/lib/runtime/headers";
import { getTrustedProxy, type TrustedProxy } from "@/lib/trusted-proxy";

// An end user is a person sitting behind a computer screen.
//
// For example, if my-stack-app.com is using Hexclave, and person A is on my-stack-app.com and sends a server action
// to server B of my-stack-app.com, then the end user is person A, not server B.
//
// An end user is not the same as a ProjectUser. For example, if person A is not logged into
// my-stack-app.com, they are still considered an end user, and will have an associated IP address.


/**
 * Returns the end user's IP address from the current request's headers, or `undefined` if it can't be determined.
 * Falls back to spoofable headers (x-forwarded-for) if no trusted proxy header (cf-connecting-ip,
 * x-vercel-forwarded-for) is available.
 */
export async function getSpoofableEndUserIp(): Promise<string | undefined> {
  const endUserInfo = await getEndUserInfo();
  return endUserInfo?.maybeSpoofed ? endUserInfo.spoofedInfo.ip : endUserInfo?.exactInfo.ip;
}


/**
 * Returns the end user's IP only if it came from a trusted proxy header (cf-connecting-ip or x-vercel-forwarded-for).
 * Returns `undefined` if the IP could only be determined from spoofable headers.
 */
export async function getExactEndUserIp(): Promise<string | undefined> {
  const endUserInfo = await getEndUserInfo();
  return endUserInfo?.maybeSpoofed ? undefined : endUserInfo?.exactInfo.ip;
}

type EndUserLocation = {
  countryCode?: string,
  regionCode?: string,
  cityName?: string,
  latitude?: number,
  longitude?: number,
  tzIdentifier?: string,
};

export async function getSpoofableEndUserLocation(): Promise<EndUserLocation | null> {
  const endUserInfo = await getEndUserInfo();
  if (!endUserInfo) {
    return null;
  }

  const locationInfo = getLocationInfo(endUserInfo);
  return pick(locationInfo, ["countryCode", "regionCode", "cityName", "latitude", "longitude", "tzIdentifier"]);
}

export type BestEffortEndUserRequestContext = {
  ipAddress: string | null,
  ipTrusted: boolean | null,
  location: EndUserLocation | null,
};

export async function getBestEffortEndUserRequestContext(): Promise<BestEffortEndUserRequestContext> {
  const endUserInfo = await getEndUserInfo();
  if (!endUserInfo) {
    return {
      ipAddress: null,
      ipTrusted: null,
      location: null,
    };
  }

  const locationInfo = getLocationInfo(endUserInfo);
  return {
    ipAddress: locationInfo.ip,
    ipTrusted: !endUserInfo.maybeSpoofed,
    location: pick(locationInfo, ["countryCode", "regionCode", "cityName", "latitude", "longitude", "tzIdentifier"]),
  };
}


type EndUserInfoInner = EndUserLocation & { ip: string }

function getLocationInfo(endUserInfo: { maybeSpoofed: true, spoofedInfo: EndUserInfoInner } | { maybeSpoofed: false, exactInfo: EndUserInfoInner }) {
  return endUserInfo.maybeSpoofed ? endUserInfo.spoofedInfo : endUserInfo.exactInfo;
}

function parseCoordinate(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeVercelGeoHeader(raw: string | null | undefined): string | undefined {
  if (raw == null || raw === "") return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function getBrowserEndUserInfo(allHeaders: Headers, trustedProxy: TrustedProxy):
  | { maybeSpoofed: true, spoofedInfo: EndUserInfoInner }
  | { maybeSpoofed: false, exactInfo: EndUserInfoInner }
  | null {
  const isVercelTrusted = trustedProxy === "vercel";
  const isCloudflareTrusted = trustedProxy === "cloudflare";
  const isCloudRunTrusted = trustedProxy === "cloudrun";
  const isGenericProxyTrusted = trustedProxy === "generic";

  // Only read proxy headers as trusted when the corresponding proxy is configured.
  // Google Cloud's HTTP(S) LB appends two entries to X-Forwarded-For:
  //   <client-supplied>, <real-client-ip>, <lb-ip>
  // So the real client IP is the second-to-last entry (.at(-2)).
  // See: https://cloud.google.com/load-balancing/docs/https#x-forwarded-for_header
  const trustedIp = (isVercelTrusted ? allHeaders.get("x-vercel-forwarded-for") : undefined)
    ?? (isCloudflareTrusted ? allHeaders.get("cf-connecting-ip") : undefined)
    ?? (isCloudRunTrusted ? allHeaders.get("x-forwarded-for")?.split(",").at(-2)?.trim() : undefined)
    // A generic proxy cannot have safe chain semantics inferred for it. Operators must
    // overwrite X-Real-IP and prevent direct access to the origin before enabling this mode.
    ?? (isGenericProxyTrusted ? allHeaders.get("x-real-ip") : undefined)
    ?? undefined;

  // All other IP headers are always spoofable — including proxy headers when the proxy is not configured as trusted
  const spoofableIp = (!isGenericProxyTrusted ? allHeaders.get("x-real-ip") : undefined)
    ?? (!isCloudRunTrusted ? allHeaders.get("x-forwarded-for")?.split(",").at(0) : undefined)
    ?? (!isVercelTrusted ? allHeaders.get("x-vercel-forwarded-for") : undefined)
    ?? (!isCloudflareTrusted ? allHeaders.get("cf-connecting-ip") : undefined)
    ?? undefined;

  const ip = trustedIp ?? spoofableIp;

  if (!ip || !isIpAddress(ip)) {
    console.warn("getEndUserIp() found IP address in headers, but is invalid. This is most likely a misconfigured client", { ip, headers: Object.fromEntries(allHeaders) });
    return null;
  }

  // Geo headers are only trustworthy when they come from a verified proxy.
  // If a trusted proxy is configured but it did not provide its trusted IP header,
  // treat its geo headers as spoofed too.
  const rawCountryCode = (isVercelTrusted ? allHeaders.get("x-vercel-ip-country") : undefined)
    ?? (isCloudflareTrusted ? allHeaders.get("cf-ipcountry") : undefined)
    ?? undefined;
  const geoLocation: EndUserLocation = {
    countryCode: rawCountryCode ? normalizeCountryCode(rawCountryCode) : undefined,
    regionCode: (isVercelTrusted ? allHeaders.get("x-vercel-ip-country-region") : undefined) || undefined,
    cityName: decodeVercelGeoHeader(isVercelTrusted ? allHeaders.get("x-vercel-ip-city") : undefined),
    latitude: parseCoordinate(isVercelTrusted ? allHeaders.get("x-vercel-ip-latitude") : null),
    longitude: parseCoordinate(isVercelTrusted ? allHeaders.get("x-vercel-ip-longitude") : null),
    tzIdentifier: (isVercelTrusted ? allHeaders.get("x-vercel-ip-timezone") : undefined) || undefined,
  };

  // When no proxy is trusted, geo headers are spoofable — still include them but under spoofedInfo
  const rawSpoofedCountryCode = trustedProxy === "" ? ((allHeaders.get("x-vercel-ip-country") ?? allHeaders.get("cf-ipcountry")) || undefined) : undefined;
  const spoofedGeoLocation: EndUserLocation = trustedProxy === "" ? {
    countryCode: rawSpoofedCountryCode ? normalizeCountryCode(rawSpoofedCountryCode) : undefined,
    regionCode: allHeaders.get("x-vercel-ip-country-region") || undefined,
    cityName: decodeVercelGeoHeader(allHeaders.get("x-vercel-ip-city")),
    latitude: parseCoordinate(allHeaders.get("x-vercel-ip-latitude")),
    longitude: parseCoordinate(allHeaders.get("x-vercel-ip-longitude")),
    tzIdentifier: allHeaders.get("x-vercel-ip-timezone") || undefined,
  } : undefined;

  if (trustedIp) {
    return { maybeSpoofed: false, exactInfo: { ip, ...geoLocation } };
  }
  return { maybeSpoofed: true, spoofedInfo: { ip, ...(trustedProxy === "" ? spoofedGeoLocation : undefined) } };
}

export async function getEndUserInfo(): Promise<
  // discriminated union to make sure the user is really explicit about checking the maybeSpoofed field
  | { maybeSpoofed: true, spoofedInfo: EndUserInfoInner }
  | { maybeSpoofed: false, exactInfo: EndUserInfoInner }
  | null
> {
  const allHeaders = await headers();

  // note that this is just the requester claiming to be a browser; we can't trust them as they could just fake the
  // headers
  //
  // but in this case, there's no reason why an attacker would want to fake it
  //
  // this works for all modern browsers because Mozilla is part of the user agent of all of them
  // https://stackoverflow.com/a/1114297
  const isClaimingToBeBrowser = ["Mozilla", "Chrome", "Safari"].some(header => allHeaders.get("User-Agent")?.includes(header));

  if (isClaimingToBeBrowser) {
    // Determine which proxy we trust based on deployment configuration.
    // These headers can only be trusted when the origin is exclusively reachable through the proxy;
    // HEXCLAVE_TRUSTED_PROXY should name the platform proxy, use "generic" for a locked-down
    // reverse proxy that overwrites forwarding headers, or remain empty for no proxy trust.
    const trustedProxy = getTrustedProxy();
    return getBrowserEndUserInfo(allHeaders, trustedProxy);
  }

  /**
   * Specifies whether this request is coming from a trusted server (ie. a server with a valid secret server key).
   *
   * If a trusted server gives us an end user IP, then we always trust them.
   *
   * TODO we don't currently check if the server is trusted, and always assume false. fix that
   */
  const isTrustedServer = false as boolean;

  if (isTrustedServer) {
    // TODO we currently don't do anything to find the IP address if the request is coming from a trusted server, so
    // this is never set to true
    // we should fix that, by storing IP information in X-Stack-Requester in the StackApp interface on servers, and then
    // reading that information
    throw new HexclaveAssertionError("getEndUserIp() is unimplemented for trusted servers");
  }

  // we don't know anything about this request
  // most likely it's a consumer of our REST API that doesn't use our SDKs
  return null;
}

import.meta.vitest?.describe("getBrowserEndUserInfo(...)", () => {
  const { expect, test } = import.meta.vitest!;

  test("does not trust Vercel geo headers when the trusted Vercel IP header is absent", () => {
    const result = getBrowserEndUserInfo(new Headers({
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "203.0.113.10",
      "x-vercel-ip-country": "DE",
      "x-vercel-ip-country-region": "BE",
      "x-vercel-ip-city": "Berlin",
      "x-vercel-ip-latitude": "52.52",
      "x-vercel-ip-longitude": "13.40",
      "x-vercel-ip-timezone": "Europe/Berlin",
    }), "vercel");

    expect(result).toEqual({
      maybeSpoofed: true,
      spoofedInfo: {
        ip: "203.0.113.10",
      },
    });
  });

  test("trusts second-to-last x-forwarded-for entry when Cloud Run proxy is configured", () => {
    // Google Cloud LB appends: <client-supplied>, <real-client-ip>, <lb-ip>
    const result = getBrowserEndUserInfo(new Headers({
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "198.51.100.42, 10.0.0.1",
    }), "cloudrun");

    expect(result).toEqual({
      maybeSpoofed: false,
      exactInfo: {
        ip: "198.51.100.42",
      },
    });
  });

  test("ignores client-spoofed x-forwarded-for entries for Cloud Run proxy", () => {
    // Client sends "1.1.1.1", LB appends real client IP and its own IP
    const result = getBrowserEndUserInfo(new Headers({
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "1.1.1.1, 198.51.100.42, 10.0.0.1",
    }), "cloudrun");

    expect(result).toEqual({
      maybeSpoofed: false,
      exactInfo: {
        ip: "198.51.100.42",
      },
    });
  });

  test("does not expose x-forwarded-for as spoofable when Cloud Run proxy is configured", () => {
    const result = getBrowserEndUserInfo(new Headers({
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "198.51.100.42, 10.0.0.1",
      "x-real-ip": "10.0.0.1",
    }), "cloudrun");

    expect(result).toEqual({
      maybeSpoofed: false,
      exactInfo: {
        ip: "198.51.100.42",
      },
    });
  });

  test("trusts only an overwritten x-real-ip header for a generic reverse proxy", () => {
    const result = getBrowserEndUserInfo(new Headers({
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "192.0.2.1, 10.0.0.1",
      "x-real-ip": "198.51.100.42",
    }), "generic");

    expect(result).toEqual({
      maybeSpoofed: false,
      exactInfo: {
        ip: "198.51.100.42",
      },
    });
  });

  test("does not infer trusted forwarding-chain semantics for a generic reverse proxy", () => {
    const result = getBrowserEndUserInfo(new Headers({
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "192.0.2.1, 198.51.100.42, 10.0.0.1",
    }), "generic");

    expect(result).toEqual({
      maybeSpoofed: true,
      spoofedInfo: {
        ip: "192.0.2.1",
      },
    });
  });

  test("does not trust geo headers for Cloud Run proxy", () => {
    const result = getBrowserEndUserInfo(new Headers({
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "198.51.100.42, 10.0.0.1",
      "x-vercel-ip-country": "US",
      "cf-ipcountry": "DE",
    }), "cloudrun");

    expect(result).toEqual({
      maybeSpoofed: false,
      exactInfo: {
        ip: "198.51.100.42",
      },
    });
  });

  test("keeps trusted proxy geo headers when the trusted IP header is present", () => {
    const result = getBrowserEndUserInfo(new Headers({
      "user-agent": "Mozilla/5.0",
      "x-vercel-forwarded-for": "203.0.113.10",
      "x-vercel-ip-country": "DE",
      "x-vercel-ip-country-region": "BE",
      "x-vercel-ip-city": "Berlin",
      "x-vercel-ip-latitude": "52.52",
      "x-vercel-ip-longitude": "13.40",
      "x-vercel-ip-timezone": "Europe/Berlin",
    }), "vercel");

    expect(result).toEqual({
      maybeSpoofed: false,
      exactInfo: {
        ip: "203.0.113.10",
        countryCode: "DE",
        regionCode: "BE",
        cityName: "Berlin",
        latitude: 52.52,
        longitude: 13.4,
        tzIdentifier: "Europe/Berlin",
      },
    });
  });

  test("decodes URL-encoded city names from Vercel geo headers", () => {
    // Vercel percent-encodes city names, so a multi-word city arrives as "San%20Francisco".
    const result = getBrowserEndUserInfo(new Headers({
      "user-agent": "Mozilla/5.0",
      "x-vercel-forwarded-for": "203.0.113.10",
      "x-vercel-ip-country": "US",
      "x-vercel-ip-country-region": "CA",
      "x-vercel-ip-city": "San%20Francisco",
      "x-vercel-ip-latitude": "37.77",
      "x-vercel-ip-longitude": "-122.41",
      "x-vercel-ip-timezone": "America/Los_Angeles",
    }), "vercel");

    expect(result).toEqual({
      maybeSpoofed: false,
      exactInfo: {
        ip: "203.0.113.10",
        countryCode: "US",
        regionCode: "CA",
        cityName: "San Francisco",
        latitude: 37.77,
        longitude: -122.41,
        tzIdentifier: "America/Los_Angeles",
      },
    });
  });

  test("falls back to the raw city name when it is not valid percent-encoding", () => {
    // A lone "%" is invalid percent-encoding; decoding must not throw, just pass it through.
    const result = getBrowserEndUserInfo(new Headers({
      "user-agent": "Mozilla/5.0",
      "x-vercel-forwarded-for": "203.0.113.10",
      "x-vercel-ip-city": "100% Real City",
    }), "vercel");

    expect(result).toEqual({
      maybeSpoofed: false,
      exactInfo: {
        ip: "203.0.113.10",
        cityName: "100% Real City",
      },
    });
  });
});

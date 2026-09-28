import { isApiKey, parseProjectApiKey } from "@hexclave/shared/dist/utils/api-keys";
import { typedIncludes } from "@hexclave/shared/dist/utils/arrays";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { nicify } from "@hexclave/shared/dist/utils/strings";
import { SnapshotSerializer } from "vitest";
import { getPortPrefix } from "./helpers/ports";

const hideHeaders = [
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "access-control-max-age",
  "cache-control",
  "connection",
  "content-security-policy",
  "content-type",
  "content-length",
  "cross-origin-opener-policy",
  "date",
  "keep-alive",
  "permissions-policy",
  "referrer-policy",
  "transfer-encoding",
  "vary",
  "allow",
  "x-content-type-options",
  "x-frame-options",
  "content-encoding",
  "etag",
  "x-stack-request-id",
  "x-hexclave-request-id",
  // Hexclave rebrand: backend dual-emits these alongside the x-stack-* variants
  // with identical values. Hide the duplicates so snapshots stay focused on the
  // existing x-stack-* entries — avoids bloating every response snapshot in the
  // suite, and PR 3 (removing the dual-emit) won't need to re-regen them.
  "x-hexclave-known-error",
  "x-hexclave-actual-status",
  "x-middleware-rewrite",
] as const;

const stripHeaders = [] as const;

const stripFields = [
  "access_token",
  "refresh_token",
  "expires_in",
  "refreshTokenId",
  "refresh_token_id",
  "exp",
  "iat",
  "date",
  "last_active_at_millis",
  "signed_up_at_millis",
  "expires_at_millis",
  "created_at_millis",
  "effective_at_millis",
  "sent_at_millis",
  "updated_at_millis",
  "manually_revoked_at_millis",
  "scheduled_at_millis",
  "started_rendering_at_millis",
  "rendered_at_millis",
  "started_sending_at_millis",
  "delivered_at_millis",
  "skipped_at_millis",
  "error_at_millis",
  "bounced_at_millis",
  "delivery_delayed_at_millis",
  "opened_at_millis",
  "clicked_at_millis",
  "marked_as_spam_at_millis",
  "last_four",
  "attempt_code",
  "nonce",
  "authorization_code",
  "secret",
  "token",
  "createdAt",
  "updatedAt",
  "current_period_end",
  "response",
  "msgId",
  "endpointId",
  "timestamp",
  "responseStatusCode",
  "responseDurationMs",
  "iterator",
  "prevIterator",
  "nextAttempt",
  "lastFour",
  "port",
  "wall_clock_time",
  "cpu_time",
  "hourly_counts",
  "live_users",
  // Hourly series are keyed to wall-clock UTC hour boundaries, so a test that
  // straddles a boundary can redistribute counts between the final buckets.
  "hourly_users",
  "hourly_active_users",
  "hourly_page_views",
  "hourly_visitors",
] as const;

const stripFieldsIfString = [
  "secret_api_key",
  "publishable_client_key",
  "secret_server_key",
  "super_secret_admin_key",
  "stripe_account_id",
] as const;

const stripCookies = [
  "_interaction",
  "_interaction.sig",
  "_interaction_resume",
  "_interaction_resume.sig",
  "_session",
  "_session.sig",
  "_session.legacy",
  "_session.legacy.sig",
] as const;

const stripUrlQueryParams = [
  "redirect_uri",
  "state",
  "code",
  "code_challenge",
  "interaction_uid",
] as const;

const keyedCookieNamePrefixes = [
  "stack-oauth-inner-",
  // Hexclave rebrand: dual-written OAuth inner-state cookie
  "hexclave-oauth-inner-",
] as const;

// Hexclave rebrand: backend dual-writes these Set-Cookie entries alongside the
// stack-* variants with identical values. Hide the hexclave-* duplicates so
// snapshots stay focused on the existing stack-* entries — mirrors the
// hideHeaders strategy for x-hexclave-{known-error,actual-status} and avoids
// regenerating every OAuth response snapshot in the suite. PR 3 (removing the
// dual-write) won't need to re-regen them.
const hiddenSetCookieNamePrefixes = [
  "hexclave-oauth-inner-",
] as const;

// Track Headers instances we've already stripped duplicate hexclave Set-Cookies
// from, to avoid infinite recursion when nicify re-enters on the filtered copy.
const dualFilteredHeaders = new WeakSet<Headers>();

const stringRegexReplacements = [
  [/(\/integrations\/(neon|custom)\/oauth\/idp\/(interaction|auth)\/)[a-zA-Z0-9_-]+/gi, "$1<stripped $3 UID>"],
  [new RegExp(`localhost\:${getPortPrefix()}`, "gi"), "localhost:<$$NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX>"],
  [new RegExp(`localhost\%3A${getPortPrefix()}`, "gi"), "localhost%3A%3C%24NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX%3E"],
  [/(Timeout exceeded: elapsed )[0-9.]+( ms)/gi, "$1<stripped time>$2"],
  // react-dom serializes a zero-length CSS value as either "0" or "0px" depending on
  // the react-dom build that renders the email — the mock and prod Freestyle sandboxes
  // resolve different versions, so the same template yields "margin:0" in one E2E mode
  // and "margin:0px" in the other, breaking inline email-HTML snapshots across modes.
  // "0px" and "0" are identical in CSS, so canonicalize the standalone zero-pixel form
  // to unitless "0" for stable, environment-independent snapshots. \b keeps this from
  // touching non-zero lengths like "10px"/"100px" (no word boundary precedes their "0").
  [/\b0px\b/g, "0"],
] as const;


function addAll<T>(set: Set<T>, values: readonly T[]) {
  for (const value of values) {
    set.add(value);
  }
}

const snapshotSerializer: SnapshotSerializer = {
  serialize(val, config, indentation, depth, refs, printer) {
    return nicify(val, {
      currentIndent: indentation,
      maxDepth: config.maxDepth - depth,
      refs: new Map(refs.map((ref, i) => [ref, `vitestRef[${i}]`])),
      lineIndent: config.indent,
      multiline: true,
      path: "snapshot",
      overrides: (value, options) => {
        const parentValue = options?.parent?.value;

        // Strip all string regex replacements
        if (typeof value === "string") {
          for (const [regex, replacement] of stringRegexReplacements) {
            const newValue: string = value.replace(regex, replacement);
            if (newValue !== value) return nicify(newValue, options);
          }
        }

        // Strip all API keys
        if (typeof value === "string" && isApiKey(value)) {
          const apiKey = parseProjectApiKey(value);
          return `${apiKey.prefix}_<stripped ${apiKey.isPublic ? "public " : ""}${apiKey.type} API key>`;
        }

        // Strip all UUIDs except all-zero UUID
        if (typeof value === "string") {
          const newValue = value.replace(
            /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
            "<stripped UUID>"
          );
          if (newValue !== value) return nicify(newValue, options);
        }
        // match something like "Your code is 34JXKG" and replace it with "Your code is <stripped code>"
        if (typeof value === "string") {
          const newValue = value.replace(
            /Your code is [0-9A-Z]{6}/gi,
            "Your code is <stripped code>"
          );
          if (newValue !== value) return nicify(newValue, options);
        }

        // strip svix message id with the format msg_2ssgKCpeddVpe8ZpqB8Zl0rmXyD
        if (typeof value === "string") {
          const newValue = value.replace(/msg_[0-9a-zA-Z]{27}/gi, "<stripped svix message id>");
          if (newValue !== value) return nicify(newValue, options);
        }

        // Strip URL query params
        const urlRegexHeuristic = /(?:(?:https?|ftp|file):\/\/|www\.|ftp\.)(?:\([-A-Z0-9+&@#\/%=~_|$<>?!:,.]*\)|[-A-Z0-9+&@#\/%=~_|<>$?!:,.])*(?:\([-A-Z0-9+&@#\/%=~_|$?!:,.]*\)|[A-Z0-9+&@#\/%=~_|$])/igm;
        if (typeof value === "string") {
          for (const urlMatch of value.matchAll(urlRegexHeuristic)) {
            const questionMarkIndex = urlMatch[0].indexOf("?");
            if (questionMarkIndex >= 0) {
              const searchParamsObj = new URLSearchParams(urlMatch[0].slice(questionMarkIndex + 1));
              for (const param of stripUrlQueryParams) {
                if (searchParamsObj.has(param)) {
                  searchParamsObj.set(param, "<stripped query param>");
                }
              }
              let newValue = `${urlMatch[0].slice(0, questionMarkIndex)}?${searchParamsObj.toString()}`;
              if (urlMatch[0].endsWith("/") !== newValue.endsWith("/")) {
                if (urlMatch[0].endsWith("/")) {
                  newValue += "/";
                } else {
                  newValue = newValue.slice(0, -1);
                }
              }
              if (newValue !== value) return nicify(newValue, options);
            }
          }
        }

        // Strip headers
        if (options?.parent?.value instanceof Headers) {
          if (typeof value !== "string") {
            throw new HexclaveAssertionError("Headers should only contain string values");
          }
          const headerName = options.keyInParent?.toString().toLowerCase();
          if (typedIncludes(stripHeaders, headerName)) {
            return `<stripped header '${headerName}'>`;
          }
          if (headerName === "set-cookie") {
            const partsStrings = value.split(";").map((part) => part.trim());
            let cookieName = partsStrings[0].split("=")[0];
            const matchedKeyedPrefix = keyedCookieNamePrefixes.find((prefix) => cookieName.startsWith(prefix));
            if (matchedKeyedPrefix !== undefined) {
              cookieName = `${matchedKeyedPrefix}<stripped cookie name key>`;
            }
            const cookieValue = partsStrings[0].split("=")[1];
            const parts = new Map(partsStrings.map((part) => {
              const [key, value] = part.split("=");
              return [key, value];
            }));
            const expiresDate = new Date(parts.get("Expires") ?? "2002-01-01");
            if (expiresDate.getTime() < new Date("2001-01-01").getTime()) {
              return `<deleting cookie '${cookieName}' at path '${parts.get("Path") ?? "/"}'>`;
            } else {
              return `<setting cookie ${JSON.stringify(cookieName)} at path ${JSON.stringify(parts.get("path") ?? "/")} to ${typedIncludes(stripCookies, cookieName) ? "<stripped cookie value>" : JSON.stringify(cookieValue)}>`;
            }
          }
        }

        // Hide fields
        const oldHideFields = options?.hideFields ?? [];
        let newHideFields = new Set<PropertyKey>(oldHideFields);
        if (
          (typeof value === "object" || typeof value === "function")
          && value
          && "getSnapshotSerializerOptions" in value
        ) {
          const snapshotSerializerOptions = (value.getSnapshotSerializerOptions as any)();
          addAll(newHideFields, snapshotSerializerOptions?.hideFields ?? []);
        }
        if (value instanceof Headers) {
          // Pre-filter dual-written hexclave-* Set-Cookies before adding hideHeaders,
          // so the recursive nicify call serializes only the stack-* entries.
          if (!dualFilteredHeaders.has(value)) {
            const setCookies = value.getSetCookie();
            const filteredSetCookies = setCookies.filter(c =>
              !hiddenSetCookieNamePrefixes.some(prefix => c.startsWith(prefix))
            );
            if (filteredSetCookies.length !== setCookies.length) {
              const filteredHeaders = new Headers();
              for (const [name, val] of value.entries()) {
                if (name.toLowerCase() !== "set-cookie") {
                  filteredHeaders.append(name, val);
                }
              }
              for (const cookie of filteredSetCookies) {
                filteredHeaders.append("set-cookie", cookie);
              }
              dualFilteredHeaders.add(filteredHeaders);
              return nicify(filteredHeaders, options);
            }
          }
          addAll(newHideFields, hideHeaders);
        }
        if (newHideFields.size !== oldHideFields.length) {
          return nicify(value, {
            ...options,
            hideFields: [...newHideFields],
          });
        }

        // Strip fields
        if (
          (typeof parentValue === "object" || typeof parentValue === "function")
          && parentValue
          && options.keyInParent
          && "getSnapshotSerializerOptions" in parentValue
        ) {
          const parentSnapshotSerializerOptions = (parentValue.getSnapshotSerializerOptions as any)();
          if (parentSnapshotSerializerOptions?.stripFields?.includes(options.keyInParent)) {
            return `<stripped field '${options.keyInParent.toString()}'>`;
          }
        }
        const allStripFields = [...stripFields, ...typeof value === "string" ? stripFieldsIfString : []];
        if (typedIncludes(allStripFields, options?.keyInParent)) {
          return `<stripped field '${options.keyInParent}'>`;
        }

        // Otherwise, use default serialization
        return null;
      },
    });
  },
  test(val) {
    return true;
  },
};
export default snapshotSerializer;

import withPostHog from "@/analytics";
import { arePlanLimitsEnforced } from "@/lib/plan-entitlements";
import { globalPrismaClient } from "@/prisma-client";
import { getHexclaveServerApp } from "@/hexclave";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { urlSchema, yupBoolean, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { HTTP_METHODS } from "@hexclave/shared/dist/utils/http";
import { filterUndefined, typedKeys } from "@hexclave/shared/dist/utils/objects";
import { UnionToIntersection } from "@hexclave/shared/dist/utils/types";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import * as yup from "yup";
import { getClickhouseAdminClient } from "./clickhouse";
import { getEndUserInfo } from "./end-users";
import { DEFAULT_BRANCH_ID } from "./tenancies";

export const endUserIpInfoSchema = yupObject({
  ip: yupString().defined(),
  isTrusted: yupBoolean().defined(),
  countryCode: yupString().optional(),
  regionCode: yupString().optional(),
  cityName: yupString().optional(),
  latitude: yupNumber().optional(),
  longitude: yupNumber().optional(),
  tzIdentifier: yupString().optional(),
});

export type EndUserIpInfo = yup.InferType<typeof endUserIpInfoSchema>;

type ClickhouseEndUserIpInfo = {
  ip: string,
  is_trusted: boolean,
  country_code?: string,
  region_code?: string,
  city_name?: string,
  latitude?: number,
  longitude?: number,
  tz_identifier?: string,
};

function toClickhouseEndUserIpInfo(ipInfo: EndUserIpInfo | null): ClickhouseEndUserIpInfo | null {
  if (!ipInfo) {
    return null;
  }

  return {
    ip: ipInfo.ip,
    is_trusted: ipInfo.isTrusted,
    country_code: ipInfo.countryCode ?? undefined,
    region_code: ipInfo.regionCode ?? undefined,
    city_name: ipInfo.cityName ?? undefined,
    latitude: ipInfo.latitude ?? undefined,
    longitude: ipInfo.longitude ?? undefined,
    tz_identifier: ipInfo.tzIdentifier ?? undefined,
  };
}

/**
 * Extracts the end user IP info from the current request.
 * Must be called before any async operations as it uses dynamic APIs.
 */
export async function getEndUserIpInfoForEvent(): Promise<EndUserIpInfo | null> {
  const endUserInfo = await getEndUserInfo();
  if (!endUserInfo) {
    return null;
  }

  const info = endUserInfo.maybeSpoofed ? endUserInfo.spoofedInfo : endUserInfo.exactInfo;
  return {
    ip: info.ip,
    isTrusted: !endUserInfo.maybeSpoofed,
    countryCode: info.countryCode,
    regionCode: info.regionCode,
    cityName: info.cityName,
    latitude: info.latitude,
    longitude: info.longitude,
    tzIdentifier: info.tzIdentifier,
  };
}

type EventType = {
  id: string,
  dataSchema: yup.Schema<any>,
  // The event type that this event type inherits from. Use this if every one of the events is also another event and you want all the fields from it.
  inherits: EventType[],
};

type SystemEventTypeBase = EventType & {
  id: `$${string}`,
};

const LegacyApiEventType = {
  id: "$legacy-api",
  dataSchema: yupObject({}),
  inherits: [],
} as const satisfies SystemEventTypeBase;

const ProjectEventType = {
  id: "$project",
  dataSchema: yupObject({
    projectId: yupString().defined(),
  }),
  inherits: [],
} as const satisfies SystemEventTypeBase;

const ProjectActivityEventType = {
  id: "$project-activity",
  dataSchema: yupObject({}),
  inherits: [ProjectEventType],
} as const satisfies SystemEventTypeBase;

const UserActivityEventType = {
  id: "$user-activity",
  dataSchema: yupObject({
    // old events of this type may not have a branchId field, so we default to the default branch ID
    branchId: yupString().defined().default(DEFAULT_BRANCH_ID),
    userId: yupString().uuid().defined(),
    // old events of this type may not have an isAnonymous field, so we default to false
    isAnonymous: yupBoolean().defined().default(false),
    teamId: yupString().optional(),
  }),
  inherits: [ProjectActivityEventType],
} as const satisfies SystemEventTypeBase;

const SessionActivityEventType = {
  id: "$session-activity",
  dataSchema: yupObject({
    sessionId: yupString().defined(),
  }),
  inherits: [UserActivityEventType],
} as const satisfies SystemEventTypeBase;

const TokenRefreshEventType = {
  id: "$token-refresh",
  dataSchema: yupObject({
    refreshTokenId: yupString().defined(),
    ipInfo: endUserIpInfoSchema.nullable().defined(),
  }),
  inherits: [UserActivityEventType],
} as const satisfies SystemEventTypeBase;


const ApiRequestEventType = {
  id: "$api-request",
  dataSchema: yupObject({
    method: yupString().oneOf(typedKeys(HTTP_METHODS)).defined(),
    url: urlSchema.defined(),
    body: yupMixed().nullable().optional(),
    headers: yupObject().defined(),
  }),
  inherits: [
    ProjectEventType,
  ],
} as const satisfies SystemEventTypeBase;

const SignUpRuleTriggerEventType = {
  id: "$sign-up-rule-trigger",
  dataSchema: yupObject({
    projectId: yupString().defined(),
    branchId: yupString().defined(),
    ruleId: yupString().defined(),
    action: yupString().oneOf(['allow', 'reject', 'restrict', 'log']).defined(),
    email: yupString().nullable().defined(),
    authMethod: yupString().oneOf(['password', 'otp', 'oauth', 'passkey']).nullable().defined(),
    oauthProvider: yupString().nullable().defined(),
  }),
  inherits: [],
} as const satisfies SystemEventTypeBase;

const SignInAttemptEventType = {
  id: "$sign-in-attempt",
  dataSchema: yupObject({
    projectId: yupString().defined(),
    branchId: yupString().defined(),
    userId: yupString().nullable().defined(),
    outcome: yupString().oneOf(["success", "failed"]).defined(),
    method: yupString().oneOf(["password", "otp", "passkey", "oauth"]).defined(),
    failureReason: yupString().nullable().defined(),
    email: yupString().nullable().defined(),
    oauthProvider: yupString().nullable().defined(),
    ipInfo: endUserIpInfoSchema.nullable().defined(),
  }),
  inherits: [],
} as const satisfies SystemEventTypeBase;

const PermissionCheckEventType = {
  id: "$permission-check",
  dataSchema: yupObject({
    projectId: yupString().defined(),
    branchId: yupString().defined(),
    userId: yupString().nullable().defined(),
    outcome: yupString().oneOf(["denied"]).defined(),
    permissionId: yupString().defined(),
    teamId: yupString().nullable().defined(),
    scope: yupString().oneOf(["team", "project"]).defined(),
    ipInfo: endUserIpInfoSchema.nullable().defined(),
  }),
  inherits: [],
} as const satisfies SystemEventTypeBase;

const UserRestrictedEventType = {
  id: "$user-restricted",
  dataSchema: yupObject({
    projectId: yupString().defined(),
    branchId: yupString().defined(),
    userId: yupString().defined(),
    restrictedReason: yupString().defined(),
    ipInfo: endUserIpInfoSchema.nullable().defined(),
  }),
  inherits: [],
} as const satisfies SystemEventTypeBase;

export const TV_DISPLAY_SECURITY_ACTIONS = [
  "pairing-approved",
  "credential-issued",
  "refresh-reuse-detected",
  "display-renamed",
  "profile-reassigned",
  "display-revoked",
] as const;
export type TvDisplaySecurityAction = typeof TV_DISPLAY_SECURITY_ACTIONS[number];

const TvDisplaySecurityEventType = {
  id: "$tv-display-security",
  dataSchema: yupObject({
    projectId: yupString().defined(),
    branchId: yupString().defined(),
    action: yupString().oneOf(TV_DISPLAY_SECURITY_ACTIONS).defined(),
    displayId: yupString().uuid().nullable().defined(),
    actorUserId: yupString().uuid().nullable().defined(),
  }).noUnknown().defined(),
  inherits: [],
} as const satisfies SystemEventTypeBase;

export const SystemEventTypes = stripEventTypeSuffixFromKeys({
  ProjectEventType,
  ProjectActivityEventType,
  UserActivityEventType,
  SessionActivityEventType,
  TokenRefreshEventType,
  ApiRequestEventType,
  LegacyApiEventType,
  SignUpRuleTriggerEventType,
  SignInAttemptEventType,
  PermissionCheckEventType,
  UserRestrictedEventType,
  TvDisplaySecurityEventType,
} as const);
const systemEventTypesById = new Map(Object.values(SystemEventTypes).map(eventType => [eventType.id, eventType]));

function stripEventTypeSuffixFromKeys<T extends Record<`${string}EventType`, unknown>>(t: T): { [K in keyof T as K extends `${infer Key}EventType` ? Key : never]: T[K] } {
  return Object.fromEntries(Object.entries(t).map(([key, value]) => [key.replace(/EventType$/, ""), value])) as any;
}

type DataOfMany<T extends EventType[]> = UnionToIntersection<T extends unknown ? DataOf<T[number]> : never>;  // distributive conditional. See: https://www.typescriptlang.org/docs/handbook/2/conditional-types.html#distributive-conditional-types

type DataOf<T extends EventType> =
  & yup.InferType<T["dataSchema"]>
  & DataOfMany<T["inherits"]>;

/**
 * Do not wrap this function in waitUntil or runAsynchronously as it may use dynamic APIs
 */
export async function logEvent<T extends EventType[]>(
  eventTypes: T,
  data: DataOfMany<T>,
  options: {
    /**
     * Billing team id for analytics-quota debiting, or null if the project
     * has no owner team. Required: every caller has the tenancy (or project)
     * in hand, so resolving this once at the call site via
     * `getBillingTeamId(tenancy.project)` is strictly cheaper than a
     * per-event DB lookup inside logEvent.
     */
    billingTeamId: string | null,
    time?: Date | { start: Date, end: Date },
    refreshTokenId?: string,
    sessionReplayId?: string,
    sessionReplaySegmentId?: string,
  }
) {
  let timeOrTimeRange = options.time ?? new Date();
  const timeRange = "start" in timeOrTimeRange && "end" in timeOrTimeRange ? timeOrTimeRange : { start: timeOrTimeRange, end: timeOrTimeRange };
  const isWide = timeOrTimeRange === timeRange;

  // assert all event types are valid
  for (const eventType of eventTypes) {
    if (eventType.id.startsWith("$")) {
      if (!systemEventTypesById.has(eventType.id as any)) {
        throw new HexclaveAssertionError(`Invalid system event type: ${eventType.id}`, { eventType });
      }
    } else {
      throw new HexclaveAssertionError(`Non-system event types are not supported yet`, { eventType });
    }
  }


  // traverse and list all events in the inheritance chain
  const allEventTypes = new Set<EventType>();
  const addEventType = (eventType: EventType) => {
    if (allEventTypes.has(eventType)) {
      return;
    }
    allEventTypes.add(eventType);
    eventType.inherits.forEach(addEventType);
  };
  eventTypes.forEach(addEventType);


  // validate & transform data
  const originalData = data;
  for (const eventType of allEventTypes) {
    try {
      data = await eventType.dataSchema.validate(data, { strict: true, stripUnknown: false });
    } catch (error) {
      if (error instanceof yup.ValidationError) {
        throw new HexclaveAssertionError(`Invalid event data for event type: ${eventType.id}`, { eventType, data, originalData, originalEventTypes: eventTypes, cause: error });
      }
      throw error;
    }
  }


  // get end user information
  const endUserInfo = await getEndUserInfo();  // this is a dynamic API, can't run it asynchronously
  const endUserInfoInner = endUserInfo?.maybeSpoofed ? endUserInfo.spoofedInfo : endUserInfo?.exactInfo;
  const eventTypesArray = [...allEventTypes];
  const dataRecord = data as Record<string, unknown> | null | undefined;
  const projectId =
    typeof dataRecord === "object" && dataRecord && typeof dataRecord.projectId === "string"
      ? dataRecord.projectId
      : "";
  const branchId =
    typeof dataRecord === "object" && dataRecord && typeof dataRecord.branchId === "string"
      ? dataRecord.branchId
      : DEFAULT_BRANCH_ID;
  const userId =
    typeof dataRecord === "object" && dataRecord && typeof dataRecord.userId === "string"
      ? dataRecord.userId
      : "";


  // rest is no more dynamic APIs so we can run it asynchronously
  runAsynchronouslyAndWaitUntil((async () => {
    const billingTeamId = options.billingTeamId;

    if (billingTeamId != null && arePlanLimitsEnforced()) {
      // The analytics-events quota lives in bulldozer, but event logging must
      // not hard-depend on it: if bulldozer is unreachable, report it and log
      // the event anyway (treat the quota as available)
      let isDebited = true;
      try {
        const app = getHexclaveServerApp();
        const eventsItem = await app.getItem({ itemId: ITEM_IDS.analyticsEvents, teamId: billingTeamId });
        isDebited = await eventsItem.tryDecreaseQuantity(1);
      } catch (error) {
        captureError("events:analytics-events-quota-check", error);
      }
      if (!isDebited) {
        return;
      }
    }

    // log event in DB
    await globalPrismaClient.event.create({
      data: {
        systemEventTypeIds: eventTypesArray.map(eventType => eventType.id),
        data: data as any,
        isEndUserIpInfoGuessTrusted: !endUserInfo?.maybeSpoofed,
        endUserIpInfoGuess: endUserInfoInner ? {
          create: {
            ip: endUserInfoInner.ip,
            countryCode: endUserInfoInner.countryCode,
            regionCode: endUserInfoInner.regionCode,
            cityName: endUserInfoInner.cityName,
            tzIdentifier: endUserInfoInner.tzIdentifier,
            latitude: endUserInfoInner.latitude,
            longitude: endUserInfoInner.longitude,
          },
        } : undefined,
        isWide,
        eventStartedAt: timeRange.start,
        eventEndedAt: timeRange.end,
      },
    });

    // Log specific events to ClickHouse
    const clickhouseEventTypes = [
      '$token-refresh',
      '$sign-up-rule-trigger',
      '$sign-in-attempt',
      '$permission-check',
      '$user-restricted',
    ];
    const matchingEventType = eventTypesArray.find(e => clickhouseEventTypes.includes(e.id));
    if (matchingEventType) {
      let clickhouseEventData: Record<string, unknown>;
      if (matchingEventType.id === "$token-refresh") {
        const refreshTokenId =
          typeof dataRecord === "object" && dataRecord && typeof dataRecord.refreshTokenId === "string"
            ? dataRecord.refreshTokenId
            : throwErr(new HexclaveAssertionError("refreshTokenId is required for $token-refresh ClickHouse event", { dataRecord }));
        const isAnonymous =
          typeof dataRecord === "object" && dataRecord && typeof dataRecord.isAnonymous === "boolean"
            ? dataRecord.isAnonymous
            : throwErr(new HexclaveAssertionError("isAnonymous is required for $token-refresh ClickHouse event", { dataRecord }));
        const ipInfo =
          typeof dataRecord === "object" && dataRecord
            ? (dataRecord.ipInfo as EndUserIpInfo | null | undefined)
            : undefined;
        clickhouseEventData = {
          refresh_token_id: refreshTokenId,
          is_anonymous: isAnonymous,
          ip_info: toClickhouseEndUserIpInfo(ipInfo ?? null),
        };
      } else if (matchingEventType.id === "$sign-up-rule-trigger") {
        const ruleId =
          typeof dataRecord === "object" && dataRecord && typeof dataRecord.ruleId === "string"
            ? dataRecord.ruleId
            : throwErr(new HexclaveAssertionError("ruleId is required for $sign-up-rule-trigger ClickHouse event", { dataRecord }));
        const action =
          typeof dataRecord === "object" && dataRecord && typeof dataRecord.action === "string"
            ? dataRecord.action
            : throwErr(new HexclaveAssertionError("action is required for $sign-up-rule-trigger ClickHouse event", { dataRecord }));
        const email =
          typeof dataRecord === "object" && dataRecord
            ? (dataRecord.email as string | null | undefined) ?? null
            : null;
        const authMethod =
          typeof dataRecord === "object" && dataRecord
            ? (dataRecord.authMethod as string | null | undefined) ?? null
            : null;
        const oauthProvider =
          typeof dataRecord === "object" && dataRecord
            ? (dataRecord.oauthProvider as string | null | undefined) ?? null
            : null;
        clickhouseEventData = {
          rule_id: ruleId,
          action,
          email,
          auth_method: authMethod,
          oauth_provider: oauthProvider,
        };
      } else if (matchingEventType.id === "$sign-in-attempt") {
        const outcome =
          typeof dataRecord === "object" && dataRecord && typeof dataRecord.outcome === "string"
            ? dataRecord.outcome
            : throwErr(new HexclaveAssertionError("outcome is required for $sign-in-attempt ClickHouse event", { dataRecord }));
        const method =
          typeof dataRecord === "object" && dataRecord && typeof dataRecord.method === "string"
            ? dataRecord.method
            : throwErr(new HexclaveAssertionError("method is required for $sign-in-attempt ClickHouse event", { dataRecord }));
        const failureReason =
          typeof dataRecord === "object" && dataRecord
            ? (dataRecord.failureReason as string | null | undefined) ?? null
            : null;
        const email =
          typeof dataRecord === "object" && dataRecord
            ? (dataRecord.email as string | null | undefined) ?? null
            : null;
        const oauthProvider =
          typeof dataRecord === "object" && dataRecord
            ? (dataRecord.oauthProvider as string | null | undefined) ?? null
            : null;
        const ipInfo =
          typeof dataRecord === "object" && dataRecord
            ? (dataRecord.ipInfo as EndUserIpInfo | null | undefined)
            : undefined;
        clickhouseEventData = {
          outcome,
          method,
          failure_reason: failureReason,
          email,
          oauth_provider: oauthProvider,
          ip_info: toClickhouseEndUserIpInfo(ipInfo ?? null),
        };
      } else if (matchingEventType.id === "$permission-check") {
        const outcome =
          typeof dataRecord === "object" && dataRecord && typeof dataRecord.outcome === "string"
            ? dataRecord.outcome
            : throwErr(new HexclaveAssertionError("outcome is required for $permission-check ClickHouse event", { dataRecord }));
        const permissionId =
          typeof dataRecord === "object" && dataRecord && typeof dataRecord.permissionId === "string"
            ? dataRecord.permissionId
            : throwErr(new HexclaveAssertionError("permissionId is required for $permission-check ClickHouse event", { dataRecord }));
        const scope =
          typeof dataRecord === "object" && dataRecord && typeof dataRecord.scope === "string"
            ? dataRecord.scope
            : throwErr(new HexclaveAssertionError("scope is required for $permission-check ClickHouse event", { dataRecord }));
        const teamId =
          typeof dataRecord === "object" && dataRecord
            ? (dataRecord.teamId as string | null | undefined) ?? null
            : null;
        const ipInfo =
          typeof dataRecord === "object" && dataRecord
            ? (dataRecord.ipInfo as EndUserIpInfo | null | undefined)
            : undefined;
        clickhouseEventData = {
          outcome,
          permission_id: permissionId,
          team_id: teamId,
          scope,
          ip_info: toClickhouseEndUserIpInfo(ipInfo ?? null),
        };
      } else if (matchingEventType.id === "$user-restricted") {
        const restrictedReason =
          typeof dataRecord === "object" && dataRecord && typeof dataRecord.restrictedReason === "string"
            ? dataRecord.restrictedReason
            : throwErr(new HexclaveAssertionError("restrictedReason is required for $user-restricted ClickHouse event", { dataRecord }));
        const ipInfo =
          typeof dataRecord === "object" && dataRecord
            ? (dataRecord.ipInfo as EndUserIpInfo | null | undefined)
            : undefined;
        clickhouseEventData = {
          restricted_reason: restrictedReason,
          ip_info: toClickhouseEndUserIpInfo(ipInfo ?? null),
        };
      } else {
        throw new HexclaveAssertionError(`Unhandled ClickHouse event type: ${matchingEventType.id}`, { matchingEventType });
      }

      if (!projectId) {
        throw new HexclaveAssertionError(
          `projectId is required for ClickHouse event insertion (${matchingEventType.id})`,
          { matchingEventType, dataRecord }
        );
      }
      const clickhouseClient = getClickhouseAdminClient();
      // Resolve refresh_token_id: prefer explicit option, fall back to data for $token-refresh events
      const resolvedRefreshTokenId = options.refreshTokenId
        ?? (matchingEventType.id === "$token-refresh" && typeof (clickhouseEventData as any).refresh_token_id === "string"
          ? (clickhouseEventData as any).refresh_token_id as string
          : null);
      // Resolve team_id from the event data for $permission-check events.
      const resolvedTeamId = matchingEventType.id === "$permission-check" && typeof (clickhouseEventData as any).team_id === "string"
        ? (clickhouseEventData as any).team_id as string
        : null;

      await clickhouseClient.insert({
        table: "analytics_internal.events",
        values: [{
          event_type: matchingEventType.id,
          event_at: timeRange.end,
          data: clickhouseEventData,
          project_id: projectId,
          branch_id: branchId,
          user_id: userId || null,
          team_id: resolvedTeamId ?? null,
          refresh_token_id: resolvedRefreshTokenId ?? null,
          session_replay_id: options.sessionReplayId ?? null,
          session_replay_segment_id: options.sessionReplaySegmentId ?? null,
        }],
        format: "JSONEachRow",
        clickhouse_settings: {
          date_time_input_format: "best_effort",
          async_insert: 1,
        },
      });
    }

    // log event in PostHog
    if (getNodeEnvironment().includes("production") && !getEnvVariable("CI", "")) {
      await withPostHog(async posthog => {
        const distinctId = typeof data === "object" && data && "userId" in data ? (data.userId as string) : `backend-anon-${generateUuid()}`;
        for (const eventType of allEventTypes) {
          const postHogEventName = `stack_${eventType.id.replace(/^\$/, "system_").replace(/-/g, "_")}`;
          posthog.capture({
            event: postHogEventName,
            distinctId,
            groups: filterUndefined({
              projectId: typeof data === "object" && data && "projectId" in data ? (typeof data.projectId === "string" ? data.projectId : throwErr("Project ID is not a string for some reason?", { data })) : undefined,
            }),
            timestamp: timeRange.end,
            properties: {
              data,
              is_wide: isWide,
              event_started_at: timeRange.start,
              event_ended_at: timeRange.end,
            },
          });
        }
      });
    }
  })());
}

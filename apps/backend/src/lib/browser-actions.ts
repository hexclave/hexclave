import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { createAnalyticsClickmapToken } from "@/lib/analytics-clickmap-tokens";
import { createImpersonationAuthTokens, MAX_AUTH_SESSION_EXPIRATION_MS } from "@/lib/tokens";
import { globalPrismaClient } from "@/prisma-client";
import { claimVerificationCode, createVerificationCodeHandler } from "@/route-handlers/verification-code-handler";
import { VerificationCodeType } from "@/generated/prisma/client";
import { KnownErrors } from "@hexclave/shared";
import { yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import {
  BROWSER_ACTION_QUERY_PARAM,
  createClickmapOverlaySnippet,
  generateImpersonateSnippet,
} from "@hexclave/shared/dist/utils/browser-action-snippets";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import type { Tenancy } from "@/lib/tenancies";
import { normalizeTrustedOrigin, validateTrustedOrigin } from "@/lib/trusted-origins";

export const DEFAULT_BROWSER_ACTION_TTL_MS = 5 * 60 * 1000;
export const MAX_BROWSER_ACTION_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_IMPERSONATION_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

type ImpersonationBrowserActionData = {
  type: "impersonation",
  origin: string,
  refresh_token: string,
  expires_at_millis: number,
};

type ClickmapBrowserActionData = {
  type: "clickmap-overlay",
  origin: string,
};

export type BrowserActionData =
  | ImpersonationBrowserActionData
  | ClickmapBrowserActionData;

function isBrowserActionData(value: unknown): value is BrowserActionData {
  if (typeof value !== "object" || value === null || !("type" in value) || !("origin" in value)) {
    return false;
  }
  if (typeof value.origin !== "string") return false;
  if (value.type === "clickmap-overlay") {
    return Object.keys(value).every(key => key === "type" || key === "origin");
  }
  if (
    value.type !== "impersonation"
    || !("refresh_token" in value)
    || !("expires_at_millis" in value)
  ) {
    return false;
  }
  return typeof value.refresh_token === "string"
    && typeof value.expires_at_millis === "number"
    && Number.isInteger(value.expires_at_millis);
}

const browserActionDataSchema = yupMixed<BrowserActionData>()
  .defined()
  .test("browser-action-data", "Invalid browser action data", isBrowserActionData);

export const browserActionHandler = createVerificationCodeHandler({
  type: VerificationCodeType.BROWSER_ACTION,
  data: browserActionDataSchema,
  method: yupObject({}).defined(),
  response: yupObject({
    statusCode: yupNumber().defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({}).defined(),
  }).defined(),
  handler: async () => {
    throw new StatusError(StatusError.BadRequest, "Browser actions must be consumed through the browser action endpoint");
  },
});

function validateBrowserActionTtl(expiresInMillis: number): number {
  if (!Number.isInteger(expiresInMillis) || expiresInMillis < 1 || expiresInMillis > MAX_BROWSER_ACTION_TTL_MS) {
    throw new StatusError(StatusError.BadRequest, "Invalid browser action expiration");
  }
  return expiresInMillis;
}

type CreateBrowserActionOptions = {
  tenancy: Tenancy,
  origin: string,
  expiresInMillis: number,
  apiUrl: string,
  sessionExpiresInMillis?: number,
} & (
  | {
    type: "impersonation",
    params: { userId: string },
  }
  | {
    type: "clickmap-overlay",
    params: Record<never, never>,
  }
);

export async function createBrowserAction(options: CreateBrowserActionOptions): Promise<{
  id: string,
  url: string,
  expiresAtMillis: number,
  refreshTokenId?: string,
}> {
  const expiresInMillis = validateBrowserActionTtl(options.expiresInMillis);
  const origin = validateTrustedOrigin(options.tenancy, options.origin);
  const expiresAtMillis = Date.now() + expiresInMillis;
  let data: BrowserActionData;
  let refreshTokenId: string | undefined;

  if (options.type === "impersonation") {
    const sessionExpiresInMillis = options.sessionExpiresInMillis ?? DEFAULT_IMPERSONATION_SESSION_TTL_MS;
    if (!Number.isInteger(sessionExpiresInMillis) || sessionExpiresInMillis < 1 || sessionExpiresInMillis > MAX_AUTH_SESSION_EXPIRATION_MS) {
      throw new StatusError(StatusError.BadRequest, "Invalid impersonation session expiration");
    }
    const userId = options.params.userId;
    const user = await usersCrudHandlers.adminRead({
      user_id: userId,
      tenancy: options.tenancy,
      allowedErrorTypes: [KnownErrors.UserNotFound],
    });
    const tokens = await createImpersonationAuthTokens({
      tenancy: options.tenancy,
      projectUserId: user.id,
      expiresInMillis: sessionExpiresInMillis,
      apiUrl: options.apiUrl,
    });
    refreshTokenId = tokens.refreshTokenId;
    data = {
      type: "impersonation",
      origin,
      refresh_token: tokens.refreshToken,
      expires_at_millis: Date.now() + sessionExpiresInMillis,
    };
  } else {
    data = {
      type: "clickmap-overlay",
      origin,
    };
  }

  let code: { code: string };
  try {
    code = await browserActionHandler.createCode({
      tenancy: options.tenancy,
      method: {},
      data,
      callbackUrl: undefined,
      expiresInMs: expiresInMillis,
    });
  } catch (error) {
    if (data.type === "impersonation") {
      await globalPrismaClient.projectUserRefreshToken.deleteMany({
        where: {
          tenancyId: options.tenancy.id,
          refreshToken: data.refresh_token,
        },
      });
    }
    throw error;
  }
  const actionUrl = new URL(`${origin}/`);
  actionUrl.searchParams.set(BROWSER_ACTION_QUERY_PARAM, code.code);
  return {
    id: code.code,
    url: actionUrl.toString(),
    expiresAtMillis,
    refreshTokenId,
  };
}

export async function consumeBrowserAction(options: {
  tenancy: Tenancy,
  code: string,
  requestOrigin: string | undefined,
}): Promise<{ javascript: string }> {
  if (options.requestOrigin == null) {
    throw new StatusError(StatusError.Forbidden, "Browser action origin is not allowed");
  }
  let requestOrigin: string;
  try {
    requestOrigin = normalizeTrustedOrigin(options.requestOrigin);
  } catch {
    throw new StatusError(StatusError.Forbidden, "Browser action origin is not allowed");
  }
  const action = await globalPrismaClient.verificationCode.findUnique({
    where: {
      projectId_branchId_code: {
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        code: options.code,
      },
      type: VerificationCodeType.BROWSER_ACTION,
    },
  });
  if (action == null || action.expiresAt <= new Date()) {
    throw new StatusError(StatusError.Forbidden, "Browser action is invalid or expired");
  }

  let data: BrowserActionData;
  try {
    data = await browserActionDataSchema.validate(action.data, { strict: true });
  } catch (error) {
    throw new HexclaveAssertionError("Stored browser action data does not match its action type", { cause: error });
  }
  if (data.origin !== requestOrigin) {
    throw new StatusError(StatusError.Forbidden, "Browser action origin is not allowed");
  }
  // Origin matching is defense in depth; it is not an authentication boundary.
  if (data.type === "impersonation") {
    const javascript = generateImpersonateSnippet(
      options.tenancy.project.id,
      data.refresh_token,
      new Date(data.expires_at_millis),
    );
    await claimVerificationCode({
      projectId: options.tenancy.project.id,
      branchId: options.tenancy.branchId,
      type: VerificationCodeType.BROWSER_ACTION,
      code: options.code,
    });
    return {
      javascript,
    };
  }

  // Mint before claiming so a signing failure does not irreversibly consume the action.
  const clickmapToken = await createAnalyticsClickmapToken({
    tenancy: options.tenancy,
    origin: data.origin,
  });
  await claimVerificationCode({
    projectId: options.tenancy.project.id,
    branchId: options.tenancy.branchId,
    type: VerificationCodeType.BROWSER_ACTION,
    code: options.code,
  });
  return {
    javascript: createClickmapOverlaySnippet(clickmapToken.token),
  };
}

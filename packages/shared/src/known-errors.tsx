import { HexclaveAssertionError, StatusError, throwErr } from "./utils/errors";
import { identityArgs } from "./utils/functions";
import { Json } from "./utils/json";
import { deindent } from "./utils/strings";

export type KnownErrorJson = {
  code: string,
  message: string,
  details?: Json,
};

export type AbstractKnownErrorConstructor<Args extends any[]> =
  & (abstract new (...args: Args) => KnownError)
  & {
    constructorArgsFromJson: (json: KnownErrorJson) => Args,
  };

export type KnownErrorConstructor<SuperInstance extends KnownError, Args extends any[]> = {
  new(...args: Args): SuperInstance & { constructorArgs: Args },
  errorCode: string,
  constructorArgsFromJson: (json: KnownErrorJson) => Args,
  isInstance: (error: unknown) => error is SuperInstance & { constructorArgs: Args },
};

export abstract class KnownError extends StatusError {
  private readonly __stackKnownErrorBrand = "stack-known-error-brand-sentinel" as const;
  public name = "KnownError";

  constructor(
    public readonly statusCode: number,
    public readonly humanReadableMessage: string,
    public readonly details?: Json,
  ) {
    super(
      statusCode,
      humanReadableMessage
    );
  }

  public static isKnownError(error: unknown): error is KnownError {
    // like instanceof, but also works for errors thrown in other realms or by different versions of the same package
    return typeof error === "object" && error !== null && "__stackKnownErrorBrand" in error && error.__stackKnownErrorBrand === "stack-known-error-brand-sentinel";
  }

  public override getBody(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(this.toDescriptiveJson(), undefined, 2));
  }

  public override getHeaders(): Record<string, string[]> {
    return {
      "Content-Type": ["application/json; charset=utf-8"],
      // Hexclave rebrand: dual-emit both X-Hexclave-* and X-Stack-* so old and new SDKs can both read it.
      "X-Stack-Known-Error": [this.errorCode],
      "X-Hexclave-Known-Error": [this.errorCode],
    };
  }

  public override toDescriptiveJson(): Json {
    return {
      code: this.errorCode,
      ...this.details ? { details: this.details } : {},
      error: this.humanReadableMessage,
    };
  }

  get errorCode(): string {
    return (this.constructor as any).errorCode ?? throwErr(`Can't find error code for this KnownError. Is its constructor a KnownErrorConstructor? ${this}`);
  }

  public static constructorArgsFromJson(json: KnownErrorJson): ConstructorParameters<typeof KnownError> {
    return [
      400,
      json.message,
      json,
    ];
  }

  public static fromJson(json: KnownErrorJson): KnownError {
    for (const [_, KnownErrorType] of Object.entries(KnownErrors)) {
      if (json.code === KnownErrorType.prototype.errorCode) {
        const constructorArgs = KnownErrorType.constructorArgsFromJson(json);
        return new KnownErrorType(
          // @ts-ignore-next-line
          ...constructorArgs,
        );
      }
    }

    throw new Error(`An error occurred. Please update your version of the Hexclave SDK. ${json.code}: ${json.message}`);
  }
}

const knownErrorConstructorErrorCodeSentinel = Symbol("knownErrorConstructorErrorCodeSentinel");
/**
 * Exists solely so that known errors are nominative types (ie. two KnownErrors with the same interface are not the same type)
 */
type KnownErrorBrand<ErrorCode extends string> = {
  /**
   * Does not exist at runtime
   *
   * Must be an object because it may be true for multiple error codes (it's true for all parents)
   */
  [knownErrorConstructorErrorCodeSentinel]: {
    [K in ErrorCode]: true
  },
};

function createKnownErrorConstructor<ErrorCode extends string, Super extends AbstractKnownErrorConstructor<any>, Args extends any[]>(
  SuperClass: Super,
  errorCode: ErrorCode,
  create: ((...args: Args) => Readonly<ConstructorParameters<Super>>),
  constructorArgsFromJson: ((jsonDetails: any) => NoInfer<Args>),
): KnownErrorConstructor<InstanceType<Super> & KnownErrorBrand<ErrorCode>, Args> & { errorCode: ErrorCode };
function createKnownErrorConstructor<ErrorCode extends string, Super extends AbstractKnownErrorConstructor<any>>(
  SuperClass: Super,
  errorCode: ErrorCode,
  create: "inherit",
  constructorArgsFromJson: "inherit",
): KnownErrorConstructor<InstanceType<Super> & KnownErrorBrand<ErrorCode>, ConstructorParameters<Super>> & { errorCode: ErrorCode };
function createKnownErrorConstructor<ErrorCode extends string, Super extends AbstractKnownErrorConstructor<any>, Args extends any[]>(
  SuperClass: Super,
  errorCode: ErrorCode,
  create: "inherit" | ((...args: Args) => Readonly<ConstructorParameters<Super>>),
  constructorArgsFromJson: "inherit" | ((jsonDetails: any) => NoInfer<Args>),
): KnownErrorConstructor<InstanceType<Super> & KnownErrorBrand<ErrorCode>, Args> & { errorCode: ErrorCode } {
  const createFn = create === "inherit" ? identityArgs<Args> as never : create;
  const constructorArgsFromJsonFn = constructorArgsFromJson === "inherit" ? SuperClass.constructorArgsFromJson as never : constructorArgsFromJson;

  // @ts-expect-error this is not a mixin, but TS detects it as one
  class KnownErrorImpl extends SuperClass {
    public static readonly errorCode = errorCode;
    public name = `KnownError<${errorCode}>`;
    public readonly constructorArgs: Args;

    constructor(...args: Args) {
      // @ts-ignore legendary comment, may never be removed https://x.com/konstiwohlwend/status/1998543556567617780
      super(...createFn(...args));
      this.constructorArgs = args;
    }

    static constructorArgsFromJson(json: KnownErrorJson): Args {
      return constructorArgsFromJsonFn(json.details);
    }

    static isInstance(error: unknown): error is InstanceType<Super> & { constructorArgs: Args } {
      if (!KnownError.isKnownError(error)) return false;
      let current: unknown = error;
      while (true) {
        current = Object.getPrototypeOf(current);
        if (!current) break;
        if ("errorCode" in current.constructor && current.constructor.errorCode === errorCode) return true;
      }
      return false;
    }
  };

  // @ts-expect-error
  return KnownErrorImpl;
}
import.meta.vitest?.test("KnownError.isInstance", ({ expect }) => {
  expect(KnownErrors.InvalidProjectAuthentication.isInstance(undefined)).toBe(false);
  expect(KnownErrors.InvalidProjectAuthentication.isInstance(new Error())).toBe(false);

  const error = new KnownErrors.ProjectKeyWithoutAccessType();
  expect(KnownErrors.ProjectKeyWithoutAccessType.isInstance(error)).toBe(true);
  expect(KnownErrors.InvalidProjectAuthentication.isInstance(error)).toBe(true);
  expect(KnownErrors.InvalidAccessType.isInstance(error)).toBe(false);
});

const UnsupportedError = createKnownErrorConstructor(
  KnownError,
  "UNSUPPORTED_ERROR",
  (originalErrorCode: string) => [
    500,
    `An error occurred that is not currently supported (possibly because it was added in a version of Stack that is newer than this client). The original unsupported error code was: ${originalErrorCode}`,
    {
      originalErrorCode,
    },
  ] as const,
  (json) => [
    (json as any)?.originalErrorCode ?? throwErr("originalErrorCode not found in UnsupportedError details"),
  ] as const,
);

const BodyParsingError = createKnownErrorConstructor(
  KnownError,
  "BODY_PARSING_ERROR",
  (message: string) => [
    400,
    message,
  ] as const,
  (json) => [json.message] as const,
);

const SchemaError = createKnownErrorConstructor(
  KnownError,
  "SCHEMA_ERROR",
  (message: string) => [
    400,
    message || throwErr("SchemaError requires a message"),
    {
      message,
    },
  ] as const,
  (json: any) => [json.message] as const,
);

const AllOverloadsFailed = createKnownErrorConstructor(
  KnownError,
  "ALL_OVERLOADS_FAILED",
  (overloadErrors: Json[]) => [
    400,
    deindent`
      This endpoint has multiple overloads, but they all failed to process the request.

        ${overloadErrors.map((e, i) => deindent`
          Overload ${i + 1}: ${JSON.stringify(e, undefined, 2)}
        `).join("\n\n")}
    `,
    {
      overload_errors: overloadErrors,
    },
  ] as const,
  (json) => [
    (json as any)?.overload_errors ?? throwErr("overload_errors not found in AllOverloadsFailed details"),
  ] as const,
);

const ProjectAuthenticationError = createKnownErrorConstructor(
  KnownError,
  "PROJECT_AUTHENTICATION_ERROR",
  "inherit",
  "inherit",
);

const InvalidProjectAuthentication = createKnownErrorConstructor(
  ProjectAuthenticationError,
  "INVALID_PROJECT_AUTHENTICATION",
  "inherit",
  "inherit",
);

const ProjectKeyWithoutAccessType = createKnownErrorConstructor(
  InvalidProjectAuthentication,
  "PROJECT_KEY_WITHOUT_ACCESS_TYPE",
  () => [
    400,
    "Either an API key or an admin access token was provided, but the x-hexclave-access-type header is missing. Set it to 'client', 'server', or 'admin' as appropriate. (The legacy x-stack-access-type header is also accepted.)",
  ] as const,
  () => [] as const,
);

const InvalidAccessType = createKnownErrorConstructor(
  InvalidProjectAuthentication,
  "INVALID_ACCESS_TYPE",
  (accessType: string) => [
    400,
    `The x-hexclave-access-type header must be 'client', 'server', or 'admin', but was '${accessType}'. (The legacy x-stack-access-type header is also accepted.)`,
  ] as const,
  (json) => [
    (json as any)?.accessType ?? throwErr("accessType not found in InvalidAccessType details"),
  ] as const,
);

const AccessTypeWithoutProjectId = createKnownErrorConstructor(
  InvalidProjectAuthentication,
  "ACCESS_TYPE_WITHOUT_PROJECT_ID",
  (accessType: "client" | "server" | "admin") => [
    400,
    deindent`
      The x-hexclave-access-type header was '${accessType}', but the x-hexclave-project-id header was not provided. (The legacy x-stack-access-type and x-stack-project-id headers are also accepted.)
      
      For more information, see the docs on REST API authentication: https://docs.hexclave.com/api/overview#authentication
    `,
    {
      request_type: accessType,
    },
  ] as const,
  (json: any) => [json.request_type] as const,
);

const AccessTypeRequired = createKnownErrorConstructor(
  InvalidProjectAuthentication,
  "ACCESS_TYPE_REQUIRED",
  () => [
    400,
    deindent`
      You must specify an access level for this Hexclave project. Make sure project API keys are provided (eg. x-hexclave-publishable-client-key) and you set the x-hexclave-access-type header to 'client', 'server', or 'admin'. (The legacy x-stack-* equivalents are also accepted.)
      
      For more information, see the docs on REST API authentication: https://docs.hexclave.com/api/overview#authentication
    `,
  ] as const,
  () => [] as const,
);

const InsufficientAccessType = createKnownErrorConstructor(
  InvalidProjectAuthentication,
  "INSUFFICIENT_ACCESS_TYPE",
  (actualAccessType: "client" | "server" | "admin", allowedAccessTypes: ("client" | "server" | "admin")[]) => [
    401,
    `The x-hexclave-access-type header must be ${allowedAccessTypes.map(s => `'${s}'`).join(" or ")}, but was '${actualAccessType}'. (The legacy x-stack-access-type header is also accepted.)`,
    {
      actual_access_type: actualAccessType,
      allowed_access_types: allowedAccessTypes,
    },
  ] as const,
  (json: any) => [
    json.actual_access_type,
    json.allowed_access_types,
  ] as const,
);

const InvalidPublishableClientKey = createKnownErrorConstructor(
  InvalidProjectAuthentication,
  "INVALID_PUBLISHABLE_CLIENT_KEY",
  (projectId: string) => [
    401,
    `The publishable key is not valid for the project ${JSON.stringify(projectId)}. Does the project and/or the key exist?`,
    {
      project_id: projectId,
    },
  ] as const,
  (json: any) => [json.project_id] as const,
);

const InvalidSecretServerKey = createKnownErrorConstructor(
  InvalidProjectAuthentication,
  "INVALID_SECRET_SERVER_KEY",
  (projectId: string) => [
    401,
    `The secret server key is not valid for the project ${JSON.stringify(projectId)}. Does the project and/or the key exist?`,
    {
      project_id: projectId,
    },
  ] as const,
  (json: any) => [json.project_id] as const,
);

const InvalidSuperSecretAdminKey = createKnownErrorConstructor(
  InvalidProjectAuthentication,
  "INVALID_SUPER_SECRET_ADMIN_KEY",
  (projectId: string) => [
    401,
    `The super secret admin key is not valid for the project ${JSON.stringify(projectId)}. Does the project and/or the key exist?`,
    {
      project_id: projectId,
    },
  ] as const,
  (json: any) => [json.project_id] as const,
);

const InvalidAdminAccessToken = createKnownErrorConstructor(
  InvalidProjectAuthentication,
  "INVALID_ADMIN_ACCESS_TOKEN",
  "inherit",
  "inherit",
);

const UnparsableAdminAccessToken = createKnownErrorConstructor(
  InvalidAdminAccessToken,
  "UNPARSABLE_ADMIN_ACCESS_TOKEN",
  () => [
    401,
    "Admin access token is not parsable.",
  ] as const,
  () => [] as const,
);

const AdminAccessTokenExpired = createKnownErrorConstructor(
  InvalidAdminAccessToken,
  "ADMIN_ACCESS_TOKEN_EXPIRED",
  (expiredAt: Date | undefined) => [
    401,
    `Admin access token has expired. Please refresh it and try again.${expiredAt ? ` (The access token expired at ${expiredAt.toISOString()}.)` : ""}`,
    { expired_at_millis: expiredAt?.getTime() ?? null },
  ] as const,
  (json: any) => [json.expired_at_millis ? new Date(json.expired_at_millis) : undefined] as const,
);

const InvalidProjectForAdminAccessToken = createKnownErrorConstructor(
  InvalidAdminAccessToken,
  "INVALID_PROJECT_FOR_ADMIN_ACCESS_TOKEN",
  () => [
    401,
    "Admin access tokens must be created on the internal project.",
  ] as const,
  () => [] as const,
);

const AdminAccessTokenIsNotAdmin = createKnownErrorConstructor(
  InvalidAdminAccessToken,
  "ADMIN_ACCESS_TOKEN_IS_NOT_ADMIN",
  () => [
    401,
    "Admin access token does not have the required permissions to access this project.",
  ] as const,
  () => [] as const,
);

/**
 * @deprecated Use InsufficientAccessType instead
 */
const ProjectAuthenticationRequired = createKnownErrorConstructor(
  ProjectAuthenticationError,
  "PROJECT_AUTHENTICATION_REQUIRED",
  "inherit",
  "inherit",
);


/**
 * @deprecated Use InsufficientAccessType instead
 */
const ClientAuthenticationRequired = createKnownErrorConstructor(
  ProjectAuthenticationRequired,
  "CLIENT_AUTHENTICATION_REQUIRED",
  () => [
    401,
    "The publishable client key must be provided.",
  ] as const,
  () => [] as const,
);

const PublishableClientKeyRequiredForProject = createKnownErrorConstructor(
  ProjectAuthenticationRequired,
  "PUBLISHABLE_CLIENT_KEY_REQUIRED_FOR_PROJECT",
  (projectId?: string) => [
    401,
    "Publishable client keys are required for this project. Create one in Project Keys, or disable this requirement there to allow keyless client access.",
    {
      project_id: projectId ?? null,
    },
  ] as const,
  (json: any) => [json.project_id ?? undefined] as const,
);

/**
 * @deprecated Use InsufficientAccessType instead
 */
const ServerAuthenticationRequired = createKnownErrorConstructor(
  ProjectAuthenticationRequired,
  "SERVER_AUTHENTICATION_REQUIRED",
  () => [
    401,
    "The secret server key must be provided.",
  ] as const,
  () => [] as const,
);

/**
 * @deprecated Use InsufficientAccessType instead
 */
const ClientOrServerAuthenticationRequired = createKnownErrorConstructor(
  ProjectAuthenticationRequired,
  "CLIENT_OR_SERVER_AUTHENTICATION_REQUIRED",
  () => [
    401,
    "Either the publishable client key or the secret server key must be provided.",
  ] as const,
  () => [] as const,
);

/**
 * @deprecated Use InsufficientAccessType instead
 */
const ClientOrAdminAuthenticationRequired = createKnownErrorConstructor(
  ProjectAuthenticationRequired,
  "CLIENT_OR_ADMIN_AUTHENTICATION_REQUIRED",
  () => [
    401,
    "Either the publishable client key or the super secret admin key must be provided.",
  ] as const,
  () => [] as const,
);

/**
 * @deprecated Use InsufficientAccessType instead
 */
const ClientOrServerOrAdminAuthenticationRequired = createKnownErrorConstructor(
  ProjectAuthenticationRequired,
  "CLIENT_OR_SERVER_OR_ADMIN_AUTHENTICATION_REQUIRED",
  () => [
    401,
    "Either the publishable client key, the secret server key, or the super secret admin key must be provided.",
  ] as const,
  () => [] as const,
);

/**
 * @deprecated Use InsufficientAccessType instead
 */
const AdminAuthenticationRequired = createKnownErrorConstructor(
  ProjectAuthenticationRequired,
  "ADMIN_AUTHENTICATION_REQUIRED",
  () => [
    401,
    "The super secret admin key must be provided.",
  ] as const,
  () => [] as const,
);

const ExpectedInternalProject = createKnownErrorConstructor(
  ProjectAuthenticationError,
  "EXPECTED_INTERNAL_PROJECT",
  () => [
    401,
    "The project ID is expected to be internal.",
  ] as const,
  () => [] as const,
);

const SessionAuthenticationError = createKnownErrorConstructor(
  KnownError,
  "SESSION_AUTHENTICATION_ERROR",
  "inherit",
  "inherit",
);

const InvalidSessionAuthentication = createKnownErrorConstructor(
  SessionAuthenticationError,
  "INVALID_SESSION_AUTHENTICATION",
  "inherit",
  "inherit",
);

const InvalidAccessToken = createKnownErrorConstructor(
  InvalidSessionAuthentication,
  "INVALID_ACCESS_TOKEN",
  "inherit",
  "inherit",
);

const UnparsableAccessToken = createKnownErrorConstructor(
  InvalidAccessToken,
  "UNPARSABLE_ACCESS_TOKEN",
  () => [
    401,
    "Access token is not parsable.",
  ] as const,
  () => [] as const,
);

const AccessTokenExpired = createKnownErrorConstructor(
  InvalidAccessToken,
  "ACCESS_TOKEN_EXPIRED",
  (expiredAt: Date | undefined, projectId: string | undefined, userId: string | undefined, refreshTokenId: string | undefined) => [
    401,
    deindent`
      Access token has expired. Please refresh it and try again.${expiredAt ? ` (The access token expired at ${expiredAt.toISOString()}.)` : ""}${projectId ? ` Project ID: ${projectId}.` : ""}${userId ? ` User ID: ${userId}.` : ""}${refreshTokenId ? ` Refresh token ID: ${refreshTokenId}.` : ""}

      Debug info: Most likely, you fetched the access token before it expired (for example, in a server component, pre-rendered page, or on page load), but then didn't refresh it before it expired. If this is the case, and you're using the SDK, make sure you call getAccessToken() every time you need to use the access token. If you're not using the SDK, make sure you refresh the access token with the refresh endpoint.
    `,
    {
      expired_at_millis: expiredAt?.getTime() ?? null,
      project_id: projectId ?? null,
      user_id: userId ?? null,
      refresh_token_id: refreshTokenId ?? null,
    },
  ] as const,
  (json: any) => [
    json.expired_at_millis ? new Date(json.expired_at_millis) : undefined,
    json.project_id ?? undefined,
    json.user_id ?? undefined,
    json.refresh_token_id ?? undefined,
  ] as const,
);

const InvalidProjectForAccessToken = createKnownErrorConstructor(
  InvalidAccessToken,
  "INVALID_PROJECT_FOR_ACCESS_TOKEN",
  (expectedProjectId: string, actualProjectId: string) => [
    401,
    `Access token not valid for this project. Expected project ID ${JSON.stringify(expectedProjectId)}, but the token is for project ID ${JSON.stringify(actualProjectId)}.`,
    {
      expected_project_id: expectedProjectId,
      actual_project_id: actualProjectId,
    },
  ] as const,
  (json: any) => [json.expected_project_id, json.actual_project_id] as const,
);


const RefreshTokenError = createKnownErrorConstructor(
  KnownError,
  "REFRESH_TOKEN_ERROR",
  "inherit",
  "inherit",
);

const RefreshTokenNotFoundOrExpired = createKnownErrorConstructor(
  RefreshTokenError,
  "REFRESH_TOKEN_NOT_FOUND_OR_EXPIRED",
  () => [
    401,
    "Refresh token not found for this project, or the session has expired/been revoked.",
  ] as const,
  () => [] as const,
);

const CannotDeleteCurrentSession = createKnownErrorConstructor(
  RefreshTokenError,
  "CANNOT_DELETE_CURRENT_SESSION",
  () => [
    400,
    "Cannot delete the current session.",
  ] as const,
  () => [] as const,
);


const ProviderRejected = createKnownErrorConstructor(
  RefreshTokenError,
  "PROVIDER_REJECTED",
  () => [
    401,
    "The provider refused to refresh their token. This usually means that the provider used to authenticate the user no longer regards this session as valid, and the user must re-authenticate.",
  ] as const,
  () => [] as const,
);

const UserWithEmailAlreadyExists = createKnownErrorConstructor(
  KnownError,
  "USER_EMAIL_ALREADY_EXISTS",
  (email: string, wouldWorkIfEmailWasVerified: boolean = false) => [
    409,
    `A user with email ${JSON.stringify(email)} already exists${wouldWorkIfEmailWasVerified ? " but the email is not verified. Please login to your existing account with the method you used to sign up, and then verify your email to sign in with this login method." : "."}`,
    {
      email,
      would_work_if_email_was_verified: wouldWorkIfEmailWasVerified,
    },
  ] as const,
  (json: any) => [json.email, json.would_work_if_email_was_verified ?? false] as const,
);

const EmailNotVerified = createKnownErrorConstructor(
  KnownError,
  "EMAIL_NOT_VERIFIED",
  () => [
    400,
    "The email is not verified.",
  ] as const,
  () => [] as const,
);

const CannotGetOwnUserWithoutUser = createKnownErrorConstructor(
  KnownError,
  "CANNOT_GET_OWN_USER_WITHOUT_USER",
  () => [
    400,
    "You have specified 'me' as a userId, but did not provide authentication for a user.",
  ] as const,
  () => [] as const,
);

const UserIdDoesNotExist = createKnownErrorConstructor(
  KnownError,
  "USER_ID_DOES_NOT_EXIST",
  (userId: string) => [
    400,
    `The given user with the ID ${userId} does not exist.`,
    {
      user_id: userId,
    },
  ] as const,
  (json: any) => [json.user_id] as const,
);

const UserNotFound = createKnownErrorConstructor(
  KnownError,
  "USER_NOT_FOUND",
  () => [
    404,
    "User not found.",
  ] as const,
  () => [] as const,
);

const RestrictedUserNotAllowed = createKnownErrorConstructor(
  KnownError,
  "RESTRICTED_USER_NOT_ALLOWED",
  (restrictedReason: { type: "anonymous" | "email_not_verified" | "restricted_by_administrator" }) => [
    403,
    `The user in the access token is in restricted state. Reason: ${restrictedReason.type}. Please pass the X-Stack-Allow-Restricted-User header if this is intended.`,
    {
      restricted_reason: restrictedReason,
    },
  ] as const,
  (json: any) => [json.restricted_reason ?? { type: "anonymous" }] as const,
);

const ProjectNotFound = createKnownErrorConstructor(
  KnownError,
  "PROJECT_NOT_FOUND",
  (projectId: string) => {
    if (typeof projectId !== "string") throw new HexclaveAssertionError("projectId of KnownErrors.ProjectNotFound must be a string");
    return [
      404,
      `Project ${projectId} not found or is not accessible with the current user.`,
      {
        project_id: projectId,
      },
    ] as const;
  },
  (json: any) => [json.project_id] as const,
);

const CurrentProjectNotFound = createKnownErrorConstructor(
  KnownError,
  "CURRENT_PROJECT_NOT_FOUND",
  (projectId: string) => [
    400,
    `The current project with ID ${projectId} was not found. Please check the value of the x-hexclave-project-id header. (The legacy x-stack-project-id header is also accepted.)`,
    {
      project_id: projectId,
    },
  ] as const,
  (json: any) => [json.project_id] as const,
);

const BranchDoesNotExist = createKnownErrorConstructor(
  KnownError,
  "BRANCH_DOES_NOT_EXIST",
  (branchId: string) => [
    400,
    `The branch with ID ${branchId} does not exist.`,
    {
      branch_id: branchId,
    },
  ] as const,
  (json: any) => [json.branch_id] as const,
);


const SignUpNotEnabled = createKnownErrorConstructor(
  KnownError,
  "SIGN_UP_NOT_ENABLED",
  () => [
    400,
    "Creation of new accounts is not enabled for this project. Please ask the project owner to enable it.",
  ] as const,
  () => [] as const,
);

const SignUpRejected = createKnownErrorConstructor(
  KnownError,
  "SIGN_UP_REJECTED",
  (message?: string) => [
    403,
    message ?? "Your sign up was rejected by an administrator's sign-up rule.",
    {
      message: message ?? "Your sign up was rejected by an administrator's sign-up rule.",
    },
  ] as const,
  (json: any) => [json.message] as const,
);

const BotChallengeRequired = createKnownErrorConstructor(
  KnownError,
  "BOT_CHALLENGE_REQUIRED",
  () => [
    409,
    "An additional bot challenge is required before sign-up can continue.",
  ] as const,
  () => [] as const,
);

const BotChallengeFailed = createKnownErrorConstructor(
  KnownError,
  "BOT_CHALLENGE_FAILED",
  (message: string) => [
    400,
    message,
    {
      message,
    },
  ] as const,
  (json: any) => [json.message] as const,
);

const PasswordAuthenticationNotEnabled = createKnownErrorConstructor(
  KnownError,
  "PASSWORD_AUTHENTICATION_NOT_ENABLED",
  () => [
    400,
    "Password authentication is not enabled for this project.",
  ] as const,
  () => [] as const,
);

const DataVaultStoreDoesNotExist = createKnownErrorConstructor(
  KnownError,
  "DATA_VAULT_STORE_DOES_NOT_EXIST",
  (storeId: string) => [
    400,
    `Data vault store with ID ${storeId} does not exist.`,
    {
      store_id: storeId,
    },
  ] as const,
  (json: any) => [json.store_id] as const,
);

const DataVaultStoreHashedKeyDoesNotExist = createKnownErrorConstructor(
  KnownError,
  "DATA_VAULT_STORE_HASHED_KEY_DOES_NOT_EXIST",
  (storeId: string, hashedKey: string) => [
    400,
    `Data vault store with ID ${storeId} does not contain a key with hash ${hashedKey}.`,
    {
      store_id: storeId,
      hashed_key: hashedKey,
    },
  ] as const,
  (json: any) => [json.store_id, json.hashed_key] as const,
);

const PasskeyAuthenticationNotEnabled = createKnownErrorConstructor(
  KnownError,
  "PASSKEY_AUTHENTICATION_NOT_ENABLED",
  () => [
    400,
    "Passkey authentication is not enabled for this project.",
  ] as const,
  () => [] as const,
);

const AnonymousAccountsNotEnabled = createKnownErrorConstructor(
  KnownError,
  "ANONYMOUS_ACCOUNTS_NOT_ENABLED",
  () => [
    400,
    "Anonymous accounts are not enabled for this project.",
  ] as const,
  () => [] as const,
);

const AnonymousAuthenticationNotAllowed = createKnownErrorConstructor(
  KnownError,
  "ANONYMOUS_AUTHENTICATION_NOT_ALLOWED",
  () => [
    401,
    "X-Stack-Access-Token is for an anonymous user, but anonymous users are not enabled. Set the X-Stack-Allow-Anonymous-User header of this request to 'true' to allow anonymous users.",
  ] as const,
  () => [] as const,
);


const EmailPasswordMismatch = createKnownErrorConstructor(
  KnownError,
  "EMAIL_PASSWORD_MISMATCH",
  () => [
    400,
    "Wrong e-mail or password.",
  ] as const,
  () => [] as const,
);

const RedirectUrlNotWhitelisted = createKnownErrorConstructor(
  KnownError,
  "REDIRECT_URL_NOT_WHITELISTED",
  (redirectUrl?: string) => [
    400,
    "Redirect URL not whitelisted. Did you forget to add this domain to the trusted domains list on the Hexclave dashboard?",
    redirectUrl === undefined ? undefined : {
      redirect_url: redirectUrl,
    },
  ] as const,
  (json) => [(json as any)?.redirect_url] as const,
);

const PasswordRequirementsNotMet = createKnownErrorConstructor(
  KnownError,
  "PASSWORD_REQUIREMENTS_NOT_MET",
  "inherit",
  "inherit",
);

const PasswordTooShort = createKnownErrorConstructor(
  PasswordRequirementsNotMet,
  "PASSWORD_TOO_SHORT",
  (minLength: number) => [
    400,
    `Password too short. Minimum length is ${minLength}.`,
    {
      min_length: minLength,
    },
  ] as const,
  (json) => [
    (json as any)?.min_length ?? throwErr("min_length not found in PasswordTooShort details"),
  ] as const,
);

const PasswordTooLong = createKnownErrorConstructor(
  PasswordRequirementsNotMet,
  "PASSWORD_TOO_LONG",
  (maxLength: number) => [
    400,
    `Password too long. Maximum length is ${maxLength}.`,
    {
      maxLength,
    },
  ] as const,
  (json) => [
    (json as any)?.maxLength ?? throwErr("maxLength not found in PasswordTooLong details"),
  ] as const,
);

const UserDoesNotHavePassword = createKnownErrorConstructor(
  KnownError,
  "USER_DOES_NOT_HAVE_PASSWORD",
  () => [
    400,
    "This user does not have password authentication enabled.",
  ] as const,
  () => [] as const,
);

const VerificationCodeError = createKnownErrorConstructor(
  KnownError,
  "VERIFICATION_ERROR",
  "inherit",
  "inherit",
);

const VerificationCodeNotFound = createKnownErrorConstructor(
  VerificationCodeError,
  "VERIFICATION_CODE_NOT_FOUND",
  () => [
    404,
    "The verification code does not exist for this project.",
  ] as const,
  () => [] as const,
);

const VerificationCodeExpired = createKnownErrorConstructor(
  VerificationCodeError,
  "VERIFICATION_CODE_EXPIRED",
  () => [
    400,
    "The verification code has expired.",
  ] as const,
  () => [] as const,
);

const VerificationCodeAlreadyUsed = createKnownErrorConstructor(
  VerificationCodeError,
  "VERIFICATION_CODE_ALREADY_USED",
  () => [
    409,
    "The verification link has already been used.",
  ] as const,
  () => [] as const,
);

const VerificationCodeMaxAttemptsReached = createKnownErrorConstructor(
  VerificationCodeError,
  "VERIFICATION_CODE_MAX_ATTEMPTS_REACHED",
  () => [
    400,
    "The verification code nonce has reached the maximum number of attempts. This code is not valid anymore.",
  ] as const,
  () => [] as const,
);

const PasswordConfirmationMismatch = createKnownErrorConstructor(
  KnownError,
  "PASSWORD_CONFIRMATION_MISMATCH",
  () => [
    400,
    "Passwords do not match.",
  ] as const,
  () => [] as const,
);

const EmailAlreadyVerified = createKnownErrorConstructor(
  KnownError,
  "EMAIL_ALREADY_VERIFIED",
  () => [
    409,
    "The e-mail is already verified.",
  ] as const,
  () => [] as const,
);

const EmailNotAssociatedWithUser = createKnownErrorConstructor(
  KnownError,
  "EMAIL_NOT_ASSOCIATED_WITH_USER",
  () => [
    400,
    "The e-mail is not associated with a user that could log in with that e-mail.",
  ] as const,
  () => [] as const,
);

const EmailIsNotPrimaryEmail = createKnownErrorConstructor(
  KnownError,
  "EMAIL_IS_NOT_PRIMARY_EMAIL",
  (email: string, primaryEmail: string | null) => [
    400,
    `The given e-mail (${email}) must equal the user's primary e-mail (${primaryEmail}).`,
    {
      email,
      primary_email: primaryEmail,
    },
  ] as const,
  (json: any) => [json.email, json.primary_email] as const,
);


const PasskeyRegistrationFailed = createKnownErrorConstructor(
  KnownError,
  "PASSKEY_REGISTRATION_FAILED",
  (message: string) => [
    400,
    message,
  ] as const,
  (json: any) => [json.message] as const,
);


const PasskeyWebAuthnError = createKnownErrorConstructor(
  KnownError,
  "PASSKEY_WEBAUTHN_ERROR",
  (message: string, code: string) => [
    400,
    message,
    {
      message,
      code,
    },
  ] as const,
  (json: any) => [json.message, json.code] as const,
);

const PasskeyAuthenticationFailed = createKnownErrorConstructor(
  KnownError,
  "PASSKEY_AUTHENTICATION_FAILED",
  (message: string) => [
    400,
    message,
  ] as const,
  (json: any) => [json.message] as const,
);


const PermissionNotFound = createKnownErrorConstructor(
  KnownError,
  "PERMISSION_NOT_FOUND",
  (permissionId: string) => [
    404,
    `Permission "${permissionId}" not found. Make sure you created it on the dashboard.`,
    {
      permission_id: permissionId,
    },
  ] as const,
  (json: any) => [json.permission_id] as const,
);

const PermissionScopeMismatch = createKnownErrorConstructor(
  KnownError,
  "WRONG_PERMISSION_SCOPE",
  (permissionId: string, expectedScope: "team" | "project", actualScope: "team" | "project" | null) => [
    404,
    `Permission ${JSON.stringify(permissionId)} not found. (It was found for a different scope ${JSON.stringify(actualScope)}, but scope ${JSON.stringify(expectedScope)} was expected.)`,
    {
      permission_id: permissionId,
      expected_scope: expectedScope,
      actual_scope: actualScope,
    },
  ] as const,
  (json: any) => [json.permission_id, json.expected_scope, json.actual_scope] as const,
);

const ContainedPermissionNotFound = createKnownErrorConstructor(
  KnownError,
  "CONTAINED_PERMISSION_NOT_FOUND",
  (permissionId: string) => [
    400,
    `Contained permission with ID "${permissionId}" not found. Make sure you created it on the dashboard.`,
    {
      permission_id: permissionId,
    },
  ] as const,
  (json: any) => [json.permission_id] as const,
);

const TeamNotFound = createKnownErrorConstructor(
  KnownError,
  "TEAM_NOT_FOUND",
  (teamId: string) => [
    404,
    `Team ${teamId} not found.`,
    {
      team_id: teamId,
    },
  ] as const,
  (json: any) => [json.team_id] as const,
);

const TeamAlreadyExists = createKnownErrorConstructor(
  KnownError,
  "TEAM_ALREADY_EXISTS",
  (teamId: string) => [
    409,
    `Team ${teamId} already exists.`,
    {
      team_id: teamId,
    },
  ] as const,
  (json: any) => [json.team_id] as const,
);

const TeamMembershipNotFound = createKnownErrorConstructor(
  KnownError,
  "TEAM_MEMBERSHIP_NOT_FOUND",
  (teamId: string, userId: string) => [
    404,
    `User ${userId} is not found in team ${teamId}.`,
    {
      team_id: teamId,
      user_id: userId,
    },
  ] as const,
  (json: any) => [json.team_id, json.user_id] as const,
);

const TeamInvitationRestrictedUserNotAllowed = createKnownErrorConstructor(
  KnownError,
  "TEAM_INVITATION_RESTRICTED_USER_NOT_ALLOWED",
  (restrictedReason: { type: "anonymous" | "email_not_verified" | "restricted_by_administrator" }) => [
    403,
    `Restricted users cannot accept team invitations. Reason: ${restrictedReason.type}. Please complete the onboarding process before accepting team invitations.`,
    {
      restricted_reason: restrictedReason,
    },
  ] as const,
  (json: any) => [json.restricted_reason ?? { type: "anonymous" }] as const,
);

const TeamInvitationEmailMismatch = createKnownErrorConstructor(
  KnownError,
  "TEAM_INVITATION_EMAIL_MISMATCH",
  () => [
    403,
    "This team invitation was sent to a different email address. Sign in with the invited email, or add and verify that email on your account, then try again.",
  ] as const,
  () => [] as const,
);


const EmailTemplateAlreadyExists = createKnownErrorConstructor(
  KnownError,
  "EMAIL_TEMPLATE_ALREADY_EXISTS",
  () => [
    409,
    "Email template already exists.",
  ] as const,
  () => [] as const,
);

const OAuthConnectionNotConnectedToUser = createKnownErrorConstructor(
  KnownError,
  "OAUTH_CONNECTION_NOT_CONNECTED_TO_USER",
  () => [
    400,
    "The OAuth connection is not connected to any user.",
  ] as const,
  () => [] as const,
);

const OAuthConnectionAlreadyConnectedToAnotherUser = createKnownErrorConstructor(
  KnownError,
  "OAUTH_CONNECTION_ALREADY_CONNECTED_TO_ANOTHER_USER",
  () => [
    409,
    "The OAuth connection is already connected to another user.",
  ] as const,
  () => [] as const,
);

const OAuthConnectionDoesNotHaveRequiredScope = createKnownErrorConstructor(
  KnownError,
  "OAUTH_CONNECTION_DOES_NOT_HAVE_REQUIRED_SCOPE",
  () => [
    400,
    "The OAuth connection does not have the required scope.",
  ] as const,
  () => [] as const,
);

const OAuthAccessTokenNotAvailable = createKnownErrorConstructor(
  KnownError,
  "OAUTH_ACCESS_TOKEN_NOT_AVAILABLE",
  (provider: string, details: string) => [
    400,
    `Failed to retrieve an OAuth access token for the connected account (provider: ${provider}). ${details}`,
    {
      provider,
      details,
    } as const,
  ] as const,
  (json: any) => [json.provider, json.details] as const,
);

const OAuthExtraScopeNotAvailableWithSharedOAuthKeys = createKnownErrorConstructor(
  KnownError,
  "OAUTH_EXTRA_SCOPE_NOT_AVAILABLE_WITH_SHARED_OAUTH_KEYS",
  () => [
    400,
    "Extra scopes are not available with shared OAuth keys. Please add your own OAuth keys on the Hexclave dashboard to use extra scopes.",
  ] as const,
  () => [] as const,
);

const OAuthAccessTokenNotAvailableWithSharedOAuthKeys = createKnownErrorConstructor(
  KnownError,
  "OAUTH_ACCESS_TOKEN_NOT_AVAILABLE_WITH_SHARED_OAUTH_KEYS",
  () => [
    400,
    "Access tokens are not available with shared OAuth keys. Please add your own OAuth keys on the Hexclave dashboard to use access tokens.",
  ] as const,
  () => [] as const,
);

const InvalidOAuthClientIdOrSecret = createKnownErrorConstructor(
  KnownError,
  "INVALID_OAUTH_CLIENT_ID_OR_SECRET",
  (clientId?: string) => [
    400,
    "The OAuth client ID or secret is invalid. The client ID must be equal to the project ID (potentially with a hash and a branch ID), and the client secret must be a publishable client key.",
    {
      client_id: clientId ?? null,
    },
  ] as const,
  (json: any) => [json.client_id ?? undefined] as const,
);

const InvalidScope = createKnownErrorConstructor(
  KnownError,
  "INVALID_SCOPE",
  (scope: string) => [
    400,
    `The scope "${scope}" is not a valid OAuth scope for Stack.`,
  ] as const,
  (json: any) => [json.scope] as const,
);

const UserAlreadyConnectedToAnotherOAuthConnection = createKnownErrorConstructor(
  KnownError,
  "USER_ALREADY_CONNECTED_TO_ANOTHER_OAUTH_CONNECTION",
  () => [
    409,
    "The user is already connected to another OAuth account. Did you maybe selected the wrong account?",
  ] as const,
  () => [] as const,
);

const OuterOAuthTimeout = createKnownErrorConstructor(
  KnownError,
  "OUTER_OAUTH_TIMEOUT",
  () => [
    408,
    "The OAuth flow has timed out. Please sign in again.",
  ] as const,
  () => [] as const,
);

const OAuthProviderNotFoundOrNotEnabled = createKnownErrorConstructor(
  KnownError,
  "OAUTH_PROVIDER_NOT_FOUND_OR_NOT_ENABLED",
  () => [
    400,
    "The OAuth provider is not found or not enabled.",
  ] as const,
  () => [] as const,
);

const AppleBundleIdNotConfigured = createKnownErrorConstructor(
  KnownError,
  "APPLE_BUNDLE_ID_NOT_CONFIGURED",
  () => [
    400,
    "Apple Sign In is enabled, but no Bundle IDs are configured. Please add your app's Bundle ID in the Hexclave dashboard under OAuth Providers > Apple > Apple Bundle IDs.",
  ] as const,
  () => [] as const,
);

const OAuthProviderAccountIdAlreadyUsedForSignIn = createKnownErrorConstructor(
  KnownError,
  "OAUTH_PROVIDER_ACCOUNT_ID_ALREADY_USED_FOR_SIGN_IN",
  () => [
    400,
    `A provider with the same account ID is already used for signing in.`,
  ] as const,
  () => [] as const,
);

const MultiFactorAuthenticationRequired = createKnownErrorConstructor(
  KnownError,
  "MULTI_FACTOR_AUTHENTICATION_REQUIRED",
  (attemptCode: string) => [
    400,
    `Multi-factor authentication is required for this user.`,
    {
      attempt_code: attemptCode,
    },
  ] as const,
  (json) => [json.attempt_code] as const,
);

const InvalidTotpCode = createKnownErrorConstructor(
  KnownError,
  "INVALID_TOTP_CODE",
  () => [
    400,
    "The TOTP code is invalid. Please try again.",
  ] as const,
  () => [] as const,
);

const UserAuthenticationRequired = createKnownErrorConstructor(
  KnownError,
  "USER_AUTHENTICATION_REQUIRED",
  () => [
    401,
    "User authentication required for this endpoint.",
  ] as const,
  () => [] as const,
);

const TeamMembershipAlreadyExists = createKnownErrorConstructor(
  KnownError,
  "TEAM_MEMBERSHIP_ALREADY_EXISTS",
  () => [
    409,
    "Team membership already exists.",
  ] as const,
  () => [] as const,
);

const ProjectPermissionRequired = createKnownErrorConstructor(
  KnownError,
  "PROJECT_PERMISSION_REQUIRED",
  (userId, permissionId) => [
    401,
    `User ${userId} does not have permission ${permissionId}.`,
    {
      user_id: userId,
      permission_id: permissionId,
    },
  ] as const,
  (json) => [json.user_id, json.permission_id] as const,
);

const TeamPermissionRequired = createKnownErrorConstructor(
  KnownError,
  "TEAM_PERMISSION_REQUIRED",
  (teamId, userId, permissionId) => [
    401,
    `User ${userId} does not have permission ${permissionId} in team ${teamId}.`,
    {
      team_id: teamId,
      user_id: userId,
      permission_id: permissionId,
    },
  ] as const,
  (json) => [json.team_id, json.user_id, json.permission_id] as const,
);

const TeamPermissionNotFound = createKnownErrorConstructor(
  KnownError,
  "TEAM_PERMISSION_NOT_FOUND",
  (teamId, userId, permissionId) => [
    401,
    `User ${userId} does not have permission ${permissionId} in team ${teamId}.`,
    {
      team_id: teamId,
      user_id: userId,
      permission_id: permissionId,
    },
  ] as const,
  (json) => [json.team_id, json.user_id, json.permission_id] as const,
);

const InvalidSharedOAuthProviderId = createKnownErrorConstructor(
  KnownError,
  "INVALID_SHARED_OAUTH_PROVIDER_ID",
  (providerId) => [
    400,
    `The shared OAuth provider with ID ${providerId} is not valid.`,
    {
      provider_id: providerId,
    },
  ] as const,
  (json) => [json.provider_id] as const,
);

const InvalidStandardOAuthProviderId = createKnownErrorConstructor(
  KnownError,
  "INVALID_STANDARD_OAUTH_PROVIDER_ID",
  (providerId) => [
    400,
    `The standard OAuth provider with ID ${providerId} is not valid.`,
    {
      provider_id: providerId,
    },
  ] as const,
  (json) => [json.provider_id] as const,
);

const InvalidAuthorizationCode = createKnownErrorConstructor(
  KnownError,
  "INVALID_AUTHORIZATION_CODE",
  () => [
    400,
    "The given authorization code is invalid.",
  ] as const,
  () => [] as const,
);

const InvalidAppleCredentials = createKnownErrorConstructor(
  KnownError,
  "INVALID_APPLE_CREDENTIALS",
  () => [
    400,
    "The Apple Sign In credentials could not be verified. Please try signing in again.",
  ] as const,
  () => [] as const,
);

const OAuthProviderAccessDenied = createKnownErrorConstructor(
  KnownError,
  "OAUTH_PROVIDER_ACCESS_DENIED",
  () => [
    400,
    "The OAuth provider denied access to the user.",
  ] as const,
  () => [] as const,
);

const OAuthProviderTemporarilyUnavailable = createKnownErrorConstructor(
  KnownError,
  "OAUTH_PROVIDER_TEMPORARILY_UNAVAILABLE",
  () => [
    503,
    "The OAuth provider is temporarily unavailable. Please try again later.",
  ] as const,
  () => [] as const,
);

const ContactChannelAlreadyUsedForAuthBySomeoneElse = createKnownErrorConstructor(
  KnownError,
  "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
  (type: "email", contactChannelValue?: string, wouldWorkIfEmailWasVerified: boolean = false) => [
    409,
    `This ${type} ${contactChannelValue ? `"(${contactChannelValue})"` : ""} is already used for authentication by another account${wouldWorkIfEmailWasVerified ? " but the email is not verified. Please login to your existing account with the method you used to sign up, and then verify your email to sign in with this login method." : "."}`,
    {
      type,
      contact_channel_value: contactChannelValue ?? null,
      would_work_if_email_was_verified: wouldWorkIfEmailWasVerified,
    },
  ] as const,
  (json) => [json.type, json.contact_channel_value, json.would_work_if_email_was_verified ?? false] as const,
);

const InvalidPollingCodeError = createKnownErrorConstructor(
  KnownError,
  "INVALID_POLLING_CODE",
  (details?: Json) => [
    400,
    "The polling code is invalid or does not exist.",
    details,
  ] as const,
  (json: any) => [json] as const,
);

const CliAuthError = createKnownErrorConstructor(
  KnownError,
  "CLI_AUTH_ERROR",
  (message: string) => [
    400,
    message,
  ] as const,
  (json: any) => [json.message] as const,
);

const CliAuthExpiredError = createKnownErrorConstructor(
  KnownError,
  "CLI_AUTH_EXPIRED_ERROR",
  (message: string = "CLI authentication request expired. Please try again.") => [
    400,
    message,
  ] as const,
  (json: any) => [json.message] as const,
);

const CliAuthUsedError = createKnownErrorConstructor(
  KnownError,
  "CLI_AUTH_USED_ERROR",
  (message: string = "This authentication token has already been used.") => [
    400,
    message,
  ] as const,
  (json: any) => [json.message] as const,
);


const ApiKeyNotValid = createKnownErrorConstructor(
  KnownError,
  "API_KEY_NOT_VALID",
  "inherit",
  "inherit",
);

const ApiKeyExpired = createKnownErrorConstructor(
  ApiKeyNotValid,
  "API_KEY_EXPIRED",
  () => [
    401,
    "API key has expired.",
  ] as const,
  () => [] as const,
);

const ApiKeyRevoked = createKnownErrorConstructor(
  ApiKeyNotValid,
  "API_KEY_REVOKED",
  () => [
    401,
    "API key has been revoked.",
  ] as const,
  () => [] as const,
);

const WrongApiKeyType = createKnownErrorConstructor(
  ApiKeyNotValid,
  "WRONG_API_KEY_TYPE",
  (expectedType: string, actualType: string) => [
    400,
    `This endpoint is for ${expectedType} API keys, but a ${actualType} API key was provided.`,
    { expected_type: expectedType, actual_type: actualType },
  ] as const,
  (json) => [json.expected_type, json.actual_type] as const,
);

const ApiKeyNotFound = createKnownErrorConstructor(
  ApiKeyNotValid,
  "API_KEY_NOT_FOUND",
  () => [
    404,
    "API key not found.",
  ] as const,
  () => [] as const,
);

const PublicApiKeyCannotBeRevoked = createKnownErrorConstructor(
  ApiKeyNotValid,
  "PUBLIC_API_KEY_CANNOT_BE_REVOKED",
  () => [
    400,
    "Public API keys cannot be revoked by the secretscanner endpoint.",
  ] as const,
  () => [] as const,
);
const PermissionIdAlreadyExists = createKnownErrorConstructor(
  KnownError,
  "PERMISSION_ID_ALREADY_EXISTS",
  (permissionId: string) => [
    400,
    `Permission with ID "${permissionId}" already exists. Choose a different ID.`,
    {
      permission_id: permissionId,
    },
  ] as const,
  (json: any) => [json.permission_id] as const,
);

const EmailRenderingError = createKnownErrorConstructor(
  KnownError,
  "EMAIL_RENDERING_ERROR",
  (error: string) => [
    400,
    `Failed to render email with theme: ${error}`,
    { error },
  ] as const,
  (json: any) => [json.error] as const,
);

const TemplateSourceRewriteError = createKnownErrorConstructor(
  KnownError,
  "TEMPLATE_SOURCE_REWRITE_ERROR",
  (error: string) => [
    400,
    `Failed to rewrite template source: ${error}`,
    { error },
  ] as const,
  (json: any) => [json.error] as const,
);

const RequiresCustomEmailServer = createKnownErrorConstructor(
  KnownError,
  "REQUIRES_CUSTOM_EMAIL_SERVER",
  () => [
    400,
    `This action requires a custom SMTP server. Please edit your email server configuration and try again.`,
  ] as const,
  () => [] as const,
);

const EmailCapacityBoostAlreadyActive = createKnownErrorConstructor(
  KnownError,
  "EMAIL_CAPACITY_BOOST_ALREADY_ACTIVE",
  (expiresAt: string) => [
    409,
    `Email capacity boost is already active until ${expiresAt}.`,
    { expires_at: expiresAt },
  ] as const,
  (json: any) => [json.expires_at] as const,
);

const EmailNotEditable = createKnownErrorConstructor(
  KnownError,
  "EMAIL_NOT_EDITABLE",
  (emailId: string, status: string) => [
    400,
    `Email with ID "${emailId}" cannot be edited because it is in status "${status}". Only emails in PAUSED, PREPARING, RENDERING, RENDER_ERROR, SCHEDULED, QUEUED, or SERVER_ERROR status can be edited.`,
    {
      email_id: emailId,
      status,
    },
  ] as const,
  (json: any) => [json.email_id, json.status] as const,
);

const ItemNotFound = createKnownErrorConstructor(
  KnownError,
  "ITEM_NOT_FOUND",
  (itemId: string) => [
    404,
    `Item with ID "${itemId}" not found.`,
    {
      item_id: itemId,
    },
  ] as const,
  (json) => [json.item_id] as const,
);

const ItemCustomerTypeDoesNotMatch = createKnownErrorConstructor(
  KnownError,
  "ITEM_CUSTOMER_TYPE_DOES_NOT_MATCH",
  (itemId: string, customerId: string, itemCustomerType: "user" | "team" | "custom" | undefined, actualCustomerType: "user" | "team" | "custom") => [
    400,
    `The ${actualCustomerType} with ID ${JSON.stringify(customerId)} is not a valid customer for the item with ID ${JSON.stringify(itemId)}. ${itemCustomerType ? `The item is configured to only be available for ${itemCustomerType} customers, but the customer is a ${actualCustomerType}.` : `The item is missing a customer type field. Please make sure it is set up correctly in your project configuration.`}`,
    {
      item_id: itemId,
      customer_id: customerId,
      item_customer_type: itemCustomerType ?? null,
      actual_customer_type: actualCustomerType,
    },
  ] as const,
  (json) => [json.item_id, json.customer_id, json.item_customer_type ?? undefined, json.actual_customer_type] as const,
);

const CustomerDoesNotExist = createKnownErrorConstructor(
  KnownError,
  "CUSTOMER_DOES_NOT_EXIST",
  (customerId: string) => [
    400,
    `Customer with ID ${JSON.stringify(customerId)} does not exist.`,
    {
      customer_id: customerId,
    },
  ] as const,
  (json) => [json.customer_id] as const,
);

const SubscriptionInvoiceNotFound = createKnownErrorConstructor(
  KnownError,
  "SUBSCRIPTION_INVOICE_NOT_FOUND",
  (subscriptionInvoiceId: string) => [
    404,
    `Subscription invoice with ID ${JSON.stringify(subscriptionInvoiceId)} does not exist.`,
    {
      subscription_invoice_id: subscriptionInvoiceId,
    },
  ] as const,
  (json) => [json.subscription_invoice_id] as const,
);

const OneTimePurchaseNotFound = createKnownErrorConstructor(
  KnownError,
  "ONE_TIME_PURCHASE_NOT_FOUND",
  (purchaseId: string) => [
    404,
    `One-time purchase with ID ${JSON.stringify(purchaseId)} does not exist.`,
    {
      one_time_purchase_id: purchaseId,
    },
  ] as const,
  (json) => [json.one_time_purchase_id] as const,
);

// Used by the three-knob refund flow's legacy backstop — these are thrown
// when a purchase has the pre-rework `refundedAt` column set (i.e. it was
// refunded under the previous flow). The new flow's bulldozer-derived
// prior-refund summary can't see those rows, so this gate prevents
// double-refunding through Stripe.
const SubscriptionAlreadyRefunded = createKnownErrorConstructor(
  KnownError,
  "SUBSCRIPTION_ALREADY_REFUNDED",
  (subscriptionId: string) => [
    400,
    `Subscription with ID ${JSON.stringify(subscriptionId)} was already refunded.`,
    {
      subscription_id: subscriptionId,
    },
  ] as const,
  (json) => [json.subscription_id] as const,
);

const OneTimePurchaseAlreadyRefunded = createKnownErrorConstructor(
  KnownError,
  "ONE_TIME_PURCHASE_ALREADY_REFUNDED",
  (purchaseId: string) => [
    400,
    `One-time purchase with ID ${JSON.stringify(purchaseId)} was already refunded.`,
    {
      one_time_purchase_id: purchaseId,
    },
  ] as const,
  (json) => [json.one_time_purchase_id] as const,
);

const TestModePurchaseNonRefundable = createKnownErrorConstructor(
  KnownError,
  "TEST_MODE_PURCHASE_NON_REFUNDABLE",
  () => [
    400,
    "Test mode purchases are not refundable.",
  ] as const,
  () => [] as const,
);


const ProductDoesNotExist = createKnownErrorConstructor(
  KnownError,
  "PRODUCT_DOES_NOT_EXIST",
  (productId: string, context: "item_exists" | "server_only" | null) => [
    400,
    `Product with ID ${JSON.stringify(productId)} ${context === "server_only"
      ? "is marked as server-only and cannot be accessed client side."
      : context === "item_exists"
        ? "does not exist, but an item with this ID exists."
        : "does not exist."
    }`,
    {
      product_id: productId,
      context,
    } as const,
  ] as const,
  (json) => [json.product_id, json.context] as const,
);

const ProductCustomerTypeDoesNotMatch = createKnownErrorConstructor(
  KnownError,
  "PRODUCT_CUSTOMER_TYPE_DOES_NOT_MATCH",
  (productId: string | undefined, customerId: string, productCustomerType: "user" | "team" | "custom" | undefined, actualCustomerType: "user" | "team" | "custom") => [
    400,
    `The ${actualCustomerType} with ID ${JSON.stringify(customerId)} is not a valid customer for the inline product that has been passed in. ${productCustomerType ? `The product is configured to only be available for ${productCustomerType} customers, but the customer is a ${actualCustomerType}.` : `The product is missing a customer type field. Please make sure it is set up correctly in your project configuration.`}`,
    {
      product_id: productId ?? null,
      customer_id: customerId,
      product_customer_type: productCustomerType ?? null,
      actual_customer_type: actualCustomerType,
    },
  ] as const,
  (json) => [json.product_id ?? undefined, json.customer_id, json.product_customer_type ?? undefined, json.actual_customer_type] as const,
);

const ProductAlreadyGranted = createKnownErrorConstructor(
  KnownError,
  "PRODUCT_ALREADY_GRANTED",
  (productId: string, customerId: string) => [
    400,
    `Customer with ID ${JSON.stringify(customerId)} already owns product ${JSON.stringify(productId)}.`,
    {
      product_id: productId,
      customer_id: customerId,
    },
  ] as const,
  (json) => [json.product_id, json.customer_id] as const,
);

const ItemQuantityInsufficientAmount = createKnownErrorConstructor(
  KnownError,
  "ITEM_QUANTITY_INSUFFICIENT_AMOUNT",
  (itemId: string, customerId: string, quantity: number) => [
    400,
    `The item with ID ${JSON.stringify(itemId)} has an insufficient quantity for the customer with ID ${JSON.stringify(customerId)}. An attempt was made to charge ${quantity} credits.`,
    {
      item_id: itemId,
      customer_id: customerId,
      quantity,
    },
  ] as const,
  (json) => [json.item_id, json.customer_id, json.quantity] as const,
);

const StripeAccountInfoNotFound = createKnownErrorConstructor(
  KnownError,
  "STRIPE_ACCOUNT_INFO_NOT_FOUND",
  () => [
    404,
    "Stripe account information not found. Please make sure the user has onboarded with Stripe.",
  ] as const,
  () => [] as const,
);

const AnalyticsQueryTimeout = createKnownErrorConstructor(
  KnownError,
  "ANALYTICS_QUERY_TIMEOUT",
  (timeoutMs: number) => [
    400,
    `The query timed out. Please try again with a shorter query or increase the timeout. Timeout was ${timeoutMs}ms.`,
    { timeout_ms: timeoutMs },
  ] as const,
  (json) => [json.timeout_ms] as const,
);

const AnalyticsQueryError = createKnownErrorConstructor(
  KnownError,
  "ANALYTICS_QUERY_ERROR",
  (error: string) => [
    400,
    `${error}`,
    { error },
  ] as const,
  (json) => [json.error] as const,
);

const AnalyticsNotEnabled = createKnownErrorConstructor(
  KnownError,
  "ANALYTICS_NOT_ENABLED",
  () => [
    400,
    "Analytics is not enabled for this project.",
  ] as const,
  () => [] as const,
);

const DefaultPaymentMethodRequired = createKnownErrorConstructor(
  KnownError,
  "DEFAULT_PAYMENT_METHOD_REQUIRED",
  (customerType: "user" | "team", customerId: string) => [
    400,
    "No default payment method is set for this customer.",
    {
      customer_type: customerType,
      customer_id: customerId,
    },
  ] as const,
  (json) => [json.customer_type, json.customer_id] as const,
);

const NewPurchasesBlocked = createKnownErrorConstructor(
  KnownError,
  "NEW_PURCHASES_BLOCKED",
  () => [
    403,
    "New purchases are currently blocked for this project. Please contact support for more information.",
  ] as const,
  () => [] as const,
);

const TooManyImageAttachments = createKnownErrorConstructor(
  KnownError,
  "TOO_MANY_IMAGE_ATTACHMENTS",
  (maxImages: number) => [
    400,
    `Maximum ${maxImages} images per message.`,
    {
      max_images: maxImages,
    },
  ] as const,
  (json) => [json.max_images] as const,
);

const ImageAttachmentTooLarge = createKnownErrorConstructor(
  KnownError,
  "IMAGE_ATTACHMENT_TOO_LARGE",
  (maxBytes: number, actualBytes: number) => [
    400,
    `Image exceeds ${maxBytes / (1024 * 1024)}MB limit (${(actualBytes / 1024 / 1024).toFixed(2)}MB).`,
    {
      max_bytes: maxBytes,
      actual_bytes: actualBytes,
    },
  ] as const,
  (json) => [json.max_bytes, json.actual_bytes] as const,
);

export type KnownErrors = {
  [K in keyof typeof KnownErrors]: InstanceType<typeof KnownErrors[K]>;
};

export const KnownErrors = {
  CannotDeleteCurrentSession,
  UnsupportedError,
  BodyParsingError,
  SchemaError,
  AllOverloadsFailed,
  ProjectAuthenticationError,
  PermissionIdAlreadyExists,
  CliAuthError,
  CliAuthExpiredError,
  CliAuthUsedError,
  InvalidProjectAuthentication,
  ProjectKeyWithoutAccessType,
  InvalidAccessType,
  AccessTypeWithoutProjectId,
  AccessTypeRequired,
  CannotGetOwnUserWithoutUser,
  InsufficientAccessType,
  InvalidPublishableClientKey,
  InvalidSecretServerKey,
  InvalidSuperSecretAdminKey,
  InvalidAdminAccessToken,
  UnparsableAdminAccessToken,
  AdminAccessTokenExpired,
  InvalidProjectForAdminAccessToken,
  AdminAccessTokenIsNotAdmin,
  ProjectAuthenticationRequired,
  ClientAuthenticationRequired,
  PublishableClientKeyRequiredForProject,
  ServerAuthenticationRequired,
  ClientOrServerAuthenticationRequired,
  ClientOrAdminAuthenticationRequired,
  ClientOrServerOrAdminAuthenticationRequired,
  AdminAuthenticationRequired,
  ExpectedInternalProject,
  SessionAuthenticationError,
  InvalidSessionAuthentication,
  InvalidAccessToken,
  UnparsableAccessToken,
  AccessTokenExpired,
  InvalidProjectForAccessToken,
  RefreshTokenError,
  ProviderRejected,
  RefreshTokenNotFoundOrExpired,
  UserWithEmailAlreadyExists,
  EmailNotVerified,
  UserIdDoesNotExist,
  UserNotFound,
  RestrictedUserNotAllowed,
  ApiKeyNotFound,
  PublicApiKeyCannotBeRevoked,
  ProjectNotFound,
  CurrentProjectNotFound,
  BranchDoesNotExist,
  SignUpNotEnabled,
  SignUpRejected,
  BotChallengeRequired,
  BotChallengeFailed,
  PasswordAuthenticationNotEnabled,
  PasskeyAuthenticationNotEnabled,
  AnonymousAccountsNotEnabled,
  AnonymousAuthenticationNotAllowed,
  EmailPasswordMismatch,
  RedirectUrlNotWhitelisted,
  PasswordRequirementsNotMet,
  PasswordTooShort,
  PasswordTooLong,
  UserDoesNotHavePassword,
  VerificationCodeError,
  VerificationCodeNotFound,
  VerificationCodeExpired,
  VerificationCodeAlreadyUsed,
  VerificationCodeMaxAttemptsReached,
  PasswordConfirmationMismatch,
  EmailAlreadyVerified,
  EmailNotAssociatedWithUser,
  EmailIsNotPrimaryEmail,
  PasskeyRegistrationFailed,
  PasskeyWebAuthnError,
  PasskeyAuthenticationFailed,
  PermissionNotFound,
  PermissionScopeMismatch,
  ContainedPermissionNotFound,
  TeamNotFound,
  TeamMembershipNotFound,
  TeamInvitationRestrictedUserNotAllowed,
  TeamInvitationEmailMismatch,
  EmailTemplateAlreadyExists,
  OAuthConnectionNotConnectedToUser,
  OAuthConnectionAlreadyConnectedToAnotherUser,
  OAuthConnectionDoesNotHaveRequiredScope,
  OAuthAccessTokenNotAvailable,
  OAuthExtraScopeNotAvailableWithSharedOAuthKeys,
  OAuthAccessTokenNotAvailableWithSharedOAuthKeys,
  InvalidOAuthClientIdOrSecret,
  InvalidScope,
  UserAlreadyConnectedToAnotherOAuthConnection,
  OuterOAuthTimeout,
  OAuthProviderNotFoundOrNotEnabled,
  AppleBundleIdNotConfigured,
  OAuthProviderAccountIdAlreadyUsedForSignIn,
  MultiFactorAuthenticationRequired,
  InvalidTotpCode,
  UserAuthenticationRequired,
  TeamMembershipAlreadyExists,
  ProjectPermissionRequired,
  TeamPermissionRequired,
  InvalidSharedOAuthProviderId,
  InvalidStandardOAuthProviderId,
  InvalidAuthorizationCode,
  InvalidAppleCredentials,
  TeamPermissionNotFound,
  OAuthProviderAccessDenied,
  OAuthProviderTemporarilyUnavailable,
  ContactChannelAlreadyUsedForAuthBySomeoneElse,
  InvalidPollingCodeError,
  ApiKeyNotValid,
  ApiKeyExpired,
  ApiKeyRevoked,
  WrongApiKeyType,
  EmailRenderingError,
  TemplateSourceRewriteError,
  RequiresCustomEmailServer,
  EmailCapacityBoostAlreadyActive,
  EmailNotEditable,
  ItemNotFound,
  ItemCustomerTypeDoesNotMatch,
  CustomerDoesNotExist,
  ProductDoesNotExist,
  ProductCustomerTypeDoesNotMatch,
  ProductAlreadyGranted,
  SubscriptionInvoiceNotFound,
  OneTimePurchaseNotFound,
  SubscriptionAlreadyRefunded,
  OneTimePurchaseAlreadyRefunded,
  TestModePurchaseNonRefundable,
  ItemQuantityInsufficientAmount,
  StripeAccountInfoNotFound,
  DefaultPaymentMethodRequired,
  NewPurchasesBlocked,
  DataVaultStoreDoesNotExist,
  DataVaultStoreHashedKeyDoesNotExist,
  AnalyticsQueryTimeout,
  AnalyticsQueryError,
  AnalyticsNotEnabled,
  TooManyImageAttachments,
  ImageAttachmentTooLarge,
} satisfies Record<string, KnownErrorConstructor<any, any>>;


// ensure that all known error codes are unique
const knownErrorCodes = new Set<string>();
for (const [_, KnownError] of Object.entries(KnownErrors)) {
  if (knownErrorCodes.has(KnownError.errorCode)) {
    throw new Error(`Duplicate known error code: ${KnownError.errorCode}`);
  }
  knownErrorCodes.add(KnownError.errorCode);
}

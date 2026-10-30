import { recordExternalDbSyncDeletion } from "@/lib/external-db-sync";
import { logSignInAttemptInBackground } from "@/lib/compliance-events";
import { validateRedirectUrl } from "@/lib/redirect-urls";
import { getApiUrlForRequest } from "@/lib/request-api-url";
import { getSoleTenancyFromProjectBranch, getTenancy, Tenancy } from "@/lib/tenancies";
import { PrismaTransaction } from "@/lib/types";
import { globalPrismaClient } from "@/prisma-client";
import { Prisma, VerificationCodeType } from "@/generated/prisma/client";
import { KnownErrors } from "@hexclave/shared";
import { ProjectsCrud } from "@hexclave/shared/dist/interface/crud/projects";
import { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import { adaptSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { DeepPartial } from "@hexclave/shared/dist/utils/objects";
import * as yup from "yup";
import { SmartRequest } from "./smart-request";
import { SmartResponse } from "./smart-response";
import { createSmartRouteHandler, SmartRouteHandler, SmartRouteHandlerOverloadMetadata } from "./smart-route-handler";

const MAX_ATTEMPTS_PER_CODE = 20;

export async function claimVerificationCode(options: {
  projectId: string,
  branchId: string,
  type: VerificationCodeType,
  code: string,
}): Promise<void> {
  const claimResult = await globalPrismaClient.verificationCode.updateMany({
    where: {
      projectId: options.projectId,
      branchId: options.branchId,
      code: options.code,
      type: options.type,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: {
      usedAt: new Date(),
    },
  });
  if (claimResult.count === 0) {
    throw new KnownErrors.VerificationCodeAlreadyUsed();
  }
}

type CreateCodeOptions<Data, Method extends {}, CallbackUrl extends string | URL | undefined, AlreadyParsed extends boolean = true> = ProjectBranchCombo<AlreadyParsed> & {
  method: Method,
  expiresInMs?: number,
  transaction?: PrismaTransaction,
  data: Data,
  callbackUrl: CallbackUrl,
};

type ListCodesOptions<Data, AlreadyParsed extends boolean = true> = ProjectBranchCombo<AlreadyParsed> & {
  dataFilter?: Prisma.JsonFilter<"VerificationCode"> | undefined,
}

type RevokeCodeOptions<AlreadyParsed extends boolean = true> = ProjectBranchCombo<AlreadyParsed> & {
  id: string,
  dataFilter?: Prisma.JsonFilter<"VerificationCode"> | undefined,
}

type CodeObject<Data, Method extends {}, CallbackUrl extends string | URL | undefined> = {
  id: string,
  data: Data,
  method: Method,
  code: string,
  link: CallbackUrl extends string | URL ? URL : undefined,
  expiresAt: Date,
};

type VerificationCodeHandler<Data, SendCodeExtraOptions extends {}, SendCodeReturnType, HasDetails extends boolean, Method extends {}> = {
  createCode<CallbackUrl extends string | URL | undefined>(options: CreateCodeOptions<Data, Method, CallbackUrl, false>): Promise<CodeObject<Data, Method, CallbackUrl>>,
  sendCode(options: CreateCodeOptions<Data, Method, string | URL, false>, sendOptions: SendCodeExtraOptions): Promise<SendCodeReturnType>,
  listCodes(options: ListCodesOptions<Data, false>): Promise<CodeObject<Data, Method, string | URL>[]>,
  revokeCode(options: RevokeCodeOptions<false>): Promise<void>,
  validateCode(fullCode: string): Promise<CodeObject<Data, Method, string | URL>>,
  postHandler: SmartRouteHandler<any, any, any>,
  checkHandler: SmartRouteHandler<any, any, any>,
  detailsHandler: HasDetails extends true ? SmartRouteHandler<any, any, any> : undefined,
};

type ProjectBranchCombo<AlreadyParsed extends boolean> = (
  | { project: Omit<ProjectsCrud["Admin"]["Read"], "config">, branchId: string, tenancy?: undefined }
  | (AlreadyParsed extends true ? never : { tenancy: Tenancy, project?: undefined, branchId?: undefined })
);

function parseProjectBranchCombo<T extends ProjectBranchCombo<boolean>>(obj: T): T & ProjectBranchCombo<true> {
  return {
    ...obj,
    project: obj.project ?? obj.tenancy.project,
    branchId: obj.branchId ?? obj.tenancy.branchId,
  };
}

/**
 * Make sure to always check that the method is the same as the one in the data.
 */
export function createVerificationCodeHandler<
  Data,
  RequestBody extends {} & DeepPartial<SmartRequest["body"]>,
  Response extends SmartResponse,
  DetailsResponse extends SmartResponse | undefined,
  SendCodeExtraOptions extends {},
  Method extends {},
  SendCodeReturnType,
>(options: {
  metadata?: {
    post?: SmartRouteHandlerOverloadMetadata,
    check?: SmartRouteHandlerOverloadMetadata,
    details?: SmartRouteHandlerOverloadMetadata,
    codeDescription?: string,
  },
  type: VerificationCodeType,
  data: yup.Schema<Data>,
  method: yup.Schema<Method>,
  requestBody?: yup.ObjectSchema<RequestBody>,
  detailsResponse?: yup.Schema<DetailsResponse>,
  response: yup.Schema<Response>,
  complianceSignInAttempt?: boolean,
  send?(
    codeObject: CodeObject<Data, Method, string | URL>,
    createOptions: CreateCodeOptions<Data, Method, string | URL>,
    sendOptions: SendCodeExtraOptions,
  ): Promise<SendCodeReturnType>,
  validate?(
    tenancy: Tenancy,
    method: Method,
    data: Data,
    body: RequestBody,
    user: UsersCrud["Admin"]["Read"] | undefined
  ): Promise<void>,
  handler(
    tenancy: Tenancy,
    method: Method,
    data: Data,
    body: RequestBody,
    user: UsersCrud["Admin"]["Read"] | undefined,
    // Host-derived API URL for the request that submitted the verification
    // code, computed from `request-api-url.ts`. Hands off the request host to
    // verification flows (MFA / OTP / passkey sign-in) so the JWT `iss` claim
    // on the access token they mint follows the SDK's configured host instead
    // of falling back to `NEXT_PUBLIC_STACK_API_URL`. Implementations that
    // don't sign tokens can ignore it.
    apiUrl: string,
  ): Promise<Response>,
  details?: DetailsResponse extends SmartResponse ? ((
    tenancy: Tenancy,
    method: Method,
    data: Data,
    body: RequestBody,
    user: UsersCrud["Admin"]["Read"] | undefined
  ) => Promise<DetailsResponse>) : undefined,
}): VerificationCodeHandler<Data, SendCodeExtraOptions, SendCodeReturnType, DetailsResponse extends SmartResponse ? true : false, Method> {
  const createHandler = (handlerType: 'post' | 'check' | 'details') => createSmartRouteHandler({
    metadata: options.metadata?.[handlerType],
    request: yupObject({
      auth: yupObject({
        tenancy: adaptSchema.defined(),
        project: adaptSchema.defined(),
        branchId: adaptSchema.defined(),
        user: adaptSchema,
      }).defined(),
      body: yupObject({
        code: yupString().length(45).defined().meta({ openapiField: { description: options.metadata?.codeDescription || "A 45 character code", exampleValue: "u3h6gn4w24pqc8ya679inrhjwh1rybth6a7thurqhnpf2" } }),
      // we cast to undefined as a typehack because the types are a bit icky
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      }).concat((handlerType === 'post' ? options.requestBody : undefined) as undefined ?? yupObject({})).defined(),
    }),
    response: handlerType === 'check' ?
      yupObject({
        statusCode: yupNumber().oneOf([200]).defined(),
        bodyType: yupString().oneOf(["json"]).defined(),
        body: yupObject({
          "is_code_valid": yupBoolean().oneOf([true]).defined(),
        }).defined(),
      }).defined() as yup.ObjectSchema<any> :
      handlerType === 'details' ?
        options.detailsResponse || throwErr('detailsResponse is required') :
        options.response,
    async handler({ body: { code: codeRaw, ...requestBody }, auth }, fullReq) {
      // Codes generated by createCode are always lowercase, but the code sent in the e-mail is uppercase
      // To not confuse the developers, we always convert the code to lowercase
      const code = codeRaw.toLowerCase();

      const verificationCode = await globalPrismaClient.verificationCode.findUnique({
        where: {
          projectId_branchId_code: {
            projectId: auth.project.id,
            branchId: auth.branchId,
            code,
          },
          type: options.type,
        },
      });

      const logOtpFailure = (failureReason: "invalid_otp" | "expired_otp" | "used_otp" | "max_attempts", method: unknown) => {
        if (options.complianceSignInAttempt !== true) {
          return;
        }
        const email = typeof method === "object"
          && method !== null
          && "email" in method
          && typeof method.email === "string"
          ? method.email
          : null;
        logSignInAttemptInBackground(auth.tenancy, {
          outcome: "failed",
          method: "otp",
          failureReason,
          email,
        });
      };

      // Increment the attempt count for all codes that match except for the first 6 characters
      await globalPrismaClient.verificationCode.updateMany({
        where: {
          projectId: auth.project.id,
          branchId: auth.branchId,
          code: {
            endsWith: code.slice(6),
          }
        },
        data: {
          attemptCount: { increment: 1 },
        },
      });

      if (!verificationCode) {
        logOtpFailure("invalid_otp", undefined);
        throw new KnownErrors.VerificationCodeNotFound();
      }
      if (verificationCode.expiresAt < new Date()) {
        logOtpFailure("expired_otp", verificationCode.method);
        throw new KnownErrors.VerificationCodeExpired();
      }
      if (verificationCode.usedAt) {
        logOtpFailure("used_otp", verificationCode.method);
        throw new KnownErrors.VerificationCodeAlreadyUsed();
      }
      if (verificationCode.attemptCount >= MAX_ATTEMPTS_PER_CODE) {
        logOtpFailure("max_attempts", verificationCode.method);
        throw new KnownErrors.VerificationCodeMaxAttemptsReached;
      }

      const validatedMethod = await options.method.validate(verificationCode.method, {
        strict: true,
      });
      const validatedData = await options.data.validate(verificationCode.data, {
        strict: true,
      });

      if (options.validate) {
        await options.validate(auth.tenancy, validatedMethod, validatedData, requestBody as any, auth.user as any);
      }

      switch (handlerType) {
        case 'post': {
          // Atomic claim — conditional WHERE closes the TOCTOU against the checks above.
          // claimVerificationCode throws VerificationCodeAlreadyUsed if the code was
          // claimed between the checks above and here; log that race as a used_otp failure.
          try {
            await claimVerificationCode({
              projectId: auth.project.id,
              branchId: auth.branchId,
              type: options.type,
              code,
            });
          } catch (error) {
            if (KnownErrors.VerificationCodeAlreadyUsed.isInstance(error)) {
              logOtpFailure("used_otp", verificationCode.method);
            }
            throw error;
          }

          return await options.handler(auth.tenancy, validatedMethod, validatedData, requestBody as any, auth.user, getApiUrlForRequest(fullReq));
        }
        case 'check': {
          return {
            statusCode: 200,
            bodyType: "json",
            body: {
              is_code_valid: true,
            },
          };
        }
        case 'details': {
          return await options.details?.(auth.tenancy, validatedMethod, validatedData, requestBody as any, auth.user as any) as any;
        }
      }
    },
  });

  return {
    async createCode({ method, data, callbackUrl, expiresInMs, transaction, ...params }) {
      const { project, branchId } = parseProjectBranchCombo(params);
      const validatedData = await options.data.validate(data, {
        strict: true,
      });
      if (callbackUrl !== undefined) {
        // Reuse the caller's tenancy if it has one. The lookup runs on `globalPrismaClient`, so when the caller passes a
        // `transaction` (eg. `createRateLimitedSmsCode`, which holds an advisory lock in it), looking the tenancy up again
        // would take a second pool connection while the first one is still held.
        const tenancy = params.tenancy ?? await getSoleTenancyFromProjectBranch(project.id, branchId);
        if (!validateRedirectUrl(callbackUrl, tenancy)) {
          throw new KnownErrors.RedirectUrlNotWhitelisted(callbackUrl.toString());
        }
      }

      const verificationCodePrisma = await (transaction ?? globalPrismaClient).verificationCode.create({
        data: {
          projectId: project.id,
          branchId,
          type: options.type,
          code: generateSecureRandomString(),
          redirectUrl: callbackUrl?.toString(),
          expiresAt: new Date(Date.now() + (expiresInMs ?? 1000 * 60 * 60 * 24 * 7)),  // default: expire after 7 days
          data: validatedData as any,
          method: method,
        }
      });

      return createCodeObjectFromPrismaCode(verificationCodePrisma);
    },
    async sendCode(createOptions, sendOptions) {
      const codeObj = await this.createCode(createOptions);
      if (!options.send) {
        throw new HexclaveAssertionError("Cannot use sendCode on this verification code handler because it doesn't have a send function");
      }
      return await options.send(codeObj, parseProjectBranchCombo(createOptions), sendOptions);
    },
    async listCodes(listOptions) {
      const { project, branchId } = parseProjectBranchCombo(listOptions);
      const tenancy = await getSoleTenancyFromProjectBranch(project.id, branchId);

      const codes = await globalPrismaClient.verificationCode.findMany({
        where: {
          projectId: project.id,
          branchId,
          type: options.type,
          usedAt: null,
          expiresAt: { gt: new Date() },
          data: listOptions.dataFilter,
        },
      });

      return codes.map(code => createCodeObjectFromPrismaCode(code));
    },
    async revokeCode(revokeOptions) {
      const { project, branchId } = parseProjectBranchCombo(revokeOptions);
      const tenancy = await getSoleTenancyFromProjectBranch(project.id, branchId);

      const where = {
        projectId: project.id,
        branchId,
        id: revokeOptions.id,
        type: options.type,
        data: revokeOptions.dataFilter,
      } satisfies Prisma.VerificationCodeWhereInput;

      const existingCode = await globalPrismaClient.verificationCode.findFirst({
        where,
        select: {
          id: true,
        },
      });

      if (existingCode == null) {
        // Either the code doesn't exist or it didn't match the authorized scope.
        // Return the same error in both cases so callers can't probe for the
        // existence of codes outside their scope.
        throw new KnownErrors.VerificationCodeNotFound();
      }

      // The deletion recorder snapshots the VerificationCode row, so it must run
      // before the delete. The scoped existence check above prevents tombstones
      // for codes outside the caller's authorized dataFilter.
      if (options.type === 'TEAM_INVITATION') {
        await recordExternalDbSyncDeletion(globalPrismaClient, {
          tableName: "VerificationCode_TEAM_INVITATION",
          tenancyId: tenancy.id,
          verificationCodeProjectId: project.id,
          verificationCodeBranchId: branchId,
          verificationCodeId: revokeOptions.id,
        });
      }

      const { count } = await globalPrismaClient.verificationCode.deleteMany({
        where,
      });

      if (count === 0) {
        throw new KnownErrors.VerificationCodeNotFound();
      }
    },
    async validateCode(tenancyIdAndCode: string) {
      const fullCodeParts = tenancyIdAndCode.split('_');
      if (fullCodeParts.length !== 2) {
        throw new KnownErrors.VerificationCodeNotFound();
      }
      const [tenancyId, code] = fullCodeParts;
      const tenancy = await getTenancy(tenancyId);
      if (!tenancy) {
        throw new KnownErrors.VerificationCodeNotFound();
      }
      const verificationCode = await globalPrismaClient.verificationCode.findUnique({
        where: {
          projectId_branchId_code: {
            projectId: tenancy.project.id,
            branchId: tenancy.branchId,
            code,
          },
          type: options.type,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
      });

      if (!verificationCode) throw new KnownErrors.VerificationCodeNotFound();
      if (verificationCode.expiresAt < new Date()) throw new KnownErrors.VerificationCodeExpired();
      if (verificationCode.attemptCount >= MAX_ATTEMPTS_PER_CODE) throw new KnownErrors.VerificationCodeMaxAttemptsReached;

      return createCodeObjectFromPrismaCode(verificationCode);
    },
    postHandler: createHandler('post'),
    checkHandler: createHandler('check'),
    detailsHandler: (options.detailsResponse ? createHandler('details') : undefined) as any,
  };
}


function createCodeObjectFromPrismaCode<Data, Method extends {}, CallbackUrl extends string | URL | undefined>(code: Prisma.VerificationCodeGetPayload<{}>): CodeObject<Data, Method, CallbackUrl> {
  let link: URL | undefined;
  if (code.redirectUrl !== null) {
    link = new URL(code.redirectUrl);
    link.searchParams.set('code', code.code);
  }

  return {
    id: code.id,
    data: code.data as Data,
    method: code.method as Method,
    code: code.code,
    link: link as any,
    expiresAt: code.expiresAt,
  };
}

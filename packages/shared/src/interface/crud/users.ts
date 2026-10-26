import type { InferType } from "yup";
import * as yup from "yup";
import { CrudTypeOf, createCrud } from "../../crud";
import * as fieldSchema from "../../schema-fields";
import { WebhookEvent } from "../webhooks";
import { teamsCrudServerReadSchema } from "./teams";

const restrictedByAdminMeta = {
  restricted_by_admin: { openapiField: { description: 'Whether the user is restricted by an administrator. Can be set manually or by sign-up rules.', exampleValue: false } },
  restricted_by_admin_reason: { openapiField: { description: 'Public reason shown to the user explaining why they are restricted. Optional.', exampleValue: null } },
  restricted_by_admin_private_details: { openapiField: { description: 'Private details about the restriction (e.g., which sign-up rule triggered). Only visible to server access and above.', exampleValue: null } },
} as const;

const countryCodeMeta = { openapiField: { description: 'Best-effort ISO country code captured at sign-up time from request geo headers.', exampleValue: "US" } } as const;

export const riskScoreFieldSchema = fieldSchema.yupNumber().integer().min(0).max(100).defined();
export const signUpRiskScoresSchema = fieldSchema.yupObject({
  sign_up: fieldSchema.yupObject({
    bot: riskScoreFieldSchema,
    free_trial_abuse: riskScoreFieldSchema,
  }).defined(),
});
export type SignUpRiskScoresCrud = InferType<typeof signUpRiskScoresSchema>["sign_up"];

const oauthProviderBaseFields = {
  id: fieldSchema.yupString().defined(),
  account_id: fieldSchema.yupString().defined(),
};
const hiddenFieldMeta = { openapiField: { hidden: true } } as const;

function restrictedByAdminConsistencyTest(this: yup.TestContext<any>, value: any) {
  if (value == null) return true;
  if (value.restricted_by_admin !== true) {
    if (value.restricted_by_admin_reason != null) {
      return this.createError({ message: "restricted_by_admin_reason must be null when restricted_by_admin is not true" });
    }
    if (value.restricted_by_admin_private_details != null) {
      return this.createError({ message: "restricted_by_admin_private_details must be null when restricted_by_admin is not true" });
    }
  }
  return true;
}

export const usersCrudServerUpdateSchema = fieldSchema.yupObject({
  display_name: fieldSchema.userDisplayNameSchema.optional(),
  profile_image_url: fieldSchema.profileImageUrlSchema.nullable().optional(),
  client_metadata: fieldSchema.userClientMetadataSchema.optional(),
  client_read_only_metadata: fieldSchema.userClientReadOnlyMetadataSchema.optional(),
  server_metadata: fieldSchema.userServerMetadataSchema.optional(),
  primary_email: fieldSchema.primaryEmailSchema.nullable().optional().nonEmpty(),
  primary_email_verified: fieldSchema.primaryEmailVerifiedSchema.optional(),
  primary_email_auth_enabled: fieldSchema.primaryEmailAuthEnabledSchema.optional(),
  passkey_auth_enabled: fieldSchema.userOtpAuthEnabledSchema.optional(),
  password: fieldSchema.userPasswordMutationSchema.optional(),
  password_hash: fieldSchema.userPasswordHashMutationSchema.optional(),
  otp_auth_enabled: fieldSchema.userOtpAuthEnabledMutationSchema.optional(),
  totp_secret_base64: fieldSchema.userTotpSecretMutationSchema.optional(),
  selected_team_id: fieldSchema.selectedTeamIdSchema.nullable().optional(),
  is_anonymous: fieldSchema.yupBoolean().oneOf([false]).optional(),
  restricted_by_admin: fieldSchema.yupBoolean().optional().meta(restrictedByAdminMeta.restricted_by_admin),
  restricted_by_admin_reason: fieldSchema.yupString().nullable().optional().meta(restrictedByAdminMeta.restricted_by_admin_reason),
  restricted_by_admin_private_details: fieldSchema.yupString().nullable().optional().meta(restrictedByAdminMeta.restricted_by_admin_private_details),
  country_code: fieldSchema.countryCodeSchema.nullable().optional().meta(countryCodeMeta),
  risk_scores: signUpRiskScoresSchema.optional(),
}).defined().test(
  "restricted_by_admin_consistency",
  "When restricted_by_admin is not true, reason and private_details must be null",
  restrictedByAdminConsistencyTest,
);

export const usersCrudServerReadSchema = fieldSchema.yupObject({
  id: fieldSchema.userIdSchema.defined(),
  primary_email: fieldSchema.primaryEmailSchema.nullable().defined(),
  primary_email_verified: fieldSchema.primaryEmailVerifiedSchema.defined(),
  primary_email_auth_enabled: fieldSchema.primaryEmailAuthEnabledSchema.defined(),
  display_name: fieldSchema.userDisplayNameSchema.nullable().defined(),
  selected_team: teamsCrudServerReadSchema.nullable().defined(),
  selected_team_id: fieldSchema.selectedTeamIdSchema.nullable().defined(),
  profile_image_url: fieldSchema.profileImageUrlSchema.nullable().defined(),
  signed_up_at_millis: fieldSchema.signedUpAtMillisSchema.defined(),
  has_password: fieldSchema.userHasPasswordSchema.defined(),
  otp_auth_enabled: fieldSchema.userOtpAuthEnabledSchema.defined(),
  passkey_auth_enabled: fieldSchema.userOtpAuthEnabledSchema.defined(),
  client_metadata: fieldSchema.userClientMetadataSchema,
  client_read_only_metadata: fieldSchema.userClientReadOnlyMetadataSchema,
  server_metadata: fieldSchema.userServerMetadataSchema,
  last_active_at_millis: fieldSchema.userLastActiveAtMillisSchema.nonNullable().defined(),
  is_anonymous: fieldSchema.yupBoolean().defined(),
  is_restricted: fieldSchema.yupBoolean().defined().meta({ openapiField: { description: 'Whether the user is in restricted state (has signed up but not completed onboarding requirements)', exampleValue: false } }),
  restricted_reason: fieldSchema.restrictedReasonSchema.nullable().defined().meta({ openapiField: { description: 'The reason why the user is restricted (e.g., type: "email_not_verified", "anonymous", or "restricted_by_administrator"), null if not restricted', exampleValue: null } }),
  restricted_by_admin: fieldSchema.yupBoolean().defined().meta(restrictedByAdminMeta.restricted_by_admin),
  restricted_by_admin_reason: fieldSchema.yupString().nullable().defined().meta(restrictedByAdminMeta.restricted_by_admin_reason),
  restricted_by_admin_private_details: fieldSchema.yupString().nullable().defined().meta(restrictedByAdminMeta.restricted_by_admin_private_details),
  country_code: fieldSchema.countryCodeSchema.nullable().defined().meta(countryCodeMeta),
  risk_scores: signUpRiskScoresSchema.defined().meta({ openapiField: { description: 'User risk scores used for sign-up risk evaluation.', exampleValue: { sign_up: { bot: 0, free_trial_abuse: 0 } } } }),

  oauth_providers: fieldSchema.yupArray(fieldSchema.yupObject({
    ...oauthProviderBaseFields,
    email: fieldSchema.yupString().nullable(),
  }).defined()).defined().meta(hiddenFieldMeta),
  external_auth_providers: fieldSchema.yupArray(fieldSchema.yupObject({
    id: fieldSchema.yupString().defined(),
  }).defined()).defined().meta(hiddenFieldMeta),

  /**
   * @deprecated
   */
  auth_with_email: fieldSchema.yupBoolean().defined().meta({ openapiField: { hidden: true, description: 'Whether the user can authenticate with their primary e-mail. If set to true, the user can log-in with credentials and/or magic link, if enabled in the project settings.', exampleValue: true } }),
  /**
   * @deprecated
   */
  requires_totp_mfa: fieldSchema.yupBoolean().defined().meta({ openapiField: { hidden: true, description: 'Whether the user is required to use TOTP MFA to sign in', exampleValue: false } }),
}).defined().test("restricted_reason_iff_restricted", "restricted_reason must be present if and only if is_restricted is true", function(this: yup.TestContext<any>, value: any) {
  if (value == null) return true;
  return value.is_restricted === !!value.restricted_reason;
}).test(
  "restricted_by_admin_consistency",
  "When restricted_by_admin is not true, reason and private_details must be null",
  restrictedByAdminConsistencyTest,
);

export const usersCrudServerCreateSchema = usersCrudServerUpdateSchema.omit(['selected_team_id']).concat(fieldSchema.yupObject({
  oauth_providers: fieldSchema.yupArray(fieldSchema.yupObject({
    ...oauthProviderBaseFields,
    email: fieldSchema.yupString().nullable().defined().default(null),
  }).defined()).optional().meta(hiddenFieldMeta),
  is_anonymous: fieldSchema.yupBoolean().optional(),
}).defined());

export const usersCrudServerDeleteSchema = fieldSchema.yupMixed();

export const usersCrud = createCrud({
  serverReadSchema: usersCrudServerReadSchema,
  serverUpdateSchema: usersCrudServerUpdateSchema,
  serverCreateSchema: usersCrudServerCreateSchema,
  serverDeleteSchema: usersCrudServerDeleteSchema,
  docs: {
    serverCreate: {
      tags: ["Users"],
      summary: 'Create user',
      description: 'Creates a new user. E-mail authentication is always enabled, and no password is set, meaning the only way to authenticate the newly created user is through magic link.',
    },
    serverRead: {
      tags: ["Users"],
      summary: 'Get user',
      description: 'Gets a user by user ID.',
    },
    serverUpdate: {
      tags: ["Users"],
      summary: 'Update user',
      description: 'Updates a user. Only the values provided will be updated.',
    },
    serverDelete: {
      tags: ["Users"],
      summary: 'Delete user',
      description: 'Deletes a user. Use this with caution.',
    },
    serverList: {
      tags: ["Users"],
      summary: 'List users',
      description: 'Lists all the users in the project. By default, only fully onboarded users are returned. Restricted users (those who haven\'t completed onboarding requirements like email verification) are included if `include_restricted` is set to `true`. Anonymous users are included if `include_anonymous` is set to `true` (which also includes restricted users).',
    },
  },
});
export type UsersCrud = CrudTypeOf<typeof usersCrud>;

function userWebhookEvent<S extends yup.Schema>(action: string, schema: S): WebhookEvent<S> {
  return {
    type: `user.${action}`,
    schema,
    metadata: {
      summary: `User ${action[0].toUpperCase()}${action.slice(1)}`,
      description: `This event is triggered when a user is ${action}.`,
      tags: ["Users"],
    },
  };
}

export const userCreatedWebhookEvent = userWebhookEvent("created", usersCrud.server.readSchema);
export const userUpdatedWebhookEvent = userWebhookEvent("updated", usersCrud.server.readSchema);

const webhookUserDeletedSchema = fieldSchema.yupObject({
  id: fieldSchema.userIdSchema.defined(),
  teams: fieldSchema.yupArray(fieldSchema.yupObject({
    id: fieldSchema.yupString().defined(),
  })).defined(),
}).defined();
export const userDeletedWebhookEvent = userWebhookEvent("deleted", webhookUserDeletedSchema);

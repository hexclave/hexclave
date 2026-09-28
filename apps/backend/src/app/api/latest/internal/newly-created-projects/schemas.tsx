import { ALL_APPS } from "@hexclave/shared/dist/apps/apps-config";
import {
  yupArray,
  yupBoolean,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";

export const OwnerMemberSchema = yupObject({
  id: yupString().defined(),
  display_name: yupString().nullable().defined(),
  primary_email: yupString().nullable().defined(),
  profile_image_url: yupString().nullable().defined(),
  created_at: yupString().defined(),
  last_active_at: yupString().defined(),
}).defined();

export const ProjectOwnerSchema = yupObject({
  kind: yupString().oneOf(["rde", "team", "user", "unknown"]).defined(),
  team_id: yupString().nullable().defined(),
  team_display_name: yupString().nullable().defined(),
  members: yupArray(OwnerMemberSchema).defined(),
}).defined();

export const AppTickLevelSchema = yupString().oneOf(["off", "enabled", "setup", "used"]).defined();

export const FeaturedAppsSchema = yupObject({
  authentication: AppTickLevelSchema,
  emails: AppTickLevelSchema,
  payments: AppTickLevelSchema,
  analytics: AppTickLevelSchema,
  "deploy": AppTickLevelSchema,
}).defined();

export const ProjectRowSchema = yupObject({
  id: yupString().defined(),
  display_name: yupString().defined(),
  description: yupString().defined(),
  created_at: yupString().defined(),
  is_development_environment: yupBoolean().defined(),
  onboarding_status: yupString().defined(),
  is_onboarding: yupBoolean().defined(),
  non_anonymous_users: yupNumber().integer().defined(),
  anonymous_users: yupNumber().integer().defined(),
  last_user_activity_at: yupString().nullable().defined(),
  has_activity_24h_after_creation: yupBoolean().defined(),
  owner: ProjectOwnerSchema,
  domains: yupArray(yupString().defined()).defined(),
  stripe_connected: yupBoolean().defined(),
  stripe_setup_complete: yupBoolean().defined(),
  email_customized: yupBoolean().defined(),
  email_customization: yupObject({
    has_draft: yupBoolean().defined(),
    has_modified_template: yupBoolean().defined(),
  }).defined(),
  email_setup: yupObject({
    kind: yupString().oneOf(["shared", "custom-domain", "custom-server"]).defined(),
    provider: yupString().oneOf(["resend", "smtp", "managed"]).nullable().defined(),
    sender_email: yupString().nullable().defined(),
    managed_subdomain: yupString().nullable().defined(),
  }).defined(),
  has_live_payment: yupBoolean().defined(),
  featured_apps: FeaturedAppsSchema,
  other_enabled_apps: yupArray(yupString().oneOf(Object.keys(ALL_APPS)).defined()).defined(),
}).defined();

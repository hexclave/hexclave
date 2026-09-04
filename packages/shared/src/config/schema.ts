// TODO: rename this file to spaghetti.ts because that's the kind of code here

// IMPORTANT
// WHENEVER YOU MAKE BACKWARDS-INCOMPATIBLE CHANGES TO THE CONFIG SCHEMA, YOU MUST UPDATE THE MIGRATION FUNCTIONS BELOW.
// OTHERWISE THINGS WILL GO BOOM!!

import * as yup from "yup";
import { ALL_APPS, getParentAppId } from "../apps/apps-config";
import { DEFAULT_EMAIL_TEMPLATES, DEFAULT_EMAIL_THEMES, DEFAULT_EMAIL_THEME_ID } from "../helpers/emails";
import * as schemaFields from "../schema-fields";
import { productSchema, userSpecifiedIdSchema, yupBoolean, yupDate, yupMixed, yupNever, yupNumber, yupObject, yupRecord, yupString, yupTuple, yupUnion } from "../schema-fields";
import { SUPPORTED_CURRENCIES } from "../utils/currency-constants";
import { HexclaveAssertionError } from "../utils/errors";
import { allProviders, allProviderTypes } from "../utils/oauth";
import { DeepFilterUndefined, DeepMerge, DeepRequiredOrUndefined, filterUndefined, get, getOrUndefined, has, isObjectLike, mapValues, set, typedAssign, typedEntries, typedFromEntries } from "../utils/objects";
import { Result } from "../utils/results";
import { stringCompare } from "../utils/strings";
import { CollapseObjectUnion, Expand, IntersectAll, IsUnion, typeAssert, typeAssertExtends, typeAssertIs } from "../utils/types";
import { Config, NormalizationError, NormalizesTo, assertNormalized, getInvalidConfigReason, normalize } from "./format";
import { migrateCatalogsToProductLines } from "./migrate-catalogs-to-product-lines";

export const configLevels = ['project', 'branch', 'environment', 'organization'] as const;
export type ConfigLevel = typeof configLevels[number];
const permissionRegex = /^\$?[a-z0-9_:]+$/;
const customPermissionRegex = /^[a-z0-9_:]+$/;
const providerIdRegex = /^[a-z0-9_-]+$/;

declare module "yup" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  export interface CustomSchemaMetadata {
    hexclaveConfigCanNoLongerBeOverridden?: true,
  }
}

function canNoLongerBeOverridden<T extends yup.AnyObjectSchema, K extends string[]>(schema: T, keys: K): yup.Schema<Omit<yup.InferType<T>, K[number]>, T['__context'], Omit<T['__default'], K[number]>, T['__flags']> {
  const notOmitted = schema.concat(yupObject(
    Object.fromEntries(keys.map(key => [key, schema.getNested(key).meta({ hexclaveConfigCanNoLongerBeOverridden: true })]))
  ));
  return notOmitted as any;
}

/**
 * All fields that can be overridden at this level.
 */
export const projectConfigSchema = yupObject({
  sourceOfTruth: yupUnion(
    yupObject({
      type: yupString().oneOf(['hosted']).defined(),
    }),
  ),
  project: yupObject({
    requirePublishableClientKey: yupBoolean(),
  }),
});

// --- NEW RBAC Schema ---
const branchRbacDefaultPermissions = yupRecord(
  yupString().matches(permissionRegex),
  yupBoolean().isTrue().optional(),
);

const branchRbacSchema = yupObject({
  permissions: yupRecord(
    yupString().matches(customPermissionRegex),
    yupObject({
      description: yupString().optional(),
      scope: yupString().oneOf(['team', 'project']).optional(),
      containedPermissionIds: yupRecord(
        yupString().matches(permissionRegex),
        yupBoolean().isTrue().optional()
      ).optional(),
    }).optional(),
  ),
  defaultPermissions: yupObject({
    teamCreator: branchRbacDefaultPermissions,
    teamMember: branchRbacDefaultPermissions,
    signUp: branchRbacDefaultPermissions,
  }),
});
// --- END NEW RBAC Schema ---

// --- NEW API Keys Schema ---
const branchApiKeysSchema = yupObject({
  enabled: yupObject({
    team: yupBoolean(),
    user: yupBoolean(),
  }),
});
// --- END NEW API Keys Schema ---

// --- NEW Apps Schema ---
const appIds = Object.keys(ALL_APPS) as (keyof typeof ALL_APPS)[];
const branchAppsSchema = yupObject({
  installed: yupRecord(
    // Each app is configured independently, including apps with parentAppId.
    // Some dashboard versions interpret sub-apps through their parent, but the
    // backend must retain the individual value for clients with richer behavior.
    //
    // App config is also persisted independently of backend releases. Retain
    // app IDs introduced by newer releases so an older backend can still render
    // the config; getIncompleteConfigWarnings reports IDs it does not recognize.
    yupString(),
    yupObject({
      enabled: yupBoolean(),
    }),
  ),
});
// --- END NEW Apps Schema ---


const branchAuthSchema = yupObject({
  allowSignUp: yupBoolean(),
  password: yupObject({
    allowSignIn: yupBoolean(),
  }),
  otp: yupObject({
    allowSignIn: yupBoolean(),
  }),
  passkey: yupObject({
    allowSignIn: yupBoolean(),
  }),
  oauth: yupObject({
    accountMergeStrategy: yupString().oneOf(['link_method', 'raise_error', 'allow_duplicates']).optional(),
    providers: yupRecord(
      yupString().matches(permissionRegex),
      yupObject({
        type: yupString().oneOf(allProviderTypes).optional(),
        allowSignIn: yupBoolean(),
        allowConnectedAccounts: yupBoolean(),
      }),
    ),
  }),
  signUpRules: yupRecord(
    userSpecifiedIdSchema("signUpRuleId"),
    yupObject({
      enabled: yupBoolean(),
      displayName: yupString(),
      // Priority for rule ordering (higher number = higher priority, evaluated first)
      // Rules with same priority are sorted alphabetically by ID
      priority: yupNumber().integer().min(0),
      // CEL expression string - evaluated against signup context
      // Example: 'email.endsWith("@gmail.com") && authMethod == "password"'
      condition: yupString(),
      action: yupObject({
        type: yupString().oneOf(['allow', 'reject', 'restrict', 'log']).defined(),
        message: yupString().optional(), // for reject action custom message (internal use, not shown to user)
      }),
    }),
  ),
  signUpRulesDefaultAction: yupString().oneOf(['allow', 'reject']),
});

export const branchPaymentsSchema = yupObject({
  blockNewPurchases: yupBoolean(),
  autoPay: yupObject({
    interval: schemaFields.dayIntervalSchema,
  }).optional(),
  productLines: yupRecord(
    userSpecifiedIdSchema("productLineId"),
    yupObject({
      displayName: yupString().optional(),
      customerType: schemaFields.customerTypeSchema,
    }),
  ).meta({ openapiField: { description: 'The product lines that products can be in. All products in a product line (besides add-ons) are mutually exclusive.', exampleValue: { "product-line-id": { displayName: "My Product Line", customerType: "user" } } } }),
  products: yupRecord(
    userSpecifiedIdSchema("productId"),
    productSchema,
  ),
  items: yupRecord(
    userSpecifiedIdSchema("itemId"),
    yupObject({
      displayName: yupString().optional(),
      customerType: schemaFields.customerTypeSchema,
    }),
  ),
}).optional().test(
  'product-customer-type-matches-product-line',
  'Product customer type must match its product line customer type',
  function(this: yup.TestContext<yup.AnyObject>, value) {
    if (!value) return true;
    const products = value.products;
    if (!isObjectLike(products)) return true;

    const productLines = value.productLines;
    for (const [productId, product] of Object.entries(products)) {
      if (!isObjectLike(product)) continue;
      const productLineId = product.productLineId;
      if (typeof productLineId !== "string" || productLineId.length === 0) continue;
      const productLine = isObjectLike(productLines) ? getOrUndefined(productLines, productLineId) : undefined;
      if (productLine === undefined) {
        return this.createError({
          message: `Product "${productId}" specifies product line ID "${productLineId}", but that product line does not exist`,
          path: `${this.path}.products.${productId}.productLineId`,
        });
      }
      if (!isObjectLike(productLine)) continue;
      if (product.customerType !== productLine.customerType) {
        return this.createError({
          message: `Product "${productId}" has customer type "${product.customerType}" but its product line "${productLineId}" has customer type "${productLine.customerType}"`,
          path: `${this.path}.products.${productId}.customerType`,
        });
      }
    }
    return true;
  }
);
import.meta.vitest?.test("branchPaymentsSchema accepts partial payments config without products", async ({ expect }) => {
  await expect(branchPaymentsSchema.validate({
    blockNewPurchases: true,
  }, { abortEarly: false })).resolves.toMatchObject({
    blockNewPurchases: true,
  });
});

import.meta.vitest?.test("branchPaymentsSchema accepts product lines without products", async ({ expect }) => {
  await expect(branchPaymentsSchema.validate({
    productLines: {
      pro: {
        displayName: "Pro",
        customerType: "user",
      },
    },
  }, { abortEarly: false })).resolves.toMatchObject({
    productLines: {
      pro: {
        displayName: "Pro",
        customerType: "user",
      },
    },
  });
});

import.meta.vitest?.test("branchPaymentsSchema rejects a product that references a missing product line", async ({ expect }) => {
  await expect(branchPaymentsSchema.validate({
    products: {
      pro: {
        customerType: "user",
        productLineId: "missing-line",
        prices: {},
      },
    },
  }, { abortEarly: false })).rejects.toThrowErrorMatchingInlineSnapshot(`[ValidationError: Product "pro" specifies product line ID "missing-line", but that product line does not exist]`);
});

import.meta.vitest?.test("branchPaymentsSchema rejects null product entries without throwing a raw TypeError", async ({ expect }) => {
  await expect(branchPaymentsSchema.validate({
    products: {
      pro: null,
    },
  }, { abortEarly: false })).rejects.toThrowErrorMatchingInlineSnapshot(`[ValidationError: products cannot be null]`);
});

import.meta.vitest?.test("branchPaymentsSchema rejects null product line entries without throwing a raw TypeError", async ({ expect }) => {
  await expect(branchPaymentsSchema.validate({
    productLines: {
      teamLine: null,
    },
    products: {
      pro: {
        customerType: "user",
        productLineId: "teamLine",
        prices: {},
      },
    },
  }, { abortEarly: false })).rejects.toThrowErrorMatchingInlineSnapshot(`[ValidationError: productLines cannot be null]`);
});

import.meta.vitest?.test("branchPaymentsSchema rejects a product whose customer type differs from its product line", async ({ expect }) => {
  await expect(branchPaymentsSchema.validate({
    productLines: {
      teamLine: {
        customerType: "team",
      },
    },
    products: {
      pro: {
        customerType: "user",
        productLineId: "teamLine",
        prices: {},
      },
    },
  }, { abortEarly: false })).rejects.toThrowErrorMatchingInlineSnapshot(`[ValidationError: Product "pro" has customer type "user" but its product line "teamLine" has customer type "team"]`);
});

import.meta.vitest?.test("branchPaymentsSchema lets productLineId schema reject empty IDs", async ({ expect }) => {
  await expect(branchPaymentsSchema.validate({
    products: {
      pro: {
        customerType: "user",
        productLineId: "",
        prices: {},
      },
    },
  }, { abortEarly: false })).rejects.toThrowErrorMatchingInlineSnapshot(`[ValidationError: productLineId must contain only letters, numbers, underscores, and hyphens, and not start with a hyphen, and must not be one of __proto__, constructor, prototype]`);
});

const branchDomain = yupObject({});

const branchOnboardingSchema = yupObject({
  requireEmailVerification: yupBoolean(),
});

export const branchConfigSchema = canNoLongerBeOverridden(projectConfigSchema, [
  "sourceOfTruth",
  "project",
]).concat(yupObject({
  rbac: branchRbacSchema,

  teams: yupObject({
    createPersonalTeamOnSignUp: yupBoolean(),
    allowClientTeamCreation: yupBoolean(),
  }),

  users: yupObject({
    allowClientUserDeletion: yupBoolean(),
  }),

  onboarding: branchOnboardingSchema,

  apiKeys: branchApiKeysSchema,

  apps: branchAppsSchema,

  domains: branchDomain,

  auth: branchAuthSchema,

  emails: yupObject({
    selectedThemeId: schemaFields.emailThemeSchema,
    themes: schemaFields.emailThemeListSchema,
    templates: schemaFields.emailTemplateListSchema,
  }),

  payments: branchPaymentsSchema,

  dataVault: yupObject({
    stores: yupRecord(
      userSpecifiedIdSchema("storeId"),
      yupObject({
        displayName: yupString(),
      }),
    ),
  }),
}));


// --- Analytics Schema (environment config only - not pushable) ---
const environmentAnalyticsSchema = yupObject({
  queryFolders: yupRecord(
    userSpecifiedIdSchema("folderId"),
    yupObject({
      displayName: yupString(),
      sortOrder: yupNumber().optional(),
      queries: yupRecord(
        userSpecifiedIdSchema("queryId"),
        yupObject({
          displayName: yupString(),
          sqlQuery: yupString(),  // SQL query string (not English language)
          description: yupString().optional(),
        }),
      ),
    }),
  ),
});
// --- END Analytics Schema ---

export const environmentConfigSchema = branchConfigSchema.concat(yupObject({
  auth: branchConfigSchema.getNested("auth").concat(yupObject({
    oauth: branchConfigSchema.getNested("auth").getNested("oauth").concat(yupObject({
      providers: yupRecord(
        yupString().matches(providerIdRegex),
        yupObject({
          type: yupString().oneOf(allProviderTypes).optional(),
          isShared: yupBoolean(),
          clientId: schemaFields.oauthClientIdSchema.optional(),
          clientSecret: schemaFields.oauthClientSecretSchema.optional(),
          customCallbackUrl: schemaFields.oauthCustomCallbackUrlSchema.optional().when('isShared', {
            is: true,
            then: (schema) => schema.oneOf([undefined], 'customCallbackUrl cannot be set for shared OAuth providers'),
            otherwise: (schema) => schema,
          }),
          facebookConfigId: schemaFields.oauthFacebookConfigIdSchema.optional(),
          microsoftTenantId: schemaFields.oauthMicrosoftTenantIdSchema.optional(),
          appleTeamId: schemaFields.oauthAppleTeamIdSchema.optional(),
          appleKeyId: schemaFields.oauthAppleKeyIdSchema.optional(),
          applePrivateKey: schemaFields.oauthApplePrivateKeySchema.optional(),
          appleBundles: yupRecord(
            userSpecifiedIdSchema("appleBundleId"),
            yupObject({
              bundleId: schemaFields.oauthAppleBundleIdSchema,
            }),
          ).optional(),
          // Custom OIDC provider fields (only used when type is "custom_oidc")
          issuerUrl: schemaFields.oauthIssuerUrlSchema.optional(),
          scope: schemaFields.oauthScopeSchema.optional(),
          displayName: yupString().optional(),
          allowSignIn: yupBoolean().optional(),
          allowConnectedAccounts: yupBoolean().optional(),
        }).test(
          "apple-key-credentials",
          "Apple providers must specify clientSecret or all of appleTeamId, appleKeyId, and applePrivateKey",
          (provider) => {
            if (provider.isShared || provider.type !== "apple") return true;
            const hasClientSecret = provider.clientSecret != null && provider.clientSecret !== "";
            const keyFields = [provider.appleTeamId, provider.appleKeyId, provider.applePrivateKey];
            const hasAnyKeyField = keyFields.some(field => field != null && field !== "");
            const hasAllKeyFields = keyFields.every(field => field != null && field !== "");
            return (hasClientSecret || hasAllKeyFields) && (!hasAnyKeyField || hasAllKeyFields);
          },
        ),
      ),
    })),
  })),

  emails: branchConfigSchema.getNested("emails").concat(yupObject({
    server: yupObject({
      isShared: yupBoolean(),
      provider: yupString().oneOf(['resend', 'smtp', 'managed']).optional(),
      host: schemaFields.emailHostSchema.optional().nonEmpty(),
      port: schemaFields.emailPortSchema.optional(),
      username: schemaFields.emailUsernameSchema.optional().nonEmpty(),
      password: schemaFields.emailPasswordSchema.optional().nonEmpty().when(['provider', 'isShared'], {
        is: (provider: string | undefined, isShared: boolean) => provider === 'managed' && isShared === false,
        then: (schema) => schema.defined("Password is required when using managed email provider"),
        otherwise: (schema) => schema.optional(),
      }),
      senderName: schemaFields.emailSenderNameSchema.optional().nonEmpty(),
      senderEmail: schemaFields.emailSenderEmailSchema.optional().nonEmpty(),
      managedSubdomain: yupString().optional().nonEmpty().when(['provider', 'isShared'], {
        is: (provider: string | undefined, isShared: boolean) => provider === 'managed' && isShared === false,
        then: (schema) => schema.defined("Managed subdomain is required when using managed email provider"),
        otherwise: (schema) => schema.optional(),
      }),
      managedSenderLocalPart: yupString().optional().nonEmpty().when(['provider', 'isShared'], {
        is: (provider: string | undefined, isShared: boolean) => provider === 'managed' && isShared === false,
        then: (schema) => schema.defined("Managed sender local part is required when using managed email provider"),
        otherwise: (schema) => schema.optional(),
      }),
    }),
  })),

  domains: branchConfigSchema.getNested("domains").concat(yupObject({
    allowLocalhost: yupBoolean(),
    trustedDomains: yupRecord(
      userSpecifiedIdSchema("trustedDomainId"),
      yupObject({
        baseUrl: schemaFields.wildcardUrlSchema.max(300),  // TODO: replace with wildcardProtocolAndDomainSchema (this will require a migration as some configs have domains that are not valid wildcard protocol and domain patterns)
        handlerPath: schemaFields.handlerPathSchema.max(300),
      }),
    ),
  })),

  payments: branchConfigSchema.getNested("payments").concat(yupObject({
    testMode: yupBoolean(),
  })),

  dbSync: yupObject({
    externalDatabases: yupRecord(
      userSpecifiedIdSchema("externalDatabaseId"),
      yupObject({
        type: yupString().oneOf(["postgres"]).defined(),
        connectionString: yupString().when("type", {
          is: "postgres",
          then: (schema) => schema.defined(),
          otherwise: (schema) => schema.optional(),
        }),
      }),
    ),
  }),

  analytics: environmentAnalyticsSchema,
  customDashboards: schemaFields.customDashboardsSchema,
}));

export const organizationConfigSchema = environmentConfigSchema.concat(yupObject({}));

import.meta.vitest?.test("Apple OAuth key credentials are all-or-nothing", async ({ expect }) => {
  const config = {
    auth: {
      oauth: {
        providers: {
          apple: { type: "apple", isShared: false, clientId: "com.example.web" },
        },
      },
    },
  };
  await expect(environmentConfigSchema.validate(config)).rejects.toThrow("Apple providers must specify");
  await expect(environmentConfigSchema.validate({
    ...config,
    auth: { oauth: { providers: { apple: { ...config.auth.oauth.providers.apple, appleTeamId: "TEAM" } } } },
  })).rejects.toThrow("Apple providers must specify");
  await expect(environmentConfigSchema.validate({
    ...config,
    auth: { oauth: { providers: { apple: { ...config.auth.oauth.providers.apple, appleTeamId: "TEAM", appleKeyId: "KEY", applePrivateKey: "PEM" } } } },
  })).resolves.toBeDefined();
  await expect(environmentConfigSchema.validate({
    auth: { oauth: { providers: { apple: { type: "apple", isShared: true } } } },
  })).resolves.toBeDefined();
});


// Migration functions
//
// These are used to migrate old config overrides to the new format on the database.
//
// THEY SHOULD NOT BE USED FOR ANY OTHER PURPOSE. They should not be used for default values. They should not be used
// for sanitization. Instead, use the applicable functions for that.
//
// We run these migrations over the database when we do a big migration. USE THESE SPARINGLY. USE OTHER METHODS WHENEVER
// POSSIBLE.
//
// The result of this function should be reproducible, and should not contain ANY randomness/non-determinism.
export function migrateConfigOverride(type: "project" | "branch" | "environment" | "organization", oldUnmigratedConfigOverride: any): any {
  const isBranchOrHigher = ["branch", "environment", "organization"].includes(type);
  const isEnvironmentOrHigher = ["environment", "organization"].includes(type);

  let res = oldUnmigratedConfigOverride;

  // BEGIN 2025-07-28: emails.theme is now emails.selectedThemeId
  if (isBranchOrHigher) {
    res = renameProperty(res, "emails.theme", "selectedThemeId");
  }
  // END

  // BEGIN 2025-07-28: domains.trustedDomains can no longer be an array
  if (isEnvironmentOrHigher) {
    res = mapProperty(res, p => p.join(".") === "domains.trustedDomains", (value) => {
      if (Array.isArray(value)) {
        return typedFromEntries(value.map((v, i) => [`${i}`, v]));
      }
      return value;
    });
  }
  // END

  // BEGIN 2025-07-28: themeList and templateList have been renamed (this was before the email release, so they're safe to remove)
  if (isBranchOrHigher) {
    res = removeProperty(res, p => p.join(".") === "emails.themeList");
    res = removeProperty(res, p => p.join(".") === "emails.templateList");
  }
  // END

  // BEGIN 2025-07-28: sourceOfTruth was mistakenly written to the environment config in some cases, so let's remove it
  if (isBranchOrHigher) {
    res = removeProperty(res, p => p.join(".") === "sourceOfTruth");
  }
  // END

  // BEGIN 2025-08-25: stripeAccountId and stripeAccountSetupComplete are unused, so let's remove them
  if (isBranchOrHigher) {
    res = removeProperty(res, p => p.join(".") === "payments.stripeAccountId");
    res = removeProperty(res, p => p.join(".") === "payments.stripeAccountSetupComplete");
  }
  // END

  // BEGIN 2025-08-25: payments.items.default is no longer used, so let's remove it
  if (isBranchOrHigher) {
    res = removeProperty(res, p => p.length === 4 && p[0] === "payments" && p[1] === "items" && p[3] === "default");
  }
  // END

  // BEGIN 2025-09-23: payments.offers is now payments.products
  if (isBranchOrHigher) {
    res = renameProperty(res, "payments.offers", "products");
  }
  // END

  // BEGIN 2025-09-23: payments.groups is now payments.catalogs
  if (isBranchOrHigher) {
    res = renameProperty(res, "payments.groups", "catalogs");
  }
  // END

  // BEGIN 2025-09-23: payments.products.*.groupId is now payments.products.*.catalogId
  if (isBranchOrHigher) {
    res = renameProperty(res, (p) => p.length === 4 && p[0] === "payments" && p[1] === "products" && p[3] === "groupId", (p) => "catalogId");
  }
  // END

  // BEGIN 2025-10-29: Removed workflows and everything associated with it
  if (isBranchOrHigher) {
    res = removeProperty(res, p => p[0] === "workflows");
    res = removeProperty(res, p => p[0] === "apps" && p[1] === "installed" && p[2] === "workflows");
  }
  // END

  // BEGIN 2026-01-14: payments.catalogs is now payments.productLines (with customerType inferred from products) and payments.products.*.catalogId is now payments.products.*.productLineId
  if (isBranchOrHigher) {
    res = migrateCatalogsToProductLines(res);
  }
  // END

  // BEGIN 2026-04-21: `include-by-default` product prices are no longer supported. Rewrite to an empty price map so legacy configs continue to load.
  if (isBranchOrHigher) {
    // Match `payments.products.<productId>.prices` regardless of how many segments the
    // product-ID portion contributes. mapProperty splits dot-notation override keys on
    // ".", so a product whose ID itself contains "." (e.g. "my.product") would produce
    // a path with >4 segments and silently miss an exact-length match.
    res = mapProperty(res, p => p.length >= 4 && p[0] === "payments" && p[1] === "products" && p[p.length - 1] === "prices", (value) => {
      if (value === "include-by-default") return {};
      return value;
    });
  }
  // END

  // BEGIN 2026-05-23: external source-of-truth config was never used and is no longer supported.
  // Drop the override so legacy Neon/Postgres configs continue to render as the hosted default.
  if (type === "project") {
    res = removeProperty(res, p => p[0] === "sourceOfTruth");
  }
  // END

  // BEGIN 2026-07-01: dbSync.externalDatabases contains environment-specific connection strings.
  // It should never be rendered from branch config, which can be read by branch-scoped tools.
  if (type === "branch") {
    res = removeProperty(res, p => p[0] === "dbSync");
  }
  // END

  // BEGIN 2026-07-24: the deployments app is now `deployments-alpha`, both as its
  // `apps.installed` key and as its top-level config section, so the alpha stage is
  // visible in every hexclave.config.ts that opts into it. Both renames are needed:
  // an installed entry without the config section (or vice versa) is a valid state.
  if (isBranchOrHigher) {
    res = renameProperty(res, "deployments", "deployments-alpha");
    res = renameProperty(res, "apps.installed.deployments", "deployments-alpha");
  }
  // END

  // BEGIN 2026-07-28: deployment service definitions moved out of the config
  // entirely — they now come from the `deploy` export and are stored in the
  // backend database, synced by `hexclave deploy`. The
  // stored config section is dropped, which in particular removes every
  // config-era service: they were all `type: "vercel"`, a service type that no
  // longer exists (containers on Marshal replaced it). The
  // `apps.installed.deployments-alpha` entry stays for the later app-key
  // migration — the app itself still exists. This runs after the 2026-07-24
  // rename above, so pre-rename `deployments` sections are covered too.
  if (isBranchOrHigher) {
    res = removeProperty(res, p => p[0] === "deployments-alpha");
  }
  // END

  // BEGIN 2026-08-14: the Deploy app's author-facing config key is now `deploy`.
  // Only the installed-app entry remains in current configs; the legacy top-level
  // deployment service section was removed by the migration immediately above.
  if (isBranchOrHigher) {
    res = renameProperty(res, "apps.installed.deployments-alpha", "deploy");
  }
  // END

  // BEGIN 2026-08-31: the Growth app was removed.
  if (isBranchOrHigher) {
    res = removeProperty(res, p => p[0] === "apps" && p[1] === "installed" && p[2] === "gtm");
  }
  // END

  // return the result
  return res;
};

import.meta.vitest?.test("migrateConfigOverride removes legacy sourceOfTruth overrides", ({ expect }) => {
  expect(migrateConfigOverride("project", {
    sourceOfTruth: {
      type: "neon",
      connectionStrings: {
        main: "postgres://user:password@neon.example.com/database",
      },
    },
  })).toEqual({});

  expect(migrateConfigOverride("project", {
    "sourceOfTruth.type": "postgres",
    "sourceOfTruth.connectionString": "postgres://user:password@host:5432/database",
  })).toEqual({});
});

import.meta.vitest?.test("migrateConfigOverride removes legacy deployments config sections", ({ expect }) => {
  // Post-rename section name, as an object and as dot-notation override keys.
  // Every config-era service was `type: "vercel"` — a type that no longer
  // exists — so this doubles as the guarantee that no vercel service survives
  // migration.
  expect(migrateConfigOverride("branch", {
    "deployments-alpha": { services: { web: { type: "vercel" } } },
  })).toEqual({});
  expect(migrateConfigOverride("branch", {
    "deployments-alpha.services.web.type": "vercel",
    "deployments-alpha.services.web.env": { A: { value: "x" } },
  })).toEqual({});
  // Multiple vercel services, with the full vercel-era field set.
  expect(migrateConfigOverride("branch", {
    "deployments-alpha": {
      services: {
        web: { type: "vercel", framework: "nextjs", buildCommand: "pnpm build", outputDirectory: "dist" },
        api: { type: "vercel", rootDirectory: "./api" },
      },
    },
  })).toEqual({});
  // Pre-rename name: the 2026-07-24 rename runs first, then the removal.
  expect(migrateConfigOverride("branch", {
    deployments: { services: { web: { type: "vercel" } } },
  })).toEqual({});
  // The app-installation entry must survive and receive its current name — only
  // the legacy service config section is gone.
  expect(migrateConfigOverride("branch", {
    "apps.installed.deployments-alpha": { enabled: true },
    "deployments-alpha": { services: {} },
  })).toEqual({ "apps.installed.deploy": { enabled: true } });
});

import.meta.vitest?.test("migrateConfigOverride removes legacy branch-level dbSync overrides", ({ expect }) => {
  const dbSync = {
    externalDatabases: {
      main: {
        type: "postgres",
        connectionString: "postgres://user:password@host:5432/database",
      },
    },
  };

  expect(migrateConfigOverride("branch", { dbSync })).toEqual({});
  expect(migrateConfigOverride("environment", { dbSync })).toEqual({ dbSync });
});

import.meta.vitest?.test("migrateConfigOverride renames legacy deployments app keys to deploy", ({ expect }) => {
  const services = { web: { type: "vercel", rootDirectory: "./" } };

  // The renamed CONFIG SECTION is subsequently dropped by the 2026-07-28
  // removal migration (service definitions no longer live in the config), so
  // only the installed-apps rename remains observable here.
  expect(migrateConfigOverride("branch", {
    deployments: { services },
    apps: { installed: { deployments: { enabled: true } } },
  })).toEqual({
    apps: { installed: { deploy: { enabled: true } } },
  });

  // Dot-notation overrides, which is how the dashboard used to write single
  // keys. The flat key form is preserved — only the renamed segment changes —
  // so the override keeps overriding exactly one leaf rather than being
  // widened into a whole subtree.
  expect(migrateConfigOverride("branch", {
    "deployments.services.web.buildCommand": "pnpm build",
    "apps.installed.deployments.enabled": true,
  })).toEqual({
    "apps.installed.deploy.enabled": true,
  });

  // Project level is not branch-or-higher, so nothing is renamed there.
  expect(migrateConfigOverride("project", { deployments: { services } })).toEqual({ deployments: { services } });
});

import.meta.vitest?.test("migrateConfigOverride renames deployments-alpha app installations to deploy", ({ expect }) => {
  expect(migrateConfigOverride("branch", {
    apps: { installed: { "deployments-alpha": { enabled: true } } },
  })).toEqual({
    apps: { installed: { deploy: { enabled: true } } },
  });
  expect(migrateConfigOverride("branch", {
    "apps.installed.deployments-alpha.enabled": true,
  })).toEqual({
    "apps.installed.deploy.enabled": true,
  });
  expect(migrateConfigOverride("branch", {
    "apps.installed.deploy.enabled": false,
  })).toEqual({
    "apps.installed.deploy.enabled": false,
  });
});

import.meta.vitest?.test("migrateConfigOverride removes Growth app installations", ({ expect }) => {
  expect(migrateConfigOverride("branch", {
    apps: {
      installed: {
        gtm: { enabled: true },
        analytics: { enabled: true },
      },
    },
  })).toEqual({
    apps: {
      installed: {
        analytics: { enabled: true },
      },
    },
  });
  expect(migrateConfigOverride("branch", {
    "apps.installed.gtm.enabled": true,
    "apps.installed.analytics.enabled": true,
  })).toEqual({
    "apps.installed.analytics.enabled": true,
  });
  expect(migrateConfigOverride("project", {
    "apps.installed.gtm.enabled": true,
  })).toEqual({
    "apps.installed.gtm.enabled": true,
  });
});

function removeProperty(obj: Record<string, any>, pathCond: (path: (string | symbol)[]) => boolean): any {
  return mapProperty(obj, pathCond, () => undefined);
}

function mapProperty(obj: Record<string, any>, pathCond: (path: string[]) => boolean, mapper: (value: any) => any): any {
  const res: Record<string, any> = Array.isArray(obj) ? [] : {};
  for (const [key, value] of typedEntries(obj)) {
    const path = key.split(".");
    if (pathCond(path)) {
      const newValue = mapper(value);
      if (newValue !== undefined) {
        set(res, key, newValue);
      } else {
        // do nothing
      }
    } else if (isObjectLike(value)) {
      set(res, key, mapProperty(value, p => pathCond([...path, ...p]), mapper));
    } else {
      set(res, key, value);
    }
  }
  return res;
}
import.meta.vitest?.test("mapProperty - basic property mapping", ({ expect }) => {
  expect(mapProperty({ a: { b: { c: 1 } } }, p => p.join(".") === "a.b.c", (value) => value + 1)).toEqual({ a: { b: { c: 2 } } });
  expect(mapProperty({ a: { b: { c: 1 } } }, p => p.join(".") === "a.b.d", (value) => value + 1)).toEqual({ a: { b: { c: 1 } } });
  expect(mapProperty({ x: 5 }, p => p.join(".") === "x", (value) => value * 2)).toEqual({ x: 10 });
  expect(mapProperty({ a: { b: { c: 1 } } }, p => p.join(".") === "b.c", (value) => value * 10)).toEqual({ a: { b: { c: 1 } } });
  expect(mapProperty({ a: 1 }, p => p.join(".") === "b.c", (value) => value)).toEqual({ a: 1 });
  expect(mapProperty({ "a.b": { c: 1 } }, p => p.join(".") === "a.b.c", (value) => value + 1)).toEqual({ "a.b": { c: 2 } });

  expect(mapProperty({ a: { b: { c: 1 } } }, p => p.length === 3 && p[0] === "a" && p[1] === "b", (value) => value + 1)).toEqual({ a: { b: { c: 2 } } });

  // The include-by-default migration uses a prefix/suffix path predicate against dot-notation
  // keys: `payments.products.<productId>.prices`, where the product-ID portion may be one or
  // more segments (since override keys are dot-paths and a product ID may itself contain ".").
  // Verify it matches whether the override is fully nested, dot-notation at the root, a mix,
  // or contains a dotted product ID.
  const sentinelToEmpty = (v: any) => v === "include-by-default" ? {} : v;
  const sentinelPred = (p: string[]) => p.length >= 4 && p[0] === "payments" && p[1] === "products" && p[p.length - 1] === "prices";
  expect(mapProperty({ "payments.products.x.prices": "include-by-default" }, sentinelPred, sentinelToEmpty))
    .toEqual({ "payments.products.x.prices": {} });
  expect(mapProperty({ payments: { products: { x: { prices: "include-by-default" } } } }, sentinelPred, sentinelToEmpty))
    .toEqual({ payments: { products: { x: { prices: {} } } } });
  expect(mapProperty({ "payments.products": { x: { prices: "include-by-default" } } }, sentinelPred, sentinelToEmpty))
    .toEqual({ "payments.products": { x: { prices: {} } } });
  // Dotted product ID: "my.product" expands to two path segments, total 5.
  expect(mapProperty({ "payments.products.my.product.prices": "include-by-default" }, sentinelPred, sentinelToEmpty))
    .toEqual({ "payments.products.my.product.prices": {} });
});

function renameProperty(obj: Record<string, any>, oldPath: string | ((path: string[]) => boolean), newName: string | ((path: string[]) => string)): any {
  const pathCond = typeof oldPath === "function" ? oldPath : (p: string[]) => p.join(".") === oldPath;
  const pathMapper = typeof newName === "function" ? newName : (p: string[]) => (newName as string);

  const res: Record<string, any> = Array.isArray(obj) ? [] : {};
  for (const [key, originalValue] of typedEntries(obj)) {
    const path = key.split(".");

    for (let i = 0; i < path.length; i++) {
      const pathPrefix = path.slice(0, i + 1);
      if (pathCond(pathPrefix)) {
        const name = pathMapper(pathPrefix);
        if (name.includes(".")) throw new HexclaveAssertionError(`newName must not contain a dot. Provided: ${name}`);
        path[i] = name;
      }
    }

    const value = isObjectLike(originalValue) ? renameProperty(originalValue, p => pathCond([...path, ...p]), p => pathMapper([...path, ...p])) : originalValue;
    set(res, path.join("."), value);
  }

  return res;
}
import.meta.vitest?.test("renameProperty", ({ expect }) => {
  // Basic
  expect(renameProperty({ a: 1 }, "a", "b")).toEqual({ b: 1 });
  expect(renameProperty({ b: { c: 1 } }, "b.c", "d")).toEqual({ b: { d: 1 } });
  expect(renameProperty({ a: { b: { c: 1 } } }, "a.b.c", "d")).toEqual({ a: { b: { d: 1 } } });
  expect(renameProperty({ a: { b: { c: 1 } } }, "a.b.c.d", "e")).toEqual({ a: { b: { c: 1 } } });
  expect(renameProperty({ a: { b: { c: 1 }, "b.c": 2 } }, "b.c", "d")).toEqual({ a: { b: { c: 1 }, "b.c": 2 } });
  expect(renameProperty({ a: { "b.c.d": 2 } }, "a.b.c", "e")).toEqual({ a: { "b.e.d": 2 } });
  expect(renameProperty({ a: { b: { c: 1 }, "b.c": 2 } }, "a.b.c", "d")).toEqual({ a: { b: { d: 1 }, "b.d": 2 } });
  expect(renameProperty({ a: { b: { c: 1, d: 2 } } }, "a.b.c", "d")).toEqual({ a: { b: { d: 2 } } });
  expect(renameProperty({ a: { b: { d: 2, c: 1 } } }, "a.b.c", "d")).toEqual({ a: { b: { d: 1 } } });

  // Functions
  expect(renameProperty({ a: 1 }, (p) => p.length === 1 && p[0] === "a", (p) => "b")).toEqual({ b: 1 });
  expect(renameProperty({ a: { b: { c: 1 } } }, (p) => p.length === 3 && p[0] === "a" && p[1] === "b" && p[2] === "c", (p) => "d")).toEqual({ a: { b: { d: 1 } } });
  expect(renameProperty({ a: { b: { c: 1 } } }, (p) => false, (p) => "e")).toEqual({ a: { b: { c: 1 } } });
  expect(renameProperty({ a: { b: { a: 1 } } }, (p) => p[p.length - 1] === "a", (p) => "c")).toEqual({ c: { b: { c: 1 } } });

  // Errors
  expect(() => renameProperty({ a: 1 }, "a", "b.c")).toThrow();
});


// Defaults
// these are objects that are merged together to form the rendered config (see ./README.md)
// Wherever an object could be used as a value, a function can instead be used to generate the default values on a per-key basis
// To make sure you don't accidentally forget setting a default value, you must explicitly set fields with no default value to `undefined`.
// NOTE: These values are the defaults of the schema, NOT the defaults for newly created projects. The values here signify what `null` means for each property. If you want new projects by default to have a certain value set to true, you should update the corresponding function in the backend instead.
const projectConfigDefaults = {
  sourceOfTruth: {
    type: 'hosted',
  },
  project: {
    requirePublishableClientKey: false,
  },
} as const satisfies DefaultsType<ProjectRenderedConfigBeforeDefaults, []>;

const branchConfigDefaults = {} as const satisfies DefaultsType<BranchRenderedConfigBeforeDefaults, [typeof projectConfigDefaults]>;

const environmentConfigDefaults = {} as const satisfies DefaultsType<EnvironmentRenderedConfigBeforeDefaults, [typeof branchConfigDefaults, typeof projectConfigDefaults]>;

const organizationConfigDefaults = {
  rbac: {
    permissions: (key: string) => ({
      containedPermissionIds: (key: string) => undefined,
      description: undefined,
      scope: undefined,
    }),
    defaultPermissions: {
      teamCreator: (key: string) => undefined,
      teamMember: (key: string) => undefined,
      signUp: (key: string) => undefined,
    },
  },

  apiKeys: {
    enabled: {
      team: false,
      user: false,
    },
  },

  apps: {
    installed: Object.assign(
      (appId: string) => has(ALL_APPS, appId) ? { enabled: false } : undefined,
      typedFromEntries(appIds.map(appId => [appId, { enabled: false }])),
    ),
  },

  teams: {
    createPersonalTeamOnSignUp: false,
    allowClientTeamCreation: false,
  },

  users: {
    allowClientUserDeletion: false,
  },

  onboarding: {
    requireEmailVerification: false,
  },

  domains: {
    allowLocalhost: false,
    trustedDomains: (key: string) => ({
      baseUrl: undefined,
      handlerPath: '/handler',
    }) as const,
  },

  auth: {
    allowSignUp: true,
    password: {
      allowSignIn: false,
    },
    otp: {
      allowSignIn: false,
    },
    passkey: {
      allowSignIn: false,
    },
    oauth: {
      accountMergeStrategy: 'link_method',
      providers: (key: string) => ({
        type: undefined,
        isShared: true,
        allowSignIn: false,
        allowConnectedAccounts: false,
        clientId: undefined,
        clientSecret: undefined,
        appleTeamId: undefined,
        appleKeyId: undefined,
        applePrivateKey: undefined,
        customCallbackUrl: undefined,
        facebookConfigId: undefined,
        microsoftTenantId: undefined,
        appleBundles: undefined,
      }),
    },
    signUpRules: (key: string) => ({
      enabled: false,
      displayName: undefined,
      priority: 0,
      condition: undefined,
      action: {
        type: 'allow',
        message: undefined,
      },
    }),
    signUpRulesDefaultAction: 'allow',
  },

  emails: {
    server: {
      isShared: true,
      provider: "smtp",
      host: undefined,
      port: undefined,
      username: undefined,
      password: undefined,
      senderName: undefined,
      senderEmail: undefined,
      managedSubdomain: undefined,
      managedSenderLocalPart: undefined,
    },
    selectedThemeId: DEFAULT_EMAIL_THEME_ID,
    themes: typedAssign((key: string) => ({
      displayName: "Unnamed Theme",
      tsxSource: "Error: Theme config is missing TypeScript source code.",
    }), DEFAULT_EMAIL_THEMES),
    templates: typedAssign((key: string) => ({
      displayName: "Unnamed Template",
      tsxSource: "Error: Template config is missing TypeScript source code.",
      themeId: undefined,
    }), DEFAULT_EMAIL_TEMPLATES),
  },

  payments: {
    blockNewPurchases: false,
    testMode: true,
    autoPay: undefined,
    productLines: (key: string) => ({
      displayName: undefined,
      customerType: undefined,
    }),
    products: (key: string) => ({
      displayName: key,
      productLineId: undefined,
      customerType: "user",
      freeTrial: undefined,
      serverOnly: false,
      stackable: undefined,
      isAddOnTo: false,
      prices: (key: string) => ({
        ...typedFromEntries(SUPPORTED_CURRENCIES.map(currency => [currency.code, undefined])),
        interval: undefined,
        serverOnly: false,
        freeTrial: undefined,
      }),
      includedItems: (key: string) => ({
        quantity: 0,
        repeat: "never",
        expires: "when-repeated",
      }),
    } as const),
    items: (key: string) => ({
      displayName: key,
      customerType: "user",
    } as const)
  },


  dbSync: {
    externalDatabases: (key: string) => ({
      type: undefined,
      connectionString: undefined,
    }),
  },

  dataVault: {
    stores: (key: string) => ({
      displayName: "Unnamed Vault",
    }),
  },

  analytics: {
    queryFolders: (key: string) => ({
      displayName: "Unnamed Folder",
      sortOrder: 0,
      queries: (queryKey: string) => ({
        displayName: "Unnamed Query",
        sqlQuery: "",
        description: undefined,
      }),
    }),
  },

  customDashboards: (key: string) => ({
    displayName: "Unnamed Dashboard",
    tsxSource: "Error: Dashboard config is missing source code.",
  }),
} as const satisfies DefaultsType<OrganizationRenderedConfigBeforeDefaults, [typeof environmentConfigDefaults, typeof branchConfigDefaults, typeof projectConfigDefaults]>;

type _DeepOmitDefaultsImpl<T, U> = T extends object ? (
  (
    & /* keys that are both in T and U, *and* the key's value in U is not a subtype of the key's value in T */ { [K in { [Ki in keyof T & keyof U]: U[Ki] extends T[Ki] ? never : Ki }[keyof T & keyof U]]: DeepOmitDefaults<T[K], U[K] & object> }
    & /* keys that are in T but not in U */ { [K in Exclude<keyof T, keyof U>]: T[K] }
  )
) : T;
type DeepOmitDefaults<T, U> = _DeepOmitDefaultsImpl<DeepFilterUndefined<T>, U>;
type DefaultsType<T, U extends any[]> = DeepReplaceAllowFunctionsForObjects<DeepOmitDefaults<DeepRequiredOrUndefined<T>, IntersectAll<{ [K in keyof U]: DeepReplaceFunctionsWithObjects<U[K]> }>>>;
typeAssertIs<DefaultsType<{ a: { b: Record<string, 123>, c: 456 } }, [{ a: { c: 456 } }]>, { a: { b: ((key: string) => 123) | Record<string, 123 | undefined> & ((key: string) => 123) } }>()();

type DeepReplaceAllowFunctionsForObjects<T> = T extends object
  ? (
    string extends keyof T
    ? ((arg: Exclude<keyof T, number>) => DeepReplaceAllowFunctionsForObjects<T[keyof T]>) & ({ [K in keyof T]?: DeepReplaceAllowFunctionsForObjects<T[K]> } | {})
    : { [K in keyof T]: DeepReplaceAllowFunctionsForObjects<T[K]> }
  )
  :
  T;
type ReplaceFunctionsWithObjects<T> = T extends (arg: infer K extends string) => infer R
  ? T & Record<K, R> & object
  : T;
type DeepReplaceFunctionsWithObjects<T> = T extends object ? { [K in keyof ReplaceFunctionsWithObjects<T>]: DeepReplaceFunctionsWithObjects<ReplaceFunctionsWithObjects<T>[K]> } : T;
typeAssertIs<DeepReplaceFunctionsWithObjects<{ a: { b: 123 } & ((key: string) => number) }>, { a: { b: 123, [key: string]: number } }>()();

function deepReplaceFunctionsWithObjects(obj: any, paths: string[] = []): any {
  const subPaths = (key: string) => {
    return paths.filter(p => p.split(".").length > 1 && p.split(".")[0] === key)
      .map(p => p.split(".").slice(1).join("."));
  };
  const currentPaths = [...new Set(paths.map(p => p.split(".")[0]))];
  const nonDeepReplaced = {
    ...typeof obj === "function" ? filterUndefined(Object.fromEntries(currentPaths.map(k => [k, obj(k)]))) : undefined,
    ...obj,
  };
  return mapValues(nonDeepReplaced, (v, k) => (isObjectLike(v) ? deepReplaceFunctionsWithObjects(v as any, subPaths(k as string)) : v));
}
import.meta.vitest?.test("deepReplaceFunctionsWithObjects", ({ expect }) => {
  expect(deepReplaceFunctionsWithObjects(() => { })).toEqual({});
  expect(deepReplaceFunctionsWithObjects({ a: 3 })).toEqual({ a: 3 });
  expect(deepReplaceFunctionsWithObjects({ a: () => ({ b: 1 }) })).toEqual({ a: {} });
  expect(deepReplaceFunctionsWithObjects({ a: () => ({ b: 1 }) }, ["a.c.d"])).toEqual({ a: { c: { b: 1 } } });
  expect(deepReplaceFunctionsWithObjects(() => ({ b: 1 }), ["a"])).toEqual({ a: { b: 1 } });
  expect(deepReplaceFunctionsWithObjects({ a: typedAssign(() => ({}), { b: { c: 1 } }) })).toEqual({ a: { b: { c: 1 } } });
});

type ConfigDefaultFactory = (key: string) => object;
type ApplyDefaults<D extends object | ConfigDefaultFactory, C extends object> = {} extends D ? C : DeepMerge<DeepReplaceFunctionsWithObjects<D>, C>;  // the {} extends D makes TypeScript not recurse if the defaults are empty, hence allowing us more recursion until "type instantiation too deep" kicks in... it's a total hack, but it works, so hey?
function applyDefaults<D extends object | ConfigDefaultFactory, C extends object>(defaults: D, config: C): ApplyDefaults<D, C> {
  const res: any = deepReplaceFunctionsWithObjects(defaults);

  outer: for (const [key, mergeValue] of Object.entries(config)) {
    if (!isObjectLike(mergeValue) && mergeValue !== null) {
      set(res, key, mergeValue);
    } else {
      const keyParts = key.split(".");
      let baseValue: any = defaults;
      let lastWasFunction = false;
      for (const [index, part] of keyParts.entries()) {
        if (!isObjectLike(baseValue)) {
          set(res, key, mergeValue ?? null);
          continue outer;
        }
        lastWasFunction = false;
        baseValue = has(baseValue, part) ? get(baseValue, part) : (typeof baseValue === 'function' ? (lastWasFunction = true, baseValue as any)(part) : undefined);
      }
      if (lastWasFunction && mergeValue == null) {
        set(res, key, null);
      } else if (!isObjectLike(baseValue)) {
        set(res, key, mergeValue ?? baseValue ?? null);
      } else {
        set(res, key, applyDefaults(baseValue, mergeValue ?? {}) as any);
      }
    }
  }
  return res as any;
}
import.meta.vitest?.test("applyDefaults", ({ expect }) => {
  // Basic
  expect(applyDefaults({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  expect(applyDefaults({ a: 1 }, { a: null })).toEqual({ a: 1 });
  expect(applyDefaults({}, { a: 1 })).toEqual({ a: 1 });
  expect(applyDefaults({ a: { b: 1 } }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
  expect(applyDefaults({ a: { b: 1 } }, { a: { c: 2 } })).toEqual({ a: { b: 1, c: 2 } });
  expect(applyDefaults({ a: { b: { c: 1, d: 2 } } }, { a: { b: { d: 3, e: 4 } } })).toEqual({ a: { b: { c: 1, d: 3, e: 4 } } });

  // Functions
  expect(applyDefaults((key: string) => ({ b: key }), { a: {} })).toEqual({ a: { b: "a" } });
  expect(applyDefaults((key: string) => ({ b: key }), { a: null })).toEqual({ a: null });
  expect(applyDefaults((key1: string) => (key2: string) => ({ a: key1, b: key2 }), { c: { d: {} } })).toEqual({ c: { d: { a: "c", b: "d" } } });
  expect(applyDefaults({ a: (key: string) => ({ b: key }) }, { a: { c: { d: 1 } } })).toEqual({ a: { c: { b: "c", d: 1 } } });
  expect(applyDefaults({ a: (key: string) => ({ b: key }) }, {})).toEqual({ a: {} });
  expect(applyDefaults({ a: (key: string) => ({ b: key }) }, { a: null })).toEqual({ a: {} });
  expect(applyDefaults({ a: (key: string) => ({ c: key }) }, { a: { b: null } })).toEqual({ a: { b: null } });
  expect(applyDefaults({ a: { b: (key: string) => ({ b: key }) } }, {})).toEqual({ a: { b: {} } });
  expect(applyDefaults(typedAssign(() => ({ b: 1 }), { a: { b: 1, c: 2 } }), { a: {} })).toEqual({ a: { b: 1, c: 2 } });
  expect(applyDefaults(typedAssign(() => ({ b: 1 }), { a: { b: 1, c: 2 } }), { d: {} })).toEqual({ a: { b: 1, c: 2 }, d: { b: 1 } });

  // Dot notation
  expect(applyDefaults({ a: { b: 1 } }, { "a.c": 2 })).toEqual({ a: { b: 1 }, "a.c": 2 });
  expect(applyDefaults({ a: { b: 1 } }, { "a.c": null })).toEqual({ a: { b: 1 }, "a.c": null });
  expect(applyDefaults({ a: { b: 1 } }, { a: { b: 2 }, "a.b": null })).toEqual({ a: { b: 2 }, "a.b": 1 });
  expect(applyDefaults({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } }, "a.b.c": null })).toEqual({ a: { b: { c: 2 } }, "a.b.c": 1 });
  expect(applyDefaults({}, { a: { b: 2 }, "a.b": null })).toEqual({ a: { b: 2 }, "a.b": null });
  expect(applyDefaults({ a: { b: 1, c: 2 } }, { "a.c": null })).toEqual({ a: { b: 1, c: 2 }, "a.c": 2 });
  expect(applyDefaults({ a: { b: 1, c: () => {} } }, { "a.c": null })).toEqual({ a: { b: 1, c: {} }, "a.c": {} });
  expect(applyDefaults({ a: { b: 1, c: () => {} } }, { "a.c.d": null })).toEqual({ a: { b: 1, c: {} }, "a.c.d": null });
  expect(applyDefaults({ a: { b: 1 } }, { "a.b": null })).toEqual({ a: { b: 1 }, "a.b": 1 });
  expect(applyDefaults({ a: { b: { c: 1 } } }, { "a.b": null })).toEqual({ a: { b: { c: 1 } }, "a.b": { c: 1 } });
  expect(applyDefaults({ a: {} }, { "a.b": null })).toEqual({ a: {}, "a.b": null });
  expect(applyDefaults({ a: {} }, { "a": { b: 1 }, "a.b": null })).toEqual({ a: { b: 1 }, "a.b": null });
  expect(applyDefaults({ a: 1 }, { "a.b": null })).toEqual({ a: 1, "a.b": null });
  expect(applyDefaults({ a: 1 }, { "a.b": 2 })).toEqual({ a: 1, "a.b": 2 });
  expect(applyDefaults({ a: null }, { "a.b": 2 })).toEqual({ a: null, "a.b": 2 });
  expect(applyDefaults({ a: { b: { c: 1 } } }, { "a.b": { d: 2 } })).toEqual({ a: { b: { c: 1 } }, "a.b": { c: 1, d: 2 } });
  expect(applyDefaults({ a: { b: { c: 1 } } }, { "a.b": null })).toEqual({ a: { b: { c: 1 } }, "a.b": { c: 1 } });
  expect(applyDefaults({ a: { b: { c: { d: 1 } } } }, { "a.b.c": {} })).toEqual({ a: { b: { c: { d: 1 } } }, "a.b.c": { d: 1 } });
  expect(applyDefaults({ a: () => ({ c: 1 }) }, { "a.b": { d: 2 } })).toEqual({ a: {}, "a.b": { c: 1, d: 2 } });
  expect(applyDefaults({ a: () => () => ({ d: 1 }) }, { "a.b": null })).toEqual({ a: {}, "a.b": null });
  expect(applyDefaults({ a: () => () => ({ d: 1 }) }, { "a.b.c": {} })).toEqual({ a: {}, "a.b.c": { d: 1 } });
  expect(applyDefaults({ a: { b: () => ({ c: 1, d: 2 }) } }, { "a.b.x-y.c": 3 })).toEqual({ a: { b: {} }, "a.b.x-y.c": 3 });
  expect(applyDefaults({ a: () => ({ c: 1 }) }, { "a.b.d": 2 })).toEqual({ a: {}, "a.b.d": 2 });
  expect(applyDefaults({ a: () => ({ c: 1 }) }, { "a.b.d": 2, "a.e.d": 3 })).toEqual({ a: {}, "a.b.d": 2, "a.e.d": 3 });
  expect(applyDefaults({ a: () => ({ c: 1 }) }, { "a.b.d": 2, a: { b: { d: 3 } } })).toEqual({ a: { b: { c: 1, d: 3 } }, "a.b.d": 2 });
  expect(applyDefaults({ a: () => ({ c: 1 }) }, { "a.b.d": 2, a: { e: { d: 3 } } })).toEqual({ a: { e: { c: 1, d: 3 } }, "a.b.d": 2 });
  expect(applyDefaults({ a: () => ({ c: 1 }) }, { "a.b": { d: { e: 2 } }, "a.b.d": null })).toEqual({ a: {}, "a.b": { c: 1, d: { e: 2 } }, "a.b.d": null });
});

export function applyProjectDefaults<T extends ProjectRenderedConfigBeforeDefaults>(config: T) {
  return applyDefaults(projectConfigDefaults, config);
}

export function applyBranchDefaults<T extends BranchRenderedConfigBeforeDefaults>(config: T) {
  return applyDefaults(
    branchConfigDefaults,
    applyDefaults(
      projectConfigDefaults,
      config
    )
  );
}

// SAFETY: Each cast bridges TypeScript's recursive instantiation limit; the
// runtime calls apply the same defaults in the exact order described by the
// nested ApplyDefaults return type.
export function applyEnvironmentDefaults<T extends EnvironmentRenderedConfigBeforeDefaults>(config: T): ApplyDefaults<typeof environmentConfigDefaults, ApplyDefaults<typeof branchConfigDefaults, ApplyDefaults<typeof projectConfigDefaults, T>>> {
  // SAFETY: The nested calls below apply the same defaults in the order
  // described by the recursive ApplyDefaults return type.
  return applyDefaults(
    environmentConfigDefaults,
    applyDefaults(
      branchConfigDefaults,
      applyDefaults(
        projectConfigDefaults,
        config
      ) as any
    ) as any
  ) as any;
}

// SAFETY: Each cast bridges TypeScript's recursive instantiation limit; the
// runtime calls apply the same defaults in the exact order described by the
// nested ApplyDefaults return type.
export function applyOrganizationDefaults(config: OrganizationRenderedConfigBeforeDefaults): ApplyDefaults<typeof organizationConfigDefaults, ApplyDefaults<typeof environmentConfigDefaults, ApplyDefaults<typeof branchConfigDefaults, ApplyDefaults<typeof projectConfigDefaults, OrganizationRenderedConfigBeforeDefaults>>>> {
  // SAFETY: The nested calls below apply the same defaults in the order
  // described by the recursive ApplyDefaults return type.
  return applyDefaults(
    organizationConfigDefaults,
    applyDefaults(
      environmentConfigDefaults,
      applyDefaults(
        branchConfigDefaults,
        applyDefaults(
          projectConfigDefaults,
          config
        ) as any
      ) as any
    ) as any
  ) as any;
}


export async function sanitizeProjectConfig<T extends ProjectRenderedConfigBeforeSanitization>(config: T) {
  assertNormalized(config);

  return {
    ...config,
    sourceOfTruth: {
      type: 'hosted',
    } as const,
  };
}

export async function sanitizeBranchConfig<T extends BranchRenderedConfigBeforeSanitization>(config: T) {
  assertNormalized(config);
  const prepared = await sanitizeProjectConfig(config);
  return {
    ...prepared,
  };
}

export async function sanitizeEnvironmentConfig<T extends EnvironmentRenderedConfigBeforeSanitization>(config: T) {
  assertNormalized(config);
  const prepared = await sanitizeBranchConfig(config);
  return {
    ...prepared,
  };
}

export async function sanitizeOrganizationConfig(config: OrganizationRenderedConfigBeforeSanitization) {
  assertNormalized(config);
  const prepared = await sanitizeEnvironmentConfig(config);

  const themes: typeof prepared.emails.themes = prepared.emails.themes;
  const templates: typeof prepared.emails.templates = config.emails.server.isShared ? DEFAULT_EMAIL_TEMPLATES : prepared.emails.templates;

  const products = typedFromEntries(typedEntries(prepared.payments.products).map(([key, product]) => {
    const isAddOnTo = product.isAddOnTo === false ?
      false as const :
      typedFromEntries(Object.keys(product.isAddOnTo).map((key) => [key, true as const]));
    type PriceEntry = Partial<typeof product.prices[string]> & { serverOnly: boolean };
    // `serverOnly` is guaranteed to be a boolean by the applyDefaults step above.
    const prices: Record<string, PriceEntry> = typedFromEntries(typedEntries(product.prices).map(([key, value]) => {
      const data: PriceEntry = { ...value };
      return [key, data];
    }));
    return [key, {
      ...product,
      isAddOnTo,
      prices,
    }];
  }));

  const appSortIndices = new Map(Object.keys(ALL_APPS).map((appId, index) => [appId, index]));
  const compareAppIds = (a: string, b: string) => {
    const aIndex = appSortIndices.get(a);
    const bIndex = appSortIndices.get(b);
    if (aIndex != null && bIndex != null) return aIndex - bIndex;
    if (aIndex != null) return -1;
    if (bIndex != null) return 1;
    return stringCompare(a, b);
  };

  // Get all sign-up rules and sort by priority (descending), then by ID (alphabetically)
  // Note: We don't filter out disabled rules here because the dashboard needs to show them
  // The runtime evaluation in sign-up-rules.ts handles skipping disabled rules
  const sortedRuleEntries = typedEntries(prepared.auth.signUpRules)
    .sort((a, b) => {
      const priorityA = a[1].priority;
      const priorityB = b[1].priority;
      if (priorityA !== priorityB) return priorityB - priorityA;
      return stringCompare(a[0], b[0]);
    });

  return {
    ...prepared,
    auth: {
      ...prepared.auth,
      oauth: {
        ...prepared.auth.oauth,
        providers: typedFromEntries(typedEntries(prepared.auth.oauth.providers).filter(([key, value]) => value.type !== undefined)),
      },
      signUpRules: typedFromEntries(sortedRuleEntries),
    },
    emails: {
      ...prepared.emails,
      selectedThemeId: has(themes, prepared.emails.selectedThemeId) ? prepared.emails.selectedThemeId : DEFAULT_EMAIL_THEME_ID,
      themes,
      templates,
    },
    payments: {
      ...prepared.payments,
      products
    },
    apps: {
      installed: typedFromEntries(
        typedEntries(prepared.apps.installed)
          .sort(([a], [b]) => compareAppIds(a, b))
      ),
    },
  };
}

/**
 * Does not require a base config, and hence solely relies on the override itself to validate the config. If it returns
 * no error, you know that the
 *
 * It's crucial that our DB never contains any configs that are not valid according to this function, as this would mean
 * that the config object does not satisfy the ValidatedToHaveNoConfigOverrideErrors type (which is used as an assumption
 * in a whole bunch of places in the code).
 */
export async function getConfigOverrideErrors<T extends yup.AnySchema>(schema: T, configOverride: unknown, options: { allowPropertiesThatCanNoLongerBeOverridden?: boolean } = {}): Promise<Result<null, string>> {
  // currently, we go over the schema and ensure that the general requirements for each property are satisfied
  // importantly, we cannot check any cross-property constraints, as those may change depending on the base config
  // also, since overrides can be empty, we cannot have any required properties (TODO: can we have required properties in nested objects? would that even make sense? think about it)
  if (typeof configOverride !== "object" || configOverride === null) {
    return Result.error("Config override must be a non-null object.");
  }
  if (Object.getPrototypeOf(configOverride) !== Object.getPrototypeOf({})) {
    return Result.error("Config override must be plain old JavaScript object.");
  }

  // Ensure that all keys with dots in them are at the top level of the object, not nested
  const ensureNoDotsInKeys = (obj: unknown): Result<never, string> | undefined => {
    if (typeof obj !== "object" || obj === null) {
      return;
    }
    for (const entry of Object.entries(obj)) {
      if (entry[0].includes(".")) {
        return Result.error(`Key ${entry[0]} contains a dot, which is not allowed in config override.`);
      }
      const result = ensureNoDotsInKeys(entry[1]);
      if (result) {
        return result;
      }
    }
    return;
  };
  for (const key of Object.keys(configOverride)) {
    const result = ensureNoDotsInKeys(configOverride[key as keyof typeof configOverride]);
    if (result) {
      return result;
    }
  }

  // Check config format
  const reason = getInvalidConfigReason(configOverride, { configName: 'override' });
  if (reason) return Result.error("Invalid config format: " + reason);

  const getSubSchema = (schema: yup.AnySchema, key: string): yup.AnySchema | undefined => {
    const keyParts = key.split(".");
    if (!schema.hasNested(keyParts[0])) {
      return undefined;
    }
    const nestedSchema = schema.getNested(keyParts[0]);
    if (nestedSchema.meta()?.hexclaveConfigCanNoLongerBeOverridden && !options.allowPropertiesThatCanNoLongerBeOverridden) {
      return undefined;
    }
    if (keyParts.length === 1) {
      return nestedSchema;
    } else {
      return getSubSchema(nestedSchema, keyParts.slice(1).join("."));
    }
  };

  const getRestrictedSchemaBase = (path: string, schema: yup.AnySchema): yup.AnySchema => {
    const schemaInfo = schema.meta()?.hexclaveSchemaInfo;
    switch (schemaInfo?.type) {
      case "string": {
        const stringSchema = schema as yup.StringSchema<any>;
        const description = stringSchema.describe();
        let res = yupString();
        if (description.tests.some(t => t.name === "uuid")) {
          res = res.uuid();
        }
        return res;
      }
      case "number": {
        return yupNumber();
      }
      case "boolean": {
        return yupBoolean();
      }
      case "date": {
        return yupDate();
      }
      case "mixed": {
        return yupMixed();
      }
      case "array": {
        throw new HexclaveAssertionError(`Arrays are not supported in config JSON files (besides tuples). Use a record instead.`, { schemaInfo, schema });

        // This is how the implementation would look like, but we don't support arrays in config JSON files (besides tuples)
        // const arraySchema = schema as yup.ArraySchema<any, any, any, any>;
        // const innerType = arraySchema.innerType;
        // return yupArray(innerType ? getRestrictedSchema(path + ".[]", innerType as any) : undefined());
      }
      case "tuple": {
        return yupTuple(schemaInfo.items.map((s, index) => getRestrictedSchema(path + `[${index}]`, s)) as any);
      }
      case "union": {
        const schemas = schemaInfo.items;
        const nonObjectSchemas = [...schemas.entries()].filter(([index, s]) => s.meta()?.hexclaveSchemaInfo?.type !== "object");
        const objectSchemas = schemas.filter((s): s is yup.ObjectSchema<any> => s.meta()?.hexclaveSchemaInfo?.type === "object");

        // merge all object schemas into a single schema
        const allObjectSchemaKeys = [...new Set(objectSchemas.flatMap(s => Object.keys(s.fields)))];
        const mergedObjectSchema = yupObject(
          Object.fromEntries(
            allObjectSchemaKeys.map(key => [key, yupUnion(
              ...objectSchemas.flatMap((s, index) => s.hasNested(key) ? [s.getNested(key)] : [])
            )])
          )
        );

        return yupUnion(
          ...nonObjectSchemas.map(([index, s]) => getRestrictedSchema(path + `|variant-${index}|`, s)),
          ...objectSchemas.length > 0 ? [getRestrictedSchema(path + (nonObjectSchemas.length > 0 ? `|variant|` : ""), mergedObjectSchema)] : [],
        );
      }
      case "record": {
        return yupRecord(getRestrictedSchema(path + ".key", schemaInfo.keySchema) as any, getRestrictedSchema(path + ".value", schemaInfo.valueSchema));
      }
      case "object": {
        const objectSchema = schema as yup.ObjectSchema<any>;
        return yupObject(
          Object.fromEntries(
            Object.entries(objectSchema.fields)
              .map(([key, value]) => [key, getRestrictedSchema(path + "." + key, value as any)])
          )
        );
      }
      case "never": {
        return yupNever();
      }
      default: {
        throw new HexclaveAssertionError(`Unknown schema info at path ${path}: ${JSON.stringify(schemaInfo)}`, { schemaInfo, schema });
      }
    }
  };
  const getRestrictedSchema = (path: string, schema: yup.AnySchema): yup.AnySchema => {
    let restricted = getRestrictedSchemaBase(path, schema);
    restricted = restricted.nullable();
    const description = schema.describe();
    if (description.oneOf.length > 0) {
      restricted = restricted.oneOf(description.oneOf);
    }
    if (description.notOneOf.length > 0) {
      restricted = restricted.notOneOf(description.notOneOf);
    }
    return restricted;
  };

  for (const [key, value] of Object.entries(configOverride)) {
    if (value === undefined) continue;
    if (/^payments\.products\.[^.]+\.prices$/.test(key) && value === "include-by-default") {
      return Result.error(`${key} must not be one of the following values: include-by-default`);
    }
    const subSchema = getSubSchema(schema, key);
    if (!subSchema) {
      // find smallest key prefix that is invalid
      const keySplit = key.split(".");
      for (let i = 0; i < keySplit.length; i++) {
        const prefix = keySplit.slice(0, i + 1).join(".");
        const subSchema = getSubSchema(schema, prefix);
        if (!subSchema) {
          return Result.error(`The key ${JSON.stringify(key)} is not valid (nested object not found in schema: ${JSON.stringify(prefix)}).`);
        }
      }
      throw new HexclaveAssertionError("Something weird happened? Sub-schema for key is invalid but no prefix is invalid??", { key, subSchema });
    }
    let restrictedSchema = getRestrictedSchema(key, subSchema);
    try {
      await restrictedSchema.validate(value, {
        strict: true,
        ...{
          // Although `path` is not part of the yup types, it is actually recognized and does the correct thing
          path: key
        },
        context: {
          noUnknownPathPrefixes: [''],
        },
      });
    } catch (error) {
      if (error instanceof yup.ValidationError) {
        return Result.error(error.message);
      }
      throw error;
    }
  }
  return Result.ok(null);
}
export async function assertNoConfigOverrideErrors<T extends yup.AnySchema>(schema: T, config: unknown, options: { allowPropertiesThatCanNoLongerBeOverridden?: boolean, extraInfo?: any } = {}): Promise<void> {
  const res = await getConfigOverrideErrors(schema, config, options);
  if (res.status === "error") throw new HexclaveAssertionError(`Config override is invalid — at a place where it should have already been validated! ${res.error}`, { options, config });
}
type _ValidatedToHaveNoConfigOverrideErrorsImpl<T> =
  IsUnion<T & object> extends true ? _ValidatedToHaveNoConfigOverrideErrorsImpl<CollapseObjectUnion<T & object> | Exclude<T, object>>
  : T extends object ? (T extends any[] ? T : { [K in keyof T]+?: _ValidatedToHaveNoConfigOverrideErrorsImpl<T[K]> })
  : T;
export type ValidatedToHaveNoConfigOverrideErrors<T extends yup.AnySchema> = _ValidatedToHaveNoConfigOverrideErrorsImpl<yup.InferType<T>>;
typeAssertIs<_ValidatedToHaveNoConfigOverrideErrorsImpl<{ a: string } | { b: number } | boolean>, { a?: string, b?: number } | boolean>()();
typeAssertExtends<_ValidatedToHaveNoConfigOverrideErrorsImpl<"abc" | 123 | null>, "abc" | 123 | null>()();
typeAssertExtends<_ValidatedToHaveNoConfigOverrideErrorsImpl<{ a: { b: { c: string } | { d: number } } }>, { a?: { b?: { c?: string, d?: number } } }>()();

/**
 * Checks whether there are any warnings in the incomplete config. A warning doesn't stop the config from being valid,
 * but may require action regardless.
 *
 * The DB can contain configs that are not valid according to this function, as long as they are valid according to
 * the getConfigOverrideErrors function. (This is necessary, because a changing base config may make an override invalid
 * that was previously valid.)
 */
export async function getIncompleteConfigWarnings<T extends yup.AnySchema>(schema: T, incompleteConfig: Config): Promise<Result<null, string>> {
  // every rendered config should also be a config override without errors (regardless of whether it has warnings or not)
  const overrideErrors = await getConfigOverrideErrors(schema, incompleteConfig, { allowPropertiesThatCanNoLongerBeOverridden: true });
  if (overrideErrors.status === "error") {
    return overrideErrors;
  }

  // Check for dot-notation keys that would be silently dropped during rendering.
  // We simulate the rendering pipeline: apply all defaults, then normalize with
  // onDotIntoNonObject: "ignore" (same as the actual renderer). Any key that gets
  // dropped during normalization (because a parent doesn't exist or isn't an object)
  // means it dots into nothing — the user's change would be silently lost.
  const withDefaults = applyDefaults(
    organizationConfigDefaults,
    applyDefaults(projectConfigDefaults, incompleteConfig),
  );
  const droppedKeys: string[] = [];
  const normalizedWithDefaults = normalize(withDefaults as Config, { onDotIntoNonObject: "ignore", droppedKeys });

  // Only report keys that were in the original incomplete config, not anything from defaults
  const incompleteConfigDotKeys = new Set(
    Object.keys(incompleteConfig).filter(k => k.includes('.') && incompleteConfig[k] !== undefined)
  );
  const relevantDroppedKeys = droppedKeys.filter(k => incompleteConfigDotKeys.has(k));

  if (relevantDroppedKeys.length > 0) {
    const messages = relevantDroppedKeys.map(key => {
      const segments = key.split('.');

      // Walk the normalized config to find the deepest existing parent
      let current: unknown = normalizedWithDefaults;
      let lastExistingIdx = -1;
      for (let i = 0; i < segments.length - 1; i++) {
        if (current != null && typeof current === 'object' && !Array.isArray(current) && segments[i] in (current as Record<string, unknown>)) {
          current = (current as Record<string, unknown>)[segments[i]];
          lastExistingIdx = i;
        } else {
          break;
        }
      }

      // The non-existent parent is one level deeper than the last existing segment
      const nonExistentParent = segments.slice(0, lastExistingIdx + 2).join('.');

      // Build a suggested nested object notation starting from the non-existent parent
      const remainingSegments = segments.slice(lastExistingIdx + 2);
      let suggestion = '...';
      for (let i = remainingSegments.length - 1; i >= 0; i--) {
        suggestion = `{ ${JSON.stringify(remainingSegments[i])}: ${suggestion} }`;
      }
      suggestion = `{ ${JSON.stringify(nonExistentParent)}: ${suggestion} }`;

      return `Dot-notation key ${JSON.stringify(key)} will be silently ignored because it references non-existent parent ${JSON.stringify(nonExistentParent)}. Instead of dot notation, use nested object notation like this: ${suggestion}`;
    });

    return Result.error(messages.join('\n'));
  }

  let normalized: Config;
  try {
    normalized = normalize(incompleteConfig, { onDotIntoNull: "empty-object" });
  } catch (error) {
    if (error instanceof NormalizationError) {
      return Result.error(`Config is not normalizable. ` + error.message);
    }
    throw error;
  }

  const apps = normalized.apps;
  const installedApps = isObjectLike(apps) && !Array.isArray(apps) ? apps.installed : undefined;
  if (isObjectLike(installedApps)) {
    const unknownAppIds = Object.keys(installedApps)
      .filter(appId => !has(ALL_APPS, appId))
      .sort(stringCompare);
    if (unknownAppIds.length > 0) {
      return Result.error(
        `Unknown installed app ${unknownAppIds.length === 1 ? "ID" : "IDs"}: ${unknownAppIds.map(id => JSON.stringify(id)).join(", ")}. `
        + "This config can still be rendered, but this version cannot validate or operate those apps.",
      );
    }
  }

  // test the schema against the normalized config
  try {
    await schema.validate(normalized, {
      strict: true,
      context: {
        noUnknownPathPrefixes: [''],
      },
    });
    return Result.ok(null);
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      return Result.error(error.message);
    }
    throw error;
  }
}
export type ValidatedToHaveNoIncompleteConfigWarnings<T extends yup.AnySchema> = yup.InferType<T>;

import.meta.vitest?.test("unknown installed apps render with a config warning", async ({ expect }) => {
  const config = {
    apps: {
      installed: {
        "future-app": { enabled: true },
      },
    },
  };

  expect(await getConfigOverrideErrors(branchConfigSchema, config)).toEqual(Result.ok(null));
  expect(await getIncompleteConfigWarnings(branchConfigSchema, config)).toEqual(Result.error(
    "Unknown installed app ID: \"future-app\". This config can still be rendered, but this version cannot validate or operate those apps.",
  ));
});

import.meta.vitest?.test("sub-apps can be enabled independently of their parent apps", async ({ expect }) => {
  const subAppEntries: [keyof typeof ALL_APPS, keyof typeof ALL_APPS][] = [];
  for (const appId of appIds) {
    const parentAppId = getParentAppId(appId);
    if (parentAppId != null) {
      subAppEntries.push([appId, parentAppId]);
    }
  }
  const config = {
    apps: {
      installed: Object.fromEntries(subAppEntries.flatMap(([appId, parentAppId]) => [
        [parentAppId, { enabled: false }],
        [appId, { enabled: true }],
      ])),
    },
  };

  expect(subAppEntries.length).toBeGreaterThan(0);
  expect(await getConfigOverrideErrors(branchConfigSchema, config)).toEqual(Result.ok(null));
  expect(await getIncompleteConfigWarnings(branchConfigSchema, config)).toEqual(Result.ok(null));
});


// Normalized overrides
// ex.: { a?: { b?: number, c?: string }, d?: number }
export type ProjectConfigNormalizedOverride = Expand<ValidatedToHaveNoConfigOverrideErrors<typeof projectConfigSchema>>;
export type BranchConfigNormalizedOverride = Expand<ValidatedToHaveNoConfigOverrideErrors<typeof branchConfigSchema>>;
export type EnvironmentConfigNormalizedOverride = Expand<ValidatedToHaveNoConfigOverrideErrors<typeof environmentConfigSchema>>;
export type OrganizationConfigNormalizedOverride = Expand<ValidatedToHaveNoConfigOverrideErrors<typeof organizationConfigSchema>>;


// Overrides
// ex.: { a?: null | { b?: null | number, c: string }, d?: null | number, "a.b"?: number, "a.c"?: string }
export type ProjectConfigOverride = NormalizesTo<ProjectConfigNormalizedOverride>;
export type BranchConfigOverride = NormalizesTo<BranchConfigNormalizedOverride>;
export type EnvironmentConfigOverride = NormalizesTo<EnvironmentConfigNormalizedOverride>;
export type OrganizationConfigOverride = NormalizesTo<OrganizationConfigNormalizedOverride>;

// Override overrides (used to update the overrides)
// ex.: { a?: null | { b?: null | number, c?: string }, d?: null | number, "a.b"?: number, "a.c"?: string }
export type ProjectConfigOverrideOverride = ProjectConfigOverride;
export type BranchConfigOverrideOverride = BranchConfigOverride;
export type EnvironmentConfigOverrideOverride = EnvironmentConfigOverride;
export type OrganizationConfigOverrideOverride = OrganizationConfigOverride;

// Incomplete configs
// note that we infer these types from the override types, not from the schema types directly, as there is no guarantee
// that all configs in the DB satisfy the schema (the only guarantee we make is that this once *used* to be true)
export type ProjectIncompleteConfig = Expand<ProjectConfigNormalizedOverride>;
export type BranchIncompleteConfig = Expand<ProjectIncompleteConfig & BranchConfigNormalizedOverride>;
export type EnvironmentIncompleteConfig = Expand<BranchIncompleteConfig & EnvironmentConfigNormalizedOverride>;
export type OrganizationIncompleteConfig = Expand<EnvironmentIncompleteConfig & OrganizationConfigNormalizedOverride>;


// Rendered configs before defaults, normalization, and sanitization
type ProjectRenderedConfigBeforeDefaults = Omit<ProjectIncompleteConfig,
  | keyof BranchConfigNormalizedOverride
  | keyof EnvironmentConfigNormalizedOverride
  | keyof OrganizationConfigNormalizedOverride
>;
type BranchRenderedConfigBeforeDefaults = Omit<BranchIncompleteConfig,
  | keyof EnvironmentConfigNormalizedOverride
  | keyof OrganizationConfigNormalizedOverride
>;
type EnvironmentRenderedConfigBeforeDefaults = Omit<EnvironmentIncompleteConfig,
  | keyof OrganizationConfigNormalizedOverride
>;
type OrganizationRenderedConfigBeforeDefaults = OrganizationIncompleteConfig;


// Rendered configs before sanitization
type ProjectRenderedConfigBeforeSanitization = Expand<Awaited<ReturnType<typeof applyProjectDefaults<ProjectRenderedConfigBeforeDefaults>>>>;
type BranchRenderedConfigBeforeSanitization = Expand<Awaited<ReturnType<typeof applyBranchDefaults<BranchRenderedConfigBeforeDefaults>>>>;
type EnvironmentRenderedConfigBeforeSanitization = Expand<Awaited<ReturnType<typeof applyEnvironmentDefaults<EnvironmentRenderedConfigBeforeDefaults>>>>;
type OrganizationRenderedConfigBeforeSanitization = Expand<Awaited<ReturnType<typeof applyOrganizationDefaults>>>;

// Rendered configs after defaults, normalization, and sanitization
export type ProjectRenderedConfig = Expand<Awaited<ReturnType<typeof sanitizeProjectConfig<ProjectRenderedConfigBeforeSanitization>>>>;
export type BranchRenderedConfig = Expand<Awaited<ReturnType<typeof sanitizeBranchConfig<BranchRenderedConfigBeforeSanitization>>>>;
export type EnvironmentRenderedConfig = Expand<Awaited<ReturnType<typeof sanitizeEnvironmentConfig<EnvironmentRenderedConfigBeforeSanitization>>>>;
export type OrganizationRenderedConfig = Expand<Awaited<ReturnType<typeof sanitizeOrganizationConfig>>>;

// Complete config
export type CompleteConfig = OrganizationRenderedConfig;

// Type assertions (just to make sure the types are correct)
const __assertEmptyObjectIsValidProjectOverride: ProjectConfigOverride = {};
const __assertEmptyObjectIsValidBranchOverride: BranchConfigOverride = {};
const __assertEmptyObjectIsValidEnvironmentOverride: EnvironmentConfigOverride = {};
const __assertEmptyObjectIsValidOrganizationOverride: OrganizationConfigOverride = {};
typeAssertExtends<ProjectRenderedConfig, { "sourceOfTruth": any }>()();
typeAssertExtends<BranchRenderedConfig, { "sourceOfTruth": any }>()();
typeAssertExtends<EnvironmentRenderedConfig, { "sourceOfTruth": any }>()();
typeAssertExtends<OrganizationRenderedConfig, { "sourceOfTruth": any }>()();
typeAssert<BranchRenderedConfig extends { "domains": any } ? false : true>()();
typeAssert<EnvironmentRenderedConfig extends { "domains": any } ? false : true>()();
typeAssertExtends<OrganizationRenderedConfig, { "domains": any }>()();

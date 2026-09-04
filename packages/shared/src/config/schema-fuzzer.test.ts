import { ALL_APPS } from "../apps/apps-config";
import { SUPPORTED_CURRENCIES } from "../utils/currency-constants";
import { HexclaveAssertionError } from "../utils/errors";
import { getOrUndefined, isObjectLike, set, typedEntries, typedFromEntries } from "../utils/objects";
import { nicify } from "../utils/strings";
import { normalize, override } from "./format";
import { BranchConfigNormalizedOverride, EnvironmentConfigNormalizedOverride, OrganizationConfigNormalizedOverride, ProjectConfigNormalizedOverride, applyBranchDefaults, applyEnvironmentDefaults, applyOrganizationDefaults, applyProjectDefaults, assertNoConfigOverrideErrors, branchConfigSchema, environmentConfigSchema, migrateConfigOverride, organizationConfigSchema, projectConfigSchema, sanitizeBranchConfig, sanitizeEnvironmentConfig, sanitizeOrganizationConfig, sanitizeProjectConfig } from "./schema";

type FuzzerConfig<T> = ReadonlyArray<T extends object ? ([T] extends [any[]] ? { readonly [K in keyof T]: FuzzerConfig<T[K]> } : Required<{
  [K in keyof T]: FuzzerConfig<T[K]>;
}> & Record<string, FuzzerConfig<any>>) : T>;

const projectSchemaFuzzerConfig = [{
  sourceOfTruth: [{
    type: ["hosted"],
  }],
  project: [{
    requirePublishableClientKey: [true, false],
  }],
}] satisfies FuzzerConfig<ProjectConfigNormalizedOverride>;

const branchSchemaFuzzerConfig = [{
  featureFlags: [undefined],
  apiKeys: [{
    enabled: [{
      team: [true, false],
      user: [true, false],
    }],
  }],
  auth: [{
    allowSignUp: [true, false],
    password: [{
      allowSignIn: [true, false],
    }],
    otp: [{
      allowSignIn: [true, false],
    }],
    passkey: [{
      allowSignIn: [true, false],
    }],
    oauth: [{
      accountMergeStrategy: ["link_method", "raise_error", "allow_duplicates"],
      providers: [{
        "google": [{
          type: ["google", "github", "x"] as const,
          allowSignIn: [true, false],
          allowConnectedAccounts: [true, false],
        }],
      }],
    }],
    signUpRules: [{
      "some-rule-id": [{
        enabled: [true, false],
        displayName: ["Block Test Emails", "Allow Only Company Domain"],
        priority: [0, 1, 100],
        condition: ['email.endsWith("@test.com")', 'emailDomain == "company.com"'],
        action: [{
          type: ["allow", "reject", "restrict", "log"] as const,
          message: ["", "Sign up is not allowed for this email"],
        }],
      }],
    }],
    signUpRulesDefaultAction: ["allow", "reject"],
  }],
  dataVault: [{
    stores: [{
      "some-store-id": [{
        displayName: ["Some Store", "Some Other Store"],
      }],
      "some-other-store-id": [{
        displayName: ["Some Store", "Some Other Store"],
      }],
    }],
  }],
  payments: [{
    blockNewPurchases: [false, true],
    autoPay: [{
      interval: [[[0, 1, -3, 100, 0.333, Infinity], ["day", "week", "month", "year"]]] as const,
    }],
    productLines: [{
      "some-product-line-id": [{
        displayName: ["Some Product Line", "Some Other Product Line"],
        customerType: ["user", "team", "custom"] as const,
      }],
    }],
    catalogs: [{  // ensure migration works
      "some-product-line-id": [{
        displayName: ["Some Product Line", "Some Other Product Line"],
      }],
    }],
    groups: [{  // ensure migration works
      "some-product-line-id": [{
        displayName: ["Some Product Line", "Some Other Product Line"],
      }],
    }],
    items: [{
      "some-item-id": [{
        customerType: ["user", "team", "custom"] as const,
        displayName: ["Some Item", "Some Other Item"],
      }],
    }],
    products: [{
      "some-product-id": [{
        displayName: ["Some Product", "Some Other Product"],
        customerType: ["user", "team", "custom"] as const,
        freeTrial: [[[0, 1, -3, 100, 0.333, Infinity], ["day", "week", "month", "year"]]] as const,
        serverOnly: [true, false],
        stackable: [true, false],
        productLineId: ["some-product-line-id", "some-other-product-line-id"],
        catalogId: ["some-product-line-id", "some-other-product-line-id"],  // ensure migration works
        groupId: ["some-product-line-id", "some-other-product-line-id"],  // ensure migration works
        isAddOnTo: [false, { "some-product-id": [true], "some-other-product-id": [true] }] as const,
        prices: [{
          "some-price-id": [{
            ...typedFromEntries(SUPPORTED_CURRENCIES.map(currency => [currency.code, ["100_00", "not a number", "Infinity", "0"]])),
            interval: [[[0, 1, -3, 100, 0.333, Infinity], ["day", "week", "month", "year"]]] as const,
            serverOnly: [true, false],
            freeTrial: [[[0, 1, -3, 100, 0.333, Infinity], ["day", "week", "month", "year"]]] as const,
          }],
        }],
        includedItems: [{
          "some-item-id": [{
            quantity: [0, 1, -3, 100, 0.333, Infinity],
            repeat: ["never", [[0, 1, -3, 100, 0.333, Infinity], ["day", "week", "month", "year"]]] as const,
            expires: ["never", "when-purchase-expires", "when-repeated"] as const,
          }],
        }],
      }],
    }],
  }],
  emails: [{
    themes: [{
      "12345678-1234-4234-9234-123456789012": [{
        displayName: ["Some Theme", "Some Other Theme"],
        tsxSource: ["", "some typescript source code"],
      }],
    }],
    selectedThemeId: ["some-theme-id", "some-other-theme-id"],
    templates: [{
      "12345678-1234-4234-9234-123456789012": [{
        themeId: ["some-theme-id", "some-other-theme-id"],
        displayName: ["Some Template", "Some Other Template"],
        tsxSource: ["", "some typescript source code"],
      }],
    }],
  }],
  teams: [{
    createPersonalTeamOnSignUp: [true, false],
    allowClientTeamCreation: [true, false],
  }],
  users: [{
    allowClientUserDeletion: [true, false],
  }],
  rbac: [{
    permissions: [{
      "some_permission_id": [{
        containedPermissionIds: [{
          "some_permission_id": [true],
          "$some_other_permission_id": [true],
        }] as const,
        description: ["Some Permission", "Some Other Permission"],
        scope: ["team", "project"] as const,
      }],
    }],
    defaultPermissions: [{
      teamCreator: [{
        "some_permission_id": [true],
        "$some_other_permission_id": [true],
      }] as const,
      teamMember: [{
        "some_permission_id": [true],
        "$some_other_permission_id": [true],
      }] as const,
      signUp: [{
        "some_permission_id": [true],
        "$some_other_permission_id": [true],
      }] as const,
    }],
  }],
  domains: [{}],
  apps: [{
    installed: [typedFromEntries(typedEntries(ALL_APPS).map(([key, value]) => [key, [{
      enabled: [true, false],
    }]]))],
  }],
  onboarding: [{
    requireEmailVerification: [true, false],
  }],
}] satisfies FuzzerConfig<BranchConfigNormalizedOverride>;

const environmentSchemaFuzzerConfig = [{
  ...branchSchemaFuzzerConfig[0],
  auth: [{
    ...branchSchemaFuzzerConfig[0].auth[0],
    oauth: [{
      ...branchSchemaFuzzerConfig[0].auth[0].oauth[0],
      providers: [typedFromEntries(typedEntries(branchSchemaFuzzerConfig[0].auth[0].oauth[0].providers[0]).map(([key, value]) => [key, [{
        ...value[0],
        isShared: [true, false],
        clientId: ["some-client-id"],
        clientSecret: ["some-client-secret"],
        // Kept undefined: the schema forbids customCallbackUrl when isShared is
        // true, and the fuzzer randomizes each field independently so it cannot
        // honor that coupling. The accept path is covered by an e2e test.
        customCallbackUrl: [undefined] as (string | undefined)[],
        facebookConfigId: ["some-facebook-config-id"],
        microsoftTenantId: ["some-microsoft-tenant-id"],
        appleTeamId: [undefined] as (string | undefined)[],
        appleKeyId: [undefined] as (string | undefined)[],
        applePrivateKey: [undefined] as (string | undefined)[],
        appleBundles: [{ "some-bundle-id": [{ bundleId: ["com.example.app"] }] }],
        issuerUrl: [undefined, "https://accounts.google.com"] as (string | undefined)[],
        scope: [undefined, "openid email profile"] as (string | undefined)[],
        displayName: [undefined, "My OIDC Provider"] as (string | undefined)[],
      }]]))] as const,
    }],
  }],
  domains: [{
    allowLocalhost: [true, false],
    trustedDomains: [{
      "some-domain-id": [{
        baseUrl: ["https://example.com/something-here"],
        handlerPath: ["/something-here"],
      }],
    }],
  }],
  emails: [{
    ...branchSchemaFuzzerConfig[0].emails[0],
    server: [{
      isShared: [true, false],
      provider: ["resend", "smtp", "managed"] as const,
      host: ["example.com", "://super weird host that's not valid"],
      port: [1234, 0.12543, -100, Infinity],
      username: ["some-username", "some username with a space"],
      password: ["some-password", "some password with a space"],
      senderName: ["Some Sender"],
      senderEmail: ["some-sender@example.com", "some invalid email"],
      managedSubdomain: ["mail.example.com", "invalid subdomain"],
      managedSenderLocalPart: ["noreply", "some invalid local part"],
    }],
  }],
  payments: [{
    ...branchSchemaFuzzerConfig[0].payments[0],
    testMode: [false, true],
  }],
  dbSync: [{
    externalDatabases: [{
      "some-external-db-id": [{
        type: ["postgres"] as const,
        connectionString: [
          "postgres://user:password@db.example.com:5432/database",
          "postgresql://user:password@db.example.net/database",
        ],
      }],
    }],
  }],
  analytics: [{
    queryFolders: [{
      "some-folder-id": [{
        displayName: ["Some Folder", "Some Other Folder"],
        sortOrder: [0, 1, 10, -5],
        queries: [{
          "some-query-id": [{
            displayName: ["Some Query", "Some Other Query"],
            sqlQuery: ["", "SELECT * FROM events", "SELECT * FROM users"],
            description: ["", "A query description", "Another description"],
          }],
        }],
      }],
    }],
  }],
  customDashboards: [{
    "12345678-1234-4234-9234-123456789012": [{
      displayName: ["My Dashboard", "User Growth Dashboard"],
      tsxSource: ["", "function Dashboard() { return <div>Hello</div>; }"],
    }],
  }],
}] satisfies FuzzerConfig<EnvironmentConfigNormalizedOverride>;

const organizationSchemaFuzzerConfig = environmentSchemaFuzzerConfig satisfies FuzzerConfig<OrganizationConfigNormalizedOverride>;

function setDeep<T>(obj: T, path: string[], value: any) {
  if (!isObjectLike(obj)) return obj;

  if (path.length === 0) {
    throw new Error("Path is empty");
  } else if (path.length === 1) {
    set(obj as any, path[0], value);
  } else {
    const [key, ...rest] = path;
    setDeep(getOrUndefined(obj as any, key), rest, value);
  }
}

function createFuzzerInput<T>(config: FuzzerConfig<T>, progress: number): T {
  progress = Math.min(1, 2 * progress);
  const createShouldRandom = (strength: number) => {
    const chance = Math.random() * strength * 1.2 - 0.1;
    return () => Math.random() < chance;
  };
  const createShouldObjectDependent = (strength: number) => {
    const objectChance = Math.random() * strength * 1.2 - 0.1;
    const primitiveChance = Math.random() * strength * 1.2 - 0.1;
    return (v: any) => Math.random() * Math.random() < (isObjectLike(v) ? objectChance : primitiveChance);
  };

  const shouldKeep = createShouldObjectDependent(progress * 1);
  const shouldMakeNested = createShouldObjectDependent(1.25);
  const shouldNull = createShouldRandom(0.25);

  let res: any;
  const recurse = <U>(outputPath: string[], config: FuzzerConfig<U>, forceNested: boolean, forceNonNull: boolean) => {
    let subConfig: any = config[Math.floor(Math.random() * config.length)];
    const originalValue = isObjectLike(subConfig) ? (Array.isArray(subConfig) ? [] : {}) : subConfig;

    const newValue = forceNonNull || !shouldNull() ? originalValue : null;
    const newOutputPath = forceNested || shouldMakeNested(originalValue) || outputPath.length === 0 ? outputPath : [outputPath.join(".")];
    if (outputPath.length === 0) {
      res = newValue;
    } else {
      if (forceNested || shouldKeep(originalValue)) {
        setDeep(res, newOutputPath, newValue);
      }
    }
    if (isObjectLike(subConfig)) {
      for (const [key, newValue] of typedEntries(subConfig)) {
        recurse([...newOutputPath, key], newValue, Array.isArray(subConfig), Array.isArray(subConfig));
      }
    }
  };
  recurse<T>([], config, false, true);
  return res;
}

import.meta.vitest?.test("fuzz schemas", async ({ expect }) => {
  const totalIterations = process.env.CI ? 1000 : 200;
  for (let i = 0; i < totalIterations; i++) {
    const projectInput = createFuzzerInput<ProjectConfigNormalizedOverride>(projectSchemaFuzzerConfig, i / totalIterations);
    const branchInput = createFuzzerInput<BranchConfigNormalizedOverride>(branchSchemaFuzzerConfig, i / totalIterations);
    const environmentInput = createFuzzerInput<EnvironmentConfigNormalizedOverride>(environmentSchemaFuzzerConfig, i / totalIterations);
    const organizationInput = createFuzzerInput<OrganizationConfigNormalizedOverride>(organizationSchemaFuzzerConfig, i / totalIterations);

    try {
      const projectMigrated = migrateConfigOverride("project", projectInput);
      await assertNoConfigOverrideErrors(projectConfigSchema, projectMigrated);
      const projectOverridden = override({}, projectMigrated);
      await sanitizeProjectConfig(normalize(applyProjectDefaults(projectOverridden), { onDotIntoNonObject: "ignore" }) as any);

      const branchMigrated = migrateConfigOverride("branch", branchInput);
      await assertNoConfigOverrideErrors(branchConfigSchema, branchMigrated);
      const branchOverridden = override(projectOverridden, branchMigrated);
      await sanitizeBranchConfig(normalize(applyBranchDefaults(branchOverridden), { onDotIntoNonObject: "ignore" }) as any);

      const environmentMigrated = migrateConfigOverride("environment", environmentInput);
      await assertNoConfigOverrideErrors(environmentConfigSchema, environmentMigrated);
      const environmentOverridden = override(branchOverridden, environmentMigrated);
      await sanitizeEnvironmentConfig(normalize(applyEnvironmentDefaults(environmentOverridden), { onDotIntoNonObject: "ignore" }) as any);

      const organizationMigrated = migrateConfigOverride("organization", organizationInput);
      await assertNoConfigOverrideErrors(organizationConfigSchema, organizationMigrated);
      const organizationOverridden = override(environmentOverridden, organizationMigrated);
      await sanitizeOrganizationConfig(normalize(applyOrganizationDefaults(organizationOverridden), { onDotIntoNonObject: "ignore" }) as any);

    } catch (e) {
      const data = {
        cause: e,
        inputs: {
          projectInput,
          branchInput,
          environmentInput,
          organizationInput,
        },
      } as const;
      console.error("Failed to fuzz schema in iteration ${i}/${totalIterations}!", nicify(data));
      throw new HexclaveAssertionError(`Error in iteration ${i}/${totalIterations} of schema fuzz: ${e}`, { cause: e });
    }
  }
});

import.meta.vitest?.test("rejects include-by-default product prices in config overrides", async ({ expect }) => {
  await expect(assertNoConfigOverrideErrors(branchConfigSchema, {
    "payments.products.free.prices": "include-by-default",
  })).rejects.toThrow(/payments\.products\.free\.prices must not be one of the following values: include-by-default/);
});

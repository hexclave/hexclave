import { HexclaveAssertionError } from "../utils/errors";
import type { Json } from "../utils/json";
import { isObjectLike, set, typedEntries } from "../utils/objects";

/**
 * Renames properties in an object based on a path condition.
 * This is a local copy to avoid circular dependencies with schema.ts.
 */
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

/**
 * Migrates the old "catalogs" format to "productLines", including:
 * 1. Inferring customerType for each catalog from its products (since old catalogs didn't have customerType)
 * 2. Removing empty catalogs (those with no products) since they can't have customerType inferred
 * 3. Renaming payments.catalogs -> payments.productLines
 * 4. Renaming payments.products.*.catalogId -> payments.products.*.productLineId
 *
 * This handles all config formats (nested objects, flat dot-notation, or mixed).
 */
export function migrateCatalogsToProductLines(obj: Record<string, Json>): Record<string, Json> {
  // Step 1: Collect catalogId -> customerType mappings from products
  const catalogCustomerTypes = new Map<string, string>();
  collectCatalogCustomerTypes(obj, [], catalogCustomerTypes);

  // Step 2: Find all catalog IDs that exist
  const allCatalogIds = new Set<string>();
  findAllCatalogIds(obj, [], allCatalogIds);

  // Step 3: Add customerType keys for catalogs that need them
  let res = { ...obj };
  for (const catalogId of allCatalogIds) {
    const customerType = catalogCustomerTypes.get(catalogId);
    if (customerType) {
      // Find the format used for this catalog and add customerType in the same format
      res = addCustomerTypeToCatalog(res, catalogId, customerType);
    } else {
      // Empty catalog (no products) - remove it since we can't infer customerType
      res = removeCatalog(res, catalogId);
    }
  }

  // Step 4: Rename catalogs -> productLines
  res = renameProperty(res, "payments.catalogs", "productLines");

  // Step 5: Rename catalogId -> productLineId in products
  res = renameProperty(res, (p) => p.length === 4 && p[0] === "payments" && p[1] === "products" && p[3] === "catalogId", () => "productLineId");

  return res;
}

/**
 * Recursively collects catalogId -> customerType mappings from products.
 * Handles both nested and flat config formats.
 */
function collectCatalogCustomerTypes(
  obj: Record<string, any>,
  basePath: string[],
  result: Map<string, string>
): void {
  for (const [key, value] of typedEntries(obj)) {
    const keyParts = key.split(".");
    const fullPath = [...basePath, ...keyParts];

    // Check for flat format at ROOT level only: payments.products.<productId>.catalogId
    // We check basePath.length === 0 to ensure we're at root and key contains the full path
    if (basePath.length === 0 && fullPath.length === 4 && fullPath[0] === "payments" && fullPath[1] === "products" && fullPath[3] === "catalogId") {
      if (typeof value === "string") {
        const productId = fullPath[2];
        // Look for customerType in the same flat format
        const customerTypeKey = `payments.products.${productId}.customerType`;
        if (customerTypeKey in obj && typeof obj[customerTypeKey] === "string") {
          result.set(value, obj[customerTypeKey]);
        }
      }
    }

    // Check for nested format: payments.products.<productId> with object value
    if (fullPath.length === 3 && fullPath[0] === "payments" && fullPath[1] === "products" && isObjectLike(value)) {
      const catalogId = findPropertyValue(value, "catalogId") ?? findPropertyValue(value, "productLineId");
      const customerType = findPropertyValue(value, "customerType");
      if (catalogId && typeof catalogId === "string" && customerType && typeof customerType === "string") {
        result.set(catalogId, customerType);
      }
    }

    if (isObjectLike(value)) {
      collectCatalogCustomerTypes(value, fullPath, result);
    }
  }
}

/**
 * Finds a property value in an object, handling both direct properties and dot-notation keys.
 */
function findPropertyValue(obj: Record<string, any>, propertyName: string): any {
  // Direct property
  if (propertyName in obj) {
    return obj[propertyName];
  }
  // Check for dot-notation keys that end with the property name
  for (const key of Object.keys(obj)) {
    const parts = key.split(".");
    if (parts[parts.length - 1] === propertyName) {
      return obj[key];
    }
  }
  return undefined;
}

/**
 * Finds all catalog IDs that exist in the config.
 */
function findAllCatalogIds(
  obj: Record<string, any>,
  basePath: string[],
  result: Set<string>
): void {
  for (const [key, value] of typedEntries(obj)) {
    const keyParts = key.split(".");
    const fullPath = [...basePath, ...keyParts];

    // Check for catalog entry at payments.catalogs.<catalogId>
    if (fullPath.length >= 3 && fullPath[0] === "payments" && fullPath[1] === "catalogs") {
      const catalogId = fullPath[2];
      result.add(catalogId);
    }

    if (isObjectLike(value)) {
      findAllCatalogIds(value, fullPath, result);
    }
  }
}

/**
 * Removes a catalog from the config in any format (nested or flat).
 */
function removeCatalog(obj: Record<string, any>, catalogId: string): Record<string, any> {
  // Don't process arrays - they should be copied as-is
  if (Array.isArray(obj)) {
    return obj;
  }

  const res: Record<string, any> = {};

  for (const [key, value] of typedEntries(obj)) {
    const keyParts = key.split(".");

    // Check if this key is for the catalog we want to remove
    // Format 4: "payments.catalogs.<catalogId>.displayName" or similar flat keys
    if (keyParts.length >= 3 && keyParts[0] === "payments" && keyParts[1] === "catalogs" && keyParts[2] === catalogId) {
      // Skip this key - don't copy it
      continue;
    }

    // Format 3: "payments.catalogs.<catalogId>" as a single key
    if (key === `payments.catalogs.${catalogId}`) {
      continue;
    }

    if (Array.isArray(value)) {
      res[key] = value;
    } else if (isObjectLike(value)) {
      const processed = removeCatalog(value, catalogId);
      // Check if we need to remove the catalog from nested structures
      if (key === "payments" && isObjectLike(processed) && "catalogs" in processed) {
        const catalogs = processed.catalogs;
        if (isObjectLike(catalogs) && catalogId in catalogs) {
          const { [catalogId]: _, ...rest } = catalogs as Record<string, any>;
          res[key] = { ...processed, catalogs: rest };
          continue;
        }
      }
      // Format 2: "payments.catalogs" as a key with nested catalog
      if (key === "payments.catalogs" && isObjectLike(processed) && catalogId in processed) {
        const { [catalogId]: _, ...rest } = processed as Record<string, any>;
        res[key] = rest;
        continue;
      }
      res[key] = processed;
    } else {
      res[key] = value;
    }
  }

  return res;
}

/**
 * Adds customerType to a catalog in the appropriate format.
 */
function addCustomerTypeToCatalog(obj: Record<string, any>, catalogId: string, customerType: string): Record<string, any> {
  // Don't process arrays - they should be copied as-is
  if (Array.isArray(obj)) {
    return obj;
  }

  const res: Record<string, any> = {};

  // First, copy all existing properties
  for (const [key, value] of typedEntries(obj)) {
    if (Array.isArray(value)) {
      // Copy arrays directly without processing
      res[key] = value;
    } else if (isObjectLike(value)) {
      res[key] = addCustomerTypeToCatalog(value, catalogId, customerType);
    } else {
      res[key] = value;
    }
  }

  // Check what format the catalog uses
  // Format 1: { payments: { catalogs: { [catalogId]: { ... } } } }
  const payments = res.payments;
  if (payments && isObjectLike(payments) && !Array.isArray(payments) && typeof payments !== "function") {
    const paymentsObj = payments as Record<string, any>;
    const catalogs = paymentsObj.catalogs;
    if (catalogs && isObjectLike(catalogs) && !Array.isArray(catalogs) && typeof catalogs !== "function") {
      const catalogsObj = catalogs as Record<string, any>;
      const catalog = catalogsObj[catalogId];
      if (catalog && isObjectLike(catalog)) {
        if (!("customerType" in catalog)) {
          catalogsObj[catalogId] = { ...catalog, customerType };
        }
        return res;
      }
    }
  }

  // Format 2: { "payments.catalogs": { [catalogId]: { ... } } }
  const paymentsCatalogs = res["payments.catalogs"];
  if (paymentsCatalogs && isObjectLike(paymentsCatalogs) && !Array.isArray(paymentsCatalogs) && typeof paymentsCatalogs !== "function") {
    const catalogs = paymentsCatalogs as Record<string, any>;
    if (catalogId in catalogs && isObjectLike(catalogs[catalogId])) {
      if (!("customerType" in catalogs[catalogId])) {
        catalogs[catalogId] = { ...catalogs[catalogId], customerType };
      }
      return res;
    }
  }

  // Format 3: { "payments.catalogs.[catalogId]": { ... } }
  const catalogKey = `payments.catalogs.${catalogId}`;
  if (catalogKey in res && isObjectLike(res[catalogKey])) {
    if (!("customerType" in res[catalogKey])) {
      res[catalogKey] = { ...res[catalogKey], customerType };
    }
    return res;
  }

  // Format 4: { "payments.catalogs.[catalogId].displayName": "..." }
  // Need to add a new key for customerType
  const customerTypeKey = `payments.catalogs.${catalogId}.customerType`;
  for (const key of Object.keys(res)) {
    if (key.startsWith(`payments.catalogs.${catalogId}.`) && key !== customerTypeKey) {
      // Found a flat key for this catalog, add customerType in same format
      res[customerTypeKey] = customerType;
      return res;
    }
  }

  return res;
}

// Tests
import.meta.vitest?.test("migrateCatalogsToProductLines - basic migrations", ({ expect }) => {
  // Basic nested format
  expect(migrateCatalogsToProductLines({
    payments: {
      catalogs: {
        myCatalog: { displayName: "My Catalog" }
      },
      products: {
        myProduct: { catalogId: "myCatalog", customerType: "user", prices: {} }
      }
    }
  })).toEqual({
    payments: {
      productLines: {
        myCatalog: { displayName: "My Catalog", customerType: "user" }
      },
      products: {
        myProduct: { productLineId: "myCatalog", customerType: "user", prices: {} }
      }
    }
  });

  // Flat format
  expect(migrateCatalogsToProductLines({
    "payments.catalogs.myCatalog": { displayName: "My Catalog" },
    "payments.products.myProduct.catalogId": "myCatalog",
    "payments.products.myProduct.customerType": "user",
  })).toEqual({
    "payments.productLines.myCatalog": { displayName: "My Catalog", customerType: "user" },
    "payments.products.myProduct.productLineId": "myCatalog",
    "payments.products.myProduct.customerType": "user",
  });

  // Mixed format
  expect(migrateCatalogsToProductLines({
    payments: {
      catalogs: { myCatalog: { displayName: "My Catalog" } }
    },
    "payments.products.myProduct": { catalogId: "myCatalog", customerType: "user" }
  })).toEqual({
    payments: {
      productLines: { myCatalog: { displayName: "My Catalog", customerType: "user" } }
    },
    "payments.products.myProduct": { productLineId: "myCatalog", customerType: "user" }
  });
});

import.meta.vitest?.test("migrateCatalogsToProductLines - does not overwrite existing customerType", ({ expect }) => {
  // If catalog already has customerType, don't overwrite it
  expect(migrateCatalogsToProductLines({
    payments: {
      catalogs: {
        myCatalog: { displayName: "My Catalog", customerType: "team" }
      },
      products: {
        myProduct: { catalogId: "myCatalog", customerType: "user", prices: {} }
      }
    }
  })).toEqual({
    payments: {
      productLines: {
        myCatalog: { displayName: "My Catalog", customerType: "team" }
      },
      products: {
        myProduct: { productLineId: "myCatalog", customerType: "user", prices: {} }
      }
    }
  });
});

import.meta.vitest?.test("migrateCatalogsToProductLines - multiple catalogs and products", ({ expect }) => {
  expect(migrateCatalogsToProductLines({
    payments: {
      catalogs: {
        userPlans: { displayName: "User Plans" },
        teamPlans: { displayName: "Team Plans" }
      },
      products: {
        userBasic: { catalogId: "userPlans", customerType: "user", prices: {} },
        userPro: { catalogId: "userPlans", customerType: "user", prices: {} },
        teamBasic: { catalogId: "teamPlans", customerType: "team", prices: {} }
      }
    }
  })).toEqual({
    payments: {
      productLines: {
        userPlans: { displayName: "User Plans", customerType: "user" },
        teamPlans: { displayName: "Team Plans", customerType: "team" }
      },
      products: {
        userBasic: { productLineId: "userPlans", customerType: "user", prices: {} },
        userPro: { productLineId: "userPlans", customerType: "user", prices: {} },
        teamBasic: { productLineId: "teamPlans", customerType: "team", prices: {} }
      }
    }
  });
});

import.meta.vitest?.test("migrateCatalogsToProductLines - catalog without products is removed", ({ expect }) => {
  // Catalog without any products should be removed since we can't infer customerType
  expect(migrateCatalogsToProductLines({
    payments: {
      catalogs: {
        emptyCatalog: { displayName: "Empty" }
      },
      products: {}
    }
  })).toEqual({
    payments: {
      productLines: {},
      products: {}
    }
  });
});

import.meta.vitest?.test("migrateCatalogsToProductLines - products without catalogId", ({ expect }) => {
  // Catalogs without any products referencing them should be removed
  expect(migrateCatalogsToProductLines({
    payments: {
      catalogs: {
        myCatalog: { displayName: "My Catalog" }
      },
      products: {
        standalone: { customerType: "user", prices: {} }
      }
    }
  })).toEqual({
    payments: {
      productLines: {},
      products: {
        standalone: { customerType: "user", prices: {} }
      }
    }
  });
});

import.meta.vitest?.test("migrateCatalogsToProductLines - deeply nested flat format", ({ expect }) => {
  expect(migrateCatalogsToProductLines({
    "payments.catalogs.myCatalog.displayName": "My Catalog",
    "payments.products.myProduct.catalogId": "myCatalog",
    "payments.products.myProduct.customerType": "user",
    "payments.products.myProduct.prices": {},
  })).toEqual({
    "payments.productLines.myCatalog.displayName": "My Catalog",
    "payments.productLines.myCatalog.customerType": "user",
    "payments.products.myProduct.productLineId": "myCatalog",
    "payments.products.myProduct.customerType": "user",
    "payments.products.myProduct.prices": {},
  });
});

import.meta.vitest?.test("migrateCatalogsToProductLines - no catalogs", ({ expect }) => {
  // Config without catalogs should pass through unchanged (except productLineId rename)
  expect(migrateCatalogsToProductLines({
    payments: {
      products: {
        myProduct: { catalogId: "someCatalog", customerType: "user" }
      }
    }
  })).toEqual({
    payments: {
      products: {
        myProduct: { productLineId: "someCatalog", customerType: "user" }
      }
    }
  });
});

import.meta.vitest?.test("migrateCatalogsToProductLines - already migrated (productLines)", ({ expect }) => {
  // Already has productLines, should not change customerType
  expect(migrateCatalogsToProductLines({
    payments: {
      productLines: {
        myLine: { displayName: "My Line", customerType: "team" }
      },
      products: {
        myProduct: { productLineId: "myLine", customerType: "team" }
      }
    }
  })).toEqual({
    payments: {
      productLines: {
        myLine: { displayName: "My Line", customerType: "team" }
      },
      products: {
        myProduct: { productLineId: "myLine", customerType: "team" }
      }
    }
  });
});

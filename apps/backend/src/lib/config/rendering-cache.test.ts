import { migrateConfigOverride } from "@hexclave/shared/dist/config/schema";
import { describe, expect, it } from "vitest";
import { FrozenIdentityMemo, LruMap, getCanonicalMigratedConfigOverride } from "./rendering-cache";

describe("LruMap", () => {
  it("evicts the least-recently-used entry, counting reads as uses", () => {
    const map = new LruMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1);
    map.set("c", 3);
    expect(map.get("b")).toBeUndefined();
    expect(map.get("a")).toBe(1);
    expect(map.get("c")).toBe(3);
    expect(map.size).toBe(2);
  });

  it("overwrites existing keys without growing", () => {
    const map = new LruMap<string, number>(2);
    map.set("a", 1);
    map.set("a", 2);
    expect(map.get("a")).toBe(2);
    expect(map.size).toBe(1);
  });

  it("rejects invalid sizes", () => {
    expect(() => new LruMap<string, number>(0)).toThrow();
    expect(() => new LruMap<string, number>(1.5)).toThrow();
  });
});

describe("FrozenIdentityMemo", () => {
  it("computes once per key tuple and returns the identical frozen result", async () => {
    const memo = new FrozenIdentityMemo<{ value: number }>();
    const keyA = {};
    const keyB = {};
    let calls = 0;
    const compute = async () => ({ value: ++calls });

    const first = await memo.get([keyA, keyB], compute);
    const second = await memo.get([keyA, keyB], compute);
    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(Object.isFrozen(first)).toBe(true);

    // Key order and key identity both matter, not structural equality.
    expect(await memo.get([keyB, keyA], compute)).toEqual({ value: 2 });
    expect(await memo.get([{}, keyB], compute)).toEqual({ value: 3 });
    // A prefix of a key tuple is its own entry.
    expect(await memo.get([keyA], compute)).toEqual({ value: 4 });
  });

  it("deduplicates concurrent computations", async () => {
    const memo = new FrozenIdentityMemo<{ value: number }>();
    const key = {};
    let calls = 0;
    const results = await Promise.all(Array.from({ length: 5 }, () => memo.get([key], async () => ({ value: ++calls }))));
    expect(calls).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("does not cache rejections", async () => {
    const memo = new FrozenIdentityMemo<{ value: number }>();
    const key = {};
    await expect(memo.get([key], async () => {
      throw new Error("transient");
    })).rejects.toThrow("transient");
    expect(await memo.get([key], async () => ({ value: 1 }))).toEqual({ value: 1 });
  });

  it("does not cache results that fail to freeze", async () => {
    const memo = new FrozenIdentityMemo<object>();
    const key = {};
    await expect(memo.get([key], async () => ({ bad: new Map() }))).rejects.toThrow(/non-plain object/);
    expect(await memo.get([key], async () => ({ good: true }))).toEqual({ good: true });
  });

  it("requires at least one key", () => {
    const memo = new FrozenIdentityMemo<object>();
    expect(() => memo.get([], async () => ({}))).toThrow();
  });
});

describe("getCanonicalMigratedConfigOverride", () => {
  const branchScope = { level: "branch", projectId: "project-a", branchId: "main" } as const;
  const environmentScope = { level: "environment", projectId: "project-a", branchId: "main" } as const;

  it("returns the identical frozen object for equal content in the same scope", () => {
    const first = getCanonicalMigratedConfigOverride(branchScope, { "auth.allowSignUp": false });
    const second = getCanonicalMigratedConfigOverride({ ...branchScope }, { "auth.allowSignUp": false });
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      first["auth.allowSignUp"] = true;
    }).toThrow(TypeError);
  });

  it("never shares objects between tenancies or levels, even for identical content", () => {
    const content = { "auth.allowSignUp": false };
    const base = getCanonicalMigratedConfigOverride(branchScope, content);
    expect(getCanonicalMigratedConfigOverride({ ...branchScope, projectId: "project-b" }, content)).not.toBe(base);
    expect(getCanonicalMigratedConfigOverride({ ...branchScope, branchId: "dev" }, content)).not.toBe(base);
    expect(getCanonicalMigratedConfigOverride(environmentScope, content)).not.toBe(base);
    expect(getCanonicalMigratedConfigOverride({ level: "organization", projectId: "project-a", branchId: "main", organizationId: null }, {}))
      .not.toBe(getCanonicalMigratedConfigOverride({ level: "organization", projectId: "project-a", branchId: "main", organizationId: "org-1" }, {}));
    // The other entries did not evict or replace the first one.
    expect(getCanonicalMigratedConfigOverride(branchScope, content)).toBe(base);
  });

  it("does not confuse scopes whose IDs contain separator-like characters", () => {
    const content = { "auth.allowSignUp": true };
    const first = getCanonicalMigratedConfigOverride({ level: "branch", projectId: "a\",\"b", branchId: "c" }, content);
    expect(getCanonicalMigratedConfigOverride({ level: "branch", projectId: "a", branchId: "b\",\"c" }, content)).not.toBe(first);
  });

  it("replaces the entry when the scope's content changes", () => {
    const scope = { ...branchScope, projectId: "project-changing" };
    const v1 = getCanonicalMigratedConfigOverride(scope, { "auth.allowSignUp": false });
    const v2 = getCanonicalMigratedConfigOverride(scope, { "auth.allowSignUp": true });
    expect(v2).not.toBe(v1);
    expect(v2).toEqual(migrateConfigOverride("branch", { "auth.allowSignUp": true }));
    expect(getCanonicalMigratedConfigOverride(scope, { "auth.allowSignUp": true })).toBe(v2);
    // Only one version per scope is kept, so going back produces a fresh (equal) object.
    const v1Again = getCanonicalMigratedConfigOverride(scope, { "auth.allowSignUp": false });
    expect(v1Again).not.toBe(v1);
    expect(v1Again).toEqual(v1);
  });

  it("never freezes or aliases the caller's input", () => {
    const input = { "teams.allowClientTeamCreation": true, nested: { a: 1 } };
    const canonical = getCanonicalMigratedConfigOverride(environmentScope, input);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.nested)).toBe(false);
    input.nested.a = 2;
    expect(getCanonicalMigratedConfigOverride(environmentScope, { "teams.allowClientTeamCreation": true, nested: { a: 1 } })).toBe(canonical);
  });

  it("matches what migrateConfigOverride itself would produce", () => {
    const stored = { "auth.allowSignUp": false, "domains.allowLocalhost": true };
    expect(getCanonicalMigratedConfigOverride(environmentScope, stored)).toEqual(migrateConfigOverride("environment", stored));
  });
});

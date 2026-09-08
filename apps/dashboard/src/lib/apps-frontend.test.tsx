import { describe, expect, it } from "vitest";
import { DUMMY_ORIGIN, testItemPath, type NavigableAppFrontend } from "./apps-frontend";

const PROJECT_ID = "demo-project";

function urlFor(path: string): URL {
  return new URL(path, DUMMY_ORIGIN);
}

// Path matching only reads `href` and `navigationItems`; the presentational fields are filled with the
// cheapest valid values so the fixture stays a real AppFrontend rather than a cast.
function appWith(navigationItems: NavigableAppFrontend["navigationItems"], href = "demo-app"): NavigableAppFrontend {
  return {
    icon: () => <svg />,
    href,
    navigationItems,
    screenshots: [],
    storeDescription: <p>Fixture app.</p>,
  };
}

describe("growth navigation matching", () => {
  // Mirrors the real growth navigationItems in apps-frontend.tsx. Lifecycle and detail pages are
  // deliberately not nav items; the Overview entry claims them.
  const overview = { displayName: "Overview", href: "." };
  const experiments = { displayName: "Experiments", href: "experiments" };
  const chat = { displayName: "Chat", href: "chat" };
  // const adAccounts = { displayName: "Ad accounts", href: "ad-accounts" };
  const settings = { displayName: "Settings", href: "settings" };
  const growth = appWith([overview, experiments, chat, /* adAccounts, */ settings], "gtm");

  it("highlights Overview on lifecycle and detail pages", () => {
    for (const page of ["interview", "report", "actions/some-action-id", "briefs/some-brief-id", "ad-accounts"]) {
      expect(testItemPath(PROJECT_ID, growth, overview, urlFor(`/projects/demo-project/gtm/${page}`))).toBe(true);
    }
  });

  it("highlights each top-level page's own item, deselecting Overview", () => {
    for (const item of [experiments, chat, settings]) {
      expect(testItemPath(PROJECT_ID, growth, item, urlFor(`/projects/demo-project/gtm/${item.href}`))).toBe(true);
      expect(testItemPath(PROJECT_ID, growth, overview, urlFor(`/projects/demo-project/gtm/${item.href}`))).toBe(false);
    }
  });

  it("does not highlight sibling items on another item's page", () => {
    expect(testItemPath(PROJECT_ID, growth, chat, urlFor("/projects/demo-project/gtm/settings"))).toBe(false);
    expect(testItemPath(PROJECT_ID, growth, settings, urlFor("/projects/demo-project/gtm/chat"))).toBe(false);
  });
});

describe("testItemPath", () => {
  const overview = { displayName: "Overview", href: "." };
  const admin = { displayName: "Admin", href: "admin" };
  const demoApp = appWith([overview, admin]);

  it("marks the parent item active on its own page", () => {
    expect(testItemPath(PROJECT_ID, demoApp, overview, urlFor("/projects/demo-project/demo-app"))).toBe(true);
    expect(testItemPath(PROJECT_ID, demoApp, admin, urlFor("/projects/demo-project/demo-app"))).toBe(false);
  });

  it("deselects a parent item when a nested sibling is the page being viewed", () => {
    // The Admin page lives underneath the Overview item's own path, so a plain prefix match would light up
    // both entries in the sidebar at once.
    expect(testItemPath(PROJECT_ID, demoApp, admin, urlFor("/projects/demo-project/demo-app/admin"))).toBe(true);
    expect(testItemPath(PROJECT_ID, demoApp, overview, urlFor("/projects/demo-project/demo-app/admin"))).toBe(false);
  });

  it("keeps the parent item active on nested pages no sibling claims", () => {
    expect(testItemPath(PROJECT_ID, demoApp, overview, urlFor("/projects/demo-project/demo-app/insights/abc"))).toBe(true);
    expect(testItemPath(PROJECT_ID, demoApp, admin, urlFor("/projects/demo-project/demo-app/insights/abc"))).toBe(false);
  });

  it("keeps the parent active on the nested page's own children", () => {
    const deep = urlFor("/projects/demo-project/demo-app/admin/other-project/insights/abc");
    expect(testItemPath(PROJECT_ID, demoApp, admin, deep)).toBe(true);
    expect(testItemPath(PROJECT_ID, demoApp, overview, deep)).toBe(false);
  });

  it("leaves sibling items that do not nest alone", () => {
    const authMethods = { displayName: "Auth Methods", href: "." };
    const signUpRules = { displayName: "Sign-up Rules", href: "../sign-up-rules" };
    const auth = appWith([authMethods, signUpRules], "auth-methods");

    expect(testItemPath(PROJECT_ID, auth, authMethods, urlFor("/projects/demo-project/auth-methods"))).toBe(true);
    expect(testItemPath(PROJECT_ID, auth, signUpRules, urlFor("/projects/demo-project/auth-methods"))).toBe(false);
    expect(testItemPath(PROJECT_ID, auth, signUpRules, urlFor("/projects/demo-project/sign-up-rules"))).toBe(true);
    expect(testItemPath(PROJECT_ID, auth, authMethods, urlFor("/projects/demo-project/sign-up-rules"))).toBe(false);
  });

  it("lets an item's own matchPath decide, and never ranks it against siblings", () => {
    const custom = { displayName: "Custom", href: "custom", matchPath: (path: string) => path.includes("/demo-app/") };
    const app = appWith([overview, custom]);

    expect(testItemPath(PROJECT_ID, app, custom, urlFor("/projects/demo-project/demo-app/anything"))).toBe(true);
    // The custom item matching does not deselect the parent, since there is no path to compare it on.
    expect(testItemPath(PROJECT_ID, app, overview, urlFor("/projects/demo-project/demo-app/anything"))).toBe(true);
  });

  it("never marks an external item active", () => {
    const external = { displayName: "Docs", href: "https://docs.hexclave.com", external: true };
    const app = appWith([overview, external]);

    expect(testItemPath(PROJECT_ID, app, external, urlFor("/projects/demo-project/demo-app"))).toBe(false);
  });
});

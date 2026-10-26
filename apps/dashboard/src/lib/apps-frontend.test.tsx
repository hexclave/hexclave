import { describe, expect, it } from "vitest";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { ALL_APPS_FRONTEND, DUMMY_ORIGIN, getItemPath, testItemPath, type NavigableAppFrontend } from "./apps-frontend";

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

  it("matches TV profile navigation independently of query parameters", () => {
    const tvMode = ALL_APPS_FRONTEND["tv-mode"];
    const profiles = tvMode.navigationItems[0];
    const displays = tvMode.navigationItems[1];
    const createCopy = urlFor("/projects/demo-project/tv-mode/profiles/company-pulse?create=1");

    expect(testItemPath(PROJECT_ID, tvMode, profiles, createCopy)).toBe(true);
    expect(testItemPath(PROJECT_ID, tvMode, displays, createCopy)).toBe(false);
  });
});

describe("TV Mode navigation matching", () => {
  const projectId = "project-fixture";
  const app = ALL_APPS_FRONTEND["tv-mode"];
  const profilesItem = app.navigationItems.at(0)
    ?? throwErr("TV Mode navigation must include a profiles item");
  const displaysItem = app.navigationItems.at(1)
    ?? throwErr("TV Mode navigation must include a displays item");

  function matches(path: string) {
    const url = new URL(path, DUMMY_ORIGIN);
    return {
      profiles: testItemPath(projectId, app, profilesItem, url),
      displays: testItemPath(projectId, app, displaysItem, url),
    };
  }

  it("keeps profile and display active states mutually exclusive", () => {
    expect({
      profilesIndex: matches(`/projects/${projectId}/tv-mode`),
      profilesRoutePrefix: matches(`/projects/${projectId}/tv-mode/profiles`),
      profileDetail: matches(`/projects/${projectId}/tv-mode/profiles/company-pulse`),
      displays: matches(`/projects/${projectId}/tv-mode/displays`),
      presentation: matches(`/projects/${projectId}/tv-mode/present/company-pulse`),
    }).toMatchInlineSnapshot(`
      {
        "displays": {
          "displays": true,
          "profiles": false,
        },
        "presentation": {
          "displays": false,
          "profiles": false,
        },
        "profileDetail": {
          "displays": false,
          "profiles": true,
        },
        "profilesIndex": {
          "displays": false,
          "profiles": true,
        },
        "profilesRoutePrefix": {
          "displays": false,
          "profiles": true,
        },
      }
    `);
  });

  it("builds project-scoped profile and display destinations without a profile id", () => {
    expect(app.navigationItems.map((item) => ({
      displayName: item.displayName,
      pathname: new URL(getItemPath(projectId, app, item), DUMMY_ORIGIN).pathname,
    }))).toEqual([
      { displayName: "Profiles", pathname: `/projects/${projectId}/tv-mode/` },
      { displayName: "Displays", pathname: `/projects/${projectId}/tv-mode/displays` },
    ]);
  });
});

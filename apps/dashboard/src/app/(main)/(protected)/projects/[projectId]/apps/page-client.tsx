"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { AppSquare } from "@/components/app-square";
import { DesignAlert, DesignCard, DesignCategoryTabs, DesignInput } from "@/components/design-components";
import { type AppId } from "@/lib/apps-frontend";
import { getAppIdsForListing, getEnabledAppIds } from "@/lib/apps-utils";
import { CheckCircleIcon, MagnifyingGlassIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { ALL_APPS } from "@hexclave/shared/dist/apps/apps-config";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { useMemo, useState } from "react";
import { PageLayout } from "../page-layout";

// Simplified categories as tabs
const CATEGORIES: Array<{
  id: string,
  label: string,
  tags: string[],
  special?: boolean,
}> = [
  { id: "all", label: "All Apps", tags: [] },
  { id: "installed", label: "Installed", tags: [], special: true },
  { id: "auth", label: "Authentication", tags: ["auth"] },
  { id: "developer", label: "Developer", tags: ["developers"] },
  { id: "integration", label: "Integrations", tags: ["integration"] },
  { id: "expert", label: "Advanced", tags: ["expert", "security", "storage", "operations"] },
];

export default function PageClient() {
  const adminApp = useAdminApp()!;
  const project = adminApp.useProject();
  const config = project.useConfig();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");

  // Get installed apps
  const installedApps = useMemo(() =>
    getEnabledAppIds(config.apps.installed),
    [config.apps.installed]
  );

  // Create a Set for O(1) lookups
  const installedAppsSet = useMemo(() => new Set(installedApps), [installedApps]);
  const listedApps = useMemo(() => getAppIdsForListing(installedApps), [installedApps]);

  // Filter and categorize apps
  const filteredApps = useMemo(() => {
    let apps = [...listedApps];

    // Apply category filter
    if (selectedCategory === "installed") {
      apps = apps.filter(appId => installedApps.includes(appId));
    } else if (selectedCategory !== "all") {
      const category = CATEGORIES.find(c => c.id === selectedCategory);
      if (category && category.tags.length > 0) {
        apps = apps.filter(appId =>
          ALL_APPS[appId].tags.some((tag: string) => category.tags.includes(tag))
        );
      }
    }

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      apps = apps.filter(appId => {
        const app = ALL_APPS[appId];
        return app.displayName.toLowerCase().includes(query) ||
               app.subtitle.toLowerCase().includes(query) ||
               app.tags.some((tag: string) => tag.toLowerCase().includes(query));
      });
    }

    // Sort: installed first, then by name
    return apps.sort((a, b) => {
      const aInstalled = installedAppsSet.has(a);
      const bInstalled = installedAppsSet.has(b);
      if (aInstalled && !bInstalled) return -1;
      if (!aInstalled && bInstalled) return 1;
      return stringCompare(ALL_APPS[a].displayName, ALL_APPS[b].displayName);
    });
  }, [searchQuery, selectedCategory, installedApps, installedAppsSet, listedApps]);

  // Get count for each category
  const getCategoryCount = (categoryId: string) => {
    if (categoryId === "installed") return installedApps.length;
    if (categoryId === "all") return listedApps.length;

    const category = CATEGORIES.find(c => c.id === categoryId);
    if (!category) return 0;

    return listedApps.filter((appId) => (
      ALL_APPS[appId].tags.some((tag: string) => category.tags.includes(tag))
    )).length;
  };

  return (
    <PageLayout fillWidth allowContentOverflow>
      <div className="max-w-[1400px] mx-auto w-full px-6">
        {/* Header Section */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <SquaresFourIcon className="h-8 w-8 text-blue-600 dark:text-blue-400" />
            <h1 className="text-3xl font-semibold text-gray-900 dark:text-gray-100">
              Apps
            </h1>
          </div>
          <p className="text-gray-600 dark:text-gray-400">
            Extend your project with powerful features and integrations
          </p>
        </div>

        {/* Search and Stats Bar */}
        <div className="mb-6 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center">
          <div className="max-w-md flex-1">
            <DesignInput
              type="text"
              placeholder="Search apps..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              size="lg"
              leadingIcon={<MagnifyingGlassIcon className="h-4 w-4" />}
              className="w-full"
            />
          </div>

          {installedApps.length > 0 && (
            <DesignCard
              glassmorphic
              className="shrink-0 rounded-xl"
              contentClassName="flex h-10 items-center px-4"
            >
              <div className="flex items-center gap-2">
                <CheckCircleIcon className="h-4 w-4 text-green-600 dark:text-green-400" />
                <span className="text-sm font-medium text-green-800 dark:text-green-300">
                  {installedApps.length} app{installedApps.length !== 1 ? 's' : ''} installed
                </span>
              </div>
            </DesignCard>
          )}
        </div>

        {/* Category Tabs */}
        <DesignCategoryTabs
          categories={CATEGORIES.map((category) => ({
            id: category.id,
            label: category.label,
            count: getCategoryCount(category.id),
          }))}
          selectedCategory={selectedCategory}
          onSelect={setSelectedCategory}
          gradient="blue"
          glassmorphic={false}
          className="mb-8"
        />

        {/* Apps Grid */}
        {filteredApps.length > 0 ? (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
            {filteredApps.map(appId => (
              <AppSquare
                key={appId}
                appId={appId}
                variant={installedAppsSet.has(appId) ? "installed" : "default"}
                showSubtitle={true}
              />
            ))}
          </div>
        ) : (
          <DesignAlert
            variant="info"
            title="No apps found"
            description={
              searchQuery
                ? `No apps match "${searchQuery}". Try adjusting your search.`
                : "No apps available in this category."
            }
            className="max-w-xl"
          />
        )}
      </div>
    </PageLayout>
  );
}

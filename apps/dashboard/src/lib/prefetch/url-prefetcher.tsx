"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import { hexclaveAppInternalsSymbol } from "@hexclave/next";
import { previewTemplateSource } from "@hexclave/shared/dist/helpers/emails";
import { createCachedRegex } from "@hexclave/shared/dist/utils/regex";
import { memo, useEffect, useMemo, useState } from "react";
import { HookPrefetcher, HookPrefetcherCallback } from "./hook-prefetcher";

// note that URL prefetchers are allowed to return early before execution of all hooks (but not call hook conditionally beyond that)
// this is because we suspend the component

type UrlPrefetcher = (match: RegExpMatchArray, query: URLSearchParams, hash: string) => void | HookPrefetcherCallback[];

const usageLimitBannerPrefetchers = (itemId: "analytics_events" | "session_replays"): UrlPrefetcher[] => [
  ([_, projectId]) => {
    useAdminApp(projectId).usePlanUsage();
  },
  () => {
    useDashboardInternalUser().useTeams();
  },
  ([_, projectId]) => {
    const adminApp = useAdminApp(projectId);
    const project = adminApp.useProject();
    const planUsage = adminApp.usePlanUsage();
    const teams = useDashboardInternalUser().useTeams();
    const ownerTeam = teams.find((t) => t.id === project.ownerTeamId);
    if (planUsage.arePlanLimitsEnforced && ownerTeam != null) {
      return [
        () => {
          ownerTeam.useItem(itemId);
        },
        () => {
          ownerTeam.useProducts();
        },
      ];
    }
  },
];

const urlPrefetchers: Record<string, UrlPrefetcher[]> = {
  "/projects/*": [
    ([_, projectId]) => {
      (useAdminApp(projectId) as any)[hexclaveAppInternalsSymbol].useMetrics(false);
    },
    ([_, projectId]) => {
      useAdminApp(projectId).useUsers({ limit: 1 });
    },
    ...usageLimitBannerPrefetchers("analytics_events"),
  ],
  "/projects/*/warehouse/queries": [
    ...usageLimitBannerPrefetchers("analytics_events"),
  ],
  "/projects/*/observability/traces": [
    ...usageLimitBannerPrefetchers("analytics_events"),
  ],
  "/projects/*/observability/logs": [
    ...usageLimitBannerPrefetchers("analytics_events"),
  ],
  "/projects/*/warehouse/tables": [
    ...usageLimitBannerPrefetchers("analytics_events"),
  ],
  "/projects/*/session-replays": [
    ...usageLimitBannerPrefetchers("session_replays"),
  ],
  "/projects/*/**": [
    ([_, projectId]) => {
      useAdminApp(projectId).useProject().useConfig();
    },
  ],
  "/projects/*/users": [
    ([_, projectId]) => {
      (useAdminApp(projectId) as any)[hexclaveAppInternalsSymbol].useMetricsUserCounts();
    },
    ([_, projectId]) => {
      useAdminApp(projectId).useUsers({ limit: 1 });
    },
    ([_, projectId]) => {
      useAdminApp(projectId).useUsers({
        limit: 10,
        orderBy: "signedUpAt",
        desc: true,
        includeAnonymous: false,
      });
    },
  ],
  "/projects/*/users/*": [
    ([_, projectId, userId]) => {
      const user = useAdminApp(projectId).useUser(userId);
      if (user) {
        return [
          () => {
            user.useContactChannels();
          },
          () => {
            user.useTeams();
          },
          () => {
            user.useOAuthProviders();
          },
        ];
      }
    },
  ],
  "/projects/*/team-settings": [
    ([_, projectId]) => {
      useAdminApp(projectId).useTeamPermissionDefinitions();
    },
  ],
  "/projects/*/team-permissions": [
    ([_, projectId]) => {
      useAdminApp(projectId).useTeamPermissionDefinitions();
    },
    ([_, projectId]) => {
      useAdminApp(projectId).useProjectPermissionDefinitions();
    },
  ],
  "/projects/*/project-permissions": [
    ([_, projectId]) => {
      useAdminApp(projectId).useProjectPermissionDefinitions();
    },
    ([_, projectId]) => {
      useAdminApp(projectId).useTeamPermissionDefinitions();
    },
  ],
  "/projects/*/teams": [
    ([_, projectId]) => {
      useAdminApp(projectId).useTeams({ limit: 1 });
    },
  ],
  "/projects/*/teams/*": [
    ([_, projectId]) => {
      useAdminApp(projectId).useTeamPermissionDefinitions();
    },
    ([_, projectId]) => {
      useAdminApp(projectId).useUsers({ limit: 10 });
    },
    ([_, projectId, teamId]) => {
      const team = useAdminApp(projectId).useTeam(teamId);
      if (team) {
        return [() => {
          team.useUsers();
        }];
      }
    },
  ],
  "/projects/*/api-keys": [
    ([_, projectId]) => {
      useAdminApp(projectId).useInternalApiKeys();
    },
  ],
  "/projects/*/webhooks": [
    ([_, projectId]) => {
      useAdminApp(projectId).useSvixToken();
    },
  ],
  "/projects/*/webhooks/*": [
    ([_, projectId]) => {
      useAdminApp(projectId).useSvixToken();
    },
  ],
  "/projects/*/email-drafts": [
    ([_, projectId]) => {
      useAdminApp(projectId).useEmailDrafts();
    },
  ],
  "/projects/*/email-drafts/*": [
    ([_, projectId]) => {
      useAdminApp(projectId).useEmailDrafts();
    },
    ([_, projectId]) => {
      useAdminApp(projectId).useEmailThemes();
    },
    ([_, projectId, draftId]) => {
      const adminApp = useAdminApp(projectId);
      const draft = adminApp.useEmailDrafts().find((d) => d.id === draftId);
      if (draft) {
        return [() => {
          adminApp.useEmailPreview({
            themeId: draft.themeId,
            templateTsxSource: draft.tsxSource,
          });
        }];
      }
    },
  ],
  "/projects/*/emails": [
    ([_, projectId]) => {
      useAdminApp(projectId).useUsers({ limit: 10 });
    },
  ],
  "/projects/*/email-templates": [
    ([_, projectId]) => {
      useAdminApp(projectId).useEmailTemplates();
    },
  ],
  "/projects/*/email-templates/*": [
    ([_, projectId]) => {
      useAdminApp(projectId).useEmailTemplates();
    },
    ([_, projectId]) => {
      useAdminApp(projectId).useEmailThemes();
    },
    ([_, projectId, templateId]) => {
      const adminApp = useAdminApp(projectId);
      const template = adminApp.useEmailTemplates().find((t) => t.id === templateId);
      if (template) {
        return [() => {
          adminApp.useEmailPreview({
            themeId: template.themeId,
            templateTsxSource: template.tsxSource,
          });
        }];
      }
    },
  ],
  "/projects/*/email-themes": [
    ([_, projectId]) => {
      useAdminApp(projectId).useProject().useConfig();
    },
    ([_, projectId]) => {
      useAdminApp(projectId).useEmailThemes();
    },
    ([_, projectId]) => {
      const adminApp = useAdminApp(projectId);
      const themes = adminApp.useEmailThemes();
      return themes.map((theme) => () => {
        adminApp.useEmailPreview({
          themeId: theme.id,
          templateTsxSource: previewTemplateSource,
        });
      });
    },
  ],
  "/projects/*/email-themes/*": [
    ([_, projectId, themeId]) => {
      useAdminApp(projectId).useEmailTheme(themeId);
    },
    ([_, projectId, themeId]) => {
      const adminApp = useAdminApp(projectId);
      const theme = adminApp.useEmailTheme(themeId);
      return [() => {
        adminApp.useEmailPreview({
          themeTsxSource: theme.tsxSource,
          templateTsxSource: previewTemplateSource,
        });
      }];
    },
  ],
  "/projects/*/project-settings": [
    ([_, projectId]) => {
      useAdminApp(projectId).useProject();
    },
    ([_, projectId]) => {
      useAdminApp(projectId).useProject().useProductionModeErrors();
    },
    () => {
      useDashboardInternalUser();
    },
  ],
  "/projects/*/payments/**": [
    ([_, projectId]) => {
      useAdminApp(projectId).useStripeAccountInfo();
    },
  ],
  "/projects/*/payments/transactions": [
    ([_, projectId]) => {
      useAdminApp(projectId).useTransactions({ limit: 10 });
    },
  ],
};

function matchPrefetcherPattern(pattern: string, pathname: string) {
  // * should match anything except slashes, at least 1 character; ** should match anything including slashes, can be zero characters
  // any other character should match exactly
  // trailing slashes are ignored
  const regex = createCachedRegex(`^${
      pattern
          .replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&")
          .replace(/\*\*/g, "\u0001")
          .replace(/\*/g, "([^/]+)")
          .replace(/\u0001/g, "(.*)")
          }\/?$`);
  return regex.exec(pathname) || (!pathname.endsWith("/") && regex.exec(`${pathname}/`));
}

function getMatchingPrefetchers(url: URL) {
  if (url.origin !== window.location.origin) return [];
  return Object.entries(urlPrefetchers)
    .map(([pattern, prefetchers]) => [pattern, prefetchers, matchPrefetcherPattern(pattern, url.pathname)] as const)
    .flatMap(([_, prefetchers, match]) => match ? prefetchers.map((prefetcher) => () => prefetcher(match, url.searchParams, url.hash)) : []);
}

export const UrlPrefetcher = memo(function UrlPrefetcher(props: { href: string | URL }) {
  const [url, setUrl] = useState<URL | null>(null);
  useEffect(() => {
    setUrl(new URL(props.href.toString(), window.location.href));
  }, [props.href]);

  // Memoize callbacks to prevent unnecessary re-renders of HookPrefetcher
  const callbacks = useMemo(() => {
    if (!url) return [];
    return getMatchingPrefetchers(url);
  }, [url]);

  if (!url) return null;
  return <HookPrefetcher key={url.toString()} callbacks={callbacks} />;
});

export const DocsAppsHomeGrid = () => {
  const labelOverrides = new Map([
    ["api-keys", "API Keys"],
    ["rbac", "RBAC"],
  ]);

  const toStartCase = (value) => {
    const override = labelOverrides.get(value);
    if (override != null) {
      return override;
    }
    return value
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  };

  const fallbackApps = [
    { name: "Authentication", href: "/guides/apps/authentication/overview", iconSrc: "/images/app-icons/authentication.svg" },
    { name: "Emails", href: "/guides/apps/emails/overview", iconSrc: "/images/app-icons/emails.svg" },
    { name: "Payments", href: "/guides/apps/payments/overview", iconSrc: "/images/app-icons/payments.svg" },
    { name: "Analytics", href: "/guides/apps/analytics/overview", iconSrc: "/images/app-icons/analytics.svg" },
    { name: "Teams", href: "/guides/apps/teams/overview", iconSrc: "/images/app-icons/teams.svg" },
    { name: "RBAC", href: "/guides/apps/rbac/overview", iconSrc: "/images/app-icons/rbac.svg" },
    { name: "API Keys", href: "/guides/apps/api-keys/overview", iconSrc: "/images/app-icons/api-keys.svg" },
    { name: "Data Vault", href: "/guides/apps/data-vault/overview", iconSrc: "/images/app-icons/data-vault.svg" },
    { name: "Webhooks", href: "/guides/apps/webhooks/overview", iconSrc: "/images/app-icons/webhooks.svg" },
    { name: "Launch Checklist", href: "/guides/apps/launch-checklist/overview", iconSrc: "/images/app-icons/launch-checklist.svg" },
  ];

  const getAppsFromSidebar = () => {
    if (typeof document === "undefined") {
      return fallbackApps;
    }

    const sidebarRoot = document.querySelector("ul#sidebar-group");
    if (sidebarRoot == null) {
      return fallbackApps;
    }

    const candidateLinks = sidebarRoot.querySelectorAll('a[href^="/guides/apps/"]');
    const appItems = [];
    const seenHrefs = new Set();

    for (const link of candidateLinks) {
      const href = link.getAttribute("href");
      if (href == null || seenHrefs.has(href)) {
        continue;
      }

      const iconImage = link.querySelector("img");
      if (iconImage == null) {
        continue;
      }

      const textContent = link.textContent?.replace(/\s+/g, " ").trim();
      const slug = href.replace(/^\/guides\/apps\//, "").split("/")[0];
      const iconSrc = iconImage.getAttribute("src") ?? `/images/app-icons/${slug}.svg`;
      const name = textContent != null && textContent.length > 0 ? textContent : toStartCase(slug);

      seenHrefs.add(href);
      appItems.push({ name, href, iconSrc });
    }

    if (appItems.length === 0) {
      return fallbackApps;
    }

    return appItems;
  };

  const appLinks = getAppsFromSidebar();
  const onExploreSearchInput = (event) => {
    const input = event.currentTarget;
    const root = input.closest("[data-explore-apps-root='true']");
    if (root == null) {
      return;
    }

    const query = input.value.trim().toLowerCase();
    const cards = root.querySelectorAll("[data-explore-app-card='true']");
    let visibleCount = 0;
    for (const card of cards) {
      const appName = (card.getAttribute("data-app-name") ?? "").toLowerCase();
      const isVisible = query.length === 0 || appName.includes(query);
      card.style.display = isVisible ? "" : "none";
      if (isVisible) {
        visibleCount += 1;
      }
    }

    const emptyState = root.querySelector("[data-explore-app-empty='true']");
    if (emptyState != null) {
      emptyState.style.display = visibleCount === 0 ? "block" : "none";
    }
  };

  return (
    <div data-explore-apps-root="true" className="mt-4 rounded-2xl border border-[#d6e4ff] bg-gradient-to-b from-[#f7faff] to-[#eaf2ff] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_30px_-24px_rgba(47,79,140,0.35)] dark:border-[#1f2d45] dark:from-[#11203a] dark:to-[#070f1f] dark:shadow-[inset_0_1px_0_rgba(112,152,224,0.18),0_16px_34px_-24px_rgba(2,8,20,0.85)] sm:p-4">
      <div className="mb-3 sm:mb-4">
        <input
          type="text"
          placeholder="Search apps..."
          aria-label="Search Explore Apps"
          onInput={onExploreSearchInput}
          className="h-10 w-full rounded-xl border border-[#b9cdf4] bg-white/90 px-3 text-sm text-[#1a2d52] outline-none transition-colors duration-150 focus:border-[#7ea6ed] dark:border-[#2b4a79] dark:bg-[#0c1627] dark:text-[#d6e5ff] dark:focus:border-[#4e84d8]"
        />
      </div>
      <div className="grid grid-cols-3 gap-x-2 gap-y-3 sm:grid-cols-4 sm:gap-x-3 sm:gap-y-4 lg:grid-cols-6">
        {appLinks.map((appLink) => (
          <a
            key={appLink.name}
            href={appLink.href}
            data-explore-app-card="true"
            data-app-name={appLink.name}
            className="group flex flex-col items-center gap-2 px-1 py-0.5 no-underline"
            title={appLink.name}
          >
            <div className="relative flex h-[84px] w-[84px] items-center justify-center overflow-hidden rounded-[18px] border border-[#b8cff7] bg-gradient-to-b from-[#f2f7ff] via-[#ebf2ff] to-[#e4edff] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_7px_18px_rgba(43,76,140,0.2)] transition-[border-color,box-shadow,transform] duration-150 group-hover:transition-none group-hover:border-[#78a8f0] group-hover:shadow-[inset_0_1px_0_rgba(255,255,255,1),0_0_20px_rgba(82,138,234,0.38),0_10px_22px_rgba(43,76,140,0.24)] dark:border-[#2c4c7d]/70 dark:from-[#183155] dark:via-[#112542] dark:to-[#0a1830] dark:shadow-[inset_0_1px_0_rgba(160,200,255,0.24),0_8px_24px_rgba(2,8,20,0.62)] dark:group-hover:border-[#4f84d7] dark:group-hover:shadow-[inset_0_1px_0_rgba(188,218,255,0.42),0_0_26px_rgba(77,138,239,0.5),0_12px_30px_rgba(2,8,20,0.72)]">
              <img
                src={appLink.iconSrc}
                alt=""
                aria-hidden="true"
                className="h-[34px] w-[34px] opacity-80 brightness-0 transition-all duration-150 group-hover:transition-none group-hover:opacity-90 dark:invert dark:brightness-125 dark:opacity-95"
              />
            </div>
            <span
              className="min-h-[2.2rem] max-w-[84px] text-center text-xs font-medium leading-4 text-[#2e446f] transition-colors duration-150 group-hover:transition-none group-hover:text-[#182b50] dark:text-[#d8e7ff] dark:group-hover:text-white"
              title={appLink.name}
            >
              {appLink.name}
            </span>
          </a>
        ))}
      </div>
      <p data-explore-app-empty="true" className="mt-3 hidden text-center text-xs text-[#4a5f89] dark:text-[#8fa4cc]">
        No apps match your search.
      </p>
    </div>
  );
};

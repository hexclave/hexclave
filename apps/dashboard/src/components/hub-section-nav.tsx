"use client";

import { DesignCategoryTabs } from "@/components/design-components";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, type ComponentType, type SVGProps } from "react";
import { cn } from "@/lib/utils";

export type HubSectionNavItem = {
  id: string,
  label: string,
  href: string,
  icon?: ComponentType<SVGProps<SVGSVGElement>>,
};

export type HubSectionNavProps = {
  items: HubSectionNavItem[],
  className?: string,
  /** Match user-detail underline tabs when false; default glassmorphic pill track. */
  glassmorphic?: boolean,
};

/**
 * Hub section navigation built on DesignCategoryTabs so colors/surfaces match
 * the rest of the dashboard. Tabs are href-backed via router.push because
 * DesignCategoryTabs is onSelect-only.
 */
export function HubSectionNav(props: HubSectionNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const glassmorphic = props.glassmorphic ?? true;

  const activeId = useMemo(() => {
    const matchingItems = props.items.filter((item) =>
      pathname === item.href || pathname.startsWith(`${item.href}/`)
    );
    const activeItem = matchingItems.reduce<HubSectionNavItem | null>((best, item) => {
      if (best == null || item.href.length > best.href.length) {
        return item;
      }
      return best;
    }, null);
    return activeItem?.id ?? props.items[0]?.id ?? "";
  }, [pathname, props.items]);

  const categories = useMemo(
    () => props.items.map((item) => ({
      id: item.id,
      label: item.label,
      icon: item.icon,
    })),
    [props.items],
  );

  return (
    <DesignCategoryTabs
      className={cn("mb-1", props.className)}
      categories={categories}
      selectedCategory={activeId}
      onSelect={(id) => {
        const item = props.items.find((candidate) => candidate.id === id);
        if (item == null) {
          return;
        }
        if (item.href !== pathname) {
          router.push(item.href);
        }
      }}
      showBadge={false}
      glassmorphic={glassmorphic}
      gradient="default"
      size="sm"
    />
  );
}

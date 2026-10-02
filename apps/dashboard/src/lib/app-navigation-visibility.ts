type ProjectScopedNavigationItem = {
  internalOnly?: boolean,
};

export function isAppNavigationItemVisible(
  projectId: string,
  item: ProjectScopedNavigationItem,
): boolean {
  return item.internalOnly !== true || projectId === "internal";
}

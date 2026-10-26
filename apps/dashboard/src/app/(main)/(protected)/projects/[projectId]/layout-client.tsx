"use client";

import { usePathname } from "next/navigation";
import { isTvPresentationPath } from "@/lib/tv-mode/routes";
import SidebarLayout from "./sidebar-layout";

export default function ProjectLayoutClient({
  children,
  modal,
}: {
  children: React.ReactNode,
  modal?: React.ReactNode,
}) {
  const pathname = usePathname();

  // Presentation mode deliberately keeps the canonical project URL while
  // omitting dashboard chrome so this renderer can later run on a TV Box.
  if (isTvPresentationPath(pathname)) {
    return children;
  }

  return (
    <SidebarLayout>
      {children}
      {modal}
    </SidebarLayout>
  );
}

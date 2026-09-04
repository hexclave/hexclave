import { UrlPrefetcher } from "@/lib/prefetch/url-prefetcher";
import { AdminAppProvider } from "./use-admin-app";
import ProjectLayoutClient from "./layout-client";

export default function Layout(
  props: { children: React.ReactNode, modal?: React.ReactNode }
) {
  return (
    <AdminAppProvider>

      {/* Pre-fetch the current URL to prevent request waterfalls */}
      <UrlPrefetcher href="" />

      <ProjectLayoutClient modal={props.modal}>
        {props.children}
      </ProjectLayoutClient>
    </AdminAppProvider>
  );
}

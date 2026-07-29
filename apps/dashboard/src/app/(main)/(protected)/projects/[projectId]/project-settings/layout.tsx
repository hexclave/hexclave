import { ProjectSettingsLayoutClient } from "./layout-client";

export default function Layout(props: { children: React.ReactNode }) {
  return (
    <ProjectSettingsLayoutClient>
      {props.children}
    </ProjectSettingsLayoutClient>
  );
}

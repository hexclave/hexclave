import { AppConfigurationLayoutClient } from "./layout-client";

export default function Layout(props: { children: React.ReactNode }) {
  return (
    <AppConfigurationLayoutClient>
      {props.children}
    </AppConfigurationLayoutClient>
  );
}

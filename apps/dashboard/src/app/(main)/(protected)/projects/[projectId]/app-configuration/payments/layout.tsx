"use client";

import { AppEnabledGuard } from "../../app-enabled-guard";

export default function PaymentsAppConfigurationLayout(props: {
  children: React.ReactNode,
}) {
  return (
    <AppEnabledGuard appId="payments">
      {props.children}
    </AppEnabledGuard>
  );
}

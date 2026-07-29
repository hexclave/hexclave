"use client";

import { DesignButton, DesignCard } from "@/components/design-components";
import { Link } from "@/components/link";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import EmailThemesPageClient from "../../email-themes/page-client";
import { useProjectId } from "../../use-admin-app";

export default function PageClient() {
  const projectId = useProjectId();

  return (
    <div className="space-y-4">
      <div className="mx-auto w-full min-w-0 px-4 sm:px-6" style={{ maxWidth: 1250 }}>
        <DesignCard title="Email templates" icon={EnvelopeSimpleIcon} className="mb-2">
          <p className="text-sm text-muted-foreground mb-3">
            Edit transactional email template bodies and themes used by your project.
          </p>
          <DesignButton asChild variant="secondary" size="sm">
            <Link href={`/projects/${projectId}/email-templates`}>Open templates</Link>
          </DesignButton>
        </DesignCard>
      </div>
      <EmailThemesPageClient />
    </div>
  );
}

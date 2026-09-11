"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { Link } from "@/components/link";
import { AvatarCell, AvatarCellSkeleton } from "@/components/ui";
import type { Transaction } from "@hexclave/shared/dist/interface/crud/transactions";
import { Suspense } from "react";

type CustomerType = Transaction["customer_type"];

function UserAvatarCell({ userId, link }: { userId: string, link: boolean }) {
  const app = useAdminApp();
  const user = app.useUser(userId);

  if (!user) {
    return <AvatarCell fallback="?" />;
  }
  const inner = (
    <div className="flex items-center gap-2 max-w-40 truncate">
      <AvatarCell
        src={user.profileImageUrl ?? undefined}
        fallback={user.displayName?.charAt(0) ?? user.primaryEmail?.charAt(0) ?? "?"}
      />
      {user.displayName ?? user.primaryEmail}
    </div>
  );
  if (!link) {
    return inner;
  }
  return (
    <Link href={`/projects/${encodeURIComponent(app.projectId)}/users/${encodeURIComponent(userId)}`}>
      {inner}
    </Link>
  );
}

function TeamAvatarCell({ teamId, link }: { teamId: string, link: boolean }) {
  const app = useAdminApp();
  const team = app.useTeam(teamId);
  if (!team) {
    return <AvatarCell fallback="?" />;
  }
  const inner = (
    <div className="flex items-center gap-2 max-w-40 truncate">
      <AvatarCell
        src={team.profileImageUrl ?? undefined}
        fallback={team.displayName.charAt(0)}
      />
      {team.displayName}
    </div>
  );
  if (!link) {
    return inner;
  }
  return (
    <Link href={`/projects/${encodeURIComponent(app.projectId)}/teams/${encodeURIComponent(teamId)}`}>
      {inner}
    </Link>
  );
}

/**
 * Renders a payments customer as an avatar + name. The table links through
 * to the user/team page; the glanceable details dialog does not — that
 * dialog already has one navigation action (open this transaction).
 */
export function CustomerCell(props: { customerType: CustomerType, customerId: string, link?: boolean }) {
  const link = props.link !== false;
  if (props.customerType === "user") {
    return (
      <Suspense fallback={<AvatarCellSkeleton className="max-w-40" />}>
        <UserAvatarCell userId={props.customerId} link={link} />
      </Suspense>
    );
  }
  if (props.customerType === "team") {
    return (
      <Suspense fallback={<AvatarCellSkeleton className="max-w-40" />}>
        <TeamAvatarCell teamId={props.customerId} link={link} />
      </Suspense>
    );
  }
  return (
    <span>
      <span className="capitalize">{props.customerType}</span>: {props.customerId}
    </span>
  );
}

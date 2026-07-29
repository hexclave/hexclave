"use client";

import { TeamSearchTable } from "@/components/data-table/team-search-table";
import { DesignCategoryTabs, DesignEditableGrid, DesignMenu, type DesignCategoryTabItem, type DesignEditableGridItem, type DesignMenuActionItem } from "@/components/design-components";
import { EditableInput } from "@/components/editable-input";
import { FormDialog, SmartFormDialog } from "@/components/form-dialog";
import { InputField, SelectField } from "@/components/form-fields";
import { Link } from "@/components/link";
import { MetadataSection } from "@/components/metadata-editor";
import { useRouter } from "@/components/router";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  ActionCell,
  ActionDialog,
  Alert,
  AlertDescription,
  AlertTitle,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Typography,
  useToast
} from "@/components/ui";
import { DeleteUserDialog, ImpersonateUserDialog } from "@/components/user-dialogs";
import { ALL_APPS_FRONTEND } from "@/lib/apps-frontend";
import { isAppEnabled } from "@/lib/apps-utils";
import { parseRiskScore } from "@/lib/risk-score-utils";
import { useUserActivityOrThrow } from "@/lib/hexclave-app-internals";
import { AtIcon, CalendarIcon, CheckIcon, DatabaseIcon, EnvelopeIcon, GlobeIcon, HashIcon, PlusIcon, ProhibitIcon, ShieldIcon, SquareIcon, XIcon } from "@phosphor-icons/react";
import { type DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { ServerContactChannel, ServerOAuthProvider, ServerTeam, ServerUser } from "@hexclave/next";
import { KnownErrors } from "@hexclave/shared";
import { AppId } from "@hexclave/shared/dist/apps/apps-config";
import { normalizeCountryCode } from "@hexclave/shared/dist/schema-fields";
import { fromNow } from "@hexclave/shared/dist/utils/dates";
import { captureError, HexclaveAssertionError, throwErr } from '@hexclave/shared/dist/utils/errors';
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as yup from "yup";
import { AppEnabledGuard } from "../../app-enabled-guard";
import { PageLayout } from "../../page-layout";
import { useAdminApp } from "../../use-admin-app";
import { UserAnalyticsSection } from "./user-analytics";
import { UserPageTableSection } from "./user-page-table-section";
import { UserPaymentsSection } from "./user-payments";
import { UserEmailsSection } from "./user-emails";
import dynamic from "next/dynamic";

// The session-replays page is ~2k LOC and pulls rrweb in via dynamic imports.
// Lazy-load it so the user-detail bundle doesn't pay that cost just because
// the Replays tab *might* be opened.
const SessionReplaysPageClient = dynamic(
  () => import("../../session-replays/page-client"),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        Loading session replays…
      </div>
    ),
  },
);

const userMetadataDocsUrl = "https://docs.hexclave.com/guides/getting-started/user-fundamentals#custom-metadata";

export default function PageClient({ userId }: { userId: string }) {
  const hexclaveAdminApp = useAdminApp();
  const user = hexclaveAdminApp.useUser(userId);

  if (user === null) {
    return (
      <AppEnabledGuard appId="authentication">
        <PageLayout title="User Not Found">
          User Not Found
        </PageLayout>
      </AppEnabledGuard>
    );
  }

  return (
    <AppEnabledGuard appId="authentication">
      <UserPage user={user} />
    </AppEnabledGuard>
  );
}

type UserHeaderProps = {
  user: ServerUser,
};

function UserHeader({ user }: UserHeaderProps) {
  const nameFallback = user.primaryEmail ?? user.id;
  const name = user.displayName ?? nameFallback;
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [restrictionDialogOpen, setRestrictionDialogOpen] = useState(false);
  const [impersonateOpen, setImpersonateOpen] = useState(false);
  const hexclaveAdminApp = useAdminApp();

  return (
    <div className="flex min-w-0 gap-4 items-center">
      <Avatar className="w-20 h-20 shrink-0">
        <AvatarImage src={user.profileImageUrl ?? undefined} alt={name} />
        <AvatarFallback>{name.slice(0, 2)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <EditableInput
          value={name}
          initialEditValue={user.displayName ?? ""}
          placeholder={nameFallback}
          shiftTextToLeft
          inputClassName="font-semibold text-3xl"
          onUpdate={async (newName) => {
            await user.setDisplayName(newName);
          }}/>
        <p>Last active {fromNow(user.lastActiveAt)}</p>
      </div>
      <div className="flex items-center gap-2">
        <DesignMenu
          variant="actions"
          trigger="icon"
          triggerLabel="User actions"
          align="end"
          items={[
            {
              id: "impersonate",
              label: "Impersonate",
              onClick: () => setImpersonateOpen(true),
            },
            ...user.isMultiFactorRequired ? [{
              id: "remove-2fa",
              label: "Remove 2FA",
              onClick: () => {
                runAsynchronouslyWithAlert(async () => {
                  await user.update({ totpMultiFactorSecret: null });
                });
              },
            }] satisfies DesignMenuActionItem[] : [],
            {
              id: "restriction",
              label: getRestrictionActionLabel(user),
              onClick: () => { setRestrictionDialogOpen(true); },
            },
            {
              id: "delete",
              label: "Delete",
              itemVariant: "destructive" as const,
              onClick: () => setIsDeleteModalOpen(true),
            },
          ]}
        />
        <RestrictionDialog user={user} open={restrictionDialogOpen} onOpenChange={setRestrictionDialogOpen} />
        <DeleteUserDialog
          user={user}
          open={isDeleteModalOpen}
          onOpenChange={setIsDeleteModalOpen}
          profileHref={`/projects/${encodeURIComponent(hexclaveAdminApp.projectId)}/users/${encodeURIComponent(user.id)}`}
          redirectTo={`/projects/${encodeURIComponent(hexclaveAdminApp.projectId)}/users`}
        />
        <ImpersonateUserDialog user={user} adminApp={hexclaveAdminApp} open={impersonateOpen} onClose={() => setImpersonateOpen(false)} />
      </div>
    </div>
  );
}

// Get the human-readable restriction reason
function getRestrictionReasonText(user: ServerUser): string {
  const restrictedReason = user.restrictedReason;
  if (!restrictedReason) return '';

  switch (restrictedReason.type) {
    case 'anonymous': {
      return 'Anonymous user';
    }
    case 'email_not_verified': {
      return 'Unverified email';
    }
    case 'restricted_by_administrator': {
      return 'Manually restricted';
    }
    default: {
      return 'Restricted';
    }
  }
}

function getRestrictionActionLabel(user: ServerUser): string {
  if (user.restrictedByAdmin) {
    return "Edit or remove manual restriction";
  }
  if (user.isRestricted) {
    return "Add manual restriction";
  }
  return "Restrict user";
}

function getManualRestrictionStatusText(user: ServerUser): string {
  if (user.restrictedByAdmin) {
    return "Restricted by admin";
  }
  if (user.isRestricted) {
    return `Not manually restricted (${getRestrictionReasonText(user)})`;
  }
  return "Not restricted";
}

// Restriction dialog for editing restriction details
function RestrictionDialog({
  user,
  open,
  onOpenChange,
}: {
  user: ServerUser,
  open: boolean,
  onOpenChange: (open: boolean) => void,
}) {
  const [publicReason, setPublicReason] = useState(user.restrictedByAdminReason ?? '');
  const [privateDetails, setPrivateDetails] = useState(user.restrictedByAdminPrivateDetails ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { toast } = useToast();

  // Reset form when dialog opens
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      setPublicReason(user.restrictedByAdminReason ?? '');
      setPrivateDetails(user.restrictedByAdminPrivateDetails ?? '');
      setSubmitError(null);
    }
    onOpenChange(newOpen);
  };

  const handleSaveAndRestrict = async () => {
    const trimmedPublicReason = publicReason.trim();
    const trimmedPrivateDetails = privateDetails.trim();

    setIsSaving(true);
    setSubmitError(null);
    try {
      await user.update({
        restrictedByAdmin: true,
        restrictedByAdminReason: trimmedPublicReason.length > 0 ? trimmedPublicReason : null,
        restrictedByAdminPrivateDetails: trimmedPrivateDetails.length > 0 ? trimmedPrivateDetails : null,
      });
      toast({ title: "User restricted", variant: "success" });
      onOpenChange(false);
    } catch (error) {
      captureError(`user-restriction-save-and-restrict-error`, new HexclaveAssertionError(`Failed to save and restrict user ${user.id}`, { cause: error }));
      setSubmitError(error instanceof Error && error.message ? error.message : "Failed to save the restriction. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveRestriction = async () => {
    setIsSaving(true);
    setSubmitError(null);
    try {
      await user.update({
        restrictedByAdmin: false,
        restrictedByAdminReason: null,
        restrictedByAdminPrivateDetails: null,
      });
      toast({ title: "Restriction removed", variant: "success" });
      onOpenChange(false);
    } catch (error) {
      captureError(`user-restriction-remove-error`, new HexclaveAssertionError(`Failed to remove restriction for user ${user.id}`, { cause: error }));
      setSubmitError(error instanceof Error && error.message ? error.message : "Failed to remove the restriction. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>User Restriction</DialogTitle>
          <DialogDescription>
            {user.restrictedByAdmin
              ? "This user is manually restricted. You can update the notes or remove the manual restriction."
              : "Use a manual restriction to block this user from accessing your app by default. You can optionally provide a public reason shown to the user."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Public reason (shown to user)</label>
            <Input
              value={publicReason}
              onChange={(e) => setPublicReason(e.target.value)}
              placeholder="Optional message visible to the user"
              disabled={isSaving}
            />
          </div>
          <div className="hexclave-sensitive flex flex-col gap-2">
            <label className="text-sm font-medium">Private details (internal only, optional)</label>
            <Textarea
              value={privateDetails}
              onChange={(e) => setPrivateDetails(e.target.value)}
              placeholder="Internal notes, e.g., which sign-up rule triggered"
              className="min-h-[80px]"
              disabled={isSaving}
            />
          </div>
        </div>
        {submitError && (
          <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {submitError}
          </div>
        )}
        <DialogFooter className="flex-col sm:flex-row gap-2">
          {user.restrictedByAdmin && (
            <Button
              variant="outline"
              onClick={handleRemoveRestriction}
              disabled={isSaving}
              className="sm:mr-auto"
            >
              Remove manual restriction
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveAndRestrict}
            disabled={isSaving}
          >
            Save &amp; restrict user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Restriction banner shown at top of page when user is restricted
function RestrictionBanner({ user }: { user: ServerUser }) {
  const [restrictionDialogOpen, setRestrictionDialogOpen] = useState(false);

  if (!user.isRestricted) return null;

  const reasonText = getRestrictionReasonText(user);

  return (
    <>
      <Alert variant="destructive" className="mb-4">
        <ProhibitIcon size={16} />
        <AlertTitle>This user is currently restricted</AlertTitle>
        <AlertDescription className="mt-2">
          <p className="mb-2">
            Restricted users cannot access your app by default. This user is restricted because: <strong>{reasonText}</strong>.
          </p>
          {user.restrictedReason?.type === 'email_not_verified' && (
            <p className="text-sm opacity-80">
              The user needs to verify their email address to remove this restriction.
            </p>
          )}
          {user.restrictedReason?.type === 'anonymous' && (
            <p className="text-sm opacity-80">
              Anonymous users must sign up with credentials to remove this restriction.
            </p>
          )}
          {user.restrictedReason?.type === 'restricted_by_administrator' && (
            <div className="text-sm opacity-80">
              <p>This user was manually restricted by an administrator.</p>
              {user.restrictedByAdminReason && (
                <p className="mt-1"><strong>Public reason:</strong> {user.restrictedByAdminReason}</p>
              )}
              {user.restrictedByAdminPrivateDetails && (
                <p className="hexclave-sensitive mt-1"><strong>Private details:</strong> {user.restrictedByAdminPrivateDetails}</p>
              )}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRestrictionDialogOpen(true)}
            className="mt-3"
          >
            {getRestrictionActionLabel(user)}
          </Button>
        </AlertDescription>
      </Alert>
      <RestrictionDialog user={user} open={restrictionDialogOpen} onOpenChange={setRestrictionDialogOpen} />
    </>
  );
}

function UserDetails({ user }: { user: ServerUser }) {
  const items = useMemo<DesignEditableGridItem[]>(() => [
    {
      type: "text",
      icon: <HashIcon size={14} />,
      name: "User ID",
      value: user.id,
      readOnly: true,
    },
    {
      type: "text",
      icon: <EnvelopeIcon size={14} />,
      name: "Primary email",
      value: user.primaryEmail ?? "",
      placeholder: "-",
      readOnly: true,
    },
    {
      type: "text",
      icon: <AtIcon size={14} />,
      name: "Display name",
      value: user.displayName ?? "",
      placeholder: "-",
      onUpdate: async (newName) => {
        await user.setDisplayName(newName);
      },
    },
    {
      type: "text",
      icon: <SquareIcon size={14} />,
      name: "Password",
      value: "",
      placeholder: user.hasPassword ? "************" : "-",
      onUpdate: async (newPassword) => {
        await user.setPassword({ password: newPassword });
      },
    },
    {
      type: "text",
      icon: <ShieldIcon size={14} />,
      name: "2-factor auth",
      value: user.isMultiFactorRequired ? "Enabled" : "",
      placeholder: "Disabled",
      readOnly: true,
    },
    {
      type: "text",
      icon: <CalendarIcon size={14} />,
      name: "Signed up at",
      value: user.signedUpAt.toDateString(),
      readOnly: true,
    },
  ], [user]);

  return (
    <DesignEditableGrid
      items={items}
      columns={2}
      size="sm"
      deferredSave={false}
    />
  );
}

function FraudSection({ user }: { user: ServerUser }) {
  const [restrictionDialogOpen, setRestrictionDialogOpen] = useState(false);
  const items = useMemo<DesignEditableGridItem[]>(() => [
    {
      type: "custom",
      icon: <ProhibitIcon size={14} />,
      name: "Manual restriction",
      children: (
        <span className={cn(
          "text-sm",
          user.restrictedByAdmin ? "font-medium text-destructive" : "text-muted-foreground",
        )}>
          {getManualRestrictionStatusText(user)}
        </span>
      ),
    },
    {
      type: "text",
      icon: <ShieldIcon size={14} />,
      name: "Risk score: bot",
      value: String(user.riskScores.signUp.bot),
      onUpdate: async (newValue) => {
        await user.update({
          riskScores: {
            signUp: {
              bot: parseRiskScore(newValue),
              freeTrialAbuse: user.riskScores.signUp.freeTrialAbuse,
            },
          },
        });
      },
    },
    {
      type: "text",
      icon: <ShieldIcon size={14} />,
      name: "Risk score: free trial abuse",
      value: String(user.riskScores.signUp.freeTrialAbuse),
      onUpdate: async (newValue) => {
        await user.update({
          riskScores: {
            signUp: {
              bot: user.riskScores.signUp.bot,
              freeTrialAbuse: parseRiskScore(newValue),
            },
          },
        });
      },
    },
    {
      type: "text",
      icon: <GlobeIcon size={14} />,
      name: "Sign-up country code",
      value: user.countryCode ?? "",
      placeholder: "-",
      normalizeInput: (value) => value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2),
      onUpdate: async (newValue) => {
        await user.update({
          countryCode: newValue.length > 0 ? normalizeCountryCode(newValue) : null,
        });
      },
    },
  ], [user]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Fraud
        </h2>
        <Button
          variant={user.restrictedByAdmin ? "outline" : "destructive"}
          size="sm"
          onClick={() => setRestrictionDialogOpen(true)}
        >
          {getRestrictionActionLabel(user)}
        </Button>
      </div>
      <DesignEditableGrid
        items={items}
        columns={2}
        size="sm"
        deferredSave={false}
      />
      <RestrictionDialog user={user} open={restrictionDialogOpen} onOpenChange={setRestrictionDialogOpen} />
    </section>
  );
}

type ContactChannelsSectionProps = {
  user: ServerUser,
};

function BooleanStatusCell({ value, showFalseIcon = true }: { value: boolean, showFalseIcon?: boolean }) {
  return (
    <div className="flex justify-center">
      <span className="sr-only">{value ? "Yes" : "No"}</span>
      {value ? (
        <CheckIcon aria-hidden={true} className="mx-auto h-4 w-4 text-green-500" />
      ) : showFalseIcon ? (
        <XIcon aria-hidden={true} className="mx-auto h-4 w-4 text-muted-foreground" />
      ) : null}
    </div>
  );
}

type AddEmailDialogProps = {
  user: ServerUser,
  open: boolean,
  onOpenChange: (open: boolean) => void,
};

function AddEmailDialog({ user, open, onOpenChange }: AddEmailDialogProps) {
  const formSchema = yup.object({
    email: yup.string()
      .email("Please enter a valid e-mail address")
      .defined("E-mail is required")
      .label("E-mail")
      .meta({
        stackFormFieldPlaceholder: "Enter e-mail address",
      }),
    isVerified: yup.boolean()
      .default(false)
      .label("Set as verified")
      .meta({
        description: "E-mails verified by verification emails. Can be used for OTP/magic links"
      }),
    isPrimary: yup.boolean()
      .default(false)
      .label("Set as primary")
      .meta({
        description: "Make this the primary e-mail for the user"
      }),
    isUsedForAuth: yup.boolean()
      .default(false)
      .label("Used for sign-in")
      .meta({
        description: "Allow this e-mail to be used for password sign-in. Also enables OTP/magic links if the e-mail is verified."
      }),
  });

  return (
    <SmartFormDialog
      title="Add E-mail"
      description="Add a new e-mail address to this user account."
      open={open}
      onOpenChange={onOpenChange}
      formSchema={formSchema}
      onSubmit={async (values) => {
        if (!values.email.trim()) return;

        await user.createContactChannel({
          type: 'email',
          value: values.email.trim(),
          isVerified: values.isVerified,
          isPrimary: values.isPrimary,
          usedForAuth: values.isUsedForAuth
        });
      }}
    />
  );
}

type SendVerificationEmailDialogProps = {
  channel: ServerContactChannel,
  open: boolean,
  onOpenChange: (open: boolean) => void,
};

type SendResetPasswordEmailDialogProps = {
  channel: ServerContactChannel,
  open: boolean,
  onOpenChange: (open: boolean) => void,
};

type SendSignInInvitationDialogProps = {
  channel: ServerContactChannel,
  open: boolean,
  onOpenChange: (open: boolean) => void,
};

type DomainSelectorProps = {
  control: any,
  watch: any,
  domains: Array<{ domain: string, handlerPath: string }>,
  allowLocalhost: boolean,
};

function DomainSelector({ control, watch, domains, allowLocalhost }: DomainSelectorProps) {
  return (
    <>
      <SelectField
        control={control}
        name="selected"
        label="Domain"
        options={[
          ...domains.map((domain, index) => ({ value: index.toString(), label: domain.domain })),
          ...(allowLocalhost ? [{ value: "localhost", label: "localhost" }] : [])
        ]}
      />
      {watch("selected") === "localhost" && (
        <>
          <InputField
            control={control}
            name="localhostPort"
            label="Localhost Port"
            placeholder="3000"
            type="number"
          />
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="item-1">
              <AccordionTrigger>Advanced</AccordionTrigger>
              <AccordionContent className="flex flex-col gap-8">
                <div className="flex flex-col gap-2">
                  <InputField
                    label="Handler path"
                    name="handlerPath"
                    control={control}
                    placeholder='/handler'
                  />
                  <Typography variant="secondary" type="footnote">
                    Only modify this if you changed the default handler path in your app
                  </Typography>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </>
      )}
    </>
  );
}

type SendEmailWithDomainDialogProps = {
  title: string,
  description: string,
  open: boolean,
  onOpenChange: (open: boolean) => void,
  endpointPath: string,
  onSubmit: (callbackUrl: string) => Promise<void>,
};

function SendEmailWithDomainDialog({
  title,
  description,
  open,
  onOpenChange,
  endpointPath,
  onSubmit
}: SendEmailWithDomainDialogProps) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const domains = project.config.domains;

  return (
    <FormDialog
      title={title}
      description={description}
      open={open}
      onOpenChange={onOpenChange}
      formSchema={yup.object({
        selected: yup.string().defined(),
        localhostPort: yup.number().test("required-if-localhost", "Required if localhost is selected", (value, context) => {
          return context.parent.selected === "localhost" ? value !== undefined : true;
        }),
        handlerPath: yup.string().optional(),
      })}
      okButton={{
        label: "Send",
      }}
      render={({ control, watch }) => (
        <DomainSelector
          control={control}
          watch={watch}
          domains={domains}
          allowLocalhost={project.config.allowLocalhost}
        />
      )}
      onSubmit={async (values) => {
        let baseUrl: string;
        let handlerPath: string;
        if (values.selected === "localhost") {
          baseUrl = `http://localhost:${values.localhostPort}`;
          handlerPath = values.handlerPath || '/handler';
        } else {
          const domain = domains[parseInt(values.selected)];
          baseUrl = domain.domain;
          handlerPath = domain.handlerPath;
        }
        const callbackUrl = new URL(handlerPath.replace(/\/?$/, '/') + endpointPath.replace(/^\//, ''), baseUrl).toString();
        await onSubmit(callbackUrl);
      }}
    />
  );
}

function SendVerificationEmailDialog({ channel, open, onOpenChange }: SendVerificationEmailDialogProps) {
  return (
    <SendEmailWithDomainDialog
      title="Send Verification Email"
      description={`Send a verification email to ${channel.value}? The email will contain a callback link to your domain.`}
      open={open}
      onOpenChange={onOpenChange}
      endpointPath="/email-verification"
      onSubmit={async (callbackUrl) => {
        await channel.sendVerificationEmail({ callbackUrl });
      }}
    />
  );
}

function SendResetPasswordEmailDialog({ channel, open, onOpenChange }: SendResetPasswordEmailDialogProps) {
  const hexclaveAdminApp = useAdminApp();

  return (
    <SendEmailWithDomainDialog
      title="Send Reset Password Email"
      description={`Send a password reset email to ${channel.value}? The email will contain a callback link to your domain.`}
      open={open}
      onOpenChange={onOpenChange}
      endpointPath="/password-reset"
      onSubmit={async (callbackUrl) => {
        await hexclaveAdminApp.sendForgotPasswordEmail(channel.value, { callbackUrl });
      }}
    />
  );
}

function SendSignInInvitationDialog({ channel, open, onOpenChange }: SendSignInInvitationDialogProps) {
  const hexclaveAdminApp = useAdminApp();

  return (
    <SendEmailWithDomainDialog
      title="Send Sign-In Invitation"
      description={`Send a sign-in invitation email to ${channel.value}? The email will contain a callback link to your domain.`}
      open={open}
      onOpenChange={onOpenChange}
      endpointPath="/sign-in"
      onSubmit={async (callbackUrl) => {
        await hexclaveAdminApp.sendSignInInvitationEmail(channel.value, callbackUrl);
      }}
    />
  );
}

function ContactChannelsSection({ user }: ContactChannelsSectionProps) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const contactChannels = user.useContactChannels();
  const [isAddEmailDialogOpen, setIsAddEmailDialogOpen] = useState(false);
  const [sendVerificationEmailDialog, setSendVerificationEmailDialog] = useState<{
    channel: ServerContactChannel,
    isOpen: boolean,
  } | null>(null);
  const [sendResetPasswordEmailDialog, setSendResetPasswordEmailDialog] = useState<{
    channel: ServerContactChannel,
    isOpen: boolean,
  } | null>(null);
  const [sendSignInInvitationDialog, setSendSignInInvitationDialog] = useState<{
    channel: ServerContactChannel,
    isOpen: boolean,
  } | null>(null);

  const toggleUsedForAuth = async (channel: ServerContactChannel) => {
    await channel.update({ usedForAuth: !channel.usedForAuth });
  };

  const toggleVerified = async (channel: ServerContactChannel) => {
    await channel.update({ isVerified: !channel.isVerified });
  };

  const setPrimaryEmail = async (channel: ServerContactChannel) => {
    await channel.update({ isPrimary: true });
  };

  const contactChannelColumns = useMemo<DataGridColumnDef<ServerContactChannel>[]>(() => [
    {
      id: "value",
      accessor: "value",
      header: "E-Mail",
      width: 220,
      flex: 1,
      sortable: false,
    },
    {
      id: "isPrimary",
      header: "Primary",
      width: 90,
      align: "center",
      sortable: false,
      renderCell: ({ row }) => (
        <BooleanStatusCell value={row.isPrimary} showFalseIcon={false} />
      ),
    },
    {
      id: "isVerified",
      header: "Verified",
      width: 90,
      align: "center",
      sortable: false,
      renderCell: ({ row }) => (
        <BooleanStatusCell value={row.isVerified} />
      ),
    },
    {
      id: "usedForAuth",
      header: "Used for sign-in",
      width: 140,
      align: "center",
      sortable: false,
      renderCell: ({ row }) => (
        <BooleanStatusCell value={row.usedForAuth} />
      ),
    },
    {
      id: "actions",
      header: "",
      width: 56,
      minWidth: 56,
      maxWidth: 56,
      sortable: false,
      hideable: false,
      resizable: false,
      align: "right",
      renderCell: ({ row }) => {
        const channel = row;
        return (
          <div className="flex justify-end">
            <ActionCell
              items={[
                {
                  item: "Send sign-in invitation",
                  onClick: async () => {
                    setSendSignInInvitationDialog({ channel, isOpen: true });
                  },
                },
                ...(!channel.isVerified ? [{
                  item: "Send verification email",
                  onClick: async () => {
                    setSendVerificationEmailDialog({ channel, isOpen: true });
                  },
                }] : []),
                ...(project.config.credentialEnabled ? [{
                  item: "Send reset password email",
                  onClick: async () => {
                    setSendResetPasswordEmailDialog({ channel, isOpen: true });
                  },
                }] : []),
                {
                  item: channel.isVerified ? "Mark as unverified" : "Mark as verified",
                  onClick: () => { runAsynchronouslyWithAlert(() => toggleVerified(channel)); },
                },
                ...(!channel.isPrimary ? [{
                  item: "Set as primary",
                  onClick: () => { runAsynchronouslyWithAlert(() => setPrimaryEmail(channel)); },
                }] : []),
                {
                  item: channel.usedForAuth ? "Disable for sign-in" : "Enable for sign-in",
                  onClick: () => { runAsynchronouslyWithAlert(() => toggleUsedForAuth(channel)); },
                },
                {
                  item: "Delete",
                  danger: true,
                  onClick: () => { runAsynchronouslyWithAlert(() => channel.delete()); },
                },
              ]}
            />
          </div>
        );
      },
    },
  ], [project.config.credentialEnabled]);

  return (
    <>
      <AddEmailDialog
        user={user}
        open={isAddEmailDialogOpen}
        onOpenChange={setIsAddEmailDialogOpen}
      />

      {sendVerificationEmailDialog && (
        <SendVerificationEmailDialog
          channel={sendVerificationEmailDialog.channel}
          open={sendVerificationEmailDialog.isOpen}
          onOpenChange={(open) => {
            if (!open) {
              setSendVerificationEmailDialog(null);
            }
          }}
        />
      )}

      {sendResetPasswordEmailDialog && (
        <SendResetPasswordEmailDialog
          channel={sendResetPasswordEmailDialog.channel}
          open={sendResetPasswordEmailDialog.isOpen}
          onOpenChange={(open) => {
            if (!open) {
              setSendResetPasswordEmailDialog(null);
            }
          }}
        />
      )}

      {sendSignInInvitationDialog && (
        <SendSignInInvitationDialog
          channel={sendSignInInvitationDialog.channel}
          open={sendSignInInvitationDialog.isOpen}
          onOpenChange={(open) => {
            if (!open) {
              setSendSignInInvitationDialog(null);
            }
          }}
        />
      )}

      <UserPageTableSection
        title="Contact Channels"
        urlStateKey="contactch"
        columns={contactChannelColumns}
        rows={contactChannels}
        getRowId={(channel) => channel.id}
        emptyLabel="No contact channels"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsAddEmailDialogOpen(true)}
          >
            Add E-mail
          </Button>
        }
      />
    </>
  );
}

const MEMBER_AVATAR_LIMIT = 3;

function TeamMembersAvatarsFallback() {
  return (
    <div className="flex items-center">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-7 w-7 rounded-full border-2 border-background"
          style={{ marginLeft: i === 0 ? 0 : -10 }}
        />
      ))}
    </div>
  );
}

function TeamMembersAvatars({ team, onMemberClick }: { team: ServerTeam, onMemberClick: (userId: string) => void }) {
  const members = team.useUsers();

  if (members.length === 0) {
    return <span className="text-xs text-muted-foreground">No members</span>;
  }

  const visible = members.slice(0, MEMBER_AVATAR_LIMIT);
  const remaining = members.length - visible.length;

  return (
    <div
      className="group/avatars flex items-center"
      onClick={(e) => e.stopPropagation()}
    >
      {visible.map((member, index) => {
        const name = member.displayName ?? member.primaryEmail ?? member.id;
        return (
          <Tooltip key={member.id} delayDuration={0}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`View ${name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onMemberClick(member.id);
                }}
                className={cn(
                  "relative rounded-full transition-[margin,transform] duration-200 ease-out hover:z-20 hover:scale-110 focus:z-20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  index === 0 ? "ml-0" : "-ml-2.5 group-hover/avatars:ml-1",
                )}
                style={{ zIndex: visible.length - index }}
              >
                <Avatar className="h-7 w-7 border-2 border-background">
                  <AvatarImage src={member.profileImageUrl ?? undefined} alt={name} />
                  <AvatarFallback className="text-[10px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {name}
            </TooltipContent>
          </Tooltip>
        );
      })}
      {remaining > 0 && (
        <div
          className="-ml-2.5 group-hover/avatars:ml-1 transition-[margin] duration-200 ease-out flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-background bg-muted px-1.5 text-[10px] font-medium text-muted-foreground"
          aria-label={`${remaining} more members`}
        >
          +{remaining}
        </div>
      )}
    </div>
  );
}

function UserTeamsSection({ user }: { user: ServerUser }) {
  const hexclaveAdminApp = useAdminApp();
  const router = useRouter();
  const [sortDesc, setSortDesc] = useState<boolean | undefined>(undefined);
  const teams = user.useTeams(sortDesc === undefined ? undefined : { orderBy: 'createdAt', desc: sortDesc });
  const [addTeamDialogOpen, setAddTeamDialogOpen] = useState(false);
  const [teamToRemove, setTeamToRemove] = useState<ServerTeam | null>(null);

  const navigateToTeam = useCallback((teamId: string) => {
    router.push(`/projects/${encodeURIComponent(hexclaveAdminApp.projectId)}/teams/${encodeURIComponent(teamId)}`);
  }, [router, hexclaveAdminApp.projectId]);

  const navigateToUser = useCallback((targetUserId: string) => {
    router.push(`/projects/${encodeURIComponent(hexclaveAdminApp.projectId)}/users/${encodeURIComponent(targetUserId)}`);
  }, [router, hexclaveAdminApp.projectId]);

  const teamColumns = useMemo<DataGridColumnDef<ServerTeam>[]>(() => [
    {
      id: "id",
      accessor: "id",
      header: "Team ID",
      width: 180,
      sortable: false,
      renderCell: ({ row }) => (
        <div className="font-mono text-xs bg-muted px-2 py-1 rounded max-w-[180px] truncate">
          {row.id}
        </div>
      ),
    },
    {
      id: "displayName",
      accessor: "displayName",
      header: "Display Name",
      width: 220,
      flex: 1,
      sortable: false,
      renderCell: ({ row }) => (
        <span className="font-medium">{row.displayName || '-'}</span>
      ),
    },
    {
      id: "members",
      header: "Members",
      width: 160,
      sortable: false,
      renderCell: ({ row }) => (
        <Suspense fallback={<TeamMembersAvatarsFallback />}>
          <TeamMembersAvatars team={row} onMemberClick={navigateToUser} />
        </Suspense>
      ),
    },
    {
      id: "createdAt",
      accessor: "createdAt",
      header: "Created At",
      width: 140,
      sortable: true,
      renderCell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.createdAt.toLocaleDateString()}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: 56,
      minWidth: 56,
      maxWidth: 56,
      sortable: false,
      hideable: false,
      resizable: false,
      align: "right",
      renderCell: ({ row }) => (
        <div className="flex justify-end">
          <ActionCell
            items={[
              {
                item: "View Team",
                onClick: () => {
                  navigateToTeam(row.id);
                },
              },
              {
                item: "Remove from team",
                danger: true,
                onClick: () => {
                  setTeamToRemove(row);
                },
              },
            ]}
          />
        </div>
      ),
    },
  ], [navigateToTeam, navigateToUser]);

  return (
    <>
      <UserPageTableSection
        title="Teams"
        urlStateKey="userteams"
        columns={teamColumns}
        rows={teams}
        getRowId={(team) => team.id}
        emptyLabel="No teams found"
        onRowClick={(row) => navigateToTeam(row.id)}
        onSortChange={(model) => {
          const entry = model.find((s) => s.columnId === "createdAt");
          setSortDesc(entry ? entry.direction === "desc" : undefined);
        }}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAddTeamDialogOpen(true)}
          >
            Add to team
          </Button>
        }
      />
      <Dialog open={addTeamDialogOpen} onOpenChange={setAddTeamDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader className="mb-4">
            <DialogTitle>Add to team</DialogTitle>
          </DialogHeader>
          <TeamSearchTable
            action={(team) => {
              const alreadyMember = teams.find((t) => t.id === team.id) !== undefined;
              return (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={alreadyMember}
                  onClick={() => {
                    runAsynchronouslyWithAlert(async () => {
                      await team.addUser(user.id);
                      setAddTeamDialogOpen(false);
                    });
                  }}
                >
                  {alreadyMember ? 'Added' : 'Add'}
                </Button>
              );
            }}
          />
        </DialogContent>
      </Dialog>
      <ActionDialog
        title
        danger
        open={teamToRemove !== null}
        onOpenChange={(open) => { if (!open) setTeamToRemove(null); }}
        okButton={{
          label: "Remove user from team",
          onClick: async () => {
            runAsynchronouslyWithAlert(async () => {
              if (teamToRemove) {
                await teamToRemove.removeUser(user.id);
              }
            });
          },
        }}
        cancelButton
        confirmText="I understand this will cause the user to lose access to the team."
      >
        {teamToRemove && `Are you sure you want to remove "${user.displayName ?? user.id}" from the team "${teamToRemove.displayName}"?`}
      </ActionDialog>
    </>
  );
}

type OAuthProvidersSectionProps = {
  user: ServerUser,
};

type OAuthProviderDialogProps = {
  user: ServerUser,
  open: boolean,
  onOpenChange: (open: boolean) => void,
} & ({
  mode: 'create',
} | {
  mode: 'edit',
  provider: ServerOAuthProvider,
});

function OAuthProviderDialog(props: OAuthProviderDialogProps) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const { toast } = useToast();

  // Get available OAuth providers from project config
  const availableProviders = project.config.oauthProviders;
  const isEditMode = props.mode === 'edit';
  const provider = isEditMode ? props.provider : null;

  const formSchema = yup.object({
    providerId: yup.string()
      .defined("Provider is required")
      .nonEmpty("Provider is required")
      .label("OAuth Provider")
      .meta({
        stackFormFieldRender: (innerProps: { control: any, name: string, label: string, disabled: boolean }) => (
          <SelectField
            control={innerProps.control}
            name={innerProps.name}
            label={innerProps.label}
            disabled={innerProps.disabled || isEditMode} // Disable provider selection in edit mode
            options={availableProviders.map((p: any) => ({
              value: p.id,
              label: p.id.charAt(0).toUpperCase() + p.id.slice(1)
            }))}
            placeholder="Select OAuth provider"
          />
        ),
      }),
    email: yup.string()
      .email("Please enter a valid e-mail address")
      .optional()
      .label("Email")
      .meta({
        stackFormFieldPlaceholder: "Enter email address (optional)",
      }),
    accountId: yup.string()
      .defined("Account ID is required")
      .label("Account ID")
      .meta({
        stackFormFieldPlaceholder: "Enter OAuth account ID",
        description: "The unique account identifier from the OAuth provider",
        stackFormFieldExtraProps: {
          disabled: isEditMode, // Disable account ID editing in edit mode
        },
      }),
    allowSignIn: yup.boolean()
      .default(true)
      .label("Used for sign-in")
      .meta({
        description: "Allow this OAuth provider to be used for authentication"
      }),
    allowConnectedAccounts: yup.boolean()
      .default(true)
      .label("Used for connected accounts")
      .meta({
        description: "Allow this OAuth provider to be used for connected account features"
      }),
  });

  // Set default values based on mode
  const defaultValues = isEditMode && provider ? {
    providerId: provider.type,
    email: provider.email,
    accountId: provider.accountId,
    allowSignIn: provider.allowSignIn,
    allowConnectedAccounts: provider.allowConnectedAccounts,
  } : {
    providerId: "",
    email: "",
    accountId: "",
    allowSignIn: true,
    allowConnectedAccounts: true,
  };

  const handleSubmit = async (values: yup.InferType<typeof formSchema>) => {
    let result;

    if (isEditMode && provider) {
      // Update existing provider
      result = await provider.update({
        email: values.email?.trim() || provider.email,
        allowSignIn: values.allowSignIn,
        allowConnectedAccounts: values.allowConnectedAccounts,
      });
    } else {
      // Create new provider
      if (!values.accountId.trim()) return;

      const providerConfig = availableProviders.find((p: any) => p.id === values.providerId);
      if (!providerConfig) {
        throw new HexclaveAssertionError(`Provider config not found for ${values.providerId}`);
      }

      result = await hexclaveAdminApp.createOAuthProvider({
        userId: props.user.id,
        providerConfigId: providerConfig.id,
        accountId: values.accountId.trim(),
        email: values.email?.trim() || "",
        allowSignIn: values.allowSignIn,
        allowConnectedAccounts: values.allowConnectedAccounts,
      });
    }

    // Handle errors for both create and update operations
    if (result.status === "error") {
      const providerType = isEditMode && provider ? provider.type : values.providerId;
      const accountId = isEditMode && provider ? provider.accountId : values.accountId;
      const operation = isEditMode ? "updating" : "adding";

      if (KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn.isInstance(result.error)) {
        toast({
          title: "Account Already Connected",
          description: `A ${providerType} provider with account ID "${accountId}" already exists (possibly for a different user)`,
          variant: "destructive",
        });
      } else {
        console.error(result.error);
        toast({
          title: "Error",
          description: `An unexpected error occurred while ${operation} the OAuth provider.`,
          variant: "destructive",
        });
      }
      return 'prevent-close';
    }
  };

  // Update the form schema defaults based on mode
  const schemaWithDefaults = formSchema.default(defaultValues);

  return (
    <SmartFormDialog
      title={isEditMode ? "Edit OAuth Provider" : "Add OAuth Provider"}
      description={isEditMode ? "Update the OAuth provider settings." : "Connect a new OAuth provider to this user account."}
      open={props.open}
      onOpenChange={props.onOpenChange}
      formSchema={schemaWithDefaults}
      onSubmit={handleSubmit}
    />
  );
}

function OAuthProvidersSection({ user }: OAuthProvidersSectionProps) {
  const oauthProviders = user.useOAuthProviders();
  const [isAddProviderDialogOpen, setIsAddProviderDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ServerOAuthProvider | null>(null);
  const { toast } = useToast();

  const handleProviderUpdate = useCallback(async (provider: ServerOAuthProvider, updates: { allowSignIn?: boolean, allowConnectedAccounts?: boolean }) => {
    const result = await provider.update(updates);
    if (result.status === "error") {
      if (KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn.isInstance(result.error)) {
        toast({
          title: "Account Already Connected",
          description: `A ${provider.type} provider with account ID "${provider.accountId}" is already connected for this user.`,
          variant: "destructive",
        });
      } else {
        const settingType = updates.allowSignIn !== undefined ? "sign-in" : "connected accounts";
        toast({
          title: "Error",
          description: `Failed to update ${settingType} setting.`,
          variant: "destructive",
        });
      }
    } else {
      let successMessage = "";
      if (updates.allowSignIn !== undefined) {
        successMessage = `Sign-in ${updates.allowSignIn ? 'enabled' : 'disabled'} for ${provider.type} provider.`;
      } else if (updates.allowConnectedAccounts !== undefined) {
        successMessage = `Connected accounts ${updates.allowConnectedAccounts ? 'enabled' : 'disabled'} for ${provider.type} provider.`;
      }
      toast({
        title: "Success",
        description: successMessage,
        variant: "success",
      });
    }
  }, [toast]);

  const oauthColumns = useMemo<DataGridColumnDef<ServerOAuthProvider>[]>(() => [
    {
      id: "type",
      accessor: "type",
      header: "Provider",
      width: 110,
      sortable: false,
      renderCell: ({ row }) => (
        <span className="capitalize font-medium">{row.type}</span>
      ),
    },
    {
      id: "email",
      accessor: "email",
      header: "Email",
      width: 160,
      flex: 1,
      sortable: false,
      renderCell: ({ row }) => (
        <span className="block max-w-full truncate text-sm text-muted-foreground" title={row.email}>
          {row.email ?? "No email"}
        </span>
      ),
    },
    {
      id: "accountId",
      accessor: "accountId",
      header: "Account ID",
      width: 160,
      flex: 1,
      sortable: false,
      renderCell: ({ row }) => (
        <span className="font-mono text-xs truncate block max-w-[160px]">{row.accountId}</span>
      ),
    },
    {
      id: "allowSignIn",
      header: "Sign-in",
      width: 90,
      align: "center",
      sortable: false,
      renderCell: ({ row }) => (
        <BooleanStatusCell value={row.allowSignIn} />
      ),
    },
    {
      id: "allowConnectedAccounts",
      header: "Connected",
      width: 110,
      align: "center",
      sortable: false,
      renderCell: ({ row }) => (
        <BooleanStatusCell value={row.allowConnectedAccounts} />
      ),
    },
    {
      id: "actions",
      header: "",
      width: 56,
      minWidth: 56,
      maxWidth: 56,
      sortable: false,
      hideable: false,
      resizable: false,
      align: "right",
      renderCell: ({ row }) => {
        const provider = row;
        return (
          <div className="flex justify-end">
            <ActionCell
              items={[
                {
                  item: "Edit",
                  onClick: () => setEditingProvider(provider),
                },
                {
                  item: provider.allowSignIn ? "Disable sign-in" : "Enable sign-in",
                  onClick: async () => { await handleProviderUpdate(provider, { allowSignIn: !provider.allowSignIn }); },
                },
                {
                  item: provider.allowConnectedAccounts ? "Disable connected accounts" : "Enable connected accounts",
                  onClick: async () => { await handleProviderUpdate(provider, { allowConnectedAccounts: !provider.allowConnectedAccounts }); },
                },
                {
                  item: "Delete",
                  danger: true,
                  onClick: async () => { await provider.delete(); },
                },
              ]}
            />
          </div>
        );
      },
    },
  ], [handleProviderUpdate]);

  return (
    <>
      <OAuthProviderDialog
        user={user}
        open={isAddProviderDialogOpen}
        onOpenChange={setIsAddProviderDialogOpen}
        mode="create"
      />

      {editingProvider && (
        <OAuthProviderDialog
          user={user}
          open={!!editingProvider}
          onOpenChange={() => setEditingProvider(null)}
          mode="edit"
          provider={editingProvider}
        />
      )}

      <UserPageTableSection
        title="OAuth Providers"
        urlStateKey="useroauth"
        columns={oauthColumns}
        rows={oauthProviders}
        getRowId={(provider) => provider.id}
        emptyLabel="No OAuth providers connected"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsAddProviderDialogOpen(true)}
          >
            Add Provider
          </Button>
        }
      />
    </>
  );
}

const ACTIVITY_GRID_COLUMNS = 7;
const ACTIVITY_GRID_ROWS = 53;
const ACTIVITY_GRID_CELLS = ACTIVITY_GRID_COLUMNS * ACTIVITY_GRID_ROWS;
const ACTIVITY_CELL_SIZE_PX = 11;
const ACTIVITY_GRID_GAP_PX = 2;
const ACTIVITY_SIDEBAR_WIDTH_PX = 140;
const ACTIVITY_SIDEBAR_RESERVED_WIDTH_PX = 164;
const ACTIVITY_GRID_HEIGHT_PX = ACTIVITY_GRID_ROWS * ACTIVITY_CELL_SIZE_PX + (ACTIVITY_GRID_ROWS - 1) * ACTIVITY_GRID_GAP_PX;
const ACTIVITY_BAR_ESTIMATED_HEIGHT_PX = ACTIVITY_GRID_HEIGHT_PX + 48;
const ACTIVITY_BAR_TOP_CLEARANCE_PX = 88;
const ACTIVITY_WEEKDAY_LABELS = [
  { label: "", ariaLabel: null },
  { label: "M", ariaLabel: "Monday" },
  { label: "", ariaLabel: null },
  { label: "W", ariaLabel: "Wednesday" },
  { label: "", ariaLabel: null },
  { label: "F", ariaLabel: "Friday" },
  { label: "", ariaLabel: null },
] as const;

// Activity clickmap color ramp. Indexed by 0 = no activity, 1..4 = increasing
// log-scaled intensity based on the user's own max activity over the window.
// Tailwind needs the exact class strings at build time, so we keep them
// enumerated here rather than building them dynamically.
//
// The level-0 shade uses foreground alpha (not `bg-muted`) because the user
// header sits on top of a gradient backdrop — `bg-muted` blends into the
// lighter top-left of that gradient in dark mode and the empty cells
// disappear. Foreground-alpha guarantees consistent contrast against whatever
// is behind the cells, in both themes.
const ACTIVITY_COLORS = [
  "bg-foreground/[0.08] dark:bg-foreground/[0.12]",
  "bg-emerald-500/30 dark:bg-emerald-400/30",
  "bg-emerald-500/55 dark:bg-emerald-400/55",
  "bg-emerald-500/80 dark:bg-emerald-400/80",
  "bg-emerald-500 dark:bg-emerald-400",
] as const;

function activityLevel(activity: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (activity <= 0 || max <= 0) return 0;
  const intensity = Math.log1p(activity) / Math.log1p(max);
  if (intensity <= 0.25) return 1;
  if (intensity <= 0.5) return 2;
  if (intensity <= 0.75) return 3;
  return 4;
}

// Dates come back from ClickHouse as plain `YYYY-MM-DD` strings. Parse them as
// UTC to match the bucket boundary the backend groups by (`toDate(event_at)`
// in UTC), otherwise cells on the east side of the dateline would show one day
// off in the tooltip.
const ACTIVITY_TOOLTIP_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatActivityDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return ACTIVITY_TOOLTIP_DATE_FORMATTER.format(date);
}

function parseActivityDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatActivityIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getSundayWeekStart(date: Date): Date {
  const weekStart = new Date(date);
  weekStart.setUTCHours(0, 0, 0, 0);
  const dayIndex = weekStart.getUTCDay();
  weekStart.setUTCDate(weekStart.getUTCDate() - dayIndex);
  return weekStart;
}

function ActivityShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 shrink-0">
      <span className="text-[11px] font-medium text-muted-foreground tracking-[0.14em] uppercase">Activity</span>
      <div
        className="grid text-[9px] leading-none text-muted-foreground/70"
        style={{
          gap: ACTIVITY_GRID_GAP_PX,
          gridTemplateColumns: `repeat(${ACTIVITY_GRID_COLUMNS}, ${ACTIVITY_CELL_SIZE_PX}px)`,
        }}
      >
        {ACTIVITY_WEEKDAY_LABELS.map((day, index) => (
          <span
            key={`${day.ariaLabel ?? "spacer"}-${index}`}
            className="flex justify-center"
            aria-label={day.ariaLabel ?? undefined}
            aria-hidden={day.ariaLabel == null}
            style={{ width: ACTIVITY_CELL_SIZE_PX }}
          >
            {day.label}
          </span>
        ))}
      </div>
      <div
        className="grid"
        style={{
          gap: ACTIVITY_GRID_GAP_PX,
          gridTemplateColumns: `repeat(${ACTIVITY_GRID_COLUMNS}, ${ACTIVITY_CELL_SIZE_PX}px)`,
          gridTemplateRows: `repeat(${ACTIVITY_GRID_ROWS}, ${ACTIVITY_CELL_SIZE_PX}px)`,
          gridAutoFlow: "row",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ActivityLoadingFallback() {
  const cells = useMemo(() => Array.from({ length: ACTIVITY_GRID_CELLS }), []);
  return (
    <ActivityShell>
      {cells.map((_, i) => (
        <div
          key={i}
          className={cn("rounded-[2px]", ACTIVITY_COLORS[0])}
          style={{ width: ACTIVITY_CELL_SIZE_PX, height: ACTIVITY_CELL_SIZE_PX }}
          aria-hidden
        />
      ))}
    </ActivityShell>
  );
}

function ActivityGraph({
  userId,
  onCellClick,
}: {
  userId: string,
  onCellClick: (isoDate: string) => void,
}) {
  const hexclaveAdminApp = useAdminApp();
  const { data_points: dataPoints } = useUserActivityOrThrow(hexclaveAdminApp, userId);

  const activityByDate = useMemo(
    () => new Map(dataPoints.map((point) => [point.date, point.activity])),
    [dataPoints],
  );
  const cells = useMemo(() => {
    const latestDate = dataPoints.length > 0
      ? parseActivityDate(dataPoints[dataPoints.length - 1].date)
      : new Date();
    // GitHub-style: weeks start on Sunday; grid rows go top → bottom from newest week
    // to oldest; within each row, columns are Sun → Sat.
    const week0Sunday = getSundayWeekStart(latestDate);
    return Array.from({ length: ACTIVITY_GRID_CELLS }, (_, index) => {
      const row = Math.floor(index / ACTIVITY_GRID_COLUMNS);
      const col = index % ACTIVITY_GRID_COLUMNS;
      const date = new Date(week0Sunday);
      date.setUTCDate(week0Sunday.getUTCDate() - row * ACTIVITY_GRID_COLUMNS + col);
      const isoDate = formatActivityIsoDate(date);
      return {
        date: isoDate,
        activity: activityByDate.get(isoDate) ?? 0,
      };
    });
  }, [activityByDate, dataPoints]);
  const maxActivity = useMemo(
    () => cells.reduce((acc, c) => Math.max(acc, c.activity), 0),
    [cells],
  );

  return (
    <ActivityShell>
      {cells.map((cell) => {
        const level = activityLevel(cell.activity, maxActivity);
        return (
          <Tooltip key={cell.date} delayDuration={0}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`View analytics for ${formatActivityDate(cell.date)} (${cell.activity} ${cell.activity === 1 ? "event" : "events"})`}
                onClick={() => onCellClick(cell.date)}
                className={cn(
                  "relative rounded-[2px] transition-none hover:z-10 hover:ring-2 hover:ring-foreground focus:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground cursor-pointer",
                  ACTIVITY_COLORS[level],
                )}
                style={{ width: ACTIVITY_CELL_SIZE_PX, height: ACTIVITY_CELL_SIZE_PX }}
              />
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={8} collisionPadding={8} className="z-[100] whitespace-nowrap text-xs">
              <div className="font-medium">
                {cell.activity} {cell.activity === 1 ? "event" : "events"}
              </div>
              <div className="opacity-70">{formatActivityDate(cell.date)}</div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </ActivityShell>
  );
}

function UserActivityBar({
  userId,
  onCellClick,
  anchorRef,
}: {
  userId: string,
  onCellClick: (isoDate: string) => void,
  anchorRef: RefObject<HTMLDivElement | null>,
}) {
  const [mounted, setMounted] = useState(false);
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const updateLeft = () => {
      const anchor = anchorRef.current;
      if (anchor === null) return;

      const rect = anchor.getBoundingClientRect();
      setLeft(rect.right - ACTIVITY_SIDEBAR_RESERVED_WIDTH_PX + (ACTIVITY_SIDEBAR_RESERVED_WIDTH_PX - ACTIVITY_SIDEBAR_WIDTH_PX) / 2);
    };

    updateLeft();
    window.addEventListener("resize", updateLeft);

    const resizeObserver = new ResizeObserver(updateLeft);
    if (anchorRef.current !== null) {
      resizeObserver.observe(anchorRef.current);
    }

    return () => {
      window.removeEventListener("resize", updateLeft);
      resizeObserver.disconnect();
    };
  }, [anchorRef]);

  if (!mounted || left === null) return null;

  return createPortal(
    <aside
      className="pointer-events-none fixed z-30 hidden -translate-y-1/2 xl:block"
      style={{
        left,
        width: ACTIVITY_SIDEBAR_WIDTH_PX,
        top: `max(50vh, ${ACTIVITY_BAR_TOP_CLEARANCE_PX + ACTIVITY_BAR_ESTIMATED_HEIGHT_PX / 2}px)`,
      }}
    >
      <div className="pointer-events-auto flex w-full items-center justify-center">
        <Suspense fallback={<ActivityLoadingFallback />}>
          <ActivityGraph userId={userId} onCellClick={onCellClick} />
        </Suspense>
      </div>
    </aside>,
    document.body,
  );
}

type UserPageTabConfig = {
  id: string,
  label: string,
} & (
  | { appId: AppId, icon?: undefined }
  | { appId: null, icon: NonNullable<DesignCategoryTabItem["icon"]> }
);

const USER_PAGE_TABS = [
  { id: "authentication", label: "Authentication", appId: "authentication" },
  { id: "teams", label: "Teams", appId: "teams" },
  { id: "emails", label: "Emails", appId: "emails" },
  { id: "payments", label: "Payments", appId: "payments" },
  { id: "analytics", label: "Analytics", appId: "analytics" },
  { id: "session-replays", label: "Session Replays", appId: "session-replays" },
  { id: "metadata", label: "Metadata", appId: null, icon: DatabaseIcon },
] as const satisfies readonly UserPageTabConfig[];

type UserPageTab = typeof USER_PAGE_TABS[number]["id"];

function isUserPageTab(id: string): id is UserPageTab {
  return USER_PAGE_TABS.some((tab) => tab.id === id);
}

function TabContentSkeleton({ sections }: { sections: number }) {
  return (
    <div className="flex flex-col gap-6">
      {Array.from({ length: sections }).map((_, i) => (
        <section key={i} className="flex flex-col gap-3">
          <Skeleton className="h-4 w-32" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        </section>
      ))}
    </div>
  );
}

const USER_PAGE_TAB_PARAM = "tab";

function UserPage({ user }: { user: ServerUser }) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activityBarAnchorRef = useRef<HTMLDivElement>(null);

  const visibleTabs = useMemo(
    () => USER_PAGE_TABS.filter((tab) => tab.appId === null || isAppEnabled(config.apps.installed, tab.appId)),
    [config.apps.installed],
  );

  const tabParam = searchParams.get(USER_PAGE_TAB_PARAM);
  const fallbackTab: UserPageTab = visibleTabs[0]?.id ?? throwErr("User page has no visible tabs; metadata tab should always be visible");
  const activeTab: UserPageTab = (tabParam && isUserPageTab(tabParam) && visibleTabs.some((tab) => tab.id === tabParam))
    ? tabParam
    : fallbackTab;

  const setSelectedTab = useCallback((id: UserPageTab) => {
    const newParams = new URLSearchParams(searchParams.toString());
    newParams.set(USER_PAGE_TAB_PARAM, id);
    const queryString = newParams.toString();
    router.push(queryString ? `${pathname}?${queryString}` : pathname);
  }, [pathname, router, searchParams]);

  const [analyticsDayFilter, setAnalyticsDayFilter] = useState<string | null>(null);

  const analyticsTabAvailable = visibleTabs.some((tab) => tab.id === "analytics");
  const handleActivityCellClick = useCallback((isoDate: string) => {
    if (!analyticsTabAvailable) return;
    setAnalyticsDayFilter(isoDate);
    setSelectedTab("analytics");
  }, [analyticsTabAvailable, setSelectedTab]);

  return (
    <PageLayout>
      <div className="relative flex flex-col gap-6">
        <RestrictionBanner user={user} />
        <div ref={activityBarAnchorRef} className="flex min-w-0 flex-col gap-6 xl:pr-[164px]">
          <div className="flex min-w-0 flex-col gap-4">
            <UserHeader user={user} />
            <UserDetails user={user} />
          </div>
          {visibleTabs.length > 0 && (
            <DesignCategoryTabs
              categories={visibleTabs.map((tab) => ({
                id: tab.id,
                label: tab.label,
                icon: tab.appId === null ? tab.icon : ALL_APPS_FRONTEND[tab.appId].icon,
              }))}
              selectedCategory={activeTab}
              onSelect={(id) => {
                if (!isUserPageTab(id)) {
                  throw new HexclaveAssertionError(`Unknown user page tab selected: ${id}`);
                }
                setSelectedTab(id);
              }}
              showBadge={false}
              size="sm"
              glassmorphic={false}
              trailing={(
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="h-8 justify-center gap-1.5 rounded-lg bg-transparent px-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/75 transition-colors duration-150 hover:bg-transparent hover:text-foreground hover:transition-none"
                >
                  <Link
                    href={`/projects/${encodeURIComponent(hexclaveAdminApp.projectId)}/app-configuration/apps`}
                    className="inline-flex items-center justify-center"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    <span>Install apps</span>
                  </Link>
                </Button>
              )}
            />
          )}
          {activeTab === "authentication" && (
            <Suspense fallback={<TabContentSkeleton sections={3} />}>
              <div className="flex flex-col gap-6">
                <ContactChannelsSection user={user} />
                <OAuthProvidersSection user={user} />
                <FraudSection user={user} />
              </div>
            </Suspense>
          )}
          {activeTab === "teams" && (
            <Suspense fallback={<TabContentSkeleton sections={1} />}>
              <UserTeamsSection user={user} />
            </Suspense>
          )}
          {activeTab === "emails" && (
            <Suspense fallback={<TabContentSkeleton sections={1} />}>
              <UserEmailsSection user={user} />
            </Suspense>
          )}
          {activeTab === "payments" && (
            <Suspense fallback={<TabContentSkeleton sections={1} />}>
              <UserPaymentsSection user={user} />
            </Suspense>
          )}
          {activeTab === "analytics" && (
            <Suspense fallback={<TabContentSkeleton sections={1} />}>
              <UserAnalyticsSection
                user={user}
                dayFilter={analyticsDayFilter}
                onClearDayFilter={() => setAnalyticsDayFilter(null)}
              />
            </Suspense>
          )}
          {activeTab === "session-replays" && (
            <Suspense fallback={<TabContentSkeleton sections={1} />}>
              <SessionReplaysPageClient lockedUserId={user.id} />
            </Suspense>
          )}
          {activeTab === "metadata" && (
            <MetadataSection
              entityName="user"
              docsUrl={userMetadataDocsUrl}
              clientMetadata={user.clientMetadata}
              clientReadOnlyMetadata={user.clientReadOnlyMetadata}
              serverMetadata={user.serverMetadata}
              onUpdateClientMetadata={async (value) => {
                await user.setClientMetadata(value);
              }}
              onUpdateClientReadOnlyMetadata={async (value) => {
                await user.setClientReadOnlyMetadata(value);
              }}
              onUpdateServerMetadata={async (value) => {
                await user.setServerMetadata(value);
              }}
            />
          )}
        </div>
        <UserActivityBar userId={user.id} onCellClick={handleActivityCellClick} anchorRef={activityBarAnchorRef} />
      </div>
    </PageLayout>
  );
}

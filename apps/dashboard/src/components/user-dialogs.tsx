import type { StackAdminApp } from "@hexclave/next";
import { ServerUser } from '@hexclave/next';
import { ActionDialog, Alert, Button, CopyField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator, Spinner, Textarea, Typography } from "@/components/ui";
import { generateImpersonateSnippet } from "@hexclave/shared/dist/utils/browser-action-snippets";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useMemo, useState } from "react";
import { openBrowserActionInNewTab } from "@/lib/browser-actions";
import { getTrustedOriginOptions, normalizeTrustedOrigin } from "@/lib/trusted-origins";
import { Link } from './link';
import { useRouter } from './router';


export function DeleteUserDialog(props: {
  user: ServerUser,
  open: boolean,
  profileHref: string,
  redirectTo?: string,
  onOpenChange: (open: boolean) => void,
  onDeleted?: () => void | Promise<void>,
}) {
  const router = useRouter();
  const userLabel = props.user.displayName?.trim() || props.user.primaryEmail?.trim() || props.user.id;
  return <ActionDialog
    open={props.open}
    onOpenChange={props.onOpenChange}
    title="Delete User"
    danger
    cancelButton
    okButton={{
      label: "Delete User", onClick: async () => {
        await props.user.delete();
        if (props.onDeleted) {
          runAsynchronouslyWithAlert(Promise.resolve().then(() => props.onDeleted?.()));
        }
        if (props.redirectTo) {
          router.push(props.redirectTo);
        }
      }
    }}
    confirmText="I understand that this action cannot be undone."
  >
    <Typography>
      Are you sure you want to delete the user &quot;<Link
        href={props.profileHref}
        className="inline underline underline-offset-2"
        prefetch={false}
        onClick={() => {
          props.onOpenChange(false);
        }}
      >
        {userLabel}
      </Link>&quot;?
    </Typography>
  </ActionDialog>;
}

export function ImpersonateUserDialog(props: {
  user: ServerUser,
  adminApp: StackAdminApp<false>,
  open: boolean,
  onClose: () => void,
}) {
  const config = props.adminApp.useProject().useConfig();
  const { origins, wildcardDomains } = useMemo(
    () => getTrustedOriginOptions(config.domains.trustedDomains),
    [config.domains.trustedDomains],
  );
  const [selectedOrigin, setSelectedOrigin] = useState("");
  const [customOrigin, setCustomOrigin] = useState("");
  const [reason, setReason] = useState("");
  const [fallbackSnippet, setFallbackSnippet] = useState<string | null>(null);
  const [fallbackSnippetLoading, setFallbackSnippetLoading] = useState(false);
  const [fallbackSnippetError, setFallbackSnippetError] = useState<string | null>(null);
  const canUseCustomOrigin = config.domains.allowLocalhost;

  useEffect(() => {
    setSelectedOrigin(origins[0]?.origin ?? "");
  }, [origins]);

  useEffect(() => {
    if (!props.open) {
      setFallbackSnippet(null);
      setFallbackSnippetError(null);
      setFallbackSnippetLoading(false);
      setReason("");
    }
  }, [props.open]);

  async function generateConsoleSnippet() {
    setFallbackSnippetError(null);
    setFallbackSnippetLoading(true);
    try {
      const expiresInMillis = 2 * 60 * 60 * 1000;
      const session = await props.user.createSession({
        expiresInMillis,
        isImpersonation: true,
        reason: reason.trim() === "" ? null : reason.trim(),
      });
      const tokens = await session.getTokens();
      setFallbackSnippet(generateImpersonateSnippet(
        props.adminApp.projectId,
        tokens.refreshToken ?? throwErr("Expected refresh token for newly created impersonation session"),
        new Date(Date.now() + expiresInMillis),
      ));
    } catch (error) {
      setFallbackSnippetError(error instanceof Error ? error.message : String(error));
    } finally {
      setFallbackSnippetLoading(false);
    }
  }

  async function openBrowserAction() {
    const origin = normalizeTrustedOrigin(customOrigin.trim() || selectedOrigin);
    if (origin == null) {
      window.alert("Enter a valid website address, for example https://app.example.com.");
      return "prevent-close";
    }
    const opened = await openBrowserActionInNewTab(props.adminApp, {
      type: "impersonation",
      origin,
      userId: props.user.id,
      sessionExpiresInMillis: 2 * 60 * 60 * 1000,
      reason: reason.trim() === "" ? undefined : reason.trim(),
    });
    if (opened) {
      props.onClose();
    }
  }

  return (
    <ActionDialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title="Impersonate User"
      description="Open a trusted website with a short-lived impersonation action."
      cancelButton
    >
      <div className="space-y-4">
        {origins.length === 0 && !canUseCustomOrigin ? (
          <Alert>
            Add a trusted domain before using the browser action. You can still use the console fallback below.
          </Alert>
        ) : (
          <>
            {origins.length > 0 && (
              <>
                <Typography>Select the website where the impersonated session should open.</Typography>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select value={selectedOrigin} onValueChange={setSelectedOrigin}>
                    <SelectTrigger className="min-w-0 flex-1">
                      <SelectValue placeholder="Select a trusted website" />
                    </SelectTrigger>
                    <SelectContent>
                      {origins.map((origin) => <SelectItem key={origin.id} value={origin.origin}>{origin.origin}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={async () => {
                      await openBrowserAction();
                    }}
                    disabled={selectedOrigin === "" && customOrigin.trim() === ""}
                  >
                    Impersonate
                  </Button>
                </div>
              </>
            )}
            {canUseCustomOrigin && (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  className="min-w-0 flex-1"
                  value={customOrigin}
                  onChange={(event) => setCustomOrigin(event.target.value)}
                  placeholder="Exact website address, e.g. http://localhost:5173"
                />
                {origins.length === 0 && (
                  <Button
                    onClick={async () => {
                      await openBrowserAction();
                    }}
                    disabled={selectedOrigin === "" && customOrigin.trim() === ""}
                  >
                    Impersonate
                  </Button>
                )}
              </div>
            )}
          </>
        )}
        <div className="space-y-2">
          <Label htmlFor="impersonate-reason">Reason (optional)</Label>
          <Textarea
            id="impersonate-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why are you impersonating this user?"
            maxLength={500}
            rows={2}
          />
        </div>
        <div className="flex items-center justify-center">
          <div className="flex-1">
            <Separator />
          </div>
          <div className="mx-2 text-sm text-muted-foreground">OR</div>
          <div className="flex-1">
            <Separator />
          </div>
        </div>
        <Typography variant="secondary" className="text-sm">
          Open a page in your app that the impersonated user can access, then paste this snippet into its browser console. It switches users and reloads that page.
        </Typography>
        {fallbackSnippetLoading ? (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Generating console snippet…
          </div>
        ) : fallbackSnippetError != null ? (
          <Alert variant="destructive">{fallbackSnippetError}</Alert>
        ) : fallbackSnippet != null ? (
          <CopyField type="textarea" monospace height={100} value={fallbackSnippet} isSecret />
        ) : (
          <Button onClick={async () => { await generateConsoleSnippet(); }}>
            Generate console snippet
          </Button>
        )}
      </div>
    </ActionDialog>
  );
}

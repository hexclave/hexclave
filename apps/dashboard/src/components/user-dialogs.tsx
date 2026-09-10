import type { StackAdminApp } from "@hexclave/next";
import { ServerUser } from '@hexclave/next';
import { ActionDialog, Alert, Button, CopyField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator, Spinner, Typography } from "@/components/ui";
import { generateImpersonateSnippet } from "@hexclave/shared/dist/utils/browser-action-snippets";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously, runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const [fallbackSnippet, setFallbackSnippet] = useState<string | null>(null);
  const [fallbackSnippetLoading, setFallbackSnippetLoading] = useState(false);
  const [fallbackSnippetError, setFallbackSnippetError] = useState<string | null>(null);
  const snippetRequestGeneration = useRef(0);
  const userRef = useRef(props.user);
  const adminAppRef = useRef(props.adminApp);
  userRef.current = props.user;
  adminAppRef.current = props.adminApp;
  const canUseCustomOrigin = config.domains.allowLocalhost;

  useEffect(() => {
    setSelectedOrigin(origins[0]?.origin ?? "");
  }, [origins]);

  useEffect(() => {
    if (!props.open) {
      setFallbackSnippet(null);
      setFallbackSnippetError(null);
      setFallbackSnippetLoading(false);
      return;
    }
    const requestGeneration = snippetRequestGeneration.current + 1;
    snippetRequestGeneration.current = requestGeneration;
    setFallbackSnippet(null);
    setFallbackSnippetError(null);
    setFallbackSnippetLoading(true);
    runAsynchronously((async () => {
      const expiresInMillis = 2 * 60 * 60 * 1000;
      const session = await userRef.current.createSession({ expiresInMillis, isImpersonation: true });
      const tokens = await session.getTokens();
      if (snippetRequestGeneration.current === requestGeneration) {
        setFallbackSnippet(generateImpersonateSnippet(
          adminAppRef.current.projectId,
          tokens.refreshToken ?? throwErr("Expected refresh token for newly created impersonation session"),
          new Date(Date.now() + expiresInMillis),
        ));
        setFallbackSnippetLoading(false);
      }
    })(), {
      onError: (error) => {
        if (snippetRequestGeneration.current === requestGeneration) {
          setFallbackSnippetError(error.message);
          setFallbackSnippetLoading(false);
        }
      },
    });
    return () => {
      snippetRequestGeneration.current = requestGeneration + 1;
    };
  }, [props.open, props.user.id]);

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
        ) : null}
      </div>
    </ActionDialog>
  );
}

/**
 * Single source of truth for SDK-managed page prompts and version metadata.
 *
 * Consumed by:
 *   - the backend's `/internal/component-versions` endpoint (via
 *     `getLatestPageVersions`), so the dev-tool can tell users when their
 *     installed SDK is outdated.
 *   - the template SDK's `url-targets.ts`, which calls `getCustomPagePrompts`
 *     to build prompt metadata for custom page URL target validation.
 *
 * This file lives in stack-shared because both the backend and the template
 * need the same data, and stack-shared is the only package both can import
 * from without creating a wrong-direction dependency.
 */

import { remindersPrompt } from "../ai/unified-prompts/reminders";
import { deindent } from "../utils/strings";
import type { HandlerPageUrls } from "./handler-urls";

export type PageVersionEntry = {
  minSdkVersion: `${number}.${number}.${number}`,
  upgradePrompt: string,
  changelog: string,
};

export type PageVersions = Record<number, PageVersionEntry> & { 1: PageVersionEntry };

export type PageComponentKey = Exclude<keyof HandlerPageUrls, "handler">;

export type CustomPagePrompt = {
  title: string,
  fullPrompt: string,
  versions: PageVersions,
};


function createCustomPagePrompt(options: {
  key: PageComponentKey,
  title: string,
  minSdkVersion: `${number}.${number}.${number}`,
  structure: string,
  notes: string,
  reactExample: string,
  versions: Omit<PageVersions, 1>,
}): CustomPagePrompt {
  const latestPageVersion = Math.max(1, ...Object.keys(options.versions).map(Number));
  const latestSdkVersion = latestPageVersion === 1 ? options.minSdkVersion : options.versions[latestPageVersion].minSdkVersion;
  const fullPrompt = deindent`
    This prompt explains how to implement a custom ${options.title} page for Hexclave. The version of this page that you are implementing is v${latestPageVersion}. It can be found in Hexclave's documentation, and in the Hexclave devtool indicator.

    First, make sure to upgrade the Hexclave SDK to a recent version. The minimum supported SDK version for this walkthrough is v${latestSdkVersion}.

    The user's codebase may already have a ${options.title} page that could be suitable (eg. from an earlier version of Hexclave, a template, another auth provider before migrating to Hexclave, etc.). Use your critical thinking skills to determine what the user's intent is; it is likely that instead of creating a new page, you can just modify the existing page to use Hexclave & support the logic/structure below.

    Below is a description of the logical structure of what this page should contain (note that the visual structure and layout may be different, and up to you). The page can have more content than this, but it should always contain at least what's described below.

    ${options.structure}

    Some more notes:

    - When implementing the custom page, make sure to adjust its design to match the frameworks, libraries, codestyle, design and branding of the remaining app.
    ${options.notes}

    Below is a React example of an extremely minimalistic implementation of this page. Note that this is an example, not a template, and as such you should spend careful consideration on how to implement the page in a way that is consistent with the existing codebase. Also note that these components are NOT self-contained, and NOT shadcn-ui components or a UI framework like that. They serve purely as examples on how to implement the page, but you must make sure to use the correct components and props for the framework and libraries you're using yourself. DO NOT USE THE EXACT DESIGN AS SPECIFIED IN THIS EXAMPLE, INSTEAD MAKE IT LOOK REALLY GOOD. THIS EXAMPLE ONLY DESCRIBES THE MINIMAL LOGIC THAT A SIGN-IN PAGE NEEDS TO SUPPORT, IT IS NOT A COMPLETE EXAMPLE!

    \`\`\`tsx
    ${options.reactExample}
    \`\`\`

    When you're done, please update the file where the Hexclave app is configured with its URLs, to make sure it points to this page. For example, you may have an object declared like this:

    \`\`\`tsx
    export const hexclaveServerApp = new HexclaveServerApp({
      tokenStore: "nextjs-cookie",
      urls: {
        default: {
          "type": "hosted",
        },
      }
    });
    \`\`\`

    You will want to update the \`urls\` property to point to this page, for example:

    \`\`\`tsx
      urls: {
        ${JSON.stringify(options.key)}: { type: "custom", url: "/path/to/your/custom/page", version: ${latestPageVersion} },
        // ...
      },
    \`\`\`

    ${remindersPrompt}
  `;
  const versions = {
    1: {
      minSdkVersion: options.minSdkVersion,
      upgradePrompt: fullPrompt,
      changelog: "Initial version.",
    },
    ...options.versions,
  };
  return {
    title: options.title,
    versions,
    fullPrompt,
  };
}

type AuthPagePromptType = "signIn" | "signUp";

function createAuthPagePrompt(type: AuthPagePromptType): CustomPagePrompt {
  const isSignIn = type === "signIn";
  const otherType = isSignIn ? "signUp" : "signIn";

  const title = isSignIn ? "Sign In" : "Sign Up";
  const pageHeading = isSignIn ? "Sign in to your account" : "Create a new account";
  const authVerb = isSignIn ? "sign in" : "sign up";
  const authVerbCapitalized = isSignIn ? "Sign in" : "Sign up";
  const otherAuthVerb = isSignIn ? "sign up" : "sign in";

  const credentialMethodCall = isSignIn
    ? "hexclaveApp.signInWithCredential({ email: form.email, password: form.password })"
    : "hexclaveApp.signUpWithCredential({ email: form.email, password: form.password })";

  const credentialResultType = isSignIn
    ? "Promise<Result<undefined, KnownErrors[\"EmailPasswordMismatch\"] | KnownErrors[\"InvalidTotpCode\"]>>"
    : "Promise<Result<undefined, KnownErrors[\"UserWithEmailAlreadyExists\"] | KnownErrors[\"ContactChannelAlreadyUsedForAuthBySomeoneElse\"] | KnownErrors[\"PasswordRequirementsNotMet\"] | KnownErrors[\"BotChallengeFailed\"]>>";

  return createCustomPagePrompt({
    key: type,
    title,
    minSdkVersion: "0.0.1",
    structure: deindent`
      - If user is already signed in, regardless of whether restricted or not (ie. \`await hexclaveApp.getUser({ includeRestricted: true }) !== null\`):
        - If user is restricted, \`await hexclaveApp.redirectToOnboarding({ replace: true })\`
        - Otherwise, \`await hexclaveApp.redirectToAfterSign${isSignIn ? "In" : "Up"}({ replace: true })\`
        - While the redirect is happening, you may display a loading indicator, or a note that the user is being redirected. If necessary, or if preferable, you can also render a message card that shows a link to \`await hexclaveApp.redirectToHome()\` and a sign out button.
      - If user is not signed in:
        ${isSignIn
          ? "- If sign-ups are enabled (\\`project = await hexclaveApp.getProject(); project.config.signUpEnabled\\`), show a link to the sign-up page."
          : "- If sign-ups are disabled (\\`project = await hexclaveApp.getProject(); !project.config.signUpEnabled\\`), show a message that sign-up is disabled."}
        - Show a ${authVerb} screen. The auth methods that should render:
          - For each OAuth provider (\`project.config.oauthProviders: { readonly id: string }[]\`), render an OAuth button. Clicking the button calls \`await hexclaveApp.signInWithOAuth("<providerId>")\`.
          ${isSignIn ? "- If \\`project.config.passkeyEnabled\\`, render a passkey button. Clicking the button calls \\`await hexclaveApp.signInWithPasskey()\\`." : ""}
          - If \`project.config.credentialEnabled\`, render a credential ${authVerb} form:
            - Email + password${isSignIn ? "" : " + repeat password"}
            ${isSignIn ? "" : "- Validate password strength with \\`getPasswordError()\\` and ensure repeated password matches"}
            ${isSignIn ? "- \"Forgot password?\" link calling \\`await hexclaveApp.redirectToForgotPassword()\\`" : ""}
            - Submit calls \`${credentialMethodCall}: ${credentialResultType}\`
            - On error, display the error message on the email field
          - If \`project.config.magicLinkEnabled\`, render a magic link form:
            - Email input (validated to be a correct email address) + "Send email" button
            - Calls \`hexclaveApp.sendMagicLinkEmail(email): Promise<Result<{ nonce: string }, KnownErrors["RedirectUrlNotWhitelisted"] | KnownErrors["BotChallengeFailed"]>>\`
            - After sending, switch to a 6-digit OTP input. User enters the code from their email
            - Submit the OTP + nonce via \`hexclaveApp.signInWithMagicLink(otp + nonce): Promise<Result<undefined, KnownErrors["VerificationCodeError"] | KnownErrors["InvalidTotpCode"]>>\` (string concatenation)
          - If both credential and magic-link are enabled, allow the user to choose which flow to use.
          - If none of the above auth methods are enabled, show a message explaining that no authentication methods are enabled.
        - Show a link to the ${otherAuthVerb} page that calls \`await hexclaveApp.redirectTo${isSignIn ? "SignUp" : "SignIn"}()\`.
    `,
    reactExample: deindent`
      export default function Custom${isSignIn ? "SignIn" : "SignUp"}Page() {
        const hexclaveApp = useHexclaveApp();
        const user = useUser({ includeRestricted: true });
        const project = hexclaveApp.useProject();
        const [otpState, setOtpState] = useState<null | { nonce: string }>(null);

        useEffect(() => {
          if (user) {
            if (user.isRestricted) {
              void hexclaveApp.redirectToOnboarding();
            } else {
              void hexclaveApp.redirectToAfterSign${isSignIn ? "In" : "Up"}();
            }
          }
        }, [user]);

        if (user && !user.isRestricted) {
          return (
            <div>
              <Typography>You are already signed in.</Typography>
              <Button onClick={async () => await hexclaveApp.redirectToSignOut()}>Sign out</Button>
              <Button onClick={async () => await hexclaveApp.redirectToHome()}>Go home</Button>
            </div>
          );
        }

        ${isSignIn ? "" : `
        if (!project.config.signUpEnabled) {
          return <Typography>Sign-up is not enabled.</Typography>;
        }`}

        if (otpState) {
          return (
            <Form onSubmit={async (form) => {
              const result = await hexclaveApp.signInWithMagicLink(form.otp + otpState.nonce);
              if (result.status === "error") handleErrorNicely(...);
            }}>
              <Typography>Enter the code from your email</Typography>
              <OTPInput id="otp" />
              <Button type="button" onClick={() => setOtpState(null)}>Go back</Button>
              <SubmitButton>Verify code</SubmitButton>
            </Form>
          );
        }

        const hasOAuthProviders = project.config.oauthProviders.length > 0;
        ${isSignIn ? "const hasPasskey = project.config.passkeyEnabled;" : ""}
        const hasCredential = project.config.credentialEnabled;
        const hasMagicLink = project.config.magicLinkEnabled;
        const showSeparator = (hasCredential || hasMagicLink) && ${isSignIn ? "(hasOAuthProviders || hasPasskey)" : "hasOAuthProviders"};
        const hasAnyAuthMethod = hasOAuthProviders || hasCredential || hasMagicLink${isSignIn ? " || hasPasskey" : ""};

        return (
          <div>
            <Typography type="h2">${pageHeading}</Typography>
            ${isSignIn ? `{
              project.config.signUpEnabled ? (
                <Typography>
                  {"Don't have an account? "}
                  <a
                    href="#"
                    onClick={async (e) => {
                      e.preventDefault();
                      await hexclaveApp.redirectToSignUp();
                    }}
                  >
                    Sign up
                  </a>
                </Typography>
              ) : null
            }` : `<Typography>
              {"Already have an account? "}
              <a
                href="#"
                onClick={async (e) => {
                  e.preventDefault();
                  await hexclaveApp.redirectToSignIn();
                }}
              >
                Sign in
              </a>
            </Typography>`}

            {${isSignIn ? "(hasOAuthProviders || hasPasskey)" : "hasOAuthProviders"} && (
              <div>
                {project.config.oauthProviders.map((provider) => (
                  <Button
                    key={provider.id}
                    onClick={async () => {
                      await hexclaveApp.signInWithOAuth(provider.id);
                    }}
                  >
                    ${authVerbCapitalized} with {provider.id}
                  </Button>
                ))}
                ${isSignIn ? `{hasPasskey && (
                  <Button onClick={async () => await hexclaveApp.signInWithPasskey()}>
                    Sign in with passkey
                  </Button>
                )}` : ""}
              </div>
            )}

            {showSeparator ? (
              <Typography>
                Or continue with
              </Typography>
            ) : null}

            {hasCredential || hasMagicLink ? (
              <Tabs>
                <TabsList visible={hasCredential && hasMagicLink}>
                  {hasMagicLink && <TabsTrigger value="magic-link">Email</TabsTrigger>}
                  {hasCredential && <TabsTrigger value="password">Email & Password</TabsTrigger>}
                </TabsList>
                {hasMagicLink && <TabsContent value="magic-link">
                  <Form onSubmit={async (form) => {
                    const result = await hexclaveApp.sendMagicLinkEmail(form.email);
                    if (result.status === "error") handleErrorNicely(...);
                    else setOtpState({ nonce: result.data.nonce });
                  }}>
                    <Label htmlFor="magic-link-email">Email</Label>
                    <EmailInput id="magic-link-email" />
                    <SubmitButton>Send OTP code</SubmitButton>
                  </Form>
                </TabsContent>}
                {hasCredential && <TabsContent value="password">
                  <Form onSubmit={async (form) => {
                    ${isSignIn ? "" : `if (form.password !== form.passwordRepeat) {
                      handleErrorNicely(...);
                      return;
                    }`}

                    const result = await ${credentialMethodCall};
                    if (result.status === "error") handleErrorNicely(...);
                  }}>
                    <Label htmlFor="email">Email</Label>
                    <EmailInput id="email" />

                    <Label htmlFor="password">Password</Label>
                    <PasswordInput id="password" />

                    ${isSignIn ? `<Button type="button" variant="link" onClick={async () => await hexclaveApp.redirectToForgotPassword()}>
                      Forgot password?
                    </Button>` : `<Label htmlFor="password-repeat">Repeat password</Label>
                    <PasswordInput id="password-repeat" />`}

                    <SubmitButton>
                      ${isSignIn ? "Sign In" : "Sign Up"}
                    </SubmitButton>
                  </Form>
                </TabsContent>}
              </Tabs>
            ) : null}

            {!hasAnyAuthMethod ? (
              <Typography variant="destructive">No authentication method enabled.</Typography>
            ) : null}
          </div>
        );
      }
    `,
    notes: deindent`
      - This page shares a lot of code with the ${otherType} page, and potentially other pages. Make sure to reuse code and keep behavior consistent wherever possible.
    `,
    versions: {},
  });
}

export function getCustomPagePrompts(): Record<PageComponentKey, CustomPagePrompt> {
  return {
    signIn: createAuthPagePrompt("signIn"),
    signUp: createAuthPagePrompt("signUp"),
    signOut: createCustomPagePrompt({
      key: "signOut",
      title: "Sign Out",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - Read the current user.
        - If a user exists, sign them out.
        - After sign-out, show a confirmation state that the user is signed out.
      `,
      reactExample: deindent`
        const cacheSignOut = cacheFunction(async (user: CurrentUser) => {
          return await user.signOut();
        });

        export default function CustomSignOutPage() {
          const user = useUser({ or: "return-null" });
          const hexclaveApp = useHexclaveApp();

          if (user) {
            use(cacheSignOut(user));
          }

          return (
            <MessageCard
              title="Signed out"
              primaryButtonText="Go home"
              primaryAction={async () => {
                await hexclaveApp.redirectToHome();
              }}
            >
              You have been signed out successfully.
            </MessageCard>
          );
        }
      `,
      notes: deindent`
        - Keep this page idempotent. Refreshing the page should still leave the user signed out and show a stable confirmation state.
      `,
      versions: {},
    }),
    emailVerification: createCustomPagePrompt({
      key: "emailVerification",
      title: "Email Verification",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - Read the verification code from URL params.
        - If the code is missing, show an invalid-link state.
        - If the code exists, show a confirmation step:
          - Verify action calls \`hexclaveApp.verifyEmail(code)\`.
          - Cancel action calls \`hexclaveApp.redirectToHome()\`.
        - Handle verification result:
          - \`VerificationCodeNotFound\` => invalid-link state.
          - \`VerificationCodeExpired\` => expired-link state.
          - \`VerificationCodeAlreadyUsed\` => treat as successful verification.
          - Any other error => throw.
        - On success, show a verified state with a "Go home" action.
      `,
      reactExample: deindent`
        export default function CustomEmailVerificationPage(props: { searchParams?: Record<string, string> }) {
          const hexclaveApp = useHexclaveApp();
          const [result, setResult] = useState<Awaited<ReturnType<typeof hexclaveApp.verifyEmail>> | null>(null);
          const code = props.searchParams?.code;

          if (!code) {
            return <MessageCard title="Invalid Verification Link" />;
          }

          if (!result) {
            return (
              <MessageCard
                title="Do you want to verify your email?"
                primaryButtonText="Verify"
                primaryAction={async () => {
                  setResult(await hexclaveApp.verifyEmail(code));
                }}
                secondaryButtonText="Cancel"
                secondaryAction={async () => {
                  await hexclaveApp.redirectToHome();
                }}
              />
            );
          }

          if (result.status === "error") {
            if (KnownErrors.VerificationCodeNotFound.isInstance(result.error)) {
              return <MessageCard title="Invalid Verification Link" />;
            } else if (KnownErrors.VerificationCodeExpired.isInstance(result.error)) {
              return <MessageCard title="Expired Verification Link" />;
            } else if (!KnownErrors.VerificationCodeAlreadyUsed.isInstance(result.error)) {
              throw result.error;
            }
          }

          return (
            <MessageCard
              title="Your email has been verified!"
              primaryButtonText="Go home"
              primaryAction={async () => {
                await hexclaveApp.redirectToHome();
              }}
            />
          );
        }
      `,
      notes: deindent`
        - Preserve explicit states for invalid, expired, and already-used codes so users know what happened and what to do next.
      `,
      versions: {},
    }),
    passwordReset: createCustomPagePrompt({
      key: "passwordReset",
      title: "Password Reset",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - Read the reset code from URL params.
        - If code is missing, show an invalid-link state.
        - Before rendering the form, verify the code via \`hexclaveApp.verifyPasswordResetCode(code)\`.
          - \`VerificationCodeNotFound\` => invalid-link state.
          - \`VerificationCodeExpired\` => expired-link state.
          - \`VerificationCodeAlreadyUsed\` => used-link state.
          - Any other error => throw.
        - If code is valid, render reset form:
          - New password + repeated password.
          - Validate password strength and ensure repeated password matches.
          - Submit calls \`hexclaveApp.resetPassword({ password, code })\`.
        - If reset succeeds, show success state.
        - If reset fails, show error state with guidance to request a new link.
      `,
      reactExample: deindent`
        export default function CustomPasswordResetPage(props: { searchParams: Record<string, string> }) {
          const hexclaveApp = useHexclaveApp();
          const code = props.searchParams.code;
          const [password, setPassword] = useState("");
          const [passwordRepeat, setPasswordRepeat] = useState("");
          const [done, setDone] = useState(false);
          const [failed, setFailed] = useState(false);
          const [formError, setFormError] = useState<string | null>(null);

          const cachedVerifyPasswordResetCode = cacheFunction(async (app: HexclaveClientApp<true>, codeToVerify: string) => {
            return await app.verifyPasswordResetCode(codeToVerify);
          });

          if (!code) {
            return <MessageCard title="Invalid Password Reset Link" />;
          }

          const verificationResult = use(cachedVerifyPasswordResetCode(hexclaveApp, code));
          if (verificationResult.status === "error") {
            if (KnownErrors.VerificationCodeNotFound.isInstance(verificationResult.error)) return <MessageCard title="Invalid Password Reset Link" />;
            if (KnownErrors.VerificationCodeExpired.isInstance(verificationResult.error)) return <MessageCard title="Expired Password Reset Link" />;
            if (KnownErrors.VerificationCodeAlreadyUsed.isInstance(verificationResult.error)) return <MessageCard title="Used Password Reset Link" />;
            throw verificationResult.error;
          }

          if (done) return <MessageCard title="Your password has been reset" />;
          if (failed) return <MessageCard title="Failed to reset password" />;

          return (
            <form onSubmit={async (e) => {
              e.preventDefault();
              setFormError(null);

              if (password !== passwordRepeat) {
                setFormError("Passwords do not match");
                return;
              }

              const result = await hexclaveApp.resetPassword({ password, code });
              if (result.status === "error") setFailed(true);
              else setDone(true);
            }}>
              <Label htmlFor="password">New Password</Label>
              <PasswordInput id="password" value={password} onChange={(e) => setPassword(e.target.value)} />

              <Label htmlFor="password-repeat">Repeat New Password</Label>
              <PasswordInput id="password-repeat" value={passwordRepeat} onChange={(e) => setPasswordRepeat(e.target.value)} />

              {formError ? <Typography variant="destructive">{formError}</Typography> : null}
              <Button type="submit">Reset Password</Button>
            </form>
          );
        }
      `,
      notes: deindent`
        - Verify the reset code before rendering the form so users immediately get the right state for invalid/expired/used links.
      `,
      versions: {},
    }),
    forgotPassword: createCustomPagePrompt({
      key: "forgotPassword",
      title: "Forgot Password",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - If a user is already signed in, show a signed-in state instead of the reset form.
        - If user is signed out:
          - Render a forgot-password form with email input.
          - Submit calls \`hexclaveApp.sendForgotPasswordEmail(email)\`.
          - On success, switch to an email-sent confirmation state.
        - Provide a link back to sign-in.
      `,
      reactExample: deindent`
        export default function CustomForgotPasswordPage() {
          const hexclaveApp = useHexclaveApp();
          const user = useUser({ or: "return-null" });
          const [email, setEmail] = useState("");
          const [sent, setSent] = useState(false);
          const [error, setError] = useState<string | null>(null);

          if (user) {
            return <MessageCard title="You are already signed in." />;
          }

          if (sent) {
            return <MessageCard title="Email sent" />;
          }

          return (
            <div>
              <Typography type="h2">Reset Your Password</Typography>
              <Typography>
                {"Don't need to reset? "}
                <a
                  href="#"
                  onClick={async (e) => {
                    e.preventDefault();
                    await hexclaveApp.redirectToSignIn();
                  }}
                >
                  Sign in
                </a>
              </Typography>

              <form onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                if (!email) {
                  setError("Please enter your email");
                  return;
                }
                await hexclaveApp.sendForgotPasswordEmail(email);
                setSent(true);
              }}>
                <Label htmlFor="email">Your Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                {error ? <Typography variant="destructive">{error}</Typography> : null}
                <Button type="submit">Send Email</Button>
              </form>
            </div>
          );
        }
      `,
      notes: deindent`
        - Keep the success state explicit so users know the request succeeded and do not repeatedly re-submit.
      `,
      versions: {},
    }),
    oauthCallback: createCustomPagePrompt({
      key: "oauthCallback",
      title: "OAuth Callback",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - Trigger OAuth callback handling once when the page loads by calling \`hexclaveApp.callOAuthCallback()\`.
        - If callback handler already redirected, keep a neutral loading state.
        - If callback handler did not redirect, redirect to sign-in with \`hexclaveApp.redirectToSignIn({ noRedirectBack: true })\`.
        - If callback processing throws, capture/show a useful error state.
        - Provide a fallback "click here" link in case automatic redirect does not happen.
      `,
      reactExample: deindent`
        export default function CustomOAuthCallbackPage() {
          const hexclaveApp = useHexclaveApp();
          const called = useRef(false);
          const [error, setError] = useState<unknown>(null);
          const [showRedirectLink, setShowRedirectLink] = useState(false);

          if (!called.current) {
            called.current = true;
            void runAsynchronously(async () => {
              setTimeout(() => setShowRedirectLink(true), 3000);
              try {
                const hasRedirected = await hexclaveApp.callOAuthCallback();
                if (!hasRedirected) {
                  await hexclaveApp.redirectToSignIn({ noRedirectBack: true });
                }
              } catch (e) {
                setError(e);
              }
            });
          }

          return (
            <div>
              <Spinner />
              {showRedirectLink ? (
                <Typography>
                  {"If you are not redirected automatically, "}
                  <a
                    href="#"
                    onClick={async (e) => {
                      e.preventDefault();
                      await hexclaveApp.redirectToHome();
                    }}
                  >
                    click here
                  </a>
                </Typography>
              ) : null}
              {error ? <pre>{JSON.stringify(error, null, 2)}</pre> : null}
            </div>
          );
        }
      `,
      notes: deindent`
        - This page is mainly control flow. Keep user-visible UI minimal while still providing a reliable fallback path.
      `,
      versions: {},
    }),
    magicLinkCallback: createCustomPagePrompt({
      key: "magicLinkCallback",
      title: "Magic Link Callback",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - If a user is already signed in, show a signed-in state.
        - Read the magic-link code from URL params.
        - If code is missing, show invalid-link state.
        - If code exists, show a confirmation step:
          - Confirm action calls \`hexclaveApp.signInWithMagicLink(code)\`.
          - Cancel action calls \`hexclaveApp.redirectToHome()\`.
        - Handle callback result:
          - \`VerificationCodeNotFound\` => invalid-link state.
          - \`VerificationCodeExpired\` => expired-link state.
          - \`VerificationCodeAlreadyUsed\` => already-used state.
          - Any other error => throw.
        - On success, show a success state with "Go home".
      `,
      reactExample: deindent`
        export default function CustomMagicLinkCallbackPage(props: { searchParams?: Record<string, string> }) {
          const hexclaveApp = useHexclaveApp();
          const user = useUser({ or: "return-null" });
          const [result, setResult] = useState<Awaited<ReturnType<typeof hexclaveApp.signInWithMagicLink>> | null>(null);
          const code = props.searchParams?.code;

          if (user) return <MessageCard title="You are already signed in." />;
          if (!code) return <MessageCard title="Invalid Magic Link" />;

          if (!result) {
            return (
              <MessageCard
                title="Do you want to sign in?"
                primaryButtonText="Sign in"
                primaryAction={async () => setResult(await hexclaveApp.signInWithMagicLink(code))}
                secondaryButtonText="Cancel"
                secondaryAction={async () => await hexclaveApp.redirectToHome()}
              />
            );
          }

          if (result.status === "error") {
            if (KnownErrors.VerificationCodeNotFound.isInstance(result.error)) return <MessageCard title="Invalid Magic Link" />;
            if (KnownErrors.VerificationCodeExpired.isInstance(result.error)) return <MessageCard title="Expired Magic Link" />;
            if (KnownErrors.VerificationCodeAlreadyUsed.isInstance(result.error)) return <MessageCard title="Magic Link Already Used" />;
            throw result.error;
          }

          return (
            <MessageCard
              title="Signed in successfully!"
              primaryButtonText="Go home"
              primaryAction={async () => await hexclaveApp.redirectToHome()}
            />
          );
        }
      `,
      notes: deindent`
        - Keep invalid/expired/already-used states distinct so users understand whether they should request a new link.
      `,
      versions: {},
    }),
    accountSettings: createCustomPagePrompt({
      key: "accountSettings",
      title: "Account Settings",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - Require an authenticated user (\`useUser({ or: "redirect" })\`) and project config (\`hexclaveApp.useProject()\`).
        - Render top-level pages in this order:
          - **My Profile**
          - **Emails & Auth**
          - **Notifications**
          - **Active Sessions**
          - **API Keys** (only if \`project.config.allowUserApiKeys\`)
          - **Payments** (only if user/team has billable products)
          - **Settings**
        - Conditionally include sections:
          - API keys page only when \`project.config.allowUserApiKeys\` is true.
          - Payments page only when user has products or at least one team has products.
        - Render team-related entries:
          - Show a "Teams" divider when teams exist or team creation is enabled.
          - For each team in \`user.useTeams()\`, render a team page with these sections:
            - Team user profile (override your own display name in this team) via \`user.useTeamProfile(team).update(...)\`.
            - Team profile image (\`team.update({ profileImageUrl })\`) only if \`user.usePermission(team, "$update_team")\`.
            - Team display name (\`team.update({ displayName })\`) only if \`user.usePermission(team, "$update_team")\`.
            - Member list (\`team.useUsers()\`) when \`$read_members\` or \`$invite_members\` permission exists.
            - Invite member form (\`team.inviteUser({ email })\`) when \`$invite_members\`; show outstanding invitations (\`team.useInvitations()\`) and revoke invitation action when \`$remove_members\`.
            - Team API keys (\`team.useApiKeys()\`, \`team.createApiKey(...)\`) only if \`user.usePermission(team, "$manage_api_keys")\` and \`project.config.allowTeamApiKeys\`.
            - Leave team confirmation flow using \`user.leaveTeam(team)\`.
          - Include "Create a team" page when \`project.config.clientTeamCreationEnabled\` and submit via \`user.createTeam({ displayName })\`.
        - **My Profile** page requirements:
          - Editable display name (\`user.update({ displayName })\`).
          - Editable profile image (\`user.update({ profileImageUrl })\`).
        - **Emails & Auth** page requirements (render all sub-sections in this order):
          - **Emails**:
            - List email contact channels from \`user.useContactChannels()\`.
            - Add email: \`user.createContactChannel({ type: "email", value, usedForAuth: false })\`.
            - Actions per email (with permission/state guards): send verification email, set primary (only if verified), toggle used-for-sign-in, remove email.
            - Prevent removing/disabling the last sign-in email.
          - **Password** (only if \`project.config.credentialEnabled\`):
            - If user already has password: update flow via \`user.updatePassword({ oldPassword, newPassword })\`.
            - If user has no password: set flow via \`user.setPassword({ password })\`.
            - Require a sign-in email before allowing set/update.
            - Validate password quality via \`getPasswordError()\`.
          - **Passkey** (only if \`project.config.passkeyEnabled\`):
            - Register passkey via \`user.registerPasskey()\`.
            - Disable passkey via \`user.update({ passkeyAuthEnabled: false })\`.
            - Require a verified sign-in email to enable.
            - Prevent disabling if passkey is currently the only sign-in method.
          - **OTP sign-in** (only if \`project.config.magicLinkEnabled\`):
            - Toggle OTP via \`user.update({ otpAuthEnabled: true | false })\`.
            - Require a verified sign-in email to enable.
            - Prevent disabling if OTP is currently the only sign-in method.
          - **MFA (TOTP)**:
            - Enable by generating secret + QR code, verify initial code, then persist secret via \`user.update({ totpMultiFactorSecret: secret })\`.
            - Disable via \`user.update({ totpMultiFactorSecret: null })\`.
        - **Notifications** page requirements:
          - Render categories from \`user.useNotificationCategories()\`.
          - Toggle each category via \`category.setEnabled(value)\`.
          - Show non-disableable categories as locked.
        - **Active Sessions** page requirements:
          - Load sessions via \`user.getActiveSessions()\`.
          - Show current vs other session, IP, location, created-at/last-used.
          - Revoke single session via \`user.revokeSession(sessionId)\`.
          - Revoke all non-current sessions with a confirmation step.
        - **API Keys** page requirements:
          - List keys via \`user.useApiKeys()\`.
          - Create via \`user.createApiKey(options)\`; show first-view key secret once.
          - Support revoke/update operations from table/actions.
        - **Payments** page requirements:
          - Support personal/team customer context switch.
          - Render current default payment method and allow updating it via setup-intent flow.
          - Render active plans/products with cancel and switch-plan actions.
          - Render recent invoices and link to hosted invoice URLs when available.
        - **Settings** page requirements:
          - Sign-out section (\`user.signOut()\`).
          - Delete-account section (only if \`project.config.clientUserDeletionEnabled\`) with destructive confirmation and \`user.delete()\` then redirect home.
        - Support extension points (for example \`extraItems\`) for custom sections.
        - Use loading/skeleton states for async sections.
      `,
      reactExample: deindent`
        function ProfileSection() {
          const user = useUser({ or: "redirect" });
          const [displayName, setDisplayName] = useState(user.displayName ?? "");
          const [profileImageUrl, setProfileImageUrl] = useState(user.profileImageUrl ?? "");

          return (
            <div>
              <Typography type="h3">My Profile</Typography>
              <Label htmlFor="display-name">Display name</Label>
              <Input id="display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <Label htmlFor="profile-image-url">Profile image URL</Label>
              <Input id="profile-image-url" value={profileImageUrl} onChange={(e) => setProfileImageUrl(e.target.value)} />
              <div className="flex gap-2 mt-2">
                <Button onClick={async () => await user.update({ displayName })}>Save display name</Button>
                <Button variant="secondary" onClick={async () => await user.update({ profileImageUrl })}>Save profile image</Button>
              </div>
            </div>
          );
        }

        function EmailsSection() {
          const user = useUser({ or: "redirect" });
          const [newEmail, setNewEmail] = useState("");
          const contactChannels = user.useContactChannels().filter((x) => x.type === "email");
          const usedForAuthCount = contactChannels.filter((x) => x.usedForAuth).length;

          return (
            <div className="space-y-3">
              <Typography type="h4">Emails</Typography>
              <form onSubmit={async (e) => {
                e.preventDefault();
                if (!newEmail) return;
                await user.createContactChannel({ type: "email", value: newEmail, usedForAuth: false });
                setNewEmail("");
              }}>
                <Input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Enter email" />
                <Button type="submit" className="mt-2">Add email</Button>
              </form>

              {contactChannels.map((channel) => {
                const isLastAuthEmail = channel.usedForAuth && usedForAuthCount === 1;
                return (
                  <div key={channel.id} className="border rounded p-3 space-y-2">
                    <Typography>{channel.value}</Typography>
                    <div className="flex gap-2 flex-wrap">
                      {!channel.isVerified ? <Button variant="secondary" onClick={async () => await channel.sendVerificationEmail()}>Send verification email</Button> : null}
                      {channel.isVerified && !channel.isPrimary ? <Button variant="secondary" onClick={async () => await channel.update({ isPrimary: true })}>Set as primary</Button> : null}
                      {channel.isVerified && !channel.usedForAuth ? <Button variant="secondary" onClick={async () => await channel.update({ usedForAuth: true })}>Use for sign-in</Button> : null}
                      {channel.usedForAuth ? <Button variant="secondary" disabled={isLastAuthEmail} onClick={async () => await channel.update({ usedForAuth: false })}>Stop using for sign-in</Button> : null}
                      <Button variant="destructive" disabled={isLastAuthEmail} onClick={async () => await channel.delete()}>Remove</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        }

        function PasswordSection() {
          const hexclaveApp = useHexclaveApp();
          const user = useUser({ or: "redirect" });
          const project = hexclaveApp.useProject();
          const [oldPassword, setOldPassword] = useState("");
          const [newPassword, setNewPassword] = useState("");
          const [newPasswordRepeat, setNewPasswordRepeat] = useState("");
          const hasAuthEmail = user.useContactChannels().some((x) => x.type === "email" && x.usedForAuth);

          if (!project.config.credentialEnabled) return null;

          return (
            <div className="space-y-2">
              <Typography type="h4">Password</Typography>
              {!hasAuthEmail ? <Typography variant="secondary">To set a password, please add a sign-in email.</Typography> : null}
              {user.hasPassword ? <Input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} placeholder="Old password" /> : null}
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password" />
              <Input type="password" value={newPasswordRepeat} onChange={(e) => setNewPasswordRepeat(e.target.value)} placeholder="Repeat new password" />
              <Button onClick={async () => {
                if (newPassword !== newPasswordRepeat) return;
                const passwordError = getPasswordError(newPassword);
                if (passwordError) return;
                if (user.hasPassword) await user.updatePassword({ oldPassword, newPassword });
                else await user.setPassword({ password: newPassword });
              }}>
                {user.hasPassword ? "Update password" : "Set password"}
              </Button>
            </div>
          );
        }

        function PasskeySection() {
          const hexclaveApp = useHexclaveApp();
          const user = useUser({ or: "redirect" });
          const project = hexclaveApp.useProject();
          const hasVerifiedAuthEmail = user.useContactChannels().some((x) => x.type === "email" && x.isVerified && x.usedForAuth);
          const isOnlyAuthMethod = user.passkeyAuthEnabled && !user.hasPassword && user.oauthProviders.length === 0 && !user.otpAuthEnabled;

          if (!project.config.passkeyEnabled) return null;

          return (
            <div className="space-y-2">
              <Typography type="h4">Passkey</Typography>
              {!hasVerifiedAuthEmail ? <Typography variant="secondary">Add a verified sign-in email before enabling passkey sign-in.</Typography> : null}
              {!user.passkeyAuthEnabled && hasVerifiedAuthEmail ? <Button onClick={async () => await user.registerPasskey()}>Add new passkey</Button> : null}
              {user.passkeyAuthEnabled ? (
                <Button
                  variant="secondary"
                  disabled={isOnlyAuthMethod}
                  onClick={async () => await user.update({ passkeyAuthEnabled: false })}
                >
                  Disable passkey
                </Button>
              ) : null}
            </div>
          );
        }

        function OtpSection() {
          const hexclaveApp = useHexclaveApp();
          const user = useUser({ or: "redirect" });
          const project = hexclaveApp.useProject();
          const hasVerifiedAuthEmail = user.useContactChannels().some((x) => x.type === "email" && x.isVerified && x.usedForAuth);
          const isOnlyAuthMethod = user.otpAuthEnabled && !user.hasPassword && user.oauthProviders.length === 0 && !user.passkeyAuthEnabled;

          if (!project.config.magicLinkEnabled) return null;

          return (
            <div className="space-y-2">
              <Typography type="h4">OTP sign-in</Typography>
              {!hasVerifiedAuthEmail ? <Typography variant="secondary">Add a verified sign-in email before enabling OTP sign-in.</Typography> : null}
              {!user.otpAuthEnabled && hasVerifiedAuthEmail ? <Button variant="secondary" onClick={async () => await user.update({ otpAuthEnabled: true })}>Enable OTP</Button> : null}
              {user.otpAuthEnabled ? <Button variant="secondary" disabled={isOnlyAuthMethod} onClick={async () => await user.update({ otpAuthEnabled: false })}>Disable OTP</Button> : null}
            </div>
          );
        }

        function MfaSection() {
          const user = useUser({ or: "redirect" });
          const [generatedSecret, setGeneratedSecret] = useState<Uint8Array | null>(null);
          const [mfaCode, setMfaCode] = useState("");

          return (
            <div className="space-y-2">
              <Typography type="h4">Multi-factor authentication</Typography>
              {!user.isMultiFactorRequired && !generatedSecret ? (
                <Button variant="secondary" onClick={async () => {
                  const secret = generateRandomValues(new Uint8Array(20));
                  setGeneratedSecret(secret);
                }}>
                  Enable MFA
                </Button>
              ) : null}
              {generatedSecret ? (
                <div className="space-y-2">
                  <Typography>Show generated QR code here and ask for the first code.</Typography>
                  <Input value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="123456" />
                  <Button onClick={async () => {
                    if (!verifyTOTP(generatedSecret, 30, 6, mfaCode)) return;
                    await user.update({ totpMultiFactorSecret: generatedSecret });
                    setGeneratedSecret(null);
                    setMfaCode("");
                  }}>
                    Confirm MFA setup
                  </Button>
                </div>
              ) : null}
              {user.isMultiFactorRequired ? <Button variant="secondary" onClick={async () => await user.update({ totpMultiFactorSecret: null })}>Disable MFA</Button> : null}
            </div>
          );
        }

        function EmailsAndAuthSection() {
          return (
            <div>
              <Typography type="h3">Emails & Auth</Typography>
              <EmailsSection />
              <PasswordSection />
              <PasskeySection />
              <OtpSection />
              <MfaSection />
            </div>
          );
        }

        function NotificationsSection() {
          return (
            <div>
              <Typography type="h3">Notifications</Typography>
              <Typography>Render notification preference controls here.</Typography>
            </div>
          );
        }

        function ActiveSessionsSection() {
          const user = useUser({ or: "redirect" });
          const [sessions, setSessions] = useState<ActiveSession[]>([]);

          return (
            <div>
              <Typography type="h3">Active Sessions</Typography>
              <Button variant="secondary" onClick={async () => setSessions(await user.getActiveSessions())}>Refresh sessions</Button>
              {sessions.map((session) => (
                <div key={session.id} className="border rounded p-2 mt-2">
                  <Typography>{session.isCurrentSession ? "Current Session" : "Other Session"}</Typography>
                  <Typography variant="secondary">{session.geoInfo?.ip ?? "-"} / {session.geoInfo?.cityName ?? "Unknown"}</Typography>
                  {!session.isCurrentSession ? <Button variant="destructive" onClick={async () => await user.revokeSession(session.id)}>Revoke</Button> : null}
                </div>
              ))}
              <Button
                variant="secondary"
                onClick={async () => {
                  const latestSessions = await user.getActiveSessions();
                  await Promise.all(latestSessions.filter((x) => !x.isCurrentSession).map((x) => user.revokeSession(x.id)));
                  setSessions(await user.getActiveSessions());
                }}
              >
                Revoke all other sessions
              </Button>
            </div>
          );
        }

        function ApiKeysSection() {
          const user = useUser({ or: "redirect" });
          const [newlyCreated, setNewlyCreated] = useState<ApiKey<"user", true> | null>(null);
          const apiKeys = user.useApiKeys();

          return (
            <div>
              <Typography type="h3">API Keys</Typography>
              <Button onClick={async () => {
                const created = await user.createApiKey({ description: "New key" });
                setNewlyCreated(created);
              }}>
                Create API key
              </Button>
              {newlyCreated ? <Typography variant="secondary">Copy this key now: {newlyCreated.value}</Typography> : null}
              {apiKeys.map((key) => (
                <div key={key.id} className="border rounded p-2 mt-2 flex justify-between">
                  <Typography>{key.description ?? key.id}</Typography>
                  <Button variant="destructive" onClick={async () => await key.revoke()}>Revoke</Button>
                </div>
              ))}
            </div>
          );
        }

        function PaymentsSection(props: { customer: any, customerType: "user" | "team" }) {
          const billing = props.customer.useBilling();
          const products = props.customer.useProducts().filter((p: any) => p.customerType === props.customerType);
          const invoices = props.customer.useInvoices({ limit: 10 });

          return (
            <div>
              <Typography type="h3">Payments</Typography>
              <Typography>Default payment method: {billing.defaultPaymentMethod ? "set" : "not set"}</Typography>
              <Button onClick={async () => {
                const setup = await props.customer.createPaymentMethodSetupIntent();
                await props.customer.setDefaultPaymentMethodFromSetupIntent(setup.clientSecret);
              }}>
                Update payment method
              </Button>

              <Typography type="h4">Active plans</Typography>
              {products.map((product: any) => (
                <div key={product.id ?? product.displayName} className="border rounded p-2 mt-2">
                  <Typography>{product.displayName}</Typography>
                  {product.subscription?.isCancelable ? (
                    <Button variant="secondary" onClick={async () => {
                      await useHexclaveApp().cancelSubscription({
                        ...(props.customerType === "team" ? { teamId: props.customer.id } : {}),
                        productId: product.id ?? "",
                        subscriptionId: product.subscription?.subscriptionId ?? undefined,
                      });
                    }}>
                      Cancel subscription
                    </Button>
                  ) : null}
                </div>
              ))}

              <Typography type="h4">Invoices</Typography>
              {invoices.map((invoice: any, index: number) => (
                <div key={index} className="flex justify-between border rounded p-2 mt-2">
                  <Typography>{invoice.status}</Typography>
                  {invoice.hostedInvoiceUrl ? <a href={invoice.hostedInvoiceUrl} target="_blank" rel="noreferrer">View</a> : <Typography variant="secondary">Unavailable</Typography>}
                </div>
              ))}
            </div>
          );
        }

        function TeamSection(props: { team: { displayName: string } }) {
          const user = useUser({ or: "redirect" });
          const hexclaveApp = useHexclaveApp();
          const project = hexclaveApp.useProject();
          const team = user.useTeam((props.team as any).id);

          if (!team) return null;

          const canUpdateTeam = user.usePermission(team, "$update_team");
          const canReadMembers = user.usePermission(team, "$read_members");
          const canInviteMembers = user.usePermission(team, "$invite_members");
          const canRemoveMembers = user.usePermission(team, "$remove_members");
          const canManageApiKeys = user.usePermission(team, "$manage_api_keys");

          return (
            <div className="space-y-3">
              <Typography type="h3">{props.team.displayName}</Typography>
              <Typography type="h4">Team user profile</Typography>
              <Button variant="secondary" onClick={async () => {
                const profile = user.useTeamProfile(team);
                await profile.update({ displayName: "Updated team display name for current user" });
              }}>
                Save team user display name
              </Button>

              {canUpdateTeam ? (
                <>
                  <Typography type="h4">Team profile image</Typography>
                  <Button variant="secondary" onClick={async () => await team.update({ profileImageUrl: "https://example.com/team.png" })}>
                    Save team profile image URL
                  </Button>

                  <Typography type="h4">Team display name</Typography>
                  <Button variant="secondary" onClick={async () => await team.update({ displayName: team.displayName + " (updated)" })}>
                    Save team display name
                  </Button>
                </>
              ) : null}

              {(canReadMembers || canInviteMembers) ? (
                <>
                  <Typography type="h4">Members</Typography>
                  {team.useUsers().map((member) => (
                    <Typography key={member.id}>{member.teamProfile.displayName ?? "No display name set"}</Typography>
                  ))}
                </>
              ) : null}

              {canInviteMembers ? (
                <div className="space-y-2">
                  <Typography type="h4">Invite member</Typography>
                  <Button variant="secondary" onClick={async () => await team.inviteUser({ email: "new-member@example.com" })}>
                    Invite user
                  </Button>
                  {canReadMembers ? team.useInvitations().map((invitation) => (
                    <div key={invitation.id} className="flex gap-2 items-center">
                      <Typography>{invitation.recipientEmail}</Typography>
                      {canRemoveMembers ? <Button variant="destructive" onClick={async () => await invitation.revoke()}>Revoke invitation</Button> : null}
                    </div>
                  )) : null}
                </div>
              ) : null}

              {(canManageApiKeys && project.config.allowTeamApiKeys) ? (
                <div>
                  <Typography type="h4">Team API Keys</Typography>
                  <Button variant="secondary" onClick={async () => await team.createApiKey({ description: "Team key" })}>
                    Create team API key
                  </Button>
                </div>
              ) : null}

              <div>
                <Typography type="h4">Leave team</Typography>
                <Button variant="destructive" onClick={async () => {
                  await user.leaveTeam(team);
                  window.location.reload();
                }}>
                  Leave team
                </Button>
              </div>
            </div>
          );
        }

        function CreateTeamSection() {
          const hexclaveApp = useHexclaveApp();
          const user = useUser({ or: "redirect" });
          const project = hexclaveApp.useProject();
          const navigate = hexclaveApp.useNavigate();
          const [displayName, setDisplayName] = useState("");

          if (!project.config.clientTeamCreationEnabled) {
            return <Typography variant="secondary">Team creation is not enabled.</Typography>;
          }

          return (
            <div>
              <Typography type="h3">Create a team</Typography>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Team name" />
              <Button onClick={async () => {
                const team = await user.createTeam({ displayName });
                navigate("#team-" + team.id);
              }}>
                Create
              </Button>
            </div>
          );
        }

        function SettingsSection() {
          const user = useUser({ or: "redirect" });
          return (
            <div>
              <Typography type="h3">Settings</Typography>
              <Button onClick={async () => await user.signOut()}>Sign out</Button>
              <Button variant="destructive" onClick={async () => {
                await user.delete();
                await useHexclaveApp().redirectToHome();
              }}>
                Delete account
              </Button>
            </div>
          );
        }

        export default function CustomAccountSettingsPage(props: { extraItems?: { id: string, title: string, content: React.ReactNode }[] }) {
          const hexclaveApp = useHexclaveApp();
          const user = useUser({ or: "redirect" });
          const project = hexclaveApp.useProject();
          const teams = user.useTeams();
          const [activeId, setActiveId] = useState("profile");
          const [selectedPaymentTeamId, setSelectedPaymentTeamId] = useState<string | null>(null);
          const [paymentsReady, setPaymentsReady] = useState(false);
          const [userHasProducts, setUserHasProducts] = useState(false);
          const [teamIdsWithProducts, setTeamIdsWithProducts] = useState<Set<string>>(new Set());

          if (!paymentsReady) {
            void runAsynchronously(async () => {
              const userProducts = await user.listProducts({ limit: 1 });
              const teamsWithProducts = await Promise.all(
                teams.map(async (team) => {
                  const isAdmin = await user.hasPermission(team, "team_admin");
                  if (!isAdmin) return null;
                  const teamProducts = await team.listProducts({ limit: 1 });
                  const hasTeamProducts = teamProducts.some((product) => product.customerType === "team");
                  return hasTeamProducts ? team.id : null;
                })
              );
              setUserHasProducts(userProducts.some((product) => product.customerType === "user"));
              setTeamIdsWithProducts(new Set(teamsWithProducts.filter((id): id is string => id !== null)));
              setPaymentsReady(true);
            });
          }

          const teamsWithProducts = teams.filter((team) => teamIdsWithProducts.has(team.id));
          const shouldShowPayments = paymentsReady && (userHasProducts || teamsWithProducts.length > 0);
          const selectedPaymentTeam = selectedPaymentTeamId
            ? teams.find((team) => team.id === selectedPaymentTeamId) ?? null
            : null;
          const paymentCustomer = selectedPaymentTeam ?? (userHasProducts ? user : null);
          const paymentCustomerType = selectedPaymentTeam ? "team" : "user";

          const items = [
            { id: "profile", title: "My Profile", content: <ProfileSection /> },
            { id: "auth", title: "Emails & Auth", content: <EmailsAndAuthSection /> },
            { id: "notifications", title: "Notifications", content: <NotificationsSection /> },
            { id: "sessions", title: "Active Sessions", content: <ActiveSessionsSection /> },
            ...(project.config.allowUserApiKeys ? [{ id: "api-keys", title: "API Keys", content: <ApiKeysSection /> }] : []),
            ...(shouldShowPayments && paymentCustomer ? [{
              id: "payments",
              title: "Payments",
              content: (
                <div className="space-y-2">
                  {teamsWithProducts.length > 0 ? (
                    <Select value={selectedPaymentTeamId ?? "__personal__"} onValueChange={(value) => setSelectedPaymentTeamId(value === "__personal__" ? null : value)}>
                      <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {userHasProducts ? <SelectItem value="__personal__">Personal</SelectItem> : null}
                        {teamsWithProducts.map((team) => <SelectItem key={team.id} value={team.id}>{team.displayName}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <PaymentsSection customer={paymentCustomer} customerType={paymentCustomerType} />
                </div>
              ),
            }] : []),
            ...(props.extraItems ?? []),
            ...(teams.length > 0 || project.config.clientTeamCreationEnabled ? [{ id: "teams-divider", title: "Teams", content: null }] : []),
            ...teams.map((team) => ({ id: "team-" + team.id, title: team.displayName, content: <TeamSection team={team} /> })),
            ...(project.config.clientTeamCreationEnabled ? [{ id: "team-create", title: "Create a team", content: <CreateTeamSection /> }] : []),
            { id: "settings", title: "Settings", content: <SettingsSection /> },
          ];

          const activeItem = items.find((item) => item.id === activeId) ?? items[0];

          return (
            <div>
              <Typography type="h2">Account Settings</Typography>
              <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 16 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {items.map((item) => (
                    <Button key={item.id} variant={item.id === activeId ? "default" : "secondary"} onClick={() => setActiveId(item.id)}>
                      {item.title}
                    </Button>
                  ))}
                </div>
                <div>{activeItem.content}</div>
              </div>
            </div>
          );
        }
      `,
      notes: deindent`
        - Keep section boundaries explicit and low-coupled so teams can evolve independently without rewriting the full page.
      `,
      versions: {},
    }),
    teamInvitation: createCustomPagePrompt({
      key: "teamInvitation",
      title: "Team Invitation",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - Read invitation code from URL params.
        - If code is missing, show invalid-link state.
        - Resolve current user with \`includeRestricted: true\`.
          - If user is signed out, show a sign-in prompt with cancel path.
          - If user is restricted, route user to onboarding first.
        - Verify invitation code via \`hexclaveApp.verifyTeamInvitationCode(code)\`:
          - Not found => invalid-link state.
          - Expired => expired-link state.
          - Already used => used-link state.
          - Other errors => throw.
        - If code is valid, load invitation details via \`hexclaveApp.getTeamInvitationDetails(code)\`.
        - Render invitation actions:
          - Join => \`hexclaveApp.acceptTeamInvitation(code)\`.
          - Ignore => \`hexclaveApp.redirectToHome()\`.
        - On successful join, show success state and allow navigation home.
      `,
      reactExample: deindent`
        export default function CustomTeamInvitationPage(props: { searchParams: Record<string, string> }) {
          const hexclaveApp = useHexclaveApp();
          const user = useUser({ or: "return-null", includeRestricted: true });
          const code = props.searchParams.code;
          const [accepted, setAccepted] = useState(false);
          const [details, setDetails] = useState<null | { teamDisplayName: string }>(null);
          const [pageError, setPageError] = useState<null | "invalid" | "expired" | "used" | "unknown">(null);

          if (!code) return <MessageCard title="Invalid Team Invitation Link" />;

          if (!user) {
            return (
              <MessageCard
                title="Team invitation"
                primaryButtonText="Sign in"
                primaryAction={async () => await hexclaveApp.redirectToSignIn()}
                secondaryButtonText="Cancel"
                secondaryAction={async () => await hexclaveApp.redirectToHome()}
              />
            );
          }

          if (user.isRestricted) {
            return (
              <MessageCard
                title="Complete your account setup"
                primaryButtonText="Complete setup"
                primaryAction={async () => await hexclaveApp.redirectToOnboarding()}
              />
            );
          }

          if (pageError === "invalid") return <MessageCard title="Invalid Team Invitation Link" />;
          if (pageError === "expired") return <MessageCard title="Expired Team Invitation Link" />;
          if (pageError === "used") return <MessageCard title="Used Team Invitation Link" />;
          if (pageError === "unknown") return <PredefinedMessageCard type="unknownError" />;

          if (!details) {
            return (
              <MessageCard
                title="Team invitation"
                primaryButtonText="Check invitation"
                primaryAction={async () => {
                  const verification = await hexclaveApp.verifyTeamInvitationCode(code);
                  if (verification.status === "error") {
                    if (KnownErrors.VerificationCodeNotFound.isInstance(verification.error)) {
                      setPageError("invalid");
                      return;
                    }
                    if (KnownErrors.VerificationCodeExpired.isInstance(verification.error)) {
                      setPageError("expired");
                      return;
                    }
                    if (KnownErrors.VerificationCodeAlreadyUsed.isInstance(verification.error)) {
                      setPageError("used");
                      return;
                    }
                    throw verification.error;
                  }

                  const invitationDetails = await hexclaveApp.getTeamInvitationDetails(code);
                  if (invitationDetails.status === "error") {
                    setPageError("unknown");
                    return;
                  }

                  setDetails(invitationDetails.data);
                }}
                secondaryButtonText="Cancel"
                secondaryAction={async () => await hexclaveApp.redirectToHome()}
              >
                We will verify your invitation before showing the join action.
              </MessageCard>
            );
          }

          if (accepted) {
            return <MessageCard title="Team invitation">You have successfully joined {details.teamDisplayName}</MessageCard>;
          }

          return (
            <MessageCard
              title="Team invitation"
              primaryButtonText="Join"
              primaryAction={async () => {
                const result = await hexclaveApp.acceptTeamInvitation(code);
                if (result.status === "ok") setAccepted(true);
                else setPageError("unknown");
              }}
              secondaryButtonText="Ignore"
              secondaryAction={async () => await hexclaveApp.redirectToHome()}
            >
              You are invited to join {details.teamDisplayName}
            </MessageCard>
          );
        }
      `,
      notes: deindent`
        - Treat invitation flow as a gatekeeper: auth state, restricted state, and code validity should be checked in a predictable order.
      `,
      versions: {},
    }),
    cliAuthConfirm: createCustomPagePrompt({
      key: "cliAuthConfirm",
      title: "CLI Auth Confirmation",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - Use \`useCliAuthConfirmation()\`.
        - If \`status === "invalid"\`, show an invalid-link state.
        - If \`status === "success"\`, tell the user they can close the browser and return to the CLI.
        - If \`status === "error"\`, show the error and a retry action.
        - Otherwise, show a confirmation step that calls \`authorize()\`.
        - Use \`isLoading\` to disable or show loading on the confirmation action while the hook is authorizing or redirecting.
      `,
      reactExample: deindent`
        export default function CustomCliAuthConfirmPage() {
          const cliAuth = useCliAuthConfirmation();

          if (cliAuth.status === "invalid") {
            return <MessageCard title="Invalid CLI authorization link" />;
          }

          if (cliAuth.status === "success") {
            return <MessageCard title="CLI authorized">You can close this window and return to the command line.</MessageCard>;
          }

          if (cliAuth.status === "error") {
            return (
              <MessageCard
                title="CLI authorization failed"
                primaryButtonText="Try again"
                primaryAction={cliAuth.retry}
              >
                {cliAuth.error?.message}
              </MessageCard>
            );
          }

          return (
            <MessageCard
              title="Authorize CLI application"
              primaryButtonText={cliAuth.isLoading ? "Authorizing..." : "Authorize"}
              primaryAction={cliAuth.authorize}
            >
              A command line application is requesting access to your account.
            </MessageCard>
          );
        }
      `,
      notes: deindent`
        - Be explicit about the account being authorized. CLI auth grants a refresh token to the command line application.
        - The hook owns the protocol details: reading \`login_code\`, preserving confirmed state across redirects, claiming anonymous sessions, and completing authorization.
      `,
      versions: {},
    }),
    agentAuthConfirm: createCustomPagePrompt({
      key: "agentAuthConfirm",
      title: "Agent Auth Confirmation",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - Use \`useAgentAuthConfirmation()\`.
        - If \`status === "invalid"\`, show an invalid-link state (the URL has no \`code\`).
        - If \`status === "loading"\` or \`status === "redirecting"\`, show a loading state.
        - If \`status === "error"\`, show the error and a retry action.
        - If \`status === "approved"\`, tell the user the agent now has access and that they can revoke it from their account settings.
        - If \`status === "denied"\`, confirm that the agent was not granted access.
        - Otherwise (\`status === "ready"\`), show \`agent.name\`, \`agent.description\`, \`agent.url\` and \`userHint\`, and offer \`approve()\` and \`deny()\`.
        - Use \`isLoading\` to disable the actions while a request is in flight.
      `,
      reactExample: deindent`
        export default function CustomAgentAuthConfirmPage() {
          const agentAuth = useAgentAuthConfirmation();

          if (agentAuth.status === "invalid") {
            return <MessageCard title="Invalid agent authorization link" />;
          }

          if (agentAuth.status === "approved") {
            return <MessageCard title="Agent connected">{agentAuth.agent?.name} can now act on your behalf. You can revoke its access from your account settings at any time.</MessageCard>;
          }

          if (agentAuth.status === "denied") {
            return <MessageCard title="Agent denied">The agent was not granted access.</MessageCard>;
          }

          if (agentAuth.status === "error") {
            return (
              <MessageCard
                title="Agent authorization failed"
                primaryButtonText="Try again"
                primaryAction={agentAuth.retry}
              >
                {agentAuth.error?.message}
              </MessageCard>
            );
          }

          if (agentAuth.status !== "ready") {
            return <MessageCard title="Loading..." />;
          }

          return (
            <MessageCard
              title={\`Allow \${agentAuth.agent.name} to access your account?\`}
              primaryButtonText={agentAuth.isLoading ? "Approving..." : "Approve"}
              primaryAction={agentAuth.approve}
              secondaryButtonText="Deny"
              secondaryAction={agentAuth.deny}
            >
              {agentAuth.agent.description}
            </MessageCard>
          );
        }
      `,
      notes: deindent`
        - Be explicit that approving creates a new session for the agent on the user's account with the user's full permissions.
        - The hook owns the protocol details: reading \`code\`, redirecting to sign-in when needed, inspecting the attempt, and calling approve/deny.
      `,
      versions: {},
    }),
    mfa: createCustomPagePrompt({
      key: "mfa",
      title: "MFA",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - Read the MFA attempt code from session storage.
        - Render OTP input for the one-time code.
        - When OTP is complete, submit \`hexclaveApp.signInWithMfa(otp, attemptCode, { noRedirect: true })\`.
        - Handle result:
          - Success => clear stored attempt code, show success state, then redirect after sign-in.
          - \`InvalidTotpCode\` => show invalid-code error and allow retry.
          - Other errors => show generic verification failure.
        - Keep a clear verifying/loading state while request is in flight.
        - Optionally provide a cancel action.
      `,
      reactExample: deindent`
        function OtpInput(props: { value: string, onChange: (value: string) => void, disabled?: boolean }) {
          return (
            <InputOTP maxLength={6} value={props.value} onChange={(value) => props.onChange(value.toUpperCase())} disabled={props.disabled}>
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((index) => (
                  <InputOTPSlot key={index} index={index} />
                ))}
              </InputOTPGroup>
            </InputOTP>
          );
        }

        export default function CustomMfaPage() {
          const hexclaveApp = useHexclaveApp();
          const [otp, setOtp] = useState("");
          const [submitting, setSubmitting] = useState(false);
          const [error, setError] = useState<string | null>(null);
          const [verified, setVerified] = useState(false);
          const attemptCode = typeof window !== "undefined"
            // Hexclave rebrand: prefer the new MFA attempt code key, fall back to the legacy key.
            ? (window.sessionStorage.getItem("hexclave_mfa_attempt_code") ?? window.sessionStorage.getItem("stack_mfa_attempt_code"))
            : null;

          const submit = async () => {
            if (!attemptCode || otp.length !== 6 || submitting) return;
            setSubmitting(true);
            setError(null);
            const result = await hexclaveApp.signInWithMfa(otp, attemptCode, { noRedirect: true });
            if (result.status === "ok") {
              // Hexclave rebrand: remove both the new and legacy MFA attempt code keys.
              window.sessionStorage.removeItem("hexclave_mfa_attempt_code");
              window.sessionStorage.removeItem("stack_mfa_attempt_code");
              setVerified(true);
              await hexclaveApp.redirectToAfterSignIn();
            } else if (KnownErrors.InvalidTotpCode.isInstance(result.error)) {
              setError("Invalid TOTP code");
              setOtp("");
            } else {
              setError("Verification failed");
            }
            setSubmitting(false);
          };

          return (
            <div>
              <Typography type="h2">Multi-Factor Authentication</Typography>
              <Typography>Enter the six-digit code from your authenticator app</Typography>
              <OtpInput
                value={otp}
                disabled={submitting || verified}
                onChange={(value) => {
                  setOtp(value);
                  if (value.length === 6) {
                    void submit();
                  } else {
                    setError(null);
                  }
                }}
              />
              {submitting ? <Typography>Verifying...</Typography> : null}
              {verified ? <Typography>Verified! Redirecting...</Typography> : null}
              {error ? <Typography variant="destructive">{error}</Typography> : null}
            </div>
          );
        }
      `,
      notes: deindent`
        - Keep MFA state transitions explicit (idle, verifying, verified, error) so retries and redirects are predictable.
      `,
      versions: {},
    }),
    error: createCustomPagePrompt({
      key: "error",
      title: "Error",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - Read \`errorCode\`, \`message\`, and optional \`details\` from URL params.
        - If required params are missing, show unknown-error state.
        - Parse error via \`KnownError.fromJson(...)\`.
          - If parsing fails, show unknown-error state.
        - Handle specific known OAuth-related errors with tailored messages/actions.
        - For all other known errors, show a generic known-error card/state.
      `,
      reactExample: deindent`
        export default function CustomErrorPage(props: { searchParams: Record<string, string> }) {
          const hexclaveApp = useHexclaveApp();
          const errorCode = props.searchParams.errorCode;
          const message = props.searchParams.message;
          const details = props.searchParams.details;

          if (!errorCode || !message) {
            return <PredefinedMessageCard type="unknownError" />;
          }

          let error: KnownError;
          try {
            error = KnownError.fromJson({
              code: errorCode,
              message,
              details: details ? JSON.parse(details) : {},
            });
          } catch {
            return <PredefinedMessageCard type="unknownError" />;
          }

          if (KnownErrors.OAuthConnectionAlreadyConnectedToAnotherUser.isInstance(error)) {
            return <MessageCard title="Failed to connect account" primaryButtonText="Go Home" primaryAction={() => hexclaveApp.redirectToHome()} />;
          }

          if (KnownErrors.UserAlreadyConnectedToAnotherOAuthConnection.isInstance(error)) {
            return <MessageCard title="Failed to connect account" primaryButtonText="Go Home" primaryAction={() => hexclaveApp.redirectToHome()} />;
          }

          if (KnownErrors.OAuthProviderAccessDenied.isInstance(error)) {
            return (
              <MessageCard
                title="OAuth provider access denied"
                primaryButtonText="Sign in again"
                primaryAction={() => hexclaveApp.redirectToSignIn()}
                secondaryButtonText="Go Home"
                secondaryAction={() => hexclaveApp.redirectToHome()}
              />
            );
          }

          return <KnownErrorMessageCard error={error} />;
        }
      `,
      notes: deindent`
        - Fail safely on malformed query params. Unknown-error fallback should always be available.
      `,
      versions: {},
    }),
    onboarding: createCustomPagePrompt({
      key: "onboarding",
      title: "Onboarding",
      minSdkVersion: "0.0.1",
      structure: deindent`
        - Resolve user with \`useUser({ or: "return-null", includeRestricted: true })\`.
        - Route by user state:
          - Restricted user resolved to unrestricted => redirect to \`hexclaveApp.redirectToAfterSignIn()\`.
          - Missing/anonymous user => redirect to \`hexclaveApp.redirectToSignIn()\`.
          - Restricted user => continue onboarding flow.
        - Handle restricted reasons:
          - \`email_not_verified\` and no primary email => ask user for email and call \`user.update({ primaryEmail })\`.
          - \`email_not_verified\` with primary email => show verification step, resend via \`user.sendVerificationEmail()\`, allow changing email.
          - \`restricted_by_administrator\` => show \`user.restrictedByAdminReason\` (the public reason set by an administrator), falling back to a generic restricted message.
          - Any other restricted reason => show generic setup-required state.
        - Provide sign-out path from onboarding states.
      `,
      reactExample: deindent`
        export default function CustomOnboardingPage() {
          const hexclaveApp = useHexclaveApp();
          const user = useUser({ or: "return-null", includeRestricted: true });
          const [email, setEmail] = useState("");
          const [changeEmail, setChangeEmail] = useState(false);

          if (user && !user.isRestricted) {
            void runAsynchronously(hexclaveApp.redirectToAfterSignIn());
            return null;
          }

          if (!user || user.isAnonymous) {
            void runAsynchronously(hexclaveApp.redirectToSignIn());
            return null;
          }

          if (user.restrictedReason?.type === "restricted_by_administrator") {
            return (
              <MessageCard
                title="Your account has been restricted"
                secondaryButtonText="Sign out"
                secondaryAction={async () => await user.signOut()}
              >
                {user.restrictedByAdminReason ?? "An administrator has restricted your account."}
              </MessageCard>
            );
          }

          if (user.restrictedReason?.type !== "email_not_verified") {
            return (
              <MessageCard
                title="Complete your account setup"
                secondaryButtonText="Sign out"
                secondaryAction={async () => await user.signOut()}
              />
            );
          }

          if (!user.primaryEmail || changeEmail) {
            return (
              <form onSubmit={async (e) => {
                e.preventDefault();
                await user.update({ primaryEmail: email });
                setChangeEmail(false);
              }}>
                <Typography>Add your email address</Typography>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <Button type="submit">Continue</Button>
              </form>
            );
          }

          return (
            <MessageCard
              title="Please check your email inbox"
              primaryButtonText="Resend verification email"
              primaryAction={async () => await user.sendVerificationEmail()}
              secondaryButtonText="Sign out"
              secondaryAction={async () => await user.signOut()}
            >
              Please verify your email address {user.primaryEmail}.{" "}
              <button type="button" onClick={() => setChangeEmail(true)}>change</button>
            </MessageCard>
          );
        }
      `,
      notes: deindent`
        - Treat onboarding as a state machine based on restricted reason; avoid mixing unrelated onboarding states into one branch.
      `,
      versions: {},
    }),
  };
}

export function getLatestPageVersions(): Record<string, { version: number, changelogs: Record<number, string> }> {
  return Object.fromEntries(
    Object.entries(getCustomPagePrompts()).map(([key, prompt]) => {
      const versionKeys = Object.keys(prompt.versions).map(Number);
      const latest = versionKeys.length > 0 ? Math.max(...versionKeys) : 0;
      const changelogs: Record<number, string> = {};
      for (const v of versionKeys) {
        if (prompt.versions[v].changelog) {
          changelogs[v] = prompt.versions[v].changelog;
        }
      }
      return [key, { version: latest, changelogs }];
    })
  );
}

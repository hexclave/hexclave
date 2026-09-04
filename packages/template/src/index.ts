export * from './lib/hexclave-app';
export { getConvexProvidersConfig } from "./integrations/convex";
// Hexclave aliases and legacy Stack* names — @deprecated JSDoc lives on the original
// declarations in @hexclave/shared/config so it survives dts bundling
// (per-specifier JSDoc on re-exports does not).
export type { HexclaveConfig, StackConfig } from "@hexclave/shared/config";
export { defineHexclaveConfig, defineStackConfig } from "@hexclave/shared/config";
// The author-facing types for the config file's `deploy` export.
export type {
  HexclaveDeploymentConfig,
  HexclaveDeploymentContext,
  HexclaveDeploymentReference,
  HexclaveEnvVarValue,
  HexclavePersistentVolume,
  HexclaveServerService,
  HexclaveServerlessService,
  HexclaveService,
  HexclaveServiceOutputs,
} from "@hexclave/shared/config";

// IF_PLATFORM react-like
export type { AnalyticsOptions, AnalyticsReplayOptions } from "./lib/hexclave-app/apps/implementations/session-replay";
// Hexclave aliases and legacy Stack* names — @deprecated JSDoc lives on the original
// declarations in the source files (so it survives dts bundling).
export { HexclaveHandler, StackHandler } from "./components-page/hexclave-handler";
export { useHexclaveApp, useStackApp } from "./lib/hooks";
export { HexclaveProvider, StackProvider } from "./providers/hexclave-provider";
export { HexclaveTheme, StackTheme } from './providers/theme-provider';
export { useFeatureFlag, useFeatureFlagDetails, useUser } from "./lib/hooks";

export { AccountSettings } from "./components-page/account-settings";
export { AuthPage } from "./components-page/auth-page";
export { CliAuthConfirmation, useCliAuthConfirmation, type CliAuthConfirmationState, type CliAuthConfirmationStatus } from "./components-page/cli-auth-confirm";
export { EmailVerification } from "./components-page/email-verification";
export { ForgotPassword } from "./components-page/forgot-password";
export { PasswordReset } from "./components-page/password-reset";
export { SignIn } from "./components-page/sign-in";
export { SignUp } from "./components-page/sign-up";
export { CredentialSignIn as CredentialSignIn } from "./components/credential-sign-in";
export { CredentialSignUp as CredentialSignUp } from "./components/credential-sign-up";
export { UserAvatar } from "./components/elements/user-avatar";
export { MagicLinkSignIn as MagicLinkSignIn } from "./components/magic-link-sign-in";
export { MessageCard } from "./components/message-cards/message-card";
export { OAuthButton } from "./components/oauth-button";
export { OAuthButtonGroup } from "./components/oauth-button-group";
export { SelectedTeamSwitcher } from "./components/selected-team-switcher";
export { TeamSwitcher } from "./components/team-switcher";
export { UserButton } from "./components/user-button";
// END_PLATFORM

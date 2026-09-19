import { getCustomPagePrompts, type CustomPagePrompt } from "@hexclave/shared/dist/interface/handler-urls";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { getHostedHandlerUrlFromConfig } from "@hexclave/shared/dist/utils/redirect-urls";
import { envVars } from "../../generated/env";
import { DefaultHandlerUrlTarget, HandlerPageUrls, HandlerUrlOptions, HandlerUrlTarget, HandlerUrls, ResolvedHandlerUrls } from "./common";

const localUrlPlaceholderOrigin = "http://example.com";
const schemePrefixRegex = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

const customPagePrompts: Record<keyof Omit<HandlerPageUrls, "handler">, CustomPagePrompt> = getCustomPagePrompts();

const joinHandlerComponentPath = (basePath: string, pagePath: string): string => {
  const normalizedBasePath = basePath.endsWith("/") && basePath.length > 1
    ? basePath.slice(0, -1)
    : basePath;
  if (pagePath.length === 0) {
    return normalizedBasePath;
  }
  if (normalizedBasePath === "/") {
    return `/${pagePath}`;
  }
  return `${normalizedBasePath}/${pagePath}`;
};

const getHostedPagePathForHandlerName = (handlerName: keyof HandlerUrls): string => {
  switch (handlerName) {
    case "handler": {
      return "";
    }
    case "home": {
      return "";
    }
    case "afterSignIn": {
      return "";
    }
    case "afterSignUp": {
      return "";
    }
    case "afterSignOut": {
      return "";
    }
    case "signIn": {
      return "sign-in";
    }
    case "signUp": {
      return "sign-up";
    }
    case "signOut": {
      return "sign-out";
    }
    case "emailVerification": {
      return "email-verification";
    }
    case "passwordReset": {
      return "password-reset";
    }
    case "forgotPassword": {
      return "forgot-password";
    }
    case "oauthCallback": {
      return "oauth-callback";
    }
    case "magicLinkCallback": {
      return "magic-link-callback";
    }
    case "accountSettings": {
      return "account-settings";
    }
    case "teamInvitation": {
      return "team-invitation";
    }
    case "cliAuthConfirm": {
      return "cli-auth-confirm";
    }
    case "agentAuthConfirm": {
      return "agent-auth-confirm";
    }
    case "mfa": {
      return "mfa";
    }
    case "error": {
      return "error";
    }
    case "onboarding": {
      return "onboarding";
    }
  }
};

const resolveCustomTargetUrl = (options: {
  target: { type: "custom", url: string, version: number },
  handlerName: keyof HandlerUrls,
}): string => {
  const handlerName = options.handlerName;
  if (handlerName in customPagePrompts) {
    const customPagePrompt = customPagePrompts[handlerName as keyof typeof customPagePrompts];
    if (options.target.version === 0 || options.target.version in customPagePrompt.versions) {
      return options.target.url;
    }

    throw new Error(`Unsupported custom page version ${options.target.version} for ${options.handlerName} page at ${options.target.url}. The latest supported version of this page is ${Math.max(0, ...Object.keys(customPagePrompt.versions).map(Number))}. Please upgrade your Hexclave SDK to a version that supports this version.`);
  } else {
    throw new Error(`URL target ${options.handlerName} cannot be a custom page. Please specify the URL as a string instead.`);
  }
};

export const getHostedHandlerUrl = (options: { projectId: string, pagePath: string }): string => {
  const normalizedPagePath = options.pagePath.replace(/^\/+/, "");
  const hostedPath = normalizedPagePath.length > 0 ? `handler/${normalizedPagePath}` : "handler";
  return getHostedHandlerUrlFromConfig({
    projectId: options.projectId,
    hostedPath,
    hostedHandlerDomainSuffix: envVars.HEXCLAVE_HOSTED_HANDLER_DOMAIN_SUFFIX,
    hostedHandlerUrlTemplate: envVars.HEXCLAVE_HOSTED_HANDLER_URL_TEMPLATE,
    hexclavePortPrefix: envVars.HEXCLAVE_PORT_PREFIX,
  });
};

const isRelativeUrlString = (url: string): boolean => {
  if (url.startsWith("//")) {
    return false;
  }
  return !schemePrefixRegex.test(url);
};

const nonHostedHandlerNames = new Set<keyof HandlerUrls>([
  "home",
  "afterSignIn",
  "afterSignUp",
  "afterSignOut",
]);

export const isLocalHandlerUrlTarget = (options: {
  targetUrl: string,
  handlerPath: string,
  currentOrigin?: string,
}): boolean => {
  const urlObject = new URL(options.targetUrl, localUrlPlaceholderOrigin);
  const isHandlerPathTarget = urlObject.pathname === options.handlerPath
    || urlObject.pathname.startsWith(`${options.handlerPath}/`);
  if (!isHandlerPathTarget) {
    return false;
  }

  // On server we only have path information, so treat matching handler paths as local.
  if (options.currentOrigin == null) {
    return true;
  }

  return isRelativeUrlString(options.targetUrl) || urlObject.origin === options.currentOrigin;
};

const resolveUrlTarget = (options: {
  target: HandlerUrlTarget,
  fallbackPath: string,
  handlerName: keyof HandlerUrls,
  projectId: string,
}): string => {
  if (typeof options.target === "string") {
    return options.target;
  }

  switch (options.target.type) {
    case "handler-component": {
      return options.fallbackPath;
    }
    case "hosted": {
      if (nonHostedHandlerNames.has(options.handlerName)) {
        return options.fallbackPath;
      }
      return getHostedHandlerUrl({
        projectId: options.projectId,
        pagePath: getHostedPagePathForHandlerName(options.handlerName),
      });
    }
    case "custom": {
      return resolveCustomTargetUrl({
        target: options.target,
        handlerName: options.handlerName,
      });
    }
  }
};

const assertOAuthCallbackTargetIsRelative = (target: HandlerUrlTarget): void => {
  const url = typeof target === "string"
    ? target
    : target.type === "custom"
      ? target.url
      : null;
  if (url != null && !isRelativeUrlString(url)) {
    throw new HexclaveAssertionError("OAuth callback URLs must be relative.", {
      oauthCallbackUrl: url,
      hint: "Use a relative URL like '/handler/oauth-callback', or use { type: 'hosted' } to let Stack use the current page for hosted callbacks.",
    });
  }
};

export const resolveHandlerUrls = (options: { urls: HandlerUrlOptions | undefined, projectId: string }): ResolvedHandlerUrls => {
  const configuredUrls = options.urls;
  const defaultTarget = configuredUrls?.default ?? { type: "handler-component" } as const;
  const oauthCallbackTarget: HandlerUrlTarget = configuredUrls?.oauthCallback ?? (
    defaultTarget.type === "hosted"
      ? defaultTarget
      : { type: "handler-component" }
  );
  assertOAuthCallbackTargetIsRelative(oauthCallbackTarget);
  let handlerComponentBasePath = "/handler";
  if (typeof configuredUrls?.handler === "string") {
    handlerComponentBasePath = configuredUrls.handler;
  } else if (configuredUrls?.handler != null && configuredUrls.handler.type === "custom") {
    handlerComponentBasePath = resolveCustomTargetUrl({
      target: configuredUrls.handler,
      handlerName: "handler",
    });
  }

  const homeTarget = configuredUrls?.home ?? defaultTarget;
  const localHome = resolveUrlTarget({
    target: typeof homeTarget !== "string" && homeTarget.type === "hosted"
      ? { type: "handler-component" }
      : homeTarget,
    fallbackPath: "/",
    handlerName: "home",
    projectId: options.projectId,
  });
  const home = resolveUrlTarget({
    target: homeTarget,
    fallbackPath: "/",
    handlerName: "home",
    projectId: options.projectId,
  });
  const afterSignIn = resolveUrlTarget({
    target: configuredUrls?.afterSignIn ?? defaultTarget,
    fallbackPath: localHome,
    handlerName: "afterSignIn",
    projectId: options.projectId,
  });

  return {
    handler: resolveUrlTarget({
      target: configuredUrls?.handler ?? defaultTarget,
      fallbackPath: handlerComponentBasePath,
      handlerName: "handler",
      projectId: options.projectId,
    }),
    signIn: resolveUrlTarget({
      target: configuredUrls?.signIn ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "sign-in"),
      handlerName: "signIn",
      projectId: options.projectId,
    }),
    signUp: resolveUrlTarget({
      target: configuredUrls?.signUp ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "sign-up"),
      handlerName: "signUp",
      projectId: options.projectId,
    }),
    afterSignIn,
    afterSignUp: resolveUrlTarget({
      target: configuredUrls?.afterSignUp ?? defaultTarget,
      fallbackPath: afterSignIn,
      handlerName: "afterSignUp",
      projectId: options.projectId,
    }),
    signOut: resolveUrlTarget({
      target: configuredUrls?.signOut ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "sign-out"),
      handlerName: "signOut",
      projectId: options.projectId,
    }),
    afterSignOut: resolveUrlTarget({
      target: configuredUrls?.afterSignOut ?? defaultTarget,
      fallbackPath: localHome,
      handlerName: "afterSignOut",
      projectId: options.projectId,
    }),
    emailVerification: resolveUrlTarget({
      target: configuredUrls?.emailVerification ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "email-verification"),
      handlerName: "emailVerification",
      projectId: options.projectId,
    }),
    passwordReset: resolveUrlTarget({
      target: configuredUrls?.passwordReset ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "password-reset"),
      handlerName: "passwordReset",
      projectId: options.projectId,
    }),
    forgotPassword: resolveUrlTarget({
      target: configuredUrls?.forgotPassword ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "forgot-password"),
      handlerName: "forgotPassword",
      projectId: options.projectId,
    }),
    home,
    oauthCallback: resolveUrlTarget({
      target: oauthCallbackTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "oauth-callback"),
      handlerName: "oauthCallback",
      projectId: options.projectId,
    }),
    magicLinkCallback: resolveUrlTarget({
      target: configuredUrls?.magicLinkCallback ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "magic-link-callback"),
      handlerName: "magicLinkCallback",
      projectId: options.projectId,
    }),
    accountSettings: resolveUrlTarget({
      target: configuredUrls?.accountSettings ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "account-settings"),
      handlerName: "accountSettings",
      projectId: options.projectId,
    }),
    teamInvitation: resolveUrlTarget({
      target: configuredUrls?.teamInvitation ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "team-invitation"),
      handlerName: "teamInvitation",
      projectId: options.projectId,
    }),
    cliAuthConfirm: resolveUrlTarget({
      target: configuredUrls?.cliAuthConfirm ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "cli-auth-confirm"),
      handlerName: "cliAuthConfirm",
      projectId: options.projectId,
    }),
    agentAuthConfirm: resolveUrlTarget({
      target: configuredUrls?.agentAuthConfirm ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "agent-auth-confirm"),
      handlerName: "agentAuthConfirm",
      projectId: options.projectId,
    }),
    mfa: resolveUrlTarget({
      target: configuredUrls?.mfa ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "mfa"),
      handlerName: "mfa",
      projectId: options.projectId,
    }),
    error: resolveUrlTarget({
      target: configuredUrls?.error ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "error"),
      handlerName: "error",
      projectId: options.projectId,
    }),
    onboarding: resolveUrlTarget({
      target: configuredUrls?.onboarding ?? defaultTarget,
      fallbackPath: joinHandlerComponentPath(handlerComponentBasePath, "onboarding"),
      handlerName: "onboarding",
      projectId: options.projectId,
    }),
  };
};

export const buildCliAuthConfirmUrl = (options: {
  cliAuthConfirmUrl: string,
  /** Used as the base URL only when cliAuthConfirmUrl is relative. */
  appUrl: string,
  loginCode: string,
}): string => {
  const url = new URL(options.cliAuthConfirmUrl, options.appUrl);
  url.searchParams.set("login_code", options.loginCode);
  return url.toString();
};

export const resolveUnknownHandlerPathFallbackUrl = (options: {
  defaultTarget: DefaultHandlerUrlTarget | undefined,
  projectId: string,
  unknownPath: string,
}): string | null => {
  const defaultTarget = options.defaultTarget ?? { type: "handler-component" } satisfies DefaultHandlerUrlTarget;

  switch (defaultTarget.type) {
    case "handler-component": {
      return null;
    }
    case "hosted": {
      return getHostedHandlerUrl({
        projectId: options.projectId,
        pagePath: options.unknownPath,
      });
    }
  }
};

export function getPagePrompt(pageName: string, currentVersion?: number): { title: string; fullPrompt: string; upgradePrompt: string | null; latestVersion: number } | null {
  if (!(pageName in customPagePrompts)) return null;
  const prompt = customPagePrompts[pageName as keyof typeof customPagePrompts];
  const versionKeys = Object.keys(prompt.versions).map(Number);
  const latestVersion = versionKeys.length > 0 ? Math.max(...versionKeys) : 0;

  let upgradePrompt: string | null = null;
  if (currentVersion != null) {
    const relevantVersions = versionKeys
      .filter(v => v > currentVersion)
      .sort((a, b) => a - b);
    const prompts = relevantVersions
      .map(v => prompt.versions[v].upgradePrompt)
      .filter(p => p.length > 0);
    upgradePrompt = prompts.length > 0 ? prompts.join("\n\n") : null;
  } else {
    const upgradeEntry = latestVersion > 0 ? prompt.versions[latestVersion] : undefined;
    upgradePrompt = upgradeEntry?.upgradePrompt ?? null;
  }

  return { title: prompt.title, fullPrompt: prompt.fullPrompt, upgradePrompt, latestVersion };
}

export const isHostedHandlerUrlForProject = (options: { url: string, projectId: string }): boolean => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.url);
  } catch {
    return false;
  }

  const hostedBaseUrl = new URL(getHostedHandlerUrl({ projectId: options.projectId, pagePath: "" }));
  return parsedUrl.origin === hostedBaseUrl.origin
    && (parsedUrl.pathname === hostedBaseUrl.pathname || parsedUrl.pathname.startsWith(`${hostedBaseUrl.pathname}/`));
};

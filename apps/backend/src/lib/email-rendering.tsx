import { executeJavascript, type ExecuteResult } from '@/lib/js-execution';
import { emptyEmailTheme } from '@hexclave/shared/dist/helpers/emails';
import { HexclaveAssertionError, captureError } from '@hexclave/shared/dist/utils/errors';
import { bundleJavaScript } from '@hexclave/shared/dist/utils/esbuild';
import { get, has } from '@hexclave/shared/dist/utils/objects';
import {
  type EditableMetadata,
  transpileJsxForEditing,
  convertSentinelTokensToComments,
} from "@hexclave/shared/dist/utils/jsx-editable-transpiler";
import { Result } from "@hexclave/shared/dist/utils/results";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { deindent } from "@hexclave/shared/dist/utils/strings";
import { Tenancy } from './tenancies';

export function getActiveEmailTheme(tenancy: Tenancy) {
  const themeList = tenancy.config.emails.themes;
  const currentActiveTheme = tenancy.config.emails.selectedThemeId;
  if (!(has(themeList, currentActiveTheme))) {
    throw new HexclaveAssertionError("No active email theme found", {
      themeList,
      currentActiveTheme,
    });
  }
  return get(themeList, currentActiveTheme);
}

/**
 * If themeId is a string, and it is a valid theme id, return the theme's tsxSource.
 * If themeId is false, return the empty email theme.
 * If themeId is null or undefined, return the currently active email theme.
 */
export function getEmailThemeForThemeId(tenancy: Tenancy, themeId: string | null | false | undefined) {
  const themeList = tenancy.config.emails.themes;
  if (themeId && has(themeList, themeId)) {
    return get(themeList, themeId).tsxSource;
  }
  if (themeId === false) {
    return emptyEmailTheme;
  }
  return getActiveEmailTheme(tenancy).tsxSource;
}

export function createTemplateComponentFromHtml(html: string) {
  return deindent`
    export const variablesSchema = v => v;
    export function EmailTemplate() {
      return <>
        <div dangerouslySetInnerHTML={{ __html: ${JSON.stringify(html)}}} />
      </>
    };
  `;
}

const nodeModules = {
  "react-dom": "19.1.1",
  "react": "19.1.1",
  "@react-email/components": "1.0.6",
  "arktype": "2.1.20",
  // Transitive dep of @react-email/tailwind (declared as a caret range there). Pinned exactly
  // because the two js-execution engines install node_modules independently, so a new tailwindcss
  // release makes them render byte-different HTML and trip the sanity test. If the sanity test
  // fires again with byte-different HTML, find the drifted transitive dep and pin it here too.
  "tailwindcss": "4.3.3",
};

const entryJs = deindent`
  export default async () => {
    try {
      const { renderAll } = await import("./render.tsx");
      const result = await renderAll();
      return { status: "ok", data: result };
    } catch (e) {
      if (e instanceof Error) {
        return { status: "error", error: { message: e.message, stack: e.stack, cause: e.cause } };
      }
      return { status: "error", error: { message: String(e), stack: undefined, cause: undefined } };
    }
  };
`;

type EmailRenderResult = {
  html: string,
  text: string,
  subject?: string,
  notificationCategory?: string,
  editableRegions?: Record<string, EditableMetadata>,
};

async function bundleAndExecute<T>(
  files: Record<string, string> & { '/entry.js': string },
): Promise<Result<T, string>> {
  const bundle = await bundleJavaScript(files, {
    keepAsImports: ['arktype', 'react', 'react/jsx-runtime', '@react-email/components'],
    // Dual-resolve both module names to the same source (Hexclave rebrand,
    // Tier 2): templates created before the rebrand import `@stackframe/emails`,
    // new templates import `@hexclave/emails`. Both point at the same inlined
    // virtual module so existing stored templates keep rendering.
    externalPackages: {
      '@stackframe/emails': stackframeEmailsPackage,
      '@hexclave/emails': stackframeEmailsPackage,
    },
    format: 'esm',
    sourcemap: false,
  });
  if (bundle.status === "error") {
    return Result.error(bundle.error);
  }

  const executeResult: ExecuteResult = await executeJavascript(bundle.data, { nodeModules });

  if (executeResult.status === "error") {
    return Result.error(JSON.stringify(executeResult.error));
  }
  return Result.ok(executeResult.data as T);
}

export async function renderEmailWithTemplate(
  templateOrDraftComponent: string,
  themeComponent: string,
  options: {
    user?: { displayName: string | null },
    project?: { displayName: string },
    variables?: Record<string, Json>,
    editableMarkers?: boolean,
    editableSource?: 'template' | 'theme' | 'both',
    themeProps?: {
      unsubscribeLink?: string,
      projectLogos: {
        logoUrl?: string,
        logoFullUrl?: string,
        logoDarkModeUrl?: string,
        logoFullDarkModeUrl?: string,
      },
    },
    previewMode?: boolean,
  },
): Promise<Result<EmailRenderResult, string>> {
  const variables = options.variables ?? {};
  const previewMode = options.previewMode ?? false;
  const user = (previewMode && !options.user) ? { displayName: "John Doe" } : options.user;
  const project = (previewMode && !options.project) ? { displayName: "My Project" } : options.project;
  if (!user) {
    throw new HexclaveAssertionError("User is required when not in preview mode", { user, project, variables });
  }
  if (!project) {
    throw new HexclaveAssertionError("Project is required when not in preview mode", { user, project, variables });
  }

  // Process editable markers if requested
  const editableMarkers = options.editableMarkers ?? false;
  const editableSource = options.editableSource ?? 'template';
  let editableRegions: Record<string, EditableMetadata> = {};

  let processedTemplate = templateOrDraftComponent;
  let processedTheme = themeComponent;

  if (editableMarkers) {
    // Transpile template if needed
    if (editableSource === 'template' || editableSource === 'both') {
      try {
        const templateResult = transpileJsxForEditing(templateOrDraftComponent, { sourceFile: 'template' });
        processedTemplate = templateResult.code;
        editableRegions = { ...editableRegions, ...templateResult.editableRegions };
      } catch (e) {
        // If transpilation fails, fall back to original source
        // This can happen with complex or invalid JSX
        captureError("email-transpilation-template-error", new HexclaveAssertionError(
          "Failed to transpile template for editable markers",
          { cause: e }
        ));
      }
    }

    // Transpile theme if needed
    if (editableSource === 'theme' || editableSource === 'both') {
      try {
        const themeResult = transpileJsxForEditing(themeComponent, { sourceFile: 'theme' });
        processedTheme = themeResult.code;
        editableRegions = { ...editableRegions, ...themeResult.editableRegions };
      } catch (e) {
        // If transpilation fails, fall back to original source
        captureError("email-transpilation-theme-error", new HexclaveAssertionError(
          "Failed to transpile theme for editable markers",
          { cause: e }
        ));
      }
    }
  }

  const files = {
    "/utils.tsx": findComponentValueUtil,
    "/theme.tsx": processedTheme,
    "/template.tsx": processedTemplate,
    "/render.tsx": deindent`
      import { configure } from "arktype/config"
      configure({ onUndeclaredKey: "delete" })
      import React from 'react';
      import { render } from '@react-email/components';
      import { type } from "arktype";
      import { findComponentValue } from "./utils.tsx";
      import * as TemplateModule from "./template.tsx";
      const { variablesSchema, EmailTemplate } = TemplateModule;
      import { EmailTheme } from "./theme.tsx";
      export const renderAll = async () => {
        const variables = variablesSchema ? variablesSchema({
          ${previewMode ? "...(EmailTemplate.PreviewVariables || {})," : ""}
          ...(${JSON.stringify(variables)}),
        }) : {};
        if (variables instanceof type.errors) {
          throw new Error(variables.summary)
        }
        const themeProps = {
          ...${JSON.stringify(options.themeProps || {})},
          ...${previewMode ? "EmailTheme.PreviewProps" : "{}"},
        }
        const EmailTemplateWithProps  = <EmailTemplate variables={variables} user={${JSON.stringify(user)}} project={${JSON.stringify(project)}} />;
        const Email = <EmailTheme {...themeProps}>
          {${previewMode ? "EmailTheme.PreviewProps?.children ?? " : ""} EmailTemplateWithProps}
        </EmailTheme>;
        return {
          html: await render(Email),
          text: await render(Email, { plainText: true }),
          subject: findComponentValue(EmailTemplateWithProps, "Subject"),
          notificationCategory: findComponentValue(EmailTemplateWithProps, "NotificationCategory"),
        };
      }
    `,
    "/entry.js": entryJs,
  };

  const result = await bundleAndExecute<EmailRenderResult>(files);

  // Post-process HTML to convert sentinel tokens to HTML comments if editable markers enabled
  if (result.status === "ok" && editableMarkers) {
    const processedHtml = convertSentinelTokensToComments(result.data.html);
    return Result.ok({
      ...result.data,
      html: processedHtml,
      editableRegions: Object.keys(editableRegions).length > 0 ? editableRegions : undefined,
    });
  }

  return result;
}

export type RenderEmailRequestForTenancy = {
  templateSource: string,
  themeSource: string,
  input: {
    user: { displayName: string | null },
    project: { displayName: string },
    variables?: Record<string, Json>,
    unsubscribeLink?: string,
    themeProps?: {
      projectLogos: {
        logoUrl?: string,
        logoFullUrl?: string,
        logoDarkModeUrl?: string,
        logoFullDarkModeUrl?: string,
      },
    },
  },
};

export async function renderEmailsForTenancyBatched(requests: RenderEmailRequestForTenancy[]): Promise<Result<EmailRenderResult[], string>> {
  if (requests.length === 0) {
    return Result.ok([]);
  }

  const files: Record<string, string> = {
    "/utils.tsx": findComponentValueUtil,
  };

  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    files[`/template-${index}.tsx`] = request.templateSource;
    files[`/theme-${index}.tsx`] = request.themeSource;
  }

  const serializedInputs = JSON.stringify(requests.map((request) => ({
    user: request.input.user,
    project: request.input.project,
    variables: request.input.variables ?? null,
    unsubscribeLink: request.input.unsubscribeLink ?? null,
    themeProps: request.input.themeProps ?? null,
  })));

  files["/render.tsx"] = deindent`
    import { configure } from "arktype/config";
    configure({ onUndeclaredKey: "delete" });
    import React from "react";
    import { render } from "@react-email/components";
    import { type } from "arktype";
    import { findComponentValue } from "./utils.tsx";
    ${requests.map((_, index) => `import * as TemplateModule${index} from "./template-${index}.tsx";`).join("\n")}
    ${requests.map((_, index) => `const { variablesSchema: variablesSchema${index}, EmailTemplate: EmailTemplate${index} } = TemplateModule${index};`).join("\n")}
    ${requests.map((_, index) => `import { EmailTheme as EmailTheme${index} } from "./theme-${index}.tsx";`).join("\n")}

    export const renderAll = async () => {
      const inputs = ${serializedInputs};
      const results = [];
      ${requests.map((_, index) => deindent`
        {
          const input = inputs[${index}];
          const schema = variablesSchema${index};
          const variables = schema ? schema({ ...(input.variables || {}) }) : {};
          if (variables instanceof type.errors) {
            throw new Error(variables.summary);
          }
          const TemplateWithProps = <EmailTemplate${index} variables={variables} user={input.user} project={input.project} />;
          const Email = <EmailTheme${index} unsubscribeLink={input.unsubscribeLink ?? undefined} projectLogos={input.themeProps?.projectLogos ?? {}}>
            {TemplateWithProps}
          </EmailTheme${index}>;
          results.push({
            html: await render(Email),
            text: await render(Email, { plainText: true }),
            subject: findComponentValue(TemplateWithProps, "Subject"),
            notificationCategory: findComponentValue(TemplateWithProps, "NotificationCategory"),
          });
        }
      `).join("\n")}
      return results;
    };
  `;

  files["/entry.js"] = entryJs;

  return await bundleAndExecute<EmailRenderResult[]>(files as Record<string, string> & { '/entry.js': string });
}

const findComponentValueUtil = `import React from 'react';
export function findComponentValue(element, targetStackComponent) {
  const matches = [];

  function traverse(node) {
    if (!React.isValidElement(node)) return;

    const type = node.type;
    const isTarget =
      type &&
      typeof type === "function" &&
      "__hexclaveComponent" in type &&
      type.__hexclaveComponent === targetStackComponent;

    if (isTarget) {
      matches.push(node);
    }

    const children = node.props?.children;
    if (Array.isArray(children)) {
      children.forEach(traverse);
    } else if (children) {
      traverse(children);
    }
  }
  traverse(element.type(element.props || {}));
  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length !== 1) {
    throw new Error(
      \`Expected exactly one occurrence of component "\${targetStackComponent}", found \${matches.length}.\`
    );
  }

  const matched = matches[0];
  const value = matched.props?.value;

  if (typeof value !== "string") {
    throw new Error(
      \`The "value" prop of "\${targetStackComponent}" must be a string.\`
    );
  }

  return value;
}`;

// issues with using jsx in external packages, using React.createElement instead
const stackframeEmailsPackage = deindent`
  import React from 'react';
  import { Img } from '@react-email/components';
  export const Subject = (props) => null;
  Subject.__hexclaveComponent = "Subject";
  export const NotificationCategory = (props) => null;
  NotificationCategory.__hexclaveComponent = "NotificationCategory";

  export function Logo(props) {
    return React.createElement(
      "div",
      { className: "flex gap-2 items-center" },
      React.createElement(Img, {
        src: props.logoUrl,
        alt: "Logo",
        className: "h-8",
      }),
    );
  }

  export function FullLogo(props) {
    return React.createElement(Img, {
      src: props.logoFullUrl,
      alt: "Full Logo",
      className: "h-16",
    });
  }

  export function ProjectLogo(props) {
    const { mode = "light" } = props;
    const {
      logoUrl,
      logoFullUrl,
      logoDarkModeUrl,
      logoFullDarkModeUrl,
    } = props.data ?? {};

    if (mode === "dark" && logoFullDarkModeUrl) {
      return React.createElement(FullLogo, { logoFullUrl: logoFullDarkModeUrl });
    }
    if (mode === "dark" && logoDarkModeUrl) {
      return React.createElement(Logo, {
        logoUrl: logoDarkModeUrl,
      });
    }
    if (mode === "light" && logoFullUrl) {
      return React.createElement(FullLogo, { logoFullUrl });
    }
    if (mode === "light" && logoUrl) {
      return React.createElement(Logo, {
        logoUrl,
      });
    }

    return null;
  }
`;

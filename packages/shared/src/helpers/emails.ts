import { deindent } from "../utils/strings";

export const defaultNewTemplateSource = deindent`
  import { type } from "arktype"
  import { Container } from "@react-email/components";
  import { Subject, NotificationCategory, Props } from "@stackframe/emails";

  export const variablesSchema = type({
    count: "number"
  });

  export function EmailTemplate({ user, variables }: Props<typeof variablesSchema.infer>) {
    return (
      <Container>
        <Subject value={\`Hello \${user.displayName}!\`} />
        <NotificationCategory value="Transactional" />
        <div className="font-bold">Hi {user.displayName}!</div>
        <br />
        count is {variables.count}
      </Container>
    );
  }

  EmailTemplate.PreviewVariables = {
    count: 10
  } satisfies typeof variablesSchema.infer
`;

export const previewTemplateSource = deindent`
  import { Button, Section, Hr, Text, Heading } from "@react-email/components";
  import { Subject, NotificationCategory } from "@stackframe/emails";

  export const variablesSchema = v => v;

  export function EmailTemplate({ user, project }) {
    return (
      <>
        <Subject value={\`Verify your email at \${project.displayName}\`} />
        <NotificationCategory value="Transactional" />
        <div className="font-sans text-base font-normal tracking-[0.15008px] leading-[1.5] m-0 py-8 w-full min-h-full">
          <Section>
            <Heading as="h3" className="font-sans font-bold text-[20px] text-center py-4 px-6 m-0">
              Verify your email at {project.displayName}
            </Heading>
            <Text className="font-sans font-normal text-[14px] text-center pt-2 px-6 pb-4 m-0 opacity-80">
              Hi{user.displayName ? (", " + user.displayName) : ''}! Please click on the following button to verify your email.
            </Text>
            <div className="text-center py-3 px-6">
              <Button
                href="#"
                className="text-black font-sans font-bold text-[14px] inline-block bg-[#f0f0f0] rounded-[4px] py-3 px-5 no-underline border-0"
              >
                Verify my email
              </Button>
            </div>
            <div className="py-4 px-6">
              <Hr className="opacity-20" />
            </div>
            <Text className="font-sans font-normal text-[12px] text-center pt-1 px-6 pb-6 m-0 opacity-60">
              If you were not expecting this email, you can safely ignore it. 
            </Text>
          </Section>
        </div>
      </>
    )
  }
`;

export const emptyEmailTheme = deindent`
  import { Html, Tailwind, Body } from '@react-email/components';
  export function EmailTheme({ children }: { children: React.ReactNode }) {
    return (
      <Html>
        <Tailwind>
          <Body>
            {children}
          </Body>
        </Tailwind>
      </Html>
    );
  }
`;

export const LightEmailTheme = `import { Html, Head, Tailwind, Body, Container, Section } from '@react-email/components';
import { ThemeProps, ProjectLogo } from "@stackframe/emails";

export function EmailTheme({ children, unsubscribeLink, projectLogos }: ThemeProps) {
  return (
    <Html>
      <Head />
      <Tailwind>
        <Body className="bg-[#fafbfb] font-sans text-base m-0 p-0" style={{ overflowX: 'hidden' }}>
          <div className="py-8 px-4 flex justify-center">
            <Container className="bg-white p-[45px] rounded-lg shadow-sm mx-auto" style={{ width: '100%', maxWidth: '600px' }}>
              <ProjectLogo data={projectLogos} mode="light" />
              {children}
            </Container>
          </div>
          {unsubscribeLink && (
            <Section className="p-4 opacity-60 text-center" style={{ textAlign: 'center' }}>
              <a href={unsubscribeLink} className="text-blue-600" target="_blank" rel="noopener noreferrer">Click here</a> to unsubscribe from these emails
            </Section>
          )}
        </Body>
      </Tailwind>
    </Html>
  );
}

EmailTheme.PreviewProps = {
  unsubscribeLink: "https://example.com",
} satisfies Partial<ThemeProps>
`;


const DarkEmailTheme = `import { Html, Head, Tailwind, Body, Container, Section } from '@react-email/components';
import { ThemeProps, ProjectLogo } from "@stackframe/emails";

export function EmailTheme({ children, unsubscribeLink, projectLogos }: ThemeProps) {
  return (
    <Html>
      <Head />
      <Tailwind>
        <Body className="bg-[#323232] font-sans text-white m-0 p-0" style={{ overflowX: 'hidden' }}>
          <div className="py-8 px-4 flex justify-center">
            <Container className="bg-black p-[45px] rounded-lg shadow-sm mx-auto" style={{ width: '100%', maxWidth: '600px' }}>
              <ProjectLogo data={projectLogos} mode="dark" />
              {children}
            </Container>
          </div>
          {unsubscribeLink && (
            <Section className="p-4 opacity-60 text-center" style={{ textAlign: 'center' }}>
              <a href={unsubscribeLink} className="text-blue-600" target="_blank" rel="noopener noreferrer">Click here</a> to unsubscribe from these emails
            </Section>
          )}
        </Body>
      </Tailwind>
    </Html>
  );
}

EmailTheme.PreviewProps = {
  unsubscribeLink: "https://example.com",
} satisfies Partial<ThemeProps>
`;


const ColorfulEmailTheme = `import { Html, Head, Tailwind, Body, Container, Section } from '@react-email/components';
import { ThemeProps, ProjectLogo } from "@stackframe/emails";

export function EmailTheme({ children, unsubscribeLink, projectLogos }: ThemeProps) {
  return (
    <Html>
      <Head />
      <Tailwind>
        <Body className="bg-[#f0eef6] font-sans text-base m-0 p-0" style={{ overflowX: 'hidden' }}>
          <div className="py-8 px-4 flex justify-center">
            <Container className="bg-white p-[45px] rounded-2xl mx-auto" style={{ width: '100%', maxWidth: '600px', borderTop: '4px solid #7c5ce0' }}>
              <ProjectLogo data={projectLogos} mode="light" />
              {children}
            </Container>
          </div>
          {unsubscribeLink && (
            <Section className="p-4 opacity-60 text-center" style={{ textAlign: 'center' }}>
              <a href={unsubscribeLink} className="text-[#7c5ce0]" target="_blank" rel="noopener noreferrer">Click here</a> to unsubscribe from these emails
            </Section>
          )}
        </Body>
      </Tailwind>
    </Html>
  );
}

EmailTheme.PreviewProps = {
  unsubscribeLink: "https://example.com",
} satisfies Partial<ThemeProps>
`;

export const DEFAULT_EMAIL_THEME_ID = "1df07ae6-abf3-4a40-83a5-a1a2cbe336ac";

export const DEFAULT_EMAIL_THEMES = {
  [DEFAULT_EMAIL_THEME_ID]: {
    displayName: 'Default Light',
    tsxSource: LightEmailTheme,
  },
  "a0172b5d-cff0-463b-83bb-85124697373a": {
    displayName: 'Default Dark',
    tsxSource: DarkEmailTheme,
  },
  "c7e2d94f-8a1b-4e6d-b3f5-9d0a2e7c1b8f": {
    displayName: 'Default Colorful',
    tsxSource: ColorfulEmailTheme,
  },
};

const EMAIL_TEMPLATE_EMAIL_VERIFICATION_ID = "e7d009ce-8d47-4528-b245-5bf119f2ffa3";
const EMAIL_TEMPLATE_PASSWORD_RESET_ID = "a70fb3a4-56c1-4e42-af25-49d25603abd0";
const EMAIL_TEMPLATE_MAGIC_LINK_ID = "822687fe-8d0a-4467-a0d1-416b6e639478";
const EMAIL_TEMPLATE_TEAM_INVITATION_ID = "e84de395-2076-4831-9c19-8e9a96a868e4";
const EMAIL_TEMPLATE_SIGN_IN_INVITATION_ID = "066dd73c-36da-4fd0-b6d6-ebf87683f8bc";
const EMAIL_TEMPLATE_PAYMENT_RECEIPT_ID = "70372aee-0441-4d80-974c-2e858e40123a";
const EMAIL_TEMPLATE_PAYMENT_FAILED_ID = "f64b1afe-27ec-4a28-a277-7178f3261f9a";
const EMAIL_TEMPLATE_TRIAL_WILL_END_ID = "c3f8a1d2-7e4b-4a91-b2c5-9e8f1a0d3b6c";

export const DEFAULT_EMAIL_TEMPLATES = {
  [EMAIL_TEMPLATE_EMAIL_VERIFICATION_ID]: {
    "displayName": "Email Verification",
    "tsxSource": "import { type } from \"arktype\"\nimport { Button, Section, Hr, Text, Heading } from \"@react-email/components\";\nimport { Subject, NotificationCategory, Props } from \"@stackframe/emails\";\n\nexport const variablesSchema = type({\n  emailVerificationLink: \"string\"\n})\n\nexport function EmailTemplate({ user, project, variables }: Props<typeof variablesSchema.infer>) {\n  return (\n    <>\n      <Subject value={`Verify your email at ${project.displayName}`} />\n      <NotificationCategory value=\"Transactional\" />\n      <div className=\"font-sans text-base font-normal tracking-[0.15008px] leading-[1.5] m-0 py-8 w-full min-h-full\">\n        <Section>\n          <Heading as=\"h3\" className=\"font-sans font-bold text-[20px] text-center py-4 px-6 m-0\">\n            Verify your email at {project.displayName}\n          </Heading>\n          <p className=\"font-sans font-normal text-[14px] text-center pt-2 px-6 pb-4 m-0 opacity-80\">\n            Hi{user.displayName ? (\", \" + user.displayName) : ''}! Please click on the following button to verify your email.\n          </p>\n          <div className=\"text-center py-3 px-6\">\n            <Button\n              href={variables.emailVerificationLink}\n              className=\"text-black font-sans font-bold text-[14px] inline-block bg-[#f0f0f0] rounded-[4px] py-3 px-5 no-underline border-0\"\n            >\n              Verify my email\n            </Button>\n          </div>\n          <div className=\"py-4 px-6\">\n            <Hr className=\"opacity-20\" />\n          </div>\n          <p className=\"font-sans font-normal text-[12px] text-center pt-1 px-6 pb-6 m-0 opacity-60\">\n            If you did not create an account at {project.displayName}, do not click this button. Someone may have signed up with your email address. You can safely ignore this email.\n          </p>\n        </Section>\n      </div>\n    </>\n  )\n}\n\nEmailTemplate.PreviewVariables = {\n  emailVerificationLink: \"#\"\n} satisfies typeof variablesSchema.infer",
    "themeId": undefined,
  },
  [EMAIL_TEMPLATE_PASSWORD_RESET_ID]: {
    "displayName": "Password Reset",
    "tsxSource": "import { type } from \"arktype\"\nimport { Button, Section, Hr, Text, Heading } from \"@react-email/components\"\nimport { Subject, NotificationCategory, Props} from \"@stackframe/emails\"\n\nexport const variablesSchema = type({\n  passwordResetLink: \"string\"\n})\n\nexport function EmailTemplate({ user, project, variables }: Props<typeof variablesSchema.infer>) {\n  return (\n    <>\n      <Subject value={\"Reset your password at \" + project.displayName} />\n      <NotificationCategory value=\"Transactional\" />\n      <div className=\"font-sans text-base font-normal tracking-tight leading-relaxed py-8 w-full min-h-full\">\n        <Section>\n          <Heading as=\"h3\" className=\"font-sans font-bold text-[20px] text-center py-4 px-6 m-0\">\n            Reset your password at {project.displayName}\n          </Heading>\n\n          <p className=\"text-sm font-sans font-normal text-center pt-2 pb-4 px-6 m-0 opacity-80\">\n            Hi{user.displayName ? (\", \" + user.displayName) : \"\"}! Please click on the following button to start the password reset process.\n          </p>\n\n          <div className=\"text-center px-6 py-3\">\n            <Button\n              href={variables.passwordResetLink}\n              className=\"text-black text-sm font-sans font-bold bg-[#f0f0f0] rounded-[4px] inline-block py-3 px-5 no-underline border-none\"\n              target=\"_blank\"\n            >\n              Reset my password\n            </Button>\n          </div>\n\n          <div className=\"px-6 py-4\">\n            <Hr className=\"opacity-20\" />\n          </div>\n\n          <p className=\"text-xs font-sans font-normal text-center pt-1 pb-6 px-6 m-0 opacity-60\">\n            If you were not expecting this email, you can safely ignore it.\n          </p>\n        </Section>\n      </div>\n    </>\n  )\n}\n\nEmailTemplate.PreviewVariables = {\n   passwordResetLink: \"#\"\n} satisfies typeof variablesSchema.infer",
    "themeId": undefined,
  },
  [EMAIL_TEMPLATE_MAGIC_LINK_ID]: {
    "displayName": "Magic Link/OTP",
    "tsxSource": "import { type } from 'arktype';\nimport { Section, Hr, Text, Heading } from '@react-email/components';\nimport { Subject, NotificationCategory, Props } from '@stackframe/emails';\n\nexport const variablesSchema = type({\n  magicLink: 'string',\n  otp: 'string',\n});\n\nexport function EmailTemplate({ user, project, variables }: Props<typeof variablesSchema.infer>) {\n  return (\n    <>\n      <Subject value={\"Sign in to \" + project.displayName + \": Your code is \" + variables.otp} />\n      <NotificationCategory value=\"Transactional\" />\n      <div className=\"font-sans text-base font-normal tracking-[0.15008px] leading-6 m-0 py-8 w-full min-h-full\">\n        <Section className=\"mx-auto\">\n          <Heading as=\"h3\" className=\"font-sans font-bold text-xl text-center px-6 py-4 m-0\">\n            Sign in to {project.displayName}\n          </Heading>\n          <p className=\"text-sm font-sans font-normal text-center px-6 py-4 m-0 opacity-80\">\n            Hi{user.displayName ? \", \" + user.displayName : \"\"}! This is your one-time-password for signing in:\n          </p>\n          <p className=\"text-2xl font-mono font-bold text-center px-6 py-4 m-0\">\n            {variables.otp}\n          </p>\n          <p className=\"text-sm font-sans font-normal text-center px-6 py-4 m-0\">\n            Or you can click on{' '}\n            <a\n              key={20}\n              href={variables.magicLink}\n              rel=\"noopener noreferrer\"\n              className=\"text-blue-600 underline\"\n            >\n              this link\n            </a>{' '}\n            to sign in\n          </p>\n          <Hr className=\"px-6 py-4 opacity-20\" />\n          <p className=\"text-xs font-sans font-normal text-center px-6 pt-1 pb-6 m-0 opacity-60\">\n            If you were not expecting this email, you can safely ignore it.\n          </p>\n        </Section>\n      </div>\n    </>\n  );\n}\n\nEmailTemplate.PreviewVariables = {\n  magicLink: \"#\",\n  otp: \"3SLSWZ\"\n} satisfies typeof variablesSchema.infer",
    "themeId": undefined,
  },
  [EMAIL_TEMPLATE_TEAM_INVITATION_ID]: {
    "displayName": "Team Invitation",
    "tsxSource": "import { type } from \"arktype\";\nimport { Button, Section, Hr, Text, Heading } from \"@react-email/components\";\nimport { Subject, NotificationCategory, Props } from \"@stackframe/emails\";\n\n\nexport const variablesSchema = type({\n  teamDisplayName: \"string\",\n  teamInvitationLink: \"string\"\n});\n\nexport function EmailTemplate({ user, variables }: Props<typeof variablesSchema.infer>) {\n  return (\n    <>\n      <Subject value={\"You have been invited to join \" + variables.teamDisplayName} />\n      <NotificationCategory value=\"Transactional\" />\n      <div className=\"font-sans text-base font-normal tracking-[0.15008px] leading-[1.5] m-0 py-8 w-full min-h-full\">\n        <Section className=\"mx-auto max-w-lg\">\n          <Heading as=\"h3\" className=\"font-sans font-bold text-xl text-center px-6 pt-8 m-0\">\n            You are invited to {variables.teamDisplayName}\n          </Heading>\n          <p className=\"text-sm font-sans font-normal text-center px-6 pt-2 pb-4 m-0 opacity-80\">\n            Hi{user.displayName ? \", \" + user.displayName : \"\"}! Please click the button below to join the team {variables.teamDisplayName}\n          </p>\n          <div className=\"text-center px-6 py-3\">\n            <Button\n              href={variables.teamInvitationLink}\n              className=\"text-black text-sm font-sans font-bold bg-[#f0f0f0] rounded-md inline-block px-5 py-3 no-underline border-0\"\n            >\n              Join team\n            </Button>\n          </div>\n          <div className=\"px-6 py-4\">\n            <Hr className=\"opacity-20\" />\n          </div>\n          <p className=\"text-xs font-sans font-normal text-center px-6 pb-6 pt-1 m-0 opacity-60\">\n            If you were not expecting this email, you can safely ignore it.\n          </p>\n        </Section>\n      </div>\n    </>\n  );\n}\n\nEmailTemplate.PreviewVariables = {\n  teamDisplayName: \"My Team\",\n  teamInvitationLink: \"#\"\n} satisfies typeof variablesSchema.infer ",
    "themeId": undefined,
  },
  [EMAIL_TEMPLATE_SIGN_IN_INVITATION_ID]: {
    "displayName": "Sign In Invitation",
    "tsxSource": "import { type } from \"arktype\"\nimport { Button, Section, Hr, Text, Heading } from \"@react-email/components\";\nimport { Subject, NotificationCategory, Props } from \"@stackframe/emails\";\n\nexport const variablesSchema = type({\n  signInInvitationLink: \"string\",\n  teamDisplayName: \"string\"\n})\n\nexport function EmailTemplate({ user, project, variables }: Props<typeof variablesSchema.infer>) {\n  return (\n    <>\n      <Subject\n        value={\"You have been invited to sign in to \" + project.displayName}\n      />\n      <NotificationCategory value=\"Transactional\" />\n\n      <div className=\"font-sans text-base font-normal leading-normal w-full min-h-full m-0 py-8\">\n        <Section>\n          <Heading as=\"h3\" className=\"font-sans font-bold text-xl text-center pt-8 px-6 m-0\">\n            You are invited to sign in to {variables.teamDisplayName}\n          </Heading>\n\n          <p className=\"text-sm font-sans font-normal text-center pt-2 pb-4 px-6 m-0 opacity-80\">\n            Hi\n            {user.displayName ? \", \" + user.displayName : \"\"}! Please click on the following\n            link to sign in to your account\n          </p>\n\n          <div className=\"text-center px-6 py-3\">\n            <Button\n              href={variables.signInInvitationLink}\n              className=\"text-black text-sm font-sans font-bold bg-gray-200 rounded-md inline-block py-3 px-5 no-underline border-none\"\n            >\n              Sign in\n            </Button>\n          </div>\n\n          <div className=\"px-6 py-4\">\n            <Hr className=\"opacity-20\" />\n          </div>\n\n          <p className=\"text-xs font-sans font-normal text-center pt-1 pb-6 px-6 m-0 opacity-60\">\n            If you were not expecting this email, you can safely ignore it.\n          </p>\n        </Section>\n      </div>\n    </>\n  )\n}\n\nEmailTemplate.PreviewVariables = {\n  signInInvitationLink: \"#\",\n  teamDisplayName: \"My Team\"\n} satisfies typeof variablesSchema.infer",
    "themeId": undefined,
  },
  [EMAIL_TEMPLATE_PAYMENT_RECEIPT_ID]: {
    "displayName": "Payment Receipt",
    "tsxSource": "import { type } from \"arktype\";\nimport { Button, Section, Hr } from \"@react-email/components\";\nimport { Subject, NotificationCategory, Props } from \"@stackframe/emails\";\n\nexport const variablesSchema = type({\n  productName: \"string\",\n  quantity: \"number\",\n  amount: \"string\",\n  receiptLink: \"string?\"\n});\n\nexport function EmailTemplate({ user, project, variables }: Props<typeof variablesSchema.infer>) {\n  return (\n    <>\n      <Subject value={\"Your receipt from \" + project.displayName} />\n      <NotificationCategory value=\"Transactional\" />\n      <div className=\"bg-white text-[#242424] font-sans text-base font-normal tracking-[0.15008px] leading-[1.5] m-0 py-8 w-full min-h-full\">\n        <Section className=\"bg-white\">\n          <h3 className=\"text-black font-sans font-bold text-[20px] text-center py-4 px-6 m-0\">\n            Thanks for your purchase\n          </h3>\n          <p className=\"text-[#474849] font-sans font-normal text-[14px] text-center pt-2 px-6 pb-4 m-0\">\n            Hi{user.displayName ? (\", \" + user.displayName) : \"\"}! Your payment for {variables.productName} is complete.\n          </p>\n          <div className=\"px-6\">\n            <p className=\"text-black font-sans font-bold text-[16px] text-center m-0\">\n              Total paid: {variables.amount}\n            </p>\n            <p className=\"text-[#474849] font-sans text-[13px] text-center mt-2 mb-0\">\n              Quantity: {variables.quantity}\n            </p>\n          </div>\n          {variables.receiptLink ? (\n            <div className=\"text-center py-4 px-6\">\n              <Button\n                href={variables.receiptLink}\n                target=\"_blank\"\n                className=\"text-black font-sans font-bold text-[14px] inline-block bg-[#f0f0f0] rounded-[4px] py-3 px-5 no-underline border-0\"\n              >\n                View receipt\n              </Button>\n            </div>\n          ) : null}\n          <div className=\"py-4 px-6\">\n            <Hr />\n          </div>\n        </Section>\n      </div>\n    </>\n  );\n}\n\nEmailTemplate.PreviewVariables = {\n  productName: \"Pro Plan\",\n  quantity: 1,\n  amount: \"$29.00\",\n  receiptLink: \"https://example.com/receipt\"\n} satisfies typeof variablesSchema.infer;\n",
    "themeId": undefined,
  },
  [EMAIL_TEMPLATE_PAYMENT_FAILED_ID]: {
    "displayName": "Payment Failed",
    "tsxSource": "import { type } from \"arktype\";\nimport { Button, Section, Hr } from \"@react-email/components\";\nimport { Subject, NotificationCategory, Props } from \"@stackframe/emails\";\n\nexport const variablesSchema = type({\n  productName: \"string\",\n  amount: \"string\",\n  invoiceUrl: \"string?\",\n  failureReason: \"string?\"\n});\n\nexport function EmailTemplate({ user, project, variables }: Props<typeof variablesSchema.infer>) {\n  return (\n    <>\n      <Subject value={\"Payment failed for \" + project.displayName} />\n      <NotificationCategory value=\"Transactional\" />\n      <div className=\"bg-white text-[#242424] font-sans text-base font-normal tracking-[0.15008px] leading-[1.5] m-0 py-8 w-full min-h-full\">\n        <Section className=\"bg-white\">\n          <h3 className=\"text-black font-sans font-bold text-[20px] text-center py-4 px-6 m-0\">\n            We couldn't process your payment\n          </h3>\n          <p className=\"text-[#474849] font-sans font-normal text-[14px] text-center pt-2 px-6 pb-4 m-0\">\n            Hi{user.displayName ? (\", \" + user.displayName) : \"\"}! Your payment for {variables.productName} ({variables.amount}) did not go through.\n          </p>\n          {variables.failureReason ? (\n            <p className=\"text-[#8a8b8b] font-sans text-[12px] text-center px-6 pb-2 m-0\">\n              Reason: {variables.failureReason}\n            </p>\n          ) : null}\n          {variables.invoiceUrl ? (\n            <div className=\"text-center py-3 px-6\">\n              <Button\n                href={variables.invoiceUrl}\n                target=\"_blank\"\n                className=\"text-black font-sans font-bold text-[14px] inline-block bg-[#f0f0f0] rounded-[4px] py-3 px-5 no-underline border-0\"\n              >\n                View invoice\n              </Button>\n            </div>\n          ) : null}\n          <div className=\"py-4 px-6\">\n            <Hr />\n          </div>\n          <p className=\"text-[#474849] font-sans font-normal text-[12px] text-center pt-1 px-6 pb-6 m-0\">\n            Please update your payment details to avoid service interruption.\n          </p>\n        </Section>\n      </div>\n    </>\n  );\n}\n\nEmailTemplate.PreviewVariables = {\n  productName: \"Pro Plan\",\n  amount: \"$29.00\",\n  invoiceUrl: \"https://example.com/billing\",\n  failureReason: \"Your card was declined\"\n} satisfies typeof variablesSchema.infer;\n",
    "themeId": undefined,
  },
  [EMAIL_TEMPLATE_TRIAL_WILL_END_ID]: {
    "displayName": "Trial Ending Soon",
    "tsxSource": "import { type } from \"arktype\";\nimport { Section, Hr } from \"@react-email/components\";\nimport { Subject, NotificationCategory, Props } from \"@stackframe/emails\";\n\nexport const variablesSchema = type({\n  productName: \"string\",\n  trialEndDate: \"string\",\n});\n\nexport function EmailTemplate({ user, project, variables }: Props<typeof variablesSchema.infer>) {\n  return (\n    <>\n      <Subject value={\"Your free trial for \" + variables.productName + \" is ending soon\"} />\n      <NotificationCategory value=\"Transactional\" />\n      <div className=\"bg-white text-[#242424] font-sans text-base font-normal tracking-[0.15008px] leading-[1.5] m-0 py-8 w-full min-h-full\">\n        <Section className=\"bg-white\">\n          <h3 className=\"text-black font-sans font-bold text-[20px] text-center py-4 px-6 m-0\">\n            Your free trial is ending soon\n          </h3>\n          <p className=\"text-[#474849] font-sans font-normal text-[14px] text-center pt-2 px-6 pb-4 m-0\">\n            Hi{user.displayName ? (\", \" + user.displayName) : \"\"}! Your free trial of {variables.productName} at {project.displayName} ends on {variables.trialEndDate}.\n          </p>\n          <p className=\"text-[#474849] font-sans font-normal text-[14px] text-center px-6 pb-4 m-0\">\n            After that, your payment method on file will be charged for the subscription.\n          </p>\n          <div className=\"py-4 px-6\">\n            <Hr />\n          </div>\n        </Section>\n      </div>\n    </>\n  );\n}\n\nEmailTemplate.PreviewVariables = {\n  productName: \"Pro Plan\",\n  trialEndDate: \"January 15, 2026\",\n} satisfies typeof variablesSchema.infer;\n",
    "themeId": undefined,
  }
};

export const DEFAULT_TEMPLATE_IDS = {
  email_verification: EMAIL_TEMPLATE_EMAIL_VERIFICATION_ID,
  password_reset: EMAIL_TEMPLATE_PASSWORD_RESET_ID,
  magic_link: EMAIL_TEMPLATE_MAGIC_LINK_ID,
  team_invitation: EMAIL_TEMPLATE_TEAM_INVITATION_ID,
  sign_in_invitation: EMAIL_TEMPLATE_SIGN_IN_INVITATION_ID,
  payment_receipt: EMAIL_TEMPLATE_PAYMENT_RECEIPT_ID,
  payment_failed: EMAIL_TEMPLATE_PAYMENT_FAILED_ID,
  trial_will_end: EMAIL_TEMPLATE_TRIAL_WILL_END_ID,
} as const;

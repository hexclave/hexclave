"use client";

import { useUpdateConfig } from "@/components/config-update";
import { FormDialog } from "@/components/form-dialog";
import { InputField, SelectField } from "@/components/form-fields";
import { InlineCode, SimpleTooltip } from "@/components/ui";
import { DesignAlert, DesignButton, DesignCard } from "@hexclave/dashboard-ui-components";
import type { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { getSmsSenderValueError, smsSenderTypes, type SmsSenderType } from "@hexclave/shared/dist/utils/sms";
import { ChatTextIcon, GearSixIcon, TrashIcon } from "@phosphor-icons/react";
import * as yup from "yup";
import { useAdminApp } from "../use-admin-app";

type SmsServerConfig = CompleteConfig["sms"]["server"];
type SmsProvider = NonNullable<SmsServerConfig["provider"]>;

// The `test` provider delivers SMS to the local Inbucket instead of sending them, and the backend refuses to use it
// outside of development/test environments. We only offer it when the dashboard itself runs in development, which is
// the only setup where the backend is guaranteed to be a local one too.
const isTestProviderAvailable = process.env.NODE_ENV === "development";

const READ_ONLY_IN_DEVELOPMENT_ENVIRONMENT_TOOLTIP = "SMS provider settings contain secrets, so they are read-only in a development environment. Update them in your production deployment instead.";

const providerLabels = new Map<SmsProvider, string>([
  ["twilio", "Twilio"],
  ["webhook", "Webhook (any provider)"],
  ["test", "Test (delivers to local Inbucket)"],
]);

const senderTypeOptions: { value: SmsSenderType, label: string, placeholder: string }[] = [
  { value: "phone_number", label: "Phone number", placeholder: "+15555550100" },
  { value: "short_code", label: "Short code", placeholder: "55123" },
  { value: "alphanumeric", label: "Alphanumeric sender ID (not supported in US/Canada)", placeholder: "Acme" },
  { value: "messaging_service", label: "Messaging service", placeholder: "MG00000000000000000000000000000000" },
];

function requiredWhenProvider(provider: SmsProvider, label: string) {
  return yup.string().trim().when("provider", {
    is: provider,
    then: (schema) => schema.defined(`${label} is required`).nonNullable(`${label} is required`).min(1, `${label} is required`),
    otherwise: (schema) => schema.optional(),
  }).label(label);
}

const smsProviderFormSchema = yup.object({
  provider: yup.string().oneOf(["twilio", "webhook", "test"] as const).defined().label("Provider"),
  twilioAccountSid: requiredWhenProvider("twilio", "Account SID"),
  twilioAuthToken: requiredWhenProvider("twilio", "Auth token"),
  senderType: yup.string().oneOf(smsSenderTypes).when("provider", {
    is: "twilio",
    then: (schema) => schema.defined("Sender type is required"),
    otherwise: (schema) => schema.optional(),
  }).label("Sender type"),
  senderValue: requiredWhenProvider("twilio", "Sender").test("valid-sender", function (value) {
    const { provider, senderType } = this.parent;
    if (provider !== "twilio" || senderType == null || value == null || value === "") return true;
    const error = getSmsSenderValueError(senderType, value);
    return error === null ? true : this.createError({ message: error });
  }),
  // The format rules of the webhook fields must only apply while the webhook provider is selected; otherwise a value
  // typed before switching to another provider would block saving on a field that is no longer shown
  webhookUrl: requiredWhenProvider("webhook", "Webhook URL").when("provider", {
    is: "webhook",
    then: (schema) => schema.url("Must be a valid URL").test(
      "http-or-https",
      // The backend only delivers SMS webhooks over HTTP(S) (and only HTTPS outside of development environments)
      "Must be an HTTP or HTTPS URL",
      (value) => value == null || value === "" || !URL.canParse(value) || ["http:", "https:"].includes(new URL(value).protocol),
    ),
  }),
  webhookSecret: requiredWhenProvider("webhook", "Signing secret").when("provider", {
    is: "webhook",
    then: (schema) => schema.min(16, "Signing secret must be at least 16 characters"),
  }),
});

function SmsProviderDialog(props: { trigger: React.ReactNode, currentConfig: SmsServerConfig }) {
  const hexclaveAdminApp = useAdminApp();
  const updateConfig = useUpdateConfig();

  const providerOptions = [
    { value: "twilio", label: providerLabels.get("twilio") ?? "Twilio" },
    { value: "webhook", label: providerLabels.get("webhook") ?? "Webhook" },
    ...(isTestProviderAvailable ? [{ value: "test", label: providerLabels.get("test") ?? "Test" }] : []),
  ];

  return (
    <FormDialog
      trigger={props.trigger}
      title="Configure SMS provider"
      description="Used to send one-time codes for SMS sign-in and phone number verification."
      formSchema={smsProviderFormSchema}
      defaultValues={{
        provider: props.currentConfig.provider ?? "twilio",
        twilioAccountSid: props.currentConfig.twilioAccountSid,
        // The auth token is a secret that we never need to show again, so it must be re-entered when changing the settings
        senderType: props.currentConfig.senderType ?? "phone_number",
        senderValue: props.currentConfig.senderValue,
        webhookUrl: props.currentConfig.webhookUrl,
        // Unlike the Twilio auth token, the webhook secret was generated by us and must be copied into the receiving
        // endpoint, so we show it (and generate one if there is none yet)
        webhookSecret: props.currentConfig.webhookSecret ?? generateSecureRandomString(),
      }}
      okButton={{ label: "Save" }}
      cancelButton
      onSubmit={async (values) => {
        await updateConfig({
          adminApp: hexclaveAdminApp,
          configUpdate: {
            // Replaces the whole object, so fields of a previously configured provider don't linger
            "sms.server": values.provider === "twilio" ? {
              provider: "twilio",
              twilioAccountSid: values.twilioAccountSid,
              twilioAuthToken: values.twilioAuthToken,
              senderType: values.senderType,
              senderValue: values.senderValue,
            } : values.provider === "webhook" ? {
              provider: "webhook",
              webhookUrl: values.webhookUrl,
              webhookSecret: values.webhookSecret,
            } : {
              provider: "test",
            },
          },
          pushable: false,
        });
      }}
      render={(form) => {
        const provider = form.watch("provider");
        const senderType = form.watch("senderType");
        return (
          <>
            <SelectField label="Provider" name="provider" control={form.control} options={providerOptions} required />
            {provider === "twilio" && (
              <>
                <InputField label="Account SID" name="twilioAccountSid" control={form.control} placeholder="AC00000000000000000000000000000000" required />
                <InputField label="Auth token" name="twilioAuthToken" control={form.control} type="password" required />
                <SelectField label="Sender type" name="senderType" control={form.control} options={senderTypeOptions} required />
                <InputField
                  label="Sender"
                  name="senderValue"
                  control={form.control}
                  placeholder={senderTypeOptions.find((option) => option.value === senderType)?.placeholder}
                  required
                />
                {senderType === "messaging_service" && (
                  <DesignAlert
                    variant="info"
                    description="A Twilio Messaging Service picks a sender from its pool for each message, eg. the right short code for the destination country. Recommended if your users are in multiple countries."
                  />
                )}
              </>
            )}
            {provider === "webhook" && (
              <>
                <InputField label="Webhook URL" name="webhookUrl" control={form.control} placeholder="https://example.com/hexclave/sms" required />
                <InputField label="Signing secret" name="webhookSecret" control={form.control} required />
                <DesignAlert
                  variant="info"
                  description={<>
                    Each message is sent as a JSON POST request with <InlineCode>to</InlineCode>, <InlineCode>body</InlineCode> and <InlineCode>purpose</InlineCode> fields. Deliver it with any SMS provider and respond with a 2xx status within 10 seconds. Verify the <InlineCode>X-Hexclave-Signature</InlineCode> header (<InlineCode>{"t=<timestamp>,v1=<HMAC-SHA256 of \"<timestamp>.<body>\">"}</InlineCode>) with the signing secret.
                  </>}
                />
              </>
            )}
            {provider === "test" && (
              <DesignAlert
                variant="info"
                description="Messages are delivered as emails to <phone number digits>@sms.hexclave.test in your local Inbucket instead of being sent. Only works with a local backend."
              />
            )}
          </>
        );
      }}
    />
  );
}

function describeSmsSender(config: SmsServerConfig): string | null {
  if (config.provider === "webhook") {
    return config.webhookUrl === undefined ? null : `Sending to ${config.webhookUrl}`;
  }
  if (config.senderValue === undefined) return null;
  const senderTypeLabel = senderTypeOptions.find((option) => option.value === config.senderType)?.label.split(" (")[0].toLowerCase() ?? "sender";
  return `Sending from ${senderTypeLabel} ${config.senderValue}`;
}

export function SmsProviderSettings(props: { smsSignInEnabled: boolean }) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const smsServerConfig = project.useConfig().sms.server;
  const updateConfig = useUpdateConfig();
  const isReadOnly = project.isDevelopmentEnvironment;

  const withReadOnlyTooltip = (button: React.ReactNode) => isReadOnly
    ? <SimpleTooltip tooltip={READ_ONLY_IN_DEVELOPMENT_ENVIRONMENT_TOOLTIP} inline>{button}</SimpleTooltip>
    : button;

  return (
    <DesignCard
      title="SMS provider"
      subtitle="Sends one-time codes for SMS sign-in and phone number verification"
      icon={ChatTextIcon}
      gradient="default"
    >
      <div className="flex flex-col gap-3">
        {smsServerConfig.provider === undefined ? (
          <DesignAlert
            variant={props.smsSignInEnabled ? "warning" : "default"}
            title="No SMS provider configured"
            description={props.smsSignInEnabled
              ? "SMS sign-in is enabled, but codes can't be sent until you configure a provider."
              : "Configure a provider to enable SMS sign-in. Every message is billed to your provider account."}
          />
        ) : (
          <div className="flex items-center gap-3 rounded-xl px-3.5 py-3 bg-foreground/[0.03] ring-1 ring-black/[0.06] dark:ring-white/[0.06]">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">{providerLabels.get(smsServerConfig.provider) ?? smsServerConfig.provider}</div>
              {describeSmsSender(smsServerConfig) !== null && (
                <div className="text-xs text-muted-foreground mt-0.5 truncate">{describeSmsSender(smsServerConfig)}</div>
              )}
            </div>
          </div>
        )}
        <div className="flex gap-2 flex-wrap">
          {withReadOnlyTooltip(
            <SmsProviderDialog
              currentConfig={smsServerConfig}
              trigger={
                <DesignButton variant="secondary" disabled={isReadOnly}>
                  <GearSixIcon size={16} className="mr-1.5" />
                  {smsServerConfig.provider === undefined ? "Configure provider" : "Change provider"}
                </DesignButton>
              }
            />
          )}
          {smsServerConfig.provider !== undefined && (
            props.smsSignInEnabled ? (
              <SimpleTooltip tooltip="Disable SMS sign-in before removing the provider." inline>
                <DesignButton variant="outline" disabled>
                  <TrashIcon size={16} className="mr-1.5" />
                  Remove provider
                </DesignButton>
              </SimpleTooltip>
            ) : withReadOnlyTooltip(
              <DesignButton
                variant="outline"
                disabled={isReadOnly}
                onClick={async () => {
                  await updateConfig({
                    adminApp: hexclaveAdminApp,
                    configUpdate: { "sms.server": {} },
                    pushable: false,
                  });
                }}
              >
                <TrashIcon size={16} className="mr-1.5" />
                Remove provider
              </DesignButton>
            )
          )}
        </div>
      </div>
    </DesignCard>
  );
}

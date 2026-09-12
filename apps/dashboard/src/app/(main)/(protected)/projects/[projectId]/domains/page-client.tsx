"use client";
import { FormDialog } from "@/components/form-dialog";
import { InputField, SelectField, SwitchField } from "@/components/form-fields";
import { InlineSaveDiscard } from "@/components/inline-save-discard";
import { DesignAlert } from "@/components/design-components";
import { SettingCard, SettingSwitch } from "@/components/settings";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, ActionCell, ActionDialog, Alert, Button, Typography } from "@/components/ui";
import { useUpdateConfig } from "@/components/config-update";
import { DataGrid, useDataGridUrlState, useDataSource, type DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import { isValidHostWithWildcards } from "@hexclave/shared/dist/utils/urls";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import React, { useMemo, useState } from "react";
import * as yup from "yup";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";

type DomainEntry = {
  id: string,
  baseUrl: string,
  handlerPath: string,
};

function EditDialog(props: {
  open?: boolean,
  onOpenChange?: (open: boolean) => void,
  trigger?: React.ReactNode,
  domains: DomainEntry[],
  type: 'update' | 'create',
} & (
  {
    type: 'create',
  } |
  {
    type: 'update',
    editId: string,
    defaultDomain: string,
    defaultHandlerPath: string,
  }
)) {
  const hexclaveAdminApp = useAdminApp();
  const updateConfig = useUpdateConfig();
  const canAddWww = (domain: string | undefined) => {
    return domain == null || (!domain.includes('*') && !domain.startsWith('www.'));
  };
  const canAddSubdomains = (domain: string | undefined) => {
    return domain == null || !domain.includes('*');
  };
  const isScopeAvailable = (scope: string, domain: string | undefined) => {
    if (scope === 'only') {
      return true;
    }
    if (scope === 'www') {
      return canAddWww(domain);
    }
    if (scope === 'subdomains') {
      return canAddSubdomains(domain);
    }
    return false;
  };

  type DomainFormValues = {
    domain: string,
    handlerPath: string,
    scope: 'only' | 'subdomains' | 'www',
    insecureHttp: boolean,
  };
  const previousScope = React.useRef<DomainFormValues["scope"] | undefined>(undefined);

  const domainFormSchema: yup.ObjectSchema<DomainFormValues> = yup.object({
    domain: yupString()
      .test({
        name: 'domain',
        message: (params) => `Invalid domain`,
        test: (value) => value == null || isValidHostWithWildcards(value)
      })
      .test({
        name: 'unique-domain',
        message: "Domain already exists",
        test: function(value) {
          if (!value) return true;
          const { scope, insecureHttp } = this.parent;

          // Get all existing domains except the one being edited
          const existingDomains = props.domains
            .filter((d) => (props.type === 'update' && d.id !== props.editId) || props.type === 'create')
            .map(({ baseUrl }) => baseUrl);

          // Generate all variations of the domain being tested
          const hostVariations = [value];
          if (scope === 'www') {
            hostVariations.push('www.' + value);
          } else if (scope === 'subdomains') {
            hostVariations.push('**.' + value);
          }
          const protocols = insecureHttp ? ['http://', 'https://'] : ['https://'];
          const variations = protocols.flatMap(protocol => hostVariations.map(variation => protocol + variation));

          // Check if any variation exists in existing domains
          return !variations.some(variation => existingDomains.includes(variation));
        }
      })
      .defined(),
    handlerPath: yup.string()
      .matches(/^\//, "Handler path must start with /")
      .defined(),
    scope: yup.string().oneOf(['only', 'subdomains', 'www']).defined(),
    insecureHttp: yup.boolean().defined(),
  });

  return <FormDialog
    open={props.open}
    defaultValues={{
      scope: 'only',
      domain: props.type === 'update' ? props.defaultDomain.replace(/^https?:\/\//, "") : "",
      handlerPath: props.type === 'update' ? props.defaultHandlerPath : "/handler",
      insecureHttp: props.type === 'update' ? props.defaultDomain.startsWith('http://') : false,
    }}
    onOpenChange={props.onOpenChange}
    trigger={props.trigger}
    title={(props.type === 'create' ? "Create" : "Update") + " domain and handler"}
    formSchema={domainFormSchema}
    onFormChange={(form) => {
      if (props.type !== 'create') {
        return;
      }

      const scope = form.getValues('scope');
      const domain = form.getValues('domain');
      const scopeChanged = previousScope.current !== scope;
      previousScope.current = scope;
      if (!isScopeAvailable(scope, domain)) {
        form.setValue('scope', 'only', { shouldValidate: true });
      }
      if (scopeChanged) {
        runAsynchronously(form.trigger('domain'));
      }
    }}
    okButton={{ label: props.type === 'create' ? "Create" : "Save" }}
    onSubmit={async (values) => {
      const protocol = values.insecureHttp ? 'http://' : 'https://';
      const baseUrl = protocol + values.domain;

      if (props.type === 'create' && !isScopeAvailable(values.scope, values.domain)) {
        throw new HexclaveAssertionError(`Unavailable domain scope "${values.scope}" for "${values.domain}"`);
      }

      try {
        if (props.type === 'create') {
          // Create new domain(s)
          const newDomainId = generateUuid();
          const configUpdate: Record<string, {
            baseUrl: string,
            handlerPath: string,
          }> = {
            [`domains.trustedDomains.${newDomainId}`]: {
              baseUrl,
              handlerPath: values.handlerPath,
            },
          };

          if (values.scope !== 'only') {
            const additionalDomainId = generateUuid();
            const additionalDomain = values.scope === 'www'
              ? 'www.' + values.domain
              : '**.' + values.domain;
            configUpdate[`domains.trustedDomains.${additionalDomainId}`] = {
              baseUrl: protocol + additionalDomain,
              handlerPath: values.handlerPath,
            };
          }

          // Domains are environment-level (contain URLs that may differ per environment)
          await updateConfig({
            adminApp: hexclaveAdminApp,
            configUpdate,
            pushable: false,
          });
        } else {
          // Update existing domain
          await updateConfig({
            adminApp: hexclaveAdminApp,
            configUpdate: {
              [`domains.trustedDomains.${props.editId}`]: {
                baseUrl,
                handlerPath: values.handlerPath,
              },
            },
            pushable: false,
          });
        }
      } catch (error) {
        // this piece of code fails a lot, so let's add some additional information to the error
        // TODO: remove this error once we're confident this is no longer happening
        throw new HexclaveAssertionError(
          `Failed to update domains: ${error}`,
          {
            cause: error,
            props,
            values,
          },
        );
      }
    }}
    render={(form) => {
      const domain = form.watch('domain');
      const domainLabel = domain === '' ? 'this domain' : domain;
      const scopeOptions = [
        { value: 'only', label: `Only ${domainLabel}` },
        ...(canAddSubdomains(domain) ? [{
          value: 'subdomains',
          label: domain === '' ? 'This domain and all subdomains' : `${domain} and all subdomains`,
        }] : []),
        ...(canAddWww(domain) ? [{
          value: 'www',
          label: domain === '' ? 'This domain and its www subdomain' : `${domain} and www.${domain}`,
        }] : []),
      ];

      return (
        <>
          <DesignAlert variant="info">
            <div className="space-y-2 text-foreground/80 dark:text-muted-foreground">
              <p>Please ensure you own or have control over this domain. Also note that each subdomain (e.g. blog.example.com, app.example.com) is treated as a distinct domain.</p>
              <p><strong className="text-foreground">Wildcard domains:</strong> You can use wildcards to match multiple domains:</p>
              <ul className="ml-2 list-inside list-disc space-y-1">
                <li><code>*.example.com</code> - matches any single subdomain (e.g., api.example.com, www.example.com)</li>
                <li><code>**.example.com</code> - matches any subdomain level (e.g., api.v2.example.com)</li>
                <li><code>api-*.example.com</code> - matches api-v1.example.com, api-prod.example.com, etc.</li>
                <li><code>*.*.org</code> - matches mail.example.org, but not example.org</li>
              </ul>
              <p><strong className="text-foreground">Ports:</strong> Append a port to only match that port (e.g. <code>*.example.com:4250</code>).</p>
            </div>
          </DesignAlert>
          <InputField
            label="Domain"
            name="domain"
            control={form.control}
            prefixItem={form.getValues('insecureHttp') ? 'http://' : 'https://'}
            placeholder='example.com'
          />

          {props.type === 'create' && (
            <SelectField
              label="Scope"
              name="scope"
              control={form.control}
              options={scopeOptions}
            />
          )}

          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="item-1">
              <AccordionTrigger>Advanced</AccordionTrigger>
              <AccordionContent className="flex flex-col gap-8">
                <div className="flex flex-col gap-4">
                  <SwitchField
                    label="Use HTTP instead of HTTPS"
                    name="insecureHttp"
                    control={form.control}
                  />
                  {form.watch('insecureHttp') && (
                    <Alert variant="destructive">
                      HTTP should only be allowed during development use. For production use, please use HTTPS.
                    </Alert>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <InputField
                    label="Handler path"
                    name="handlerPath"
                    control={form.control}
                    placeholder='/handler'
                  />
                  <Typography variant="secondary" type="footnote">
                    only modify this if you changed the default handler path in your app
                  </Typography>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </>
      );
    }}
  />;
}

function DeleteDialog(props: {
  open?: boolean,
  onOpenChange?: (open: boolean) => void,
  domainId: string,
  baseUrl: string,
}) {
  const hexclaveAdminApp = useAdminApp();
  const updateConfig = useUpdateConfig();

  return (
    <ActionDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Delete domain"
      danger
      okButton={{
        label: "Delete",
        onClick: async () => {
          await updateConfig({
            adminApp: hexclaveAdminApp,
            configUpdate: {
              [`domains.trustedDomains.${props.domainId}`]: null,
            },
            pushable: false,
          });
        }
      }}
      cancelButton
    >
      <Typography>
        Do you really want to remove <b>{props.baseUrl}</b> from the allow list? Your project will no longer be able to receive callbacks from this domain.
      </Typography>
    </ActionDialog>
  );
}

function ActionMenu(props: {
  domains: DomainEntry[],
  domain: DomainEntry,
}) {
  const [isDeleteModalOpen, setIsDeleteModalOpen] = React.useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = React.useState(false);

  return (
    <>
      <EditDialog
        open={isEditModalOpen}
        onOpenChange={setIsEditModalOpen}
        domains={props.domains}
        type="update"
        editId={props.domain.id}
        defaultDomain={props.domain.baseUrl}
        defaultHandlerPath={props.domain.handlerPath}
      />
      <DeleteDialog
        open={isDeleteModalOpen}
        onOpenChange={setIsDeleteModalOpen}
        domainId={props.domain.id}
        baseUrl={props.domain.baseUrl}
      />
      <ActionCell
        items={[
          { item: "Edit", onClick: () => setIsEditModalOpen(true) },
          '-',
          { item: "Delete", onClick: () => setIsDeleteModalOpen(true), danger: true }
        ]}
      />
    </>
  );
}

function DomainDataGrid({ domains }: { domains: DomainEntry[] }) {
  const columns = useMemo<DataGridColumnDef<DomainEntry>[]>(() => [
    { id: "domain", header: "Domain", accessor: "baseUrl", width: 300, type: "string" },
    {
      id: "actions",
      header: "",
      width: 80,
      sortable: false,
      resizable: false,
      renderCell: ({ row }) => (
        <ActionMenu domains={domains} domain={row} />
      ),
    },
  ], [domains]);

  const [gridState, setGridState] = useDataGridUrlState(columns, { paramPrefix: "domains" });
  const gridData = useDataSource({
    data: domains,
    columns,
    getRowId: (row) => row.id,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    paginationMode: "client",
  });

  return (
    <DataGrid
      columns={columns}
      rows={gridData.rows}
      getRowId={(row) => row.id}
      totalRowCount={gridData.totalRowCount}
      state={gridState}
      onChange={setGridState}
      paginationMode="infinite"
      hasMore={gridData.hasMore}
      isLoadingMore={gridData.isLoadingMore}
      onLoadMore={gridData.loadMore}
      footer={false}
      fillHeight={false}
    />
  );
}

export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();

  // Local state for localhost setting
  const [localAllowLocalhost, setLocalAllowLocalhost] = useState<boolean | undefined>(undefined);
  const allowLocalhost = localAllowLocalhost ?? config.domains.allowLocalhost;
  const hasLocalhostChanges = localAllowLocalhost !== undefined;

  const handleLocalhostSave = async () => {
    if (localAllowLocalhost !== undefined) {
      await updateConfig({
        adminApp: hexclaveAdminApp,
        configUpdate: {
          'domains.allowLocalhost': localAllowLocalhost,
        },
        pushable: false,
      });
    }
    setLocalAllowLocalhost(undefined);
  };

  const handleLocalhostDiscard = () => {
    setLocalAllowLocalhost(undefined);
  };

  // Convert config domains to array format for display
  const domains: DomainEntry[] = typedEntries(config.domains.trustedDomains)
    .filter(([, domain]) => domain.baseUrl !== undefined)
    .map(([id, domain]) => ({
      id,
      baseUrl: domain.baseUrl!,
      handlerPath: domain.handlerPath,
    }));

  return (
    <AppEnabledGuard appId="authentication">
      <PageLayout title="Domains">
        <SettingCard
          title="Trusted domains"
          description="Features that will redirect to your app, such as SSO and e-mail verification, will refuse to redirect to domains other than the ones listed here. Please make sure that you trust all domains listed here, as they can be used to access user data."
          actions={
            <EditDialog
              trigger={<Button>Add new domain</Button>}
              domains={domains}
              type="create"
            />
          }
        >
          {domains.length > 0 ? (
            <DomainDataGrid domains={domains} />
          ) : (
            <DesignAlert variant="info" description="No domains added yet." />
          )}
        </SettingCard>

        <SettingCard title="Development settings">
          <SettingSwitch
            checked={allowLocalhost}
            onCheckedChange={(checked) => {
              if (checked === config.domains.allowLocalhost) {
                setLocalAllowLocalhost(undefined);
              } else {
                setLocalAllowLocalhost(checked);
              }
            }}
            label="Allow all localhost callbacks for development"
            hint={<>
              When enabled, allow access from all localhost URLs by default. This makes development easier but <b>should be disabled in production.</b>
            </>}
          />
          <InlineSaveDiscard
            hasChanges={hasLocalhostChanges}
            onSave={handleLocalhostSave}
            onDiscard={handleLocalhostDiscard}
          />
        </SettingCard>
      </PageLayout>
    </AppEnabledGuard>
  );
}

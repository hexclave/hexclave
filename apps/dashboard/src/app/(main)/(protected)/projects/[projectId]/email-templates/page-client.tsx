"use client";

import { DesignCard } from "@/components/design-components";
import { FormDialog } from "@/components/form-dialog";
import { InputField } from "@/components/form-fields";
import { useRouter } from "@/components/router";
import { ActionDialog, Alert, AlertDescription, AlertTitle, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, toast, Typography } from "@/components/ui";
import { DotsThree, EnvelopeSimpleIcon, PlusIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import * as yup from "yup";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp, useProjectId } from "../use-admin-app";
import { urlString } from "@hexclave/shared/dist/utils/urls";

export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const projectId = useProjectId();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const emailConfig = config.emails.server;
  const emailTemplates = hexclaveAdminApp.useEmailTemplates();
  const router = useRouter();
  const [sharedSmtpWarningDialogOpen, setSharedSmtpWarningDialogOpen] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async (templateId: string) => {
    try {
      setDeleteError(null);
      await hexclaveAdminApp.deleteEmailTemplate(templateId);
      toast({ title: "Template deleted successfully", variant: "success" });
      setDeleteDialogOpen(null);
      return;
    } catch (error) {
      console.error("Failed to delete email template:", error);
      const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred while deleting the template";
      setDeleteError(errorMessage);
      return "prevent-close" as const;
    }
  };

  return (
    <AppEnabledGuard appId="emails">
      <PageLayout
        title="Email Templates"
        description="Customize the emails sent to your users"
        actions={<NewTemplateButton />}
      >
        {emailConfig.isShared && (
          <Alert className="bg-orange-500/5 border-orange-500/20 text-orange-600 dark:text-orange-400">
            <WarningCircleIcon className="h-4 w-4" />
            <AlertTitle className="font-semibold">Warning</AlertTitle>
            <AlertDescription className="text-muted-foreground">
              You are using a shared email server. If you want to customize the email templates, you need to configure a custom SMTP server.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-3">
          {emailTemplates.map((template) => (
            <DesignCard
              key={template.id}
              glassmorphic
              gradient="default"
              contentClassName="p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-4 min-w-0 flex-1">
                  <div className="p-2.5 rounded-xl bg-foreground/[0.04] ring-1 ring-foreground/[0.06] shrink-0">
                    <EnvelopeSimpleIcon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <Typography className="font-semibold text-foreground truncate">
                    {template.displayName}
                  </Typography>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors duration-150 hover:transition-none rounded-lg"
                    onClick={() => {
                      if (emailConfig.isShared) {
                        setSharedSmtpWarningDialogOpen(template.id);
                      } else {
                        router.push(urlString`/projects/${projectId}/app-configuration/emails/templates/${template.id}`);
                      }
                    }}
                  >
                    Edit Template
                  </Button>

                  {!emailConfig.isShared && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors duration-150 hover:transition-none rounded-lg"
                        >
                          <DotsThree size={20} weight="bold" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[180px]">
                        <DropdownMenuItem
                          onClick={() => setDeleteDialogOpen(template.id)}
                          className="py-2.5 text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400 focus:bg-red-500/10 cursor-pointer justify-center"
                        >
                          <span className="font-medium">Delete Template</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            </DesignCard>
          ))}
        </div>

        <ActionDialog
          open={sharedSmtpWarningDialogOpen !== null}
          onClose={() => setSharedSmtpWarningDialogOpen(null)}
          title="Shared Email Server"
          okButton={{
            label: "Edit Templates Anyway", onClick: async () => {
              if (sharedSmtpWarningDialogOpen == null) {
                return;
              }
              router.push(urlString`/projects/${projectId}/app-configuration/emails/templates/${sharedSmtpWarningDialogOpen}`);
            }
          }}
          cancelButton={{ label: "Cancel" }}
        >
          <Alert className="bg-orange-500/5 border-orange-500/20 text-orange-600 dark:text-orange-400">
            <WarningCircleIcon className="h-4 w-4" />
            <AlertTitle className="font-semibold">Warning</AlertTitle>
            <AlertDescription className="text-muted-foreground">
              You are using a shared email server. If you want to customize the email templates, you need to configure a custom SMTP server.
              You can edit the templates anyway, but you will not be able to save them.
            </AlertDescription>
          </Alert>
        </ActionDialog>

        <ActionDialog
          open={deleteDialogOpen !== null}
          onClose={() => {
            setDeleteDialogOpen(null);
            setDeleteError(null);
          }}
          title="Delete Email Template"
          okButton={{
            label: "Delete",
            onClick: async () => {
              if (deleteDialogOpen) {
                await handleDelete(deleteDialogOpen);
              }
            },
            props: {
              variant: "destructive"
            }
          }}
          cancelButton={{ label: "Cancel" }}
        >
          {deleteError ? (
            <Alert className="bg-red-500/5 border-red-500/20 text-red-600 dark:text-red-400">
              <WarningCircleIcon className="h-4 w-4" />
              <AlertTitle className="font-semibold">Error</AlertTitle>
              <AlertDescription className="text-muted-foreground">
                {deleteError}
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="bg-red-500/5 border-red-500/20 text-red-600 dark:text-red-400">
              <WarningCircleIcon className="h-4 w-4" />
              <AlertTitle className="font-semibold">Confirm Deletion</AlertTitle>
              <AlertDescription className="text-muted-foreground">
                Are you sure you want to delete this email template? This action cannot be undone.
              </AlertDescription>
            </Alert>
          )}
        </ActionDialog>
      </PageLayout>
    </AppEnabledGuard>
  );
}

function NewTemplateButton() {
  const hexclaveAdminApp = useAdminApp();
  const projectId = useProjectId();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const emailConfig = config.emails.server;
  const router = useRouter();
  const [showSharedWarning, setShowSharedWarning] = useState(false);

  const handleCreateNewTemplate = async (values: { name: string }) => {
    const { id } = await hexclaveAdminApp.createEmailTemplate(values.name);
    router.push(urlString`/projects/${projectId}/app-configuration/emails/templates/${id}`);
  };

  if (emailConfig.isShared) {
    return (
      <>
        <Button className="gap-2" onClick={() => setShowSharedWarning(true)}>
          <PlusIcon className="h-4 w-4" />
          New Template
        </Button>
        <ActionDialog
          open={showSharedWarning}
          onClose={() => setShowSharedWarning(false)}
          title="Custom Email Server Required"
          okButton={{
            label: "Configure Email Server",
            onClick: async () => {
              router.push(urlString`/projects/${projectId}/project-settings/email`);
            }
          }}
          cancelButton={{ label: "Cancel" }}
        >
          <Alert className="bg-orange-500/5 border-orange-500/20 text-orange-600 dark:text-orange-400">
            <WarningCircleIcon className="h-4 w-4" />
            <AlertTitle className="font-semibold">Custom SMTP Required</AlertTitle>
            <AlertDescription className="text-muted-foreground">
              To create custom email templates, you need to configure a custom SMTP server first.
            </AlertDescription>
          </Alert>
        </ActionDialog>
      </>
    );
  }

  return (
    <FormDialog
      title="New Template"
      trigger={
        <Button className="gap-2">
          <PlusIcon className="h-4 w-4" />
          New Template
        </Button>
      }
      onSubmit={handleCreateNewTemplate}
      formSchema={yup.object({
        name: yup.string().defined(),
      })}
      render={(form) => (
        <InputField
          control={form.control}
          name="name"
          label="Template Name"
          placeholder="Enter template name"
          required
        />
      )}
    />
  );
}

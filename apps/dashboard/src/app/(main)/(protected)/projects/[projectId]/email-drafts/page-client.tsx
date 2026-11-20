"use client";

import { DesignAnalyticsCard } from "@/components/design-components";
import { FormDialog } from "@/components/form-dialog";
import { InputField } from "@/components/form-fields";
import { useRouter } from "@/components/router";
import { ActionDialog, Alert, AlertDescription, AlertTitle, Button, Dialog, DialogContent, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input, Label, Spinner, Typography } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ArrowLeft, CaretDown, ClockCounterClockwise, Copy, DotsThreeVertical, FileCode, FileText, PaperPlaneTilt, Pencil, Plus, WarningCircle } from "@phosphor-icons/react";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useMemo, useState, type ElementType } from "react";
import * as yup from "yup";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";

// Section header with icon following design guide
function SectionHeader({ icon: Icon, title }: { icon: ElementType, title: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="p-1.5 rounded-lg bg-foreground/[0.04]">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
        {title}
      </span>
    </div>
  );
}

// Draft item card component
function DraftCard({
  draft,
  onOpen,
  onDelete,
  onRename,
}: {
  draft: { id: string, displayName: string },
  onOpen: () => void,
  onDelete: () => void,
  onRename: (newName: string) => Promise<void>,
}) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);

  return (
    <>
      <div
        className={cn(
          "group/card relative flex items-center justify-between gap-4 p-4 rounded-xl",
          "bg-gray-100/50 dark:bg-foreground/[0.03]",
          "border border-border/30 dark:border-foreground/[0.06]",
          "hover:bg-gray-100 dark:hover:bg-foreground/[0.05]",
          "transition-all duration-150 hover:transition-none cursor-pointer"
        )}
        onClick={onOpen}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="p-2 rounded-lg bg-foreground/[0.04] shrink-0">
            <FileText className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <Typography className="font-medium text-sm truncate">
              {draft.displayName}
            </Typography>
            <Typography variant="secondary" className="text-xs truncate">
              Draft email
            </Typography>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-3 text-xs gap-1.5 opacity-0 group-hover/card:opacity-100 transition-opacity duration-150"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "inline-flex h-7 w-7 items-center justify-center rounded-lg",
                  "text-muted-foreground hover:text-foreground",
                  "hover:bg-foreground/[0.05]",
                  "transition-colors duration-150 hover:transition-none",
                  "opacity-0 group-hover/card:opacity-100"
                )}
                onClick={(e) => e.stopPropagation()}
              >
                <DotsThreeVertical className="h-4 w-4" weight="bold" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  setShowRenameDialog(true);
                }}
              >
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowDeleteDialog(true);
                }}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <FormDialog
        open={showRenameDialog}
        onOpenChange={setShowRenameDialog}
        title="Rename Draft"
        formSchema={yup.object({
          name: yup.string().defined().nonEmpty().label("Draft name"),
        })}
        defaultValues={{ name: draft.displayName }}
        okButton={{ label: "Rename" }}
        cancelButton
        onSubmit={async (values) => {
          await onRename(values.name);
        }}
        render={(form) => (
          <InputField
            control={form.control}
            name="name"
            label="Draft Name"
            placeholder="Enter a new name for your draft"
            required
          />
        )}
      />

      <ActionDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title="Delete Draft"
        danger
        okButton={{
          label: "Delete",
          onClick: async () => {
            onDelete();
            setShowDeleteDialog(false);
          }
        }}
        cancelButton
      >
        Are you sure you want to delete &ldquo;{draft.displayName}&rdquo;? This action cannot be undone.
      </ActionDialog>
    </>
  );
}

// History draft card component (for sent drafts)
function HistoryDraftCard({
  draft,
  onOpen,
  onDelete,
  onRename,
}: {
  draft: { id: string, displayName: string, sentAt: Date },
  onOpen: () => void,
  onDelete: () => void,
  onRename: (newName: string) => Promise<void>,
}) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);

  return (
    <>
      <div
        className={cn(
          "group/card relative flex items-center justify-between gap-4 p-4 rounded-xl",
          "bg-gray-50/50 dark:bg-foreground/[0.02]",
          "border border-border/20 dark:border-foreground/[0.04]",
          "hover:bg-gray-100/50 dark:hover:bg-foreground/[0.03]",
          "transition-all duration-150 hover:transition-none cursor-pointer"
        )}
        onClick={onOpen}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="p-2 rounded-lg bg-foreground/[0.03] shrink-0">
            <PaperPlaneTilt className="h-4 w-4 text-muted-foreground/70" />
          </div>
          <div className="min-w-0 flex-1">
            <Typography className="font-medium text-sm truncate text-muted-foreground">
              {draft.displayName}
            </Typography>
            <Typography variant="secondary" className="text-xs truncate">
              Sent {draft.sentAt.toLocaleDateString()}
            </Typography>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Typography variant="secondary" className="text-xs opacity-0 group-hover/card:opacity-100 transition-opacity duration-150">
            View results
          </Typography>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "inline-flex h-7 w-7 items-center justify-center rounded-lg",
                  "text-muted-foreground hover:text-foreground",
                  "hover:bg-foreground/[0.05]",
                  "transition-colors duration-150 hover:transition-none",
                  "opacity-0 group-hover/card:opacity-100"
                )}
                onClick={(e) => e.stopPropagation()}
              >
                <DotsThreeVertical className="h-4 w-4" weight="bold" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  setShowRenameDialog(true);
                }}
              >
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowDeleteDialog(true);
                }}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <FormDialog
        open={showRenameDialog}
        onOpenChange={setShowRenameDialog}
        title="Rename Draft"
        formSchema={yup.object({
          name: yup.string().defined().nonEmpty().label("Draft name"),
        })}
        defaultValues={{ name: draft.displayName }}
        okButton={{ label: "Rename" }}
        cancelButton
        onSubmit={async (values) => {
          await onRename(values.name);
        }}
        render={(form) => (
          <InputField
            control={form.control}
            name="name"
            label="Draft Name"
            placeholder="Enter a new name for your draft"
            required
          />
        )}
      />

      <ActionDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title="Delete Sent Draft"
        danger
        okButton={{
          label: "Delete",
          onClick: async () => {
            onDelete();
            setShowDeleteDialog(false);
          }
        }}
        cancelButton
      >
        Are you sure you want to delete &ldquo;{draft.displayName}&rdquo;? This will remove the draft record but not the sent emails.
      </ActionDialog>
    </>
  );
}

// Empty state component
function EmptyState({
  onCreateFromScratch,
  onCreateFromTemplate,
}: {
  onCreateFromScratch: () => void,
  onCreateFromTemplate: () => void,
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="p-4 rounded-2xl bg-foreground/[0.04] mb-4">
        <PaperPlaneTilt className="h-8 w-8 text-muted-foreground/50" />
      </div>
      <Typography className="text-sm font-medium text-foreground mb-1">
        No drafts yet
      </Typography>
      <Typography variant="secondary" className="text-sm mb-4 max-w-xs">
        Create your first email draft to start composing messages
      </Typography>
      <NewDraftDropdown
        onCreateFromScratch={onCreateFromScratch}
        onCreateFromTemplate={onCreateFromTemplate}
      />
    </div>
  );
}

export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const emailConfig = config.emails.server;
  const router = useRouter();
  const drafts = hexclaveAdminApp.useEmailDrafts();
  const [sharedSmtpWarningDialogOpen, setSharedSmtpWarningDialogOpen] = useState<string | null>(null);
  const [newDraftDialogOpen, setNewDraftDialogOpen] = useState(false);
  const [templateSelectDialogOpen, setTemplateSelectDialogOpen] = useState(false);

  // Split drafts into active (not sent) and history (sent)
  const { activeDrafts, historyDrafts } = useMemo(() => {
    const active: typeof drafts = [];
    const history: Array<(typeof drafts)[number] & { sentAt: Date }> = [];
    for (const draft of drafts) {
      if (draft.sentAt != null) {
        history.push({
          ...draft,
          sentAt: draft.sentAt,
        });
      } else {
        active.push(draft);
      }
    }
    return { activeDrafts: active, historyDrafts: history };
  }, [drafts]);

  const handleOpenDraft = (draftId: string) => {
    if (emailConfig.isShared) {
      setSharedSmtpWarningDialogOpen(draftId);
    } else {
      router.push(urlString`email-drafts/${draftId}`);
    }
  };

  const handleOpenHistoryDraft = (draftId: string) => {
    router.push(urlString`email-drafts/${draftId}?stage=sent`);
  };

  const handleDeleteDraft = async (draftId: string) => {
    await hexclaveAdminApp.deleteEmailDraft(draftId);
  };

  const handleRenameDraft = async (draftId: string, newName: string) => {
    await stackAdminApp.updateEmailDraft(draftId, { displayName: newName });
  };

  return (
    <AppEnabledGuard appId="emails">
      <PageLayout
        title="Email Drafts"
        description="Create, edit, and send email drafts"
        actions={
          <NewDraftDropdown
            onCreateFromScratch={() => setNewDraftDialogOpen(true)}
            onCreateFromTemplate={() => setTemplateSelectDialogOpen(true)}
          />
        }
      >
        <DesignAnalyticsCard gradient="slate" className="overflow-hidden" chart={{ type: "none", tooltipType: "none", highlightMode: "none" }}>
          <div className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <SectionHeader icon={FileText} title="Drafts" />
                <Typography variant="secondary" className="text-sm mt-1">
                  Compose and manage your email drafts
                </Typography>
              </div>
              <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
                Active Drafts
              </span>
            </div>
            {activeDrafts.length > 0 && (
              <div className="text-xs text-muted-foreground tabular-nums">
                {activeDrafts.length} {activeDrafts.length === 1 ? 'draft' : 'drafts'}
              </div>
            )}
          </div>
          {/* Shared SMTP Warning */}
          {emailConfig.isShared && (
            <div className="px-5 py-4">
              <Alert variant="default" className="bg-amber-500/5 border-amber-500/20">
                <WarningCircle className="h-4 w-4 text-amber-500" weight="regular" />
                <AlertTitle className="text-amber-600 dark:text-amber-400">Using shared email server</AlertTitle>
                <AlertDescription className="text-muted-foreground">
                  Configure a custom SMTP server to send manual emails. You can still create and edit drafts.
                </AlertDescription>
              </Alert>
            </div>
          )}

          {/* Active Drafts List */}
          {activeDrafts.length === 0 ? (
            <EmptyState
              onCreateFromScratch={() => setNewDraftDialogOpen(true)}
              onCreateFromTemplate={() => setTemplateSelectDialogOpen(true)}
            />
          ) : (
            <div className="p-4 space-y-2">
              {activeDrafts.map((draft) => (
                <DraftCard
                  key={draft.id}
                  draft={draft}
                  onOpen={() => handleOpenDraft(draft.id)}
                  onDelete={() => runAsynchronouslyWithAlert(() => handleDeleteDraft(draft.id))}
                  onRename={(newName) => handleRenameDraft(draft.id, newName)}
                />
              ))}
            </div>
          )}

          {/* Add New Draft Button (when active drafts exist) */}
          {activeDrafts.length > 0 && (
            <div className="border-t border-black/[0.12] dark:border-white/[0.06] p-4">
              <NewDraftDropdown
                onCreateFromScratch={() => setNewDraftDialogOpen(true)}
                onCreateFromTemplate={() => setTemplateSelectDialogOpen(true)}
                variant="dashed"
              />
            </div>
          )}
        </DesignAnalyticsCard>

        {/* Draft History */}
        {historyDrafts.length > 0 && (
          <DesignAnalyticsCard chart={{ type: "none", tooltipType: "none", highlightMode: "none" }}>
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <SectionHeader icon={ClockCounterClockwise} title="History" />
                <Typography variant="secondary" className="text-xs">
                  {historyDrafts.length} sent {historyDrafts.length === 1 ? "draft" : "drafts"}
                </Typography>
              </div>
              <div className="flex flex-col gap-2">
                {historyDrafts.map((draft) => (
                  <HistoryDraftCard
                    key={draft.id}
                    draft={draft}
                    onOpen={() => handleOpenHistoryDraft(draft.id)}
                    onDelete={() => runAsynchronouslyWithAlert(() => handleDeleteDraft(draft.id))}
                    onRename={(newName) => handleRenameDraft(draft.id, newName)}
                  />
                ))}
              </div>
            </div>
          </DesignAnalyticsCard>
        )}

        {/* Shared SMTP Warning Dialog */}
        <ActionDialog
          open={sharedSmtpWarningDialogOpen !== null}
          onClose={() => setSharedSmtpWarningDialogOpen(null)}
          title="Shared Email Server"
          okButton={{
            label: "Open Draft Anyway",
            onClick: async () => {
              if (sharedSmtpWarningDialogOpen === null) return;
              router.push(urlString`email-drafts/${sharedSmtpWarningDialogOpen}`);
            }
          }}
          cancelButton={{ label: "Cancel" }}
        >
          <Alert variant="default" className="bg-amber-500/5 border-amber-500/20">
            <WarningCircle className="h-4 w-4 text-amber-500" weight="regular" />
            <AlertTitle className="text-amber-600 dark:text-amber-400">Warning</AlertTitle>
            <AlertDescription>
              You are using a shared email server. You can open the draft anyway, but you will not be able to send emails.
            </AlertDescription>
          </Alert>
        </ActionDialog>

        {/* New Draft Dialog (from scratch) */}
        <NewDraftDialog
          open={newDraftDialogOpen}
          onOpenChange={setNewDraftDialogOpen}
        />

        {/* Template Select Dialog */}
        <TemplateSelectDialog
          open={templateSelectDialogOpen}
          onOpenChange={setTemplateSelectDialogOpen}
        />
      </PageLayout>
    </AppEnabledGuard>
  );
}

function NewDraftDropdown({
  onCreateFromScratch,
  onCreateFromTemplate,
  variant = "default",
}: {
  onCreateFromScratch: () => void,
  onCreateFromTemplate: () => void,
  variant?: "default" | "dashed",
}) {
  if (variant === "dashed") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "w-full flex items-center justify-center gap-2 py-3 rounded-xl",
              "border border-dashed border-foreground/[0.1]",
              "bg-background/40 hover:bg-foreground/[0.03]",
              "text-muted-foreground hover:text-foreground",
              "text-sm font-medium",
              "transition-all duration-150 hover:transition-none"
            )}
          >
            <Plus className="h-4 w-4" />
            Create new draft
            <CaretDown className="h-3 w-3 ml-1" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          <DropdownMenuItem onClick={onCreateFromScratch} icon={<FileText className="h-4 w-4" />}>
            Create from scratch
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCreateFromTemplate} icon={<Copy className="h-4 w-4" />}>
            Create from template
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          New Draft
          <CaretDown className="h-3 w-3 ml-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onCreateFromScratch} icon={<FileText className="h-4 w-4" />}>
          Create from scratch
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCreateFromTemplate} icon={<Copy className="h-4 w-4" />}>
          Create from template
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NewDraftDialog({
  open,
  onOpenChange,
}: {
  open: boolean,
  onOpenChange: (open: boolean) => void,
}) {
  const hexclaveAdminApp = useAdminApp();
  const router = useRouter();

  const handleCreateNewDraft = async (values: { name: string }) => {
    const draft = await hexclaveAdminApp.createEmailDraft({ displayName: values.name });
    router.push(urlString`email-drafts/${draft.id}`);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New Draft"
      onSubmit={handleCreateNewDraft}
      formSchema={yup.object({
        name: yup.string().defined().label("Draft name"),
      })}
      okButton={{ label: "Create Draft" }}
      cancelButton
      render={(form) => (
        <InputField
          control={form.control}
          name="name"
          label="Draft Name"
          placeholder="Enter a name for your draft"
          required
        />
      )}
    />
  );
}

type TemplateDialogStep = "select" | "name";

function TemplateSelectDialog({
  open,
  onOpenChange,
}: {
  open: boolean,
  onOpenChange: (open: boolean) => void,
}) {
  const hexclaveAdminApp = useAdminApp();
  const router = useRouter();
  const templates = hexclaveAdminApp.useEmailTemplates();

  const [step, setStep] = useState<TemplateDialogStep>("select");
  const [selectedTemplate, setSelectedTemplate] = useState<{ id: string, displayName: string, tsxSource: string } | null>(null);
  const [draftName, setDraftName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const resetDialog = () => {
    setStep("select");
    setSelectedTemplate(null);
    setDraftName("");
    setIsCreating(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      resetDialog();
    }
    onOpenChange(newOpen);
  };

  const handleSelectTemplate = async (template: { id: string, displayName: string, tsxSource: string }) => {
    setSelectedTemplate(template);
    setDraftName(`Copy of ${template.displayName}`);
    setStep("name");
  };

  const createDraftFromTemplate = async () => {
    if (!selectedTemplate || !draftName.trim()) return;
    setIsCreating(true);
    try {
      const rewritten = await hexclaveAdminApp.rewriteTemplateSourceWithAI(selectedTemplate.tsxSource);
      const draft = await hexclaveAdminApp.createEmailDraft({
        displayName: draftName.trim(),
        tsxSource: rewritten.tsxSource,
      });

      handleOpenChange(false);
      router.push(urlString`email-drafts/${draft.id}`);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === "select" ? "Create from Template" : "Name Your Draft"}
          </DialogTitle>
        </DialogHeader>

        {step === "select" && (
          <div className="mt-4">
            {templates.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="p-3 rounded-xl bg-foreground/[0.04] mb-3">
                  <FileCode className="h-6 w-6 text-muted-foreground/50" />
                </div>
                <Typography className="text-sm font-medium text-foreground mb-1">
                  No templates available
                </Typography>
                <Typography variant="secondary" className="text-sm max-w-xs">
                  Create templates first to use them as a starting point for drafts
                </Typography>
              </div>
            ) : (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {templates.map((template) => (
                  <button
                    type="button"
                    key={template.id}
                    disabled={isCreating}
                    onClick={() => runAsynchronouslyWithAlert(handleSelectTemplate(template))}
                    className={cn(
                      "w-full flex items-center gap-3 p-3 rounded-lg text-left",
                      "bg-gray-100/50 dark:bg-foreground/[0.03]",
                      "border border-border/30 dark:border-foreground/[0.06]",
                      "hover:bg-gray-100 dark:hover:bg-foreground/[0.05]",
                      "transition-all duration-150 hover:transition-none",
                      isCreating && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <div className="p-2 rounded-lg bg-foreground/[0.04] shrink-0">
                      <FileCode className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Typography className="font-medium text-sm truncate">
                        {template.displayName}
                      </Typography>
                      <Typography variant="secondary" className="text-xs truncate">
                        Use as starting point
                      </Typography>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {step === "name" && (
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="draft-name" className="text-sm font-medium">Draft name</Label>
              <Input
                id="draft-name"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Enter a name for your draft"
                autoFocus
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setStep("select")}
                disabled={isCreating}
              >
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
              <Button
                type="button"
                onClick={() => runAsynchronouslyWithAlert(createDraftFromTemplate)}
                disabled={!draftName.trim() || isCreating}
                className="flex-1"
              >
                {isCreating ? (
                  <>
                    <Spinner className="h-4 w-4 mr-2" />
                    Creating...
                  </>
                ) : (
                  "Create Draft"
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

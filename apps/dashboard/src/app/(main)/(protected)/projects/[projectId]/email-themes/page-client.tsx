"use client";

import EmailPreview, { DEVICE_VIEWPORTS, DeviceViewport } from "@/components/email-preview";
import { FormDialog } from "@/components/form-dialog";
import { InputField } from "@/components/form-fields";
import { useRouter } from "@/components/router";
import { ActionDialog, Alert, AlertDescription, AlertTitle, Button, Typography } from "@/components/ui";
import { useUpdateConfig } from "@/components/config-update";
import { cn } from "@/lib/utils";
import { CheckIcon, DeviceMobile, DeviceTablet, Monitor, Palette, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { DEFAULT_EMAIL_THEMES, DEFAULT_EMAIL_THEME_ID, previewTemplateSource } from "@hexclave/shared/dist/helpers/emails";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useRef, useState, type ElementType } from "react";
import * as yup from "yup";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp, useProjectId } from "../use-admin-app";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { DesignAnalyticsCard } from "@/components/design-components";

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

// Device icon component
function DeviceIcon({ type, className }: { type: DeviceViewport['type'], className?: string }) {
  switch (type) {
    case 'phone': {
      return <DeviceMobile className={className} />;
    }
    case 'tablet': {
      return <DeviceTablet className={className} />;
    }
    case 'desktop': {
      return <Monitor className={className} />;
    }
  }
}

// Viewport selector component following design guide's Time Range Toggle pattern
function ViewportSelector({
  selectedViewport,
  onSelect,
  className
}: {
  selectedViewport: DeviceViewport,
  onSelect: (viewport: DeviceViewport) => void,
  className?: string,
}) {
  return (
    <div className={cn("inline-flex items-center gap-1 rounded-xl bg-foreground/[0.04] p-1 backdrop-blur-sm", className)}>
      {DEVICE_VIEWPORTS.map((viewport) => {
        const isActive = selectedViewport.id === viewport.id;
        return (
          <button
            key={viewport.id}
            onClick={() => onSelect(viewport)}
            className={cn(
              "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all duration-150 hover:transition-none",
              isActive
                ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/[0.06]"
                : "text-muted-foreground hover:text-foreground hover:bg-background/50"
            )}
          >
            <DeviceIcon type={viewport.type} className="h-4 w-4" />
            <span>{viewport.name}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const themes = hexclaveAdminApp.useEmailThemes();
  const config = project.useConfig();
  const activeTheme = config.emails.selectedThemeId;
  const updateConfig = useUpdateConfig();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogSelectedThemeId, setDialogSelectedThemeId] = useState<string>(activeTheme);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [selectedViewport, setSelectedViewport] = useState<DeviceViewport>(DEVICE_VIEWPORTS[0]); // Phone
  const containerRef = useRef<HTMLDivElement>(null);
  const [showViewportSelector, setShowViewportSelector] = useState(true);

  // Default to phone view on small containers and hide selector
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const isSmall = width < 700; // Threshold for hiding desktop/tablet views
        setShowViewportSelector(!isSmall);
        if (isSmall) {
          setSelectedViewport(DEVICE_VIEWPORTS[0]);
        }
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleThemeSelect = (themeId: string) => {
    setDialogSelectedThemeId(themeId);
    setDialogError(null);
  };

  const handleSaveTheme = async () => {
    setDialogError(null);
    return await new Promise<"prevent-close" | void>((resolve) => {
      runAsynchronouslyWithAlert(async () => {
        const didUpdate = await updateConfig({
          adminApp: hexclaveAdminApp,
          configUpdate: {
            'emails.selectedThemeId': dialogSelectedThemeId,
          },
          pushable: true,
        });
        if (!didUpdate) {
          setDialogError("Theme not saved. Please try again.");
          resolve("prevent-close");
          return;
        }
        setDialogOpen(false);
        resolve();
      }, {
        onError: (error) => {
          setDialogError(getErrorMessage(error));
          resolve("prevent-close");
        },
      });
    });
  };

  const handleOpenDialog = () => {
    setDialogSelectedThemeId(activeTheme);
    setDialogError(null);
    setDialogOpen(true);
  };

  const selectedThemeData = themes.find(t => t.id === activeTheme) ?? throwErr(`Unknown theme ${activeTheme}`, { activeTheme });

  return (
    <AppEnabledGuard appId="emails">
      <PageLayout
        title="Email Themes"
        description="Customize email themes for your project"
        actions={<NewThemeButton />}
      >
        <div className="flex flex-col gap-5">
          {/* Active Theme Card */}
          <DesignAnalyticsCard chart={{ type: "none", tooltipType: "none", highlightMode: "none" }}>
            <div className="p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <SectionHeader icon={Palette} title="Active Theme" />
                  <span className="text-sm text-muted-foreground">
                    Currently using <span className="font-medium text-foreground">{selectedThemeData.displayName}</span>
                  </span>
                </div>
              </div>
              <ActionDialog
                trigger={
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 px-3 text-xs gap-1.5"
                    onClick={handleOpenDialog}
                  >
                    Change Theme
                  </Button>
                }
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                title="Select Email Theme"
                cancelButton
                okButton={{
                  label: "Save Theme",
                  onClick: handleSaveTheme
                }}
              >
                <div className="grid sm:grid-cols-2 gap-4">
                  {themes.map((theme) => (
                    <ThemeOption
                      key={theme.id}
                      theme={theme}
                      isSelected={dialogSelectedThemeId === theme.id}
                      onSelect={handleThemeSelect}
                      dialogSelectedThemeId={dialogSelectedThemeId}
                      onDialogThemeDeleted={(deletedThemeId) => {
                        if (deletedThemeId === dialogSelectedThemeId) {
                          setDialogSelectedThemeId(DEFAULT_EMAIL_THEME_ID);
                        }
                      }}
                    />
                  ))}
                </div>
                {dialogError && (
                  <div className="mt-4">
                    <Alert variant="destructive">
                      <AlertTitle>Theme not saved</AlertTitle>
                      <AlertDescription>{dialogError}</AlertDescription>
                    </Alert>
                  </div>
                )}
              </ActionDialog>
            </div>
          </DesignAnalyticsCard>

          {/* Device Preview Card */}
          <DesignAnalyticsCard className="overflow-hidden" chart={{ type: "none", tooltipType: "none", highlightMode: "none" }}>
            {/* Header with viewport selector */}
            <div className="p-5 flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="p-1.5 rounded-lg bg-foreground/[0.06] dark:bg-foreground/[0.04]">
                  <Monitor className="h-3.5 w-3.5 text-foreground/70 dark:text-muted-foreground" />
                </div>
                <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
                  Preview
                </span>
                <span className="text-[11px] text-muted-foreground font-mono tabular-nums bg-foreground/[0.04] px-2 py-1 rounded">
                  {selectedViewport.width} × {selectedViewport.height}
                </span>
              </div>
              {showViewportSelector && (
                <ViewportSelector
                  selectedViewport={selectedViewport}
                  onSelect={setSelectedViewport}
                />
              )}
            </div>

            {/* Device Preview Area */}
            <div
              ref={containerRef}
              className={cn(
                "p-8 min-h-[650px] flex items-start justify-center overflow-auto",
                "bg-gradient-to-b from-foreground/[0.02] to-foreground/[0.04]"
              )}
            >
              <EmailPreview
                themeId={selectedThemeData.id}
                templateTsxSource={previewTemplateSource}
                viewport={selectedViewport}
                emailSubject="Verify your email address"
                senderName={project.displayName}
                senderEmail={`noreply@${project.displayName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`}
              />
            </div>
          </DesignAnalyticsCard>
        </div>
      </PageLayout>
    </AppEnabledGuard>
  );
}

function ThemeOption({
  theme,
  isSelected,
  onSelect,
  dialogSelectedThemeId,
  onDialogThemeDeleted,
}: {
  theme: { id: string, displayName: string },
  isSelected: boolean,
  onSelect: (themeId: string) => void,
  dialogSelectedThemeId: string,
  onDialogThemeDeleted: (deletedThemeId: string) => void,
}) {
  const hexclaveAdminApp = useAdminApp();
  const projectId = useProjectId();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();
  const router = useRouter();
  const isDefault = Object.keys(DEFAULT_EMAIL_THEMES).includes(theme.id);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    setDeleteError(null);
    return await new Promise<"prevent-close" | void>((resolve) => {
      runAsynchronouslyWithAlert(async () => {
        // If the deleted theme is the active project theme, update project to default FIRST
        // (backend prevents deleting the active theme)
        if (config.emails.selectedThemeId === theme.id) {
          const didUpdate = await updateConfig({
            adminApp: hexclaveAdminApp,
            configUpdate: {
              'emails.selectedThemeId': DEFAULT_EMAIL_THEME_ID,
            },
            pushable: true,
          });
          if (!didUpdate) {
            resolve("prevent-close");
            return;
          }
        }

        // Now delete the theme
        await hexclaveAdminApp.deleteEmailTheme(theme.id);

        // If the deleted theme was selected in the dialog, switch to default
        onDialogThemeDeleted(theme.id);
        setDeleteError(null);
        resolve();
      }, {
        onError: (error) => {
          setDeleteError(getErrorMessage(error));
          resolve("prevent-close");
        },
      });
    });
  };

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-3 p-3 rounded-xl cursor-pointer transition-all duration-150 hover:transition-none border",
        isSelected
          ? "bg-primary/5 border-primary/50 ring-1 ring-primary/20"
          : "bg-background border-border/50 hover:border-foreground/20 hover:bg-foreground/[0.02]"
      )}
      onClick={() => onSelect(theme.id)}
    >
      <div className="relative w-full aspect-[4/3] rounded-lg overflow-hidden bg-background ring-1 ring-foreground/[0.06] group-hover:shadow-md transition-all duration-150">
        <div style={{ transform: 'scale(0.5)', transformOrigin: 'top left', width: '200%', height: '200%' }}>
          <EmailPreview themeId={theme.id} templateTsxSource={previewTemplateSource} disableResizing />
        </div>

        {!isDefault && (
          <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="secondary"
              size="sm"
              className="h-8 w-8 p-0 bg-background/80 backdrop-blur-sm hover:bg-primary hover:text-primary-foreground"
              onClick={(e) => {
                e.stopPropagation();
                router.push(urlString`/projects/${projectId}/app-configuration/emails/themes/${theme.id}`);
              }}
            >
              <PencilSimple className="h-4 w-4" />
            </Button>
            <ActionDialog
              title="Delete Theme"
              description={`Are you sure you want to delete the theme "${theme.displayName}"? This action cannot be undone.`}
              okButton={{
                label: "Delete",
                onClick: handleDelete,
                props: {
                  variant: "destructive",
                },
              }}
              cancelButton
              trigger={
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8 w-8 p-0 bg-background/80 backdrop-blur-sm hover:bg-destructive hover:text-destructive-foreground"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Trash className="h-4 w-4" />
                </Button>
              }
            >
              {deleteError && (
                <div className="mt-3">
                  <Alert variant="destructive">
                    <AlertTitle>Theme not deleted</AlertTitle>
                    <AlertDescription>{deleteError}</AlertDescription>
                  </Alert>
                </div>
              )}
            </ActionDialog>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {isSelected && <CheckIcon className="h-4 w-4 text-primary" />}
        <Typography variant="secondary" className="truncate">{theme.displayName}</Typography>
      </div>
    </div>
  );
}

function NewThemeButton() {
  const hexclaveAdminApp = useAdminApp();
  const projectId = useProjectId();
  const router = useRouter();

  const handleCreateNewTheme = async (values: { name: string }) => {
    const { id } = await hexclaveAdminApp.createEmailTheme(values.name);
    router.push(urlString`/projects/${projectId}/app-configuration/emails/themes/${id}`);
  };

  return (
    <FormDialog
      title="New Theme"
      trigger={
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          New Theme
        </Button>
      }
      onSubmit={handleCreateNewTheme}
      formSchema={yup.object({
        name: yup.string().defined(),
      })}
      render={(form) => (
        <InputField
          control={form.control}
          name="name"
          label="Theme Name"
          placeholder="Enter theme name"
          required
        />
      )}
    />
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

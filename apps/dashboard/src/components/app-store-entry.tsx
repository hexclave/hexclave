'use client';

import { AppIcon } from "@/components/app-square";
import { Badge, Button, Dialog, DialogContent, DialogTitle, ScrollArea, cn } from "@/components/ui";
import { ALL_APPS_FRONTEND, getDocumentationHref, type AppId } from "@/lib/apps-frontend";
import { ArrowRightIcon, CaretLeftIcon, CaretRightIcon, CheckIcon, LightningIcon, ShieldCheckIcon, XIcon } from "@phosphor-icons/react";
import { ALL_APPS, ALL_APP_TAGS, expandAppSoftRequirements, getParentAppId } from "@hexclave/shared/dist/apps/apps-config";
import Image from "next/image";
import { FunctionComponent, useCallback, useEffect, useRef, useState } from "react";

export function AppStoreEntry({
  appId,
  isEnabled = false,
  onEnable,
  onOpen,
  onDisable,
  titleComponent: TitleComponent = "h1",
}: {
  appId: AppId,
  isEnabled?: boolean,
  onEnable: () => Promise<void>,
  onOpen?: () => void,
  onDisable?: () => Promise<void>,
  titleComponent?: FunctionComponent<any> | string,
}) {
  const app = ALL_APPS[appId];
  const appFrontend = ALL_APPS_FRONTEND[appId];
  const isDocumentationBackedApp = getDocumentationHref(appFrontend) != null;
  const parentAppId = getParentAppId(appId);
  const parentApp = parentAppId == null ? null : ALL_APPS[parentAppId];
  const softRequirementNames = [...expandAppSoftRequirements([appId])]
    .filter((requirementId) => requirementId !== appId)
    .map((requirementId) => ALL_APPS[requirementId].displayName);
  const screenshotContainerRef = useRef<HTMLDivElement>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const scrollScreenshots = (direction: 'left' | 'right') => {
    if (screenshotContainerRef.current) {
      const scrollAmount = 300; // scroll by ~1 screenshot width
      const currentScroll = screenshotContainerRef.current.scrollLeft;
      screenshotContainerRef.current.scrollTo({
        left: direction === 'left' ? currentScroll - scrollAmount : currentScroll + scrollAmount,
        behavior: 'smooth'
      });
    }
  };

  const navigatePreview = useCallback((direction: 'prev' | 'next') => {
    if (previewIndex === null) return;
    const newIndex = direction === 'prev'
      ? Math.max(0, previewIndex - 1)
      : Math.min(appFrontend.screenshots.length - 1, previewIndex + 1);
    setPreviewIndex(newIndex);
  }, [previewIndex, appFrontend.screenshots.length]);

  // Keyboard navigation for preview
  useEffect(() => {
    if (previewIndex === null) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigatePreview('prev');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigatePreview('next');
      } else if (e.key === 'Escape') {
        setPreviewIndex(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewIndex, navigatePreview]);

  // Feature highlights (can be customized per app in the future)
  const features = [
    { icon: ShieldCheckIcon, label: "Secure & Compliant" },
    { icon: LightningIcon, label: "Quick Setup" },
    { icon: CheckIcon, label: "Production Ready" },
  ];

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-950">
        {/* Hero Section */}
        <div className="relative px-6 py-8 border-b border-gray-200 dark:border-gray-800">
          <div className="max-w-4xl mx-auto">
            <div className="flex flex-col md:flex-row gap-6 items-start">
              {/* App Icon */}
              <div className="flex-shrink-0">
                <AppIcon
                  appId={appId}
                  className="shadow-xl ring-1 ring-black/5 dark:ring-white/10"
                />
              </div>

              {/* App Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-start gap-2 mb-2">
                  <TitleComponent className="text-3xl font-semibold text-gray-900 dark:text-gray-100">
                    {app.displayName}
                  </TitleComponent>
                  {app.stage !== "stable" && (
                    <Badge
                      variant={app.stage === "alpha" ? "destructive" : "secondary"}
                      className="text-xs px-2 py-0.5"
                    >
                      {app.stage === "alpha" ? "Alpha" : "Beta"}
                    </Badge>
                  )}
                </div>

                <p className="text-lg text-gray-600 dark:text-gray-400 mb-4">
                  {app.subtitle}
                </p>

                {/* Tags */}
                <div className="flex flex-wrap gap-2 mb-6">
                  {(app.tags as Array<keyof typeof ALL_APP_TAGS>).map((tag) => (
                    <div
                      key={tag}
                      className={cn(
                      "px-3 py-1 rounded-full text-xs font-medium",
                      tag === "expert"
                        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                        : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                    )}
                    >
                      {ALL_APP_TAGS[tag].displayName}
                    </div>
                  ))}
                </div>

                {/* Features Grid */}
                <div className="grid grid-cols-3 gap-3 mb-6">
                  {features.map((feature, index) => (
                    <div
                      key={index}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800"
                    >
                      <feature.icon className="w-4 h-4 text-blue-500" />
                      <span className="text-xs text-gray-600 dark:text-gray-400 text-center">
                        {feature.label}
                      </span>
                    </div>
                  ))}
                </div>

                {/* CTA Button */}
                <div className="flex flex-col items-start gap-2">
                  <div className={cn("flex gap-4", parentApp == null ? "items-center" : "flex-col items-start")}>
                    {parentApp == null ? (
                      isEnabled ? (
                        <>
                          <Button
                            onClick={onOpen}
                            size="lg"
                            className="px-8 bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white font-medium shadow-lg shadow-blue-500/20"
                          >
                            <ArrowRightIcon className="w-4 h-4 mr-2" />
                            {isDocumentationBackedApp ? "Open Docs" : "Open App"}
                          </Button>
                          {onDisable && (
                            <Button
                              onClick={onDisable}
                              variant="ghost"
                              size="lg"
                              className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300"
                            >
                              Disable
                            </Button>
                          )}
                        </>
                      ) : (
                        <Button
                          onClick={onEnable}
                          size="lg"
                          className="px-8 bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white font-medium shadow-lg shadow-blue-500/20"
                        >
                          Enable App
                        </Button>
                      )
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground">
                          This app is part of the {parentApp.displayName} app.
                        </p>
                        <Button
                          onClick={onOpen}
                          size="lg"
                          className="px-8 bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white font-medium shadow-lg shadow-blue-500/20"
                        >
                          <ArrowRightIcon className="w-4 h-4 mr-2" />
                          Go to {parentApp.displayName}
                        </Button>
                      </>
                    )}
                  </div>
                  {!isEnabled && parentApp == null && softRequirementNames.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Also enables the recommended {softRequirementNames.join(", ")} {softRequirementNames.length === 1 ? "app" : "apps"}.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Stage Warning */}
          {app.stage !== "stable" && (
            <div className="max-w-4xl mx-auto mt-6">
              <div
                className={cn(
                "p-4 rounded-xl border-l-4",
                app.stage === "alpha"
                  ? "bg-red-50 dark:bg-red-950/20 border-red-500 dark:border-red-600"
                  : "bg-amber-50 dark:bg-amber-950/20 border-amber-500 dark:border-amber-600"
              )}
              >
                <p
                  className={cn(
                  "text-sm font-medium",
                  app.stage === "alpha"
                    ? "text-red-800 dark:text-red-300"
                    : "text-amber-800 dark:text-amber-300"
                )}
                >
                  {app.stage === "alpha" && (
                    <>
                      <strong>Alpha Release:</strong> This app is in early development and may have bugs or unexpected behavior. Use with caution in production environments.
                    </>
                  )}
                  {app.stage === "beta" && (
                    <>
                      <strong>Beta Release:</strong> This app is being actively tested. You may encounter some issues, but it is generally stable for production use.
                    </>
                  )}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Screenshots Section */}
        {appFrontend.screenshots.length > 0 && (
          <div className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
            <div className="max-w-4xl mx-auto px-6 py-8">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Preview
              </h2>
              <div className="relative group/screenshots">
                {/* Left scroll button */}
                <button
                  onClick={() => scrollScreenshots('left')}
                  className="absolute left-0 top-1/2 -translate-y-1/2 z-10 bg-white/90 dark:bg-gray-900/90 hover:bg-white dark:hover:bg-gray-800 p-2 rounded-full shadow-lg border border-gray-200 dark:border-gray-700 opacity-0 group-hover/screenshots:opacity-100 transition-opacity focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  aria-label="Scroll left"
                >
                  <CaretLeftIcon className="w-5 h-5 text-gray-700 dark:text-gray-300" />
                </button>

                {/* Right scroll button */}
                <button
                  onClick={() => scrollScreenshots('right')}
                  className="absolute right-0 top-1/2 -translate-y-1/2 z-10 bg-white/90 dark:bg-gray-900/90 hover:bg-white dark:hover:bg-gray-800 p-2 rounded-full shadow-lg border border-gray-200 dark:border-gray-700 opacity-0 group-hover/screenshots:opacity-100 transition-opacity focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  aria-label="Scroll right"
                >
                  <CaretRightIcon className="w-5 h-5 text-gray-700 dark:text-gray-300" />
                </button>

                <div
                  ref={screenshotContainerRef}
                  className="flex gap-4 pb-4 overflow-x-auto scrollbar-hide scroll-smooth"
                  style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                >
                  {appFrontend.screenshots.map((screenshot: string, index: number) => (
                    <button
                      key={index}
                      onClick={() => setPreviewIndex(index)}
                      className="relative h-64 w-96 rounded-xl shadow-lg flex-shrink-0 overflow-hidden border border-gray-200 dark:border-gray-800 cursor-pointer hover:ring-2 hover:ring-blue-500/50 transition-shadow focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <Image
                        src={screenshot}
                        alt={`${app.displayName} screenshot ${index + 1}`}
                        fill
                        className="object-cover select-none"
                        draggable={false}
                      />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Description Section */}
        <div className="max-w-4xl mx-auto px-6 py-8">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            About This App
          </h2>
          <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-gray-900 dark:prose-headings:text-gray-100 prose-p:text-gray-600 dark:prose-p:text-gray-400">
            {appFrontend.storeDescription}
          </div>
        </div>

        {/* Screenshot Preview Modal */}
        <Dialog open={previewIndex !== null} onOpenChange={(open) => !open && setPreviewIndex(null)}>
          <DialogContent className="max-w-7xl max-h-[95vh] p-0 bg-black/95 border-0" noCloseButton>
            <DialogTitle className="sr-only">
              {previewIndex !== null
                ? `${app.displayName} screenshot ${previewIndex + 1} of ${appFrontend.screenshots.length}`
                : 'Screenshot preview'}
            </DialogTitle>
            <div className="relative w-full h-full flex items-center justify-center p-4">
              {previewIndex !== null && (
                <>
                  {/* Close button */}
                  <button
                    onClick={() => setPreviewIndex(null)}
                    className="absolute top-4 right-4 z-50 bg-white/10 hover:bg-white/20 p-2 rounded-full transition-colors"
                    aria-label="Close preview"
                  >
                    <XIcon className="w-6 h-6 text-white" />
                  </button>

                  {/* Image counter */}
                  <div className="absolute top-4 left-4 z-50 bg-white/10 px-3 py-1 rounded-full text-white text-sm">
                    {previewIndex + 1} / {appFrontend.screenshots.length}
                  </div>

                  {/* Previous button */}
                  {previewIndex > 0 && (
                    <button
                      onClick={() => navigatePreview('prev')}
                      className="absolute left-4 top-1/2 -translate-y-1/2 z-50 bg-white/10 hover:bg-white/20 p-3 rounded-full transition-colors"
                      aria-label="Previous screenshot"
                    >
                      <CaretLeftIcon className="w-8 h-8 text-white" />
                    </button>
                  )}

                  {/* Next button */}
                  {previewIndex < appFrontend.screenshots.length - 1 && (
                    <button
                      onClick={() => navigatePreview('next')}
                      className="absolute right-4 top-1/2 -translate-y-1/2 z-50 bg-white/10 hover:bg-white/20 p-3 rounded-full transition-colors"
                      aria-label="Next screenshot"
                    >
                      <CaretRightIcon className="w-8 h-8 text-white" />
                    </button>
                  )}

                  {/* Image */}
                  <div className="relative w-full h-[85vh] flex items-center justify-center">
                    <Image
                      src={appFrontend.screenshots[previewIndex]}
                      alt={`${app.displayName} screenshot ${previewIndex + 1}`}
                      fill
                      className="object-contain"
                      sizes="100vw"
                    />
                  </div>
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  );
}

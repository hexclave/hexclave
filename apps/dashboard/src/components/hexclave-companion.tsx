'use client';

import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { ChangelogEntry } from '@/lib/changelog';
import { getPublicEnvVar } from '@/lib/env';
import { cn } from '@/lib/utils';
import { checkVersion, VersionCheckResult } from '@/lib/version-check';
import { BookOpenIcon, ClockClockwiseIcon, LightbulbIcon, QuestionIcon, SparkleIcon, XIcon } from '@phosphor-icons/react';
import { runAsynchronously } from '@hexclave/shared/dist/utils/promises';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import packageJson from '../../package.json';
import { FeedbackForm } from './feedback-form';
import { AIChatWidget } from './hexclave-companion/ai-chat-widget';
import { ChangelogWidget } from './hexclave-companion/changelog-widget';
import { FeatureRequestBoard } from './hexclave-companion/feature-request-board';
import { UnifiedDocsWidget } from './hexclave-companion/unified-docs-widget';

/**
 * Compare two US date versions in M/D/YY format
 * Returns true if version1 is newer than version2
 */
function isNewerVersion(version1: string, version2: string): boolean {
  const parseUsDate = (version: string): Date | null => {
    const match = version.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
    if (!match) return null;
    const [, month, day, year] = match;
    const twoDigitYear = parseInt(year);
    // Sliding window: 70-99 → 1970-1999, 00-69 → 2000-2069
    const fullYear = twoDigitYear >= 70 ? 1900 + twoDigitYear : 2000 + twoDigitYear;
    return new Date(fullYear, parseInt(month) - 1, parseInt(day));
  };

  const date1 = parseUsDate(version1);
  const date2 = parseUsDate(version2);

  if (!date1 || !date2) {
    // Fallback to string comparison if parsing fails
    return version1 > version2;
  }

  return date1.getTime() > date2.getTime();
}

/**
 * Sanitize a string value for use in a cookie
 * Removes or encodes characters that could break cookie parsing
 */
function sanitizeCookieValue(value: string): string {
  // Remove or encode special characters that break cookie parsing
  return encodeURIComponent(value);
}

type SidebarItem = {
  id: string,
  label: string,
  icon: React.ElementType,
  color: string,
  hoverBg: string,
};

const sidebarItems: SidebarItem[] = [
  {
    id: 'ask-ai',
    label: 'Ask AI',
    icon: SparkleIcon,
    color: 'text-purple-600 dark:text-purple-400',
    hoverBg: 'hover:bg-purple-500/10',
  },
  {
    id: 'docs',
    label: 'Docs',
    icon: BookOpenIcon,
    color: 'text-blue-600 dark:text-blue-400',
    hoverBg: 'hover:bg-blue-500/10',
  },
  {
    id: 'feedback',
    label: 'Feature Requests',
    icon: LightbulbIcon,
    color: 'text-purple-600 dark:text-purple-400',
    hoverBg: 'hover:bg-purple-500/10',
  },
  {
    id: 'changelog',
    label: 'Changelog',
    icon: ClockClockwiseIcon,
    color: 'text-green-600 dark:text-green-400',
    hoverBg: 'hover:bg-green-500/10',
  },
  {
    id: 'support',
    label: "Support",
    icon: QuestionIcon,
    color: 'text-orange-600 dark:text-orange-400',
    hoverBg: 'hover:bg-orange-500/10',
  }
];

// Docs sidebar item stays in sidebarItems for future re-enable, but is hidden until
// UnifiedDocsWidget is wired to Mintlify docs URLs (old /docs-embed routes are gone).
const visibleSidebarItems = sidebarItems.filter((item) => item.id !== 'docs');

const MIN_DRAWER_WIDTH = 400;
const MAX_DRAWER_WIDTH = 800;
const DEFAULT_DRAWER_WIDTH = 480;
const CLOSE_THRESHOLD = 100;

// Breakpoint for split-screen mode
const SPLIT_SCREEN_BREAKPOINT = 1000;

// Context for sharing companion state with layout
type HexclaveCompanionContextType = {
  drawerWidth: number,
  isSplitScreenMode: boolean,
};

const HexclaveCompanionContext = createContext<HexclaveCompanionContextType>({
  drawerWidth: 0,
  isSplitScreenMode: false,
});

export function useHexclaveCompanion() {
  return useContext(HexclaveCompanionContext);
}


export function HexclaveCompanion({ className, glassBg = false }: { className?: string, glassBg?: boolean }) {
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [versionCheckResult, setVersionCheckResult] = useState<VersionCheckResult>(null);
  const [drawerWidth, setDrawerWidth] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isSplitScreenMode, setIsSplitScreenMode] = useState(false);
  const [changelogData, setChangelogData] = useState<ChangelogEntry[] | undefined>(undefined);
  const [hasNewVersions, setHasNewVersions] = useState(false);
  const [lastSeenVersion, setLastSeenVersion] = useState('');

  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const dragThresholdRef = useRef(false);
  const animationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const draggingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Cleanup animation timeouts on unmount
  useEffect(() => {
    return () => {
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
      }
      if (draggingTimeoutRef.current) {
        clearTimeout(draggingTimeoutRef.current);
      }
    };
  }, []);

  // Detect screen size for split-screen mode
  useEffect(() => {
    const checkScreenSize = () => {
      setIsSplitScreenMode(window.innerWidth >= SPLIT_SCREEN_BREAKPOINT);
    };

    checkScreenSize();
    window.addEventListener('resize', checkScreenSize);
    return () => window.removeEventListener('resize', checkScreenSize);
  }, []);

  useEffect(() => {
    const cleanup = checkVersion(setVersionCheckResult, {
      delay: 2000,
      silentFailure: true,
      errorPrefix: "Version check failed in companion"
    });
    return cleanup;
  }, []);

  // Fetch changelog data on mount and check for new versions
  useEffect(() => {
    runAsynchronously(async () => {
      const baseUrl = getPublicEnvVar('NEXT_PUBLIC_STACK_API_URL') || '';
      const response = await fetch(`${baseUrl}/api/latest/internal/changelog`);
      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      const entries = payload.entries || [];
      setChangelogData(entries);

      // Check for new versions
      // Hexclave rebrand: dual-read the changelog cookie, preferring the new name.
      const cookieRows = document.cookie.split('; ');
      const lastSeenRaw = (
        cookieRows.find(row => row.startsWith('hexclave-last-seen-changelog-version='))
        ?? cookieRows.find(row => row.startsWith('stack-last-seen-changelog-version='))
      )?.split('=')[1] || '';

      const lastSeen = lastSeenRaw ? decodeURIComponent(lastSeenRaw) : '';
      setLastSeenVersion(lastSeen);

      if (entries.length > 0) {
        // If no lastSeen cookie, user hasn't seen any changelog yet - show bell
        if (!lastSeen) {
          setHasNewVersions(true);
        } else {
          const hasNewer = entries.some((entry: ChangelogEntry) => {
            if (entry.isUnreleased) return false;
            return isNewerVersion(entry.version, lastSeen);
          });
          setHasNewVersions(hasNewer);
        }
      }
    });
  }, []);

  // Re-check for new versions when changelog is opened/closed
  useEffect(() => {
    if (activeItem === 'changelog') {
      // When changelog is opened, mark the latest released version as seen
      // Skip unreleased versions to avoid breaking version comparison
      if (changelogData && changelogData.length > 0) {
        const latestReleasedEntry = changelogData.find(entry => !entry.isUnreleased);
        if (latestReleasedEntry) {
          // Hexclave rebrand: dual-write the changelog cookie under both names. 1 year max-age.
          const sanitizedVersion = sanitizeCookieValue(latestReleasedEntry.version);
          document.cookie = `hexclave-last-seen-changelog-version=${sanitizedVersion}; path=/; max-age=31536000`;
          document.cookie = `stack-last-seen-changelog-version=${sanitizedVersion}; path=/; max-age=31536000`;
          setLastSeenVersion(latestReleasedEntry.version);
        }
      }
      // Clear the notification badge immediately
      setHasNewVersions(false);
    } else if (activeItem === null) {
      // When closed, re-check if there are new versions
      // Hexclave rebrand: dual-read the changelog cookie, preferring the new name.
      const cookieRows = document.cookie.split('; ');
      const lastSeenRaw = (
        cookieRows.find(row => row.startsWith('hexclave-last-seen-changelog-version='))
        ?? cookieRows.find(row => row.startsWith('stack-last-seen-changelog-version='))
      )?.split('=')[1] || '';

      const lastSeen = lastSeenRaw ? decodeURIComponent(lastSeenRaw) : '';

      if (changelogData && changelogData.length > 0) {
        // If no lastSeen cookie, user hasn't seen any changelog yet - show bell
        if (!lastSeen) {
          setHasNewVersions(true);
        } else {
          const hasNewer = changelogData.some((entry: ChangelogEntry) => {
            if (entry.isUnreleased) return false;
            return isNewerVersion(entry.version, lastSeen);
          });
          setHasNewVersions(hasNewer);
        }
      } else {
        setHasNewVersions(false);
      }
    }
  }, [activeItem, changelogData]);


  const openDrawer = useCallback((itemId: string) => {
    setActiveItem(itemId);
    setIsAnimating(true);
    // Start animation
    requestAnimationFrame(() => {
      setDrawerWidth(DEFAULT_DRAWER_WIDTH);
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
      }
      animationTimeoutRef.current = setTimeout(() => setIsAnimating(false), 300);
    });
  }, []);

  const closeDrawer = useCallback(() => {
    setIsAnimating(true);
    setDrawerWidth(0);
    if (animationTimeoutRef.current) {
      clearTimeout(animationTimeoutRef.current);
    }
    animationTimeoutRef.current = setTimeout(() => {
      setActiveItem(null);
      setIsAnimating(false);
    }, 300);
  }, []);

  // Handle click vs drag
  const handleItemClick = useCallback((itemId: string) => {
    if (dragThresholdRef.current) return; // Ignore clicks if we were dragging

    if (activeItem === itemId) {
      closeDrawer();
    } else if (activeItem) {
      setActiveItem(itemId);
    } else {
      openDrawer(itemId);
    }
  }, [activeItem, closeDrawer, openDrawer]);

  const handleMouseDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    // Don't initiate drag if clicking resizing handle or scrollbar
    if ((e.target as HTMLElement).closest('.no-drag')) return;

    // Only allow dragging when an item is already selected (drawer is open)
    if (!activeItem) return;

    setIsResizing(true);
    setIsAnimating(false);
    dragThresholdRef.current = false;

    startXRef.current = 'touches' in e ? e.touches[0].clientX : e.clientX;
    startWidthRef.current = drawerWidth;
  }, [drawerWidth, activeItem]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const deltaX = startXRef.current - clientX;

      // Check for drag threshold to distinguish click vs drag
      if (Math.abs(deltaX) > 5) {
        dragThresholdRef.current = true;
        setIsDragging(true);
      }

      // Logic:
      // - Moving left (positive deltaX) -> Width increases
      // - Moving right (negative deltaX) -> Width decreases
      // But only if we are starting from right edge.
      // Since flex-row-reverse anchors to right, increasing width moves the handle left.

      let newWidth = startWidthRef.current + deltaX;
      newWidth = Math.max(0, Math.min(MAX_DRAWER_WIDTH, newWidth));

      setDrawerWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      if (draggingTimeoutRef.current) {
        clearTimeout(draggingTimeoutRef.current);
      }
      draggingTimeoutRef.current = setTimeout(() => setIsDragging(false), 0);

      if (dragThresholdRef.current) {
        // If we dragged, snap to state
        if (drawerWidth < CLOSE_THRESHOLD) {
          closeDrawer();
        } else if (drawerWidth < MIN_DRAWER_WIDTH) {
          setIsAnimating(true);
          setDrawerWidth(MIN_DRAWER_WIDTH);
          if (animationTimeoutRef.current) {
            clearTimeout(animationTimeoutRef.current);
          }
          animationTimeoutRef.current = setTimeout(() => setIsAnimating(false), 200);
        } else {
          // Keep current width but ensure item is active
          if (!activeItem) {
             setActiveItem('ask-ai');
          }
        }
      } else {
        // If it was just a click (no drag), handleItemClick will trigger
      }
      dragThresholdRef.current = false;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleMouseMove);
    document.addEventListener('touchend', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleMouseMove);
      document.removeEventListener('touchend', handleMouseUp);
    };
  }, [isResizing, drawerWidth, closeDrawer, activeItem]);

  // Disable text selection during drag
  useEffect(() => {
    if (isDragging) {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
    } else {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isDragging]);

  if (!mounted) return null;

  const isOpen = drawerWidth > 0;
  const currentItem = sidebarItems.find(i => i.id === activeItem);

  // Calculate content opacity for smooth fade-out as width approaches close threshold
  const contentOpacity = Math.min(1, Math.max(0, (drawerWidth - CLOSE_THRESHOLD) / (MIN_DRAWER_WIDTH - CLOSE_THRESHOLD)));

  // Shared drawer content component
  const drawerContent = isOpen && activeItem && (
    <div
      className="flex flex-col h-full w-full min-w-[360px] transition-opacity duration-150"
      style={{ opacity: contentOpacity }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06] dark:border-foreground/[0.06] shrink-0 bg-white dark:bg-background/40">
        <div className="flex items-center gap-2.5">
          {currentItem && (
            <>
              <div className={cn("p-1.5 rounded-lg bg-foreground/[0.04]")}>
                <currentItem.icon className={cn("h-4 w-4", currentItem.color)} />
              </div>
              <span className="font-semibold text-foreground">
                {currentItem.label}
              </span>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] rounded-lg no-drag"
          onClick={closeDrawer}
        >
          <XIcon className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className={cn(
        "flex-1 overflow-x-hidden no-drag cursor-auto",
        activeItem === 'ask-ai' ? "overflow-hidden p-0 flex flex-col" : "overflow-y-auto p-5"
      )}>
        {activeItem === 'ask-ai' && <AIChatWidget />}
        {activeItem === 'docs' && <UnifiedDocsWidget isActive={true} />}
        {activeItem === 'feedback' && <FeatureRequestBoard isActive={true} />}
        {activeItem === 'changelog' && <ChangelogWidget isActive={true} initialData={changelogData} />}
        {activeItem === 'support' && <FeedbackForm />}
      </div>
    </div>
  );

  // Shared handle component
  const handleComponent = (
    <div
      className={cn(
        "flex items-center shrink-0 z-10",
        isOpen ? "h-full -mr-px" : "h-auto",
        !isSplitScreenMode && "pointer-events-auto"
      )}
      onMouseDown={handleMouseDown}
      onTouchStart={handleMouseDown}
    >
      {/* The Handle Pill */}
      <div className={cn(
        "flex flex-col items-center gap-3 px-2 py-3 border border-black/[0.06] dark:border-foreground/5 shadow-md transition-all duration-300 select-none",
        glassBg
          ? "bg-slate-50/90 dark:bg-background/40 backdrop-blur-xl"
          : "bg-white dark:bg-foreground/[0.03] dark:backdrop-blur-xl",
        // Only show grab cursor when an item is selected (drawer can be resized)
        activeItem && "cursor-grab active:cursor-grabbing",
        // Shape morphing
        isOpen ? "rounded-l-2xl rounded-r-none border-r-0 translate-x-px" : "rounded-full mr-3"
      )}>
        {visibleSidebarItems.map(item => (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-10 w-10 p-0 text-muted-foreground transition-all [transition-duration:50ms] rounded-xl relative group",
                  item.hoverBg,
                  activeItem === item.id && "bg-foreground/10 text-foreground shadow-sm ring-1 ring-foreground/5",
                  // Glow effect for changelog with new updates
                  item.id === 'changelog' && hasNewVersions && "ring-2 ring-green-500/30 bg-green-500/10"
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  handleItemClick(item.id);
                }}
              >
                <item.icon className={cn("h-5 w-5 transition-transform [transition-duration:50ms] group-hover:scale-110", item.color)} />
                {item.id === 'changelog' && hasNewVersions && (
                  <span className="absolute -top-1 -right-1 flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="z-[60] mr-2">
              {item.id === 'changelog' && hasNewVersions ? `${item.label} (New updates available!)` : item.label}
            </TooltipContent>
          </Tooltip>
        ))}

        {versionCheckResult && (
          <div className={cn(
            "mt-auto pt-2 px-2 py-1 text-[10px] rounded-full font-mono font-medium opacity-60 hover:opacity-100 transition-opacity",
            versionCheckResult.severe ? "text-red-500" : "text-orange-500"
          )}>
            v{packageJson.version}
          </div>
        )}
      </div>
    </div>
  );

  const contextValue = { drawerWidth, isSplitScreenMode };

  // Split-screen mode: inline layout that pushes content
  // Only show drawer container when open or animating (to allow close animation)
  const showDrawerContainerSplit = isOpen || isAnimating;

  if (isSplitScreenMode) {
    return (
      <HexclaveCompanionContext.Provider value={contextValue}>
        <aside
          className={cn(
            "sticky top-14 h-[calc(100vh-3.5rem)] dark:top-20 dark:h-[calc(100vh-6rem)] mr-3 flex flex-row-reverse items-stretch shrink-0",
            isAnimating && !isResizing && "transition-[width] duration-300 ease-out",
            className
          )}
          style={{ width: drawerWidth > 0 ? drawerWidth + 56 : 56 }} // 56px for handle width
        >
          {/* Drawer Content */}
          {showDrawerContainerSplit && (
            <div
              className={cn(
                "h-full border border-black/[0.06] dark:border-foreground/5 overflow-hidden relative rounded-2xl shadow-md",
                glassBg
                  ? "bg-slate-50/90 dark:bg-background/40 backdrop-blur-xl"
                  : "bg-white dark:bg-foreground/5 dark:backdrop-blur-xl",
                isAnimating && !isResizing && "transition-[width] duration-300 ease-out"
              )}
              style={{ width: drawerWidth }}
            >
              <div className="absolute inset-y-0 left-0 w-px bg-gradient-to-b from-transparent via-foreground/10 to-transparent opacity-50" />
              {drawerContent}
            </div>
          )}

          {/* Handle */}
          {handleComponent}
        </aside>
      </HexclaveCompanionContext.Provider>
    );
  }

  // Overlay mode: fixed position sliding drawer (default for smaller screens)
  // Only show drawer container when open or animating (to allow close animation)
  const showDrawerContainer = isOpen || isAnimating;

  return (
    <HexclaveCompanionContext.Provider value={contextValue}>
      {/* Main Container - Fixed Right Edge, Flex Reverse to push handle left */}
      <div className={cn("fixed inset-y-0 right-0 z-50 flex flex-row-reverse items-center pointer-events-none", className)}>

        {/* 1. Drawer Content (Rightmost in layout, stays anchored to right) */}
        {showDrawerContainer && (
          <div
            className={cn(
              "h-full overflow-hidden pointer-events-auto relative bg-white dark:bg-background/80 dark:backdrop-blur-xl border-l border-black/[0.06] dark:border-foreground/[0.08] shadow-2xl",
              isAnimating && !isResizing && "transition-[width] duration-300 ease-out"
            )}
            style={{ width: drawerWidth }}
          >
            {/* Inner shadow/gradient for depth */}
            <div className="absolute inset-y-0 left-0 w-px bg-gradient-to-b from-transparent via-foreground/10 to-transparent opacity-50" />
            {drawerContent}
          </div>
        )}

        {/* 2. Stack Companion Handle (Left of Drawer) */}
        {handleComponent}
      </div>
    </HexclaveCompanionContext.Provider>
  );
}

'use client';

import { WarningCircle } from '@phosphor-icons/react';
import { throwErr } from '@hexclave/shared/dist/utils/errors';
// eslint-disable-next-line no-restricted-imports
import { useRouter as useNextRouter } from 'next/navigation';
import React from 'react';
import { ActionDialog, Alert, AlertDescription, AlertTitle } from './ui';

const routerContext = React.createContext<null | {
  setNeedConfirm: (needConfirm: boolean) => void,
  readonly needConfirm: boolean,
  showNavigationDialog: (onConfirm: () => void) => void,
}>(null);

export const confirmAlertMessage = "Are you sure you want to leave this page? Changes you made may not be saved.";

export function useRouter() {
  const router = useNextRouter();
  const context = useRouterConfirm();

  return {
    push: (...args: Parameters<typeof router.push>) => {
      if (context.needConfirm) {
        context.showNavigationDialog(() => router.push(...args));
        return;
      }
      router.push(...args);
    },
    replace: (...args: Parameters<typeof router.replace>) => {
      if (context.needConfirm) {
        context.showNavigationDialog(() => router.replace(...args));
        return;
      }
      router.replace(...args);
    },
    back: () => {
      if (context.needConfirm) {
        context.showNavigationDialog(() => router.back());
        return;
      }
      router.back();
    },
  };
}

export function useRouterConfirm() {
  return React.useContext(routerContext) ?? throwErr("RouterProvider not found, please wrap your app in it.");
}

export function RouterProvider(props: {  children: React.ReactNode }) {
  const [needConfirm, setNeedConfirmState] = React.useState(false);
  const needConfirmRef = React.useRef(needConfirm);
  const [showDialog, setShowDialog] = React.useState(false);
  const [pendingNavigation, setPendingNavigation] = React.useState<(() => void) | null>(null);

  const setNeedConfirm = React.useCallback((value: boolean) => {
    needConfirmRef.current = value;
    setNeedConfirmState(value);
  }, []);

  // Handle browser navigation events (back button, closing tab, etc.)
  React.useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (needConfirmRef.current) {
        e.preventDefault();
        // Modern browsers require returnValue to be set
        e.returnValue = confirmAlertMessage;
        return confirmAlertMessage;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const showNavigationDialog = React.useCallback((onConfirm: () => void) => {
    setPendingNavigation(() => onConfirm);
    setShowDialog(true);
  }, []);

  const handleConfirm = React.useCallback(async () => {
    setShowDialog(false);
    setNeedConfirm(false);
    if (pendingNavigation) {
      pendingNavigation();
      setPendingNavigation(null);
    }
  }, [pendingNavigation, setNeedConfirm]);

  const handleCancel = React.useCallback(() => {
    setShowDialog(false);
    setPendingNavigation(null);
  }, []);

  return (
    <routerContext.Provider value={{ needConfirm, setNeedConfirm, showNavigationDialog }}>
      {props.children}

      {/* Navigation Confirmation Dialog */}
      <ActionDialog
        open={showDialog}
        onClose={handleCancel}
        title="Leave Page?"
        okButton={{
          label: "Leave",
          onClick: handleConfirm,
          props: {
            variant: "destructive"
          }
        }}
        cancelButton={{ label: "Stay" }}
      >
        <Alert className="bg-orange-500/5 border-orange-500/20">
          <WarningCircle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
          <AlertTitle className="text-orange-600 dark:text-orange-400 font-semibold">
            Unsaved Changes
          </AlertTitle>
          <AlertDescription className="text-muted-foreground">
            You have unsaved changes. Are you sure you want to leave this page? Changes you made may not be saved.
          </AlertDescription>
        </Alert>
      </ActionDialog>
    </routerContext.Provider>
  );
}

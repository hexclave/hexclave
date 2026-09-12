"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignDialog,
  DesignInput,
  DesignSelectorDropdown,
} from "@/components/design-components";
import { toast } from "@/components/ui";
import {
  approveTvDisplayOrThrow,
  fetchTvDisplaysOrThrow,
  unpairTvDisplayOrThrow,
  TvProfileRequestError,
  updateTvDisplayOrThrow,
} from "@/lib/hexclave-app-internals";
import {
  TV_DISPLAY_PAIRING_CODE_PATTERN,
  type TvDisplayResource,
  type TvProfileResource,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { BroadcastIcon, LinkBreakIcon, MonitorIcon, PlusIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

const DISPLAY_REFRESH_INTERVAL_MS = 5_000;

type ActionNotice = {
  variant: "success" | "error" | "info",
  title: string,
  description: string,
};

function errorIncludes(error: unknown, text: string): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some((nestedError: unknown) => errorIncludes(nestedError, text));
  }
  return error instanceof Error && error.message.includes(text);
}

export function getPairingFailureNotice(error: unknown): ActionNotice {
  if (
    errorIncludes(error, "Rate limited")
    || errorIncludes(error, "tv_display_pairing_rate_limited")
    || (error instanceof TvProfileRequestError && error.status === 429)
  ) {
    return {
      variant: "error",
      title: "Pairing Temporarily Paused",
      description: "Too many pairing attempts were received. Wait a few minutes, then use the latest code shown on the display.",
    };
  }
  if (error instanceof TvProfileRequestError && error.status === 428) {
    return {
      variant: "error",
      title: "Profile Privacy Changed",
      description: "This profile now shows exact financial values. Reload the Displays page, review the privacy notice, and approve pairing again.",
    };
  }
  if (
    errorIncludes(error, "tv_display_pairing_code_invalid")
    || (error instanceof TvProfileRequestError && error.status === 400)
  ) {
    return {
      variant: "error",
      title: "Pairing Code Wasn’t Accepted",
      description: "Enter the latest code shown on the display. Pairing codes expire after 10 minutes and can only be used once.",
    };
  }
  if (errorIncludes(error, "tv_display_profile_not_found") || (error instanceof TvProfileRequestError && error.status === 404)) {
    return {
      variant: "error",
      title: "Profile Is No Longer Available",
      description: "Choose another TV profile, then try pairing the display again.",
    };
  }
  return {
    variant: "error",
    title: "Display Couldn’t Be Paired",
    description: "The pairing request couldn’t be completed. Check the connection and try again with the latest display code.",
  };
}

function getManagementFailureNotice(action: "save" | "unpair"): ActionNotice {
  return action === "save"
    ? {
      variant: "error",
      title: "Assignment Couldn’t Be Saved",
      description: "The current assignment is unchanged. Check the selected profile and try again.",
    }
    : {
      variant: "error",
      title: "Display Couldn’t Be Unpaired",
      description: "The display remains connected. Check the connection and try again.",
    };
}

function stateLabel(state: TvDisplayResource["state"]): string {
  if (state === "never-connected") return "Waiting for Display";
  return state[0].toUpperCase() + state.slice(1);
}

export function TvDisplayManagement({
  adminApp,
  profiles,
  defaultProfileId = "company-pulse",
}: {
  adminApp: object,
  profiles: TvProfileResource[],
  defaultProfileId?: string,
}) {
  const [displays, setDisplays] = useState<TvDisplayResource[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [displayName, setDisplayName] = useState("Office Display");
  const [profileId, setProfileId] = useState(
    profiles.some((profile) => profile.id === defaultProfileId)
      ? defaultProfileId
      : profiles[0]?.id ?? "company-pulse",
  );
  const [acknowledgeExact, setAcknowledgeExact] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pairingError, setPairingError] = useState<ActionNotice | null>(null);
  const pairingInFlight = useRef(false);
  const refreshInFlight = useRef(false);
  const hiddenDisplayIds = useRef(new Set<string>());
  const pendingPairing = useRef<{
    displayName: string,
    existingDisplayIds: Set<string>,
    approvedAt: string,
    expiresAt: string,
  } | null>(null);

  const refresh = useCallback(async () => {
    const next = await fetchTvDisplaysOrThrow(adminApp);
    const visible = next.filter((display) => !hiddenDisplayIds.current.has(display.id));
    const pending = pendingPairing.current;
    const pendingExpiresAt = pending == null ? null : Date.parse(pending.expiresAt);
    if (pending != null && (pendingExpiresAt == null || !Number.isFinite(pendingExpiresAt) || pendingExpiresAt <= new Date().getTime())) {
      pendingPairing.current = null;
    } else if (pending != null && visible.some((display) => {
      const pairedAt = Date.parse(display.pairedAt);
      return display.displayName === pending.displayName
        && !pending.existingDisplayIds.has(display.id)
        && Number.isFinite(pairedAt)
        && pairedAt >= Date.parse(pending.approvedAt)
        && pairedAt <= Date.parse(pending.expiresAt);
    })) {
      pendingPairing.current = null;
      toast({
        variant: "success",
        title: "Display Paired",
        description: `${pending.displayName} is connected and ready for TV Mode.`,
      });
    }
    setDisplays(visible);
    setLoadFailed(false);
  }, [adminApp]);

  const refreshSafely = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      await refresh();
    } catch {
      setLoadFailed(true);
    } finally {
      refreshInFlight.current = false;
    }
  }, [refresh]);

  useEffect(() => {
    runAsynchronously(refreshSafely());
    const interval = window.setInterval(() => runAsynchronously(refreshSafely()), DISPLAY_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshSafely]);

  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const normalizedPairingCode = pairingCode.replaceAll("-", "");
  const pair = async () => {
    if (pairingInFlight.current) return;
    pairingInFlight.current = true;
    setPairing(true);
    setPairingError(null);
    const nextDisplayName = displayName.trim();
    try {
      const approval = await approveTvDisplayOrThrow(adminApp, {
        pairingCode: normalizedPairingCode,
        profileId,
        displayName: nextDisplayName,
        acknowledgeExactFinancials: acknowledgeExact,
      });
      pendingPairing.current = {
        displayName: nextDisplayName,
        existingDisplayIds: new Set(displays?.map((display) => display.id) ?? []),
        approvedAt: approval.approvedAt,
        expiresAt: approval.expiresAt,
      };
      setPairingCode("");
      setAcknowledgeExact(false);
      toast({
        variant: "success",
        title: "Pairing Approved",
        description: "The display is connecting now and will appear below automatically.",
      });
      try {
        await refresh();
      } catch {
        setLoadFailed(true);
      }
    } catch (error) {
      pendingPairing.current = null;
      setPairingError(getPairingFailureNotice(error));
    } finally {
      pairingInFlight.current = false;
      setPairing(false);
    }
  };

  const hideDisplay = useCallback((displayId: string) => {
    hiddenDisplayIds.current.add(displayId);
    setDisplays((current) => current?.filter((display) => display.id !== displayId) ?? null);
  }, []);

  const profileOptions = profiles.map((profile) => ({
    value: profile.id,
    label: profile.configuration.displayName,
  }));

  return (
    <section className="space-y-5">
      {loadFailed ? <DesignAlert variant="error" title="Displays Couldn’t Be Loaded" description="Trying again automatically. Existing display assignments are unchanged." /> : null}
      <DesignCard
        title="Pair a New Display"
        subtitle="Enter the secure code shown on the TV, then choose its name and profile."
        icon={PlusIcon}
        gradient="default"
        glassmorphic
        contentClassName="!p-0"
      >
        <div className="space-y-4 p-4 sm:p-5">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <label htmlFor="new-tv-display-code" className="text-xs font-medium text-foreground">Pairing Code</label>
              <DesignInput id="new-tv-display-code" aria-label="Pairing code" value={pairingCode} onChange={(event) => setPairingCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH" size="lg" className="font-mono uppercase tracking-widest" />
            </div>
            <div className="space-y-2">
              <label htmlFor="new-tv-display-name" className="text-xs font-medium text-foreground">Display Name</label>
              <DesignInput id="new-tv-display-name" aria-label="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Office Display" maxLength={80} size="lg" />
            </div>
            <div className="space-y-2">
              <label htmlFor="new-tv-display-profile" className="text-xs font-medium text-foreground">Assigned Profile</label>
              <DesignSelectorDropdown triggerId="new-tv-display-profile" value={profileId} onValueChange={(value) => {
                setProfileId(value);
                setAcknowledgeExact(false);
              }} options={profileOptions} size="lg" />
            </div>
          </div>
          {selectedProfile?.configuration.financialVisibility === "exact" ? (
            <label className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3 text-sm text-foreground">
              <input type="checkbox" checked={acknowledgeExact} onChange={(event) => setAcknowledgeExact(event.target.checked)} className="mt-0.5" />
              <span>I understand that this physical display will show exact financial values visible to people nearby.</span>
            </label>
          ) : null}
          {pairingError == null ? null : <DesignAlert {...pairingError} glassmorphic />}
          <div className="flex justify-end border-t border-foreground/[0.07] pt-4">
            <DesignButton type="button" size="lg" loading={pairing} disabled={!TV_DISPLAY_PAIRING_CODE_PATTERN.test(normalizedPairingCode) || displayName.trim().length === 0 || (selectedProfile?.configuration.financialVisibility === "exact" && !acknowledgeExact)} onClick={pair} className="w-full gap-2 rounded-xl sm:w-auto">
              <BroadcastIcon className="h-4 w-4" weight="fill" /> Pair Display
            </DesignButton>
          </div>
        </div>
      </DesignCard>

      <DesignCard
        title="Paired Displays"
        subtitle="Manage connected screens, their names, and assigned profiles."
        icon={MonitorIcon}
        gradient="default"
        glassmorphic
        contentClassName="!p-0"
      >
        {displays == null ? (
          <p className="p-5 text-sm text-muted-foreground">
            {loadFailed ? "Displays couldn’t be loaded. Retrying automatically…" : "Loading paired displays…"}
          </p>
        ) : null}
        {displays?.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-5 py-10 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground/[0.04] ring-1 ring-foreground/[0.06]">
              <MonitorIcon className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">No Displays Paired Yet</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">Use the pairing form above when a TV is showing a secure code.</p>
          </div>
        ) : null}
        {displays == null || displays.length === 0 ? null : (
          <div className="divide-y divide-foreground/[0.07]">
            {displays.map((display) => (
              <DisplayRow
                key={`${display.id}:${display.displayName}:${display.profileId}:${display.exactFinancialsAcknowledged}`}
                adminApp={adminApp}
                display={display}
                profiles={profiles}
                onChanged={refreshSafely}
                onRemoved={hideDisplay}
              />
            ))}
          </div>
        )}
      </DesignCard>
    </section>
  );
}

function DisplayRow({ adminApp, display, profiles, onChanged, onRemoved }: {
  adminApp: object,
  display: TvDisplayResource,
  profiles: TvProfileResource[],
  onChanged: () => Promise<void>,
  onRemoved: (displayId: string) => void,
}) {
  const [name, setName] = useState(display.displayName);
  const [profileId, setProfileId] = useState(display.profileId);
  const [acknowledgeExact, setAcknowledgeExact] = useState(display.exactFinancialsAcknowledged);
  const [savedAssignment, setSavedAssignment] = useState({
    name: display.displayName,
    profileId: display.profileId,
    acknowledgeExact: display.exactFinancialsAcknowledged,
  });
  const [saveError, setSaveError] = useState<ActionNotice | null>(null);
  const [unpairOpen, setUnpairOpen] = useState(false);
  const [unpairNotice, setUnpairNotice] = useState<ActionNotice | null>(null);
  const profile = profiles.find((candidate) => candidate.id === profileId);
  const normalizedName = name.trim();
  const hasChanges = normalizedName !== savedAssignment.name
    || profileId !== savedAssignment.profileId
    || acknowledgeExact !== savedAssignment.acknowledgeExact;
  const canSave = hasChanges
    && normalizedName.length > 0
    && profile != null
    && (profile.configuration.financialVisibility !== "exact" || acknowledgeExact);
  const save = async () => {
    setSaveError(null);
    try {
      await updateTvDisplayOrThrow(adminApp, display.id, {
        displayName: normalizedName,
        profileId,
        acknowledgeExactFinancials: acknowledgeExact,
      });
      setName(normalizedName);
      setSavedAssignment({ name: normalizedName, profileId, acknowledgeExact });
      toast({
        variant: "success",
        title: "Assignment Updated",
        description: "The display will use the new name and profile on its next refresh.",
      });
      await onChanged();
    } catch {
      setSaveError(getManagementFailureNotice("save"));
    }
  };
  const unpair = async () => {
    setUnpairNotice(null);
    try {
      await unpairTvDisplayOrThrow(adminApp, display.id);
      onRemoved(display.id);
      setUnpairOpen(false);
      toast({
        variant: "success",
        title: "Display Unpaired",
        description: `${display.displayName} no longer has access to TV Mode.`,
      });
    } catch {
      setUnpairNotice(getManagementFailureNotice("unpair"));
    }
  };
  const profileOptions = [
    ...(profile == null ? [{ value: display.profileId, label: "Profile Unavailable — Choose a New Profile", disabled: true }] : []),
    ...profiles.map((candidate) => ({ value: candidate.id, label: candidate.configuration.displayName })),
  ];
  return (
    <div className="p-4 transition-colors duration-150 hover:bg-foreground/[0.02] hover:transition-none sm:p-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(190px,0.7fr)_minmax(0,1.5fr)]">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.05] text-muted-foreground ring-1 ring-foreground/[0.06]">
            <MonitorIcon className="h-5 w-5" weight="fill" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm font-semibold text-foreground">{display.displayName}</p>
              <DesignBadge label={stateLabel(display.state)} color={display.state === "online" ? "green" : "blue"} size="sm" />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{display.lastSeenAt == null ? "Not connected yet" : `Last seen ${new Date(display.lastSeenAt).toLocaleString()}`}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">Profile: {profile?.configuration.displayName ?? display.profileDisplayName}</p>
          </div>
        </div>

        <div className="min-w-0 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor={`tv-display-name-${display.id}`} className="text-xs font-medium text-foreground">Display Name</label>
              <DesignInput id={`tv-display-name-${display.id}`} aria-label={`Display name for ${display.displayName}`} value={name} onChange={(event) => {
                setName(event.target.value);
                setSaveError(null);
              }} maxLength={80} size="lg" />
            </div>
            <div className="space-y-2">
              <label htmlFor={`tv-display-profile-${display.id}`} className="text-xs font-medium text-foreground">Assigned Profile</label>
              <DesignSelectorDropdown triggerId={`tv-display-profile-${display.id}`} value={profileId} onValueChange={(value) => {
                setProfileId(value);
                setAcknowledgeExact(false);
                setSaveError(null);
              }} options={profileOptions} size="lg" />
            </div>
          </div>
          {profile?.configuration.financialVisibility === "exact" && !acknowledgeExact ? (
            <label className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3 text-sm text-foreground">
              <input type="checkbox" checked={acknowledgeExact} onChange={(event) => {
                setAcknowledgeExact(event.target.checked);
                setSaveError(null);
              }} className="mt-0.5" />
              <span>Allow this physical display to show exact financial values.</span>
            </label>
          ) : null}
          {saveError == null ? null : <DesignAlert {...saveError} glassmorphic />}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-foreground/[0.07] pt-3">
            <DesignButton type="button" size="sm" variant={hasChanges ? "default" : "secondary"} disabled={!canSave} onClick={save} className="rounded-lg">
              {hasChanges ? "Save Assignment" : "Assignment Saved"}
            </DesignButton>
            <DesignButton type="button" size="sm" variant="outline" onClick={() => setUnpairOpen(true)} className="gap-2 rounded-lg border-red-500/20 text-red-500 hover:bg-red-500/[0.06]">
              <LinkBreakIcon className="h-4 w-4" /> Unpair
            </DesignButton>
          </div>
        </div>
      </div>
      <DesignDialog
        open={unpairOpen}
        onOpenChange={setUnpairOpen}
        icon={LinkBreakIcon}
        title="Unpair Display?"
        description={`${display.displayName} will immediately lose access to TV Mode and require a new pairing code to reconnect.`}
        size="sm"
        footer={(
          <>
            <DesignButton type="button" variant="outline" onClick={() => setUnpairOpen(false)}>Keep Display</DesignButton>
            <DesignButton type="button" variant="destructive" onClick={unpair}>Unpair Display</DesignButton>
          </>
        )}
      >
        {unpairNotice == null ? null : <DesignAlert {...unpairNotice} glassmorphic />}
      </DesignDialog>
    </div>
  );
}

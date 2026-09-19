'use client';

import { fromNow } from "@hexclave/shared/dist/utils/dates";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously, runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DotsThree, Monitor, DeviceMobile, Warning } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useUser } from "@hexclave/next";
import { ActiveSession } from "../supporting/types";
import { PageLayout } from "../page-layout";
import { cn } from "@/lib/utils";

export function ActiveSessionsPage(props?: {
  mockSessions?: Array<{
    id: string,
    isCurrentSession: boolean,
    isImpersonation?: boolean,
    agentName?: string | null,
    createdAt: string,
    lastUsedAt?: string,
    geoInfo?: {
      ip?: string,
      cityName?: string,
    },
  }>,
  mockMode?: boolean,
}) {
  const userFromHook = useUser({ or: (props?.mockSessions || props?.mockMode) ? 'return-null' : 'throw' });
  const [isLoading, setIsLoading] = useState(!props?.mockSessions);
  const [isRevokingAll, setIsRevokingAll] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [showConfirmRevokeAll, setShowConfirmRevokeAll] = useState(false);

  // Use mock data if provided
  const mockSessionsData = useMemo(() => props?.mockSessions ? props.mockSessions.map(session => ({
    id: session.id,
    isCurrentSession: session.isCurrentSession,
    isImpersonation: session.isImpersonation || false,
    agentName: session.agentName ?? null,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    geoInfo: session.geoInfo,
  })) : [
    {
      id: 'current-session',
      isCurrentSession: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      geoInfo: { ip: '192.168.1.1', cityName: 'San Francisco' }
    },
    {
      id: 'mobile-session',
      isCurrentSession: false,
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      lastUsedAt: new Date(Date.now() - 7200000).toISOString(),
      geoInfo: { ip: '10.0.0.1', cityName: 'New York' }
    }
  ], [props?.mockSessions]);

  useEffect(() => {
    if (props?.mockSessions) {
      setSessions(mockSessionsData as any);
      setIsLoading(false);
      return;
    }

    if (props?.mockMode && !userFromHook) {
      setSessions(mockSessionsData as any);
      setIsLoading(false);
      return;
    }

    if (!userFromHook) return;

    runAsynchronously(async () => {
      setIsLoading(true);
      const sessionsData = await userFromHook.getActiveSessions();
      setSessions(sessionsData);
      setIsLoading(false);
    });
  }, [mockSessionsData, userFromHook, props?.mockMode, props?.mockSessions]);

  const handleRevokeSession = async (sessionId: string) => {
    if (props?.mockSessions) {
      setSessions(prev => prev.filter(session => session.id !== sessionId));
      return;
    }

    if (!userFromHook) return;

    try {
      await userFromHook.revokeSession(sessionId);
      setSessions(prev => prev.filter(session => session.id !== sessionId));
    } catch (error) {
      captureError("session-revoke", { sessionId, error });
      throw error;
    }
  };

  const handleRevokeAllSessions = async () => {
    setIsRevokingAll(true);
    try {
      if (props?.mockSessions) {
        setSessions(prevSessions => prevSessions.filter(session => session.isCurrentSession));
      } else if (userFromHook) {
        const deletionPromises = sessions
          .filter(session => !session.isCurrentSession)
          .map(session => userFromHook.revokeSession(session.id));
        await Promise.all(deletionPromises);
        setSessions(prevSessions => prevSessions.filter(session => session.isCurrentSession));
      }
    } catch (error) {
      captureError("all-sessions-revoke", { error, sessionIds: sessions.map(session => session.id) });
      throw error;
    } finally {
      setIsRevokingAll(false);
      setShowConfirmRevokeAll(false);
    }
  };

  return (
    <PageLayout>
      <div className="border border-black/[0.08] dark:border-white/[0.08] bg-white/80 dark:bg-background/80 backdrop-blur-xl rounded-2xl p-6 shadow-sm ring-1 ring-black/[0.04] dark:ring-0 flex flex-col gap-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h3 className="font-semibold text-base text-foreground leading-snug">
              Active Sessions
            </h3>
            <p className="text-muted-foreground text-sm mt-1 leading-relaxed">
              These are devices where you&apos;re currently logged in. You can revoke access to end a session.
            </p>
          </div>
          {sessions.filter(s => !s.isCurrentSession).length > 0 && !isLoading && (
            showConfirmRevokeAll ? (
              <div className="flex gap-2 w-full md:w-auto">
                <Button
                  variant="destructive"
                  size="sm"
                  loading={isRevokingAll}
                  onClick={handleRevokeAllSessions}
                  className="rounded-xl flex-1 md:flex-none px-4 py-2"
                >
                  Confirm Revoke All
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isRevokingAll}
                  onClick={() => setShowConfirmRevokeAll(false)}
                  className="border-black/[0.08] dark:border-white/[0.08] rounded-xl flex-1 md:flex-none px-4 py-2"
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowConfirmRevokeAll(true)}
                className="border-black/[0.08] dark:border-white/[0.08] rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-900 px-4 py-2 text-xs font-semibold w-full md:w-auto"
              >
                Revoke All Other Sessions
              </Button>
            )
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-[200px] w-full rounded-xl" />
          </div>
        ) : (
          <div className="border border-black/[0.06] dark:border-white/[0.06] rounded-xl overflow-hidden shadow-sm">
            <Table>
              <TableHeader className="bg-zinc-50/50 dark:bg-zinc-900/50">
                <TableRow className="border-b border-black/[0.06] dark:border-white/[0.06]">
                  <TableHead className="py-3 px-4 font-semibold text-xs text-muted-foreground uppercase tracking-wider">Session</TableHead>
                  <TableHead className="py-3 px-4 font-semibold text-xs text-muted-foreground uppercase tracking-wider">IP Address</TableHead>
                  <TableHead className="py-3 px-4 font-semibold text-xs text-muted-foreground uppercase tracking-wider">Location</TableHead>
                  <TableHead className="py-3 px-4 font-semibold text-xs text-muted-foreground uppercase tracking-wider">Last Used</TableHead>
                  <TableHead className="py-3 px-4 text-right w-[60px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground italic text-sm">
                      No active sessions found
                    </TableCell>
                  </TableRow>
                ) : (
                  sessions.map((session) => (
                    <TableRow key={session.id} className="border-b border-black/[0.04] dark:border-white/[0.04] last:border-b-0 hover:bg-zinc-50/30 dark:hover:bg-zinc-900/30 transition-colors duration-150">
                      <TableCell className="py-4 px-4">
                        <div className="flex items-center gap-3">
                          <div className="bg-zinc-100 dark:bg-zinc-900 p-2 rounded-xl text-foreground shrink-0 border border-black/[0.04] dark:border-white/[0.04]">
                            {session.id.includes("mobile") ? (
                              <DeviceMobile className="h-5 w-5" />
                            ) : (
                              <Monitor className="h-5 w-5" />
                            )}
                          </div>
                          <div className="flex flex-col">
                            <span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                              {session.isCurrentSession ? "Current Session" : session.agentName ?? "Other Session"}
                              {session.isCurrentSession && (
                                <Badge className="bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-[10px] px-2 py-0 border-0 font-bold rounded-full">
                                  Active
                                </Badge>
                              )}
                            </span>
                            {session.agentName != null && (
                              <Badge className="bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400 border border-sky-200 dark:border-sky-900/30 text-[9px] px-1.5 py-0 font-semibold rounded-md w-fit mt-1">
                                Agent
                              </Badge>
                            )}
                            {session.isImpersonation && (
                              <Badge className="bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border border-amber-200 dark:border-amber-900/30 text-[9px] px-1.5 py-0 font-semibold rounded-md w-fit mt-1">
                                Impersonation
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground/80 mt-0.5">
                              Signed in {new Date(session.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-4 px-4 text-sm text-foreground/90 font-medium">
                        {session.geoInfo?.ip || '-'}
                      </TableCell>
                      <TableCell className="py-4 px-4 text-sm text-foreground/90 font-medium">
                        {session.geoInfo?.cityName || 'Unknown'}
                      </TableCell>
                      <TableCell className="py-4 px-4">
                        <div className="flex flex-col">
                          <span className="text-sm font-semibold text-foreground">
                            {session.lastUsedAt ? fromNow(new Date(session.lastUsedAt)) : "Never"}
                          </span>
                          <span className="text-xs text-muted-foreground/80 mt-0.5" title={session.lastUsedAt ? new Date(session.lastUsedAt).toLocaleString() : ""}>
                            {session.lastUsedAt ? new Date(session.lastUsedAt).toLocaleDateString() : ""}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="py-4 px-4 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              className="h-8 w-8 p-0 rounded-lg text-muted-foreground hover:text-foreground hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
                            >
                              <DotsThree className="h-5 w-5 weight-bold" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-[140px] rounded-xl border-black/[0.08] dark:border-white/[0.08] shadow-md">
                            <DropdownMenuItem
                              onClick={() => runAsynchronouslyWithAlert(async () => { await handleRevokeSession(session.id); })}
                              disabled={session.isCurrentSession}
                              className={cn(
                                "cursor-pointer rounded-lg text-red-500 hover:text-red-600 focus:text-red-500",
                                session.isCurrentSession ? "opacity-50 cursor-not-allowed" : ""
                              )}
                            >
                              Revoke Session
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </PageLayout>
  );
}

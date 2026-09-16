import { fromNow } from "@hexclave/shared/dist/utils/dates";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { ActionCell, Badge, Button, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Typography } from "@hexclave/ui";
import { useEffect, useState } from "react";
import { useUser } from "../../../lib/hooks";
import { ActiveSession } from "../../../lib/hexclave-app/users";
import { useTranslation } from "../../../lib/translations";
import { PageLayout } from "../page-layout";

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
  const { t } = useTranslation();
  const userFromHook = useUser({ or: (props?.mockSessions || props?.mockMode) ? 'return-null' : 'throw' });
  const [isLoading, setIsLoading] = useState(!props?.mockSessions);
  const [isRevokingAll, setIsRevokingAll] = useState(false);
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [showConfirmRevokeAll, setShowConfirmRevokeAll] = useState(false);

  // Use mock data if provided
  const mockSessionsData = props?.mockSessions ? props.mockSessions.map(session => ({
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
      agentName: null,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      geoInfo: { ip: '192.168.1.1', cityName: 'San Francisco' }
    },
    {
      id: 'mobile-session',
      isCurrentSession: false,
      agentName: null,
      createdAt: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
      lastUsedAt: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
      geoInfo: { ip: '10.0.0.1', cityName: 'New York' }
    }
  ];

  // Fetch sessions when component mounts (only if not using mock data)
  useEffect(() => {
    if (props?.mockSessions) {
      setSessions(mockSessionsData as any);
      setIsLoading(false);
      return;
    }

    // If in mock mode but no mock sessions provided, use default mock data
    if (props?.mockMode && !userFromHook) {
      setSessions(mockSessionsData as any);
      setIsLoading(false);
      return;
    }

    if (!userFromHook) return;

    runAsynchronously(async () => {
      setIsLoading(true);
      const sessionsData = await userFromHook.getActiveSessions();
      const enhancedSessions = sessionsData;
      setSessions(enhancedSessions);
      setIsLoading(false);
    });
  }, [userFromHook, props?.mockSessions]);

  const handleRevokeSession = async (sessionId: string) => {
    if (props?.mockSessions) {
      // Mock revoke - just remove from list
      setSessions(prev => prev.filter(session => session.id !== sessionId));
      return;
    }

    if (!userFromHook) return;

    try {
      await userFromHook.revokeSession(sessionId);
      setSessions(prev => prev.filter(session => session.id !== sessionId));
    } catch (error) {
      captureError("session-revoke", { sessionId ,error });
      throw error;
    }
  };

  const handleRevokeAllSessions = async () => {
    setIsRevokingAll(true);
    try {
      if (props?.mockSessions) {
        // Mock revoke all - just keep current session
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
      <div>
        <div className="flex justify-between items-center mb-2">
          <Typography className='font-medium'>{t("Active Sessions")}</Typography>
          {sessions.filter(s => !s.isCurrentSession).length > 0 && !isLoading && (
            showConfirmRevokeAll ? (
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  loading={isRevokingAll}
                  onClick={handleRevokeAllSessions}
                >
                  {t("Confirm")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isRevokingAll}
                  onClick={() => setShowConfirmRevokeAll(false)}
                >
                  {t("Cancel")}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowConfirmRevokeAll(true)}
              >
                {t("Revoke All Other Sessions")}
              </Button>
            )
          )}
        </div>
        <Typography variant='secondary' type='footnote' className="mb-4">
          {t("These are devices where you're currently logged in. You can revoke access to end a session.")}
        </Typography>

        {isLoading ? (
          <Skeleton className="h-[300px] w-full rounded-md" />
        ) : (
          <div className='border rounded-md'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">{t("Session")}</TableHead>
                  <TableHead className="w-[150px]">{t("IP Address")}</TableHead>
                  <TableHead className="w-[150px]">{t("Location")}</TableHead>
                  <TableHead className="w-[150px]">{t("Last used")}</TableHead>
                  <TableHead className="w-[80px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-6">
                      <Typography variant="secondary">{t("No active sessions found")}</Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  sessions.map((session) => (
                    <TableRow key={session.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          {/* Agent sessions carry the agent's name; for everything else we don't save what kind of session it is yet (cli, browser, auth method, ...) */}
                          <Typography>{session.isCurrentSession ? t("Current Session") : session.agentName ?? t("Other Session")}</Typography>
                          {session.agentName != null && <Badge variant="secondary" className="w-fit mt-1">{t("Agent")}</Badge>}
                          {session.isImpersonation && <Badge variant="secondary" className="w-fit mt-1">{t("Impersonation")}</Badge>}
                          <Typography variant='secondary' type='footnote'>
                            {t("Signed in {time}", { time: new Date(session.createdAt).toLocaleDateString() })}
                          </Typography>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Typography>{session.geoInfo?.ip || t('-')}</Typography>
                      </TableCell>
                      <TableCell>
                        <Typography>{session.geoInfo?.cityName || t('Unknown')}</Typography>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <Typography>{session.lastUsedAt ? fromNow(new Date(session.lastUsedAt)) : t("Never")}</Typography>
                          <Typography variant='secondary' type='footnote' title={session.lastUsedAt ? new Date(session.lastUsedAt).toLocaleString() : ""}>
                            {session.lastUsedAt ? new Date(session.lastUsedAt).toLocaleDateString() : ""}
                          </Typography>
                        </div>
                      </TableCell>
                      <TableCell align="right">
                        <ActionCell
                          items={[
                            {
                              item: t("Revoke"),
                              onClick: () => handleRevokeSession(session.id),
                              danger: true,
                              disabled: session.isCurrentSession,
                              disabledTooltip: session.isCurrentSession ? t("You cannot revoke your current session") : undefined,
                            },
                          ]}
                        />
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

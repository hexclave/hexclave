'use client';

import { useStackApp, useUser } from '@hexclave/next';
import { runAsynchronouslyWithAlert } from '@hexclave/shared/dist/utils/promises';
import { Button, Card, CardContent, CardHeader, Input, Typography } from '@hexclave/ui';
import { useMemo, useState } from 'react';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readType(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const type = value.type;
  return typeof type === 'string' ? type : undefined;
}

// Helper to decode JWT payload (without verification)
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return payload;
  } catch {
    return null;
  }
}

export default function TokenStalenessPage() {
  const user = useUser({ or: "anonymous" });
  const app = useStackApp();
  const [newDisplayName, setNewDisplayName] = useState('');

  // Get partial user from token (can be stale compared to actual user data)
  const partialUserFromToken = app.usePartialUser({ from: 'token', or: 'anonymous-if-exists' });

  // Get raw tokens
  const tokens = user?.currentSession.useTokens();

  // Decode JWT payload
  const jwtPayload = useMemo(() => {
    if (!tokens?.accessToken) return null;
    return decodeJwtPayload(tokens.accessToken);
  }, [tokens?.accessToken]);

  // Get user's teams
  const teams = user?.useTeams() ?? [];

  // Check for mismatches between token and actual user data
  const mismatches = useMemo(() => {
    if (!user || !jwtPayload) return [];
    const result: { field: string, token: unknown, actual: unknown }[] = [];

    // Helper to compare values, treating null and undefined as equivalent
    const isDifferent = (a: unknown, b: unknown) => {
      if (a == null && b == null) return false; // both null/undefined
      return a !== b;
    };

    if (isDifferent(jwtPayload.name, user.displayName)) {
      result.push({ field: 'displayName / name', token: jwtPayload.name, actual: user.displayName });
    }
    if (isDifferent(jwtPayload.email, user.primaryEmail)) {
      result.push({ field: 'primaryEmail / email', token: jwtPayload.email, actual: user.primaryEmail });
    }
    if (isDifferent(jwtPayload.email_verified, user.primaryEmailVerified)) {
      result.push({ field: 'primaryEmailVerified / email_verified', token: jwtPayload.email_verified, actual: user.primaryEmailVerified });
    }
    if (isDifferent(jwtPayload.is_anonymous, user.isAnonymous)) {
      result.push({ field: 'isAnonymous / is_anonymous', token: jwtPayload.is_anonymous, actual: user.isAnonymous });
    }
    if (isDifferent(jwtPayload.is_restricted, user.isRestricted)) {
      result.push({ field: 'isRestricted / is_restricted', token: jwtPayload.is_restricted, actual: user.isRestricted });
    }
    if (isDifferent(readType(jwtPayload.restricted_reason), readType(user.restrictedReason))) {
      result.push({ field: 'restrictedReason / restricted_reason', token: JSON.stringify(jwtPayload.restricted_reason), actual: JSON.stringify(user.restrictedReason) });
    }
    if (isDifferent(jwtPayload.selected_team_id, user.selectedTeam?.id)) {
      result.push({ field: 'selectedTeam.id / selected_team_id', token: jwtPayload.selected_team_id, actual: user.selectedTeam?.id });
    }

    return result;
  }, [user, jwtPayload]);

  const updateDisplayName = async () => {
    if (!user || !newDisplayName.trim()) return;
    await user.update({ displayName: newDisplayName.trim() });
    setNewDisplayName('');
  };

  const selectTeam = async (teamId: string | null) => {
    if (!user) return;
    await user.setSelectedTeam(teamId);
  };

  const createTeam = async () => {
    if (!user) return;
    await user.createTeam({ displayName: `Team ${Date.now()}` });
  };

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <Typography type="h1" className="mb-2">Token Staleness Demo</Typography>
      <Typography className="text-gray-600 mb-6">
        This page demonstrates how JWT access tokens can become stale when user data changes.
      </Typography>

      <div className="grid gap-6">
        {/* Mismatch Alert */}
        {mismatches.length > 0 && (
          <Card className="border-amber-500 bg-amber-50">
            <CardHeader>
              <Typography type="h3" className="text-amber-800">⚠️ Token Mismatches Detected!</Typography>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Typography className="text-amber-700 text-sm mb-3">
                  The following fields differ between the JWT token and the actual user data from the API:
                </Typography>
                {mismatches.map((m, i) => (
                  <div key={i} className="flex flex-col gap-1 p-2 bg-white rounded border border-amber-200">
                    <span className="font-semibold text-amber-800">{m.field}</span>
                    <div className="flex gap-4 text-sm">
                      <span className="text-red-600">Token: <code className="bg-red-50 px-1">{JSON.stringify(m.token)}</code></span>
                      <span className="text-green-600">Actual: <code className="bg-green-50 px-1">{JSON.stringify(m.actual)}</code></span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Current User Data (from API) */}
        <Card>
          <CardHeader>
            <Typography type="h3">User Data (from useUser - fresh from API)</Typography>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {user && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold w-40">User ID:</span>
                    <code className="text-sm bg-gray-100 px-2 py-1 rounded">{user.id}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold w-40">displayName:</span>
                    <code className="text-sm bg-gray-100 px-2 py-1 rounded">{user.displayName ?? 'null'}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold w-40">primaryEmail:</span>
                    <code className="text-sm bg-gray-100 px-2 py-1 rounded">{user.primaryEmail ?? 'null'}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold w-40">primaryEmailVerified:</span>
                    <code className="text-sm bg-gray-100 px-2 py-1 rounded">{String(user.primaryEmailVerified)}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold w-40">isAnonymous:</span>
                    <code className="text-sm bg-gray-100 px-2 py-1 rounded">{String(user.isAnonymous)}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold w-40">isRestricted:</span>
                    <code className="text-sm bg-gray-100 px-2 py-1 rounded">{String(user.isRestricted)}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold w-40">restrictedReason:</span>
                    <code className="text-sm bg-gray-100 px-2 py-1 rounded">{user.restrictedReason ? JSON.stringify(user.restrictedReason) : 'null'}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold w-40">selectedTeam.id:</span>
                    <code className="text-sm bg-gray-100 px-2 py-1 rounded">{user.selectedTeam?.id ?? 'null'}</code>
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Partial User from Token */}
        {partialUserFromToken && (
          <Card>
            <CardHeader>
              <Typography type="h3">Partial User (from usePartialUser - from token)</Typography>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-amber-600 bg-amber-50 p-2 rounded mb-3">
                ⚠️ This data comes directly from the JWT token and may be stale for up to 10 minutes.
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold w-40">id:</span>
                  <code className="text-sm bg-gray-100 px-2 py-1 rounded">{partialUserFromToken.id}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold w-40">displayName:</span>
                  <code className="text-sm bg-gray-100 px-2 py-1 rounded">{partialUserFromToken.displayName ?? 'null'}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold w-40">primaryEmail:</span>
                  <code className="text-sm bg-gray-100 px-2 py-1 rounded">{partialUserFromToken.primaryEmail ?? 'null'}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold w-40">primaryEmailVerified:</span>
                  <code className="text-sm bg-gray-100 px-2 py-1 rounded">{String(partialUserFromToken.primaryEmailVerified)}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold w-40">isAnonymous:</span>
                  <code className="text-sm bg-gray-100 px-2 py-1 rounded">{String(partialUserFromToken.isAnonymous)}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold w-40">isRestricted:</span>
                  <code className="text-sm bg-gray-100 px-2 py-1 rounded">{String(partialUserFromToken.isRestricted)}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold w-40">restrictedReason:</span>
                  <code className="text-sm bg-gray-100 px-2 py-1 rounded">{partialUserFromToken.restrictedReason ? JSON.stringify(partialUserFromToken.restrictedReason) : 'null'}</code>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Actions to cause staleness */}
        <Card>
          <CardHeader>
            <Typography type="h3">Actions (will cause token staleness)</Typography>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Change Display Name */}
              <div>
                <Typography className="font-semibold mb-2">Change Display Name</Typography>
                <div className="flex gap-2">
                  <Input
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    placeholder="New display name"
                    className="flex-1"
                  />
                  <Button
                    onClick={() => runAsynchronouslyWithAlert(updateDisplayName)}
                    disabled={!newDisplayName.trim()}
                  >
                    Update
                  </Button>
                </div>
                <Typography className="text-xs text-gray-500 mt-1">
                  After updating, the &quot;name&quot; field in the token will be stale until refresh.
                </Typography>
              </div>

              {/* Change Selected Team */}
              <div>
                <Typography className="font-semibold mb-2">Change Selected Team</Typography>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={user?.selectedTeam === null ? "default" : "secondary"}
                    onClick={() => runAsynchronouslyWithAlert(() => selectTeam(null))}
                  >
                    None
                  </Button>
                  {teams.map((team) => (
                    <Button
                      key={team.id}
                      variant={user?.selectedTeam?.id === team.id ? "default" : "secondary"}
                      onClick={() => runAsynchronouslyWithAlert(() => selectTeam(team.id))}
                    >
                      {team.displayName}
                    </Button>
                  ))}
                  <Button
                    variant="outline"
                    onClick={() => runAsynchronouslyWithAlert(createTeam)}
                  >
                    + Create Team
                  </Button>
                </div>
                <Typography className="text-xs text-gray-500 mt-1">
                  After changing, the &quot;selected_team_id&quot; field in the token will be stale until refresh.
                </Typography>
              </div>

              {/* Sign Out */}
              <div>
                <Typography className="font-semibold mb-2">Sign Out</Typography>
                <Button
                  variant="destructive"
                  onClick={() => runAsynchronouslyWithAlert(async () => {
                    await user?.signOut({ redirectUrl: "/token-staleness" });
                  })}
                >
                  Sign Out
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Raw JWT Payload */}
        {jwtPayload && (
          <Card>
            <CardHeader>
              <Typography type="h3">Raw JWT Payload</Typography>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-blue-600 bg-blue-50 p-2 rounded mb-3">
                ℹ️ This is the decoded payload from the access token. Key fields that can become stale:
                name, email, email_verified, is_anonymous, is_restricted, restricted_reason, selected_team_id
              </div>
              <pre className="text-xs bg-gray-100 p-3 rounded overflow-auto max-h-96">
                {JSON.stringify(jwtPayload, null, 2)}
              </pre>
            </CardContent>
          </Card>
        )}

        {/* Explanation Card */}
        <Card>
          <CardHeader>
            <Typography type="h3">How Token Staleness Works</Typography>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              <div>
                <Typography className="font-semibold mb-1">Access Token Lifecycle</Typography>
                <Typography className="text-gray-600">
                  Access tokens are short-lived JWTs that contain a snapshot of user data at the time of generation.
                  When the token expires, a new one is generated from the refresh token with updated user data.
                </Typography>
              </div>
              <div>
                <Typography className="font-semibold mb-1">What Gets Stale?</Typography>
                <ul className="list-disc list-inside text-gray-600 space-y-1">
                  <li><code className="bg-gray-100 px-1">name</code> (displayName)</li>
                  <li><code className="bg-gray-100 px-1">email</code> (primaryEmail)</li>
                  <li><code className="bg-gray-100 px-1">email_verified</code> (primaryEmailVerified)</li>
                  <li><code className="bg-gray-100 px-1">is_anonymous</code></li>
                  <li><code className="bg-gray-100 px-1">is_restricted</code> / <code className="bg-gray-100 px-1">restricted_reason</code></li>
                  <li><code className="bg-gray-100 px-1">selected_team_id</code></li>
                </ul>
              </div>
              <div>
                <Typography className="font-semibold mb-1">When to Use Which?</Typography>
                <ul className="list-disc list-inside text-gray-600 space-y-1">
                  <li><code className="bg-gray-100 px-1">useUser()</code> - Always fresh, fetches from API. Use for displaying current user state.</li>
                  <li><code className="bg-gray-100 px-1">usePartialUser({'{ from: "token" }'})</code> - From token, can be stale. Use for quick checks where staleness is acceptable.</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

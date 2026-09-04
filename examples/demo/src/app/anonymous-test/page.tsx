'use client';

import { useStackApp, useUser } from '@hexclave/next';
import { runAsynchronouslyWithAlert } from '@hexclave/shared/dist/utils/promises';
import { Button, Card, CardContent, CardHeader, Typography } from '@hexclave/ui';
import { useState } from 'react';

type TestResult = {
  success: boolean,
  error?: string,
  status?: number,
  expected?: string,
  data?: unknown,
};

type TestResults = Record<string, TestResult>;

export default function AnonymousTestPage() {
  const user = useUser({ or: "anonymous-if-exists[deprecated]" });
  const isAnonymous = user?.isAnonymous;
  const app = useStackApp();
  const [testResults, setTestResults] = useState<TestResults>({});
  const [loading, setLoading] = useState<string | null>(null);

  const signUpAnonymously = async () => {
    setLoading('signup');
    try {
      await app.getUser({ or: "anonymous" });
    } catch (error) {
      setTestResults(prev => ({
        ...prev,
        signup: { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }));
    } finally {
      setLoading(null);
    }
  };

  const clearSession = () => {
    runAsynchronouslyWithAlert(async () => {
      await user?.signOut({ redirectUrl: "/anonymous-test" });
    });
  };

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <Typography type="h1" className="mb-6">Anonymous User Testing</Typography>

      <div className="grid gap-6">
        {/* Current Status Card */}
        <Card>
          <CardHeader>
            <Typography type="h3">Current Status</Typography>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold">User Status:</span>
                <span className={`px-2 py-1 rounded text-sm ${
                  user ? (isAnonymous ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800') : 'bg-gray-100 text-gray-800'
                }`}>
                  {user ? (isAnonymous ? 'Anonymous User' : 'Regular User') : 'Not Signed In'}
                </span>
              </div>
              {user && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">User ID:</span>
                    <code className="text-sm bg-gray-100 px-2 py-1 rounded">{user.id}</code>
                  </div>
                  {user.primaryEmail && (
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">Email:</span>
                      <span>{user.primaryEmail}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Test Actions Card */}
        <Card>
          <CardHeader>
            <Typography type="h3">Test Actions</Typography>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {!user && (
                <div>
                  <Typography className="mb-2">Sign up as anonymous user</Typography>
                  <Button
                    onClick={signUpAnonymously}
                    disabled={loading === 'signup'}
                  >
                    {loading === 'signup' ? 'Signing up...' : 'Sign Up Anonymously'}
                  </Button>
                </div>
              )}

              {user && (
                <div>
                  <Typography className="mb-2">Sign out and start over:</Typography>
                  <Button
                    onClick={clearSession}
                    variant="destructive"
                  >
                    Sign out
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Test Results Card */}
        {Object.keys(testResults).length > 0 && (
          <Card>
            <CardHeader>
              <Typography type="h3">Test Results</Typography>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {Object.entries(testResults).map(([key, result]) => (
                  <div key={key} className="border rounded p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-semibold">{key}:</span>
                      <span className={`px-2 py-1 rounded text-sm ${
                        result.success ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                      }`}>
                        {result.success ? 'Success' : 'Failed'}
                      </span>
                      {result.status && (
                        <span className="text-sm text-gray-600">
                          Status: {result.status}
                        </span>
                      )}
                    </div>
                    {result.expected && (
                      <div className="text-sm text-gray-600 mb-1">
                        Expected: {result.expected}
                      </div>
                    )}
                    <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto">
                      {JSON.stringify(result.data || result.error, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Information Card */}
        <Card>
          <CardHeader>
            <Typography type="h3">About Anonymous Users</Typography>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              <div>
                <Typography className="font-semibold mb-1">What are anonymous users?</Typography>
                <Typography className="text-gray-600">
                  Anonymous users are temporary user accounts that don&apos;t require email or password.
                  They&apos;re useful for letting users try your app before signing up.
                </Typography>
              </div>
              <div>
                <Typography className="font-semibold mb-1">Key Features:</Typography>
                <ul className="list-disc list-inside text-gray-600 space-y-1">
                  <li>Sign up without email or password</li>
                  <li>JWT tokens have &apos;anon&apos; role</li>
                  <li>Can be upgraded to regular users</li>
                  <li>Require X-Stack-Allow-Anonymous-User header for API access</li>
                  <li>Have separate JWT signing keys</li>
                </ul>
              </div>
              <div>
                <Typography className="font-semibold mb-1">Test Scenarios:</Typography>
                <ul className="list-disc list-inside text-gray-600 space-y-1">
                  <li>Sign up as anonymous user</li>
                  <li>Access API endpoints with anonymous token</li>
                  <li>Test rejection without proper header</li>
                  <li>Upgrade anonymous user to regular user</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

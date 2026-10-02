import type { StackClientAppConstructorOptions, StackServerAppConstructorOptions } from '@hexclave/js';
import { AdminProjectCreateOptions, StackAdminApp, StackClientApp, StackServerApp } from '@hexclave/js';
import { throwErr } from '@hexclave/shared/dist/utils/errors';
import { Result } from '@hexclave/shared/dist/utils/results';
import { SDK_BASE_URL, STACK_INTERNAL_PROJECT_ADMIN_KEY, STACK_INTERNAL_PROJECT_CLIENT_KEY, STACK_INTERNAL_PROJECT_SERVER_KEY } from '../helpers';

const testExtraRequestHeaders = {
  "x-stack-disable-artificial-development-delay": "yes",
};

const sdkBaseUrl = SDK_BASE_URL;

export async function scaffoldProject(body?: Omit<AdminProjectCreateOptions, 'displayName' | 'teamId'> & { displayName?: string }) {
  const internalApp = new StackAdminApp({
    projectId: 'internal',
    baseUrl: sdkBaseUrl,
    publishableClientKey: STACK_INTERNAL_PROJECT_CLIENT_KEY,
    secretServerKey: STACK_INTERNAL_PROJECT_SERVER_KEY,
    superSecretAdminKey: STACK_INTERNAL_PROJECT_ADMIN_KEY,
    tokenStore: "memory",
    redirectMethod: "none",
    extraRequestHeaders: testExtraRequestHeaders,
  });

  const fakeEmail = `${crypto.randomUUID()}@stack-js-test.example.com`;

  Result.orThrow(await internalApp.signUpWithCredential({
    email: fakeEmail,
    password: "password",
    noVerificationCallback: true,
  }));
  const adminUser = await internalApp.getUser({
    or: 'throw',
  });
  const teamId = adminUser.selectedTeam?.id ?? throwErr("No team selected");

  const project = await adminUser.createProject({
    displayName: body?.displayName || 'New Project',
    teamId,
    ...body,
  });

  return {
    project,
    adminUser,
  };
}

export async function createApp(
  body?: Parameters<typeof scaffoldProject>[0],
  appOverrides?: {
    client?: Partial<StackClientAppConstructorOptions<true, string>>,
    server?: Partial<StackServerAppConstructorOptions<true, string>>,
  },
) {
  const { project, adminUser } = await scaffoldProject(body);
  const adminApp = new StackAdminApp({
    projectId: project.id,
    baseUrl: sdkBaseUrl,
    projectOwnerSession: adminUser._internalSession,
    tokenStore: "memory",
    redirectMethod: "none",
    extraRequestHeaders: testExtraRequestHeaders,
  });

  const apiKey = await adminApp.createInternalApiKey({
    description: 'test',
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    hasPublishableClientKey: true,
    hasSecretServerKey: true,
    hasSuperSecretAdminKey: false,
  });
  if (!apiKey.secretServerKey) {
    throw new Error("createInternalApiKey did not return a secretServerKey");
  }
  const secretServerKey = apiKey.secretServerKey;

  const serverApp = new StackServerApp({
    baseUrl: sdkBaseUrl,
    projectId: project.id,
    publishableClientKey: apiKey.publishableClientKey,
    secretServerKey,
    tokenStore: "memory",
    redirectMethod: "none",
    extraRequestHeaders: testExtraRequestHeaders,
    telemetry: { resource: { service: { name: "e2e-server" } } },
    ...(appOverrides?.server ?? {}),
  });

  const clientApp = new StackClientApp({
    baseUrl: sdkBaseUrl,
    projectId: project.id,
    publishableClientKey: apiKey.publishableClientKey,
    tokenStore: "memory",
    redirectMethod: "none",
    extraRequestHeaders: testExtraRequestHeaders,
    telemetry: { resource: { service: { name: "e2e-client" } } },
    ...(appOverrides?.client ?? {}),
  });

  return {
    serverApp,
    clientApp,
    adminApp,
    apiKey,
    project,
    secretServerKey,
  };
}

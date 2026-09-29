import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import Database from "better-sqlite3";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value == null || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const databaseSchema = `
  create table if not exists "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
  create table if not exists "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
  create table if not exists "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
  create table if not exists "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
  create table if not exists "jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" date not null, "expiresAt" date, "alg" text, "crv" text);
  create index if not exists "session_userId_idx" on "session" ("userId");
  create index if not exists "account_userId_idx" on "account" ("userId");
  create index if not exists "verification_identifier_idx" on "verification" ("identifier");
`;

function createAuth() {
  const database = new Database("./better-auth.db");
  database.exec(databaseSchema);
  const jwksColumns = new Set(
    database.prepare<[], { name: string }>('PRAGMA table_info("jwks")').all().map((column) => column.name),
  );
  // Existing demo databases need the JWKS metadata columns Better Auth added after the original table was created.
  if (!jwksColumns.has("alg")) database.exec('ALTER TABLE "jwks" ADD COLUMN "alg" text');
  if (!jwksColumns.has("crv")) database.exec('ALTER TABLE "jwks" ADD COLUMN "crv" text');
  const betterAuthUrl = requireEnv("BETTER_AUTH_URL");
  return betterAuth({
    database,
    baseURL: betterAuthUrl,
    secret: requireEnv("BETTER_AUTH_SECRET"),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({
        jwt: {
          issuer: betterAuthUrl,
          audience: "better-auth-integration-demo",
          definePayload: ({ user, session }) => ({
            sub: user.id,
            email: user.email,
            email_verified: user.emailVerified,
            name: user.name,
            sid: session.id,
          }),
        },
      }),
    ],
  });
}

let auth: ReturnType<typeof createAuth> | null = null;

export function getAuth(): ReturnType<typeof createAuth> {
  if (auth != null) return auth;
  auth = createAuth();
  return auth;
}

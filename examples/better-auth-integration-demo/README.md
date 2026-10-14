# Better Auth → Hexclave example

This example signs in with a local Better Auth instance, exchanges its provider
JWT with the local Hexclave backend, and displays the resulting session
metadata.

## Local setup

1. Copy `.env.local.example` to `.env.local`.
2. Set a local `BETTER_AUTH_SECRET` and the local Hexclave client and server
   keys and API URL.
3. Run `pnpm dev` from this directory. The script follows the repository's
   `NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX` convention (`81` defaults to port `8114`).
4. Create a Better Auth user through the form, then sign in and exchange its
   token with Hexclave.

Before exchanging a token, enable the `better-auth-integration` provider in
the Hexclave dashboard at
`http://localhost:8101/projects/<project-id>/better-auth-integration`.
Configure the matching Better Auth values:

- issuer: `http://localhost:8114`
- audience: `better-auth-integration-demo`
- JWKS URL: `http://localhost:8114/api/auth/jwks`

If you use a custom port prefix, export `NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX` in
your terminal before running `pnpm dev` (the `dev` script reads it from the
shell, not from `.env.local`), and then update the dashboard URL,
`BETTER_AUTH_URL`, the issuer and JWKS URL, and `NEXT_PUBLIC_HEXCLAVE_API_URL`
together; `.env` files do not derive ports automatically.

The example intentionally does not include provider credentials, access tokens,
or user credentials. The local SQLite database is created at runtime.

# WorkOS AuthKit → Hexclave example

This example signs in with WorkOS AuthKit, exchanges the provider access token
with the local Hexclave backend, and displays the resulting session metadata.

## Local setup

1. Copy `.env.local.example` to `.env.local`.
2. Fill in the WorkOS AuthKit values for your own development tenant:
   - `WORKOS_CLIENT_ID`
   - `WORKOS_API_KEY`
   - `WORKOS_AUTHKIT_DOMAIN`
   - `WORKOS_COOKIE_PASSWORD` (use a local value at least 32 characters long)
3. Set the local Hexclave client and server keys and API URL.
4. Configure `http://localhost:8113/auth/callback` as an allowed WorkOS redirect in WorkOS. If you use a custom `NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX`, update this URI in WorkOS and `.env.local` together; `.env` files cannot compute these ports from the prefix automatically.
5. Run `pnpm dev` from this directory.

Enable the `workos-integration` provider in the Hexclave dashboard at
`http://localhost:8101/projects/<project-id>/workos-integration` before
exchanging a token. Configure the WorkOS client ID and API key there; the
dashboard derives the issuer and JWKS URL from the client ID unless an explicit
override is required. If you use a custom port prefix, update the dashboard
URL, API URL, and redirect URI together; the redirect URI must be registered in
WorkOS for the port you use.

The example intentionally does not include provider credentials, access tokens,
or user credentials. The WorkOS issuer is derived from the configured client ID
by the Hexclave dashboard unless an explicit override is required.

## Getting the user's email and name

A WorkOS AuthKit access token has no `email` or `name` claim by default, so
Hexclave creates the user with an empty profile. To map them:

1. In the WorkOS dashboard, open **Authentication → Features → JWT Template**
   and save:

   ```json
   {
     "email": {{ user.email }},
     "name": "{{ user.first_name || '' }} {{ user.last_name || '' }}"
   }
   ```

2. Delete the existing Hexclave user on the project's **Users** page. Hexclave
   maps these claims only when it first creates the user.
3. Sign out and sign in again so WorkOS issues a token from the new template.

The email is stored as unverified unless the token has `email_verified: true`
(a boolean).

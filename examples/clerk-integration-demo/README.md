# Clerk → Hexclave example

This standalone example loads Clerk's browser SDK from its CDN, signs in a real
Clerk development-instance user, and exchanges the resulting provider JWT with
the local Hexclave backend.

## Local setup

1. Copy `.env.local.example` to `.env.local`.
2. Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` to the publishable key for your Clerk
   development instance.
3. Run `pnpm dev` from this directory. It uses port `8115` by default.
4. Configure the `clerk-integration` provider in the local dashboard at
   `http://localhost:8101/projects/<project-id>/clerk-integration`:
   - Issuer: `https://<your-clerk-domain>`
   - Authorized parties: `http://localhost:8115`
5. Sign in with Clerk. The page displays the decoded provider claims and the
   mapped Hexclave user profile.

The same-origin exchange route accepts POST only. It validates the provider
token input and every backend response before returning safe display data.
The provider token is never written to disk or committed.

## Getting the user's email and name

Clerk's default session token has no `email` or `name` claim, so Hexclave
creates the user with an empty profile. To map them, add the claims in the Clerk
dashboard under **Sessions → Customize session token**:

```json
{
  "email": "{{user.primary_email_address}}",
  "name": "{{user.full_name}}"
}
```

Hexclave maps these claims only when it first creates the user, so delete the
existing Hexclave user on the project's **Users** page, then sign out of Clerk
and sign in again.

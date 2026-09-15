import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { agentAuthDefaults, isAgentAuthEnabled } from "./agent-auth";
import { getApiUrlForRequest } from "./request-api-url";
import { DEFAULT_BRANCH_ID, Tenancy, getSoleTenancyFromProjectBranch } from "./tenancies";

/**
 * Request shape shared by `/agent/auth.md` and `/agent/discovery`.
 *
 * Discovery is the one place an agent lands *before* it knows how to talk to
 * this project, so it must not require the very headers it is documenting.
 * `auth` is therefore nullable: an agent that only knows the project ID (the
 * dashboard prompt gives it exactly that) sends `x-hexclave-project-id` and
 * nothing else, and we resolve the tenancy from that header ourselves. Agents
 * that already have client headers can send them too, which lets us echo the
 * publishable key back into the pre-filled commands.
 */
export const agentAuthDiscoveryRequestSchema = yupObject({
  auth: yupObject({
    type: clientOrHigherAuthTypeSchema,
    tenancy: adaptSchema.defined(),
  }).nullable(),
  headers: yupObject({
    "x-stack-project-id": yupTuple([yupString().optional()]).optional(),
    "x-stack-branch-id": yupTuple([yupString().optional()]).optional(),
    "x-stack-publishable-client-key": yupTuple([yupString().optional()]).optional(),
  }).defined(),
});

export async function getAgentAuthDiscoveryForRequest(
  req: { auth: { tenancy: Tenancy } | null, headers: Record<string, string[] | undefined> },
  fullReq: { headers: Record<string, string[] | undefined> },
): Promise<AgentAuthDiscovery> {
  let tenancy: Tenancy;
  if (req.auth != null) {
    tenancy = req.auth.tenancy;
  } else {
    const projectId = req.headers["x-stack-project-id"]?.[0];
    if (projectId == null) {
      throw new StatusError(400, "Send the project ID in the x-hexclave-project-id header to read this project's agent auth guide.");
    }
    const branchId = req.headers["x-stack-branch-id"]?.[0] ?? DEFAULT_BRANCH_ID;
    tenancy = await getSoleTenancyFromProjectBranch(projectId, branchId, true) ?? throwProjectNotFound(projectId);
  }
  return getAgentAuthDiscovery({
    tenancy,
    apiUrl: getApiUrlForRequest(fullReq),
    publishableClientKey: req.headers["x-stack-publishable-client-key"]?.[0] ?? null,
  });
}

function throwProjectNotFound(projectId: string): never {
  throw new KnownErrors.CurrentProjectNotFound(projectId);
}

/**
 * Machine-readable description of a project's agent-auth setup. This is what
 * `/agent/discovery` returns, and what `/agent/auth.md` is rendered from, so
 * the two can never disagree.
 *
 * Field names for the OAuth-ish parts follow RFC 8414/9728 where a direct
 * equivalent exists (`issuer`, `registration_endpoint`, ...) so generic agent
 * tooling that already understands those documents can find the endpoints;
 * everything specific to Hexclave lives under `hexclave_agent_auth`.
 */
export type AgentAuthDiscovery = {
  issuer: string,
  registration_endpoint: string,
  token_endpoint: string,
  revocation_endpoint: string,
  agent_auth_md: string,
  hexclave_agent_auth: {
    enabled: boolean,
    project_id: string,
    project_display_name: string,
    publishable_client_key: string | null,
    publishable_client_key_required: boolean,
    poll_endpoint: string,
    confirm_endpoint: string,
    sessions_endpoint: string,
    anonymous_session_header: Record<string, string>,
    claim_code_format: string,
    default_attempt_lifetime_millis: number,
    agent_session_lifetime_millis: number,
    required_headers: Record<string, string>,
  },
};

export function getAgentAuthDiscovery(options: {
  tenancy: Tenancy,
  apiUrl: string,
  publishableClientKey: string | null,
}): AgentAuthDiscovery {
  const { tenancy, apiUrl } = options;
  const api = apiUrl.replace(/\/$/, "");
  // Projects that don't enforce a publishable client key (the default for new projects) must not make agents hunt for
  // one; the header is only listed when the project actually checks it. If it is checked and the agent didn't send it
  // to us, the placeholder tells the agent to ask the user for it.
  const publishableClientKeyRequired = tenancy.config.project.requirePublishableClientKey;
  return {
    issuer: api,
    registration_endpoint: `${api}/api/v1/agent/register`,
    token_endpoint: `${api}/api/v1/auth/sessions/current/refresh`,
    revocation_endpoint: `${api}/api/v1/auth/sessions/current`,
    agent_auth_md: `${api}/api/v1/agent/auth.md`,
    hexclave_agent_auth: {
      enabled: isAgentAuthEnabled(tenancy),
      project_id: tenancy.project.id,
      project_display_name: tenancy.project.display_name,
      publishable_client_key: options.publishableClientKey,
      publishable_client_key_required: publishableClientKeyRequired,
      poll_endpoint: `${api}/api/v1/agent/register/poll`,
      confirm_endpoint: `${api}/api/v1/agent/register/confirm`,
      sessions_endpoint: `${api}/api/v1/auth/sessions`,
      anonymous_session_header: { "x-hexclave-allow-anonymous-user": "true" },
      claim_code_format: "XXXX-XXXX (A-Z and 2-9, no 0/O/1/I)",
      default_attempt_lifetime_millis: agentAuthDefaults.attemptExpiresInMillis,
      agent_session_lifetime_millis: agentAuthDefaults.agentSessionExpiresInMillis,
      required_headers: {
        "x-hexclave-access-type": "client",
        "x-hexclave-project-id": tenancy.project.id,
        ...(options.publishableClientKey != null || publishableClientKeyRequired ? {
          "x-hexclave-publishable-client-key": options.publishableClientKey ?? "<publishable client key; ask the user, it is in the app's Hexclave config>",
        } : {}),
      },
    },
  };
}

function headerFlags(headers: Record<string, string>): string {
  return Object.entries(headers).map(([k, v]) => `  -H '${k}: ${v}'`).join(" \\\n");
}

/**
 * The agent-readable guide. Written for an LLM that has just been pointed at
 * this URL and knows nothing about Hexclave: every step is a complete command
 * with this project's values already filled in.
 */
export function renderAgentAuthMd(discovery: AgentAuthDiscovery): string {
  const hx = discovery.hexclave_agent_auth;
  const headers = headerFlags(hx.required_headers);
  const authHeaders = `${headers} \\\n  -H 'x-hexclave-access-token: <access_token>'`;

  const disabledNotice = hx.enabled ? "" : `
> **Agent auth is not enabled for this project yet.** The endpoints below will
> return \`AGENT_AUTH_NOT_ENABLED\` until the project owner installs the
> *Agent Auth* app in the Hexclave dashboard. Tell the user, then stop.
`;

  const anonymousNote = `You can start calling the API with \`anonymous_session.access_token\` right
away, before anyone has approved you, by adding ${headerFlags(hx.anonymous_session_header).trim()}
to those requests. Anything you create as the anonymous user stays with that
user, so prefer to wait for approval for work that should be attributed to the
human.`;

  return `# Agent authentication for ${hx.project_display_name}

This app uses Hexclave for authentication. Hexclave has agent auth built in:
you do not need an API key, a browser, or an OAuth client. You register once,
a human approves you, and you receive your own session on their account.

Your session is a regular Hexclave session. It has exactly the permissions of
the user who approved you, it shows up under their account settings with your
agent name next to it, and they can revoke it at any time. Treat it like a
password: never print it, never send it anywhere but the API URL below.
${disabledNotice}
Machine-readable version of this document: \`${discovery.agent_auth_md.replace(/auth\.md$/, "discovery")}\`

## 1. Register yourself

\`\`\`bash
curl -X POST '${discovery.registration_endpoint}' \\
${headers} \\
  -H 'content-type: application/json' \\
  -d '{
    "agent": {
      "name": "<your agent name, e.g. Claude Code>",
      "description": "<one sentence on what you want to do>",
      "url": "<optional homepage>"
    },
    "user_hint": "<optional: the email of the person who should approve>",
    "app_url": "<optional: the URL of the app you are working in, so the confirm link opens there>"
  }'
\`\`\`

Response:

\`\`\`json
{
  "claim_code": "K7PQ-3XWM",
  "confirm_url": "https://.../handler/agent-auth-confirm?code=K7PQ-3XWM",
  "poll_token": "<keep this secret>",
  "expires_at_millis": 1700000000000,
  "anonymous_session": {
    "user_id": "...",
    "access_token": "...",
    "refresh_token": "..."
  }
}
\`\`\`

${anonymousNote}

## 2. Ask the human to approve

Show the user the \`confirm_url\` (or the \`claim_code\` alone if they already
have the app open; it is short on purpose: ${hx.claim_code_format}). Say who you
are and what you want to do. The page asks them to sign in with their normal
account, shows your name and description, and has Approve and Deny buttons.
The code expires ${Math.round(hx.default_attempt_lifetime_millis / 60000)} minutes after registration.

## 3. Poll until approved

\`\`\`bash
curl -X POST '${hx.poll_endpoint}' \\
${headers} \\
  -H 'content-type: application/json' \\
  -d '{ "poll_token": "<poll_token from step 1>" }'
\`\`\`

Poll every 3-5 seconds. \`status\` is one of:

| status     | meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| \`pending\`  | The user has not decided yet. Keep polling.                      |
| \`approved\` | Success. \`session\` contains your tokens. **Returned only once.** |
| \`denied\`   | The user said no. Stop; do not register again without asking.    |
| \`expired\`  | Nobody approved in time. Register again if the user still wants. |
| \`used\`     | You already received the session. Use the tokens you stored.     |

## 4. Call the API as the user

\`\`\`bash
curl '${hx.sessions_endpoint.replace(/\/auth\/sessions$/, "/users/me")}' \\
${authHeaders}
\`\`\`

Access tokens are short-lived. When you get a \`401\`, refresh:

\`\`\`bash
curl -X POST '${discovery.token_endpoint}' \\
${headers} \\
  -H 'x-hexclave-refresh-token: <refresh_token>'
\`\`\`

Your session expires ${Math.round(hx.agent_session_lifetime_millis / (1000 * 60 * 60 * 24))} days after approval, or earlier if the user revokes it.

## 5. Sign out when you are done

\`\`\`bash
curl -X DELETE '${discovery.revocation_endpoint}' \\
${authHeaders}
\`\`\`

## Notes for tool authors

- Project ID: \`${hx.project_id}\`. Every request needs the headers shown above.
- The same flow works from any language; the SDKs are optional.
- Users see and revoke agent sessions in their account settings; \`GET ${hx.sessions_endpoint}\`
  lists them with \`agent_name\` set, so you can also offer a "disconnect" action yourself.
`;
}

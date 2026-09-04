/**
 * Client-side helpers for talking to the GitHub REST API on behalf of a Stack
 * user's connected GitHub account.
 *
 * Kept separate from any React/hook code so the helpers are easy to unit-test
 * and to share between the new-project onboarding flow and the config-update
 * dialog.
 */

import type { OAuthConnection } from "@hexclave/next";
import { isJsonSerializable, type Json, type JsonObject } from "@hexclave/shared/dist/utils/json";

export const GITHUB_SCOPE_REQUIREMENTS = ["repo", "workflow"];

export function isObject(value: unknown): value is JsonObject {
  return isJsonSerializable(value) && typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getObjectString(value: JsonObject, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

export function parseRepositoryFullName(fullName: string): { owner: string, repo: string } {
  const slashIndex = fullName.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= fullName.length - 1 || fullName.indexOf("/", slashIndex + 1) !== -1) {
    throw new Error(`Repository must be in the format 'owner/repo' (got '${fullName}').`);
  }
  return {
    owner: fullName.slice(0, slashIndex),
    repo: fullName.slice(slashIndex + 1),
  };
}

export function encodeGitHubPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function githubRepositoryContentsUrl(owner: string, repo: string, path: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeGitHubPath(path)}`;
}

export type GithubFetch = (path: string, requestInit?: RequestInit) => Promise<Json | null>;

/**
 * Returns a `githubFetch` helper bound to the given OAuth connection. The
 * helper accepts an `api.github.com`-relative path (e.g. "/user") and returns
 * the parsed JSON body. Non-2xx responses are turned into thrown Errors whose
 * message is the GitHub-supplied `message` field when present.
 */
export function createGithubFetch(account: OAuthConnection): GithubFetch {
  return async (path, requestInit) => {
    const tokenResult = await account.getAccessToken({ scopes: GITHUB_SCOPE_REQUIREMENTS });
    if (tokenResult.status === "error") {
      throw new Error("Could not get a GitHub access token. Reconnect your GitHub account and try again.");
    }

    const response = await fetch(new URL(path, "https://api.github.com").toString(), {
      ...requestInit,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenResult.data.accessToken}`,
        ...(requestInit?.headers ?? {}),
      },
    });

    if (response.status === 204) {
      // 204 is always a success status (any 2xx satisfies `response.ok`),
      // so no error check is needed here.
      return null;
    }

    const responseText = await response.text();
    const parsedBody = responseText.length > 0 ? JSON.parse(responseText) : null;

    if (!response.ok) {
      const parsedMessage = isObject(parsedBody) ? getObjectString(parsedBody, "message") : null;
      throw new Error(parsedMessage ?? `GitHub API request failed with status ${response.status}.`);
    }

    return parsedBody;
  };
}

export type GithubFileContent = {
  /** UTF-8 decoded file content. */
  text: string,
  /** Blob SHA — required when updating the file via the Contents API. */
  sha: string,
};

/**
 * Fetches a file via `GET /repos/{owner}/{repo}/contents/{path}` and returns
 * its decoded UTF-8 content plus blob SHA. Returns `null` if the file does not
 * exist on the given branch.
 *
 * Errors that are not 404s (network failures, permission errors, etc.) are
 * re-thrown.
 */
export async function getFileContent(
  githubFetch: GithubFetch,
  options: { owner: string, repo: string, branch: string, path: string },
): Promise<GithubFileContent | null> {
  const { owner, repo, branch, path } = options;
  const refQuery = new URLSearchParams({ ref: branch }).toString();
  try {
    // `cache: "no-store"` because GitHub's Contents API responds with
    // `Cache-Control: private, max-age=60` for authenticated reads, and the
    // browser's HTTP cache is not invalidated by our subsequent PUT to the
    // same URL. Without this, a second push within ~60s reads a stale blob
    // SHA and the PUT fails with 409 "{path} does not match {sha}".
    const response = await githubFetch(`${githubRepositoryContentsUrl(owner, repo, path)}?${refQuery}`, { cache: "no-store" });
    if (!isObject(response) || Array.isArray(response)) {
      // GitHub returns an array when the path is a directory; treat that as
      // "file not found" so the caller surfaces a clear error.
      return null;
    }
    const type = getObjectString(response, "type");
    if (type !== "file") {
      return null;
    }
    const encoding = getObjectString(response, "encoding");
    const rawContent = getObjectString(response, "content");
    const sha = getObjectString(response, "sha");
    if (rawContent == null || sha == null) {
      throw new Error("GitHub file response is missing content or sha.");
    }
    if (encoding !== "base64") {
      throw new Error(`Unexpected GitHub file encoding '${encoding ?? "<missing>"}'.`);
    }
    return {
      text: decodeBase64Utf8(rawContent),
      sha,
    };
  } catch (error) {
    if (error instanceof Error && /Not Found/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

/**
 * Creates or updates a file via `PUT /repos/{owner}/{repo}/contents/{path}`.
 * `sha` is required when updating an existing file (the blob SHA from
 * `getFileContent`) and must be omitted when creating a new file.
 */
export async function commitFile(
  githubFetch: GithubFetch,
  options: {
    owner: string,
    repo: string,
    branch: string,
    path: string,
    content: string,
    message: string,
    sha?: string,
  },
): Promise<void> {
  const { owner, repo, branch, path, content, message, sha } = options;
  const body: Record<string, unknown> = {
    message,
    content: encodeBase64Utf8(content),
    branch,
  };
  if (sha !== undefined) {
    body.sha = sha;
  }
  await githubFetch(githubRepositoryContentsUrl(owner, repo, path), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function decodeBase64Utf8(base64: string): string {
  const stripped = base64.replace(/\s+/g, "");
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(stripped);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  }
  // Node fallback for unit tests.
  return Buffer.from(stripped, "base64").toString("utf-8");
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (typeof globalThis.btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return globalThis.btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

import "server-only";

import { createTvFixtureSnapshot, getTvProfileFixture } from "@/lib/tv-mode/fixtures";
import { TV_FIXTURE_VARIANTS, type TvFixtureVariant } from "@/lib/tv-mode/types";
import { createTvBoxDocument } from "../document";

type TvBoxQaResponseOptions = {
  enabled: string | undefined,
  fixture: string | null,
  nodeEnvironment: string | undefined,
};

function resolveFixtureVariant(value: string | null): TvFixtureVariant | null {
  if (value == null || value === "loading") return null;
  return TV_FIXTURE_VARIANTS.find((candidate) => candidate === value) ?? null;
}

function notFoundResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

export function createTvBoxQaResponse(options: TvBoxQaResponseOptions): Response {
  // This route intentionally has two independent server-side gates. The build
  // environment prevents production exposure, while the explicit opt-in keeps
  // synthetic presentations unavailable during ordinary development.
  if (options.nodeEnvironment !== "development" || options.enabled !== "true") {
    return notFoundResponse();
  }

  const variant = resolveFixtureVariant(options.fixture);
  if (variant == null) return notFoundResponse();

  const profile = getTvProfileFixture("company-pulse");
  if (profile == null) {
    throw new Error("TV Box QA requires the centralized company-pulse fixture profile.");
  }
  const snapshot = createTvFixtureSnapshot("tv-box-qa", profile, variant);
  return new Response(createTvBoxDocument({ mode: "fixture-preview", snapshot }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
}

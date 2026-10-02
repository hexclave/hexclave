// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RegistryDetailContent, selectNewestReleaseId, type RegistryEntry } from "./page-client";

afterEach(() => cleanup());

const release = {
  id: "release-newest",
  version: "1.4.2",
  status: "open",
  ref: "main",
  url: null,
  date_added: "2026-08-26T00:00:00.000Z",
  date_started: null,
  date_released: "2026-08-26T00:00:00.000Z",
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:00:00.000Z",
} satisfies Omit<RegistryEntry, "commits" | "deployments" | "artifacts">;

describe("registry workspace", () => {
  it("selects the newest release once and preserves an explicit selection", () => {
    const releases = [release, { ...release, id: "release-older", version: "1.4.1" }];
    expect(selectNewestReleaseId(null, releases)).toBe("release-newest");
    expect(selectNewestReleaseId("release-older", releases)).toBe("release-older");
  });

  it("renders finalized source-map manifests and debug-ID details inside the release", () => {
    const detail: RegistryEntry = {
      ...release,
      commits: [],
      deployments: [],
      artifacts: {
        next_cursor: null,
        items: [{
          id: "manifest-1",
          manifest_sha256: "a".repeat(64),
          dist: null,
          environment: "development",
          finalized_at: "2026-08-26T00:00:00.000Z",
          debug_ids: [{
            id: "debug-row-1",
            debug_id: "00000000-0000-4000-8000-000000000001",
            code_file: "minified-chunk.js",
            source_map_file: "minified-chunk.js.map",
            source_map_inline: false,
            bundle_bytes: 100,
            source_map_bytes: 200,
            source_map_gzipped_bytes: 150,
          }],
        }],
      },
    };

    render(<RegistryDetailContent detail={detail} view="source-maps" />);

    expect(screen.getByText("development")).toBeTruthy();
    expect(screen.getByText("minified-chunk.js")).toBeTruthy();
    expect(screen.getByText(/Debug ID 00000000/)).toBeTruthy();
    expect(screen.getByText("External map")).toBeTruthy();
  });
});

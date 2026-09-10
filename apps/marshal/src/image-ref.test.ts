import { describe, expect, it } from "vitest";
import { pinToDigest, validateImageRef } from "./image-ref.js";

const DIGEST = `sha256:${"b".repeat(64)}`;

describe("recording which bytes an image reference turned out to mean", () => {
  it("replaces a tag with the digest the platform resolved it to", () => {
    // The whole point: the spec names a pointer, and this is the only place the
    // bytes behind it are written down.
    expect(pinToDigest("docker.io/library/postgres:16", DIGEST)).toBe(`docker.io/library/postgres@${DIGEST}`);
    expect(pinToDigest("ghcr.io/org/app:1.2.3", DIGEST)).toBe(`ghcr.io/org/app@${DIGEST}`);
  });

  it("replaces a digest too, rather than appending a second one", () => {
    // A built service's reference already carries the digest the build pushed.
    // Re-pinning it to what the platform reports is a no-op in practice, but it
    // must not produce a reference with two digests in it.
    expect(pinToDigest(`us-central1-docker.pkg.dev/project/runtime/app@${"sha256:" + "a".repeat(64)}`, DIGEST)).toBe(`us-central1-docker.pkg.dev/project/runtime/app@${DIGEST}`);
  });

  it("does not mistake a registry PORT for a tag", () => {
    // The ":" in "registry.example.com:5000" is a port; the name it belongs to
    // has to survive intact or the recorded reference points at nothing.
    expect(pinToDigest("registry.example.com:5000/team/app:v1", DIGEST)).toBe(`registry.example.com:5000/team/app@${DIGEST}`);
    expect(pinToDigest("registry.example.com:5000/team/app", DIGEST)).toBe(`registry.example.com:5000/team/app@${DIGEST}`);
  });

  it("pins what validateImageRef canonicalized, so one image has one spelling", () => {
    // The two run back to back on a real deploy: the canonical form is what goes
    // into the machine config, and this is what gets recorded for it.
    expect(pinToDigest(validateImageRef("postgres:16", "image").canonical, DIGEST))
      .toBe(`docker.io/library/postgres@${DIGEST}`);
    expect(pinToDigest(validateImageRef("registry-1.docker.io/library/postgres:16", "image").canonical, DIGEST))
      .toBe(`docker.io/library/postgres@${DIGEST}`);
  });
});

describe("the references a target may name, now that nothing resolves them", () => {
  it("still refuses a bare name, which means :latest", () => {
    // Unchanged by dropping resolution, and more load-bearing without it: an
    // unpinned pointer reaching the machine config is the one reference
    // guaranteed to move under a running service.
    expect(() => validateImageRef("postgres", "image")).toThrow(/explicit tag or digest/);
  });

  it("accepts a tag and a digest alike", () => {
    expect(validateImageRef("postgres:16", "image").canonical).toBe("docker.io/library/postgres:16");
    expect(validateImageRef(`postgres@${DIGEST}`, "image").canonical).toBe(`docker.io/library/postgres@${DIGEST}`);
  });
});

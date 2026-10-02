# CLI source-map upload (`hexclave source-maps upload`)

The CLI discovers build artifacts, extracts/injects debug IDs, prepares a
manifest, and uploads bundles plus external source maps through a
register → presign → upload → finalize protocol. The protocol is intentionally
paranoid: every server response field is validated against the locally
prepared plan, and any mismatch aborts the whole upload.

## Discovery and debug IDs

- Bundle files: `.js`, `.mjs`, `.cjs` (case-insensitive), skipping directories
  named `node_modules`, `.git`, and `cache`.
- Debug IDs are lowercase hyphenated UUIDs
  (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`). An
  artifact may carry one as a `//# debugId=<uuid>` pragma, injected into the
  bundle, or derived deterministically from the bundle digest.
- Injection wraps the debug-ID assignment in marker comments:
  start `// hexclave:debug-id-injection:start`, end
  `// hexclave:debug-id-injection:end`, with
  `// hexclave:debug-id-injection:separator` between independent blocks; the
  block regex `(?:SEPARATOR\n)?START\n[\s\S]*?\nEND\n?` removes previously
  injected blocks before re-injection so re-runs are idempotent.
- Bundles also get a `debugJsIdentifier` token prefixed `hexclave-dbid-`
  followed by the UUID (used by runtime error capture to report the debug ID).
- Existing `sourceMappingURL` comments are matched with
  `^[ \t]*\/\/[#@][ \t]*sourceMappingURL=([^\s]*)[ \t]*$`. A bundle whose map
  is inline (data URI) uploads no separate map file; an external `.map` file
  next to the bundle is gzipped (Node `zlib.gzipSync`) for upload.
- Next.js note surfaced to users when server maps appear missing:
  `experimental: { serverSourceMaps: true }`.

## Manifest

Prepared artifacts produce a canonical JSON manifest with one entry per
artifact:

    {
      schema_version,
      release, deployment_key?, environment?,
      dist?,
      name?,
      artifacts: [{
        debug_id,            // lowercase hyphenated UUID
        code_file,           // repo-relative bundle path
        source_map_file,     // repo-relative .map path, or null for inline
        bundle_sha256,       // hex sha256 of the exact uploaded bundle bytes
        bundle_bytes,
        source_map_sha256?,  // of the UNCOMPRESSED map bytes
        source_map_bytes?,   // uncompressed size
        source_map_gzip_sha256?,  // of the gzipped bytes actually uploaded
        source_map_gzip_bytes?,
      }],
    }

`manifest_sha256` = lowercase hex sha256 over the exact manifest JSON bytes.
The plan is frozen at preparation time: if recomputing it before upload yields
a different manifest or digest, the CLI aborts ("upload plan changed after
preparation") so artifact digests can never diverge from what was built.

## Protocol

Constants: registration path `/api/latest/source-maps/artifacts`; finalize
path `/api/latest/source-maps/artifacts/finalize`; request timeout 60 s; up to
3 attempts with retry delay capped at 5 s; response bodies capped at 2 MiB.
Auth is either a server secret key (`x-stack-access-type: server`,
`x-stack-project-id`, `x-stack-secret-server-key` headers) or an admin session
(`x-stack-access-type: admin`, `x-stack-project-id`,
`x-stack-admin-access-token` refreshed per request).

1. **Register** — `POST /api/latest/source-maps/artifacts` with
   `{ manifest, manifest_sha256 }`.
2. **Presign** — the registration response IS the presign step. Validate it
   against the local plan, field by field:
   - `status` must be `"registered"` or `"already_registered"`.
   - Echoed `manifest_sha256` must equal the local digest, else abort.
   - `finalize_path` must be exactly the known finalize path, else abort.
   - Every returned artifact must match a prepared artifact by `debug_id`
     (unknown/duplicate IDs abort), preserve its prepared `code_file` /
     `source_map_file` identities exactly, keep object keys consistent with
     inline-vs-external (`bundle_object_key` non-empty; `source_map_object_key`
     present iff the map is external), and carry presigned upload URLs that
     pass URL validation (https only, expected host) —
     `bundle_upload_url` required, `source_map_upload_url` present iff
     external. Each artifact reports `already_finalized`; artifacts already
     finalized in storage skip the upload step entirely.
3. **Upload** — for each not-yet-finalized artifact: PUT the bundle to
   `bundle_upload_url` as `application/javascript` (re-read from disk and
   verified to still hash to the manifest's `bundle_sha256` immediately before
   upload), then PUT the gzipped map to `source_map_upload_url` as
   `application/json` with `Content-Encoding: gzip`.
4. **Finalize** — `POST <finalize_path>` with
   `{ manifest_sha256 }`. The echoed digest must match again. Response lists
   `uploaded` and `already_uploaded` debug IDs, which must exactly cover the
   prepared artifact set without duplicates; the union is reported to the user
   (`uploaded` vs "already had" counts).

Any protocol violation throws a typed source-map upload error naming the
failing operation ("registration"/"finalize") and the offending value; HTTP
error bodies are surfaced truncated to 1,000 characters after stripping
markup.

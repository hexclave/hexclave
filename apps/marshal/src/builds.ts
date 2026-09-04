import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { BASE_IMAGE, BASE_IMAGE_WORKDIR, BUILDER_IMAGE, BUILD_DOCKERFILE_DIR, BUILD_ENV_DIR, BUILD_TIMEOUT_SECONDS, RAILPACK_BUILDKIT_TMPFS_SIZE, RAILPACK_CLI_SHA256, RAILPACK_CLI_URL, RAILPACK_FRONTEND_IMAGE, getConfig } from "./config.js";
import { builderInstanceName } from "./naming.js";
import { presignValidatedUploadGet } from "./store.js";
import type { ReconciliationLeaseGuard } from "./reconciliation-lock.js";
import type { EnvValue } from "./types.js";
import { tenantContext } from "./gcp/context.js";

// The completion webhook's path, in one place. app.ts authenticates /internal/* in
// onRequest, BEFORE any handler runs, by matching this prefix — so a path that only the
// route below knows about is rejected as an unknown internal route and no build can ever
// complete. Both sides derive from this constant rather than re-typing the path.
export const INTERNAL_COMPLETE_PATH_PREFIX = "/internal/deployments/";

/** Where the builder harness POSTs its completion for `deploymentId`. */
export function buildCompletionPath(deploymentId: string): string {
  return `${INTERNAL_COMPLETE_PATH_PREFIX}${deploymentId}/complete`;
}

// Builders start a build for an uploaded source tarball; completion always flows through
// the webhook path (POST /internal/deployments/:deploymentId/complete →
// services.completeBuild), so the two implementations stay behaviorally identical:
//  - gcp:  ephemeral per-build Compute Engine VM running BuildKit; it calls the webhook.
//  - mock: dev/e2e only; "completes" in-process on the next tick with a deterministic
//          fake digest.

// One image to build within a deployment's single builder machine.
export type BuildTarget = {
  serviceKey: string,
  // Where to push the built image in the tenant's Artifact Registry repository.
  pushTarget: string,
  // Upload-root-relative Dockerfile to build from; null = Railpack
  // auto-detection, unless `baseImage` selects a generated Dockerfile instead.
  dockerfilePath: string | null,
  // Where detection starts, relative to the upload root. The build CONTEXT is
  // always the whole upload — a monorepo service usually has to reach shared
  // code above its own directory — so this only narrows where the builder looks
  // for a build to infer, never what it can COPY.
  rootDirectory: string | null,
  // Set when this target is built from a GENERATED Dockerfile: the image that
  // Dockerfile starts FROM, which is either the author's own `image` (a
  // build command turns it from the thing to run into the thing to build on) or
  // Marshal's BASE_IMAGE. Null for the Dockerfile and Railpack paths.
  //
  // Decided by the caller rather than re-derived here, so the rule that says
  // which of the three build kinds a target is lives in exactly one place.
  baseImage: string | null,
  // A single command line to run while the image is built; null = none.
  // Guaranteed by validateDeploymentRequest to be one line with no control
  // characters, which is what lets it be written into a Dockerfile at all.
  buildCommand: string | null,
  // The tenant env THIS target's build gets to see (buildTimeEnv of its spec).
  // Per target rather than per build: one machine builds them all, but a value
  // belonging to one service must not end up inlined into another's image.
  buildEnv: Record<string, string>,
};

/**
 * The Dockerfile Marshal generates for one target, or the lines it appends to
 * the author's own — the whole difference being whether the target names a base
 * image or a Dockerfile.
 *
 * Generated HERE, in TypeScript, rather than assembled by the /bin/sh harness:
 * the harness has no JSON, no quoting primitives worth the name, and reads its
 * per-target inputs out of a tab-separated manifest that a command containing a
 * tab or a newline would break. Building the file here and injecting it through
 * the machine `files` API keeps every value out of shell entirely.
 *
 * Returns null when the target needs neither (a plain Dockerfile or Railpack
 * build with no build command).
 */
export function generatedDockerfile(target: BuildTarget): { path: "Dockerfile" | "suffix", contents: string } | null {
  const runLine = target.buildCommand === null
    ? null
    // EXEC form, with the command JSON-encoded: shell form would make the
    // command a line of a Dockerfile, where a trailing backslash continues onto
    // the next instruction and a `#` at the start is a comment. JSON.stringify
    // is the encoder for exactly this, and the `sh -c` wrapper is what keeps
    // `&&`, pipes and `$VAR` expansion working inside it. Build args still reach
    // it: BuildKit exposes them to the RUN as environment variables regardless
    // of which form the instruction uses.
    : `RUN ["/bin/sh", "-c", ${JSON.stringify(target.buildCommand)}]`;
  // A build ARG per build-visible env var, which is how the values reach the
  // command: `--opt build-arg:KEY=value` reaches a stage ONLY if that stage
  // declares `ARG KEY`, and BuildKit then exposes it to the RUN as an
  // environment variable. Declaring them here is therefore what makes "every env
  // var is available to your build command, exactly as in a Railpack build"
  // true — on the appended path especially, where the author's own Dockerfile
  // has no reason to have declared Hexclave's variables.
  //
  // Sorted so two builds of one target generate byte-identical Dockerfiles, and
  // so a layer cache (a future builder that has one) is not missed over key
  // order. The keys are already constrained to /^[A-Za-z_][A-Za-z0-9_]*$/, which
  // is why they can be written unquoted. Re-declaring one the author already
  // declared is harmless: it re-scopes the same value.
  const argLines = Object.keys(target.buildEnv).sort().map((key) => `ARG ${key}`);
  if (target.baseImage === null) {
    // The author's Dockerfile describes a complete build already, so nothing is
    // copied in that it did not copy itself; the command is simply the last
    // thing that runs, in whatever WORKDIR and as whatever USER the Dockerfile
    // left behind.
    //
    // The leading newline is load-bearing: the harness concatenates this onto a
    // file that is not guaranteed to end in one, and without it the appended RUN
    // would glue itself to the author's last instruction.
    return runLine === null ? null : { path: "suffix", contents: `\n${[...argLines, runLine].join("\n")}\n` };
  }
  // The runtime's own base image ships node, npm, yarn and corepack, but NOT a
  // pnpm binary — corepack only installs the shims when told to. One line here is
  // what makes "pnpm is preinstalled" true, and it respects a `packageManager`
  // field if the project has one.
  //
  // Only for OUR base: an author's own image is not ours to assume anything
  // about, and `corepack enable` on an image without corepack would fail the
  // build before their command ever ran.
  const setupLines = target.baseImage === BASE_IMAGE ? ["RUN corepack enable"] : [];
  // COPY before WORKDIR: the copy targets the whole upload root, and the WORKDIR
  // is where the command runs INSIDE it. A rootDirectory of "." (or none) leaves
  // the working directory at the root itself.
  //
  // The `$` is ESCAPED: a Dockerfile expands variables in a WORKDIR path, and the
  // ARG lines above put every build-visible name in scope — so a real directory
  // named `apps/$APP` (legal on disk, and accepted by every path check on the way
  // here) would otherwise expand to something else, or to nothing.
  const workdir = target.rootDirectory === null || target.rootDirectory === "." || target.rootDirectory === ""
    ? BASE_IMAGE_WORKDIR
    : `${BASE_IMAGE_WORKDIR}/${target.rootDirectory.replaceAll("$", "\\$")}`;
  return {
    path: "Dockerfile",
    contents: [
      `FROM ${target.baseImage}`,
      ...setupLines,
      ...argLines,
      // The whole upload, not just the service's own directory: a monorepo
      // service usually has to reach shared code above it, which is the same
      // reason the build CONTEXT is the whole upload on every other path.
      `COPY . ${BASE_IMAGE_WORKDIR}`,
      `WORKDIR ${workdir}`,
      ...(runLine === null ? [] : [runLine]),
      // Deliberately no CMD. The start command is machine configuration, applied
      // by the runtime as the machine's init — so an image built here starts
      // whatever its BASE started, and a base with nothing to start is exactly
      // why a start command is required on that path.
      "",
    ].join("\n"),
  };
}

export type StartBuildOptions = {
  ns: string,
  // The deployment this build belongs to; also the id of its validated upload
  // object and of its persisted log.
  deploymentId: string,
  uploadId: string,
  // Built in this order, in ONE machine. The first failure aborts the rest: the
  // whole deployment fails, so there is no half-built cluster to salvage.
  targets: BuildTarget[],
};

// ONE env channel, Vercel-style: every declared env var goes to both the build and the
// runtime, secrets included. There is deliberately no build/runtime marker on the wire and
// no allowlist of which vars qualify — a framework that inlines values (NEXT_PUBLIC_*,
// VITE_*) has to see them while it compiles, and nothing in a ServiceSpec says which vars
// those are, so guessing would just be a different way to be wrong.
//
// `{ ref }` values are the one exception, and only because they are unresolvable rather
// than withheld: a ref names an output (url, hostname) of a service that has not been
// rolled out yet, so at build time there is nothing to resolve it to. Nothing to flag or
// reject — it simply isn't there.
export function buildTimeEnv(env: Record<string, EnvValue>): Record<string, string> {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(env)) {
    if ("value" in value) entries.push([key, value.value]);
  }
  return Object.fromEntries(entries);
}

export function buildEnvByteLength(env: Record<string, string>): number {
  let total = 0;
  for (const [key, value] of Object.entries(env)) {
    total += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
  }
  return total;
}

export type Builder = {
  name: string,
  startBuild: (options: StartBuildOptions, lease: ReconciliationLeaseGuard) => Promise<{ builderApp: string | null, builderMachineId: string | null }>,
};

// Per-deployment webhook token: HMAC over (deploymentId, ns) so a stolen token can't
// complete a different deployment, and Marshal can verify statelessly.
export function computeWebhookToken(deploymentId: string, ns: string): string {
  return createHmac("sha256", getConfig().webhookSecret).update(`${deploymentId}\0${ns}`).digest("hex");
}

export function verifyWebhookToken(token: string, deploymentId: string, ns: string): boolean {
  const expected = computeWebhookToken(deploymentId, ns);
  const provided = Buffer.from(token, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

// The harness: BuildKit plus a small shell wrapper, injected through VM metadata.
// Its stdout doubles as the live build log (Compute Engine serial output). The VM env block carries
// only Marshal's own credentials (tarball URL, registry auth, webhook callback) — the
// TENANT's env arrives as files instead, one per var under $BUILD_ENV_DIR, so that a value
// can never be confused with a credential and `env` in a log dump stays free of both.
// On success it POSTs buildctl's metadata JSON (which contains containerimage.digest);
// Marshal falls back to a registry HEAD if that ever comes back unparseable.
//
// Two build modes, selected by DOCKERFILE_PATH:
//  - non-empty: a classic Dockerfile build (dockerfile.v0 frontend, --opt filename).
//  - empty: Railpack auto-detection — the pinned railpack CLI analyzes the source into a
//    build plan that the pinned railpack BuildKit frontend executes. No Dockerfile is ever
//    picked up implicitly.
export function buildHarnessScript(): string {
  return `#!/bin/sh
set -u
webhook() {
  wget -qO- --header "Authorization: Bearer $WEBHOOK_TOKEN" --header "Content-Type: $2" \\
    --post-file "$3" "$WEBHOOK_URL&status=$1" || \\
  wget -qO- --header "Authorization: Bearer $WEBHOOK_TOKEN" --header "Content-Type: $2" \\
    --post-file "$3" "$WEBHOOK_URL&status=$1" || true
}
fail() {
  echo "MARSHAL_BUILD_FAILED: $1"
  printf '%s' "$1" > /tmp/error.txt
  webhook failed text/plain /tmp/error.txt
  exit 1
}
( sleep "$BUILD_TIMEOUT_SECONDS"
  echo "MARSHAL_BUILD_TIMEOUT"
  printf '%s' "build timed out after $BUILD_TIMEOUT_SECONDS seconds" > /tmp/timeout.txt
  webhook failed text/plain /tmp/timeout.txt
  kill -9 -1 ) &
echo "MARSHAL_BUILD_START"
# Buildkit's overlayfs snapshotter needs an upperdir that is not itself an overlayfs, and the
# machine rootfs IS one — so without help buildkit silently falls back to the native
# (full-copy-per-layer) snapshotter, slow enough that large base images time the build out.
#
# Two filesystems on the machine can serve as that upperdir, and the order matters:
#
#  - a tmpfs, which is fast but is unswappable RAM. Every byte the snapshot store holds is
#    taken from the build itself, so the guest must be big enough for BOTH (see
#    RAILPACK_BUILDER_GUEST). Undersized, this is what an 8g guest with a 6g tmpfs died of:
#    the store filled and a large "next build" hit ENOSPC, and a hungrier one is OOM-killed
#    at ~1.3g RSS while the kernel holds ~6g of snapshots it cannot reclaim.
#  - a disk-backed ext4 directory mounted at $BUILDKIT_DISK_DIR. It is a legal upperdir and
#    costs no RAM, but is materially slower than tmpfs. Hence second, not first.
#
# It is still far better than the third outcome: on the native snapshotter a build does not
# fail, it silently gets slow enough to time out.
BUILDKIT_DISK_DIR=/.marshal-buildkit-disk
BUILDKIT_ROOT=""
BUILDKIT_STORE_READY=""
if [ -n "\${BUILDKIT_TMPFS_SIZE:-}" ]; then
  mkdir -p /var/lib/buildkit
  if mount -t tmpfs -o "size=$BUILDKIT_TMPFS_SIZE" tmpfs /var/lib/buildkit; then
    BUILDKIT_STORE_READY=1
    echo "MARSHAL_BUILDKIT_STORE tmpfs $BUILDKIT_TMPFS_SIZE"
  else
    echo "MARSHAL_TMPFS_MOUNT_FAILED (falling back to the disk-backed snapshot store)"
  fi
fi
# $2/$3 of /proc/mounts are the mount point and the fs type. Requiring an exact mount point
# (not just a directory that exists) is what proves this is a separate filesystem rather than
# a plain directory on the overlay, which would put us straight back on the native snapshotter.
if [ -z "$BUILDKIT_STORE_READY" ] && awk -v dir="$BUILDKIT_DISK_DIR" '$2 == dir && $3 != "overlay" { ok = 1 } END { exit !ok }' /proc/mounts 2>/dev/null; then
  BUILDKIT_ROOT="$BUILDKIT_DISK_DIR/buildkit"
  mkdir -p "$BUILDKIT_ROOT"
  echo "MARSHAL_BUILDKIT_STORE disk $BUILDKIT_DISK_DIR"
fi
if [ -n "$BUILDKIT_ROOT" ]; then
  buildkitd --root "$BUILDKIT_ROOT" >/tmp/buildkitd.log 2>&1 &
else
  buildkitd >/tmp/buildkitd.log 2>&1 &
fi
i=0
until buildctl debug workers >/dev/null 2>&1; do
  i=$((i+1)); [ $i -gt 60 ] && fail "buildkitd did not start"
  sleep 1
done
# Which snapshotter buildkit actually chose. Echoed because the fallback is silent: on the
# native one a build does not fail, it just gets slow enough to hit BUILD_TIMEOUT_SECONDS.
grep -o "auto snapshotter: using [a-z]*" /tmp/buildkitd.log | head -n 1
mkdir -p /ctx
# Fetch and extract OUTSIDE the context dir, then extract INTO it — otherwise the tarball
# itself sits in the build context and a plain \`COPY . .\` bakes a compressed copy of the
# whole source tree into the user's image.
# Marshal validates the archive and copies it to an immutable, deployment-specific object
# before this machine receives credentials. The original client-writable upload is never
# extracted.
wget -q -O /tmp/ctx.tar.gz "$TARBALL_URL" || fail "failed to fetch the source tarball"
tar xzf /tmp/ctx.tar.gz -C /ctx || fail "the source tarball is not a valid gzipped tarball"
cd /ctx
mkdir -p /root/.docker
printf '{"auths":{"%s":{"auth":"%s"}}}' "$REGISTRY_HOST" "$REGISTRY_AUTH_B64" > /root/.docker/config.json

# Tenant build-time env, one directory per TARGET and one file per var inside it (filename =
# var name, contents = the exact value). Per target because one machine builds every service
# of the deployment: a value belonging to one service must never be offered to another's
# build, where a framework that inlines values would bake it into the wrong image.
# Nothing here echoes a value; the helpers print only names and paths.
target_env_dir() { printf '%s/%s' "$BUILD_ENV_DIR" "$1"; }
# Deliberately unquoted at the call site: word-splitting IS the mechanism, and var names
# (and the fixed dir) contain no whitespace, so each printf below becomes exactly two words.
secret_args() {
  [ -d "$1" ] || return 0
  for f in "$1"/*; do
    [ -f "$f" ] || continue
    printf ' --secret id=%s,src=%s' "\${f##*/}" "$f"
  done
}
# Railpack's frontend keys its layer cache on this: without it, a changed secret would reuse
# the layer built from the old one. Every builder here is ephemeral so there is no cache to
# poison today, but the frontend's contract is what it is and the hash is nearly free.
secrets_hash() {
  [ -d "$1" ] || return 0
  for f in "$1"/*; do
    [ -f "$f" ] || continue
    printf '%s=' "\${f##*/}"; cat "$f"; printf '\\n'
  done | sha256sum | cut -d' ' -f1
}

# One line per target: <service_key>TAB<push_target>TAB<dockerfile_path>TAB<root_directory>.
# A tab-separated manifest rather than JSON because this is /bin/sh with no jq, and every
# field is already validated by Marshal to contain no tabs, newlines or control characters.
# Empty dockerfile_path selects Railpack auto-detection; empty root_directory means the
# upload root.
DIGESTS=""
# The tab comes from printf: POSIX sh does not expand backslash escapes inside double quotes,
# so a literal "\\t" here would be the two characters backslash and t.
TAB="$(printf '\\t')"
# Read the WHOLE line (IFS= disables splitting and trimming) and cut the fields by hand.
# A four-variable "read" with IFS set to a tab cannot do this: a tab is IFS WHITE SPACE, so a
# run of them collapses into one delimiter — and an empty dockerfile_path (Railpack
# auto-detection) would silently shift root_directory into DOCKERFILE_PATH, building a
# Dockerfile at a directory path. Both fields are optional, so both empties are the common
# case, not an edge one.
while IFS= read -r TARGET_LINE; do
  [ -n "$TARGET_LINE" ] || continue
  SERVICE_KEY="\${TARGET_LINE%%"$TAB"*}"
  TARGET_REST="\${TARGET_LINE#*"$TAB"}"
  PUSH_TARGET="\${TARGET_REST%%"$TAB"*}"
  TARGET_REST="\${TARGET_REST#*"$TAB"}"
  DOCKERFILE_PATH="\${TARGET_REST%%"$TAB"*}"
  ROOT_DIRECTORY="\${TARGET_REST#*"$TAB"}"
  [ -n "$SERVICE_KEY" ] || continue
  echo "MARSHAL_TARGET_START $SERVICE_KEY"
  ENV_DIR="$(target_env_dir "$SERVICE_KEY")"
  # Where Marshal injected this target's generated Dockerfile (or the suffix to
  # append to the author's), if it generated one. Deliberately not under /ctx.
  GEN_DIR="$BUILD_DOCKERFILE_DIR/$SERVICE_KEY"
  # The build CONTEXT is always the whole upload, so a monorepo service can COPY shared code
  # from above its own directory. ROOT_DIRECTORY only says where a Dockerfile-less build
  # should look for something to infer.
  DETECT_DIR="/ctx"
  if [ -n "$ROOT_DIRECTORY" ]; then
    [ -d "/ctx/$ROOT_DIRECTORY" ] || fail "$SERVICE_KEY: rootDirectory $ROOT_DIRECTORY does not exist in the uploaded source"
    DETECT_DIR="/ctx/$ROOT_DIRECTORY"
  fi
  # The Dockerfile-shaped build arguments, shared by both Dockerfile paths below:
  # every build-visible var as a secret mount (byte-exact, unbaked) and as a build
  # ARG (the channel a plain \`ARG FOO\` reads, and the one a generated Dockerfile
  # declares). The Railpack branch resets them; it feeds railpack instead.
  set -- $(secret_args "$ENV_DIR")
  if [ -d "$ENV_DIR" ]; then
    for f in "$ENV_DIR"/*; do
      [ -f "$f" ] || continue
      # \\$(cat) drops trailing newlines — a build ARG is a command-line string, so a value
      # ending in one cannot survive this channel. The secret mount above is byte-exact.
      set -- "$@" --opt "build-arg:\${f##*/}=$(cat "$f")"
    done
  fi
  # Three build kinds, in the order that decides them:
  #  - a GENERATED Dockerfile (Marshal wrote one: a base image with the upload copied in),
  #  - the author's Dockerfile, optionally with a Marshal-written suffix appended,
  #  - Railpack auto-detection.
  # Marshal decides which by what it injected into $GEN_DIR, so the harness never
  # re-derives the rule — it only looks for the files.
  if [ -f "$GEN_DIR/Dockerfile" ]; then
    echo "MARSHAL_GENERATED_DOCKERFILE $SERVICE_KEY"
    # The generated file lives OUTSIDE /ctx (it is not part of the author's source
    # and must not appear in their \`COPY . .\`), which is fine: \`filename\` is
    # resolved against the dockerfile local, and every COPY inside it against the
    # context local, which is still the whole upload.
    if ! buildctl build --frontend dockerfile.v0 --local context=/ctx --local dockerfile="$GEN_DIR" \\
        --opt "filename=Dockerfile" "$@" \\
        --output "type=image,name=$PUSH_TARGET,push=true" --metadata-file /tmp/md.json 2>&1; then
      fail "$SERVICE_KEY: the build failed (see the build log above)"
    fi
  elif [ -n "$DOCKERFILE_PATH" ]; then
    [ -f "/ctx/$DOCKERFILE_PATH" ] || fail "$SERVICE_KEY: no Dockerfile found at $DOCKERFILE_PATH in the uploaded source"
    DOCKERFILE_DIR=/ctx
    DOCKERFILE_NAME="$DOCKERFILE_PATH"
    # A build command on a Dockerfile build is appended as a final RUN. Written to
    # a scratch directory rather than back into /ctx: the context is the author's
    # source, and a file added to it would land in their own \`COPY . .\`.
    if [ -f "$GEN_DIR/suffix" ]; then
      echo "MARSHAL_APPEND_BUILD_COMMAND $SERVICE_KEY"
      mkdir -p "/tmp/dockerfiles/$SERVICE_KEY"
      cat "/ctx/$DOCKERFILE_PATH" "$GEN_DIR/suffix" > "/tmp/dockerfiles/$SERVICE_KEY/Dockerfile" \\
        || fail "$SERVICE_KEY: could not append the build command to $DOCKERFILE_PATH"
      # A Dockerfile-SPECIFIC ignore file is found by name next to the Dockerfile
      # ("docker/web.Dockerfile.dockerignore"), so moving the file out of /ctx
      # would silently stop applying it — and a build that suddenly stops
      # excluding things bakes them into the image instead. Carried across under
      # the name the relocated file now has. (The context-wide /ctx/.dockerignore
      # still applies on its own: the context local is unchanged.)
      if [ -f "/ctx/$DOCKERFILE_PATH.dockerignore" ]; then
        cp "/ctx/$DOCKERFILE_PATH.dockerignore" "/tmp/dockerfiles/$SERVICE_KEY/Dockerfile.dockerignore" \\
          || fail "$SERVICE_KEY: could not carry over $DOCKERFILE_PATH.dockerignore"
      fi
      DOCKERFILE_DIR="/tmp/dockerfiles/$SERVICE_KEY"
      DOCKERFILE_NAME=Dockerfile
    fi
    if ! buildctl build --frontend dockerfile.v0 --local context=/ctx --local dockerfile="$DOCKERFILE_DIR" \\
        --opt "filename=$DOCKERFILE_NAME" "$@" \\
        --output "type=image,name=$PUSH_TARGET,push=true" --metadata-file /tmp/md.json 2>&1; then
      fail "$SERVICE_KEY: docker build failed (see the build log above)"
    fi
  else
    echo "MARSHAL_RAILPACK_DETECT $SERVICE_KEY"
    if [ ! -f /tmp/railpack-bin/railpack ]; then
      wget -q -O /tmp/railpack.tar.gz "$RAILPACK_CLI_URL" || wget -q -O /tmp/railpack.tar.gz "$RAILPACK_CLI_URL" || fail "failed to fetch the railpack CLI (a build-infrastructure problem, not an issue with your code)"
      echo "$RAILPACK_CLI_SHA256  /tmp/railpack.tar.gz" | sha256sum -c - >/dev/null 2>&1 || fail "the railpack CLI download failed checksum verification (a build-infrastructure problem, not an issue with your code)"
      mkdir -p /tmp/railpack-bin
      tar xzf /tmp/railpack.tar.gz -C /tmp/railpack-bin || fail "failed to extract the railpack CLI (a build-infrastructure problem, not an issue with your code)"
      [ -x /tmp/railpack-bin/railpack ] || fail "the railpack CLI archive did not contain the expected binary (a build-infrastructure problem, not an issue with your code)"
    fi
    # The plan gets its own directory: it is transferred to the frontend as the whole
    # "dockerfile" local, which must not drag /tmp scratch files along. The CLI runs in a
    # subshell with the build credentials stripped — unlike Dockerfile RUN steps (sandboxed by
    # buildkit), it executes directly in this harness, and it has no business seeing them.
    rm -rf /tmp/railpack-plan && mkdir -p /tmp/railpack-plan
    # railpack sees the env twice, for two different reasons. Here, --env is what DETECTION
    # reads (a NODE_VERSION or a RAILPACK_* knob changes the plan it emits) and what makes it
    # list each name in the plan's "secrets"; the values themselves never enter the plan file.
    # Below, buildctl supplies those same names as secret mounts, which the railpack frontend
    # exposes as environment variables on every build step — that is the channel a "next
    # build" actually reads NEXT_PUBLIC_* from.
    set --
    if [ -d "$ENV_DIR" ]; then
      for f in "$ENV_DIR"/*; do
        [ -f "$f" ] || continue
        set -- "$@" --env "\${f##*/}=$(cat "$f")"
      done
    fi
    if ! ( unset REGISTRY_AUTH_B64 WEBHOOK_TOKEN WEBHOOK_URL TARBALL_URL; cd "$DETECT_DIR" && /tmp/railpack-bin/railpack prepare . --plan-out /tmp/railpack-plan/railpack-plan.json "$@" 2>&1 ); then
      fail "$SERVICE_KEY: railpack could not determine how to build this service (see the log above) — set a buildCommand in your deploy file to say how to build it, add a Dockerfile and set dockerfilePath, or configure detection with a railpack.json (https://railpack.com)"
    fi
    set -- $(secret_args "$ENV_DIR")
    if [ "$#" -gt 0 ]; then set -- "$@" --opt "build-arg:secrets-hash=$(secrets_hash "$ENV_DIR")"; fi
    if ! buildctl build --frontend gateway.v0 --opt "source=$RAILPACK_FRONTEND_IMAGE" \\
        --local context="$DETECT_DIR" --local dockerfile=/tmp/railpack-plan "$@" \\
        --output "type=image,name=$PUSH_TARGET,push=true" --metadata-file /tmp/md.json 2>&1; then
      fail "$SERVICE_KEY: railpack build failed (see the build log above)"
    fi
  fi
  DIGEST="$(sed -n 's/.*"containerimage.digest"[^"]*"\\([^"]*\\)".*/\\1/p' /tmp/md.json | head -n 1)"
  [ -n "$DIGEST" ] || fail "$SERVICE_KEY: the build produced no image digest"
  # Accumulated as JSON by hand: service keys and digests are both validated to be
  # alphanumeric-ish, so no escaping is needed and there is no jq in this image.
  if [ -n "$DIGESTS" ]; then DIGESTS="$DIGESTS,"; fi
  DIGESTS="$DIGESTS\\"$SERVICE_KEY\\":\\"$DIGEST\\""
  echo "MARSHAL_TARGET_DONE $SERVICE_KEY"
done < /marshal-targets.tsv
printf '{"targets":{%s}}' "$DIGESTS" > /tmp/result.json
webhook succeeded application/json /tmp/result.json
echo "MARSHAL_BUILD_DONE"
`;
}

export function createGcpBuilder(): Builder {
  return {
    name: "gcp",
    async startBuild(options, lease) {
      const config = getConfig();
      if (config.publicUrl === null) {
        throw new Error("MARSHAL_PUBLIC_URL must be set for real GCP builds — the builder VM calls the completion webhook on it");
      }
      const context = await tenantContext(options.ns);
      await lease.assertOwned();
      await context.artifactRegistry.ensureRepository();
      const tarballUrl = await presignValidatedUploadGet(options.ns, options.deploymentId, BUILD_TIMEOUT_SECONDS + 60);
      const webhookToken = computeWebhookToken(options.deploymentId, options.ns);
      const webhookUrl = `${config.publicUrl}${buildCompletionPath(options.deploymentId)}?ns=${encodeURIComponent(options.ns)}`;
      const targetsManifest = options.targets
        .map((target) => [target.serviceKey, target.pushTarget, target.dockerfilePath ?? "", target.rootDirectory ?? ""].join("\t"))
        .join("\n");
      const isRailpackBuild = options.targets.some((target) => target.dockerfilePath === null && target.baseImage === null);
      const files = [
        { path: "/marshal-build.sh", contentsBase64: Buffer.from(buildHarnessScript()).toString("base64") },
        { path: "/marshal-targets.tsv", contentsBase64: Buffer.from(`${targetsManifest}\n`, "utf8").toString("base64") },
        ...options.targets.flatMap((target) => Object.entries(target.buildEnv).flatMap(([key, value]) => value === "" ? [] : [{
          path: `${BUILD_ENV_DIR}/${target.serviceKey}/${key}`,
          contentsBase64: Buffer.from(value, "utf8").toString("base64"),
        }])),
        ...options.targets.flatMap((target) => {
          const generated = generatedDockerfile(target);
          return generated === null ? [] : [{
            path: `${BUILD_DOCKERFILE_DIR}/${target.serviceKey}/${generated.path}`,
            contentsBase64: Buffer.from(generated.contents, "utf8").toString("base64"),
          }];
        }),
      ];
      await lease.assertOwned();
      const machine = await context.compute.createBuilder({
        name: builderInstanceName(config.envId, options.deploymentId),
        image: BUILDER_IMAGE,
        machineType: isRailpackBuild ? "e2-standard-4" : "e2-standard-2",
        diskSizeGb: isRailpackBuild ? 50 : 30,
        files,
        env: {
          BUILD_ENV_DIR,
          BUILD_DOCKERFILE_DIR,
          TARBALL_URL: tarballUrl,
          REGISTRY_HOST: context.artifactRegistry.registryHost,
          WEBHOOK_URL: webhookUrl,
          WEBHOOK_TOKEN: webhookToken,
          BUILD_TIMEOUT_SECONDS: String(BUILD_TIMEOUT_SECONDS),
          RAILPACK_CLI_URL,
          RAILPACK_CLI_SHA256,
          RAILPACK_FRONTEND_IMAGE,
          ...(isRailpackBuild ? { BUILDKIT_TMPFS_SIZE: RAILPACK_BUILDKIT_TMPFS_SIZE } : {}),
        },
      });
      return { builderApp: context.project.projectId, builderMachineId: machine.name };
    },
  };
}

export type CompleteBuildFn = (options: {
  ns: string,
  deploymentId: string,
  status: "succeeded" | "failed",
  // On success: the JSON the harness posts, `{"targets":{"<service_key>":"sha256:..."}}`.
  metadataJson: string | null,
  errorText: string | null,
}) => Promise<void>;

export function createMockBuilder(completeBuild: CompleteBuildFn): Builder {
  return {
    name: "mock",
    async startBuild(options, lease) {
      await lease.assertOwned();
      // Test hook: a target whose build env declares MARSHAL_MOCK_FAIL_BUILD fails the
      // whole build — the only way e2e can exercise the failure path with an instant fake
      // builder, and it fails the whole deployment exactly as a real build would.
      const shouldFail = options.targets.some((target) => Object.hasOwn(target.buildEnv, "MARSHAL_MOCK_FAIL_BUILD"));
      // Deterministic fake digests so e2e assertions and image mapping are stable. Derived
      // per target from the deployment id, since one build now produces several images.
      // Hashed rather than assembled from the ids themselves: a digest must be 64 HEX
      // characters to survive parseBuildImages, and a service key is free to contain
      // letters that hex does not have.
      const digests = Object.fromEntries(options.targets.map((target) => [
        target.serviceKey,
        `sha256:${createHash("sha256").update(`${options.deploymentId}-${target.serviceKey}`).digest("hex")}`,
      ]));
      // Complete on the next tick, mirroring the real flow's asynchrony without making the
      // request wait on the rollout.
      setTimeout(() => {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- errors are handled inside
        (async () => {
          try {
            await completeBuild({
              ns: options.ns,
              deploymentId: options.deploymentId,
              status: shouldFail ? "failed" : "succeeded",
              metadataJson: shouldFail ? null : JSON.stringify({ targets: digests }),
              errorText: shouldFail ? "mock build failed (a target declares MARSHAL_MOCK_FAIL_BUILD)" : null,
            });
          } catch (error) {
            console.error(`mock builder: completing deployment ${options.deploymentId} failed`, error);
          }
        })();
      }, 0);
      return { builderApp: null, builderMachineId: null };
    },
  };
}

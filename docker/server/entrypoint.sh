#!/bin/bash

set -e

# ============= ROTATED SECRETS OVERLAY =============
# On emulator snapshot resume, the host injects freshly-generated secrets into
# /run/stack-auth/rotated-secrets.env before supervisorctl restarts us. Sourcing
# here lets a fast-restart pick up new values without a full container restart.
if [ -f /run/stack-auth/rotated-secrets.env ]; then
  set -a
  # shellcheck disable=SC1091
  source /run/stack-auth/rotated-secrets.env
  set +a
fi

# ============= HEXCLAVE_ ↔ STACK_ ENV ALIASING =============
# Hexclave rebrand: HEXCLAVE_*-prefixed env vars are canonical, but self-host
# operators (and older compose files) may still set the legacy STACK_* names.
# Node-side code dual-reads both, but this shell script and the sentinel
# substitution below look up vars by one exact name — so mirror every
# HEXCLAVE_*/STACK_* var to its unset twin. Called again right before the
# sentinel scan to pick up vars exported by the sections in between.
mirror_hexclave_stack_env() {
  local _name _twin
  for _name in $(compgen -e); do
    case "$_name" in
      *HEXCLAVE_*) _twin=${_name/HEXCLAVE_/STACK_} ;;
      *STACK_*) _twin=${_name/STACK_/HEXCLAVE_} ;;
      *) continue ;;
    esac
    if [ -n "${!_name:-}" ] && [ -n "${!_twin:-}" ] && [ "${!_name}" != "${!_twin}" ]; then
      echo "ERROR: $_name and $_twin are both set to different non-empty values. Remove one of them or set them to the same value." >&2
      exit 1
    fi
    if [ -z "${!_twin:-}" ] && [ -n "${!_name:-}" ]; then
      export "$_twin=${!_name}"
    fi
  done
}
mirror_hexclave_stack_env

# ============= FORWARD MOCK OAUTH SERVER =============

# Start socat to forward port 32202 for mock-oauth-server if enabled
if [ "$STACK_FORWARD_MOCK_OAUTH_SERVER" = "true" ]; then
  socat TCP-LISTEN:32202,fork,reuseaddr TCP:host.docker.internal:32202 &
fi

# ============= ENV VARS =============

resolve_internal_project_key_aliases() {
  local _canonical _alias
  for _canonical in STACK_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY STACK_INTERNAL_PROJECT_SECRET_SERVER_KEY; do
    case "$_canonical" in
      STACK_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY) _alias=STACK_SEED_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY ;;
      STACK_INTERNAL_PROJECT_SECRET_SERVER_KEY) _alias=STACK_SEED_INTERNAL_PROJECT_SECRET_SERVER_KEY ;;
    esac
    if [ -n "${!_canonical:-}" ] && [ -n "${!_alias:-}" ] && [ "${!_canonical}" != "${!_alias}" ]; then
      echo "ERROR: $_canonical and $_alias are both set to different non-empty values. Remove one of them or set them to the same value." >&2
      exit 1
    fi
    if [ -z "${!_canonical:-}" ] && [ -n "${!_alias:-}" ]; then
      export "$_canonical=${!_alias}"
    fi
  done
}
resolve_internal_project_key_aliases

derive_internal_project_key() {
  local _label=$1
  printf '%s' "$_label" | openssl dgst -sha256 -hmac "$STACK_SERVER_SECRET" -binary | base64 -w0
}

if [ -z "${STACK_SERVER_SECRET:-}" ]; then
  echo "WARNING: STACK_SERVER_SECRET is unset; generated internal project keys will rotate on restart and break the dashboard. Set the server secret or all internal project keys explicitly." >&2
fi

# Deterministic derivation keeps generated dashboard keys stable across restarts
# while using distinct HMAC labels so the three keys cannot be recovered from one another.
export STACK_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY=${STACK_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY:-$(if [ -n "${STACK_SERVER_SECRET:-}" ]; then derive_internal_project_key internal-project-publishable-client-key; else openssl rand -base64 32; fi)}
export STACK_INTERNAL_PROJECT_SECRET_SERVER_KEY=${STACK_INTERNAL_PROJECT_SECRET_SERVER_KEY:-$(if [ -n "${STACK_SERVER_SECRET:-}" ]; then derive_internal_project_key internal-project-secret-server-key; else openssl rand -base64 32; fi)}
export STACK_SEED_INTERNAL_PROJECT_SUPER_SECRET_ADMIN_KEY=${STACK_SEED_INTERNAL_PROJECT_SUPER_SECRET_ADMIN_KEY:-$(if [ -n "${STACK_SERVER_SECRET:-}" ]; then derive_internal_project_key internal-project-super-secret-admin-key; else openssl rand -base64 32; fi)}

export NEXT_PUBLIC_STACK_PROJECT_ID=internal
export NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY=${STACK_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY}
if [ -n "${STACK_INTERNAL_PROJECT_SECRET_SERVER_KEY:-}" ]; then
  export STACK_SECRET_SERVER_KEY=${STACK_INTERNAL_PROJECT_SECRET_SERVER_KEY}
fi
if [ -n "${STACK_SEED_INTERNAL_PROJECT_SUPER_SECRET_ADMIN_KEY:-}" ]; then
  export STACK_SUPER_SECRET_ADMIN_KEY=${STACK_SEED_INTERNAL_PROJECT_SUPER_SECRET_ADMIN_KEY}
fi

export NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL=${NEXT_PUBLIC_STACK_DASHBOARD_URL}
# Hexclave rebrand: the port-prefix var was renamed outright to
# NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX. The dashboard bundle's post-build sentinel
# is STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX, and the sentinel
# substitution loop below derives the env var name from the sentinel — so this
# MUST export NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX or the sentinel never resolves.
# Accept the legacy NEXT_PUBLIC_STACK_PORT_PREFIX as input for back-compat with
# existing self-host configs.
export NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX=${NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX:-${NEXT_PUBLIC_STACK_PORT_PREFIX:-81}}
PORT_PREFIX=${NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX}
export NEXT_PUBLIC_SERVER_STACK_DASHBOARD_URL="http://localhost:${PORT_PREFIX}01"
export NEXT_PUBLIC_BROWSER_STACK_API_URL=${NEXT_PUBLIC_STACK_API_URL}
export NEXT_PUBLIC_SERVER_STACK_API_URL="http://localhost:${PORT_PREFIX}02"
export BACKEND_PORT=${BACKEND_PORT:-${PORT_PREFIX}02}
export DASHBOARD_PORT=${DASHBOARD_PORT:-${PORT_PREFIX}01}

export USE_INLINE_ENV_VARS=true

if [ -z "${NEXT_PUBLIC_STACK_SVIX_SERVER_URL}" ]; then
  export NEXT_PUBLIC_STACK_SVIX_SERVER_URL=${STACK_SVIX_SERVER_URL}
fi

# ============= MIGRATIONS =============

should_run_migrations=true
if [ "$STACK_SKIP_MIGRATIONS" = "true" ] || [ "$STACK_RUN_MIGRATIONS" = "false" ]; then
  should_run_migrations=false
fi

if [ "$should_run_migrations" = "false" ]; then
  echo "Skipping migrations."
else
  echo "Running migrations..."
  cd apps/backend
  node dist/db-migrations.mjs migrate
  cd ../..
fi

should_run_seed_script=true
if [ "$STACK_SKIP_SEED_SCRIPT" = "true" ] || [ "$STACK_RUN_SEED_SCRIPT" = "false" ]; then
  should_run_seed_script=false
fi

if [ "$should_run_seed_script" = "false" ]; then
  echo "Skipping seed script."
else
  echo "Running seed script..."
  cd apps/backend
  node dist/db-migrations.mjs seed
  cd ../..
fi

# ============= ENV VARS =============

# Mirror again: the sections above exported more STACK_/HEXCLAVE_ vars (internal
# project keys, NEXT_PUBLIC_STACK_PROJECT_ID, svix fallback). The dashboard
# bundle inlines BOTH process.env.NEXT_PUBLIC_HEXCLAVE_* and
# process.env.NEXT_PUBLIC_STACK_* references as sentinels (dual-read), and the
# fallback chain treats an unreplaced sentinel as truthy — so both spellings
# must resolve to the same real value before the sentinel replacement below.
mirror_hexclave_stack_env

# Create a working directory for our processed files.
# Keep this off /tmp so config sharing can bind-mount /tmp
# without pushing the whole runtime copy step onto the host filesystem.
WORK_DIR="${STACK_RUNTIME_WORK_DIR:-/var/tmp/stack-runtime}"
if [ "$WORK_DIR" = "/" ]; then
  echo "ERROR: STACK_RUNTIME_WORK_DIR=/ cannot be used because startup cleanup would target the container root. Choose a dedicated runtime directory." >&2
  exit 1
fi
mkdir -p "$WORK_DIR"

# The full-tree sentinel scan is expensive (several seconds over the whole built
# app tree). On a fast-restart the placeholders have already been sed-replaced
# by rotate-secrets, and no new sentinels need substitution. Skip the scan in
# that case. Marker lives in WORK_DIR because the docker/server image runs as
# the unprivileged `node` user and cannot write to /var/run.
SENTINEL_MARKER="$WORK_DIR/.stack-sentinels-replaced"
sentinel_env_vars=""
sentinel_fingerprint=""
runtime_build_identity=""
runtime_tree_trusted=false
sentinel_marker_present=false
# Keep this list explicit: these values are required by the bundled dashboard,
# while other discovered sentinels intentionally remain optional at runtime.
required_sentinel_env_vars="NEXT_PUBLIC_STACK_PROJECT_ID NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY NEXT_PUBLIC_STACK_API_URL NEXT_PUBLIC_SERVER_STACK_API_URL NEXT_PUBLIC_STACK_DASHBOARD_URL NEXT_PUBLIC_SERVER_STACK_DASHBOARD_URL USE_INLINE_ENV_VARS"
get_runtime_build_identity() {
  local _identity
  if ! _identity=$(cat /app/.stack-runtime-build-identity 2>/dev/null) || [ -z "$_identity" ]; then
    return 1
  fi
  printf '%s\n' "$_identity"
}
require_rebuildable_runtime_work_dir() {
  if [ "$WORK_DIR" = "/app" ]; then
    echo "ERROR: STACK_RUNTIME_WORK_DIR=/app cannot rebuild changed sentinel values in place. Recreate the container without STACK_RUNTIME_WORK_DIR=/app." >&2
    exit 1
  fi
}
rebuild_runtime_tree() {
  require_rebuildable_runtime_work_dir
  while IFS= read -r -d '' _runtime_entry; do
    rm -rf "$WORK_DIR/$_runtime_entry"
  done < <(find /app -mindepth 1 -maxdepth 1 -printf '%f\0')
  cp -r /app/. "$WORK_DIR"/.
  rm -f "$SENTINEL_MARKER"
}
sentinel_values_are_replaced() {
  local _env_var _value _sentinel _pattern="" _status=0
  for _env_var in $sentinel_env_vars; do
    _value="${!_env_var:-}"
    if [ -n "$_value" ]; then
      _sentinel="STACK_ENV_VAR_SENTINEL_$_env_var"
      _pattern="${_pattern:+$_pattern|}$_sentinel"
    fi
  done
  if [ -z "$_pattern" ]; then
    return 0
  fi
  grep -rl -E "$_pattern" "$WORK_DIR/apps" >/dev/null 2>&1 || _status=$?
  case "$_status" in
    0) return 1 ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
}
if ! runtime_build_identity=$(get_runtime_build_identity); then
  echo "WARNING: Could not determine the bundled app build identity; the sentinel marker will not be trusted on restart." >&2
  runtime_build_identity=""
fi
if [ -f "$SENTINEL_MARKER" ]; then
  sentinel_marker_present=true
  stored_sentinel_fingerprint=$(sed -n '1p' "$SENTINEL_MARKER")
  sentinel_env_vars=$(sed -n '2p' "$SENTINEL_MARKER")
  stored_runtime_build_identity=$(sed -n '3p' "$SENTINEL_MARKER")
  if [ -n "$stored_sentinel_fingerprint" ] && [ -n "$sentinel_env_vars" ]; then
    current_sentinel_fingerprint=$(printf '%s\n' "$sentinel_env_vars" | tr ' ' '\n' | while IFS= read -r env_var; do printf '%s=%s\n' "$env_var" "${!env_var:-}"; done | sort | sha256sum | cut -d ' ' -f1)
    if [ "$stored_sentinel_fingerprint" = "$current_sentinel_fingerprint" ] \
      && [ -n "$runtime_build_identity" ] \
      && [ "$stored_runtime_build_identity" = "$runtime_build_identity" ] \
      && sentinel_values_are_replaced; then
      echo "Sentinel values unchanged on a previous start; skipping scan."
      sentinel_fingerprint=$stored_sentinel_fingerprint
      runtime_tree_trusted=true
    else
      echo "Sentinel marker is stale or incomplete; restoring pristine runtime files and rescanning."
    fi
  else
    echo "Sentinel marker has no fingerprint; restoring pristine runtime files and rescanning."
  fi
fi

if [ "$runtime_tree_trusted" = false ]; then
  if [ "$WORK_DIR" != "/app" ]; then
    echo "Restoring pristine files to working directory..."
    rebuild_runtime_tree
  elif [ "$sentinel_marker_present" = true ]; then
    # A marker proves that /app was previously processed, so it cannot safely
    # be rescanned in place after the marker becomes stale.
    require_rebuildable_runtime_work_dir
  fi
fi

if [ "$runtime_tree_trusted" = false ]; then

  # Find all files in the apps directory that contain a STACK_ENV_VAR_SENTINEL and extract the unique sentinel strings.
  # Require at least one character after `STACK_ENV_VAR_SENTINEL_` — a bare
  # `STACK_ENV_VAR_SENTINEL_` (trailing underscore but no suffix) makes env_var
  # empty below, which would crash `${!env_var}` with "invalid variable name"
  # under `set -e`. The dashboard bundle's sentinel-construction code embeds
  # the prefix as a literal string, so this case occurs in practice.
  echo "Finding unhandled sentinels..."
  unhandled_sentinels=$(find "$WORK_DIR/apps" -type f -exec grep -l "STACK_ENV_VAR_SENTINEL" {} + | \
    xargs grep -h "STACK_ENV_VAR_SENTINEL" | \
    grep -oE "STACK_ENV_VAR_SENTINEL_[A-Z_]*[A-Z]+[A-Z_]*" | \
    sort -u)

  # Choose an uncommon delimiter – here, we use the ASCII Unit Separator (0x1F)
  delimiter=$(printf '\037')

  echo "Replacing sentinels..."
  for sentinel in $unhandled_sentinels; do
    # The sentinel is like "STACK_ENV_VAR_SENTINEL_MY_VAR", so extract the env var name.
    env_var=${sentinel#STACK_ENV_VAR_SENTINEL_}
    case " $sentinel_env_vars " in
      *" $env_var "*) ;;
      *) sentinel_env_vars="${sentinel_env_vars:+$sentinel_env_vars }$env_var" ;;
    esac

    # Defense in depth: skip if env_var name is empty. The regex above already
    # excludes bare-prefix matches, but `${!env_var}` with an empty name aborts
    # the whole script under `set -e`, so guard it explicitly.
    if [ -z "$env_var" ]; then
      continue
    fi

    # Get the corresponding environment variable value.
    value="${!env_var:-}"

    # Optional values may remain sentinel-backed so the runtime resolver can
    # treat them as unset. Required values are checked after the scan.
    if [ -z "$value" ]; then
      continue
    fi

    # Although the sentinel only contains [A-Z_] we still escape it for any regex meta-characters.
    escaped_sentinel=$(printf '%s\n' "$sentinel" | sed -e 's/\\/\\\\/g' -e 's/[][\/.^$*]/\\&/g')

    # For the replacement value, first escape backslashes, then escape any occurrence of
    # the chosen delimiter and the '&' (which has special meaning in sed replacements).
    escaped_value=$(printf '%s\n' "$value" | sed -e 's/\\/\\\\/g' -e "s/[${delimiter}&]/\\\\&/g")

    # Hexclave rebrand: only sed files that actually contain the sentinel. The previous
    # `find … -exec sed -i … {} +` ran sed across the ENTIRE standalone build for every
    # sentinel (22 sentinels × thousands of files), and got unworkable once the dashboard
    # bundle grew to include dual-literal _inlineEnvVars references. Restrict to matching
    # files; also log per-sentinel so a hang at any specific sentinel is visible.
    echo "  - Replacing $sentinel"
    files=$(grep -rl "$sentinel" "$WORK_DIR/apps" 2>/dev/null || true)
    if [ -n "$files" ]; then
      echo "$files" | xargs sed -i "s${delimiter}${escaped_sentinel}${delimiter}${escaped_value}${delimiter}g"
    fi
  done
  for env_var in $required_sentinel_env_vars; do
    value="${!env_var:-}"
    if [ -z "$value" ]; then
      echo "ERROR: Required sentinel environment variable $env_var is unset; set it in the self-host environment file before starting the server." >&2
      exit 1
    fi
  done
  if sentinel_values_are_replaced; then
    sentinel_check_status=0
  else
    sentinel_check_status=$?
  fi
  if [ "$sentinel_check_status" -eq 2 ]; then
    echo "ERROR: Could not verify sentinel replacement in the runtime tree; refusing to start." >&2
    exit 1
  fi
  if [ "$sentinel_check_status" -eq 1 ]; then
    echo "ERROR: Sentinel replacement was incomplete; refusing to start with unreplaced runtime values." >&2
    exit 1
  fi
  echo "Sentinel replacement complete."
  sentinel_fingerprint=$(printf '%s\n' "$sentinel_env_vars" | tr ' ' '\n' | while IFS= read -r env_var; do printf '%s=%s\n' "$env_var" "${!env_var:-}"; done | sort | sha256sum | cut -d ' ' -f1)
  marker_tmp="${SENTINEL_MARKER}.tmp.$$"
  {
    printf '%s\n' "$sentinel_fingerprint"
    printf '%s\n' "$sentinel_env_vars"
    printf '%s\n' "$runtime_build_identity"
  } > "$marker_tmp"
  mv "$marker_tmp" "$SENTINEL_MARKER"
fi

# ============= START BACKEND AND DASHBOARD =============

echo "Starting backend on port $BACKEND_PORT..."
cd "$WORK_DIR"
PORT=$BACKEND_PORT HOSTNAME=0.0.0.0 node apps/backend/dist/server.mjs &
backend_pid=$!

echo "Starting dashboard on port $DASHBOARD_PORT..."
PORT=$DASHBOARD_PORT HOSTNAME=0.0.0.0 node apps/dashboard/server.js &
dashboard_pid=$!

termination_started=false
signal_handled=false
terminate_children_gracefully() {
  if [ "$termination_started" = true ]; then
    return
  fi
  termination_started=true
  kill -TERM "$backend_pid" "$dashboard_pid" 2>/dev/null || true
}
handle_signal() {
  if [ "$signal_handled" = true ]; then
    kill -KILL "$backend_pid" "$dashboard_pid" 2>/dev/null || true
    return
  fi
  signal_handled=true
  terminate_children_gracefully
}

trap handle_signal SIGTERM SIGINT

# If either service exits, terminate and reap its sibling. Otherwise PID 1 can
# leave a failed backend behind a healthy dashboard (or vice versa).
set +e
wait -n "$backend_pid" "$dashboard_pid"
child_exit_code=$?
set -e

if [ "$termination_started" = false ]; then
  terminate_children_gracefully
fi
wait "$backend_pid" 2>/dev/null || true
wait "$dashboard_pid" 2>/dev/null || true
exit "$child_exit_code"

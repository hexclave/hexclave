# Dependency installation

Use Corepack and the exact pnpm version and integrity hash in the root `package.json`:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
```

The root currently uses pnpm 11.28.5, a release older than the seven-day delay below. This retains the single-document lockfile expected by the pinned Docker pruning tool. The application dependencies and their existing lockfile are preserved. The offline preinstall check rejects other installers and pnpm versions before running project hooks. Workspace manifests that declare a `packageManager` field use the same pin, including when Corepack starts inside a package. SDK template generation uses Node 24’s native TypeScript support so a first install does not depend on an already-installed `tsx`.

`pnpm-workspace.yaml` applies a seven-day release delay, strict missing-timestamp handling, trust checks on the resolved lockfile, blocked exotic transitive sources, and explicit version-scoped dependency build decisions. Review any dependency version that adds or changes an install script before approving it. Do not use flags or environment variables that disable these checks.

The version-specific exclusions in that file are compatibility decisions for existing releases. They do not approve future versions. Remove age exclusions after the configured window; remove other exclusions when the introducing dependency supports a suitable replacement. Do not add package-wide exemptions.

CI installs use frozen lockfiles. The backend/server Dockerfiles bootstrap the same integrity-pinned pnpm version and retain explicit tool versions. Runtime package installation inside test fixtures, tenant sandboxes, and SDK package-manager interoperability examples is a separate behavior; these changes do not change those interfaces.

Installer guard checks run without the monorepo build:

```sh
node --test-isolation=none --test scripts/check-package-manager.test.mjs
```

CI activates pnpm through Corepack before installation so the SHA-512 pin is checked; the offline guard checks the version only. The bootstrap tests run in the lint/build job before dependencies are installed. Docker’s pruning tool has its own frozen lockfile in `docker/tools`, including the platform binaries, and a matching seven-day trust policy. Run `corepack pnpm install --frozen-lockfile` from that directory to check it.

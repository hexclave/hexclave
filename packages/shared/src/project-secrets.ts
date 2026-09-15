// Project secrets: per-project, write-only credential values, envelope-encrypted
// with KMS server-side. They are set in the dashboard (Project Settings →
// Secrets) or through the admin SDK, and are only ever decrypted server-side by
// the feature that consumes them — no API returns a value.
//
// Deployments are currently the only consumer (`secret()` env vars in the
// `deploy` export of hexclave.deploy.ts name a key in this store), which is
// why the store is scoped to the PROJECT rather than to a tenancy: infrastructure
// credentials are shared across branches by design, and a per-organization copy
// of an API key would be meaningless. Keep this module free of
// deployments-specific concepts so the next consumer doesn't have to reach
// through the Deployments app to use it.

export const PROJECT_SECRET_KEY_REGEX = /^[a-zA-Z0-9_-]+$/;

// The regex alone bounds the alphabet but not the LENGTH, and a key is half of a composite
// unique index — so a multi-kilobyte key that is otherwise perfectly valid fails deep inside
// Postgres ("index row size exceeds btree maximum") and surfaces as a 500 after the KMS work
// has already run. 256 is far above any real environment-variable name.
export const MAX_PROJECT_SECRET_KEY_LENGTH = 256;

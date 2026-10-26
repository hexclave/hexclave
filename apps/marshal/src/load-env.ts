import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env files for the marshal process (mirrors apps/bulldozer-js/src/load-env.ts).
// Ordering = precedence: dotenv never overrides an already-set var, so real shell env always
// wins and the most-specific file listed first wins. `.env*.local` is gitignored and holds
// secrets (real GCP/R2 credentials); the committed `.env`/`.env.development` hold only
// non-secret config. Must stay the first import in index.ts.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const environmentFiles = process.env.NODE_ENV === "test"
  ? [".env.test.local", ".env.test", ".env.development.local", ".env.local", ".env.development", ".env"]
  : process.env.NODE_ENV === "development"
    ? [".env.development.local", ".env.local", ".env.development", ".env"]
    : [".env.local", ".env"];

config({ path: environmentFiles.map(file => resolve(packageRoot, file)) });

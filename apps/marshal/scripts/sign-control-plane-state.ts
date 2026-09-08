// Signs a bucket's unsigned control-plane records in place, so a Marshal that fails closed on
// unsigned state (see readAuthenticatedControlPlaneState in src/store.ts) can be rolled into
// an environment whose bucket predates the signing.
//
// Why offline and not at read time: accepting an unsigned object once and signing it would
// authenticate whatever was in the bucket at that moment — including a forged claim written
// after a bucket compromise. Run this deliberately, against a bucket you trust, BEFORE the
// first deploy of the version that requires signatures. Idempotent: an already-signed object
// is verified and left alone; a signed object that fails verification is reported and left
// alone too, never re-signed.
//
// Covers every authenticated prefix: domains/*.json (the one prefix a Fly-era bucket holds),
// tenants/*.json, gcp-project-pool/*.json, and the pool ledger.
//
//   MARSHAL_S3_* + HEXCLAVE_MARSHAL_DATA_ENCRYPTION_KEY set (the same values Marshal runs
//   with), then from apps/marshal:
//     pnpm exec tsx scripts/sign-control-plane-state.ts            # dry run: report only
//     pnpm exec tsx scripts/sign-control-plane-state.ts --write    # sign what is unsigned
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { authenticateControlPlaneState, parseDataEncryptionRootKey, verifyControlPlaneStateAuthentication } from "../src/spec-crypto.js";

const AUTHENTICATED_PREFIXES = ["domains/", "tenants/", "gcp-project-pool/"];
const AUTHENTICATED_KEYS = ["gcp-project-pool-ledger.json"];

function env(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`${name} is not set`);
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const rootKey = parseDataEncryptionRootKey(env("HEXCLAVE_MARSHAL_DATA_ENCRYPTION_KEY"));
  const bucket = env("MARSHAL_S3_BUCKET");
  const s3 = new S3Client({
    region: env("MARSHAL_S3_REGION", "auto"),
    endpoint: env("MARSHAL_S3_ENDPOINT"),
    forcePathStyle: process.env.MARSHAL_S3_FORCE_PATH_STYLE === "1",
    credentials: { accessKeyId: env("MARSHAL_S3_ACCESS_KEY_ID"), secretAccessKey: env("MARSHAL_S3_SECRET_ACCESS_KEY") },
  });

  const keys: string[] = [...AUTHENTICATED_KEYS];
  for (const prefix of AUTHENTICATED_PREFIXES) {
    let continuationToken: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }));
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined && object.Key.endsWith(".json")) keys.push(object.Key);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
  }

  let signed = 0;
  let alreadySigned = 0;
  let invalid = 0;
  let missing = 0;
  for (const key of keys) {
    let body: string | undefined;
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      body = await result.Body?.transformToString();
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") {
        missing++;
        continue;
      }
      throw error;
    }
    if (body === undefined) {
      missing++;
      continue;
    }
    const stored: unknown = JSON.parse(body);
    const isSigned = typeof stored === "object" && stored !== null && (stored as Record<string, unknown>).authentication_version === 1 && "value" in stored && typeof (stored as Record<string, unknown>).mac_base64 === "string";
    if (isSigned) {
      const record = stored as { value: unknown, mac_base64: string };
      if (verifyControlPlaneStateAuthentication(JSON.stringify(record.value), key, record.mac_base64, rootKey)) {
        alreadySigned++;
      } else {
        invalid++;
        console.error(`INVALID signature: ${key} (left untouched — investigate before trusting this bucket)`);
      }
      continue;
    }
    // Unsigned: the whole object IS the value. Wrap and sign it, bound to its own key.
    const serialized = JSON.stringify(stored);
    const wrapped = { authentication_version: 1, value: stored, mac_base64: authenticateControlPlaneState(serialized, key, rootKey) };
    if (write) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(wrapped), ContentType: "application/json" }));
      console.log(`signed ${key}`);
    } else {
      console.log(`would sign ${key}`);
    }
    signed++;
  }
  console.log(`${write ? "signed" : "unsigned"}: ${signed}, already signed: ${alreadySigned}, invalid: ${invalid}, missing: ${missing}${write ? "" : " (dry run; pass --write to sign)"}`);
  if (invalid > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

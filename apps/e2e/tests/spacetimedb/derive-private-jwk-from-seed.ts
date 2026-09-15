import { createECDH, createHash } from "node:crypto";
import * as jose from "jose";

export type DerivedPrivateJwk = {
  kty: "EC",
  alg: "ES256",
  crv: "P-256",
  kid: string,
  d: string,
  x: string,
  y: string,
};

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function derivePrivateJwkFromSeed(purpose: string, seed: string): DerivedPrivateJwk {
  const getHashOfJwkInfo = (type: string) => jose.base64url.encode(
    createHash("sha256")
      .update(JSON.stringify([type, purpose, seed]))
      .digest(),
  );
  const derivedSecret = getHashOfJwkInfo("seed-derived-jwk-secret");
  const kid = getHashOfJwkInfo("seed-derived-jwk-kid").slice(0, 12);

  const priv = new Uint8Array(createHash("sha256").update(jose.base64url.decode(derivedSecret)).digest());
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(priv));
  const pub = ecdh.getPublicKey(null, "uncompressed");
  return {
    kty: "EC",
    crv: "P-256",
    alg: "ES256",
    kid,
    d: encodeBase64Url(priv),
    x: encodeBase64Url(pub.subarray(1, 33)),
    y: encodeBase64Url(pub.subarray(33, 65)),
  };
}

export const SPACETIMEDB_SIGNING_KEY_DERIVATION_PURPOSE = "hexclave-internal-tool-spacetimedb-signing";

import crypto from "crypto";
import elliptic from "elliptic";
import * as jose from "jose";
import { JOSEError } from "jose/errors";
import { encodeBase64Url } from "./bytes";
import { getEnvVariable } from "./env";
import { HexclaveAssertionError, errorToNiceString } from "./errors";
import { globalVar } from "./globals";
import { pick } from "./objects";
import { Result } from "./results";
import { nicify } from "./strings";

function getHexclaveServerSecret() {
  const STACK_SERVER_SECRET = getEnvVariable("STACK_SERVER_SECRET");
  try {
    jose.base64url.decode(STACK_SERVER_SECRET);
  } catch (e) {
    throw new HexclaveAssertionError("STACK_SERVER_SECRET is not valid. Please use the generateKeys script to generate a new secret.", { cause: e });
  }
  return STACK_SERVER_SECRET;
}

export async function getJwtInfo(options: {
  jwt: string,
}) {
  try {
    if (typeof options.jwt !== "string") return Result.error({ error: "JWT input is not a string!", stringifiedInput: nicify(options.jwt) });
    if (!options.jwt.startsWith("ey")) return Result.error({ error: "Input is a string, but not a JWT!", input: options.jwt });
    const decodedJwt = jose.decodeJwt(options.jwt);
    return Result.ok({ payload: decodedJwt });
  } catch (e) {
    return Result.error({
      exception: errorToNiceString(e),
    });
  }
}

export async function signJWT(options: {
  issuer: string,
  audience: string,
  payload: any,
  expirationTime?: string | Date,
}) {
  const privateJwks = await getPrivateJwks({ audience: options.audience });
  const privateKey = await jose.importJWK(privateJwks[0]);
  const expirationTime = options.expirationTime instanceof Date
    ? Math.floor(options.expirationTime.getTime() / 1000)
    : options.expirationTime;

  return await new jose.SignJWT(options.payload)
    .setProtectedHeader({ alg: "ES256", kid: privateJwks[0].kid })
    .setIssuer(options.issuer)
    .setIssuedAt()
    .setAudience(options.audience)
    .setExpirationTime(expirationTime ?? "5m")
    .sign(privateKey);
}

export async function verifyJWT(options: {
  allowedIssuers: string[],
  jwt: string,
}) {
  const decodedJwt = jose.decodeJwt(options.jwt);
  const audience = decodedJwt.aud;
  if (!audience || typeof audience !== "string") {
    throw new JOSEError("Invalid JWT audience");
  }

  const jwkSet = jose.createLocalJWKSet(await getPublicJwkSet(await getPrivateJwks({ audience })));
  const verified = await jose.jwtVerify(options.jwt, jwkSet, { issuer: options.allowedIssuers });
  return verified.payload;
}

export type PrivateJwk = {
  kty: "EC",
  alg: "ES256",
  crv: "P-256",
  kid: string,
  d: string,
  x: string,
  y: string,
};
async function getPrivateJwkFromDerivedSecret(derivedSecret: string, kid: string): Promise<PrivateJwk> {
  const secretHash = await globalVar.crypto.subtle.digest("SHA-256", jose.base64url.decode(derivedSecret));
  const priv = new Uint8Array(secretHash);

  const ec = new elliptic.ec('p256');
  const key = ec.keyFromPrivate(priv);
  const publicKey = key.getPublic();

  return {
    kty: 'EC',
    crv: 'P-256',
    alg: 'ES256',
    kid: kid,
    d: encodeBase64Url(priv),
    x: encodeBase64Url(publicKey.getX().toBuffer()),
    y: encodeBase64Url(publicKey.getY().toBuffer()),
  };
}

/**
 * Returns a list of valid private JWKs for the given audience, with the first one taking precedence when signing new
 * JWTs.
 */
export async function getPrivateJwks(options: {
  audience: string,
}): Promise<PrivateJwk[]> {
  const getHashOfJwkInfo = (type: string) => jose.base64url.encode(
    crypto
      .createHash('sha256')
      .update(JSON.stringify([type, getHexclaveServerSecret(), {
        audience: options.audience,
      }]))
      .digest()
  );
  // NOTE (Hexclave rebrand): do NOT rename these "stack-*" literals. They are hashed into the
  // per-audience JWT signing secret and key id (kid); renaming them would rotate every project's
  // JWKS and invalidate all already-issued access tokens. Internal constants, never user-visible.
  const perAudienceSecret = getHashOfJwkInfo("stack-jwk-audience-secret");
  const perAudienceKid = getHashOfJwkInfo("stack-jwk-kid").slice(0, 12);

  const oldPerAudienceSecret = oldGetPerAudienceSecret({ audience: options.audience });
  const oldPerAudienceKid = oldGetKid({ secret: oldPerAudienceSecret });

  return [
    // TODO next-release: make this not take precedence; then, in the release after that, remove it entirely
    await getPrivateJwkFromDerivedSecret(oldPerAudienceSecret, oldPerAudienceKid),

    await getPrivateJwkFromDerivedSecret(perAudienceSecret, perAudienceKid),
  ];
}

export type PublicJwk = {
  kty: "EC",
  alg: "ES256",
  crv: "P-256",
  kid: string,
  x: string,
  y: string,
};
export async function getPublicJwkSet(privateJwks: PrivateJwk[]): Promise<{ keys: PublicJwk[] }> {
  return {
    keys: privateJwks.map(jwk => pick(jwk, ["kty", "alg", "crv", "x", "y", "kid"])),
  };
}

function oldGetPerAudienceSecret(options: {
  audience: string,
}) {
  if (options.audience === "kid") {
    throw new HexclaveAssertionError("You cannot use the 'kid' audience for a per-audience secret, see comment below in jwt.tsx");
  }
  return jose.base64url.encode(
    crypto
      .createHash('sha256')
      // TODO we should prefix a string like "stack-audience-secret" before we hash so you can't use `getKid(...)` to get the secret for eg. the "kid" audience if the same secret value is used
      // Sadly doing this modification is a bit annoying as we need to leave the old keys to be valid for a little longer
      .update(JSON.stringify([getHexclaveServerSecret(), options.audience]))
      .digest()
  );
};

export function oldGetKid(options: {
  secret: string,
}) {
  return jose.base64url.encode(
    crypto
      .createHash('sha256')
      .update(JSON.stringify([options.secret, "kid"]))  // TODO see above in getPerAudienceSecret
      .digest()
  ).slice(0, 12);
}

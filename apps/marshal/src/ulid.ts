import { randomBytes } from "node:crypto";

// Minimal ULID implementation (Crockford base32, 48-bit ms timestamp + 80 random bits).
// Build ids are ULIDs so they sort lexicographically by creation time, which is what makes
// newest-first bucket listings and the before_millis filter cheap.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(atMillis: number = Date.now()): string {
  let time = atMillis;
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = ALPHABET[time % 32];
    time = Math.floor(time / 32);
  }
  const random = randomBytes(16);
  let randomPart = "";
  for (let i = 0; i < 16; i++) {
    randomPart += ALPHABET[random[i] % 32];
  }
  return timeChars.join("") + randomPart;
}

export function ulidTimeMillis(id: string): number {
  let time = 0;
  for (let i = 0; i < 10; i++) {
    time = time * 32 + ALPHABET.indexOf(id[i]);
  }
  return time;
}

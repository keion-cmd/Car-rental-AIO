import crypto from "node:crypto";

// scrypt from node:crypto — memory-hard, in the standard library, no
// dependency. Cost parameters follow the OWASP-recommended minimum for
// scrypt (N=2^14, r=8, p=1): derived-key memory cost is 128*N*r bytes =
// 128*16384*8 = 16 MiB per hash, comfortably under Node's default
// scrypt maxmem (32 MiB) while still being expensive enough to make
// offline brute-forcing a leaked hash impractical at staff-account scale.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

// Encoded as scrypt:N:r:p:saltBase64:hashBase64 so the cost parameters
// travel with the hash — a future change to SCRYPT_N etc. does not break
// verification of hashes already stored under the old parameters.
export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derivedKey = await scryptAsync(plain, salt);
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("base64")}:${derivedKey.toString("base64")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");

  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(plain, salt, expected.length, { N: n, r, p }, (err, derivedKeyResult) => {
      if (err) reject(err);
      else resolve(derivedKeyResult);
    });
  });

  // Never ===. Lengths must match before timingSafeEqual is called (it
  // throws on mismatched lengths) — that early return is on a length that
  // depends only on the stored value, not the guess, so it leaks nothing
  // about the plaintext.
  if (derivedKey.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(derivedKey, expected);
}

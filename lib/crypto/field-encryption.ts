import crypto from "node:crypto";

// AES-256-GCM. IV is random per call, so encrypting the same plaintext twice
// yields different ciphertext — the column this backs is therefore not
// searchable or joinable. That's intended: licence numbers are read by
// booking id, never searched. The auth tag is stored alongside the
// ciphertext so tampering fails decryption instead of returning garbage.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function loadKey(): Buffer {
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error("FIELD_ENCRYPTION_KEY is not set. Field encryption cannot start without it.");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(`FIELD_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (64 hex chars), got ${key.length}.`);
  }
  return key;
}

// Read once at module load and fail loudly at startup, not silently on
// first use.
const KEY = loadKey();

export function encryptField(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptField(ciphertext: string): string {
  const raw = Buffer.from(ciphertext, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

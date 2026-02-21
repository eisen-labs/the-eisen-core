/**
 * Cryptographic primitives for workspace key derivation and wrapping.
 *
 * Key derivation chain (server-side only, never exposed):
 *   masterKey        → loaded from KMS / env
 *   userKey          = HMAC-SHA256(masterKey, userId)
 *   workspaceKey     = HMAC-SHA256(userKey, workspaceId)
 *   wrapKey          = HKDF-SHA256(rawApiKey, salt="eisen-key-wrap", length=32)
 *   wrappedKey       = AES-256-GCM(workspaceKey, key=wrapKey)
 *
 * The wrapped key is what travels over the wire. The client unwraps it
 * using their raw API key.
 */
import { createHmac, createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { getMasterKey } from "./kms.ts";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HKDF_SALT = "eisen-key-wrap";
const HKDF_INFO = "eisen-workspace-key";

// ── Key derivation ──────────────────────────────────────

/**
 * Derive a per-user key from the master key.
 *   userKey = HMAC-SHA256(masterKey, userId)
 */
export async function deriveUserKey(userId: string): Promise<Buffer> {
  const masterKey = await getMasterKey();
  return Buffer.from(createHmac("sha256", masterKey).update(userId).digest());
}

/**
 * Derive a per-workspace key from the user key.
 *   workspaceKey = HMAC-SHA256(userKey, workspaceId)
 */
export function deriveWorkspaceKey(userKey: Buffer, workspaceId: string): Buffer {
  return Buffer.from(createHmac("sha256", userKey).update(workspaceId).digest());
}

/**
 * Full derivation: masterKey → userKey → workspaceKey
 */
export async function deriveFullWorkspaceKey(
  userId: string,
  workspaceId: string
): Promise<Buffer> {
  const userKey = await deriveUserKey(userId);
  return deriveWorkspaceKey(userKey, workspaceId);
}

// ── Key wrapping ────────────────────────────────────────

/**
 * Derive a wrapping key from the user's raw API key using HKDF.
 *   wrapKey = HKDF-SHA256(rawApiKey, salt="eisen-key-wrap", length=32)
 */
export function deriveWrapKey(rawApiKey: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", rawApiKey, HKDF_SALT, HKDF_INFO, 32)
  );
}

/**
 * Wrap (encrypt) a workspace key with AES-256-GCM using the wrap key.
 *
 * Output format: [ 12-byte IV | ciphertext | 16-byte GCM auth tag ]
 * Returned as a base64 string.
 */
export function wrapKey(workspaceKey: Buffer, rawApiKey: string): string {
  const wrapKey = deriveWrapKey(rawApiKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, wrapKey, iv);

  const encrypted = Buffer.concat([cipher.update(workspaceKey), cipher.final()]);
  const tag = cipher.getAuthTag();

  // [ IV (12) ][ ciphertext (32) ][ auth tag (16) ] = 60 bytes
  const wrapped = Buffer.concat([iv, encrypted, tag]);
  return wrapped.toString("base64");
}

/**
 * Unwrap (decrypt) a workspace key. Used for testing / verification only.
 * In production, the client performs the unwrap.
 */
export function unwrapKey(wrappedBase64: string, rawApiKey: string): Buffer {
  const wrapKeyBuf = deriveWrapKey(rawApiKey);
  const wrapped = Buffer.from(wrappedBase64, "base64");

  const iv = wrapped.subarray(0, IV_LENGTH);
  const tag = wrapped.subarray(wrapped.length - TAG_LENGTH);
  const ciphertext = wrapped.subarray(IV_LENGTH, wrapped.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, wrapKeyBuf, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

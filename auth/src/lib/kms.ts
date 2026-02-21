/**
 * Master key provider.
 *
 * - Development: reads MASTER_KEY hex string from env
 * - Production:  decrypts MASTER_KEY_CIPHERTEXT via GCP Cloud KMS
 *
 * The master key is loaded once at first access and held in module memory.
 * It is never logged or serialized.
 */
import { env } from "../env.ts";

let _masterKey: Buffer | null = null;

/**
 * Load the master key. Throws if not configured.
 *
 * In production with GCP KMS configured:
 *   1. Reads MASTER_KEY_CIPHERTEXT (base64-encoded) from env
 *   2. Calls Cloud KMS decrypt API using the service account credentials
 *      (provided automatically by Cloud Run via GOOGLE_APPLICATION_CREDENTIALS)
 *   3. Returns the decrypted 32-byte master key
 *
 * In development (or when GCP_PROJECT_ID is not set):
 *   Reads MASTER_KEY hex string directly from env
 */
export async function getMasterKey(): Promise<Buffer> {
  if (_masterKey) return _masterKey;

  if (env.NODE_ENV === "production" && env.GCP_PROJECT_ID) {
    _masterKey = await decryptFromKMS();
    return _masterKey;
  }

  // Development fallback: raw hex from env
  if (!env.MASTER_KEY) {
    throw new Error(
      "MASTER_KEY env var is required (64 hex chars). Generate with: openssl rand -hex 32"
    );
  }

  _masterKey = Buffer.from(env.MASTER_KEY, "hex");

  if (_masterKey.length !== 32) {
    _masterKey = null;
    throw new Error("MASTER_KEY must be exactly 32 bytes (64 hex characters)");
  }

  return _masterKey;
}

/**
 * Decrypt the master key ciphertext using GCP Cloud KMS.
 *
 * Requires:
 *   - GCP_PROJECT_ID, GCP_KMS_LOCATION, GCP_KMS_KEY_RING, GCP_KMS_KEY_NAME
 *   - MASTER_KEY_CIPHERTEXT (base64-encoded ciphertext)
 *   - Service account with roles/cloudkms.cryptoKeyDecrypter
 *
 * To create the ciphertext:
 *   echo -n "<64-hex-char-master-key>" | xxd -r -p | \
 *     gcloud kms encrypt \
 *       --project=PROJECT_ID \
 *       --location=global \
 *       --keyring=eisen-auth \
 *       --key=master-key \
 *       --plaintext-file=- \
 *       --ciphertext-file=- | base64
 */
async function decryptFromKMS(): Promise<Buffer> {
  if (
    !env.GCP_PROJECT_ID ||
    !env.GCP_KMS_LOCATION ||
    !env.GCP_KMS_KEY_RING ||
    !env.GCP_KMS_KEY_NAME
  ) {
    throw new Error(
      "GCP KMS env vars required in production: GCP_PROJECT_ID, GCP_KMS_LOCATION, GCP_KMS_KEY_RING, GCP_KMS_KEY_NAME"
    );
  }

  if (!env.MASTER_KEY_CIPHERTEXT) {
    throw new Error(
      "MASTER_KEY_CIPHERTEXT env var required in production (base64-encoded KMS ciphertext)"
    );
  }

  const { KeyManagementServiceClient } = await import("@google-cloud/kms");
  const client = new KeyManagementServiceClient();

  const keyName = client.cryptoKeyPath(
    env.GCP_PROJECT_ID,
    env.GCP_KMS_LOCATION,
    env.GCP_KMS_KEY_RING,
    env.GCP_KMS_KEY_NAME
  );

  const ciphertext = Buffer.from(env.MASTER_KEY_CIPHERTEXT, "base64");

  const [result] = await client.decrypt({
    name: keyName,
    ciphertext,
  });

  if (!result.plaintext) {
    throw new Error("KMS decrypt returned empty plaintext");
  }

  const key = Buffer.from(result.plaintext as Uint8Array);

  if (key.length !== 32) {
    throw new Error(
      `KMS decrypted key is ${key.length} bytes, expected 32. Ensure the plaintext is a raw 32-byte key.`
    );
  }

  console.log("Master key loaded from GCP Cloud KMS");
  return key;
}

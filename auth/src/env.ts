import { z } from "zod";

const envSchema = z.object({
  // ── Server ────────────────────────────────────────────
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // ── NeonDB ────────────────────────────────────────────
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid postgres:// URL"),

  // ── CORS ──────────────────────────────────────────────
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((s) => s.split(",").map((o) => o.trim())),

  // ── JWT ───────────────────────────────────────────────
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.coerce.number().default(86400),
  JWT_OFFLINE_WINDOW: z.coerce.number().default(604800),

  // ── OAuth: Google ─────────────────────────────────────
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  // ── OAuth: GitHub ─────────────────────────────────────
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_REDIRECT_URI: z.string().url().optional(),

  // ── Frontend redirect ─────────────────────────────────
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),

  // ── Master key ────────────────────────────────────────
  MASTER_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "MASTER_KEY must be 64 hex characters")
    .optional(),

  // ── GCP KMS (production) ──────────────────────────────
  GCP_PROJECT_ID: z.string().optional(),
  GCP_KMS_LOCATION: z.string().optional(),
  GCP_KMS_KEY_RING: z.string().optional(),
  GCP_KMS_KEY_NAME: z.string().optional(),
  // Base64-encoded ciphertext of the master key, encrypted by Cloud KMS
  MASTER_KEY_CIPHERTEXT: z.string().optional(),

  // ── Stripe ────────────────────────────────────────────
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),
  STRIPE_PREMIUM_PRICE_ID: z.string().optional(),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),

  // ── Stripe (sandbox) ───────────────────────────────────
  SANDBOX_WEBHOOK_SECRET: z.string().optional(),
  SANDBOX_SECRET_KEY: z.string().optional(),
  SANDBOX_PRO_PRICE_ID: z.string().optional(),
  SANDBOX_PREMIUM_PRICE_ID: z.string().optional(),
  SANDBOX_PUBLIC_URL: z.string().url().default("http://localhost:3000"),

  // ── Admin ─────────────────────────────────────────────
  ADMIN_SECRET: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === "development" && !data.SANDBOX_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "SANDBOX_WEBHOOK_SECRET is required in development",
      path: ["SANDBOX_WEBHOOK_SECRET"],
    });
  }
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  // Bun auto-loads .env — just validate process.env
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Environment validation failed:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();

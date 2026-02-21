import { Hono } from "hono";
import { corsMiddleware } from "./middleware/cors.ts";
import { requestId } from "./middleware/requestId.ts";
import { structuredLogger } from "./middleware/logger.ts";
import { health } from "./routes/health.ts";
import { auth } from "./routes/auth.ts";
import { apikeys } from "./routes/apikeys.ts";
import { workspace } from "./routes/workspace.ts";
import { billing } from "./routes/billing.ts";
import { admin } from "./routes/admin.ts";

const app = new Hono();

// ── Global middleware ──────────────────────────────────
app.use("*", requestId);
app.use("*", corsMiddleware);
app.use("*", structuredLogger);

// ── Routes ─────────────────────────────────────────────
app.route("/", health);
app.route("/", auth);
app.route("/", apikeys);
app.route("/", workspace);
app.route("/", billing);
app.route("/", admin);

// ── 404 fallback ───────────────────────────────────────
app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

// ── Global error handler ───────────────────────────────
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

export { app };

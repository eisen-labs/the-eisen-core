import { cors } from "hono/cors";
import { env } from "../env.ts";

export const corsMiddleware = cors({
  origin: env.ALLOWED_ORIGINS,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  exposeHeaders: ["X-Request-Id"],
  credentials: true,
  maxAge: 86400,
});

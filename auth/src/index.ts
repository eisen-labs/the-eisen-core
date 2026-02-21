import { env } from "./env.ts";
import { app } from "./app.ts";

const port = env.NODE_ENV === "production" ? 8080 : env.PORT;

console.log(`eisen-auth starting on port ${port} [${env.NODE_ENV}]`);

export default {
  port,
  fetch: app.fetch,
  // Disable Bun's HTML error overlay — this is a JSON API server
  development: false,
};

/**
 * Migration runner — executes all SQL files in src/db/migrations/ in order.
 *
 * Usage: bun run migrate
 */
import { getPool, closePool } from "./client.ts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

async function migrate() {
  const pool = getPool();

  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Get already-applied migrations
  const applied = await pool.query("SELECT name FROM _migrations ORDER BY name");
  const appliedSet = new Set(applied.rows.map((r: { name: string }) => r.name));

  // Read and sort migration files
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  skip  ${file} (already applied)`);
      continue;
    }

    const sql = await Bun.file(join(MIGRATIONS_DIR, file)).text();

    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      await pool.query("COMMIT");
      console.log(`  apply ${file}`);
      count++;
    } catch (err) {
      await pool.query("ROLLBACK");
      console.error(`  FAIL  ${file}:`, err);
      process.exit(1);
    }
  }

  console.log(`\nDone. ${count} migration(s) applied.`);
  await closePool();
}

migrate();

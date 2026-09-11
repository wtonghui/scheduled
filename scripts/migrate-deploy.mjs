/**
 * Prisma migration deploy — pure-JS driver edition.
 *
 * Replaces `npx prisma migrate deploy` for databases incompatible with
 * Prisma's Rust schema engine (e.g. OceanBase: the engine queries the
 * @@socket system variable at startup, which OB does not support, causing
 * migrate to exit and the pod to CrashLoop).
 *
 * - Reads migration SQL from prisma/migrations/<name>/migration.sql
 * - Applies pending migrations via mysql2 (pure JS, no Rust engine)
 * - Records each in the _prisma_migrations table, keeping full
 *   compatibility with Prisma's own migration tracking / `migrate status`
 *
 * Usage:  node scripts/migrate-deploy.mjs
 * Env:    DATABASE_URL=mysql://user:pass@host:port/db?params
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "prisma", "migrations");

const MIGRATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS \`_prisma_migrations\` (
    \`id\` VARCHAR(36) NOT NULL,
    \`checksum\` VARCHAR(64) NOT NULL,
    \`finished_at\` DATETIME(3) NULL,
    \`migration_name\` VARCHAR(255) NOT NULL,
    \`logs\` TEXT NULL,
    \`rolled_back_at\` DATETIME(3) NULL,
    \`started_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`applied_steps_count\` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (\`id\`)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
`;

function parseDatabaseUrl(raw) {
  const u = new URL(raw);
  return {
    host: u.hostname,
    port: u.port ? Number.parseInt(u.port, 10) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    timezone: u.searchParams.get("timezone") ?? undefined,
  };
}

/** Prisma checksum = SHA-512 hex truncated to 64 chars */
function computeChecksum(sql) {
  return createHash("sha512").update(sql).digest("hex").slice(0, 64);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[migrate] DATABASE_URL is not set");
    process.exit(1);
  }

  const opts = parseDatabaseUrl(dbUrl);
  console.log(
    `[migrate] connecting to ${opts.user}@${opts.host}:${opts.port}/${opts.database} ...`,
  );

  const conn = await createConnection({
    host: opts.host,
    port: opts.port,
    user: opts.user,
    password: opts.password,
    database: opts.database,
    timezone: opts.timezone,
    multipleStatements: true,
    connectTimeout: 30_000,
  });

  try {
    await conn.query(MIGRATIONS_TABLE_DDL);

    const [rows] = await conn.query(
      "SELECT migration_name FROM `_prisma_migrations` WHERE rolled_back_at IS NULL",
    );
    const applied = new Set(
      rows.map((r) => r.migration_name ?? r.MIGRATION_NAME),
    );

    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();

    let count = 0;
    for (const name of dirs) {
      if (applied.has(name)) continue;

      let sql;
      try {
        sql = await readFile(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
      } catch {
        console.warn(`[migrate] ${name}: no migration.sql, skipping`);
        continue;
      }

      const id = randomUUID();
      const checksum = computeChecksum(sql);
      console.log(`[migrate] applying ${name} ...`);

      await conn.query(
        "INSERT INTO `_prisma_migrations` (id, checksum, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?)",
        [id, checksum, name, new Date(), 0],
      );

      try {
        await conn.query(sql);
        await conn.query(
          "UPDATE `_prisma_migrations` SET finished_at = ?, applied_steps_count = ? WHERE id = ?",
          [new Date(), 1, id],
        );
        count += 1;
      } catch (err) {
        await conn.query(
          "UPDATE `_prisma_migrations` SET finished_at = ?, logs = ? WHERE id = ?",
          [new Date(), String(err?.message ?? err), id],
        );
        console.error(`[migrate] FAILED ${name}:`, err?.message ?? err);
        throw err;
      }
    }

    console.log(
      count === 0
        ? "[migrate] no new migrations to apply"
        : `[migrate] applied ${count} migration(s)`,
    );
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("[migrate] fatal:", err?.message ?? err);
  process.exit(1);
});

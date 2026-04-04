import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import pg from "pg";

import { validateStartupSchemaReady } from "../src/services/schema/startupSchemaService.js";
import { SUPABASE_MIGRATIONS_DIR } from "../src/services/schema/supabaseMigrationCatalog.js";
import { createPgSupabaseCompat } from "./lib/createPgSupabaseCompat.js";

dotenv.config();

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const migrationsDir = path.join(repoRoot, SUPABASE_MIGRATIONS_DIR);

function requireCleanDatabaseUrl() {
  const value = process.env.CLEAN_DATABASE_URL || process.env.DATABASE_URL || "";

  if (!value) {
    throw new Error(
      "Missing CLEAN_DATABASE_URL (or DATABASE_URL) for clean database validation."
    );
  }

  return value;
}

async function applySqlFile(client, fileName) {
  const absolutePath = path.join(migrationsDir, fileName);
  const sql = readFileSync(absolutePath, "utf8");
  await client.query(sql);
}

async function main() {
  const client = new Client({
    connectionString: requireCleanDatabaseUrl(),
  });

  await client.connect();

  try {
    await client.query("drop schema if exists public cascade");
    await client.query("create schema public");

    const migrationFiles = readdirSync(migrationsDir)
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();

    for (const fileName of migrationFiles) {
      await applySqlFile(client, fileName);
    }

    await validateStartupSchemaReady(createPgSupabaseCompat(client), {
      phase: "clean-db-validation",
    });

    console.log("Clean database validation passed.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Clean database validation failed.");
  console.error(error.message || error);
  process.exit(1);
});

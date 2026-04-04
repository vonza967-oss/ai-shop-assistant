import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import {
  LEGACY_SOURCE_TO_SUPABASE_FILE,
  SUPABASE_MIGRATIONS,
  SUPABASE_MIGRATIONS_DIR,
} from "../src/services/schema/supabaseMigrationCatalog.js";
import {
  DEPLOY_MIGRATION_MANIFEST,
  FULL_CURRENT_MAIN_MIGRATION_IDS,
  STARTUP_SCHEMA_CHECKS,
  getManifestMigrationFiles,
} from "../src/services/schema/deployReadinessManifest.js";

test("legacy db sql files are mapped into ordered supabase migrations exactly once", () => {
  const legacyDbFiles = readdirSync("db")
    .filter((fileName) => fileName.endsWith(".sql"))
    .map((fileName) => `db/${fileName}`)
    .sort();

  const mappedLegacyFiles = Object.keys(LEGACY_SOURCE_TO_SUPABASE_FILE).sort();

  assert.deepEqual(mappedLegacyFiles, legacyDbFiles);
});

test("supabase migration catalog stays sorted and points at real files", () => {
  const versions = SUPABASE_MIGRATIONS.map((migration) => migration.version);
  const files = SUPABASE_MIGRATIONS.map((migration) => migration.file);
  const sortedFiles = [...files].sort();

  assert.deepEqual(versions, [...versions].sort());
  assert.equal(new Set(versions).size, versions.length);
  assert.deepEqual(files, sortedFiles);

  files.forEach((filePath) => {
    assert.ok(existsSync(filePath), `expected ${filePath} to exist`);
  });
});

test("full migration manifest order matches the supabase/migrations directory", () => {
  const catalogFiles = getManifestMigrationFiles(FULL_CURRENT_MAIN_MIGRATION_IDS);
  const directoryFiles = readdirSync(SUPABASE_MIGRATIONS_DIR)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort()
    .map((fileName) => `${SUPABASE_MIGRATIONS_DIR}/${fileName}`);

  assert.deepEqual(catalogFiles, directoryFiles);
});

test("startup schema validators only reference declared supabase migrations", () => {
  STARTUP_SCHEMA_CHECKS.forEach((check) => {
    check.migrationIds.forEach((migrationId) => {
      assert.ok(
        DEPLOY_MIGRATION_MANIFEST[migrationId],
        `expected manifest entry for startup migration ${migrationId}`
      );
    });
  });
});

test("baseline migration only contains the foundational snapshot", () => {
  const baselineSql = readFileSync(
    "supabase/migrations/20260404000000_initial_schema_base.sql",
    "utf8"
  );

  assert.match(baselineSql, /create table if not exists public\.businesses/i);
  assert.doesNotMatch(baselineSql, /agent_contact_leads/i);
  assert.doesNotMatch(baselineSql, /operator_inbox_threads/i);
  assert.doesNotMatch(baselineSql, /owner_user_id/i);
});

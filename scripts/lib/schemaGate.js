import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TABLE_BLOCK_PATTERN = /create table(?: if not exists)? public\.(\w+)\s*\(([\s\S]*?)\);\s*/gi;
const ALTER_TABLE_PATTERN = /alter table(?: if exists)? public\.(\w+)\s+([\s\S]*?);/gi;
const STRING_CONSTANT_PATTERN = /(?:export\s+)?const\s+(\w+)\s*=\s*["'`]([^"'`]+)["'`]\s*;/g;
const ARRAY_JOIN_PATTERN = /(?:export\s+)?const\s+(\w+)\s*=\s*\[([\s\S]*?)\]\.join\(([\s\S]*?)\)\s*;/g;
const FROM_PATTERN = /\.from\(([^)]+)\)/g;
const FROM_SELECT_PATTERN = /\.from\(([^)]+)\)\s*(?:\.\w+\([^)]*\)\s*){0,4}\.select\(([^)]+)\)/gs;
const STRING_LITERAL_PATTERN = /["'`]([^"'`]+)["'`]/g;

function createInventory() {
  return new Map();
}

function ensureInventoryEntry(inventory, tableName) {
  if (!inventory.has(tableName)) {
    inventory.set(tableName, new Set());
  }

  return inventory.get(tableName);
}

function addColumns(inventory, tableName, columns = []) {
  const entry = ensureInventoryEntry(inventory, tableName);
  columns.forEach((columnName) => {
    if (columnName) {
      entry.add(columnName);
    }
  });
}

function parseColumnName(line) {
  const trimmed = String(line || "").trim();

  if (
    !trimmed
    || trimmed.startsWith("--")
    || trimmed.startsWith("constraint ")
    || trimmed.startsWith("primary key")
    || trimmed.startsWith("unique ")
    || trimmed.startsWith("foreign key")
    || trimmed.startsWith("check ")
  ) {
    return "";
  }

  const match = trimmed.match(/^("?[\w]+"?)/);
  return match ? match[1].replace(/"/g, "") : "";
}

function parseStringLiterals(value) {
  const literals = [];

  for (const match of value.matchAll(STRING_LITERAL_PATTERN)) {
    literals.push(match[1]);
  }

  return literals;
}

function normalizeColumnToken(value) {
  const normalized = String(value || "").trim().replace(/^"|"$/g, "");

  if (
    !normalized
    || normalized === "*"
    || normalized.includes("(")
    || normalized.includes(")")
    || normalized.includes(":")
  ) {
    return "";
  }

  return normalized.split(/\s+/)[0];
}

export function splitColumnList(value) {
  return String(value || "")
    .split(",")
    .map((columnName) => normalizeColumnToken(columnName))
    .filter(Boolean);
}

export function parseSqlInventory(sqlText) {
  const inventory = createInventory();

  for (const match of sqlText.matchAll(TABLE_BLOCK_PATTERN)) {
    const tableName = match[1];
    const body = match[2];
    const columns = body
      .split("\n")
      .map((line) => line.replace(/,$/, ""))
      .map((line) => parseColumnName(line))
      .filter(Boolean);

    addColumns(inventory, tableName, columns);
  }

  return inventory;
}

export function parseMigrationInventory(files) {
  const inventory = createInventory();
  const coverageByFile = new Map();

  files.forEach(({ name, sql }) => {
    const fileInventory = createInventory();
    const createdTables = parseSqlInventory(sql);

    createdTables.forEach((columns, tableName) => {
      addColumns(fileInventory, tableName, [...columns]);
      addColumns(inventory, tableName, [...columns]);
    });

    for (const match of sql.matchAll(ALTER_TABLE_PATTERN)) {
      const tableName = match[1];
      const body = match[2];
      const columns = [];

      for (const addColumnMatch of body.matchAll(/add column(?: if not exists)? (\w+)/gi)) {
        columns.push(addColumnMatch[1]);
      }

      addColumns(fileInventory, tableName, columns);
      addColumns(inventory, tableName, columns);
    }

    coverageByFile.set(name, fileInventory);
  });

  return {
    inventory,
    coverageByFile,
  };
}

export function inventoryToObject(inventory) {
  return Object.fromEntries(
    [...inventory.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tableName, columns]) => [tableName, [...columns].sort()])
  );
}

export function parseStringConstants(sourceText) {
  const constants = new Map();

  for (const match of sourceText.matchAll(STRING_CONSTANT_PATTERN)) {
    constants.set(match[1], match[2]);
  }

  for (const match of sourceText.matchAll(ARRAY_JOIN_PATTERN)) {
    constants.set(match[1], parseStringLiterals(match[2]).join(", "));
  }

  return constants;
}

function resolveValue(expression, constants) {
  const trimmed = String(expression || "").trim();

  if (!trimmed) {
    return "";
  }

  const stringLiteral = trimmed.match(/^["'`]([^"'`]+)["'`]$/);

  if (stringLiteral) {
    return stringLiteral[1];
  }

  if (constants.has(trimmed)) {
    return constants.get(trimmed);
  }

  return "";
}

export function scanSourceDependencies(files, sharedConstants = new Map()) {
  const inventory = createInventory();

  files.forEach(({ path, source }) => {
    const constants = new Map(sharedConstants);
    parseStringConstants(source).forEach((value, key) => {
      constants.set(key, value);
    });

    for (const match of source.matchAll(FROM_PATTERN)) {
      const tableName = resolveValue(match[1], constants);

      if (tableName) {
        ensureInventoryEntry(inventory, tableName);
      }
    }

    for (const match of source.matchAll(FROM_SELECT_PATTERN)) {
      const tableName = resolveValue(match[1], constants);
      const selectValue = resolveValue(match[2], constants);

      if (!tableName) {
        continue;
      }

      addColumns(inventory, tableName, splitColumnList(selectValue));
    }

    if (!path) {
      return;
    }
  });

  return inventory;
}

export function buildRequiredTables({ sourceInventory, schemaHints }) {
  const requirements = new Map();

  sourceInventory.forEach((columns, tableName) => {
    requirements.set(tableName, {
      table: tableName,
      columns: new Set(columns),
      migrationFiles: [],
      migrationColumns: new Set(),
    });
  });

  Object.entries(schemaHints || {}).forEach(([tableName, hint]) => {
    const existing = requirements.get(tableName) || {
      table: tableName,
      columns: new Set(),
      migrationFiles: [],
      migrationColumns: new Set(),
    };

    (hint.requiredColumns || []).forEach((columnName) => existing.columns.add(columnName));
    (hint.migrationColumns || hint.requiredColumns || []).forEach((columnName) => existing.migrationColumns.add(columnName));
    existing.migrationFiles = [...new Set([...(existing.migrationFiles || []), ...(hint.migrationFiles || [])])];

    requirements.set(tableName, existing);
  });

  return requirements;
}

export function evaluateSchemaSync({
  requirements,
  schemaInventory,
  migrationInventory,
  migrationCoverageByFile,
}) {
  const errors = [];

  requirements.forEach((requirement, tableName) => {
    const schemaColumns = schemaInventory.get(tableName);

    if (!schemaColumns) {
      errors.push(`db/schema.sql is missing required table '${tableName}'.`);
      return;
    }

    [...requirement.columns].sort().forEach((columnName) => {
      if (!schemaColumns.has(columnName)) {
        errors.push(`db/schema.sql is missing required column '${tableName}.${columnName}'.`);
      }
    });

    if (!requirement.migrationFiles.length) {
      return;
    }

    requirement.migrationFiles.forEach((fileName) => {
      if (!migrationCoverageByFile.has(fileName)) {
        errors.push(`Expected migration file '${fileName}' for '${tableName}' is missing.`);
      }
    });

    const migrationColumns = migrationInventory.get(tableName) || new Set();

    [...requirement.migrationColumns].sort().forEach((columnName) => {
      if (!migrationColumns.has(columnName)) {
        errors.push(`Supabase migrations do not represent required column '${tableName}.${columnName}'.`);
      }
    });
  });

  return errors;
}

export function evaluateSchemaFileChanges(changedFiles = []) {
  const migrationFiles = changedFiles.filter(
    (filePath) =>
      filePath.startsWith("supabase/migrations/") && filePath.endsWith(".sql")
  );
  const schemaChanged = changedFiles.includes("db/schema.sql");
  const errors = [];

  if (schemaChanged && !migrationFiles.length) {
    errors.push("db/schema.sql changed without a matching migration in supabase/migrations/.");
  }

  if (migrationFiles.length && !schemaChanged) {
    errors.push(
      `Supabase migrations changed (${migrationFiles.join(", ")}) without updating db/schema.sql.`
    );
  }

  return errors;
}

export function readGithubEventPayload(eventPath) {
  if (!eventPath) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(eventPath, "utf8"));
  } catch {
    return null;
  }
}

export function resolveBaseSha(env = process.env, eventPayload = null) {
  const eventName = env.GITHUB_EVENT_NAME || "";

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return eventPayload?.pull_request?.base?.sha || "";
  }

  if (eventName === "push") {
    return eventPayload?.before || "";
  }

  return "";
}

export function listChangedFiles({ cwd, baseSha }) {
  if (!baseSha || /^0+$/.test(baseSha)) {
    return [];
  }

  const output = execFileSync("git", ["diff", "--name-only", `${baseSha}...HEAD`], {
    cwd,
    encoding: "utf8",
  });

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

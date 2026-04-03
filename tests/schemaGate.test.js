import test from "node:test";
import assert from "node:assert/strict";

import { PERSISTENCE_SCHEMA_HINTS } from "../src/services/schema/persistenceSchema.js";
import {
  buildRequiredTables,
  evaluateSchemaFileChanges,
  evaluateSchemaSync,
  parseMigrationInventory,
  parseSqlInventory,
} from "../scripts/lib/schemaGate.js";

test("schema hints cover recent required persistence tables", () => {
  const requiredTables = [
    "messages",
    "widget_configs",
    "agent_action_queue_statuses",
    "agent_follow_up_workflows",
    "operator_contacts",
    "operator_contact_identities",
  ];

  requiredTables.forEach((tableName) => {
    assert.ok(PERSISTENCE_SCHEMA_HINTS[tableName], `expected schema hint for ${tableName}`);
    assert.ok(
      (PERSISTENCE_SCHEMA_HINTS[tableName].migrationFiles || []).length > 0,
      `expected migration mapping for ${tableName}`
    );
  });
});

test("schema sync detects missing canonical and migration coverage", () => {
  const schemaInventory = parseSqlInventory(`
    create table if not exists public.messages (
      id uuid,
      agent_id uuid,
      role text,
      content text,
      created_at timestamp with time zone
    );
  `);
  const { inventory: migrationInventory, coverageByFile } = parseMigrationInventory([
    {
      name: "messages_visitor_identity.sql",
      sql: "create index if not exists messages_agent_id_idx on public.messages (agent_id);",
    },
  ]);
  const requirements = buildRequiredTables({
    sourceInventory: new Map([
      ["messages", new Set(["id", "agent_id", "role", "content", "session_key", "created_at"])],
    ]),
    schemaHints: {
      messages: {
        requiredColumns: ["id", "agent_id", "role", "content", "session_key", "created_at"],
        migrationFiles: ["messages_visitor_identity.sql"],
        migrationColumns: ["session_key"],
      },
    },
  });

  const errors = evaluateSchemaSync({
    requirements,
    schemaInventory,
    migrationInventory,
    migrationCoverageByFile: coverageByFile,
  });

  assert.ok(errors.some((message) => message.includes("db/schema.sql is missing required column 'messages.session_key'")));
  assert.ok(errors.some((message) => message.includes("db migrations do not represent required column 'messages.session_key'")));
});

test("schema file enforcement requires schema.sql and migrations together", () => {
  assert.deepEqual(
    evaluateSchemaFileChanges(["db/schema.sql"]),
    ["db/schema.sql changed without a matching incremental migration in db/."]
  );

  const migrationOnlyErrors = evaluateSchemaFileChanges(["db/messages_visitor_identity.sql"]);
  assert.equal(migrationOnlyErrors.length, 1);
  assert.match(migrationOnlyErrors[0], /without updating db\/schema\.sql/i);

  assert.deepEqual(
    evaluateSchemaFileChanges(["db/schema.sql", "db/messages_visitor_identity.sql"]),
    []
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import { validateStartupSchemaReady } from "../src/services/schema/startupSchemaService.js";

function createSchemaProbeSupabase(failures = {}) {
  return {
    from(tableName) {
      return {
        select() {
          return {
            limit() {
              const failure = failures[tableName];

              if (failure) {
                return Promise.resolve({
                  data: null,
                  error: {
                    code: failure.code,
                    message: failure.message,
                  },
                });
              }

              return Promise.resolve({
                data: [],
                error: null,
              });
            },
          };
        },
      };
    },
  };
}

test("startup schema validation passes when required tables are available", async () => {
  await assert.doesNotReject(() =>
    validateStartupSchemaReady(createSchemaProbeSupabase(), { phase: "test" })
  );
});

test("startup schema validation fails loudly for missing messages schema", async () => {
  await assert.rejects(
    () =>
      validateStartupSchemaReady(
        createSchemaProbeSupabase({
          messages: {
            code: "42P01",
            message: "relation public.messages does not exist",
          },
        }),
        { phase: "test" }
      ),
    /message persistence schema/i
  );
});

test("startup schema validation fails loudly for missing widget config schema", async () => {
  await assert.rejects(
    () =>
      validateStartupSchemaReady(
        createSchemaProbeSupabase({
          widget_configs: {
            code: "42703",
            message: "column last_verification_status does not exist",
          },
        }),
        { phase: "test" }
      ),
    /install schema/i
  );
});

test("startup schema validation fails loudly for missing widget telemetry schema with manifest guidance", async () => {
  await assert.rejects(
    () =>
      validateStartupSchemaReady(
        createSchemaProbeSupabase({
          agent_widget_events: {
            code: "42P01",
            message: "relation public.agent_widget_events does not exist",
          },
        }),
        { phase: "test" }
      ),
    /supabase\/migrations\/20260404000300_install_verification_activation_loop\.sql/i
  );
});

test("startup schema validation fails loudly for missing action queue schema", async () => {
  await assert.rejects(
    () =>
      validateStartupSchemaReady(
        createSchemaProbeSupabase({
          agent_action_queue_statuses: {
            code: "42703",
            message: "column follow_up_completed does not exist",
          },
        }),
        { phase: "test" }
      ),
    /action queue schema/i
  );
});

test("startup schema validation fails loudly for missing follow-up workflow schema", async () => {
  await assert.rejects(
    () =>
      validateStartupSchemaReady(
        createSchemaProbeSupabase({
          agent_follow_up_workflows: {
            code: "42P01",
            message: "relation public.agent_follow_up_workflows does not exist",
          },
        }),
        { phase: "test" }
      ),
    /follow-up workflow schema/i
  );
});

test("startup schema validation errors map directly to the recovery bundle docs", async () => {
  await assert.rejects(
    () =>
      validateStartupSchemaReady(
        createSchemaProbeSupabase({
          messages: {
            code: "42P01",
            message: "relation public.messages does not exist",
          },
        }),
        { phase: "test" }
      ),
    /docs\/sql\/prod_recovery_startup\.sql/i
  );
});

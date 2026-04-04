import {
  buildStartupSchemaManifestMessage,
  STARTUP_SCHEMA_CHECKS,
} from "./deployReadinessManifest.js";

export async function validateStartupSchemaReady(supabase, options = {}) {
  const phase = options.phase || "startup";

  for (const check of STARTUP_SCHEMA_CHECKS) {
    try {
      await check.assertReady(supabase, { phase });
    } catch (error) {
      if (error?.code !== "schema_not_ready") {
        throw error;
      }

      const manifestError = new Error(
        buildStartupSchemaManifestMessage({ phase, check, cause: error })
      );
      manifestError.statusCode = error.statusCode || 500;
      manifestError.code = error.code;
      manifestError.cause = error;
      manifestError.startupCheckId = check.id;
      manifestError.requiredMigrationIds = [...check.migrationIds];
      manifestError.prerequisiteMigrationIds = [...check.prerequisiteMigrationIds];
      throw manifestError;
    }
  }
}

import dotenv from "dotenv";

import { runDeployReadinessVerification } from "./lib/deployReadiness.js";

dotenv.config();

async function main() {
  await runDeployReadinessVerification();
  console.log("Production deploy-readiness verification passed.");
}

main().catch((error) => {
  console.error("Production deploy-readiness verification failed.");
  console.error(error.message || error);
  process.exit(1);
});

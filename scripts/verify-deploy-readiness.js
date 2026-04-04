import dotenv from "dotenv";

import { runDeployReadinessVerification } from "./lib/deployReadiness.js";

dotenv.config();

runDeployReadinessVerification().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

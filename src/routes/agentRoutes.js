import express from "express";

import { getSupabaseClient } from "../clients/supabaseClient.js";
import { getWidgetBootstrap } from "../services/agents/agentService.js";

export function createAgentRouter() {
  const router = express.Router();

  router.get("/widget/bootstrap", async (req, res) => {
    try {
      const result = await getWidgetBootstrap(getSupabaseClient(), {
        agentId: req.query.agent_id || req.query.agentId,
        agentKey: req.query.agent_key || req.query.agentKey,
        businessId: req.query.business_id || req.query.businessId,
        websiteUrl: req.query.website_url || req.query.websiteUrl,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  return router;
}

import express from "express";

import { getSupabaseClient } from "../clients/supabaseClient.js";
import {
  createAgentForBusinessName,
  deleteAgent,
  getWidgetBootstrap,
  listAllAgents,
  listAgents,
  resolveAgentContext,
  updateAgentSettings,
} from "../services/agents/agentService.js";
import { listAgentMessages } from "../services/chat/messageService.js";
import { extractBusinessWebsiteContent } from "../services/scraping/websiteContentService.js";

export function createAgentRouter() {
  const router = express.Router();
  const getAdminToken = (req) => req.query.token || req.headers["x-admin-token"];

  function ensureAdminAccess(req) {
    const configuredToken = process.env.ADMIN_TOKEN;

    if (!configuredToken) {
      const error = new Error("ADMIN_TOKEN is not configured on the server.");
      error.statusCode = 403;
      throw error;
    }

    if (getAdminToken(req) !== configuredToken) {
      const error = new Error("Forbidden");
      error.statusCode = 403;
      throw error;
    }
  }

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

  router.post("/agents/create", async (req, res) => {
    try {
      const result = await createAgentForBusinessName(
        getSupabaseClient(),
        req.body.business_name,
        req.body.website_url || req.body.websiteUrl,
        req.body.client_id || req.body.clientId
      );

      res.json({
        agent_id: result.agent.id,
        agent_key: result.agent.publicAgentKey,
        business_id: result.business.id,
      });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.get("/agents/list", async (_req, res) => {
    try {
      const agents = await listAgents(
        getSupabaseClient(),
        _req.query.client_id || _req.query.clientId
      );
      res.json({ agents });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.get("/agents/admin-list", async (req, res) => {
    try {
      ensureAdminAccess(req);
      const agents = await listAllAgents(getSupabaseClient());
      res.json({ agents });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.get("/agents/messages", async (req, res) => {
    try {
      const messages = await listAgentMessages(
        getSupabaseClient(),
        req.query.agent_id || req.query.agentId
      );
      res.json({ messages });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/update", async (req, res) => {
    try {
      const result = await updateAgentSettings(getSupabaseClient(), {
        agentId: req.body.agent_id || req.body.agentId,
        name: req.body.name,
        assistantName: req.body.assistant_name || req.body.assistantName,
        tone: req.body.tone,
        systemPrompt: req.body.system_prompt || req.body.systemPrompt,
        welcomeMessage: req.body.welcome_message || req.body.welcomeMessage,
        buttonLabel: req.body.button_label || req.body.buttonLabel,
        websiteUrl: req.body.website_url || req.body.websiteUrl,
        primaryColor: req.body.primary_color || req.body.primaryColor,
        secondaryColor: req.body.secondary_color || req.body.secondaryColor,
      });

      res.json({ ok: true, agent: result });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/delete", async (req, res) => {
    try {
      const result = await deleteAgent(getSupabaseClient(), req.body.agent_id || req.body.agentId);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/knowledge/import", async (req, res) => {
    try {
      const supabase = getSupabaseClient();
      const { business } = await resolveAgentContext(supabase, {
        agentKey: req.body.agent_key || req.body.agentKey,
        businessId: req.body.business_id || req.body.businessId,
      });

      const result = await extractBusinessWebsiteContent(supabase, {
        businessId: business.id,
        websiteUrl: business.website_url,
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

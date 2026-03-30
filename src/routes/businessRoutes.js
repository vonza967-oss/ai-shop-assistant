import express from "express";

import { getSupabaseClient } from "../clients/supabaseClient.js";
import {
  extractBusinessWebsiteContent,
  scrapeAllBusinesses,
} from "../services/scraping/websiteContentService.js";
import { requireAdminToken } from "../utils/httpGuards.js";

export function createBusinessRouter() {
  const router = express.Router();

  router.get("/businesses/:id/scrape", async (req, res) => {
    try {
      const result = await extractBusinessWebsiteContent(getSupabaseClient(), {
        businessId: req.params.id,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/businesses/scrape", requireAdminToken, async (req, res) => {
    try {
      const result = await extractBusinessWebsiteContent(getSupabaseClient(), {
        businessId: req.body.business_id || req.body.businessId,
        websiteUrl: req.body.website_url || req.body.websiteUrl,
        name: req.body.name,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/businesses/scrape-all", requireAdminToken, async (_req, res) => {
    try {
      const result = await scrapeAllBusinesses(getSupabaseClient());

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

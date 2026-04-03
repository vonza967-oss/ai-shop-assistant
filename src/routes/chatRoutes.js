import express from "express";

import { getOpenAIClient } from "../clients/openaiClient.js";
import { getSupabaseClient } from "../clients/supabaseClient.js";
import {
  handleChatRequest,
  handleLeadCaptureRequest,
} from "../services/chat/chatService.js";
import { enforceChatRateLimit } from "../utils/httpGuards.js";

export function createChatRouter(deps = {}) {
  const router = express.Router();
  const handleChatRequestImpl = deps.handleChatRequest || handleChatRequest;
  const handleLeadCaptureRequestImpl = deps.handleLeadCaptureRequest || handleLeadCaptureRequest;

  router.post("/chat", enforceChatRateLimit, async (req, res) => {
    try {
      const result = await handleChatRequestImpl({
        supabase: getSupabaseClient(),
        openai: getOpenAIClient(),
        body: req.body,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/chat/capture", enforceChatRateLimit, async (req, res) => {
    try {
      const result = await handleLeadCaptureRequestImpl({
        supabase: getSupabaseClient(),
        body: req.body,
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

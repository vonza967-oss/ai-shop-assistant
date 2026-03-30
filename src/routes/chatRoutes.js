import express from "express";

import { getOpenAIClient } from "../clients/openaiClient.js";
import { getSupabaseClient } from "../clients/supabaseClient.js";
import { handleChatRequest } from "../services/chat/chatService.js";
import { enforceChatRateLimit } from "../utils/httpGuards.js";

export function createChatRouter() {
  const router = express.Router();

  router.post("/chat", enforceChatRateLimit, async (req, res) => {
    try {
      const result = await handleChatRequest({
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

  return router;
}

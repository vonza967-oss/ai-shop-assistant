import { resolveAgentContext } from "../agents/agentService.js";
import {
  extractBusinessWebsiteContent,
  getStoredWebsiteContent,
} from "../scraping/websiteContentService.js";
import {
  buildBusinessContextForChat,
  buildChatSystemPrompt,
  buildConversationGuidance,
  getReplyRepairIssues,
  repairAssistantReply,
} from "./prompting.js";
import {
  buildEffectiveUserText,
  cleanText,
  detectResponseLanguage,
  formatConversationHistory,
  normalizeAssistantReply,
  sanitizeChatHistory,
} from "../../utils/text.js";

export async function handleChatRequest({
  supabase,
  openai,
  body,
}) {
  console.log("FULL BODY:", body);

  const message = body.message;
  const agentId = body.agent_id || body.agentId;
  const agentKey = body.agent_key || body.agentKey;
  const businessId = body.business_id || body.businessId;
  const websiteUrl = cleanText(body.website_url || body.websiteUrl || "");
  const history = sanitizeChatHistory(body.history);
  const effectiveUserText = buildEffectiveUserText(message || "", history);
  const conversationHistory = formatConversationHistory(history);
  let language = detectResponseLanguage(effectiveUserText || message || "");
  const conversationGuidance = buildConversationGuidance(message, history);

  console.log("USER MESSAGE:", message);
  console.log("CHAT HISTORY:", history);
  console.log("CONVERSATION GUIDANCE:", conversationGuidance);

  if (!message || !String(message).trim()) {
    const error = new Error("No message provided");
    error.statusCode = 400;
    throw error;
  }

  if (!agentId && !agentKey && !businessId && !websiteUrl) {
    const error = new Error(
      "agent_id, agent_key, business_id, or website_url is required"
    );
    error.statusCode = 400;
    throw error;
  }

  const { agent, business, widgetConfig } = await resolveAgentContext(supabase, {
    agentId,
    agentKey,
    businessId,
    websiteUrl,
    businessName: body.name,
  });

  if (agent.language && agent.language.toLowerCase() !== "auto") {
    language = agent.language;
  }

  let websiteContent = await getStoredWebsiteContent(supabase, business.id);
  if (!websiteContent) {
    websiteContent = await extractBusinessWebsiteContent(supabase, {
      businessId: business.id,
      websiteUrl: business.website_url,
    });
  }

  const businessContext = buildBusinessContextForChat(
    websiteContent,
    effectiveUserText
  );

  console.log("CHAT BUSINESS CONTEXT:", businessContext);

  const systemPrompt = buildChatSystemPrompt(language, agent);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.85,
    presence_penalty: 0.3,
    frequency_penalty: 0.35,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "system",
        content: `Business reference:\n\n${businessContext}`,
      },
      ...(conversationGuidance
        ? [
            {
              role: "system",
              content: `Conversation guidance:\n\n${conversationGuidance}`,
            },
          ]
        : []),
      ...history,
      { role: "user", content: message },
    ],
  });

  let finalReply = normalizeAssistantReply(
    completion.choices[0].message.content || ""
  );
  const repairIssues = getReplyRepairIssues(finalReply, language);

  console.log("INITIAL MODEL REPLY:", finalReply);
  console.log("REPLY REPAIR ISSUES:", repairIssues);

  if (repairIssues.length > 0) {
    finalReply = await repairAssistantReply(
      openai,
      finalReply,
      message,
      conversationHistory,
      language,
      repairIssues
    );
  }

  if (!finalReply) {
    const error = new Error("The assistant could not generate a reply.");
    error.statusCode = 502;
    throw error;
  }

  console.log("FINAL REPLY:", finalReply);

  return {
    reply: finalReply,
    agentId: agent.id,
    agentKey: agent.publicAgentKey,
    businessId: websiteContent.businessId,
    widgetConfig: {
      ...widgetConfig,
      assistantName: agent.name || widgetConfig.assistantName,
    },
  };
}

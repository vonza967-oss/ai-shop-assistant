import { resolveAgentContext } from "../agents/agentService.js";
import {
  getStoredWebsiteContent,
  hasVisualIntent,
  selectRelevantImageUrls,
} from "../scraping/websiteContentService.js";
import {
  buildBusinessContextForChat,
  buildChatSystemPrompt,
  buildConversationGuidance,
  getReplyRepairIssues,
  repairAssistantReply,
} from "./prompting.js";
import { storeAgentMessages } from "./messageService.js";
import {
  buildEffectiveUserText,
  cleanText,
  detectResponseLanguage,
  formatConversationHistory,
  normalizeAssistantReply,
  sanitizeChatHistory,
} from "../../utils/text.js";

function hasLimitedKnowledge(websiteContent) {
  return (websiteContent?.content || "").includes(
    "Limited content available. This assistant may give general answers."
  );
}

function appendImageLines(reply, websiteContent, userMessage) {
  if (!hasVisualIntent(userMessage)) {
    return reply;
  }

  const imageUrls = selectRelevantImageUrls(websiteContent, userMessage);

  if (!imageUrls.length) {
    return reply;
  }

  return `${reply}\n\n${imageUrls.map((url) => `Image: ${url}`).join("\n")}`;
}

function buildLimitedKnowledgeReply(language, agentName, websiteContent) {
  const name = cleanText(agentName || websiteContent?.pageTitle || "This assistant");
  const rawMetaDescription = cleanText(websiteContent?.metaDescription || "");
  const metaDescription =
    rawMetaDescription === "Limited content available. This assistant may give general answers."
      ? ""
      : rawMetaDescription;
  const siteLabel = cleanText(
    websiteContent?.pageTitle ||
      websiteContent?.websiteUrl ||
      agentName ||
      "the business"
  );

  if (language === "Hungarian") {
    const summary = metaDescription
      ? `${name} kapcsán jelenleg ennyi biztos látszik: ${metaDescription}`
      : `${name} kapcsán jelenleg csak korlátozott weboldal-információ érhető el, ezért részletes céges adatokat nem tudok biztosan megmondani.`;
    return `${summary} Abban viszont tudok segíteni, hogy gyorsan leszűkítsük, mit keresel ezzel a szolgáltatóval kapcsolatban, és mi legyen a következő lépés. Pontosan miben szeretnél segítséget: szolgáltatás választásban, árajánlat irányban, vagy annak tisztázásában, hogy ${siteLabel} valóban neked való-e?`;
  }

  const summary = metaDescription
      ? `${name} can at least be described this way from the available website data: ${metaDescription}`
      : `${name} currently has only limited website information available, so I should not guess detailed facts about the business.`;
  return `${summary} I can still help you narrow down what you need and point you toward the most useful next step. What are you looking for specifically: help choosing a service, understanding pricing direction, or deciding whether ${siteLabel} is the right fit for what you need?`;
}

async function buildChatResponse({ supabase, agent, businessId, widgetConfig, userMessage, reply }) {
  await storeAgentMessages(supabase, agent.id, [
    { role: "user", content: userMessage },
    { role: "assistant", content: reply },
  ]);

  return {
    reply,
    agentId: agent.id,
    agentKey: agent.publicAgentKey,
    businessId,
    widgetConfig: {
      ...widgetConfig,
      assistantName: agent.name || widgetConfig.assistantName,
    },
  };
}

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
  const normalizedMessage = cleanText(message || "");
  const language = detectResponseLanguage(normalizedMessage);
  const conversationGuidance = buildConversationGuidance(message, history);

  console.log("USER MESSAGE:", message);
  console.log("CHAT HISTORY:", history);
  console.log("CONVERSATION GUIDANCE:", conversationGuidance);

  if (!message || !String(message).trim()) {
    const error = new Error("Message cannot be empty.");
    error.statusCode = 400;
    throw error;
  }

  if (!agentKey && !businessId) {
    const error = new Error(
      "agent_key or business_id is required."
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

  const websiteContent = await getStoredWebsiteContent(supabase, business.id);

  if (!websiteContent) {
    const fallbackReply =
      language === "Hungarian"
        ? "Ez az asszisztens még nincs teljesen felkészítve, mert a weboldal tartalma még nincs betöltve. Kérlek próbáld újra később, vagy kérd meg az adminisztrátort, hogy futtassa a tartalom importálását."
        : "This assistant is not ready yet because the website content has not been imported. Please try again later or ask an admin to run the content import.";

    return buildChatResponse({
      supabase,
      agent,
      businessId: business.id,
      widgetConfig,
      userMessage: message,
      reply: fallbackReply,
    });
  }

  if (hasLimitedKnowledge(websiteContent)) {
    return buildChatResponse({
      supabase,
      agent,
      businessId: websiteContent.businessId,
      widgetConfig,
      userMessage: message,
      reply: appendImageLines(
        buildLimitedKnowledgeReply(
          language,
          agent.name || widgetConfig.assistantName,
          websiteContent
        ),
        websiteContent,
        message
      ),
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

  return buildChatResponse({
    supabase,
    agent,
    businessId: websiteContent.businessId,
    widgetConfig,
    userMessage: message,
    reply: appendImageLines(finalReply, websiteContent, message),
  });
}

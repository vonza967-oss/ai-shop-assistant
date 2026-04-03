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
import {
  assertMessagesSchemaReady,
  storeAgentMessages,
} from "./messageService.js";
import {
  applyLeadCaptureAction,
  processLiveChatLeadCapture,
} from "../leads/liveLeadCaptureService.js";
import { evaluateLiveConversionRouting } from "../conversion/liveConversionRoutingService.js";
import { listRecentWidgetEvents } from "../analytics/widgetTelemetryService.js";
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

function stripRawAssetUrls(reply = "") {
  return cleanText(
    String(reply || "")
      .replace(/https?:\/\/\S+\.(?:avif|gif|jpe?g|png|webp)(?:[?#]\S*)?/gi, "")
      .replace(/\n{3,}/g, "\n\n")
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

  return `${reply}\n\nRelevant image links:\n${imageUrls.map((url) => `- ${url}`).join("\n")}`;
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
      ? `${name} kapcsán ennyi látszik biztosan a weboldalból: ${metaDescription}`
      : `${name} kapcsán nem látok elég részletes információt a weboldalból ehhez a kérdéshez.`;
    return `${summary} Ha szeretnéd, segítek leszűkíteni a következő lépést. Szolgáltatást keresel, árazás érdekel, vagy az a fontos, hogyan tudod felvenni velük a kapcsolatot?`;
  }

  const summary = metaDescription
      ? `From the website, this is the clearest detail I have about ${name}: ${metaDescription}`
      : `I don't have enough detail from the website to answer that confidently about ${name}.`;
  return `${summary} I can still help with the next step. Are you trying to understand their services, pricing, or how to contact ${siteLabel}?`;
}

async function buildChatResponse({
  supabase,
  agent,
  businessId,
  widgetConfig,
  userMessage,
  reply,
  sessionKey,
  leadCapture = null,
  directRouting = null,
}) {
  await storeAgentMessages(supabase, agent.id, [
    { role: "user", content: userMessage },
    { role: "assistant", content: reply },
  ], {
    sessionKey,
  });

  return {
    reply,
    agentId: agent.id,
    agentKey: agent.publicAgentKey,
    businessId,
    widgetConfig: {
      ...widgetConfig,
      assistantName: agent.name || widgetConfig.assistantName,
    },
    leadCapture,
    directRouting,
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
  const sessionKey = cleanText(body.visitor_session_key || body.visitorSessionKey || "");
  const installId = cleanText(body.install_id || body.installId || "");
  const pageUrl = cleanText(body.page_url || body.pageUrl || "");
  const origin = cleanText(body.origin || "");
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
  await assertMessagesSchemaReady(supabase, { phase: "request" });

  if (!websiteContent) {
    const fallbackReply =
      language === "Hungarian"
        ? "Ehhez még nincs betöltött weboldal-tartalom, ezért nem tudok biztos választ adni a weboldal alapján. Kérlek próbáld újra később, vagy kérd meg az adminisztrátort, hogy futtassa a tartalom importálását."
        : "I don't have website content for this assistant yet, so I can't answer that from the site. Please try again later or ask an admin to run the content import.";

    return buildChatResponse({
      supabase,
      agent,
      businessId: business.id,
      widgetConfig,
      userMessage: message,
      reply: fallbackReply,
      sessionKey,
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
      sessionKey,
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

  let finalReply = stripRawAssetUrls(
    normalizeAssistantReply(
      completion.choices[0].message.content || ""
    )
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
    finalReply = stripRawAssetUrls(finalReply);
  }

  if (!finalReply) {
    const error = new Error("The assistant could not generate a reply.");
    error.statusCode = 502;
    throw error;
  }

  console.log("FINAL REPLY:", finalReply);

  const leadCapture = await processLiveChatLeadCapture(supabase, {
    agent,
    business,
    widgetConfig,
    sessionKey,
    installId,
    pageUrl,
    origin,
    userMessage: message,
    language,
  });
  const recentWidgetEvents = await listRecentWidgetEvents(supabase, {
    agentId: agent.id,
    installId: installId || widgetConfig.installId,
    sessionId: sessionKey,
  });
  const directRouting = evaluateLiveConversionRouting({
    widgetConfig,
    userMessage: message,
    sessionKey,
    leadCapture,
    recentWidgetEvents,
  });

  console.info("[live routing] Evaluated direct conversion routing.", {
    agentId: agent.id,
    sessionKey,
    mode: directRouting?.mode || "chat_only",
    intentType: directRouting?.intentType || "",
    ctaType: directRouting?.primaryCta?.ctaType || "",
    suppressReason: directRouting?.suppressReason || "",
  });

  return buildChatResponse({
    supabase,
    agent,
    businessId: websiteContent.businessId,
    widgetConfig,
    userMessage: message,
    reply: appendImageLines(finalReply, websiteContent, message),
    sessionKey,
    leadCapture,
    directRouting,
  });
}

export async function handleLeadCaptureRequest({
  supabase,
  body,
}) {
  const agentId = body.agent_id || body.agentId;
  const agentKey = body.agent_key || body.agentKey;
  const businessId = body.business_id || body.businessId;
  const websiteUrl = cleanText(body.website_url || body.websiteUrl || "");
  const sessionKey = cleanText(body.visitor_session_key || body.visitorSessionKey || "");
  const installId = cleanText(body.install_id || body.installId || "");
  const pageUrl = cleanText(body.page_url || body.pageUrl || "");
  const origin = cleanText(body.origin || "");
  const action = cleanText(body.action).toLowerCase();
  const referenceMessage = cleanText(body.reference_message || body.referenceMessage || "");
  const language = detectResponseLanguage(referenceMessage);

  if (!agentKey && !businessId && !agentId) {
    const error = new Error("agent_id, agent_key, or business_id is required.");
    error.statusCode = 400;
    throw error;
  }

  if (!action) {
    const error = new Error("action is required.");
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

  const leadCapture = await applyLeadCaptureAction(supabase, {
    agent,
    business,
    widgetConfig,
    action,
    sessionKey,
    installId,
    pageUrl,
    origin,
    language,
    userMessage: referenceMessage,
    name: body.name,
    email: body.email,
    phone: body.phone,
    preferredChannel: body.preferred_channel || body.preferredChannel,
  });

  return {
    ok: true,
    agentId: agent.id,
    agentKey: agent.publicAgentKey,
    businessId: business.id,
    leadCapture,
  };
}

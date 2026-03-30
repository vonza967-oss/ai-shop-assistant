import {
  appearsHungarian,
  buildEffectiveUserText,
  cleanText,
  containsQuestion,
  detectMessageTopics,
  isGreetingMessage,
  normalizeAssistantReply,
} from "../../utils/text.js";
import { buildRelevantContextBlock } from "../scraping/websiteContentService.js";

export function extractServiceHints(text) {
  const serviceDefinitions = [
    { label: "Céges weboldal", pattern: /céges weboldal/i },
    { label: "Webáruház / webshop", pattern: /webáruház|webshop/i },
    { label: "Személyes / portfólió oldal", pattern: /portfólió|portfolio/i },
    { label: "SEO optimalizálás", pattern: /\bseo\b|keresőoptimaliz/i },
    { label: "Weboldal karbantartás", pattern: /karbantart/i },
    { label: "Weboldal audit", pattern: /\baudit\b/i },
    { label: "Gyorsaság optimalizálás", pattern: /gyorsaság optimaliz/i },
  ];

  return serviceDefinitions
    .filter((service) => service.pattern.test(text))
    .map((service) => service.label)
    .slice(0, 6);
}

export function extractContactDetails(text) {
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phoneMatch = text.match(/(?:\+?\d[\d\s()-]{7,}\d)/);
  const details = [];

  if (emailMatch?.[0]) {
    details.push(`Email: ${emailMatch[0]}`);
  }

  if (phoneMatch?.[0]) {
    details.push(`Phone: ${cleanText(phoneMatch[0])}`);
  }

  return details.join(" | ");
}

export function buildBusinessContextForChat(contentRecord, userMessage) {
  const relevantContext = buildRelevantContextBlock(contentRecord, userMessage);
  const serviceHints = extractServiceHints(contentRecord.content);
  const contactDetails = extractContactDetails(contentRecord.content);

  return [
    "Use the business information below as factual reference only.",
    "Do not copy its marketing tone.",
    serviceHints.length
      ? `Services or offers mentioned on the site: ${serviceHints.join(", ")}.`
      : "",
    contactDetails ? `Contact details on the site: ${contactDetails}.` : "",
    "Most relevant website excerpts:",
    relevantContext || contentRecord.content.slice(0, 9000),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildChatSystemPrompt(language, agent = {}) {
  const customPrompt = cleanText(agent.systemPrompt || "");
  const purpose = cleanText(agent.purpose || "");
  const tone = cleanText(agent.tone || "");
  const agentName = cleanText(agent.name || "the assistant");

  return `You are a thoughtful personal advisor helping a visitor figure out the best next step with this business.

Your mission:
- understand what the user is actually trying to achieve
- guide them toward the most relevant product, service, or next step
- make the decision process feel easy, personal, and clear
- represent the assistant identity as ${agentName}
${purpose ? `- primary assistant purpose: ${purpose}` : ""}

How to behave:
- Always reply in ${language}
- Use the latest user message and the recent conversation together
- When the content supports it, start by clearly summarizing what the business does in 1-2 sentences
- When the content supports it, mention exactly 2-3 concrete services, offers, or deliverables from the scraped content
- Prioritize concrete facts from the content over general advice
- Prefer specific details from headings, titles, descriptions, and clearly stated service sections before giving a broader summary
- If the user follows up, continue from the last relevant point instead of restarting
- If the user is vague, narrow the decision with 2-3 tailored options
- If the user is leaning toward one direction, explain that direction more specifically
- If the user reacts to a previous option like "the more detailed one sounds better", continue from that exact option instead of restarting the conversation
- Explain the practical difference in plain language before naming a package or tier
- If the user asks about price, explain what affects the price and what option seems closest, but do not invent numbers
- If the user asks about price before choosing a service, narrow the scope first instead of pushing a consultation immediately
- If the user asks how the business can help, answer with specific ways that fit the user's situation
- Match the answer shape to the user's intent: clear summary for general questions, concrete offerings for service questions, pricing factors for pricing questions, and practical next steps for contact questions
- If image URLs are present in the provided business content and the user asks for visuals, naturally mention what the image likely shows based on the surrounding content
- When image URLs are available, do not claim that you cannot show images
- Mention the business only as a possible solution, not as the center of the answer
- Use the business information as factual ground truth, but do not copy its wording
- Avoid vague wording like "they may offer", "it seems like", or "probably"

Style:
- natural, human, and helpful
- concise, usually 3-5 sentences
- short paragraphs
- no fluff
- no robotic repetition
- no generic marketing language
- sound like a person explaining something clearly, not a template
- vary sentence openings and rhythm so answers do not all feel the same
- do not force the same structure in every reply
${tone ? `- preferred tone: ${tone}` : ""}

Hard rules:
- Do not invent facts, services, prices, or guarantees
- Do not speak as "we" or as the company
- Do not sound like a scripted chatbot or advertisement
- Avoid sounding like you are trying to close the sale too early
- If specific information exists in the content, use it directly instead of generalizing
- Do not skip obvious facts that are clearly present in the content
- If image URLs are included after the main answer, treat them as part of the reply rather than rejecting them
- End with one clear next-step question that moves the conversation forward

${customPrompt ? `Additional agent instructions:\n${customPrompt}` : ""}`;
}

export function detectUserIntent(message, history) {
  const combinedUserText = buildEffectiveUserText(message, history).toLowerCase();

  if (
    /(mennyi|mennyibe|kerul|kerül|kerulne|kerülne|ár|árak|price|cost|pricing|quote|budget|ajánlat)/i.test(
      combinedUserText
    )
  ) {
    return "pricing";
  }

  if (
    /(kapcsolat|contact|elérhetőség|elerhetoseg|reach|email|phone|call|next step|következő lépés|kovetkezo lepes|inquiry|enquiry)/i.test(
      combinedUserText
    )
  ) {
    return "contact";
  }

  if (
    /(szolgáltatás|szolgaltatas|services|offer|offering|what do they offer|mit kínál|mit kinal|mivel tud segíteni|mivel tud segiteni)/i.test(
      combinedUserText
    )
  ) {
    return "services";
  }

  if (
    /(what does.*do|what is.*business|what is.*company|mivel foglalkoz|mit csinál|mit csinal|what do you do|what does this business do)/i.test(
      combinedUserText
    )
  ) {
    return "general";
  }

  return "general";
}

export function buildConversationGuidance(message, history) {
  const normalizedMessage = message.toLowerCase();
  const combinedUserText = buildEffectiveUserText(message, history).toLowerCase();
  const topics = detectMessageTopics(combinedUserText);
  const intent = detectUserIntent(message, history);
  const guidance = [];

  if (intent === "services") {
    guidance.push(
      "The user wants to know the actual services or offerings. Focus on concrete offerings from the content instead of a broad company overview."
    );
  }

  if (intent === "general") {
    guidance.push(
      "The user wants a clear overview. Start with a direct explanation of what the business does, then mention only the most relevant concrete examples."
    );
  }

  if (intent === "pricing") {
    guidance.push(
      "The user is asking about pricing. Explain what factors affect the price, connect those factors to the available services, and do not invent numbers."
    );
  }

  if (intent === "contact") {
    guidance.push(
      "The user wants contact or next-step guidance. Use any concrete contact details in the content and guide them toward the most practical next action."
    );
  }

  if (isGreetingMessage(message) && history.length === 0) {
    guidance.push(
      "The user is only greeting you. Keep it brief, friendly, and invite them to share what they want help deciding."
    );
  }

  if (
    /(mennyi|mennyibe|kerul|kerül|kerulne|kerülne|ár|price|cost|quote)/i.test(combinedUserText) &&
    !topics.includes("website") &&
    !topics.includes("webshop")
  ) {
    guidance.push(
      "The user is asking about price before clearly choosing a service. First narrow down whether they mean a company website, webshop, or a more advanced setup."
    );
  }

  if (
    /(reszletesebb|részletesebb|jobban hangzik|detailed|more advanced|premium)/i.test(
      normalizedMessage
    )
  ) {
    guidance.push(
      "The user is leaning toward a more detailed route. Explain what becomes more detailed in practical terms before naming any package or tier."
    );
  }

  if (
    /(miben tudsz|miben segitesz|miben segítesz|how can you help|what can you help with)/i.test(
      combinedUserText
    )
  ) {
    guidance.push(
      "Answer specifically how the business can help in this situation. Do not give a generic service list."
    );
  }

  if (history.length > 0 && cleanText(message).split(/\s+/).length <= 8) {
    guidance.push(
      "This is likely a follow-up. Answer it in the context of the earlier conversation instead of restarting discovery."
    );
  }

  return guidance.join("\n");
}

export function getReplyRepairIssues(reply, language) {
  const issues = [];

  if (!reply) {
    issues.push("reply is empty");
  }

  if (language === "Hungarian" && reply && !appearsHungarian(reply)) {
    issues.push("reply must be in Hungarian");
  }

  if (reply && !containsQuestion(reply)) {
    issues.push("reply must end with one clear next-step question");
  }

  return issues;
}

export async function repairAssistantReply(
  openai,
  reply,
  userMessage,
  history,
  language,
  issues
) {
  const rewrite = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    messages: [
      {
        role: "system",
        content: `Rewrite the reply so it sounds like a smart personal advisor.
- Always reply in ${language}
- Keep the meaning, but make it sound natural and specific
- Answer the user's latest message directly
- Use the recent conversation for continuity
- End with one clear next-step question
- Do not sound like a company or advertisement
- Vary the phrasing so it feels conversational and not formulaic
- Avoid rigid patterns that make the answer sound like a template
- If the reply includes image URLs, keep them and make the text before them feel natural and visually helpful

Return only the improved reply.`,
      },
      {
        role: "user",
        content: `Latest user message:\n${userMessage}\n\nRecent conversation:\n${history}\n\nIssues to fix:\n${issues.join(", ")}\n\nReply:\n${reply}`,
      },
    ],
  });

  return normalizeAssistantReply(rewrite.choices[0].message.content || "");
}

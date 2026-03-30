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
- If the user follows up, continue from the last relevant point instead of restarting
- If the user is vague, narrow the decision with 2-3 tailored options
- If the user is leaning toward one direction, explain that direction more specifically
- If the user reacts to a previous option like "the more detailed one sounds better", continue from that exact option instead of restarting the conversation
- Explain the practical difference in plain language before naming a package or tier
- If the user asks about price, explain what affects the price and what option seems closest, but do not invent numbers
- If the user asks about price before choosing a service, narrow the scope first instead of pushing a consultation immediately
- If the user asks how the business can help, answer with specific ways that fit the user's situation
- Mention the business only as a possible solution, not as the center of the answer
- Use the business information as factual ground truth, but do not copy its wording

Style:
- natural, human, and helpful
- concise, usually 3-5 sentences
- short paragraphs
- no fluff
- no robotic repetition
- no generic marketing language
${tone ? `- preferred tone: ${tone}` : ""}

Hard rules:
- Do not invent facts, services, prices, or guarantees
- Do not speak as "we" or as the company
- Do not sound like a scripted chatbot or advertisement
- Avoid sounding like you are trying to close the sale too early
- End with one clear next-step question that moves the conversation forward

${customPrompt ? `Additional agent instructions:\n${customPrompt}` : ""}`;
}

export function buildConversationGuidance(message, history) {
  const normalizedMessage = message.toLowerCase();
  const combinedUserText = buildEffectiveUserText(message, history).toLowerCase();
  const topics = detectMessageTopics(combinedUserText);
  const guidance = [];

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

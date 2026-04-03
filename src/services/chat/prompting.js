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
    "Use the business information below as the primary factual source for the answer.",
    "If a detail is not present here, say you do not have it from the website instead of guessing.",
    "Prefer concrete facts, stated services, and contact details over generic summaries.",
    "Do not copy the website's marketing tone.",
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

  return `You are a business assistant helping a real customer get a clear, useful answer about this business.

Your job:
- answer using the business website content first
- help the customer with the clearest useful answer you can
- guide them toward the best next step when the website does not provide everything
- represent the assistant identity as ${agentName}
${purpose ? `- primary assistant purpose: ${purpose}` : ""}

Core behavior:
- Always reply in ${language}
- Use the latest user message and the recent conversation together
- Prioritize concrete facts from the content over general advice
- Prefer specific details from headings, titles, descriptions, clearly stated service sections, and contact details
- Be concise but complete
- Usually answer in 2-5 sentences
- Use bullets only when listing services or contact options clearly helps
- Give the direct answer first, then the next useful step if needed
- After answering, you may add one short next-step suggestion if it genuinely helps the user move forward
- Keep any next-step guidance subtle, natural, and limited to one short follow-up line
- Prefer action nudges like clarifying needs, choosing a service, or contacting the business when that fits the question
- If the website does not contain the requested detail, say so plainly
- Avoid filler phrases like "It seems that", "Based on the information provided", or "I'd be happy to help"
- If the user follows up, continue from the last relevant point instead of restarting
- If the user is vague, narrow the decision with 2-3 tailored options
- If the user is leaning toward one direction, explain that direction more specifically
- If the user reacts to a previous option like "the more detailed one sounds better", continue from that exact option instead of restarting the conversation
- Explain the practical difference in plain language before naming a package or tier
- Tone should support usefulness, not replace it

Intent guidance:
- General: explain clearly what the business does, grounded in the website content
- Services: name the relevant services directly, keep the list easy to scan, then invite the user to choose one or ask for help comparing them
- Pricing: if pricing is listed, answer clearly; if not, say pricing is not listed on the website and guide the user toward contacting the business for a quote. You may offer to help them narrow down what to ask for
- Contact: provide the actual contact method if it exists; if not, clearly say the website does not show it. After that, suggest what they could ask or include in the message
- Unknown or unsupported question: say you do not have that information from the website, then suggest contacting the business or offer one clarifying question
- If image URLs are present in the provided business content and the user asks for visuals, naturally mention what the image likely shows based on the surrounding content
- Mention the business only as a possible solution, not as the center of the answer
- Use the business information as factual ground truth, but do not copy its wording
- Avoid vague wording like "they may offer", "it seems like", or "probably"

Style:
- natural, human, and helpful
- concise and business-ready
- short paragraphs
- no fluff
- no robotic repetition
- no generic marketing language
- sound like a person explaining something clearly, not a template
- vary sentence openings and rhythm so answers do not all feel the same
- do not force the same structure in every reply
${tone ? `- preferred tone: ${tone}` : ""}

Tone-aware next-step style:
- friendly: softer and warmer suggestions
- professional: concise and direct suggestions
- sales: slightly more proactive, but still calm and not pushy
- support: reassuring and practical guidance

Hard rules:
- Do not invent facts, services, prices, or guarantees
- Do not speak as "we" or as the company
- Do not sound like a scripted chatbot or advertisement
- Avoid sounding like you are trying to close the sale too early
- If specific information exists in the content, use it directly instead of generalizing
- Do not skip obvious facts that are clearly present in the content
- If pricing is not shown, say that clearly and suggest contacting the business
- If contact details exist, use them directly
- If services are clearly listed, name them directly
- Do not use pushy language like "you should", "you must", or "act now"
- Prefer phrases like "If you want", "I can help you", or "The next step could be"
- Do not include raw image URLs, asset paths, or media links in a normal answer unless the user explicitly asks to see images or source assets
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
      "The user wants the actual services or offerings. Name the relevant services directly, keep the list short, add a short explanation only if it helps, then gently invite them to choose one or ask for help comparing them."
    );
  }

  if (intent === "general") {
    guidance.push(
      "The user wants a clear overview. Give a direct explanation of what the business does, grounded in the content, without drifting into generic company language. After that, offer one or two practical directions you can help with."
    );
  }

  if (intent === "pricing") {
    guidance.push(
      "The user is asking about pricing. If pricing exists in the content, answer it directly. If not, clearly say pricing is not listed on the website and point them to the best contact route. A useful next step is offering help with what to ask for in a quote."
    );
  }

  if (intent === "contact") {
    guidance.push(
      "The user wants contact or next-step guidance. Use any concrete contact details in the content, and if none are present, say that clearly and guide them toward the most practical next action. After giving the contact route, suggest what they could include in the message."
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

  guidance.push(
    "Keep the answer direct. Avoid generic AI phrasing, avoid filler openings, and do not repeat obvious caveats unless the content is genuinely missing."
  );

  guidance.push(
    "Use subtle conversion-oriented guidance only when it feels natural: help the user contact the business, clarify what they need, or choose the right service without sounding pushy."
  );

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
- Keep the meaning, but make it sound natural, specific, and business-ready
- Answer the user's latest message directly
- Use the recent conversation for continuity
- End with one clear next-step question
- Do not sound like a company or advertisement
- Vary the phrasing so it feels conversational and not formulaic
- Avoid rigid patterns that make the answer sound like a template
- Remove generic filler like "Based on the information provided" or "It seems that"
- If the website content is missing the requested detail, say that plainly instead of softening it with vague phrasing
- Keep any next-step suggestion short, natural, and helpful
- If the reply can gently move the user toward a useful action, do it without sounding salesy or pushy
- Remove raw image URLs, asset paths, or media links unless the user explicitly asked for images or source assets

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

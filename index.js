import express from "express";
import dotenv from "dotenv";
import cors from "cors"; 
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import axios from "axios";
import * as cheerio from "cheerio";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const BUSINESSES_TABLE = "businesses";
const WEBSITE_CONTENT_TABLE = "website_content";
const MAX_CRAWL_PAGES = 8;

const app = express();
const port = Number(process.env.PORT || 3000);
const publicAppUrl = (process.env.PUBLIC_APP_URL || `http://0.0.0.0:${port}`).replace(/\/$/, "");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());  
app.use(express.json());
app.use(express.static(path.join(__dirname, "frontend")));
app.get("/widget", (_req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});
app.get("/embed.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "embed.js"));
});
app.get("/embed-lite.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "embed-lite.js"));
});
app.get("/generator", (_req, res) => {
  res.sendFile(path.join(__dirname, "generator.html"));
});
app.get("/manifest.json", (_req, res) => {
  res.sendFile(path.join(__dirname, "manifest.json"));
});
app.get("/service-worker.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "service-worker.js"));
});
app.get("/icon-192.svg", (_req, res) => {
  res.sendFile(path.join(__dirname, "icon-192.svg"));
});
app.get("/icon-512.svg", (_req, res) => {
  res.sendFile(path.join(__dirname, "icon-512.svg"));
});

function getSupabaseClient() {
  const missing = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ].filter((key) => !process.env[key]);

  if (missing.length > 0) {
    const error = new Error(
      `Missing environment variables: ${missing.join(", ")}`
    );
    error.statusCode = 500;
    throw error;
  }

  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("Missing environment variables: OPENAI_API_KEY");
    error.statusCode = 500;
    throw error;
  }

  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function logSupabaseStartupCheck() {
  console.log("PUBLIC_APP_URL:", process.env.PUBLIC_APP_URL || "not set");
  console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
  console.log(
    "SERVICE ROLE:",
    process.env.SUPABASE_SERVICE_ROLE_KEY ? "loaded" : "missing"
  );

  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from(BUSINESSES_TABLE)
      .select("*")
      .limit(1);

    console.log("Supabase startup test data:", data);
    console.log("Supabase startup test error:", error);

    if (error) {
      console.error(error);
    }
  } catch (error) {
    console.error(error);
  }
}

async function ensureBusinessRecord(supabase, options = {}) {
  const { businessId, websiteUrl, name } = options;

  if (businessId) {
    const business = await findBusinessByIdentifier(supabase, businessId);

    if (business?.website_url) {
      return business;
    }

    if (business && !business.website_url) {
      const notFoundError = new Error("Business website_url not found");
      notFoundError.statusCode = 404;
      throw notFoundError;
    }
  }

  if (!websiteUrl) {
    const missingError = new Error(
      "Business not found. Use a valid business UUID, matching business key, or set data-website-url in the embed script."
    );
    missingError.statusCode = 400;
    throw missingError;
  }

  const { data: existingBusiness, error: lookupError } = await supabase
    .from(BUSINESSES_TABLE)
    .select("id, name, website_url")
    .eq("website_url", websiteUrl)
    .maybeSingle();

  if (lookupError) {
    console.error(lookupError);
    throw lookupError;
  }

  if (existingBusiness) {
    return existingBusiness;
  }

  const { data: createdBusiness, error: createError } = await supabase
    .from(BUSINESSES_TABLE)
    .insert({
      name: name || new URL(websiteUrl).hostname,
      website_url: websiteUrl,
    })
    .select("id, name, website_url")
    .single();

  if (createError) {
    console.error(createError);
    throw createError;
  }

  return createdBusiness;
}

function normalizeUrl(rawUrl, baseUrl) {
  if (!rawUrl) return null;

  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function isSameDomain(url, rootUrl) {
  try {
    return new URL(url).hostname === new URL(rootUrl).hostname;
  } catch {
    return false;
  }
}

function normalizePathname(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/";
  }
}

function cleanText(value) {
  return value ? value.replace(/\s+/g, " ").trim() : "";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_PATTERN.test(cleanText(value));
}

function slugifyLookupValue(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "");
}

function getHostnameFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function buildBusinessLookupKeys(business) {
  const keys = new Set();
  const businessId = cleanText(business.id).toLowerCase();
  const businessName = cleanText(business.name);
  const websiteUrl = cleanText(business.website_url);

  if (businessId) {
    keys.add(businessId);
  }

  if (businessName) {
    keys.add(businessName.toLowerCase());
    keys.add(slugifyLookupValue(businessName));
  }

  if (websiteUrl) {
    keys.add(websiteUrl.toLowerCase());
    keys.add(slugifyLookupValue(websiteUrl));

    const hostname = getHostnameFromUrl(websiteUrl);
    if (hostname) {
      keys.add(hostname);
      keys.add(slugifyLookupValue(hostname));
    }
  }

  return keys;
}

async function findBusinessByIdentifier(supabase, businessIdentifier) {
  const lookupValue = cleanText(businessIdentifier);

  if (!lookupValue) {
    return null;
  }

  if (isUuid(lookupValue)) {
    const { data: business, error } = await supabase
      .from(BUSINESSES_TABLE)
      .select("id, name, website_url")
      .eq("id", lookupValue)
      .maybeSingle();

    if (error) {
      console.error(error);
      throw error;
    }

    return business || null;
  }

  const normalizedLookup = slugifyLookupValue(lookupValue);
  const lowercaseLookup = lookupValue.toLowerCase();
  const { data: businesses, error } = await supabase
    .from(BUSINESSES_TABLE)
    .select("id, name, website_url");

  if (error) {
    console.error(error);
    throw error;
  }

  return (
    (businesses || []).find((business) => {
      const keys = buildBusinessLookupKeys(business);
      return keys.has(lowercaseLookup) || keys.has(normalizedLookup);
    }) || null
  );
}

function tokenizeForMatching(value) {
  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "have",
    "your",
    "would",
    "like",
    "need",
    "want",
    "about",
    "into",
    "what",
    "when",
    "where",
    "which",
    "mert",
    "vagy",
    "hogy",
    "ezt",
    "egy",
    "van",
    "lesz",
    "most",
    "nekem",
    "neked",
    "amit",
    "akkor",
    "kell",
    "lenne",
    "szeretnék",
    "szeretnek",
    "szia",
    "hello",
  ]);

  return cleanText(value)
    .toLowerCase()
    .split(/[^a-z0-9áéíóöőúüű]+/i)
    .filter((token) => token.length > 2 && !stopwords.has(token));
}

function sanitizeChatHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter(
      (entry) =>
        entry &&
        (entry.role === "user" || entry.role === "assistant") &&
        typeof entry.content === "string" &&
        cleanText(entry.content)
    )
    .map((entry) => ({
      role: entry.role,
      content: cleanText(entry.content),
    }))
    .slice(-6);
}

function formatConversationHistory(history) {
  if (!history.length) {
    return "No previous conversation.";
  }

  return history
    .map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.content}`)
    .join("\n");
}

function buildEffectiveUserText(message, history) {
  const recentUserMessages = history
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content)
    .slice(-3);

  return [...recentUserMessages, cleanText(message)].join(" ").trim();
}

function detectResponseLanguage(message) {
  const normalized = message.toLowerCase();

  if (
    /[áéíóöőúüű]/i.test(normalized) ||
    /\b(szia|helló|helo|üdv|kell|szeretnék|szeretnek|segits|segíts|weboldal|honlap|webshop|ar|ár|ajanlat|ajánlat|mennyi|mennyibe|kerul|kerül|kerulne|kerülne|reszletesebb|részletesebb|megoldas|megoldás|miben|tudsz|segiteni|segíteni|igazabol|igazából|jobban|hangzik)\b/i.test(normalized)
  ) {
    return "Hungarian";
  }

  return "English";
}

function isGreetingMessage(message) {
  return /^(szia|hello|hi|helló|hey|yo|üdv|jó napot)\W*$/i.test(
    message.trim()
  );
}

function detectMessageTopics(message) {
  const normalized = message.toLowerCase();
  const topics = [];

  if (/(webshop|webáruház|shop|termék)/i.test(normalized)) {
    topics.push("webshop");
  }

  if (/(weboldal|honlap|website|site|landing)/i.test(normalized)) {
    topics.push("website");
  }

  if (/(ár|árak|mennyi|költség|budget|price|cost|quote|ajánlat)/i.test(normalized)) {
    topics.push("pricing");
  }

  if (/(konzult|kapcsolat|contact|book|foglal|egyeztet)/i.test(normalized)) {
    topics.push("consultation");
  }

  if (/(seo|keresőoptimaliz)/i.test(normalized)) {
    topics.push("seo");
  }

  if (/(karbant|support|támogat|maintenance)/i.test(normalized)) {
    topics.push("maintenance");
  }

  return topics;
}

function buildRelevantContextBlock(contentRecord, userMessage) {
  const sections = contentRecord.content
    .split(/\n\n---\n\n/)
    .map((section) => section.trim())
    .filter(Boolean);
  const keywords = tokenizeForMatching(userMessage);

  if (sections.length === 0) {
    return "";
  }

  const rankedSections = sections
    .map((section) => {
      const normalizedSection = section.toLowerCase();
      const score = keywords.reduce((total, keyword) => {
        if (!normalizedSection.includes(keyword)) {
          return total;
        }

        return total + (normalizedSection.includes(`title: ${keyword}`) ? 4 : 2);
      }, 0);

      return {
        section,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);

  const topSections = rankedSections
    .filter((entry) => entry.score > 0)
    .slice(0, 3)
    .map((entry) => entry.section.slice(0, 1800));

  const fallbackSections = sections.slice(0, 2).map((section) => section.slice(0, 1800));
  const selectedSections = topSections.length > 0 ? topSections : fallbackSections;

  return selectedSections.join("\n\n---\n\n").slice(0, 6000);
}

function cleanExtractedContent(rawText) {
  const shortLineSeen = new Set();
  const lines = rawText
    .replace(/\u00a0/g, " ")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);

  const cleanedLines = [];

  for (const line of lines) {
    const normalized = line.toLowerCase();
    const wordCount = normalized.split(/\s+/).length;
    const isLikelyNavigationLine = wordCount <= 8;

    if (isLikelyNavigationLine) {
      if (shortLineSeen.has(normalized)) {
        continue;
      }

      shortLineSeen.add(normalized);
    }

    cleanedLines.push(line);
  }

  return cleanedLines.join("\n\n").slice(0, 15000).trim();
}

function extractInternalLinks(html, pageUrl, rootUrl) {
  const $ = cheerio.load(html);
  const priorityPatterns = [/^\/$/, /^\/services?\/?$/i, /^\/about(-us)?\/?$/i, /^\/contact\/?$/i];
  const seen = new Set();
  const prioritized = [];
  const others = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const normalized = normalizeUrl(href, pageUrl);

    if (!normalized || !isSameDomain(normalized, rootUrl)) {
      return;
    }

    const parsed = new URL(normalized);
    parsed.hash = "";
    parsed.search = "";
    const cleanUrl = parsed.toString();

    if (seen.has(cleanUrl)) {
      return;
    }

    seen.add(cleanUrl);

    const pathname = normalizePathname(cleanUrl);
    if (priorityPatterns.some((pattern) => pattern.test(pathname))) {
      prioritized.push(cleanUrl);
    } else {
      others.push(cleanUrl);
    }
  });

  return [...prioritized, ...others];
}

function extractWebsiteContentFromHtml(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();

  const pageTitle = cleanText($("title").first().text());
  const metaDescription = cleanText(
    $('meta[name="description"]').attr("content") || ""
  );
  const content = cleanExtractedContent($("body").text());

  console.log("CONTENT LENGTH:", content.length);
  console.log(content.slice(0, 500));

  return {
    pageTitle,
    metaDescription,
    content,
  };
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      "User-Agent":
        `Mozilla/5.0 (compatible; AIShopAssistant/1.0; +${publicAppUrl})`,
      Accept: "text/html,application/xhtml+xml",
    },
  });

  return response.data;
}

async function storeWebsiteContent(supabase, contentRecord) {
  const payload = {
    business_id: contentRecord.businessId,
    website_url: contentRecord.websiteUrl,
    page_title: contentRecord.pageTitle,
    meta_description: contentRecord.metaDescription,
    content: contentRecord.content,
    crawled_urls: contentRecord.crawledUrls,
    page_count: contentRecord.pageCount,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from(WEBSITE_CONTENT_TABLE)
    .upsert(payload, { onConflict: "business_id" });

  if (error) {
    console.error(error);

    if (error.code === "PGRST205") {
      const tableError = new Error(
        `Supabase table '${WEBSITE_CONTENT_TABLE}' was not found. Create it before storing crawled website content.`
      );
      tableError.statusCode = 500;
      throw tableError;
    }

    throw error;
  }
}

async function getStoredWebsiteContent(supabase, businessId) {
  const { data: content, error } = await supabase
    .from(WEBSITE_CONTENT_TABLE)
    .select(
      "business_id, website_url, page_title, meta_description, content, crawled_urls, page_count"
    )
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) {
    console.error(error);
    throw error;
  }

  if (!content) {
    return null;
  }

  return {
    businessId: content.business_id,
    websiteUrl: content.website_url,
    pageTitle: content.page_title,
    metaDescription: content.meta_description,
    content: content.content,
    crawledUrls: content.crawled_urls || [],
    pageCount: content.page_count || 0,
  };
}

async function extractBusinessWebsiteContent(supabase, options = {}) {
  const business = await ensureBusinessRecord(supabase, options);
  const queue = [business.website_url];
  const visited = new Set();
  const pageResults = [];

  while (queue.length > 0 && pageResults.length < MAX_CRAWL_PAGES) {
    const currentUrl = queue.shift();

    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);

    try {
      const html = await fetchHtml(currentUrl);
      const pageContent = extractWebsiteContentFromHtml(html);

      if (pageContent.content) {
        pageResults.push({
          url: currentUrl,
          ...pageContent,
        });
      }

      const links = extractInternalLinks(html, currentUrl, business.website_url);
      for (const link of links) {
        if (!visited.has(link) && queue.length + pageResults.length < MAX_CRAWL_PAGES * 3) {
          queue.push(link);
        }
      }
    } catch (error) {
      console.error(`Failed to crawl ${currentUrl}:`, error.message);
    }
  }

  const combinedContent = pageResults
    .map(
      (page) =>
        `URL: ${page.url}\nTitle: ${page.pageTitle || "None"}\nDescription: ${page.metaDescription || "None"}\nContent:\n${page.content}`
    )
    .join("\n\n---\n\n")
    .slice(0, 20000)
    .trim();

  if (!combinedContent || combinedContent.length < 500) {
    const scrapeError = new Error(
      "Failed to extract meaningful website content"
    );
    scrapeError.statusCode = 422;
    throw scrapeError;
  }

  const combinedRecord = {
    businessId: business.id,
    websiteUrl: business.website_url,
    pageTitle: pageResults[0]?.pageTitle || null,
    metaDescription: pageResults[0]?.metaDescription || null,
    content: combinedContent,
    crawledUrls: pageResults.map((page) => page.url),
    pageCount: pageResults.length,
  };

  await storeWebsiteContent(supabase, combinedRecord);

  return combinedRecord;
}

function containsQuestion(text) {
  return text.includes("?");
}

function appearsHungarian(text) {
  return (
    /[áéíóöőúüű]/i.test(text) ||
    /\b(és|hogy|most|neked|inkább|melyik|szeretnél|mennyi|vagy|irányba)\b/i.test(
      text
    )
  );
}

function extractServiceHints(text) {
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

function extractContactDetails(text) {
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

function buildBusinessContextForChat(contentRecord, userMessage) {
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

function buildChatSystemPrompt(language) {
  return `You are a thoughtful personal advisor helping a visitor figure out the best next step with this business.

Your mission:
- understand what the user is actually trying to achieve
- guide them toward the most relevant product, service, or next step
- make the decision process feel easy, personal, and clear

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

Hard rules:
- Do not invent facts, services, prices, or guarantees
- Do not speak as "we" or as the company
- Do not sound like a scripted chatbot or advertisement
- Avoid sounding like you are trying to close the sale too early
- End with one clear next-step question that moves the conversation forward`;
}

function buildConversationGuidance(message, history) {
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

function getReplyRepairIssues(reply, language) {
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

function normalizeAssistantReply(text) {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

async function repairAssistantReply(
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

async function scrapeAllBusinesses(supabase) {
  const { data: businesses, error } = await supabase
    .from(BUSINESSES_TABLE)
    .select("id, website_url")
    .not("website_url", "is", null);

  if (error) {
    console.error(error);
    throw error;
  }

  const results = [];

  for (const business of businesses || []) {
    if (!business.website_url) continue;

    try {
      const result = await extractBusinessWebsiteContent(supabase, {
        businessId: business.id,
      });
      results.push({
        businessId: result.businessId,
        websiteUrl: result.websiteUrl,
        pageTitle: result.pageTitle,
        pageCount: result.pageCount,
        crawledUrls: result.crawledUrls,
        contentLength: result.content.length,
        contentPreview: result.content.slice(0, 500),
      });
    } catch (err) {
      results.push({
        businessId: business.id,
        websiteUrl: business.website_url,
        error: err.message || "Something went wrong",
      });
    }
  }

  return {
    totalBusinesses: results.length,
    results,
  };
}

// ROUTE
app.post("/chat", async (req, res) => {
  try {
    console.log("FULL BODY:", req.body);
    const message = req.body.message;
    const businessId = req.body.business_id || req.body.businessId;
    const websiteUrl = cleanText(req.body.website_url || req.body.websiteUrl || "");
    const history = sanitizeChatHistory(req.body.history);
    const supabase = getSupabaseClient();
    const openai = getOpenAIClient();
    const effectiveUserText = buildEffectiveUserText(message || "", history);
    const conversationHistory = formatConversationHistory(history);
    const language = detectResponseLanguage(effectiveUserText || message || "");
    const conversationGuidance = buildConversationGuidance(message, history);

    console.log("USER MESSAGE:", message);
    console.log("CHAT HISTORY:", history);
    console.log("CONVERSATION GUIDANCE:", conversationGuidance);

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "No message provided" });
    }

    if (!businessId && !websiteUrl) {
      const error = new Error("business_id or website_url is required");
      error.statusCode = 400;
      throw error;
    }

    const business = await ensureBusinessRecord(supabase, {
      businessId,
      websiteUrl,
    });

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

    const systemPrompt = buildChatSystemPrompt(language);

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

    console.log(
      "INITIAL MODEL REPLY:",
      finalReply
    );
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

    res.json({
      reply: finalReply,
      businessId: websiteContent.businessId,
    });

  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Something went wrong",
    });
  }
});

app.get("/businesses/:id/scrape", async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const result = await extractBusinessWebsiteContent(supabase, {
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

app.post("/businesses/scrape", async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const result = await extractBusinessWebsiteContent(supabase, {
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

app.post("/businesses/scrape-all", async (_req, res) => {
  try {
    const supabase = getSupabaseClient();
    const result = await scrapeAllBusinesses(supabase);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Something went wrong",
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// START SERVER
await logSupabaseStartupCheck();

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on ${publicAppUrl}`);
});

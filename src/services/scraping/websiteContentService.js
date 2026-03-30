import axios from "axios";
import * as cheerio from "cheerio";

import {
  BUSINESSES_TABLE,
  MAX_CRAWL_PAGES,
  WEBSITE_CONTENT_TABLE,
} from "../../config/constants.js";
import { getPublicAppUrl } from "../../config/env.js";
import { ensureBusinessRecord } from "../business/businessResolution.js";
import { cleanText, tokenizeForMatching } from "../../utils/text.js";
import {
  isSameDomain,
  normalizePathname,
  normalizeUrl,
} from "../../utils/url.js";

export function buildRelevantContextBlock(contentRecord, userMessage) {
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

        const headingBonus =
          normalizedSection.includes(`title: ${keyword}`) ||
          normalizedSection.includes(`headings:\n${keyword}`) ||
          normalizedSection.includes(`highlights:\n${keyword}`)
            ? 4
            : 0;

        return total + 2 + headingBonus;
      }, 0);

      const structureScore =
        (normalizedSection.includes("headings:") ? 2 : 0) +
        (normalizedSection.includes("highlights:") ? 2 : 0) +
        (normalizedSection.includes("description:") ? 1 : 0);

      return { section, score: score + structureScore };
    })
    .sort((left, right) => right.score - left.score);

  const topSections = rankedSections
    .filter((entry) => entry.score > 0)
    .slice(0, 5)
    .map((entry) => entry.section.slice(0, 2200));

  const fallbackSections = sections
    .slice(0, 3)
    .map((section) => section.slice(0, 2200));
  const selectedSections = topSections.length > 0 ? topSections : fallbackSections;

  return selectedSections.join("\n\n---\n\n").slice(0, 9000);
}

export function cleanExtractedContent(rawText) {
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

export function extractInternalLinks(html, pageUrl, rootUrl) {
  const $ = cheerio.load(html);
  const priorityPatterns = [
    /^\/$/,
    /^\/services?\/?$/i,
    /^\/about(-us)?\/?$/i,
    /^\/contact\/?$/i,
  ];
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

function isUsefulImageUrl(url) {
  const normalized = cleanText(url).toLowerCase();

  if (!normalized || normalized.startsWith("data:")) {
    return false;
  }

  if (/\.(svg|ico)(\?|$)/i.test(normalized)) {
    return false;
  }

  if (/(favicon|sprite|badge)/i.test(normalized)) {
    return false;
  }

  return true;
}

export function extractUsefulImageUrls(html, pageUrl) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const imageUrls = [];
  let discoveredCount = 0;

  $("img").each((_, element) => {
    discoveredCount += 1;
    const src =
      $(element).attr("src") ||
      $(element).attr("data-src") ||
      $(element).attr("data-lazy-src") ||
      $(element).attr("srcset")?.split(",")[0]?.trim()?.split(/\s+/)[0];
    const normalizedUrl = normalizeUrl(src, pageUrl);
    const width = Number.parseInt($(element).attr("width") || "", 10);
    const height = Number.parseInt($(element).attr("height") || "", 10);
    const alt = cleanText($(element).attr("alt") || "");
    const className = cleanText($(element).attr("class") || "");

    if (!normalizedUrl || seen.has(normalizedUrl) || !isUsefulImageUrl(normalizedUrl)) {
      return;
    }

    if ((Number.isFinite(width) && width > 0 && width < 48) || (Number.isFinite(height) && height > 0 && height < 48)) {
      return;
    }

    if (/(favicon|icon)/i.test(`${alt} ${className}`)) {
      return;
    }

    seen.add(normalizedUrl);
    imageUrls.push(normalizedUrl);
  });

  const keptImages = imageUrls.slice(0, 12);
  console.log(`[image-debug] ${pageUrl} found ${discoveredCount} <img> tags, kept ${keptImages.length}`);

  return keptImages;
}

export function extractImageUrlsFromContent(content = "") {
  return [
    ...new Set(
      content
        .split("\n")
        .map((line) => cleanText(line))
        .filter((line) => /^https?:\/\//i.test(line))
    ),
  ];
}

export function hasVisualIntent(message = "") {
  return /(show|image|images|photo|photos|picture|pictures|visual|look|see|gallery|product|products|service|services|portfolio|reference|example|examples|kép|képek|mutasd|mutass|fotó|fotók|vizuális|portfolio)/i.test(
    message
  );
}

export function selectRelevantImageUrls(contentRecord, userMessage) {
  if (!hasVisualIntent(userMessage)) {
    return [];
  }

  const relevantContext = buildRelevantContextBlock(contentRecord, userMessage);
  const relevantImages = extractImageUrlsFromContent(relevantContext);

  if (relevantImages.length > 0) {
    return relevantImages.slice(0, 2);
  }

  return extractImageUrlsFromContent(contentRecord.content).slice(0, 2);
}

export function extractWebsiteContentFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();

  const pageTitle = cleanText($("title").first().text());
  const metaDescription = cleanText(
    $('meta[name="description"]').attr("content") || ""
  );
  const headings = $("h1, h2, h3")
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean)
    .slice(0, 24);
  const highlights = $("li, strong, b")
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean)
    .slice(0, 40);
  const imageUrls = extractUsefulImageUrls(html, pageUrl);
  const bodyContent = cleanExtractedContent($("body").text());
  const structuredContent = [
    imageUrls.length ? `Images:\n${imageUrls.join("\n")}` : "",
    headings.length ? `Headings:\n${headings.join("\n")}` : "",
    highlights.length ? `Highlights:\n${highlights.join("\n")}` : "",
    bodyContent ? `Body:\n${bodyContent}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const content = cleanExtractedContent(structuredContent);

  console.log("CONTENT LENGTH:", content.length);
  console.log(content.slice(0, 500));
  console.log(`[image-debug] ${pageUrl} sample images:`, imageUrls.slice(0, 5));

  return {
    pageTitle,
    metaDescription,
    content,
    imageUrls,
  };
}

function buildFallbackContentRecord(business, pageResults) {
  const primaryPage = pageResults[0] || {};
  const fallbackTitle = primaryPage.pageTitle || business.name || business.website_url;
  const fallbackDescription =
    primaryPage.metaDescription ||
    "Limited content available. This assistant may give general answers.";
  const fallbackContent = [
    `URL: ${business.website_url}`,
    `Title: ${fallbackTitle || "None"}`,
    `Description: ${fallbackDescription || "None"}`,
    primaryPage.imageUrls?.length ? `Images:\n${primaryPage.imageUrls.join("\n")}` : "",
    "Content:",
    "Limited content available. This assistant may give general answers.",
  ].filter(Boolean).join("\n");

  return {
    businessId: business.id,
    websiteUrl: business.website_url,
    pageTitle: fallbackTitle || null,
    metaDescription: fallbackDescription || null,
    content: fallbackContent,
    crawledUrls: pageResults.map((page) => page.url),
    pageCount: pageResults.length,
  };
}

export async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      "User-Agent":
        `Mozilla/5.0 (compatible; AIShopAssistant/1.0; +${getPublicAppUrl()})`,
      Accept: "text/html,application/xhtml+xml",
    },
  });

  return response.data;
}

export async function storeWebsiteContent(supabase, contentRecord) {
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

export async function getStoredWebsiteContent(supabase, businessId) {
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

export async function extractBusinessWebsiteContent(supabase, options = {}) {
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
      const pageContent = extractWebsiteContentFromHtml(html, currentUrl);

      pageResults.push({
        url: currentUrl,
        ...pageContent,
      });

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
        `URL: ${page.url}\nTitle: ${page.pageTitle || "None"}\nDescription: ${page.metaDescription || "None"}\n${page.imageUrls?.length ? `Images:\n${page.imageUrls.join("\n")}\n` : ""}Content:\n${page.content}`
    )
    .join("\n\n---\n\n")
    .slice(0, 20000)
    .trim();

  const combinedRecord =
    combinedContent && combinedContent.length >= 500
      ? {
          businessId: business.id,
          websiteUrl: business.website_url,
          pageTitle: pageResults[0]?.pageTitle || null,
          metaDescription: pageResults[0]?.metaDescription || null,
          content: combinedContent,
          crawledUrls: pageResults.map((page) => page.url),
          pageCount: pageResults.length,
        }
      : buildFallbackContentRecord(business, pageResults);

  console.log("[image-debug] stored image sample:", extractImageUrlsFromContent(combinedRecord.content).slice(0, 5));

  await storeWebsiteContent(supabase, combinedRecord);

  return combinedRecord;
}

export async function scrapeAllBusinesses(supabase) {
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

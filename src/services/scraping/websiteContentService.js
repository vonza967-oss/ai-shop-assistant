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

const MEDIA_BLOCK_START = "[[VONZA_MEDIA_ASSETS]]";
const MEDIA_BLOCK_END = "[[/VONZA_MEDIA_ASSETS]]";

function escapeRegex(value = "") {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

const MEDIA_BLOCK_PATTERN = new RegExp(
  `${escapeRegex(MEDIA_BLOCK_START)}\\n?([\\s\\S]*?)\\n?${escapeRegex(MEDIA_BLOCK_END)}`,
  "i"
);

function normalizeMediaAsset(asset = {}, fallbackPageUrl = "") {
  const rawUrl = cleanText(asset.url);
  const url = /^https?:\/\//i.test(rawUrl)
    ? rawUrl
    : normalizeUrl(rawUrl, fallbackPageUrl);

  if (!url || !isUsefulImageUrl(url)) {
    return null;
  }

  return {
    url,
    pageUrl: cleanText(asset.pageUrl || fallbackPageUrl),
    alt: cleanText(asset.alt),
  };
}

function serializeMediaAssets(assets = []) {
  const normalizedAssets = assets
    .map((asset) => normalizeMediaAsset(asset))
    .filter(Boolean)
    .slice(0, 48);

  if (!normalizedAssets.length) {
    return "";
  }

  return `${MEDIA_BLOCK_START}\n${JSON.stringify(normalizedAssets)}\n${MEDIA_BLOCK_END}`;
}

export function extractStructuredMediaAssets(content = "") {
  const normalizedContent = String(content || "");
  const seen = new Set();
  const structuredAssets = [];

  const startIndex = normalizedContent.indexOf(MEDIA_BLOCK_START);
  const endIndex = normalizedContent.indexOf(MEDIA_BLOCK_END);

  if (startIndex >= 0 && endIndex > startIndex) {
    try {
      const rawBlock = normalizedContent
        .slice(startIndex + MEDIA_BLOCK_START.length, endIndex)
        .trim();
      const parsed = JSON.parse(rawBlock);

      if (Array.isArray(parsed)) {
        parsed.forEach((asset) => {
          const normalized = normalizeMediaAsset(asset);

          if (!normalized || seen.has(normalized.url)) {
            return;
          }

          seen.add(normalized.url);
          structuredAssets.push(normalized);
        });
      }
    } catch {
      // Ignore malformed media blocks and fall back to legacy parsing below.
    }
  }

  const lines = normalizedContent.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    if (cleanText(lines[index]).toLowerCase() !== "images:") {
      continue;
    }

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = cleanText(lines[cursor]);

      if (!line) {
        continue;
      }

      if (!/^https?:\/\//i.test(line)) {
        break;
      }

      if (!/\.(avif|gif|jpe?g|png|webp)(\?|#|$)/i.test(line)) {
        continue;
      }

      const normalized = normalizeMediaAsset({ url: line });

      if (!normalized || seen.has(normalized.url)) {
        continue;
      }

      seen.add(normalized.url);
      structuredAssets.push(normalized);
    }
  }

  return structuredAssets;
}

export function stripStructuredMediaContent(content = "") {
  return String(content || "").replace(MEDIA_BLOCK_PATTERN, "").trim();
}

export function stripLegacyImageSections(content = "") {
  const lines = String(content || "").split("\n");
  const cleanedLines = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalized = cleanText(line).toLowerCase();

    if (normalized !== "images:") {
      cleanedLines.push(line);
      continue;
    }

    index += 1;

    while (index < lines.length) {
      const candidate = cleanText(lines[index]);

      if (!candidate) {
        index += 1;
        continue;
      }

      if (/^https?:\/\//i.test(candidate)) {
        index += 1;
        continue;
      }

      index -= 1;
      break;
    }
  }

  return cleanedLines.join("\n");
}

export function buildPlainWebsiteContent(content = "") {
  const withoutStructuredMedia = stripStructuredMediaContent(content);
  const withoutLegacyImageSections = stripLegacyImageSections(withoutStructuredMedia);

  return cleanExtractedContent(withoutLegacyImageSections);
}

export function buildRelevantContextBlock(contentRecord, userMessage) {
  const sections = buildPlainWebsiteContent(contentRecord.content)
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
  return extractUsefulImageAssets(html, pageUrl).map((asset) => asset.url);
}

export function extractUsefulImageAssets(html, pageUrl) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const imageAssets = [];
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
    imageAssets.push({
      url: normalizedUrl,
      pageUrl,
      alt,
    });
  });

  const keptImages = imageAssets.slice(0, 12);
  console.log(`[image-debug] ${pageUrl} found ${discoveredCount} <img> tags, kept ${keptImages.length}`);

  return keptImages;
}

export function extractImageUrlsFromContent(content = "") {
  return extractStructuredMediaAssets(content).map((asset) => asset.url);
}

function getContentMediaAssets(contentRecord = {}) {
  if (Array.isArray(contentRecord.mediaAssets) && contentRecord.mediaAssets.length > 0) {
    return contentRecord.mediaAssets
      .map((asset) => normalizeMediaAsset(asset))
      .filter(Boolean);
  }

  return extractStructuredMediaAssets(contentRecord.rawContent || contentRecord.content);
}

export function hasVisualIntent(message = "") {
  return /(show me|send me|share|image|images|photo|photos|picture|pictures|gallery|logo|logos|visual|visuals|screenshot|screenshots|asset|assets|source image|source images|kép|képek|mutasd|mutass|fotó|fotók|vizuális|galéria|logo)/i.test(
    message
  );
}

export function selectRelevantImageUrls(contentRecord, userMessage) {
  if (!hasVisualIntent(userMessage)) {
    return [];
  }

  const assets = getContentMediaAssets(contentRecord);
  const keywords = tokenizeForMatching(userMessage);
  const rankedAssets = assets
    .map((asset) => {
      const altText = cleanText(asset.alt).toLowerCase();
      const pageText = cleanText(asset.pageUrl).toLowerCase();
      const score = keywords.reduce((total, keyword) => {
        if (!keyword) {
          return total;
        }

        let nextScore = total;

        if (altText.includes(keyword)) {
          nextScore += 4;
        }

        if (pageText.includes(keyword)) {
          nextScore += 2;
        }

        return nextScore;
      }, 0);

      return {
        asset,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);

  const relevantImages = rankedAssets
    .filter((entry) => entry.score > 0)
    .map((entry) => entry.asset.url);

  if (relevantImages.length > 0) {
    return relevantImages.slice(0, 2);
  }

  return assets.map((asset) => asset.url).slice(0, 2);
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
  const mediaAssets = extractUsefulImageAssets(html, pageUrl);
  const imageUrls = mediaAssets.map((asset) => asset.url);
  const bodyContent = cleanExtractedContent($("body").text());
  const structuredContent = [
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
    mediaAssets,
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
    primaryPage.mediaAssets?.length ? `Media assets available on request: ${primaryPage.mediaAssets.length}` : "",
    "Content:",
    "Limited content available. This assistant may give general answers.",
    serializeMediaAssets(primaryPage.mediaAssets || []),
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
    content: buildPlainWebsiteContent(content.content),
    rawContent: content.content,
    mediaAssets: extractStructuredMediaAssets(content.content),
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
    .map((page) => ({
      ...page,
      content: buildPlainWebsiteContent(page.content),
    }))
    .map(
      (page) =>
        `URL: ${page.url}\nTitle: ${page.pageTitle || "None"}\nDescription: ${page.metaDescription || "None"}\nContent:\n${page.content}`
    )
    .join("\n\n---\n\n")
    .slice(0, 20000)
    .trim();
  const combinedMediaAssets = pageResults.flatMap((page) => page.mediaAssets || []);
  const serializedMediaAssets = serializeMediaAssets(combinedMediaAssets);
  const persistedContent = [combinedContent, serializedMediaAssets].filter(Boolean).join("\n\n");

  const combinedRecord =
    combinedContent && combinedContent.length >= 500
      ? {
          businessId: business.id,
          websiteUrl: business.website_url,
          pageTitle: pageResults[0]?.pageTitle || null,
          metaDescription: pageResults[0]?.metaDescription || null,
          content: persistedContent,
          mediaAssets: combinedMediaAssets,
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

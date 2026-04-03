import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlainWebsiteContent,
  buildRelevantContextBlock,
  extractStructuredMediaAssets,
  hasVisualIntent,
  selectRelevantImageUrls,
} from "../src/services/scraping/websiteContentService.js";
import { buildBusinessContextForChat } from "../src/services/chat/prompting.js";

const MEDIA_BLOCK = `[[VONZA_MEDIA_ASSETS]]
[{"url":"https://example.com/images/hero.jpg","pageUrl":"https://example.com/gallery","alt":"Kitchen remodel hero"},{"url":"https://example.com/images/logo.png","pageUrl":"https://example.com","alt":"Company logo"}]
[[/VONZA_MEDIA_ASSETS]]`;

test("plain website content strips raw image sections and structured media blocks", () => {
  const rawContent = [
    "URL: https://example.com",
    "Title: Acme Services",
    "Images:",
    "https://example.com/uploads/hero.jpg",
    "https://example.com/uploads/gallery.webp",
    "Content:",
    "We remodel kitchens and bathrooms.",
    MEDIA_BLOCK,
  ].join("\n");

  const cleaned = buildPlainWebsiteContent(rawContent);

  assert.doesNotMatch(cleaned, /hero\.jpg/i);
  assert.doesNotMatch(cleaned, /gallery\.webp/i);
  assert.match(cleaned, /We remodel kitchens and bathrooms\./);
});

test("business context stays grounded in text and keeps media URLs out of prompt context", () => {
  const record = {
    content: [
      "Title: Acme Services",
      "Headings:",
      "Kitchen Remodeling",
      "Body:",
      "We design and build custom kitchens.",
      MEDIA_BLOCK,
    ].join("\n"),
  };

  const context = buildBusinessContextForChat(record, "Do you offer kitchen remodeling?");

  assert.match(context, /Kitchen Remodeling/);
  assert.doesNotMatch(context, /https:\/\/example\.com\/images\//i);
  assert.doesNotMatch(buildRelevantContextBlock(record, "show me your kitchen work"), /hero\.jpg/i);
});

test("explicit visual requests can still retrieve structured media assets", () => {
  const record = {
    content: [
      "Title: Acme Services",
      "Body:",
      "We design and build custom kitchens.",
      MEDIA_BLOCK,
    ].join("\n"),
  };

  const assets = extractStructuredMediaAssets(record.content);
  const selected = selectRelevantImageUrls(record, "Can you show me kitchen photos?");

  assert.equal(assets.length, 2);
  assert.deepEqual(selected, ["https://example.com/images/hero.jpg"]);
  assert.equal(hasVisualIntent("What services do you offer?"), false);
  assert.equal(hasVisualIntent("Can you show me photos?"), true);
});

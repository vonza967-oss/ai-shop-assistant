import { OPERATOR_BUSINESS_PROFILE_TABLE } from "../../config/constants.js";
import { cleanText } from "../../utils/text.js";

const BUSINESS_PROFILE_SELECT = [
  "id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "business_summary",
  "services",
  "pricing",
  "policies",
  "service_areas",
  "operating_hours",
  "approved_contact_channels",
  "approval_preferences",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const DEFAULT_APPROVAL_PREFERENCES = Object.freeze({
  followUpDrafts: "owner_required",
  contactNextSteps: "owner_required",
  outcomeRecommendations: "owner_required",
  taskRecommendations: "owner_required",
  profileChanges: "owner_required",
});

const READINESS_SECTIONS = Object.freeze([
  { key: "business_profile", label: "Business profile" },
  { key: "services", label: "Services" },
  { key: "pricing", label: "Pricing" },
  { key: "policies", label: "Policies" },
  { key: "service_areas", label: "Service areas" },
  { key: "operating_hours", label: "Operating hours" },
  { key: "approved_contact_channels", label: "Approved contact channels" },
  { key: "approval_preferences", label: "Approval preferences" },
]);

const LIMITED_CONTENT_MARKER = "Limited content available. This assistant may give general answers.";
const SERVICE_HINT_PATTERN =
  /\b(service|services|repair|install|installation|maintenance|consultation|support|cleaning|inspection|emergency|remodel|design|replacement|treatment|therapy|coaching|training)\b/i;
const PRICING_HINT_PATTERN =
  /(\$[\d,.]+|\bprice\b|\bpricing\b|\bcost\b|\bquote\b|\bestimate\b|\bstarting at\b|\bfrom\b|\bper (hour|visit|month|session)\b)/i;
const POLICY_HINT_PATTERN =
  /\b(policy|policies|cancel|cancellation|refund|deposit|warranty|guarantee|insured|license|licensed|payment|terms|reschedul|notice|minimum)\b/i;
const AREA_HINT_PATTERN =
  /\b(serving|service area|service areas|locations?|county|cities|city|town|neighborhood|region|metro|travel)\b/i;
const HOURS_HINT_PATTERN =
  /\b(mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday|hours|open|closed|24\/7)\b/i;
const TIME_HINT_PATTERN = /\b(\d{1,2}(:\d{2})?\s?(am|pm)|24\/7|noon|midnight)\b/i;

function createEmptyBusinessProfilePrefill() {
  return {
    available: false,
    fieldCount: 0,
    sourceSummary: "",
    reviewRequired: true,
    suggestions: {
      businessSummary: {
        value: "",
        source: "",
      },
      services: [],
      pricing: [],
      policies: [],
      serviceAreas: [],
      operatingHours: [],
      approvedContactChannels: [],
      approvalPreferences: normalizeApprovalPreferences({}),
    },
  };
}

function isMissingRelationError(error, relationName = "") {
  const message = cleanText(error?.message || "").toLowerCase();

  return (
    error?.code === "PGRST205"
    || error?.code === "PGRST204"
    || error?.code === "42P01"
    || error?.code === "42703"
    || message.includes(`'public.${relationName}'`)
    || message.includes(`${relationName} was not found`)
    || (message.includes("column") && message.includes("does not exist"))
  );
}

function normalizeObjectArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function normalizeTextArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => cleanText(entry)).filter(Boolean))]
    : [];
}

function normalizeApprovalPreferences(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};

  return {
    ...DEFAULT_APPROVAL_PREFERENCES,
    ...Object.fromEntries(
      Object.entries(source).map(([key, entry]) => [key, cleanText(entry)])
    ),
  };
}

function uniqueByKey(values = [], getKey = (value) => value) {
  const seen = new Set();
  const result = [];

  values.forEach((value) => {
    const key = cleanText(getKey(value)).toLowerCase();

    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push(value);
  });

  return result;
}

function normalizeTextObject(value, keyNames = []) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    keyNames
      .map((key) => [key, cleanText(source[key])])
      .filter(([, entry]) => entry)
  );
}

function splitWebsiteContentEntries(websiteContent = {}) {
  const lines = String(websiteContent.content || "")
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const entries = [];
  let currentSection = "general";

  if (cleanText(websiteContent.metaDescription)) {
    entries.push({
      section: "description",
      text: cleanText(websiteContent.metaDescription),
      source: "meta_description",
    });
  }

  lines.forEach((line) => {
    if (line === LIMITED_CONTENT_MARKER || /^https?:\/\//i.test(line)) {
      return;
    }

    const labeledMatch = line.match(/^(URL|Title|Description|Headings|Highlights|Body|Content):\s*(.*)$/i);

    if (labeledMatch) {
      currentSection = cleanText(labeledMatch[1]).toLowerCase();
      const inlineValue = cleanText(labeledMatch[2]);

      if (currentSection !== "url" && inlineValue && inlineValue !== LIMITED_CONTENT_MARKER) {
        entries.push({
          section: currentSection,
          text: inlineValue,
          source: "website_import",
        });
      }
      return;
    }

    if (currentSection === "url" || line === LIMITED_CONTENT_MARKER) {
      return;
    }

    entries.push({
      section: currentSection,
      text: line,
      source: "website_import",
    });
  });

  return entries;
}

function looksLikeOperatingHours(text = "") {
  return HOURS_HINT_PATTERN.test(text) && TIME_HINT_PATTERN.test(text);
}

function looksLikePricing(text = "") {
  return PRICING_HINT_PATTERN.test(text);
}

function looksLikePolicy(text = "") {
  return POLICY_HINT_PATTERN.test(text);
}

function looksLikeServiceArea(text = "") {
  return AREA_HINT_PATTERN.test(text);
}

function looksLikeService(entry = {}) {
  const text = cleanText(entry.text);

  if (!text || looksLikePricing(text) || looksLikePolicy(text) || looksLikeServiceArea(text) || looksLikeOperatingHours(text)) {
    return false;
  }

  if (entry.section === "headings" || entry.section === "highlights") {
    return text.length <= 80;
  }

  return SERVICE_HINT_PATTERN.test(text);
}

function pickSuggestedBusinessSummary(entries = []) {
  const summaryCandidate = entries.find((entry) =>
    ["description", "body", "content"].includes(entry.section)
    && cleanText(entry.text).length >= 40
    && cleanText(entry.text) !== LIMITED_CONTENT_MARKER
  );

  if (!summaryCandidate) {
    return {
      value: "",
      source: "",
    };
  }

  return {
    value: cleanText(summaryCandidate.text).slice(0, 320),
    source: cleanText(summaryCandidate.source) || "website_import",
  };
}

function splitStructuredLine(text = "") {
  const parts = cleanText(text)
    .split(/\s+[|:-]\s+/)
    .map((entry) => cleanText(entry))
    .filter(Boolean);

  if (parts.length >= 2) {
    return {
      label: parts[0],
      detail: parts.slice(1).join(" | "),
    };
  }

  return {
    label: cleanText(text),
    detail: "",
  };
}

function extractSuggestedServices(entries = []) {
  return uniqueByKey(
    entries
      .filter((entry) => looksLikeService(entry))
      .slice(0, 8)
      .map((entry) => {
        const parts = splitStructuredLine(entry.text);
        return {
          name: parts.label,
          note: parts.detail,
          source: cleanText(entry.source) || "website_import",
        };
      }),
    (entry) => entry.name
  );
}

function extractSuggestedPricing(entries = []) {
  return uniqueByKey(
    entries
      .filter((entry) => looksLikePricing(entry.text))
      .slice(0, 6)
      .map((entry) => {
        const amountMatch = cleanText(entry.text).match(/(\$[\d,.]+(?:\s*[-–]\s*\$?[\d,.]+)?(?:\s*(?:\/|per)\s*(?:hour|visit|month|session))?)/i);
        const parts = splitStructuredLine(entry.text);
        return {
          label: parts.label || "Pricing note",
          amount: cleanText(amountMatch?.[1]),
          details: parts.detail || cleanText(entry.text),
          source: cleanText(entry.source) || "website_import",
        };
      }),
    (entry) => `${entry.label}|${entry.amount}|${entry.details}`
  );
}

function extractSuggestedPolicies(entries = []) {
  return uniqueByKey(
    entries
      .filter((entry) => looksLikePolicy(entry.text))
      .slice(0, 6)
      .map((entry) => {
        const parts = splitStructuredLine(entry.text);
        return {
          label: parts.label || "Policy",
          details: parts.detail || cleanText(entry.text),
          source: cleanText(entry.source) || "website_import",
        };
      }),
    (entry) => `${entry.label}|${entry.details}`
  );
}

function extractSuggestedServiceAreas(entries = []) {
  return uniqueByKey(
    entries
      .filter((entry) => looksLikeServiceArea(entry.text))
      .slice(0, 6)
      .map((entry) => {
        const parts = splitStructuredLine(entry.text.replace(/^serving\s+/i, ""));
        return {
          name: parts.label || cleanText(entry.text),
          note: parts.detail,
          source: cleanText(entry.source) || "website_import",
        };
      }),
    (entry) => `${entry.name}|${entry.note}`
  );
}

function extractSuggestedOperatingHours(entries = [], agent = {}) {
  const suggestions = entries
    .filter((entry) => looksLikeOperatingHours(entry.text))
    .slice(0, 7)
    .map((entry) => {
      const parts = splitStructuredLine(entry.text);
      return {
        label: parts.label || "Hours",
        hours: parts.detail || cleanText(entry.text),
        source: cleanText(entry.source) || "website_import",
      };
    });

  if (!suggestions.length && cleanText(agent.businessHoursNote)) {
    suggestions.push({
      label: "Availability note",
      hours: cleanText(agent.businessHoursNote),
      source: "assistant_settings",
    });
  }

  return uniqueByKey(suggestions, (entry) => `${entry.label}|${entry.hours}`);
}

export function buildOperatorBusinessProfilePrefill({
  agent = {},
  websiteContent = null,
  profile = {},
} = {}) {
  const entries = splitWebsiteContentEntries(websiteContent || {});
  const suggestions = {
    businessSummary: pickSuggestedBusinessSummary(entries),
    services: extractSuggestedServices(entries),
    pricing: extractSuggestedPricing(entries),
    policies: extractSuggestedPolicies(entries),
    serviceAreas: extractSuggestedServiceAreas(entries),
    operatingHours: extractSuggestedOperatingHours(entries, agent),
    approvedContactChannels: buildDefaultApprovedContactChannels(agent),
    approvalPreferences: normalizeApprovalPreferences(profile.approvalPreferences),
  };

  const fieldCount = [
    suggestions.businessSummary.value ? 1 : 0,
    suggestions.services.length ? 1 : 0,
    suggestions.pricing.length ? 1 : 0,
    suggestions.policies.length ? 1 : 0,
    suggestions.serviceAreas.length ? 1 : 0,
    suggestions.operatingHours.length ? 1 : 0,
    suggestions.approvedContactChannels.length ? 1 : 0,
    Object.keys(suggestions.approvalPreferences).length ? 1 : 0,
  ].reduce((total, count) => total + count, 0);

  if (!fieldCount) {
    return createEmptyBusinessProfilePrefill();
  }

  return {
    available: true,
    fieldCount,
    reviewRequired: true,
    sourceSummary: "Suggestions are based on imported website knowledge plus current assistant contact settings. Nothing is saved until the owner reviews and submits.",
    suggestions,
  };
}

export function attachBusinessProfilePrefill(profile = {}, options = {}) {
  return {
    ...profile,
    prefill: buildOperatorBusinessProfilePrefill({
      agent: options.agent,
      websiteContent: options.websiteContent,
      profile,
    }),
  };
}

function buildDefaultApprovedContactChannels(agent = {}) {
  const channels = ["website_chat"];

  if (cleanText(agent.contactEmail)) {
    channels.push("email");
  }

  if (cleanText(agent.contactPhone)) {
    channels.push("phone");
  }

  return [...new Set(channels)];
}

export function buildBusinessProfileReadiness(profile = {}) {
  const sectionStates = {
    business_profile: Boolean(cleanText(profile.businessSummary)),
    services: (profile.services || []).length > 0,
    pricing: (profile.pricing || []).length > 0,
    policies: (profile.policies || []).length > 0,
    service_areas: (profile.serviceAreas || []).length > 0,
    operating_hours: (profile.operatingHours || []).length > 0,
    approved_contact_channels: (profile.approvedContactChannels || []).length > 0,
    approval_preferences: Object.keys(profile.approvalPreferences || {}).length > 0,
  };

  const completedSections = READINESS_SECTIONS.filter((section) => sectionStates[section.key]).length;
  const missingSections = READINESS_SECTIONS
    .filter((section) => !sectionStates[section.key])
    .map((section) => section.label);

  return {
    totalSections: READINESS_SECTIONS.length,
    completedSections,
    missingCount: missingSections.length,
    missingSections,
    summary: missingSections.length
      ? `${completedSections} of ${READINESS_SECTIONS.length} business context areas are filled. Missing: ${missingSections.join(", ")}.`
      : "All core business context areas are filled for Copilot.",
  };
}

export function createDefaultOperatorBusinessProfile({
  agent = {},
  ownerUserId = "",
  persistenceAvailable = true,
  migrationRequired = false,
} = {}) {
  const profile = {
    id: "",
    agentId: cleanText(agent.id),
    businessId: cleanText(agent.businessId),
    ownerUserId: cleanText(ownerUserId),
    businessSummary: "",
    services: [],
    pricing: [],
    policies: [],
    serviceAreas: [],
    operatingHours: [],
    approvedContactChannels: buildDefaultApprovedContactChannels(agent),
    approvalPreferences: normalizeApprovalPreferences({}),
    metadata: {},
    prefill: createEmptyBusinessProfilePrefill(),
    createdAt: null,
    updatedAt: null,
    persistenceAvailable,
    migrationRequired,
  };

  return {
    ...profile,
    readiness: buildBusinessProfileReadiness(profile),
  };
}

function mapBusinessProfileRow(row = {}, agent = {}) {
  const profile = {
    id: cleanText(row.id),
    agentId: cleanText(row.agent_id),
    businessId: cleanText(row.business_id),
    ownerUserId: cleanText(row.owner_user_id),
    businessSummary: cleanText(row.business_summary),
    services: normalizeObjectArray(row.services),
    pricing: normalizeObjectArray(row.pricing),
    policies: normalizeObjectArray(row.policies),
    serviceAreas: normalizeObjectArray(row.service_areas),
    operatingHours: normalizeObjectArray(row.operating_hours),
    approvedContactChannels: normalizeTextArray(row.approved_contact_channels),
    approvalPreferences: normalizeApprovalPreferences(row.approval_preferences),
    metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata
      : {},
    prefill: createEmptyBusinessProfilePrefill(),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    persistenceAvailable: true,
    migrationRequired: false,
  };

  if (!profile.approvedContactChannels.length) {
    profile.approvedContactChannels = buildDefaultApprovedContactChannels(agent);
  }

  return {
    ...profile,
    readiness: buildBusinessProfileReadiness(profile),
  };
}

function buildUpsertPayload(agent = {}, ownerUserId = "", input = {}) {
  return {
    agent_id: cleanText(agent.id),
    business_id: cleanText(agent.businessId) || null,
    owner_user_id: cleanText(ownerUserId),
    business_summary: cleanText(input.businessSummary) || null,
    services: normalizeObjectArray(input.services),
    pricing: normalizeObjectArray(input.pricing),
    policies: normalizeObjectArray(input.policies),
    service_areas: normalizeObjectArray(input.serviceAreas),
    operating_hours: normalizeObjectArray(input.operatingHours),
    approved_contact_channels: normalizeTextArray(input.approvedContactChannels),
    approval_preferences: normalizeApprovalPreferences(input.approvalPreferences),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : {},
    updated_at: new Date().toISOString(),
  };
}

export async function getOperatorBusinessProfile(supabase, { agent, ownerUserId } = {}) {
  const agentId = cleanText(agent?.id);
  const normalizedOwnerUserId = cleanText(ownerUserId);

  if (!agentId || !normalizedOwnerUserId) {
    return createDefaultOperatorBusinessProfile({
      agent,
      ownerUserId: normalizedOwnerUserId,
    });
  }

  const { data, error } = await supabase
    .from(OPERATOR_BUSINESS_PROFILE_TABLE)
    .select(BUSINESS_PROFILE_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", normalizedOwnerUserId)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error, OPERATOR_BUSINESS_PROFILE_TABLE)) {
      return createDefaultOperatorBusinessProfile({
        agent,
        ownerUserId: normalizedOwnerUserId,
        persistenceAvailable: false,
        migrationRequired: true,
      });
    }

    throw error;
  }

  if (!data?.id) {
    return createDefaultOperatorBusinessProfile({
      agent,
      ownerUserId: normalizedOwnerUserId,
    });
  }

  return mapBusinessProfileRow(data, agent);
}

export async function upsertOperatorBusinessProfile(supabase, { agent, ownerUserId, profile = {} } = {}) {
  const agentId = cleanText(agent?.id);
  const normalizedOwnerUserId = cleanText(ownerUserId);

  if (!agentId || !normalizedOwnerUserId) {
    const error = new Error("agent and owner_user_id are required");
    error.statusCode = 400;
    throw error;
  }

  const payload = buildUpsertPayload(agent, normalizedOwnerUserId, profile);
  const { data, error } = await supabase
    .from(OPERATOR_BUSINESS_PROFILE_TABLE)
    .upsert(payload, { onConflict: "agent_id,owner_user_id" })
    .select(BUSINESS_PROFILE_SELECT)
    .single();

  if (error) {
    if (isMissingRelationError(error, OPERATOR_BUSINESS_PROFILE_TABLE)) {
      const migrationError = new Error(
        "Operator business profile persistence is not ready on this deployment. Run the production deploy workflow so Supabase applies the latest migrations, including operator business profiles."
      );
      migrationError.statusCode = 503;
      throw migrationError;
    }

    throw error;
  }

  return mapBusinessProfileRow(data, agent);
}

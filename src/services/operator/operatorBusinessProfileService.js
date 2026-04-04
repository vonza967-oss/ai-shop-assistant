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

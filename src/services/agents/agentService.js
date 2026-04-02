import { cleanText, slugifyLookupValue } from "../../utils/text.js";
import { getHostnameFromUrl, normalizeWebsiteUrl } from "../../utils/url.js";
import { ensureBusinessRecord, findBusinessByIdentifier } from "../business/businessResolution.js";
import { getAgentMessageStats } from "../chat/messageService.js";
import { listWidgetEventSummaryByAgentIds } from "../analytics/widgetTelemetryService.js";
import {
  deriveAllowedDomains,
  getWidgetInstallContextByInstallId,
  isOriginAllowed,
  listInstallStatusByAgentIds,
  logWidgetInitFailure,
} from "../install/installPresenceService.js";
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_LANGUAGE,
  DEFAULT_PURPOSE,
  DEFAULT_TONE,
  DEFAULT_WIDGET_CONFIG,
} from "./agentDefaults.js";

const AGENTS_TABLE = "agents";
const WIDGET_CONFIGS_TABLE = "widget_configs";
const WEBSITE_CONTENT_TABLE = "website_content";
const LIMITED_CONTENT_MARKER = "Limited content available. This assistant may give general answers.";
const DEFAULT_ACCESS_STATUS = "pending";

function normalizeAccessStatus(value) {
  const normalized = cleanText(value).toLowerCase();
  return ["pending", "active", "suspended"].includes(normalized)
    ? normalized
    : DEFAULT_ACCESS_STATUS;
}

function isMissingRelationError(error, relationName) {
  const message = cleanText(error?.message || "");
  return (
    error?.code === "PGRST205" ||
    error?.code === "42P01" ||
    message.toLowerCase().includes(`'public.${relationName}'`) ||
    message.toLowerCase().includes(`${relationName} was not found`)
  );
}

function normalizeAgentKey(value) {
  return slugifyLookupValue(value).replace(/_+/g, "");
}

function buildInvalidWebsiteUrlError() {
  const error = new Error("Enter a valid public https URL, like https://example.com.");
  error.statusCode = 400;
  return error;
}

function buildAgentSettingsError(message, statusCode = 500, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) {
    error.code = code;
  }
  return error;
}

async function findBusinessByWebsiteUrl(supabase, websiteUrl) {
  const business = await findBusinessByIdentifier(supabase, websiteUrl);
  return business?.website_url ? business : null;
}

async function updateBusinessWebsiteUrl(supabase, businessId, websiteUrl) {
  const { error } = await supabase
    .from("businesses")
    .update({
      website_url: websiteUrl,
    })
    .eq("id", businessId);

  if (error) {
    console.error("[agentService] Failed to update business website URL:", {
      businessId,
      websiteUrl,
      code: error.code,
      message: error.message,
    });
    throw error;
  }
}

async function reassignAgentBusiness(supabase, agentId, businessId) {
  const { error } = await supabase
    .from(AGENTS_TABLE)
    .update({
      business_id: businessId,
    })
    .eq("id", agentId);

  if (error) {
    console.error("[agentService] Failed to reassign agent business:", {
      agentId,
      businessId,
      code: error.code,
      message: error.message,
    });
    throw error;
  }
}

function buildDefaultAgentKey(business) {
  const name = cleanText(business.name);
  const hostname = getHostnameFromUrl(business.website_url || "");
  const rawValue = name || hostname || cleanText(business.id);
  return normalizeAgentKey(rawValue) || cleanText(business.id).toLowerCase();
}

function mapAgentRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    businessId: row.business_id,
    clientId: row.client_id || "",
    ownerUserId: row.owner_user_id || "",
    accessStatus: normalizeAccessStatus(row.access_status),
    publicAgentKey: row.public_agent_key,
    name: row.name || DEFAULT_AGENT_NAME,
    purpose: row.purpose || DEFAULT_PURPOSE,
    systemPrompt: row.system_prompt || "",
    tone: row.tone || DEFAULT_TONE,
    language: row.language || DEFAULT_LANGUAGE,
    isActive: row.is_active !== false,
  };
}

function mapWidgetConfigRow(row) {
  return {
    ...DEFAULT_WIDGET_CONFIG,
    ...(row
      ? {
          assistantName: row.assistant_name || DEFAULT_WIDGET_CONFIG.assistantName,
          welcomeMessage: row.welcome_message || DEFAULT_WIDGET_CONFIG.welcomeMessage,
          buttonLabel: row.button_label || DEFAULT_WIDGET_CONFIG.buttonLabel,
          primaryColor: row.primary_color || DEFAULT_WIDGET_CONFIG.primaryColor,
          secondaryColor: row.secondary_color || DEFAULT_WIDGET_CONFIG.secondaryColor,
          launcherText: row.launcher_text || DEFAULT_WIDGET_CONFIG.launcherText,
          themeMode: row.theme_mode || DEFAULT_WIDGET_CONFIG.themeMode,
          installId: row.install_id || "",
          allowedDomains: deriveAllowedDomains(row.allowed_domains, ""),
          lastVerificationStatus: row.last_verification_status || null,
          lastVerifiedAt: row.last_verified_at || null,
          lastVerificationOrigin: row.last_verification_origin || null,
          lastVerificationTargetUrl: row.last_verification_target_url || null,
          lastVerificationDetails:
            row.last_verification_details && typeof row.last_verification_details === "object"
              ? row.last_verification_details
              : {},
        }
      : {}),
  };
}

function buildKnowledgeSummary(row) {
  const content = cleanText(row?.content || "");
  const contentLength = content.length;
  const pageCount = Number(row?.page_count || 0);
  const hasWebsiteContent = Boolean(contentLength);
  const hasLimitedMarker = content.includes(LIMITED_CONTENT_MARKER);

  let state = "missing";
  let description = "Website knowledge has not been imported yet.";

  if (hasWebsiteContent) {
    if (hasLimitedMarker || contentLength < 400) {
      state = "limited";
      description = "Website knowledge exists, but it is still limited and may need another import pass.";
    } else {
      state = "ready";
      description = "Website knowledge is imported and ready to support customer questions.";
    }
  }

  return {
    state,
    description,
    hasWebsiteContent,
    contentLength,
    pageCount,
    updatedAt: row?.updated_at || null,
  };
}

function buildDefaultInstallStatus(widgetConfig = null, websiteUrl = "") {
  return {
    state: "not_installed",
    label: "Not installed yet",
    host: "",
    pageUrl: null,
    lastSeenAt: null,
    lastSeenUrl: null,
    lastVerifiedAt: widgetConfig?.lastVerifiedAt || null,
    verificationStatus: widgetConfig?.lastVerificationStatus || null,
    verificationTargetUrl: widgetConfig?.lastVerificationTargetUrl || websiteUrl || null,
    verificationOrigin: widgetConfig?.lastVerificationOrigin || null,
    verificationDetails: widgetConfig?.lastVerificationDetails || {},
    installId: widgetConfig?.installId || "",
    allowedDomains: deriveAllowedDomains(widgetConfig?.allowedDomains, websiteUrl),
    expectedDomain: getHostnameFromUrl(websiteUrl || ""),
    installedAt: null,
  };
}

export async function getWidgetConfigForAgent(supabase, agentId) {
  const { data, error } = await supabase
    .from(WIDGET_CONFIGS_TABLE)
    .select(
      "id, agent_id, assistant_name, welcome_message, button_label, primary_color, secondary_color, launcher_text, theme_mode, install_id, allowed_domains, last_verification_status, last_verified_at, last_verification_origin, last_verification_target_url, last_verification_details"
    )
    .eq("agent_id", agentId)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error, WIDGET_CONFIGS_TABLE)) {
      return mapWidgetConfigRow(null);
    }
    console.error(error);
    throw error;
  }

  return mapWidgetConfigRow(data || null);
}

export async function ensureWidgetConfigForAgent(supabase, agentId) {
  const existingConfig = await getWidgetConfigForAgent(supabase, agentId);

  const { data, error } = await supabase
    .from(WIDGET_CONFIGS_TABLE)
    .upsert(
      {
        agent_id: agentId,
        assistant_name: existingConfig.assistantName,
        welcome_message: existingConfig.welcomeMessage,
        button_label: existingConfig.buttonLabel,
        primary_color: existingConfig.primaryColor,
        secondary_color: existingConfig.secondaryColor,
        launcher_text: existingConfig.launcherText,
        theme_mode: existingConfig.themeMode,
        allowed_domains: existingConfig.allowedDomains || [],
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" }
    )
    .select(
      "id, agent_id, assistant_name, welcome_message, button_label, primary_color, secondary_color, launcher_text, theme_mode, install_id, allowed_domains, last_verification_status, last_verified_at, last_verification_origin, last_verification_target_url, last_verification_details"
    )
    .single();

  if (error) {
    if (isMissingRelationError(error, WIDGET_CONFIGS_TABLE)) {
      return existingConfig;
    }

    console.error(error);
    throw error;
  }

  return mapWidgetConfigRow(data || null);
}

async function findAgentById(supabase, agentId) {
  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .select(
      "id, business_id, client_id, owner_user_id, access_status, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
    )
    .eq("id", agentId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error, AGENTS_TABLE)) {
      return null;
    }
    console.error(error);
    throw error;
  }

  return mapAgentRow(data || null);
}

async function findAgentByKey(supabase, agentKey) {
  const lookupKey = cleanText(agentKey);

  if (!lookupKey) {
    return null;
  }

  const normalizedLookup = normalizeAgentKey(lookupKey);
  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .select(
      "id, business_id, client_id, owner_user_id, access_status, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
    )
    .eq("is_active", true);

  if (error) {
    if (isMissingRelationError(error, AGENTS_TABLE)) {
      return null;
    }
    console.error(error);
    throw error;
  }

  const match = (data || []).find((agent) => {
    const agentKeyValue = cleanText(agent.public_agent_key);
    return (
      agentKeyValue.toLowerCase() === lookupKey.toLowerCase() ||
      normalizeAgentKey(agentKeyValue) === normalizedLookup
    );
  });

  return mapAgentRow(match || null);
}

async function findDefaultAgentForBusiness(supabase, businessId, options = {}) {
  const clientId = cleanText(options.clientId);
  const ownerUserId = cleanText(options.ownerUserId);
  let query = supabase
    .from(AGENTS_TABLE)
    .select(
      "id, business_id, client_id, owner_user_id, access_status, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
    )
    .eq("business_id", businessId)
    .eq("is_active", true);

  if (ownerUserId) {
    query = query.eq("owner_user_id", ownerUserId);
  } else if (clientId) {
    query = query.eq("client_id", clientId);
  }

  const { data, error } = await query.limit(1);

  if (error) {
    if (isMissingRelationError(error, AGENTS_TABLE)) {
      return null;
    }
    console.error(error);
    throw error;
  }

  return mapAgentRow(data?.[0] || null);
}

async function claimAgentOwnershipById(supabase, agentId, ownerUserId) {
  const normalizedOwnerUserId = cleanText(ownerUserId);

  if (!agentId || !normalizedOwnerUserId) {
    return null;
  }

  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .update({
      owner_user_id: normalizedOwnerUserId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agentId)
    .select(
      "id, business_id, client_id, owner_user_id, access_status, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
    )
    .single();

  if (error) {
    console.error(error);
    throw error;
  }

  return mapAgentRow(data || null);
}

export async function ensureAgentForBusiness(supabase, business, options = {}) {
  const clientId = cleanText(options.clientId);
  const ownerUserId = cleanText(options.ownerUserId);
  const existingAgent = await findDefaultAgentForBusiness(supabase, business.id, {
    clientId,
    ownerUserId,
  });

  if (existingAgent) {
    return existingAgent;
  }

  if (ownerUserId && clientId) {
    const bridgeAgent = await findDefaultAgentForBusiness(supabase, business.id, { clientId });

    if (bridgeAgent && (!bridgeAgent.ownerUserId || bridgeAgent.ownerUserId === ownerUserId)) {
      return claimAgentOwnershipById(supabase, bridgeAgent.id, ownerUserId);
    }
  }

  const defaultKey = buildDefaultAgentKey(business);
  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .insert({
      business_id: business.id,
      client_id: clientId || null,
      owner_user_id: ownerUserId || null,
      access_status: DEFAULT_ACCESS_STATUS,
      public_agent_key: defaultKey,
      name: cleanText(business.name) || DEFAULT_AGENT_NAME,
      purpose: DEFAULT_PURPOSE,
      tone: DEFAULT_TONE,
      language: DEFAULT_LANGUAGE,
      is_active: true,
    })
    .select(
      "id, business_id, client_id, owner_user_id, access_status, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
    )
    .single();

  if (error) {
    if (isMissingRelationError(error, AGENTS_TABLE)) {
      return {
        id: `fallback-${business.id}`,
        businessId: business.id,
        clientId: clientId || "",
        ownerUserId: ownerUserId || "",
        accessStatus: DEFAULT_ACCESS_STATUS,
        publicAgentKey: buildDefaultAgentKey(business),
        name: cleanText(business.name) || DEFAULT_AGENT_NAME,
        purpose: DEFAULT_PURPOSE,
        systemPrompt: "",
        tone: DEFAULT_TONE,
        language: DEFAULT_LANGUAGE,
        isActive: true,
      };
    }
    console.error(error);
    throw error;
  }

  return mapAgentRow(data);
}

export async function resolveAgentContext(supabase, options = {}) {
  const {
    agentId,
    agentKey,
    businessId,
    websiteUrl,
    businessName,
  } = options;

  let agent = null;

  try {
    if (agentId) {
      agent = await findAgentById(supabase, agentId);
    }

    if (!agent && agentKey) {
      agent = await findAgentByKey(supabase, agentKey);
    }

    if (agent) {
      const business =
        (await findBusinessByIdentifier(supabase, agent.businessId)) ||
        (await ensureBusinessRecord(supabase, {
          businessId: agent.businessId,
          websiteUrl,
          name: businessName,
        }));
      const widgetConfig = await getWidgetConfigForAgent(supabase, agent.id);

      return {
        agent,
        business,
        widgetConfig,
      };
    }

    const business = await ensureBusinessRecord(supabase, {
      businessId,
      websiteUrl,
      name: businessName,
    });
    const ensuredAgent = await ensureAgentForBusiness(supabase, business);
    const widgetConfig = await getWidgetConfigForAgent(supabase, ensuredAgent.id);

    return {
      agent: ensuredAgent,
      business,
      widgetConfig,
    };
  } catch (error) {
    if (
      isMissingRelationError(error, AGENTS_TABLE) ||
      isMissingRelationError(error, WIDGET_CONFIGS_TABLE)
    ) {
      const business = await ensureBusinessRecord(supabase, {
        businessId,
        websiteUrl,
        name: businessName,
      });
      const fallbackAgent = {
        id: `fallback-${business.id}`,
        businessId: business.id,
        clientId: "",
        ownerUserId: "",
        accessStatus: DEFAULT_ACCESS_STATUS,
        publicAgentKey: buildDefaultAgentKey(business),
        name: cleanText(business.name) || DEFAULT_AGENT_NAME,
        purpose: DEFAULT_PURPOSE,
        systemPrompt: "",
        tone: DEFAULT_TONE,
        language: DEFAULT_LANGUAGE,
        isActive: true,
      };

      return {
        agent: fallbackAgent,
        business,
        widgetConfig: mapWidgetConfigRow(null),
      };
    }

    throw error;
  }
}

export async function getWidgetBootstrap(supabase, options = {}) {
  const installId = cleanText(options.installId);
  const requestedOrigin = cleanText(options.origin);
  const pageUrl = cleanText(options.pageUrl);
  let context = null;

  if (installId) {
    const installContext = await getWidgetInstallContextByInstallId(supabase, installId);

    if (!installContext?.agent || !installContext.business) {
      const error = new Error("Install not found");
      error.statusCode = 404;
      throw error;
    }

    if (requestedOrigin && !isOriginAllowed(requestedOrigin, installContext.allowedDomains)) {
      logWidgetInitFailure({
        reason: "domain_blocked",
        installId,
        origin: requestedOrigin,
        pageUrl,
        allowedDomains: installContext.allowedDomains,
        message: "Origin is not on the install allowlist.",
      });
      const error = new Error("This website origin is not allowed for the current install.");
      error.statusCode = 403;
      error.code = "domain_blocked";
      throw error;
    }

    context = {
      agent: {
        id: installContext.agent.id,
        publicAgentKey: installContext.agent.public_agent_key || "",
        name: installContext.agent.name || DEFAULT_AGENT_NAME,
      },
      business: installContext.business,
      widgetConfig: mapWidgetConfigRow(installContext.widgetConfigRow),
      allowedDomains: installContext.allowedDomains,
    };
  } else {
    context = await resolveAgentContext(supabase, options);
  }

  return {
    agent: context.agent,
    business: {
      id: context.business.id,
      name: context.business.name,
      websiteUrl: context.business.website_url,
    },
    widgetConfig: {
      ...context.widgetConfig,
      assistantName: context.widgetConfig.assistantName || context.agent.name || DEFAULT_WIDGET_CONFIG.assistantName,
    },
    install: {
      installId: context.widgetConfig.installId || installId || "",
      allowedDomains: context.allowedDomains || context.widgetConfig.allowedDomains || [],
    },
  };
}

export async function createAgentForBusinessName(supabase, businessName, websiteUrl, clientId, ownerUserId) {
  const normalizedBusinessName = cleanText(businessName);
  const providedWebsiteUrl = cleanText(websiteUrl);
  const normalizedWebsiteUrl = providedWebsiteUrl
    ? normalizeWebsiteUrl(providedWebsiteUrl, {
        requireHttps: true,
        requirePublicHostname: true,
      })
    : "";
  const normalizedClientId = cleanText(clientId);
  const normalizedOwnerUserId = cleanText(ownerUserId);

  if (!normalizedBusinessName) {
    const error = new Error("business_name is required");
    error.statusCode = 400;
    throw error;
  }

  if (!normalizedClientId && !normalizedOwnerUserId) {
    const error = new Error("client_id or authenticated owner is required");
    error.statusCode = 400;
    throw error;
  }

  if (providedWebsiteUrl && !normalizedWebsiteUrl) {
    throw buildInvalidWebsiteUrlError();
  }

  let business = await findBusinessByIdentifier(supabase, normalizedBusinessName);

  if (!business) {
    const syntheticWebsiteUrl =
      normalizedWebsiteUrl || `https://${slugifyLookupValue(normalizedBusinessName) || "business"}.local`;
    business = await ensureBusinessRecord(supabase, {
      websiteUrl: syntheticWebsiteUrl,
      name: normalizedBusinessName,
    });
  } else if (normalizedWebsiteUrl && business.website_url !== normalizedWebsiteUrl) {
    const { data: updatedBusiness, error: updateBusinessError } = await supabase
      .from("businesses")
      .update({
        website_url: normalizedWebsiteUrl,
      })
      .eq("id", business.id)
      .select("id, name, website_url")
      .single();

    if (updateBusinessError) {
      console.error(updateBusinessError);
      throw updateBusinessError;
    }

    business = updatedBusiness;
  }

  const agent = await ensureAgentForBusiness(supabase, business, {
    clientId: normalizedClientId,
    ownerUserId: normalizedOwnerUserId,
  });
  const widgetConfig = await ensureWidgetConfigForAgent(supabase, agent.id);

  return {
    business,
    agent,
    widgetConfig: {
      ...widgetConfig,
      assistantName: widgetConfig.assistantName || agent.name || DEFAULT_WIDGET_CONFIG.assistantName,
    },
  };
}

export async function listAgents(supabase, options = {}) {
  const normalizedClientId = cleanText(options.clientId);
  const normalizedOwnerUserId = cleanText(options.ownerUserId);
  const includeBridgeAgent = options.includeBridgeAgent === true;

  if (!normalizedClientId && !normalizedOwnerUserId) {
    const error = new Error("client_id or authenticated owner is required");
    error.statusCode = 400;
    throw error;
  }

  let query = supabase
    .from(AGENTS_TABLE)
    .select("id, business_id, client_id, owner_user_id, access_status, public_agent_key, name, tone, system_prompt, is_active")
    .order("name", { ascending: true });

  if (normalizedOwnerUserId) {
    query = query.eq("owner_user_id", normalizedOwnerUserId);
  } else {
    query = query.eq("client_id", normalizedClientId);
  }

  const { data, error } = await query;

  if (error) {
    if (isMissingRelationError(error, AGENTS_TABLE)) {
      return { agents: [], bridgeAgent: null };
    }

    console.error(error);
    throw error;
  }

  const agentRows = data || [];
  const agentIds = agentRows.map((row) => row.id);
  const businessIds = [...new Set(agentRows.map((row) => row.business_id).filter(Boolean))];
  let widgetConfigsByAgentId = new Map();
  let businessesById = new Map();
  let websiteContentByBusinessId = new Map();
  let messageStatsByAgentId = new Map();
  let installStatusByAgentId = new Map();
  let widgetMetricsByAgentId = new Map();

  if (agentIds.length) {
    const { data: widgetRows, error: widgetError } = await supabase
      .from(WIDGET_CONFIGS_TABLE)
      .select("agent_id, assistant_name, welcome_message, button_label, primary_color, secondary_color, install_id, allowed_domains, last_verification_status, last_verified_at, last_verification_origin, last_verification_target_url, last_verification_details")
      .in("agent_id", agentIds);

    if (widgetError) {
      if (!isMissingRelationError(widgetError, WIDGET_CONFIGS_TABLE)) {
        console.error(widgetError);
        throw widgetError;
      }
    } else {
      widgetConfigsByAgentId = new Map(
        (widgetRows || []).map((row) => [
          row.agent_id,
          mapWidgetConfigRow(row),
        ])
      );
    }
  }

  if (businessIds.length) {
    const { data: businessRows, error: businessError } = await supabase
      .from("businesses")
      .select("id, website_url")
      .in("id", businessIds);

    if (businessError) {
      console.error(businessError);
      throw businessError;
    }

    businessesById = new Map((businessRows || []).map((row) => [row.id, row]));
  }

  if (businessIds.length) {
    const { data: websiteContentRows, error: websiteContentError } = await supabase
      .from(WEBSITE_CONTENT_TABLE)
      .select("business_id, content, page_count, updated_at")
      .in("business_id", businessIds);

    if (websiteContentError) {
      if (!isMissingRelationError(websiteContentError, WEBSITE_CONTENT_TABLE)) {
        console.error(websiteContentError);
        throw websiteContentError;
      }
    } else {
      websiteContentByBusinessId = new Map(
        (websiteContentRows || []).map((row) => [row.business_id, buildKnowledgeSummary(row)])
      );
    }
  }

  if (agentIds.length) {
    messageStatsByAgentId = await getAgentMessageStats(supabase, agentIds);
    installStatusByAgentId = await listInstallStatusByAgentIds(supabase, agentIds);
    widgetMetricsByAgentId = await listWidgetEventSummaryByAgentIds(supabase, agentIds, {
      sinceByAgentId: new Map(
        agentIds.map((agentId) => [agentId, installStatusByAgentId.get(agentId)?.installedAt || null])
      ),
    });
  }

  const agents = agentRows.map((row) => {
    const widgetConfig = widgetConfigsByAgentId.get(row.id);
    const knowledge = websiteContentByBusinessId.get(row.business_id) || buildKnowledgeSummary(null);
    const messageStats = messageStatsByAgentId.get(row.id) || {};
    const websiteUrl = businessesById.get(row.business_id)?.website_url || "";

    return {
      id: row.id,
      businessId: row.business_id,
      clientId: row.client_id || "",
      ownerUserId: row.owner_user_id || "",
      accessStatus: normalizeAccessStatus(row.access_status),
      name: row.name || DEFAULT_AGENT_NAME,
      assistantName:
        widgetConfig?.assistantName || row.name || DEFAULT_WIDGET_CONFIG.assistantName,
      publicAgentKey: row.public_agent_key || "",
      installId: widgetConfig?.installId || "",
      allowedDomains: deriveAllowedDomains(widgetConfig?.allowedDomains, websiteUrl),
      isActive: row.is_active !== false,
      tone: row.tone || DEFAULT_TONE,
      systemPrompt: row.system_prompt || "",
      websiteUrl,
      welcomeMessage:
        widgetConfig?.welcomeMessage || DEFAULT_WIDGET_CONFIG.welcomeMessage,
      buttonLabel:
        widgetConfig?.buttonLabel || DEFAULT_WIDGET_CONFIG.buttonLabel,
      primaryColor:
        widgetConfig?.primaryColor || DEFAULT_WIDGET_CONFIG.primaryColor,
      secondaryColor:
        widgetConfig?.secondaryColor || DEFAULT_WIDGET_CONFIG.secondaryColor,
      hasWidgetConfig: Boolean(widgetConfig),
      knowledge,
      installStatus: installStatusByAgentId.get(row.id) || buildDefaultInstallStatus(widgetConfig, websiteUrl),
      widgetMetrics: widgetMetricsByAgentId.get(row.id) || null,
      messageCount: messageStats.messageCount || 0,
      lastMessageAt: messageStats.lastMessageAt || null,
    };
  });

  let bridgeAgent = null;

  if (includeBridgeAgent && normalizedOwnerUserId && normalizedClientId && !agents.length) {
    bridgeAgent = await findClaimableAgentByClientId(supabase, {
      clientId: normalizedClientId,
      ownerUserId: normalizedOwnerUserId,
    });
  }

  return {
    agents,
    bridgeAgent,
  };
}

export async function listAllAgents(supabase) {
  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .select("id, business_id, client_id, owner_user_id, access_status, public_agent_key, name, tone, system_prompt, is_active")
    .order("name", { ascending: true });

  if (error) {
    if (isMissingRelationError(error, AGENTS_TABLE)) {
      return [];
    }

    console.error(error);
    throw error;
  }

  const agentRows = data || [];
  const agentIds = agentRows.map((row) => row.id);
  const businessIds = [...new Set(agentRows.map((row) => row.business_id).filter(Boolean))];
  let widgetConfigsByAgentId = new Map();
  let businessesById = new Map();
  let messageStatsByAgentId = new Map();
  let installStatusByAgentId = new Map();
  let widgetMetricsByAgentId = new Map();

  if (agentIds.length) {
    const { data: widgetRows, error: widgetError } = await supabase
      .from(WIDGET_CONFIGS_TABLE)
      .select("agent_id, assistant_name, welcome_message, button_label, primary_color, secondary_color, install_id, allowed_domains, last_verification_status, last_verified_at, last_verification_origin, last_verification_target_url, last_verification_details")
      .in("agent_id", agentIds);

    if (widgetError) {
      if (!isMissingRelationError(widgetError, WIDGET_CONFIGS_TABLE)) {
        console.error(widgetError);
        throw widgetError;
      }
    } else {
      widgetConfigsByAgentId = new Map(
        (widgetRows || []).map((row) => [row.agent_id, mapWidgetConfigRow(row)])
      );
    }
  }

  if (businessIds.length) {
    const { data: businessRows, error: businessError } = await supabase
      .from("businesses")
      .select("id, website_url")
      .in("id", businessIds);

    if (businessError) {
      console.error(businessError);
      throw businessError;
    }

    businessesById = new Map((businessRows || []).map((row) => [row.id, row]));
  }

  if (agentIds.length) {
    messageStatsByAgentId = await getAgentMessageStats(supabase, agentIds);
    installStatusByAgentId = await listInstallStatusByAgentIds(supabase, agentIds);
    widgetMetricsByAgentId = await listWidgetEventSummaryByAgentIds(supabase, agentIds, {
      sinceByAgentId: new Map(
        agentIds.map((agentId) => [agentId, installStatusByAgentId.get(agentId)?.installedAt || null])
      ),
    });
  }

  return agentRows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    clientId: row.client_id || "",
    ownerUserId: row.owner_user_id || "",
    accessStatus: normalizeAccessStatus(row.access_status),
    name: row.name || DEFAULT_AGENT_NAME,
    assistantName:
      widgetConfigsByAgentId.get(row.id)?.assistantName || row.name || DEFAULT_WIDGET_CONFIG.assistantName,
    publicAgentKey: row.public_agent_key || "",
    installId: widgetConfigsByAgentId.get(row.id)?.installId || "",
    allowedDomains: deriveAllowedDomains(
      widgetConfigsByAgentId.get(row.id)?.allowedDomains,
      businessesById.get(row.business_id)?.website_url || ""
    ),
    isActive: row.is_active !== false,
    tone: row.tone || DEFAULT_TONE,
    systemPrompt: row.system_prompt || "",
    websiteUrl: businessesById.get(row.business_id)?.website_url || "",
    welcomeMessage:
      widgetConfigsByAgentId.get(row.id)?.welcomeMessage || DEFAULT_WIDGET_CONFIG.welcomeMessage,
    buttonLabel:
      widgetConfigsByAgentId.get(row.id)?.buttonLabel || DEFAULT_WIDGET_CONFIG.buttonLabel,
    primaryColor:
      widgetConfigsByAgentId.get(row.id)?.primaryColor || DEFAULT_WIDGET_CONFIG.primaryColor,
    secondaryColor:
      widgetConfigsByAgentId.get(row.id)?.secondaryColor || DEFAULT_WIDGET_CONFIG.secondaryColor,
    installStatus: installStatusByAgentId.get(row.id) || buildDefaultInstallStatus(
      widgetConfigsByAgentId.get(row.id),
      businessesById.get(row.business_id)?.website_url || ""
    ),
    widgetMetrics: widgetMetricsByAgentId.get(row.id) || null,
    messageCount: messageStatsByAgentId.get(row.id)?.messageCount || 0,
    lastMessageAt: messageStatsByAgentId.get(row.id)?.lastMessageAt || null,
  }));
}

export async function getAgentWorkspaceSnapshot(supabase, agentId) {
  const normalizedAgentId = cleanText(agentId);

  if (!normalizedAgentId) {
    const error = new Error("agent_id is required");
    error.statusCode = 400;
    throw error;
  }

  const agents = await listAllAgents(supabase);
  const agent = agents.find((candidate) => candidate.id === normalizedAgentId) || null;

  if (!agent) {
    const error = new Error("Agent not found");
    error.statusCode = 404;
    throw error;
  }

  return agent;
}

export async function updateAgentSettings(
  supabase,
  { agentId, name, assistantName, tone, systemPrompt, welcomeMessage, buttonLabel, websiteUrl, primaryColor, secondaryColor, allowedDomains }
) {
  const normalizedAgentId = cleanText(agentId);
  const providedWebsiteUrl = cleanText(websiteUrl);
  const normalizedWebsiteUrl = providedWebsiteUrl
    ? normalizeWebsiteUrl(providedWebsiteUrl, {
        requireHttps: true,
        requirePublicHostname: true,
      })
    : "";

  if (!normalizedAgentId) {
    const error = new Error("agent_id is required");
    error.statusCode = 400;
    throw error;
  }

  if (providedWebsiteUrl && !normalizedWebsiteUrl) {
    throw buildInvalidWebsiteUrlError();
  }

  const agent = await findAgentById(supabase, normalizedAgentId);

  if (!agent) {
    const error = new Error("Agent not found");
    error.statusCode = 404;
    throw error;
  }

  const nextAssistantName = cleanText(assistantName) || cleanText(name) || agent.name || DEFAULT_AGENT_NAME;
  const nextTone = cleanText(tone) || agent.tone || DEFAULT_TONE;
  const nextSystemPrompt = cleanText(systemPrompt) || "";
  const currentWidgetConfig = await ensureWidgetConfigForAgent(supabase, normalizedAgentId);
  const currentBusiness = agent.businessId
    ? await findBusinessByIdentifier(supabase, agent.businessId)
    : null;
  const currentWebsiteUrl =
    normalizeWebsiteUrl(currentBusiness?.website_url || "", {
      requirePublicHostname: false,
    }) || cleanText(currentBusiness?.website_url || "");

  const { error: agentError } = await supabase
    .from(AGENTS_TABLE)
    .update({
      name: nextAssistantName,
      tone: nextTone,
      system_prompt: nextSystemPrompt,
    })
    .eq("id", normalizedAgentId);

  if (agentError) {
    console.error("[agentService] Failed to update agent core settings:", {
      agentId: normalizedAgentId,
      code: agentError.code,
      message: agentError.message,
    });
    throw agentError;
  }

  let resolvedWebsiteUrl = currentWebsiteUrl;

  if (normalizedWebsiteUrl) {
    try {
      if (normalizedWebsiteUrl !== currentWebsiteUrl) {
        const existingBusiness = await findBusinessByWebsiteUrl(supabase, normalizedWebsiteUrl);

        if (existingBusiness && existingBusiness.id !== agent.businessId) {
          if (existingBusiness.website_url !== normalizedWebsiteUrl) {
            await updateBusinessWebsiteUrl(supabase, existingBusiness.id, normalizedWebsiteUrl);
          }
          await reassignAgentBusiness(supabase, normalizedAgentId, existingBusiness.id);
        } else {
          await updateBusinessWebsiteUrl(supabase, agent.businessId, normalizedWebsiteUrl);
        }
      } else if (currentBusiness?.website_url !== normalizedWebsiteUrl) {
        await updateBusinessWebsiteUrl(supabase, agent.businessId, normalizedWebsiteUrl);
      }
    } catch (businessError) {
      if (businessError?.code === "23505") {
        const existingBusiness = await findBusinessByWebsiteUrl(supabase, normalizedWebsiteUrl);

        if (existingBusiness?.id) {
          if (existingBusiness.website_url !== normalizedWebsiteUrl) {
            await updateBusinessWebsiteUrl(supabase, existingBusiness.id, normalizedWebsiteUrl);
          }
          await reassignAgentBusiness(supabase, normalizedAgentId, existingBusiness.id);
        } else {
          throw buildAgentSettingsError(
            "That website is already connected elsewhere in Vonza. Try again in a moment.",
            409,
            businessError.code
          );
        }
      } else {
        throw businessError;
      }
    }

    resolvedWebsiteUrl = normalizedWebsiteUrl;
  }

  const resolvedAllowedDomains = deriveAllowedDomains(allowedDomains, resolvedWebsiteUrl);

  const { error: widgetError } = await supabase
    .from(WIDGET_CONFIGS_TABLE)
    .upsert(
      {
        agent_id: normalizedAgentId,
        assistant_name: nextAssistantName,
        welcome_message: cleanText(welcomeMessage) || currentWidgetConfig.welcomeMessage,
        button_label: cleanText(buttonLabel) || currentWidgetConfig.buttonLabel,
        primary_color: cleanText(primaryColor) || currentWidgetConfig.primaryColor,
        secondary_color: cleanText(secondaryColor) || currentWidgetConfig.secondaryColor,
        launcher_text: currentWidgetConfig.launcherText,
        theme_mode: currentWidgetConfig.themeMode,
        allowed_domains: resolvedAllowedDomains,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" }
    );

  if (widgetError) {
    if (!isMissingRelationError(widgetError, WIDGET_CONFIGS_TABLE)) {
      console.error("[agentService] Failed to update widget config:", {
        agentId: normalizedAgentId,
        code: widgetError.code,
        message: widgetError.message,
      });
      throw widgetError;
    }
  }

  return {
    id: normalizedAgentId,
    publicAgentKey: agent.publicAgentKey,
    name: nextAssistantName,
    assistantName: nextAssistantName,
    tone: nextTone,
    systemPrompt: nextSystemPrompt,
    websiteUrl: resolvedWebsiteUrl,
    welcomeMessage: cleanText(welcomeMessage) || currentWidgetConfig.welcomeMessage,
    buttonLabel: cleanText(buttonLabel) || currentWidgetConfig.buttonLabel,
    primaryColor: cleanText(primaryColor) || currentWidgetConfig.primaryColor,
    secondaryColor: cleanText(secondaryColor) || currentWidgetConfig.secondaryColor,
    installId: currentWidgetConfig.installId,
    allowedDomains: resolvedAllowedDomains,
  };
}

export async function deleteAgent(supabase, agentId) {
  const normalizedAgentId = cleanText(agentId);

  if (!normalizedAgentId) {
    const error = new Error("agent_id is required");
    error.statusCode = 400;
    throw error;
  }

  const { error: widgetConfigError } = await supabase
    .from(WIDGET_CONFIGS_TABLE)
    .delete()
    .eq("agent_id", normalizedAgentId);

  if (widgetConfigError && !isMissingRelationError(widgetConfigError, WIDGET_CONFIGS_TABLE)) {
    console.error(widgetConfigError);
    throw widgetConfigError;
  }

  const { error: agentError } = await supabase
    .from(AGENTS_TABLE)
    .delete()
    .eq("id", normalizedAgentId);

  if (agentError) {
    console.error(agentError);
    throw agentError;
  }

  return { ok: true };
}

export async function findClaimableAgentByClientId(supabase, options = {}) {
  const normalizedClientId = cleanText(options.clientId);
  const normalizedOwnerUserId = cleanText(options.ownerUserId);

  if (!normalizedClientId) {
    return null;
  }

  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .select("id, business_id, client_id, owner_user_id, access_status, public_agent_key, name, tone, system_prompt, is_active")
    .eq("client_id", normalizedClientId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    if (isMissingRelationError(error, AGENTS_TABLE)) {
      return null;
    }

    console.error(error);
    throw error;
  }

  const match = (data || []).find((row) => {
    const existingOwnerUserId = cleanText(row.owner_user_id);
    return !existingOwnerUserId || existingOwnerUserId === normalizedOwnerUserId;
  });

  if (!match) {
    return null;
  }

  const mappedAgent = mapAgentRow(match);
  const widgetConfig = await getWidgetConfigForAgent(supabase, mappedAgent.id);

  return {
    ...mappedAgent,
    assistantName: widgetConfig.assistantName || mappedAgent.name || DEFAULT_WIDGET_CONFIG.assistantName,
    welcomeMessage: widgetConfig.welcomeMessage || DEFAULT_WIDGET_CONFIG.welcomeMessage,
    buttonLabel: widgetConfig.buttonLabel || DEFAULT_WIDGET_CONFIG.buttonLabel,
    primaryColor: widgetConfig.primaryColor || DEFAULT_WIDGET_CONFIG.primaryColor,
    secondaryColor: widgetConfig.secondaryColor || DEFAULT_WIDGET_CONFIG.secondaryColor,
  };
}

export async function claimAgentForOwner(supabase, options = {}) {
  const normalizedAgentId = cleanText(options.agentId);
  const normalizedClientId = cleanText(options.clientId);
  const normalizedOwnerUserId = cleanText(options.ownerUserId);

  if (!normalizedOwnerUserId) {
    const error = new Error("Authenticated owner is required");
    error.statusCode = 401;
    throw error;
  }

  let candidate = null;

  if (normalizedAgentId) {
    candidate = await findAgentById(supabase, normalizedAgentId);

    if (candidate && normalizedClientId && candidate.clientId && candidate.clientId !== normalizedClientId) {
      candidate = null;
    }
  }

  if (!candidate) {
    candidate = await findClaimableAgentByClientId(supabase, {
      clientId: normalizedClientId,
      ownerUserId: normalizedOwnerUserId,
    });
  }

  if (!candidate) {
    const error = new Error("No claimable assistant found in this browser.");
    error.statusCode = 404;
    throw error;
  }

  if (candidate.ownerUserId && candidate.ownerUserId !== normalizedOwnerUserId) {
    const error = new Error("This assistant is already claimed by another account.");
    error.statusCode = 403;
    throw error;
  }

  return claimAgentOwnershipById(supabase, candidate.id, normalizedOwnerUserId);
}

export async function requireAgentAccess(supabase, options = {}) {
  const normalizedAgentId = cleanText(options.agentId);
  const normalizedOwnerUserId = cleanText(options.ownerUserId);
  const normalizedClientId = cleanText(options.clientId);

  if (!normalizedAgentId) {
    const error = new Error("agent_id is required");
    error.statusCode = 400;
    throw error;
  }

  const agent = await findAgentById(supabase, normalizedAgentId);

  if (!agent) {
    const error = new Error("Agent not found");
    error.statusCode = 404;
    throw error;
  }

  if (normalizedOwnerUserId) {
    if (cleanText(agent.ownerUserId) !== normalizedOwnerUserId) {
      const error = new Error("Forbidden");
      error.statusCode = 403;
      throw error;
    }

    return agent;
  }

  if (normalizedClientId && cleanText(agent.clientId) === normalizedClientId) {
    return agent;
  }

  const error = new Error("Forbidden");
  error.statusCode = 403;
  throw error;
}

export async function requireActiveAgentAccess(supabase, options = {}) {
  const agent = await requireAgentAccess(supabase, options);

  if (normalizeAccessStatus(agent.accessStatus) !== "active") {
    const error = new Error("Access is not active yet.");
    error.statusCode = 403;
    throw error;
  }

  return agent;
}

export async function updateAgentAccessStatus(supabase, options = {}) {
  const normalizedAgentId = cleanText(options.agentId);

  if (!normalizedAgentId) {
    const error = new Error("agent_id is required");
    error.statusCode = 400;
    throw error;
  }

  const nextAccessStatus = normalizeAccessStatus(options.accessStatus);
  const agent = await findAgentById(supabase, normalizedAgentId);

  if (!agent) {
    const error = new Error("Agent not found");
    error.statusCode = 404;
    throw error;
  }

  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .update({
      access_status: nextAccessStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", normalizedAgentId)
    .select(
      "id, business_id, client_id, owner_user_id, access_status, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
    )
    .single();

  if (error) {
    console.error(error);
    throw error;
  }

  return mapAgentRow(data || null);
}

export async function updateOwnedAccessStatus(supabase, options = {}) {
  const normalizedOwnerUserId = cleanText(options.ownerUserId);
  const nextAccessStatus = normalizeAccessStatus(options.accessStatus);

  if (!normalizedOwnerUserId) {
    const error = new Error("Authenticated owner is required");
    error.statusCode = 401;
    throw error;
  }

  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .update({
      access_status: nextAccessStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("owner_user_id", normalizedOwnerUserId)
    .select(
      "id, business_id, client_id, owner_user_id, access_status, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
    );

  if (error) {
    console.error(error);
    throw error;
  }

  return (data || []).map((row) => mapAgentRow(row));
}

export { AGENTS_TABLE, WIDGET_CONFIGS_TABLE };

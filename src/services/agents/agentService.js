import { cleanText, slugifyLookupValue } from "../../utils/text.js";
import { getHostnameFromUrl } from "../../utils/url.js";
import { ensureBusinessRecord, findBusinessByIdentifier } from "../business/businessResolution.js";
import { getAgentMessageStats } from "../chat/messageService.js";
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_LANGUAGE,
  DEFAULT_PURPOSE,
  DEFAULT_TONE,
  DEFAULT_WIDGET_CONFIG,
} from "./agentDefaults.js";

const AGENTS_TABLE = "agents";
const WIDGET_CONFIGS_TABLE = "widget_configs";

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
        }
      : {}),
  };
}

export async function getWidgetConfigForAgent(supabase, agentId) {
  const { data, error } = await supabase
    .from(WIDGET_CONFIGS_TABLE)
    .select(
      "id, agent_id, assistant_name, welcome_message, button_label, primary_color, secondary_color, launcher_text, theme_mode"
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
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" }
    )
    .select(
      "id, agent_id, assistant_name, welcome_message, button_label, primary_color, secondary_color, launcher_text, theme_mode"
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
      "id, business_id, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
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
      "id, business_id, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
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

async function findDefaultAgentForBusiness(supabase, businessId, clientId) {
  let query = supabase
    .from(AGENTS_TABLE)
    .select(
      "id, business_id, client_id, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
    )
    .eq("business_id", businessId)
    .eq("is_active", true);

  if (clientId) {
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

export async function ensureAgentForBusiness(supabase, business, clientId) {
  const existingAgent = await findDefaultAgentForBusiness(supabase, business.id, clientId);

  if (existingAgent) {
    return existingAgent;
  }

  const defaultKey = buildDefaultAgentKey(business);
  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .insert({
      business_id: business.id,
      client_id: clientId || null,
      public_agent_key: defaultKey,
      name: cleanText(business.name) || DEFAULT_AGENT_NAME,
      purpose: DEFAULT_PURPOSE,
      tone: DEFAULT_TONE,
      language: DEFAULT_LANGUAGE,
      is_active: true,
    })
    .select(
      "id, business_id, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
    )
    .single();

  if (error) {
    if (isMissingRelationError(error, AGENTS_TABLE)) {
      return {
        id: `fallback-${business.id}`,
        businessId: business.id,
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
  const context = await resolveAgentContext(supabase, options);

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
  };
}

export async function createAgentForBusinessName(supabase, businessName, websiteUrl, clientId) {
  const normalizedBusinessName = cleanText(businessName);
  const normalizedWebsiteUrl = cleanText(websiteUrl);
  const normalizedClientId = cleanText(clientId);

  if (!normalizedBusinessName) {
    const error = new Error("business_name is required");
    error.statusCode = 400;
    throw error;
  }

  if (!normalizedClientId) {
    const error = new Error("client_id is required");
    error.statusCode = 400;
    throw error;
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

  const agent = await ensureAgentForBusiness(supabase, business, normalizedClientId);
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

export async function listAgents(supabase, clientId) {
  const normalizedClientId = cleanText(clientId);

  if (!normalizedClientId) {
    const error = new Error("client_id is required");
    error.statusCode = 400;
    throw error;
  }

  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .select("id, business_id, client_id, public_agent_key, name, tone, system_prompt, is_active")
    .eq("client_id", normalizedClientId)
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

  if (agentIds.length) {
    const { data: widgetRows, error: widgetError } = await supabase
      .from(WIDGET_CONFIGS_TABLE)
      .select("agent_id, assistant_name, welcome_message, button_label, primary_color, secondary_color")
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
          {
            assistantName: row.assistant_name || DEFAULT_WIDGET_CONFIG.assistantName,
            welcomeMessage: row.welcome_message || DEFAULT_WIDGET_CONFIG.welcomeMessage,
            buttonLabel: row.button_label || DEFAULT_WIDGET_CONFIG.buttonLabel,
            primaryColor: row.primary_color || DEFAULT_WIDGET_CONFIG.primaryColor,
            secondaryColor: row.secondary_color || DEFAULT_WIDGET_CONFIG.secondaryColor,
          },
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

  return agentRows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    clientId: row.client_id || "",
    name: row.name || DEFAULT_AGENT_NAME,
    assistantName:
      widgetConfigsByAgentId.get(row.id)?.assistantName || row.name || DEFAULT_WIDGET_CONFIG.assistantName,
    publicAgentKey: row.public_agent_key || "",
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
  }));
}

export async function listAllAgents(supabase) {
  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .select("id, business_id, client_id, public_agent_key, name, tone, system_prompt, is_active")
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

  if (agentIds.length) {
    const { data: widgetRows, error: widgetError } = await supabase
      .from(WIDGET_CONFIGS_TABLE)
      .select("agent_id, assistant_name, welcome_message, button_label, primary_color, secondary_color")
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
          {
            assistantName: row.assistant_name || DEFAULT_WIDGET_CONFIG.assistantName,
            welcomeMessage: row.welcome_message || DEFAULT_WIDGET_CONFIG.welcomeMessage,
            buttonLabel: row.button_label || DEFAULT_WIDGET_CONFIG.buttonLabel,
            primaryColor: row.primary_color || DEFAULT_WIDGET_CONFIG.primaryColor,
            secondaryColor: row.secondary_color || DEFAULT_WIDGET_CONFIG.secondaryColor,
          },
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

  if (agentIds.length) {
    messageStatsByAgentId = await getAgentMessageStats(supabase, agentIds);
  }

  return agentRows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    clientId: row.client_id || "",
    name: row.name || DEFAULT_AGENT_NAME,
    assistantName:
      widgetConfigsByAgentId.get(row.id)?.assistantName || row.name || DEFAULT_WIDGET_CONFIG.assistantName,
    publicAgentKey: row.public_agent_key || "",
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
    messageCount: messageStatsByAgentId.get(row.id)?.messageCount || 0,
    lastMessageAt: messageStatsByAgentId.get(row.id)?.lastMessageAt || null,
  }));
}

export async function updateAgentSettings(
  supabase,
  { agentId, name, assistantName, tone, systemPrompt, welcomeMessage, buttonLabel, websiteUrl, primaryColor, secondaryColor }
) {
  const normalizedAgentId = cleanText(agentId);
  const normalizedWebsiteUrl = cleanText(websiteUrl);

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

  const nextAssistantName = cleanText(assistantName) || cleanText(name) || agent.name || DEFAULT_AGENT_NAME;
  const nextTone = cleanText(tone) || agent.tone || DEFAULT_TONE;
  const nextSystemPrompt = cleanText(systemPrompt) || "";
  const currentWidgetConfig = await ensureWidgetConfigForAgent(supabase, normalizedAgentId);

  const { error: agentError } = await supabase
    .from(AGENTS_TABLE)
    .update({
      name: nextAssistantName,
      tone: nextTone,
      system_prompt: nextSystemPrompt,
    })
    .eq("id", normalizedAgentId);

  if (agentError) {
    console.error(agentError);
    throw agentError;
  }

  if (normalizedWebsiteUrl) {
    const { error: businessError } = await supabase
      .from("businesses")
      .update({
        website_url: normalizedWebsiteUrl,
      })
      .eq("id", agent.businessId);

    if (businessError) {
      console.error(businessError);
      throw businessError;
    }
  }

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
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" }
    );

  if (widgetError) {
    if (!isMissingRelationError(widgetError, WIDGET_CONFIGS_TABLE)) {
      console.error(widgetError);
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
    websiteUrl: normalizedWebsiteUrl,
    welcomeMessage: cleanText(welcomeMessage) || currentWidgetConfig.welcomeMessage,
    buttonLabel: cleanText(buttonLabel) || currentWidgetConfig.buttonLabel,
    primaryColor: cleanText(primaryColor) || currentWidgetConfig.primaryColor,
    secondaryColor: cleanText(secondaryColor) || currentWidgetConfig.secondaryColor,
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

export { AGENTS_TABLE, WIDGET_CONFIGS_TABLE };

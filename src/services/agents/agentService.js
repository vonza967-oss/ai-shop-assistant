import { cleanText, slugifyLookupValue } from "../../utils/text.js";
import { getHostnameFromUrl } from "../../utils/url.js";
import { ensureBusinessRecord, findBusinessByIdentifier } from "../business/businessResolution.js";
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
      "id, agent_id, welcome_message, button_label, primary_color, secondary_color, launcher_text, theme_mode"
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

async function findDefaultAgentForBusiness(supabase, businessId) {
  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .select(
      "id, business_id, public_agent_key, name, purpose, system_prompt, tone, language, is_active"
    )
    .eq("business_id", businessId)
    .eq("is_active", true)
    .limit(1);

  if (error) {
    if (isMissingRelationError(error, AGENTS_TABLE)) {
      return null;
    }
    console.error(error);
    throw error;
  }

  return mapAgentRow(data?.[0] || null);
}

export async function ensureAgentForBusiness(supabase, business) {
  const existingAgent = await findDefaultAgentForBusiness(supabase, business.id);

  if (existingAgent) {
    return existingAgent;
  }

  const defaultKey = buildDefaultAgentKey(business);
  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .insert({
      business_id: business.id,
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
      assistantName: context.agent.name || context.widgetConfig.assistantName,
    },
  };
}

export { AGENTS_TABLE, WIDGET_CONFIGS_TABLE };

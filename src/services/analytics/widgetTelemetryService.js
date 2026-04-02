import { cleanText } from "../../utils/text.js";
import { getWidgetInstallContextByInstallId, isMissingRelationError } from "../install/installPresenceService.js";

const WIDGET_EVENTS_TABLE = "agent_widget_events";

export const TRACKED_WIDGET_EVENTS = [
  "widget_loaded",
  "widget_opened",
  "first_message_sent",
  "message_replied",
  "contact_captured",
  "conversation_started",
];

function normalizeJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizePageUrl(value) {
  const normalized = cleanText(value);

  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeOrigin(value) {
  const pageUrl = normalizePageUrl(value);

  if (!pageUrl) {
    return "";
  }

  return new URL(pageUrl).origin.toLowerCase();
}

function buildDefaultDedupeKey({ installId, eventName, sessionId, origin, pageUrl, metadata }) {
  const normalizedMetadata = normalizeJsonObject(metadata);
  const parts = [cleanText(installId), cleanText(eventName), cleanText(sessionId)];

  if (eventName === "widget_loaded") {
    parts.push(cleanText(pageUrl) || cleanText(origin));
  } else if (eventName === "message_replied") {
    parts.push(cleanText(normalizedMetadata.replyId) || cleanText(normalizedMetadata.replyHash));
  } else if (eventName === "contact_captured") {
    parts.push(cleanText(normalizedMetadata.contactHash));
  }

  return parts.filter(Boolean).join("::");
}

function buildEmptyMetrics() {
  return {
    totalEvents: 0,
    widgetLoadedCount: 0,
    widgetOpenedCount: 0,
    firstMessageSentCount: 0,
    messageRepliedCount: 0,
    contactCapturedCount: 0,
    conversationStartedCount: 0,
    conversationsSinceInstall: 0,
    uniqueSessionCount: 0,
    lastEventAt: null,
    lastConversationAt: null,
  };
}

export async function trackWidgetEvent(supabase, input = {}) {
  const installId = cleanText(input.installId);
  const eventName = cleanText(input.eventName);
  const sessionId = cleanText(input.sessionId || input.fingerprint);
  const origin = normalizeOrigin(input.origin);
  const pageUrl = normalizePageUrl(input.pageUrl);
  const fingerprint = cleanText(input.fingerprint);
  const metadata = normalizeJsonObject(input.metadata);

  if (!installId) {
    const error = new Error("install_id is required");
    error.statusCode = 400;
    throw error;
  }

  if (!TRACKED_WIDGET_EVENTS.includes(eventName)) {
    const error = new Error("Unsupported widget event");
    error.statusCode = 400;
    throw error;
  }

  if (!sessionId) {
    const error = new Error("session_id is required");
    error.statusCode = 400;
    throw error;
  }

  const context = await getWidgetInstallContextByInstallId(supabase, installId);

  if (!context?.agent?.id) {
    const error = new Error("Install not found");
    error.statusCode = 404;
    throw error;
  }

  const dedupeKey = cleanText(input.dedupeKey) || buildDefaultDedupeKey({
    installId,
    eventName,
    sessionId,
    origin,
    pageUrl,
    metadata,
  });

  const { error } = await supabase.from(WIDGET_EVENTS_TABLE).insert({
    agent_id: context.agent.id,
    install_id: installId,
    session_id: sessionId,
    fingerprint: fingerprint || null,
    event_name: eventName,
    origin: origin || null,
    page_url: pageUrl || null,
    metadata,
    dedupe_key: dedupeKey,
    created_at: new Date().toISOString(),
  });

  if (error) {
    if (error?.code === "23505") {
      return { ok: true, duplicate: true };
    }

    if (isMissingRelationError(error, WIDGET_EVENTS_TABLE)) {
      return { ok: false, skipped: true };
    }

    console.warn("[widget telemetry] ingestion failure", {
      installId,
      eventName,
      sessionId,
      code: error.code || null,
      message: error.message || "Unknown error",
    });
    throw error;
  }

  return {
    ok: true,
    duplicate: false,
    agentId: context.agent.id,
  };
}

export async function listWidgetEventSummaryByAgentIds(supabase, agentIds = [], options = {}) {
  const normalizedAgentIds = agentIds.map((agentId) => cleanText(agentId)).filter(Boolean);

  if (!normalizedAgentIds.length) {
    return new Map();
  }

  const { data, error } = await supabase
    .from(WIDGET_EVENTS_TABLE)
    .select("agent_id, event_name, session_id, created_at")
    .in("agent_id", normalizedAgentIds)
    .in("event_name", TRACKED_WIDGET_EVENTS);

  if (error) {
    if (isMissingRelationError(error, WIDGET_EVENTS_TABLE)) {
      return new Map();
    }

    console.error(error);
    throw error;
  }

  const sinceByAgentId = options.sinceByAgentId instanceof Map ? options.sinceByAgentId : new Map();
  const metricsByAgentId = new Map(
    normalizedAgentIds.map((agentId) => [agentId, { ...buildEmptyMetrics(), sessionIds: new Set() }])
  );

  (data || []).forEach((row) => {
    const metrics = metricsByAgentId.get(row.agent_id);

    if (!metrics) {
      return;
    }

    metrics.totalEvents += 1;
    if (row.session_id) {
      metrics.sessionIds.add(row.session_id);
    }

    if (!metrics.lastEventAt || new Date(row.created_at).getTime() > new Date(metrics.lastEventAt).getTime()) {
      metrics.lastEventAt = row.created_at;
    }

    const sinceValue = sinceByAgentId.get(row.agent_id);
    const happenedAfterInstall = sinceValue
      ? new Date(row.created_at).getTime() >= new Date(sinceValue).getTime()
      : true;

    switch (row.event_name) {
      case "widget_loaded":
        metrics.widgetLoadedCount += 1;
        break;
      case "widget_opened":
        metrics.widgetOpenedCount += 1;
        break;
      case "first_message_sent":
        metrics.firstMessageSentCount += 1;
        break;
      case "message_replied":
        metrics.messageRepliedCount += 1;
        break;
      case "contact_captured":
        metrics.contactCapturedCount += 1;
        break;
      case "conversation_started":
        metrics.conversationStartedCount += 1;
        if (happenedAfterInstall) {
          metrics.conversationsSinceInstall += 1;
        }
        if (!metrics.lastConversationAt || new Date(row.created_at).getTime() > new Date(metrics.lastConversationAt).getTime()) {
          metrics.lastConversationAt = row.created_at;
        }
        break;
      default:
        break;
    }
  });

  return new Map(
    normalizedAgentIds.map((agentId) => {
      const metrics = metricsByAgentId.get(agentId) || { ...buildEmptyMetrics(), sessionIds: new Set() };
      return [
        agentId,
        {
          totalEvents: metrics.totalEvents,
          widgetLoadedCount: metrics.widgetLoadedCount,
          widgetOpenedCount: metrics.widgetOpenedCount,
          firstMessageSentCount: metrics.firstMessageSentCount,
          messageRepliedCount: metrics.messageRepliedCount,
          contactCapturedCount: metrics.contactCapturedCount,
          conversationStartedCount: metrics.conversationStartedCount,
          conversationsSinceInstall: metrics.conversationsSinceInstall,
          uniqueSessionCount: metrics.sessionIds.size,
          lastEventAt: metrics.lastEventAt,
          lastConversationAt: metrics.lastConversationAt,
        },
      ];
    })
  );
}

export async function assertWidgetTelemetrySchemaReady(supabase) {
  const { error } = await supabase
    .from(WIDGET_EVENTS_TABLE)
    .select("install_id, session_id, fingerprint, event_name, origin, page_url, dedupe_key")
    .limit(1);

  if (error) {
    if (isMissingRelationError(error, WIDGET_EVENTS_TABLE) || error?.code === "42703") {
      const schemaError = new Error(
        `[startup] Missing required widget telemetry schema for '${WIDGET_EVENTS_TABLE}'. Apply the latest database migration before starting this build.`
      );
      schemaError.statusCode = 500;
      throw schemaError;
    }

    throw error;
  }
}

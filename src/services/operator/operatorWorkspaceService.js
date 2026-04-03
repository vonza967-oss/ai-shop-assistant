import { randomBytes } from "node:crypto";

import axios from "axios";

import {
  getGoogleClientId,
  getGoogleClientSecret,
  getGoogleOAuthRedirectUri,
  getGoogleTokenEncryptionSecret,
  isOperatorWorkspaceEnabled,
} from "../../config/env.js";
import {
  CONNECTED_ACCOUNT_AUDIT_TABLE,
  CONNECTED_ACCOUNT_TABLE,
  GOOGLE_OAUTH_STATE_TABLE,
  OPERATOR_CALENDAR_EVENT_TABLE,
  OPERATOR_CAMPAIGN_RECIPIENT_TABLE,
  OPERATOR_CAMPAIGN_STEP_TABLE,
  OPERATOR_CAMPAIGN_TABLE,
  OPERATOR_INBOX_MESSAGE_TABLE,
  OPERATOR_INBOX_THREAD_TABLE,
  OPERATOR_TASK_TABLE,
} from "../../config/constants.js";
import { listLeadCaptures } from "../leads/liveLeadCaptureService.js";
import { listFollowUpWorkflows } from "../followup/followUpService.js";
import { updateActionQueueStatus } from "../analytics/actionQueueService.js";
import { listConversionOutcomesForAgent, recordOutcomeEvent } from "../conversion/conversionOutcomeService.js";
import {
  buildOperatorActivationChecklist,
  buildOperatorBriefing,
  buildOperatorSingleNextAction,
  buildOperatorTodaySummary,
  createDefaultOperatorActivationState,
  getOperatorActivationState,
  getOperatorMailboxOptions,
  patchOperatorActivationState,
  probeOperatorActivationPersistence,
} from "./operatorActivationService.js";
import { getOperatorContactsWorkspace } from "./contactWorkspaceService.js";
import { cleanText } from "../../utils/text.js";
import { decryptSecret, encryptSecret, hashToken } from "../../utils/crypto.js";

export const GOOGLE_OPERATOR_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
  "profile",
];

export const INBOX_CLASSIFICATIONS = [
  "lead_sales",
  "support",
  "complaint",
  "billing",
  "follow_up_needed",
];

export const CAMPAIGN_GOALS = [
  "welcome",
  "quote_follow_up",
  "abandoned_lead_reengagement",
  "review_request",
  "complaint_recovery",
];

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_GMAIL_THREADS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
const GOOGLE_GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GOOGLE_CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MAILBOX_FALLBACK = "INBOX";
const DEFAULT_SYNC_WINDOW_DAYS = 14;
const DEFAULT_SYNC_RESULTS = 12;
const STALE_REPLY_WINDOW_HOURS = 24;
const CALENDAR_SLOT_MINUTES = 60;
const SLOT_SEARCH_DAYS = 5;
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;

const CONNECTED_ACCOUNT_SELECT = [
  "id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "provider",
  "provider_account_id",
  "account_email",
  "display_name",
  "selected_mailbox",
  "scopes",
  "scope_audit",
  "status",
  "access_token_encrypted",
  "refresh_token_encrypted",
  "token_expires_at",
  "last_refreshed_at",
  "last_sync_at",
  "last_error",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const INBOX_THREAD_SELECT = [
  "id",
  "connected_account_id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "provider_thread_id",
  "provider_history_id",
  "mailbox_label",
  "subject",
  "snippet",
  "classification",
  "priority",
  "status",
  "complaint_state",
  "follow_up_state",
  "needs_reply",
  "risk_level",
  "unread_count",
  "participants",
  "contact_id",
  "related_lead_id",
  "related_follow_up_id",
  "related_action_key",
  "last_message_at",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const INBOX_MESSAGE_SELECT = [
  "id",
  "thread_id",
  "connected_account_id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "provider_message_id",
  "direction",
  "approval_status",
  "message_state",
  "sender",
  "recipients",
  "cc",
  "subject",
  "body_preview",
  "body_text",
  "sent_at",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const CALENDAR_EVENT_SELECT = [
  "id",
  "connected_account_id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "provider_event_id",
  "action_type",
  "source_kind",
  "status",
  "approval_status",
  "title",
  "description",
  "attendee_emails",
  "start_at",
  "end_at",
  "timezone",
  "location",
  "contact_id",
  "lead_id",
  "related_action_key",
  "conflict_state",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const CAMPAIGN_SELECT = [
  "id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "goal",
  "title",
  "status",
  "approval_status",
  "recipient_source",
  "source_filters",
  "schedule_config",
  "sequence_summary",
  "reply_handling_mode",
  "approved_at",
  "activated_at",
  "last_error",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const CAMPAIGN_STEP_SELECT = [
  "id",
  "campaign_id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "step_order",
  "channel",
  "timing_offset_hours",
  "subject",
  "body",
  "approval_status",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const CAMPAIGN_RECIPIENT_SELECT = [
  "id",
  "campaign_id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "lead_id",
  "contact_id",
  "person_key",
  "contact_name",
  "contact_email",
  "status",
  "current_step_index",
  "next_send_at",
  "last_contacted_at",
  "reply_state",
  "last_thread_id",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const TASK_SELECT = [
  "id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "source_type",
  "source_id",
  "task_type",
  "title",
  "description",
  "status",
  "priority",
  "approval_required",
  "contact_id",
  "related_thread_id",
  "related_event_id",
  "related_campaign_id",
  "related_lead_id",
  "related_action_key",
  "task_state",
  "resolved_at",
  "created_at",
  "updated_at",
].join(", ");

function buildConfigError(message) {
  const error = new Error(message);
  error.statusCode = 500;
  return error;
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cleanText(entry)).filter(Boolean);
  }

  return [];
}

function uniqueText(values = []) {
  return [...new Set(normalizeArray(values))];
}

function isMissingRelationError(error, relationName) {
  const message = cleanText(error?.message || "").toLowerCase();

  return (
    error?.code === "PGRST205" ||
    error?.code === "42P01" ||
    message.includes(`'public.${relationName}'`) ||
    message.includes(`${relationName} was not found`)
  );
}

function parseTimestamp(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isWithinHours(value, hours) {
  const timestamp = parseTimestamp(value);
  return Boolean(timestamp) && (Date.now() - timestamp) <= hours * 60 * 60 * 1000;
}

function buildGoogleApi(deps = {}) {
  return {
    async exchangeCode({ code, redirectUri }) {
      if (typeof deps.exchangeCode === "function") {
        return deps.exchangeCode({ code, redirectUri });
      }

      const params = new URLSearchParams({
        code,
        client_id: getGoogleClientId(),
        client_secret: getGoogleClientSecret(),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
      const response = await axios.post(GOOGLE_TOKEN_URL, params.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      return response.data;
    },

    async refreshAccessToken({ refreshToken }) {
      if (typeof deps.refreshAccessToken === "function") {
        return deps.refreshAccessToken({ refreshToken });
      }

      const params = new URLSearchParams({
        client_id: getGoogleClientId(),
        client_secret: getGoogleClientSecret(),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });
      const response = await axios.post(GOOGLE_TOKEN_URL, params.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      return response.data;
    },

    async getUserInfo({ accessToken }) {
      if (typeof deps.getUserInfo === "function") {
        return deps.getUserInfo({ accessToken });
      }

      const response = await axios.get(GOOGLE_USERINFO_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      return response.data;
    },

    async listInboxThreads({ accessToken, mailbox, maxResults }) {
      if (typeof deps.listInboxThreads === "function") {
        return deps.listInboxThreads({ accessToken, mailbox, maxResults });
      }

      const labelIds = mailbox && mailbox !== MAILBOX_FALLBACK ? [mailbox] : [MAILBOX_FALLBACK];
      const listResponse = await axios.get(GOOGLE_GMAIL_THREADS_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params: {
          labelIds,
          maxResults,
          q: `newer_than:${DEFAULT_SYNC_WINDOW_DAYS}d`,
        },
      });
      const threadIds = (listResponse.data?.threads || []).map((thread) => thread.id).filter(Boolean);
      const threads = await Promise.all(threadIds.map(async (threadId) => {
        const response = await axios.get(`${GOOGLE_GMAIL_THREADS_URL}/${threadId}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          params: {
            format: "full",
          },
        });
        return response.data;
      }));

      return threads;
    },

    async sendMessage({ accessToken, raw }) {
      if (typeof deps.sendMessage === "function") {
        return deps.sendMessage({ accessToken, raw });
      }

      const response = await axios.post(
        GOOGLE_GMAIL_SEND_URL,
        { raw },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      return response.data;
    },

    async listCalendarEvents({ accessToken, timeMin, timeMax, maxResults }) {
      if (typeof deps.listCalendarEvents === "function") {
        return deps.listCalendarEvents({ accessToken, timeMin, timeMax, maxResults });
      }

      const response = await axios.get(GOOGLE_CALENDAR_EVENTS_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params: {
          singleEvents: true,
          orderBy: "startTime",
          timeMin,
          timeMax,
          maxResults,
        },
      });
      return response.data?.items || [];
    },

    async createCalendarEvent({ accessToken, event }) {
      if (typeof deps.createCalendarEvent === "function") {
        return deps.createCalendarEvent({ accessToken, event });
      }

      const response = await axios.post(GOOGLE_CALENDAR_EVENTS_URL, event, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      return response.data;
    },

    async updateCalendarEvent({ accessToken, eventId, event }) {
      if (typeof deps.updateCalendarEvent === "function") {
        return deps.updateCalendarEvent({ accessToken, eventId, event });
      }

      const response = await axios.put(`${GOOGLE_CALENDAR_EVENTS_URL}/${eventId}`, event, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      return response.data;
    },

    async cancelCalendarEvent({ accessToken, eventId }) {
      if (typeof deps.cancelCalendarEvent === "function") {
        return deps.cancelCalendarEvent({ accessToken, eventId });
      }

      await axios.delete(`${GOOGLE_CALENDAR_EVENTS_URL}/${eventId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      return { id: eventId, status: "cancelled" };
    },
  };
}

function assertGoogleConfigReady() {
  if (!getGoogleClientId()) {
    throw buildConfigError("Missing environment variables: GOOGLE_CLIENT_ID");
  }

  if (!getGoogleClientSecret()) {
    throw buildConfigError("Missing environment variables: GOOGLE_CLIENT_SECRET");
  }

  if (!getGoogleOAuthRedirectUri()) {
    throw buildConfigError("Missing environment variables: GOOGLE_OAUTH_REDIRECT_URI");
  }

  if (!getGoogleTokenEncryptionSecret()) {
    throw buildConfigError("Missing environment variables: GOOGLE_TOKEN_ENCRYPTION_SECRET");
  }
}

function isGoogleConfigReady() {
  return Boolean(
    getGoogleClientId()
    && getGoogleClientSecret()
    && getGoogleOAuthRedirectUri()
    && getGoogleTokenEncryptionSecret()
  );
}

function buildGoogleAuthUrl({ stateToken, scopes, redirectUri }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", getGoogleClientId());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", stateToken);
  return url.toString();
}

function mapConnectedAccountRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: cleanText(row.id),
    agentId: cleanText(row.agent_id),
    businessId: cleanText(row.business_id),
    ownerUserId: cleanText(row.owner_user_id),
    provider: cleanText(row.provider) || "google",
    providerAccountId: cleanText(row.provider_account_id),
    accountEmail: cleanText(row.account_email).toLowerCase(),
    displayName: cleanText(row.display_name),
    selectedMailbox: cleanText(row.selected_mailbox) || MAILBOX_FALLBACK,
    scopes: normalizeArray(row.scopes),
    scopeAudit: Array.isArray(row.scope_audit) ? row.scope_audit : [],
    status: cleanText(row.status) || "pending",
    accessTokenEncrypted: cleanText(row.access_token_encrypted),
    refreshTokenEncrypted: cleanText(row.refresh_token_encrypted),
    tokenExpiresAt: row.token_expires_at || null,
    lastRefreshedAt: row.last_refreshed_at || null,
    lastSyncAt: row.last_sync_at || null,
    lastError: cleanText(row.last_error),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapInboxThreadRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: cleanText(row.id),
    connectedAccountId: cleanText(row.connected_account_id),
    agentId: cleanText(row.agent_id),
    businessId: cleanText(row.business_id),
    ownerUserId: cleanText(row.owner_user_id),
    providerThreadId: cleanText(row.provider_thread_id),
    providerHistoryId: cleanText(row.provider_history_id),
    mailboxLabel: cleanText(row.mailbox_label),
    subject: cleanText(row.subject),
    snippet: cleanText(row.snippet),
    classification: cleanText(row.classification) || "follow_up_needed",
    priority: cleanText(row.priority) || "normal",
    status: cleanText(row.status) || "open",
    complaintState: cleanText(row.complaint_state) || "none",
    followUpState: cleanText(row.follow_up_state) || "open",
    needsReply: row.needs_reply === true,
    riskLevel: cleanText(row.risk_level) || "normal",
    unreadCount: Number(row.unread_count || 0) || 0,
    participants: Array.isArray(row.participants) ? row.participants : [],
    contactId: cleanText(row.contact_id),
    relatedLeadId: cleanText(row.related_lead_id),
    relatedFollowUpId: cleanText(row.related_follow_up_id),
    relatedActionKey: cleanText(row.related_action_key),
    lastMessageAt: row.last_message_at || null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapInboxMessageRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: cleanText(row.id),
    threadId: cleanText(row.thread_id),
    connectedAccountId: cleanText(row.connected_account_id),
    agentId: cleanText(row.agent_id),
    businessId: cleanText(row.business_id),
    ownerUserId: cleanText(row.owner_user_id),
    providerMessageId: cleanText(row.provider_message_id),
    direction: cleanText(row.direction) || "inbound",
    approvalStatus: cleanText(row.approval_status) || "not_required",
    messageState: cleanText(row.message_state) || "stored",
    sender: cleanText(row.sender),
    recipients: normalizeArray(row.recipients),
    cc: normalizeArray(row.cc),
    subject: cleanText(row.subject),
    bodyPreview: cleanText(row.body_preview),
    bodyText: cleanText(row.body_text),
    sentAt: row.sent_at || null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapCalendarEventRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: cleanText(row.id),
    connectedAccountId: cleanText(row.connected_account_id),
    agentId: cleanText(row.agent_id),
    businessId: cleanText(row.business_id),
    ownerUserId: cleanText(row.owner_user_id),
    providerEventId: cleanText(row.provider_event_id),
    actionType: cleanText(row.action_type) || "view",
    sourceKind: cleanText(row.source_kind) || "google_sync",
    status: cleanText(row.status) || "confirmed",
    approvalStatus: cleanText(row.approval_status) || "synced",
    title: cleanText(row.title),
    description: cleanText(row.description),
    attendeeEmails: normalizeArray(row.attendee_emails),
    startAt: row.start_at || null,
    endAt: row.end_at || null,
    timezone: cleanText(row.timezone),
    location: cleanText(row.location),
    contactId: cleanText(row.contact_id),
    leadId: cleanText(row.lead_id),
    relatedActionKey: cleanText(row.related_action_key),
    conflictState: cleanText(row.conflict_state) || "clear",
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapCampaignRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: cleanText(row.id),
    agentId: cleanText(row.agent_id),
    businessId: cleanText(row.business_id),
    ownerUserId: cleanText(row.owner_user_id),
    goal: cleanText(row.goal),
    title: cleanText(row.title),
    status: cleanText(row.status) || "draft",
    approvalStatus: cleanText(row.approval_status) || "draft",
    recipientSource: cleanText(row.recipient_source) || "captured_leads",
    sourceFilters: row.source_filters && typeof row.source_filters === "object" ? row.source_filters : {},
    scheduleConfig: row.schedule_config && typeof row.schedule_config === "object" ? row.schedule_config : {},
    sequenceSummary: cleanText(row.sequence_summary),
    replyHandlingMode: cleanText(row.reply_handling_mode) || "manual_review",
    approvedAt: row.approved_at || null,
    activatedAt: row.activated_at || null,
    lastError: cleanText(row.last_error),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapCampaignStepRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: cleanText(row.id),
    campaignId: cleanText(row.campaign_id),
    agentId: cleanText(row.agent_id),
    ownerUserId: cleanText(row.owner_user_id),
    stepOrder: Number(row.step_order || 0) || 0,
    channel: cleanText(row.channel) || "email",
    timingOffsetHours: Number(row.timing_offset_hours || 0) || 0,
    subject: cleanText(row.subject),
    body: cleanText(row.body),
    approvalStatus: cleanText(row.approval_status) || "pending_owner",
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}

function mapCampaignRecipientRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: cleanText(row.id),
    campaignId: cleanText(row.campaign_id),
    agentId: cleanText(row.agent_id),
    ownerUserId: cleanText(row.owner_user_id),
    contactId: cleanText(row.contact_id),
    leadId: cleanText(row.lead_id),
    personKey: cleanText(row.person_key),
    contactName: cleanText(row.contact_name),
    contactEmail: cleanText(row.contact_email).toLowerCase(),
    status: cleanText(row.status) || "pending",
    currentStepIndex: Number(row.current_step_index || 0) || 0,
    nextSendAt: row.next_send_at || null,
    lastContactedAt: row.last_contacted_at || null,
    replyState: cleanText(row.reply_state) || "awaiting_reply",
    lastThreadId: cleanText(row.last_thread_id),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}

function mapTaskRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: cleanText(row.id),
    agentId: cleanText(row.agent_id),
    ownerUserId: cleanText(row.owner_user_id),
    sourceType: cleanText(row.source_type),
    sourceId: cleanText(row.source_id),
    taskType: cleanText(row.task_type),
    title: cleanText(row.title),
    description: cleanText(row.description),
    status: cleanText(row.status) || "open",
    priority: cleanText(row.priority) || "normal",
    approvalRequired: row.approval_required === true,
    contactId: cleanText(row.contact_id),
    relatedThreadId: cleanText(row.related_thread_id),
    relatedEventId: cleanText(row.related_event_id),
    relatedCampaignId: cleanText(row.related_campaign_id),
    relatedLeadId: cleanText(row.related_lead_id),
    relatedActionKey: cleanText(row.related_action_key),
    taskState: row.task_state && typeof row.task_state === "object" ? row.task_state : {},
    resolvedAt: row.resolved_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

export function classifyInboxThread(thread = {}) {
  const text = cleanText([
    thread.subject,
    thread.snippet,
    ...(Array.isArray(thread.messages)
      ? thread.messages.map((message) => [message.subject, message.bodyText, message.bodyPreview].join(" "))
      : []),
  ].join(" ")).toLowerCase();

  if (
    /(complaint|refund|frustrated|angry|terrible|awful|disappointed|unhappy|bad service|very upset)/i.test(text)
  ) {
    return "complaint";
  }

  if (/(invoice|billing|charge|charged|payment|receipt|card|subscription)/i.test(text)) {
    return "billing";
  }

  if (/(support|problem|issue|broken|not working|error|help me|late|cancel my order)/i.test(text)) {
    return "support";
  }

  if (/(quote|pricing|book|booking|schedule|availability|demo|estimate|service|proposal|interested)/i.test(text)) {
    return "lead_sales";
  }

  return "follow_up_needed";
}

function getComplaintState(classification) {
  if (classification === "complaint") {
    return "open";
  }

  if (classification === "support") {
    return "active";
  }

  return "none";
}

function getPriority(classification, lastMessageAt) {
  if (classification === "complaint") {
    return "high";
  }

  if (classification === "support" || !isWithinHours(lastMessageAt, STALE_REPLY_WINDOW_HOURS)) {
    return "medium";
  }

  return "normal";
}

function getRiskLevel({ classification, needsReply, lastMessageAt }) {
  if (classification === "complaint") {
    return "high";
  }

  if (needsReply && !isWithinHours(lastMessageAt, STALE_REPLY_WINDOW_HOURS)) {
    return "high";
  }

  if (needsReply || classification === "support") {
    return "medium";
  }

  return "normal";
}

function escapeMime(value) {
  return String(value || "").replace(/\r?\n/g, " ").trim();
}

function toMimeRaw({ from, to, subject, body, threadId }) {
  const lines = [
    `From: ${escapeMime(from)}`,
    `To: ${escapeMime(to)}`,
    `Subject: ${escapeMime(subject)}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
  ];

  if (threadId) {
    lines.push(`References: ${escapeMime(threadId)}`);
  }

  lines.push("", body || "");
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizeEmail(value) {
  const match = cleanText(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? cleanText(match[0]).toLowerCase() : "";
}

function extractHeader(headers = [], name) {
  return cleanText(
    (headers || []).find((header) => cleanText(header?.name).toLowerCase() === name.toLowerCase())?.value
  );
}

function decodeBodyData(data = "") {
  if (!data) {
    return "";
  }

  try {
    return Buffer.from(String(data).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function stripHtml(value = "") {
  return cleanText(String(value || "").replace(/<[^>]+>/g, " "));
}

function extractBodyFromPayload(payload = {}) {
  const direct = decodeBodyData(payload.body?.data);

  if (cleanText(direct)) {
    return stripHtml(direct);
  }

  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) {
    const mimeType = cleanText(part.mimeType).toLowerCase();
    const partBody = decodeBodyData(part.body?.data);

    if (mimeType === "text/plain" && cleanText(partBody)) {
      return cleanText(partBody);
    }

    if (mimeType === "text/html" && cleanText(partBody)) {
      return stripHtml(partBody);
    }

    const nested = extractBodyFromPayload(part);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function buildNormalizedGmailThread(thread = {}, accountEmail = "") {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const normalizedMessages = messages.map((message) => {
    const headers = Array.isArray(message.payload?.headers) ? message.payload.headers : [];
    const from = extractHeader(headers, "From");
    const to = uniqueText(extractHeader(headers, "To").split(","));
    const cc = uniqueText(extractHeader(headers, "Cc").split(","));
    const subject = extractHeader(headers, "Subject");
    const sentAt = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null;
    const senderEmail = normalizeEmail(from);
    const accountEmailNormalized = normalizeEmail(accountEmail);
    const direction = senderEmail && accountEmailNormalized && senderEmail === accountEmailNormalized
      ? "outbound"
      : "inbound";

    return {
      providerMessageId: cleanText(message.id),
      subject,
      sender: from,
      senderEmail,
      recipients: to.map(normalizeEmail).filter(Boolean),
      cc: cc.map(normalizeEmail).filter(Boolean),
      bodyText: extractBodyFromPayload(message.payload || {}),
      bodyPreview: cleanText(message.snippet),
      direction,
      sentAt,
    };
  });

  const orderedMessages = normalizedMessages
    .slice()
    .sort((left, right) => parseTimestamp(left.sentAt) - parseTimestamp(right.sentAt));
  const lastMessage = orderedMessages[orderedMessages.length - 1] || null;
  const unreadCount = normalizedMessages.filter((message) => message.direction === "inbound").length;
  const participants = uniqueText(
    normalizedMessages.flatMap((message) => [message.sender, ...message.recipients, ...message.cc])
  );

  return {
    providerThreadId: cleanText(thread.id),
    providerHistoryId: cleanText(thread.historyId),
    subject: lastMessage?.subject || cleanText(thread.snippet),
    snippet: cleanText(thread.snippet),
    lastMessageAt: lastMessage?.sentAt || null,
    participants,
    unreadCount,
    messages: orderedMessages,
  };
}

function matchLeadForThread(leads = [], thread = {}) {
  const emails = uniqueText(
    (thread.messages || []).flatMap((message) => [message.senderEmail, ...(message.recipients || [])])
      .map(normalizeEmail)
  );

  return leads.find((lead) => {
    const contactEmail = normalizeEmail(lead.contactEmail);
    return contactEmail && emails.includes(contactEmail);
  }) || null;
}

function getThreadContactEmails(thread = {}) {
  return uniqueText(
    (thread.messages || []).flatMap((message) => [
      message.senderEmail,
      ...(message.recipients || []),
      ...(message.cc || []),
    ]).concat(thread.participants || []).map(normalizeEmail)
  );
}

function getLatestInboundMessage(thread = {}) {
  return (thread.messages || [])
    .slice()
    .reverse()
    .find((message) => cleanText(message.direction) === "inbound") || null;
}

function findCampaignRecipientForThread(campaigns = [], thread = {}) {
  const emails = new Set(getThreadContactEmails(thread));

  if (!emails.size) {
    return { campaign: null, recipient: null };
  }

  for (const campaign of campaigns) {
    for (const recipient of campaign.recipients || []) {
      if (!emails.has(normalizeEmail(recipient.contactEmail))) {
        continue;
      }

      return { campaign, recipient };
    }
  }

  return { campaign: null, recipient: null };
}

function buildComplaintTask(thread, lead) {
  if (!thread || !["complaint", "support"].includes(thread.classification)) {
    return null;
  }

  return {
    sourceType: "inbox_thread",
    sourceId: thread.providerThreadId,
    taskType: thread.classification === "complaint" ? "complaint_queue" : "support_follow_up",
    title: thread.classification === "complaint"
      ? `Complaint needs review: ${thread.subject || "Inbox thread"}`
      : `Support reply needed: ${thread.subject || "Inbox thread"}`,
    description: thread.snippet || "A connected inbox thread needs owner attention.",
    status: "open",
    priority: thread.classification === "complaint" ? "high" : "medium",
    approvalRequired: true,
    relatedThreadId: thread.id || null,
    relatedLeadId: lead?.id || null,
    relatedActionKey: cleanText(lead?.latestActionKey) || cleanText(thread.relatedActionKey),
    taskState: {
      complaintState: thread.complaintState,
      classification: thread.classification,
      riskLevel: thread.riskLevel,
    },
  };
}

function buildFollowUpTask(thread, lead) {
  if (!thread || thread.classification !== "lead_sales" || !thread.needsReply) {
    return null;
  }

  return {
    sourceType: "inbox_thread",
    sourceId: `${thread.providerThreadId}:lead_follow_up`,
    taskType: "lead_inbox_follow_up",
    title: `Lead reply needed: ${thread.subject || "Inbox thread"}`,
    description: thread.snippet || "A sales or booking thread may go cold without a reply.",
    status: "open",
    priority: thread.riskLevel === "high" ? "high" : "medium",
    approvalRequired: true,
    relatedThreadId: thread.id || null,
    relatedLeadId: lead?.id || null,
    relatedActionKey: cleanText(lead?.latestActionKey) || cleanText(thread.relatedActionKey),
    taskState: {
      classification: thread.classification,
      riskLevel: thread.riskLevel,
    },
  };
}

async function writeAuditLog(supabase, payload = {}) {
  const { error } = await supabase.from(CONNECTED_ACCOUNT_AUDIT_TABLE).insert({
    agent_id: payload.agentId || null,
    business_id: payload.businessId || null,
    owner_user_id: payload.ownerUserId || null,
    connected_account_id: payload.connectedAccountId || null,
    actor_type: cleanText(payload.actorType) || "system",
    actor_id: cleanText(payload.actorId) || null,
    action_type: cleanText(payload.actionType) || "unknown",
    target_type: cleanText(payload.targetType) || "unknown",
    target_id: cleanText(payload.targetId) || null,
    details: payload.details && typeof payload.details === "object" ? payload.details : {},
  });

  if (error && !isMissingRelationError(error, CONNECTED_ACCOUNT_AUDIT_TABLE)) {
    console.error("[operator audit] Failed to persist audit log:", error);
  }
}

async function listConnectedAccountsInternal(supabase, { agentId, ownerUserId }) {
  const { data, error } = await supabase
    .from(CONNECTED_ACCOUNT_TABLE)
    .select(CONNECTED_ACCOUNT_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingRelationError(error, CONNECTED_ACCOUNT_TABLE)) {
      return [];
    }

    throw error;
  }

  return (data || []).map(mapConnectedAccountRow);
}

export async function listConnectedAccounts(supabase, options = {}) {
  return listConnectedAccountsInternal(supabase, {
    agentId: cleanText(options.agentId),
    ownerUserId: cleanText(options.ownerUserId),
  });
}

async function getPrimaryConnectedAccount(supabase, { agentId, ownerUserId }) {
  const accounts = await listConnectedAccountsInternal(supabase, { agentId, ownerUserId });
  return accounts.find((account) => account.status === "connected") || accounts[0] || null;
}

async function getOAuthStateRecord(supabase, stateToken) {
  const tokenHash = hashToken(stateToken);
  const { data, error } = await supabase
    .from(GOOGLE_OAUTH_STATE_TABLE)
    .select("*")
    .eq("state_token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function ensureFreshGoogleAccessToken(supabase, account, deps = {}) {
  const googleApi = buildGoogleApi(deps);
  const encryptionSecret = getGoogleTokenEncryptionSecret();
  const tokenExpiresSoon = !account.tokenExpiresAt || parseTimestamp(account.tokenExpiresAt) <= Date.now() + 2 * 60 * 1000;

  if (!tokenExpiresSoon) {
    return decryptSecret(account.accessTokenEncrypted, encryptionSecret);
  }

  const refreshToken = decryptSecret(account.refreshTokenEncrypted, encryptionSecret);

  if (!refreshToken) {
    const error = new Error("Google connection needs to be reconnected before it can sync again.");
    error.statusCode = 409;
    throw error;
  }

  const refreshed = await googleApi.refreshAccessToken({ refreshToken });
  const nextAccessToken = cleanText(refreshed.access_token);
  const nextExpiry = new Date(Date.now() + (Number(refreshed.expires_in || 3600) * 1000)).toISOString();

  const { data, error } = await supabase
    .from(CONNECTED_ACCOUNT_TABLE)
    .update({
      access_token_encrypted: encryptSecret(nextAccessToken, encryptionSecret),
      refresh_token_encrypted: account.refreshTokenEncrypted,
      token_expires_at: nextExpiry,
      last_refreshed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "connected",
      last_error: null,
    })
    .eq("id", account.id)
    .select(CONNECTED_ACCOUNT_SELECT)
    .single();

  if (error) {
    throw error;
  }

  await writeAuditLog(supabase, {
    agentId: account.agentId,
    businessId: account.businessId,
    ownerUserId: account.ownerUserId,
    connectedAccountId: account.id,
    actorType: "system",
    actionType: "google_token_refreshed",
    targetType: "connected_account",
    targetId: account.id,
    details: {
      accountEmail: account.accountEmail,
      expiresAt: nextExpiry,
    },
  });

  return decryptSecret(mapConnectedAccountRow(data).accessTokenEncrypted, encryptionSecret);
}

export async function createGoogleConnectionStart(supabase, options = {}) {
  assertGoogleConfigReady();
  const agent = options.agent || {};
  const ownerUserId = cleanText(options.ownerUserId);
  const redirectPath = cleanText(options.redirectPath || "/dashboard");
  const selectedMailbox = cleanText(options.selectedMailbox) || MAILBOX_FALLBACK;

  if (!cleanText(agent.id) || !ownerUserId) {
    const error = new Error("agent and owner_user_id are required");
    error.statusCode = 400;
    throw error;
  }

  const scopes = uniqueText(options.scopes?.length ? options.scopes : GOOGLE_OPERATOR_SCOPES);
  const stateToken = randomBytes(24).toString("base64url");
  const stateHash = hashToken(stateToken);
  const redirectUri = getGoogleOAuthRedirectUri();

  const { error } = await supabase.from(GOOGLE_OAUTH_STATE_TABLE).insert({
    agent_id: agent.id,
    business_id: agent.businessId || null,
    owner_user_id: ownerUserId,
    provider: "google",
    requested_scopes: scopes,
    redirect_path: redirectPath,
    selected_mailbox: selectedMailbox,
    state_token_hash: stateHash,
    status: "pending",
    expires_at: new Date(Date.now() + (15 * 60 * 1000)).toISOString(),
    metadata: {
      accountType: "google_workspace",
    },
  });

  if (error) {
    throw error;
  }

  const authUrl = buildGoogleAuthUrl({
    stateToken,
    scopes,
    redirectUri,
  });

  await writeAuditLog(supabase, {
    agentId: agent.id,
    businessId: agent.businessId,
    ownerUserId,
    actorType: "owner",
    actorId: ownerUserId,
    actionType: "google_connection_started",
    targetType: "google_oauth_state",
    targetId: stateHash,
    details: {
      scopes,
      selectedMailbox,
    },
  });

  return {
    ok: true,
    authUrl,
    redirectUri,
    scopes,
    selectedMailbox,
  };
}

export async function completeGoogleConnection(supabase, options = {}, deps = {}) {
  assertGoogleConfigReady();
  const stateToken = cleanText(options.stateToken);
  const code = cleanText(options.code);
  const oauthError = cleanText(options.oauthError);
  const redirectUri = getGoogleOAuthRedirectUri();
  const googleApi = buildGoogleApi(deps);

  if (!stateToken) {
    const error = new Error("Missing Google OAuth state.");
    error.statusCode = 400;
    throw error;
  }

  const stateRecord = await getOAuthStateRecord(supabase, stateToken);

  if (!stateRecord) {
    const error = new Error("Google connection state was not found or has expired.");
    error.statusCode = 404;
    throw error;
  }

  const redirectPath = cleanText(stateRecord.redirect_path || "/dashboard");

  if (oauthError) {
    await supabase
      .from(GOOGLE_OAUTH_STATE_TABLE)
      .update({
        status: "failed",
        updated_at: new Date().toISOString(),
        metadata: {
          ...(stateRecord.metadata && typeof stateRecord.metadata === "object" ? stateRecord.metadata : {}),
          oauthError,
        },
      })
      .eq("id", stateRecord.id);

    return {
      redirectUrl: `${redirectPath}${redirectPath.includes("?") ? "&" : "?"}google=error&reason=${encodeURIComponent(oauthError)}`,
    };
  }

  if (!code) {
    const error = new Error("Missing Google authorization code.");
    error.statusCode = 400;
    throw error;
  }

  if (parseTimestamp(stateRecord.expires_at) < Date.now()) {
    const error = new Error("Google connection request expired. Please try again.");
    error.statusCode = 410;
    throw error;
  }

  const tokenResponse = await googleApi.exchangeCode({
    code,
    redirectUri,
  });
  const userInfo = await googleApi.getUserInfo({
    accessToken: cleanText(tokenResponse.access_token),
  });
  const encryptionSecret = getGoogleTokenEncryptionSecret();
  const scopes = uniqueText(cleanText(tokenResponse.scope).split(" "));
  const existing = await getPrimaryConnectedAccount(supabase, {
    agentId: cleanText(stateRecord.agent_id),
    ownerUserId: cleanText(stateRecord.owner_user_id),
  });
  const accountPayload = {
    agent_id: stateRecord.agent_id,
    business_id: stateRecord.business_id,
    owner_user_id: stateRecord.owner_user_id,
    provider: "google",
    provider_account_id: cleanText(userInfo.sub),
    account_email: normalizeEmail(userInfo.email),
    display_name: cleanText(userInfo.name || userInfo.given_name || userInfo.email),
    selected_mailbox: cleanText(stateRecord.selected_mailbox) || MAILBOX_FALLBACK,
    scopes,
    scope_audit: scopes.map((scope) => ({
      scope,
      grantedAt: new Date().toISOString(),
    })),
    status: "connected",
    access_token_encrypted: encryptSecret(cleanText(tokenResponse.access_token), encryptionSecret),
    refresh_token_encrypted: encryptSecret(cleanText(tokenResponse.refresh_token), encryptionSecret),
    token_expires_at: new Date(Date.now() + (Number(tokenResponse.expires_in || 3600) * 1000)).toISOString(),
    last_refreshed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_error: null,
    metadata: {
      locale: cleanText(userInfo.locale),
      emailVerified: userInfo.email_verified === true,
    },
  };

  let accountRow = null;

  if (existing?.id) {
    const { data, error } = await supabase
      .from(CONNECTED_ACCOUNT_TABLE)
      .update(accountPayload)
      .eq("id", existing.id)
      .select(CONNECTED_ACCOUNT_SELECT)
      .single();

    if (error) {
      throw error;
    }

    accountRow = data;
  } else {
    const { data, error } = await supabase
      .from(CONNECTED_ACCOUNT_TABLE)
      .insert(accountPayload)
      .select(CONNECTED_ACCOUNT_SELECT)
      .single();

    if (error) {
      throw error;
    }

    accountRow = data;
  }

  await supabase
    .from(GOOGLE_OAUTH_STATE_TABLE)
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", stateRecord.id);

  const connectedAccount = mapConnectedAccountRow(accountRow);
  await writeAuditLog(supabase, {
    agentId: connectedAccount.agentId,
    businessId: connectedAccount.businessId,
    ownerUserId: connectedAccount.ownerUserId,
    connectedAccountId: connectedAccount.id,
    actorType: "google_callback",
    actorId: connectedAccount.accountEmail,
    actionType: "google_connection_completed",
    targetType: "connected_account",
    targetId: connectedAccount.id,
    details: {
      scopes,
      selectedMailbox: connectedAccount.selectedMailbox,
      accountEmail: connectedAccount.accountEmail,
    },
  });

  await patchOperatorActivationState(supabase, {
    agent,
    ownerUserId: connectedAccount.ownerUserId,
    changes: {
      operatorWorkspaceEnabled: true,
      googleConnected: true,
      metadata: {
        googleConnectedAt: new Date().toISOString(),
        selectedMailbox: connectedAccount.selectedMailbox || MAILBOX_FALLBACK,
        grantedScopes: connectedAccount.scopes || [],
      },
    },
  });

  return {
    connectedAccount,
    redirectUrl: `${redirectPath}${redirectPath.includes("?") ? "&" : "?"}google=connected`,
  };
}

async function upsertInboxThread(supabase, payload) {
  const existingQuery = await supabase
    .from(OPERATOR_INBOX_THREAD_TABLE)
    .select(INBOX_THREAD_SELECT)
    .eq("connected_account_id", payload.connected_account_id)
    .eq("provider_thread_id", payload.provider_thread_id)
    .maybeSingle();

  if (existingQuery.error && !isMissingRelationError(existingQuery.error, OPERATOR_INBOX_THREAD_TABLE)) {
    throw existingQuery.error;
  }

  if (existingQuery.data?.id) {
    const { data, error } = await supabase
      .from(OPERATOR_INBOX_THREAD_TABLE)
      .update({
        ...payload,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingQuery.data.id)
      .select(INBOX_THREAD_SELECT)
      .single();

    if (error) {
      throw error;
    }

    return mapInboxThreadRow(data);
  }

  const { data, error } = await supabase
    .from(OPERATOR_INBOX_THREAD_TABLE)
    .insert(payload)
    .select(INBOX_THREAD_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return mapInboxThreadRow(data);
}

async function upsertInboxMessage(supabase, payload) {
  const existingQuery = await supabase
    .from(OPERATOR_INBOX_MESSAGE_TABLE)
    .select(INBOX_MESSAGE_SELECT)
    .eq("connected_account_id", payload.connected_account_id)
    .eq("provider_message_id", payload.provider_message_id)
    .maybeSingle();

  if (existingQuery.error && !isMissingRelationError(existingQuery.error, OPERATOR_INBOX_MESSAGE_TABLE)) {
    throw existingQuery.error;
  }

  if (existingQuery.data?.id) {
    const { data, error } = await supabase
      .from(OPERATOR_INBOX_MESSAGE_TABLE)
      .update({
        ...payload,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingQuery.data.id)
      .select(INBOX_MESSAGE_SELECT)
      .single();

    if (error) {
      throw error;
    }

    return mapInboxMessageRow(data);
  }

  const { data, error } = await supabase
    .from(OPERATOR_INBOX_MESSAGE_TABLE)
    .insert(payload)
    .select(INBOX_MESSAGE_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return mapInboxMessageRow(data);
}

async function upsertCalendarEvent(supabase, payload) {
  if (payload.provider_event_id) {
    const existingQuery = await supabase
      .from(OPERATOR_CALENDAR_EVENT_TABLE)
      .select(CALENDAR_EVENT_SELECT)
      .eq("connected_account_id", payload.connected_account_id)
      .eq("provider_event_id", payload.provider_event_id)
      .maybeSingle();

    if (existingQuery.error && !isMissingRelationError(existingQuery.error, OPERATOR_CALENDAR_EVENT_TABLE)) {
      throw existingQuery.error;
    }

    if (existingQuery.data?.id) {
      const { data, error } = await supabase
        .from(OPERATOR_CALENDAR_EVENT_TABLE)
        .update({
          ...payload,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingQuery.data.id)
        .select(CALENDAR_EVENT_SELECT)
        .single();

      if (error) {
        throw error;
      }

      return mapCalendarEventRow(data);
    }
  }

  const { data, error } = await supabase
    .from(OPERATOR_CALENDAR_EVENT_TABLE)
    .insert(payload)
    .select(CALENDAR_EVENT_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return mapCalendarEventRow(data);
}

async function upsertOperatorTask(supabase, agent, ownerUserId, payload = {}) {
  if (!payload.sourceType || !payload.sourceId || !payload.taskType) {
    return null;
  }

  const existingQuery = await supabase
    .from(OPERATOR_TASK_TABLE)
    .select(TASK_SELECT)
    .eq("agent_id", agent.id)
    .eq("owner_user_id", ownerUserId)
    .eq("source_type", payload.sourceType)
    .eq("source_id", payload.sourceId)
    .eq("task_type", payload.taskType)
    .maybeSingle();

  if (existingQuery.error && !isMissingRelationError(existingQuery.error, OPERATOR_TASK_TABLE)) {
    throw existingQuery.error;
  }

  const rowPayload = {
    agent_id: agent.id,
    business_id: agent.businessId || null,
    owner_user_id: ownerUserId,
    source_type: payload.sourceType,
    source_id: payload.sourceId,
    task_type: payload.taskType,
    title: payload.title,
    description: payload.description || null,
    status: payload.status || "open",
    priority: payload.priority || "normal",
    approval_required: payload.approvalRequired === true,
    related_thread_id: payload.relatedThreadId || null,
    related_event_id: payload.relatedEventId || null,
    related_campaign_id: payload.relatedCampaignId || null,
    related_lead_id: payload.relatedLeadId || null,
    related_action_key: payload.relatedActionKey || null,
    task_state: payload.taskState || {},
    resolved_at: payload.status === "resolved" ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };

  if (existingQuery.data?.id) {
    const { data, error } = await supabase
      .from(OPERATOR_TASK_TABLE)
      .update(rowPayload)
      .eq("id", existingQuery.data.id)
      .select(TASK_SELECT)
      .single();

    if (error) {
      throw error;
    }

    return mapTaskRow(data);
  }

  const { data, error } = await supabase
    .from(OPERATOR_TASK_TABLE)
    .insert(rowPayload)
    .select(TASK_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return mapTaskRow(data);
}

function buildReplySubject(thread, businessName) {
  if (thread.classification === "complaint") {
    return `Re: We’re sorry about your experience with ${businessName || "our business"}`;
  }

  if (thread.classification === "support") {
    return `Re: Helping with your request for ${businessName || "our business"}`;
  }

  if (thread.classification === "billing") {
    return `Re: Billing follow-up from ${businessName || "our business"}`;
  }

  if (thread.classification === "lead_sales") {
    return `Re: Next steps with ${businessName || "our business"}`;
  }

  return `Re: Following up from ${businessName || "our business"}`;
}

export function buildReplyDraft(thread = {}, options = {}) {
  const businessName = cleanText(options.businessName) || "our business";
  const senderName = cleanText(options.senderName) || businessName;
  const latestInbound = (thread.messages || [])
    .slice()
    .reverse()
    .find((message) => message.direction === "inbound");
  const firstRecipient = normalizeEmail(
    latestInbound?.senderEmail
      || latestInbound?.sender
      || (thread.participants || []).find((entry) => normalizeEmail(entry))
  );
  const greetingName = cleanText(
    latestInbound?.sender?.split("<")[0]
      || firstRecipient.split("@")[0]
  );
  const greeting = greetingName ? `Hi ${greetingName},` : "Hi,";
  let body = "";

  switch (thread.classification) {
    case "complaint":
      body = [
        greeting,
        "",
        `Thanks for flagging this. I’m sorry you had a frustrating experience with ${businessName}.`,
        "I’ve reviewed your note and prepared the next step so we can resolve it quickly.",
        "If you can confirm the best callback or reply window, we’ll follow up directly and make this right.",
        "",
        `Best,`,
        senderName,
      ].join("\n");
      break;
    case "support":
      body = [
        greeting,
        "",
        `Thanks for reaching out to ${businessName}.`,
        "I reviewed your message and prepared a follow-up so we can help without losing context.",
        "If there is anything urgent we should know before we reply in full, send it here and we’ll prioritize it.",
        "",
        `Best,`,
        senderName,
      ].join("\n");
      break;
    case "billing":
      body = [
        greeting,
        "",
        `Thanks for contacting ${businessName} about billing.`,
        "I reviewed the thread and prepared the next reply so we can clarify the charge or invoice quickly.",
        "If you want, include the invoice number or the best email for billing follow-up and we’ll take it from there.",
        "",
        `Best,`,
        senderName,
      ].join("\n");
      break;
    case "lead_sales":
      body = [
        greeting,
        "",
        `Thanks for reaching out to ${businessName}.`,
        "I reviewed your message and prepared the next step so we can keep momentum moving.",
        "If you share the timing or scope you have in mind, we can line up the right next action right away.",
        "",
        `Best,`,
        senderName,
      ].join("\n");
      break;
    default:
      body = [
        greeting,
        "",
        `Thanks for your message to ${businessName}.`,
        "I reviewed the thread and prepared a reply so we can follow up clearly and on time.",
        "",
        `Best,`,
        senderName,
      ].join("\n");
      break;
  }

  return {
    to: firstRecipient,
    subject: buildReplySubject(thread, businessName),
    body,
  };
}

export function suggestCalendarSlots(events = [], options = {}) {
  const now = parseTimestamp(options.now || new Date().toISOString()) || Date.now();
  const durationMinutes = Number(options.durationMinutes || CALENDAR_SLOT_MINUTES) || CALENDAR_SLOT_MINUTES;
  const windowDays = Number(options.windowDays || SLOT_SEARCH_DAYS) || SLOT_SEARCH_DAYS;
  const startHour = Number(options.startHour || BUSINESS_START_HOUR) || BUSINESS_START_HOUR;
  const endHour = Number(options.endHour || BUSINESS_END_HOUR) || BUSINESS_END_HOUR;
  const busyEvents = (events || [])
    .filter((event) => event.status !== "cancelled")
    .map((event) => ({
      startAt: parseTimestamp(event.startAt || event.start_at),
      endAt: parseTimestamp(event.endAt || event.end_at),
    }))
    .filter((event) => event.startAt && event.endAt && event.endAt > event.startAt)
    .sort((left, right) => left.startAt - right.startAt);

  const slots = [];
  const cursorDate = new Date(now);
  cursorDate.setMinutes(0, 0, 0);

  for (let dayOffset = 0; dayOffset < windowDays; dayOffset += 1) {
    const day = new Date(cursorDate);
    day.setDate(cursorDate.getDate() + dayOffset);
    const weekday = day.getDay();

    if (weekday === 0 || weekday === 6) {
      continue;
    }

    for (let hour = startHour; hour < endHour; hour += 1) {
      const slotStart = new Date(day);
      slotStart.setHours(hour, 0, 0, 0);
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60 * 1000);

      if (slotStart.getTime() <= now) {
        continue;
      }

      const overlaps = busyEvents.some((event) =>
        slotStart.getTime() < event.endAt && slotEnd.getTime() > event.startAt
      );

      if (!overlaps) {
        slots.push({
          startAt: slotStart.toISOString(),
          endAt: slotEnd.toISOString(),
          label: slotStart.toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
        });
      }

      if (slots.length >= 6) {
        return slots;
      }
    }
  }

  return slots;
}

export function buildCalendarDailySummary(options = {}) {
  const events = Array.isArray(options.events) ? options.events : [];
  const tasks = Array.isArray(options.tasks) ? options.tasks : [];
  const slots = Array.isArray(options.slots) ? options.slots : [];
  const openComplaints = tasks.filter((task) => task.taskType === "complaint_queue" && task.status === "open").length;
  const openConflicts = tasks.filter((task) => task.taskType === "calendar_conflict" && task.status === "open").length;
  const nextEvent = events
    .filter((event) => parseTimestamp(event.startAt) >= Date.now())
    .sort((left, right) => parseTimestamp(left.startAt) - parseTimestamp(right.startAt))[0];

  if (!events.length) {
    return `No booked events are on the calendar right now. ${slots.length ? `The best open slot is ${slots[0].label}.` : "There are no open slots suggested yet."}`;
  }

  const parts = [
    `${events.length} upcoming event${events.length === 1 ? "" : "s"} are visible in the workspace.`,
  ];

  if (nextEvent?.title) {
    parts.push(`Next up: ${nextEvent.title}.`);
  }

  if (openConflicts > 0) {
    parts.push(`${openConflicts} scheduling conflict${openConflicts === 1 ? "" : "s"} need attention.`);
  }

  if (openComplaints > 0) {
    parts.push(`${openComplaints} complaint${openComplaints === 1 ? "" : "s"} still need coordinated follow-up.`);
  }

  if (slots.length) {
    parts.push(`Suggested opening: ${slots[0].label}.`);
  }

  return parts.join(" ");
}

function buildMissedBookingOpportunities(leads = [], events = []) {
  const attendeeEmails = new Set(events.flatMap((event) => normalizeArray(event.attendeeEmails)).map(normalizeEmail));
  return leads
    .filter((lead) => {
      const hasBookingSignal = ["booking", "booking_intent"].includes(cleanText(lead.latestIntentType || lead.latestActionType).toLowerCase())
        || /book|appointment|schedule|availability/i.test(cleanText(lead.captureReason));
      return hasBookingSignal && normalizeEmail(lead.contactEmail) && !attendeeEmails.has(normalizeEmail(lead.contactEmail));
    })
    .slice(0, 6)
    .map((lead) => ({
      leadId: lead.id,
      contactName: lead.contactName || lead.contactEmail,
      contactEmail: lead.contactEmail,
      relatedActionKey: lead.latestActionKey,
      reason: lead.captureReason || "Booking intent was captured, but no event is on the calendar yet.",
    }));
}

function detectCalendarConflicts(events = []) {
  const ordered = (events || [])
    .filter((event) => event.status !== "cancelled")
    .slice()
    .sort((left, right) => parseTimestamp(left.startAt) - parseTimestamp(right.startAt));
  const conflicts = [];

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];

    if (parseTimestamp(current.endAt) > parseTimestamp(next.startAt)) {
      conflicts.push({ current, next });
    }
  }

  return conflicts;
}

function buildCampaignTitle(goal) {
  switch (goal) {
    case "welcome":
      return "Welcome sequence";
    case "quote_follow_up":
      return "Quote follow-up";
    case "abandoned_lead_reengagement":
      return "Abandoned lead re-engagement";
    case "review_request":
      return "Review request";
    case "complaint_recovery":
      return "Complaint recovery";
    default:
      return "Outbound sequence";
  }
}

export function buildCampaignSequence(goal, businessName = "your business") {
  switch (goal) {
    case "welcome":
      return [
        {
          stepOrder: 0,
          timingOffsetHours: 0,
          subject: `Welcome to ${businessName}`,
          body: `Hi,\n\nThanks for connecting with ${businessName}. This first email welcomes the lead, sets expectations, and points them to the best next step.\n\nBest,\n${businessName}`,
        },
        {
          stepOrder: 1,
          timingOffsetHours: 48,
          subject: `Checking in from ${businessName}`,
          body: `Hi,\n\nI wanted to follow up and make sure you have what you need from ${businessName}. If you want to move forward, reply here and we’ll help with the next step.\n\nBest,\n${businessName}`,
        },
      ];
    case "quote_follow_up":
      return [
        {
          stepOrder: 0,
          timingOffsetHours: 0,
          subject: `Following up on your quote request`,
          body: `Hi,\n\nI wanted to follow up on your quote request with ${businessName}. If you share the last few details we need, we can get the quote moving quickly.\n\nBest,\n${businessName}`,
        },
        {
          stepOrder: 1,
          timingOffsetHours: 72,
          subject: `Still interested in a quote from ${businessName}?`,
          body: `Hi,\n\nI’m checking back in case the quote request is still active. Reply here with timing, scope, or questions and we’ll pick it up from there.\n\nBest,\n${businessName}`,
        },
      ];
    case "abandoned_lead_reengagement":
      return [
        {
          stepOrder: 0,
          timingOffsetHours: 0,
          subject: `Still exploring options with ${businessName}?`,
          body: `Hi,\n\nYou recently showed interest in ${businessName}, so I wanted to make it easy to restart the conversation. If the timing is right, reply here and we’ll help with the next step.\n\nBest,\n${businessName}`,
        },
        {
          stepOrder: 1,
          timingOffsetHours: 96,
          subject: `A quick follow-up from ${businessName}`,
          body: `Hi,\n\nI’m following up one more time in case this is still relevant. If not, no problem. If it is, reply here and we’ll keep things moving.\n\nBest,\n${businessName}`,
        },
      ];
    case "review_request":
      return [
        {
          stepOrder: 0,
          timingOffsetHours: 0,
          subject: `Could you leave a quick review for ${businessName}?`,
          body: `Hi,\n\nThanks for working with ${businessName}. If the experience was positive, we’d really appreciate a quick review.\n\nBest,\n${businessName}`,
        },
      ];
    case "complaint_recovery":
      return [
        {
          stepOrder: 0,
          timingOffsetHours: 0,
          subject: `Following up to make things right`,
          body: `Hi,\n\nI’m following up from ${businessName} because we want to make sure your concern was handled properly. Reply here if anything still needs attention and we’ll take care of it.\n\nBest,\n${businessName}`,
        },
        {
          stepOrder: 1,
          timingOffsetHours: 72,
          subject: `Checking that everything is resolved`,
          body: `Hi,\n\nI wanted to check in one more time and make sure things are resolved on your side. If anything is still open, reply here and we’ll step in.\n\nBest,\n${businessName}`,
        },
      ];
    default:
      return [];
  }
}

async function listStoredInboxThreads(supabase, { agentId, ownerUserId }) {
  const { data, error } = await supabase
    .from(OPERATOR_INBOX_THREAD_TABLE)
    .select(INBOX_THREAD_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("last_message_at", { ascending: false });

  if (error) {
    if (isMissingRelationError(error, OPERATOR_INBOX_THREAD_TABLE)) {
      return [];
    }

    throw error;
  }

  return (data || []).map(mapInboxThreadRow);
}

async function listStoredInboxMessages(supabase, { threadIds }) {
  if (!threadIds.length) {
    return [];
  }

  const { data, error } = await supabase
    .from(OPERATOR_INBOX_MESSAGE_TABLE)
    .select(INBOX_MESSAGE_SELECT)
    .in("thread_id", threadIds)
    .order("created_at", { ascending: true });

  if (error) {
    if (isMissingRelationError(error, OPERATOR_INBOX_MESSAGE_TABLE)) {
      return [];
    }

    throw error;
  }

  return (data || []).map(mapInboxMessageRow);
}

async function listStoredCalendarEvents(supabase, { agentId, ownerUserId }) {
  const { data, error } = await supabase
    .from(OPERATOR_CALENDAR_EVENT_TABLE)
    .select(CALENDAR_EVENT_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("start_at", { ascending: true });

  if (error) {
    if (isMissingRelationError(error, OPERATOR_CALENDAR_EVENT_TABLE)) {
      return [];
    }

    throw error;
  }

  return (data || []).map(mapCalendarEventRow);
}

async function listStoredTasks(supabase, { agentId, ownerUserId }) {
  const { data, error } = await supabase
    .from(OPERATOR_TASK_TABLE)
    .select(TASK_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("updated_at", { ascending: false });

  if (error) {
    if (isMissingRelationError(error, OPERATOR_TASK_TABLE)) {
      return [];
    }

    throw error;
  }

  return (data || []).map(mapTaskRow);
}

async function listStoredCampaigns(supabase, { agentId, ownerUserId }) {
  const { data: campaignRows, error: campaignError } = await supabase
    .from(OPERATOR_CAMPAIGN_TABLE)
    .select(CAMPAIGN_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("created_at", { ascending: false });

  if (campaignError) {
    if (isMissingRelationError(campaignError, OPERATOR_CAMPAIGN_TABLE)) {
      return [];
    }

    throw campaignError;
  }

  const campaigns = (campaignRows || []).map(mapCampaignRow);
  const campaignIds = campaigns.map((campaign) => campaign.id);

  if (!campaignIds.length) {
    return campaigns;
  }

  const [{ data: stepRows, error: stepError }, { data: recipientRows, error: recipientError }] = await Promise.all([
    supabase
      .from(OPERATOR_CAMPAIGN_STEP_TABLE)
      .select(CAMPAIGN_STEP_SELECT)
      .in("campaign_id", campaignIds)
      .order("step_order", { ascending: true }),
    supabase
      .from(OPERATOR_CAMPAIGN_RECIPIENT_TABLE)
      .select(CAMPAIGN_RECIPIENT_SELECT)
      .in("campaign_id", campaignIds)
      .order("created_at", { ascending: true }),
  ]);

  if (stepError && !isMissingRelationError(stepError, OPERATOR_CAMPAIGN_STEP_TABLE)) {
    throw stepError;
  }

  if (recipientError && !isMissingRelationError(recipientError, OPERATOR_CAMPAIGN_RECIPIENT_TABLE)) {
    throw recipientError;
  }

  const stepsByCampaignId = new Map();
  (stepRows || []).forEach((row) => {
    const step = mapCampaignStepRow(row);
    stepsByCampaignId.set(step.campaignId, [...(stepsByCampaignId.get(step.campaignId) || []), step]);
  });

  const recipientsByCampaignId = new Map();
  (recipientRows || []).forEach((row) => {
    const recipient = mapCampaignRecipientRow(row);
    recipientsByCampaignId.set(
      recipient.campaignId,
      [...(recipientsByCampaignId.get(recipient.campaignId) || []), recipient]
    );
  });

  return campaigns.map((campaign) => ({
    ...campaign,
    steps: stepsByCampaignId.get(campaign.id) || [],
    recipients: recipientsByCampaignId.get(campaign.id) || [],
  }));
}

export async function syncInboxWorkspace(supabase, options = {}, deps = {}) {
  const agent = options.agent || {};
  const ownerUserId = cleanText(options.ownerUserId);
  const account = options.connectedAccount || await getPrimaryConnectedAccount(supabase, {
    agentId: cleanText(agent.id),
    ownerUserId,
  });

  if (!account || account.status !== "connected") {
    return {
      connected: false,
      threads: [],
    };
  }

  const accessToken = await ensureFreshGoogleAccessToken(supabase, account, deps);
  const googleApi = buildGoogleApi(deps);
  const leadCaptureResult = await listLeadCaptures(supabase, {
    agentId: agent.id,
    ownerUserId,
  });
  const leads = leadCaptureResult.records || [];
  const campaigns = await listStoredCampaigns(supabase, {
    agentId: agent.id,
    ownerUserId,
  }).catch(() => []);
  const googleThreads = await googleApi.listInboxThreads({
    accessToken,
    mailbox: account.selectedMailbox,
    maxResults: Number(options.maxResults || DEFAULT_SYNC_RESULTS) || DEFAULT_SYNC_RESULTS,
  });
  const syncedThreads = [];

  for (const googleThread of googleThreads) {
    const normalizedThread = buildNormalizedGmailThread(googleThread, account.accountEmail);
    const relatedLead = matchLeadForThread(leads, normalizedThread);
    const { campaign: relatedCampaign, recipient: relatedRecipient } = findCampaignRecipientForThread(campaigns, normalizedThread);
    const latestInbound = getLatestInboundMessage(normalizedThread);
    const classification = classifyInboxThread(normalizedThread);
    const needsReply = (normalizedThread.messages || []).length
      ? normalizedThread.messages[normalizedThread.messages.length - 1].direction === "inbound"
      : false;
    const thread = await upsertInboxThread(supabase, {
      connected_account_id: account.id,
      agent_id: agent.id,
      business_id: agent.businessId || null,
      owner_user_id: ownerUserId,
      provider_thread_id: normalizedThread.providerThreadId,
      provider_history_id: normalizedThread.providerHistoryId || null,
      mailbox_label: account.selectedMailbox,
      subject: normalizedThread.subject || null,
      snippet: normalizedThread.snippet || null,
      classification,
      priority: getPriority(classification, normalizedThread.lastMessageAt),
      status: needsReply ? "open" : "waiting",
      complaint_state: getComplaintState(classification),
      follow_up_state: needsReply ? "open" : "waiting",
      needs_reply: needsReply,
      risk_level: getRiskLevel({
        classification,
        needsReply,
        lastMessageAt: normalizedThread.lastMessageAt,
      }),
      unread_count: normalizedThread.unreadCount,
      participants: normalizedThread.participants,
      contact_id: relatedLead?.contactId || relatedRecipient?.contactId || null,
      related_lead_id: relatedLead?.id || null,
      related_follow_up_id: relatedLead?.relatedFollowUpId || null,
      related_action_key: relatedLead?.latestActionKey || null,
      last_message_at: normalizedThread.lastMessageAt || null,
      metadata: {
        source: "gmail_sync",
      },
    });

    for (const message of normalizedThread.messages) {
      await upsertInboxMessage(supabase, {
        thread_id: thread.id,
        connected_account_id: account.id,
        agent_id: agent.id,
        business_id: agent.businessId || null,
        owner_user_id: ownerUserId,
        provider_message_id: message.providerMessageId,
        direction: message.direction,
        approval_status: "not_required",
        message_state: "stored",
        sender: message.sender || null,
        recipients: message.recipients || [],
        cc: message.cc || [],
        subject: message.subject || null,
        body_preview: message.bodyPreview || null,
        body_text: message.bodyText || null,
        sent_at: message.sentAt || null,
        metadata: {},
      });
    }

    const complaintTask = buildComplaintTask(thread, relatedLead);
    if (complaintTask) {
      const task = await upsertOperatorTask(supabase, agent, ownerUserId, complaintTask);

      await recordOutcomeEvent(supabase, {
        agentId: agent.id,
        businessId: agent.businessId,
        ownerUserId,
        outcomeType: "complaint_opened",
        sourceType: "inbox_thread",
        confirmationLevel: "confirmed",
        contactId: thread.contactId || relatedLead?.contactId || relatedRecipient?.contactId || "",
        leadId: relatedLead?.id || "",
        followUpId: thread.relatedFollowUpId || relatedLead?.relatedFollowUpId || "",
        actionKey: thread.relatedActionKey || relatedLead?.latestActionKey || "",
        inboxThreadId: thread.id,
        operatorTaskId: task?.id || "",
        pageUrl: "",
        occurredAt: thread.lastMessageAt || new Date().toISOString(),
        dedupeKey: [
          agent.id,
          thread.id,
          "complaint_opened",
        ].join("::"),
        sourceRecordType: "operator_inbox_thread",
        sourceRecordId: thread.id,
        metadata: {
          classification,
        },
      });

      if (task?.relatedActionKey) {
        try {
          await updateActionQueueStatus(supabase, {
            agentId: agent.id,
            ownerUserId,
            actionKey: task.relatedActionKey,
            status: "reviewed",
            followUpNeeded: true,
            note: "Connected inbox complaint/support thread needs operator review.",
          });
        } catch (error) {
          console.warn("[operator] Could not sync complaint state to action queue:", error.message);
        }
      }
    }

    const followUpTask = buildFollowUpTask(thread, relatedLead);
    if (followUpTask) {
      await upsertOperatorTask(supabase, agent, ownerUserId, followUpTask);
    }

    if (needsReply && thread.relatedFollowUpId) {
      await recordOutcomeEvent(supabase, {
        agentId: agent.id,
        businessId: agent.businessId,
        ownerUserId,
        outcomeType: "follow_up_replied",
        sourceType: "inbox_thread",
        confirmationLevel: "confirmed",
        contactId: thread.contactId || relatedLead?.contactId || relatedRecipient?.contactId || "",
        leadId: relatedLead?.id || "",
        followUpId: thread.relatedFollowUpId,
        actionKey: thread.relatedActionKey || relatedLead?.latestActionKey || "",
        inboxThreadId: thread.id,
        occurredAt: latestInbound?.sentAt || thread.lastMessageAt || new Date().toISOString(),
        dedupeKey: [
          agent.id,
          thread.id,
          thread.relatedFollowUpId,
          "follow_up_replied",
        ].join("::"),
        attributionPath: "follow_up_assisted",
        sourceRecordType: "operator_inbox_thread",
        sourceRecordId: thread.id,
      });
    }

    if (needsReply && relatedCampaign?.id && relatedRecipient?.id) {
      const { error: campaignRecipientError } = await supabase
        .from(OPERATOR_CAMPAIGN_RECIPIENT_TABLE)
        .update({
          reply_state: "replied",
          last_thread_id: thread.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", relatedRecipient.id);

      if (campaignRecipientError && !isMissingRelationError(campaignRecipientError, OPERATOR_CAMPAIGN_RECIPIENT_TABLE)) {
        throw campaignRecipientError;
      }

      await recordOutcomeEvent(supabase, {
        agentId: agent.id,
        businessId: agent.businessId,
        ownerUserId,
        outcomeType: "campaign_replied",
        sourceType: "campaign",
        confirmationLevel: "confirmed",
        contactId: relatedRecipient.contactId || thread.contactId || relatedLead?.contactId || "",
        leadId: relatedRecipient.leadId || relatedLead?.id || "",
        actionKey: thread.relatedActionKey || relatedLead?.latestActionKey || cleanText(relatedRecipient.metadata?.latestActionKey),
        inboxThreadId: thread.id,
        campaignId: relatedCampaign.id,
        campaignRecipientId: relatedRecipient.id,
        occurredAt: latestInbound?.sentAt || thread.lastMessageAt || new Date().toISOString(),
        dedupeKey: [
          agent.id,
          thread.id,
          relatedCampaign.id,
          relatedRecipient.id,
          "campaign_replied",
        ].join("::"),
        attributionPath: "campaign",
        sourceRecordType: "operator_campaign_recipient",
        sourceRecordId: relatedRecipient.id,
      });
    }

    syncedThreads.push({
      ...thread,
      messages: normalizedThread.messages,
    });
  }

  await supabase
    .from(CONNECTED_ACCOUNT_TABLE)
    .update({
      last_sync_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", account.id);

  await patchOperatorActivationState(supabase, {
    agent,
    ownerUserId,
    changes: {
      googleConnected: true,
      inboxSynced: true,
      metadata: {
        inboxLastSyncedAt: new Date().toISOString(),
      },
    },
  });

  return {
    connected: true,
    account,
    threads: syncedThreads,
  };
}

export async function syncCalendarWorkspace(supabase, options = {}, deps = {}) {
  const agent = options.agent || {};
  const ownerUserId = cleanText(options.ownerUserId);
  const account = options.connectedAccount || await getPrimaryConnectedAccount(supabase, {
    agentId: cleanText(agent.id),
    ownerUserId,
  });

  if (!account || account.status !== "connected") {
    return {
      connected: false,
      events: [],
      suggestedSlots: [],
      missedBookingOpportunities: [],
    };
  }

  const accessToken = await ensureFreshGoogleAccessToken(supabase, account, deps);
  const googleApi = buildGoogleApi(deps);
  const leadCaptureResult = await listLeadCaptures(supabase, {
    agentId: agent.id,
    ownerUserId,
  });
  const leads = leadCaptureResult.records || [];
  const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + DEFAULT_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const googleEvents = await googleApi.listCalendarEvents({
    accessToken,
    timeMin,
    timeMax,
    maxResults: 24,
  });
  const syncedEvents = [];

  for (const googleEvent of googleEvents) {
    const attendeeEmails = uniqueText((googleEvent.attendees || []).map((attendee) => attendee.email).filter(Boolean));
    const relatedLead = leads.find((lead) => attendeeEmails.includes(normalizeEmail(lead.contactEmail))) || null;
    const event = await upsertCalendarEvent(supabase, {
      connected_account_id: account.id,
      agent_id: agent.id,
      business_id: agent.businessId || null,
      owner_user_id: ownerUserId,
      provider_event_id: cleanText(googleEvent.id) || null,
      action_type: "view",
      source_kind: "google_sync",
      status: cleanText(googleEvent.status) || "confirmed",
      approval_status: "synced",
      title: cleanText(googleEvent.summary) || "Untitled event",
      description: cleanText(googleEvent.description) || null,
      attendee_emails: attendeeEmails,
      start_at: googleEvent.start?.dateTime || googleEvent.start?.date || null,
      end_at: googleEvent.end?.dateTime || googleEvent.end?.date || null,
      timezone: cleanText(googleEvent.start?.timeZone || googleEvent.end?.timeZone) || "UTC",
      location: cleanText(googleEvent.location) || null,
      contact_id: relatedLead?.contactId || null,
      lead_id: relatedLead?.id || null,
      related_action_key: relatedLead?.latestActionKey || null,
      conflict_state: "clear",
      metadata: {
        htmlLink: cleanText(googleEvent.htmlLink),
      },
    });

    if (cleanText(event.status) !== "cancelled") {
      await recordOutcomeEvent(supabase, {
        agentId: agent.id,
        businessId: agent.businessId,
        ownerUserId,
        outcomeType: "booking_confirmed",
        sourceType: "calendar_event",
        confirmationLevel: "confirmed",
        contactId: event.contactId || relatedLead?.contactId || "",
        leadId: event.leadId || relatedLead?.id || "",
        actionKey: event.relatedActionKey || relatedLead?.latestActionKey || "",
        calendarEventId: event.id,
        occurredAt: event.startAt || event.updatedAt || new Date().toISOString(),
        dedupeKey: [
          agent.id,
          event.id,
          "booking_confirmed",
        ].join("::"),
        attributionPath: "calendar_booking",
        sourceRecordType: "operator_calendar_event",
        sourceRecordId: event.id,
      });
    }
    syncedEvents.push(event);
  }

  const conflicts = detectCalendarConflicts(syncedEvents);
  for (const conflict of conflicts) {
    await upsertOperatorTask(supabase, agent, ownerUserId, {
      sourceType: "calendar_conflict",
      sourceId: `${conflict.current.providerEventId}:${conflict.next.providerEventId}`,
      taskType: "calendar_conflict",
      title: `Scheduling conflict between ${conflict.current.title || "event"} and ${conflict.next.title || "event"}`,
      description: "Two upcoming events overlap in the connected calendar.",
      status: "open",
      priority: "high",
      approvalRequired: true,
      relatedEventId: conflict.current.id,
      relatedActionKey: cleanText(conflict.current.relatedActionKey),
      taskState: {
        conflictingEventId: conflict.next.id,
        currentStartAt: conflict.current.startAt,
        nextStartAt: conflict.next.startAt,
      },
    });
  }

  const missedBookingOpportunities = buildMissedBookingOpportunities(leads, syncedEvents);
  for (const opportunity of missedBookingOpportunities) {
    await upsertOperatorTask(supabase, agent, ownerUserId, {
      sourceType: "booking_lead",
      sourceId: cleanText(opportunity.leadId),
      taskType: "missed_booking_opportunity",
      title: `Booking opportunity waiting: ${opportunity.contactName || opportunity.contactEmail}`,
      description: opportunity.reason,
      status: "open",
      priority: "medium",
      approvalRequired: true,
      relatedLeadId: opportunity.leadId,
      relatedActionKey: opportunity.relatedActionKey,
      taskState: {
        contactEmail: opportunity.contactEmail,
      },
    });
  }

  const suggestedSlots = suggestCalendarSlots(syncedEvents);

  await supabase
    .from(CONNECTED_ACCOUNT_TABLE)
    .update({
      last_sync_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", account.id);

  await patchOperatorActivationState(supabase, {
    agent,
    ownerUserId,
    changes: {
      googleConnected: true,
      calendarSynced: true,
      metadata: {
        calendarLastSyncedAt: new Date().toISOString(),
      },
    },
  });

  return {
    connected: true,
    account,
    events: syncedEvents,
    suggestedSlots,
    missedBookingOpportunities,
  };
}

function attachThreadMessages(threads = [], messages = []) {
  const messagesByThreadId = new Map();
  messages.forEach((message) => {
    messagesByThreadId.set(message.threadId, [...(messagesByThreadId.get(message.threadId) || []), message]);
  });

  return threads.map((thread) => ({
    ...thread,
    messages: messagesByThreadId.get(thread.id) || [],
  }));
}

function getSettledValue(result, fallbackValue) {
  return result?.status === "fulfilled" ? result.value : fallbackValue;
}

function getSettledErrorMessage(result, fallbackMessage = "") {
  if (result?.status !== "rejected") {
    return "";
  }

  return cleanText(result.reason?.message || fallbackMessage);
}

function buildOperatorSummary({
  threads = [],
  events = [],
  tasks = [],
  campaigns = [],
  followUps = [],
  suggestedSlots = [],
} = {}) {
  const inboxNeedingAttention = threads.filter((thread) => thread.needsReply || thread.riskLevel === "high").length;
  const complaintQueue = tasks.filter((task) => task.taskType === "complaint_queue" && task.status === "open").length;
  const activeCampaigns = campaigns.filter((campaign) => campaign.status === "active").length;
  const followUpsNeedingApproval = followUps.filter((followUp) => ["draft", "ready", "failed", "missing_contact"].includes(cleanText(followUp.status))).length;
  const pendingCalendarApprovals = events.filter((event) => event.approvalStatus === "pending_owner").length;
  const overdueThreads = threads.filter((thread) => thread.needsReply && !isWithinHours(thread.lastMessageAt, STALE_REPLY_WINDOW_HOURS)).length;
  const upcomingBookings = events.filter((event) => parseTimestamp(event.startAt) >= Date.now()).length;

  return {
    inboxNeedingAttention,
    complaintQueue,
    activeCampaigns,
    followUpsNeedingApproval,
    pendingCalendarApprovals,
    overdueThreads,
    upcomingBookings,
    openAvailabilityCount: suggestedSlots.length,
    operatorLoad:
      inboxNeedingAttention
      + complaintQueue
      + followUpsNeedingApproval
      + pendingCalendarApprovals,
  };
}

export async function getOperatorWorkspaceSnapshot(supabase, options = {}, deps = {}) {
  const agent = options.agent || {};
  const ownerUserId = cleanText(options.ownerUserId);
  const featureEnabled = isOperatorWorkspaceEnabled();

  if (!cleanText(agent.id) || !ownerUserId) {
    const error = new Error("agent and owner_user_id are required");
    error.statusCode = 400;
    throw error;
  }

  const persistence = featureEnabled
    ? await probeOperatorActivationPersistence(supabase)
    : { persistenceAvailable: true, migrationRequired: false };
  const googleConfigReady = isGoogleConfigReady();

  if (!featureEnabled) {
    return {
      enabled: false,
      featureEnabled: false,
      status: {
        enabled: false,
        featureEnabled: false,
        googleConfigReady,
        googleConnectReady: false,
        googleConnected: false,
        persistenceAvailable: persistence.persistenceAvailable,
        migrationRequired: persistence.migrationRequired,
      },
      activation: {
        ...createDefaultOperatorActivationState({
          agentId: agent.id,
          businessId: agent.businessId,
          ownerUserId,
          operatorWorkspaceEnabled: false,
        }),
        checklist: [],
        completedCount: 0,
        totalCount: 0,
        isComplete: false,
      },
      briefing: {
        title: "Operator workspace is off",
        text: "Operator Workspace v1 is disabled on this deployment, so Vonza is keeping the legacy setup workspace active.",
      },
      nextAction: {
        key: "legacy_workspace",
        title: "Continue setup",
        description: "Overview, Customize, and Analytics stay available while the website front desk continues to work.",
        buttonLabel: "Continue setup",
        actionType: "open_customize",
        targetSection: "customize",
      },
      today: buildOperatorTodaySummary(),
      contextOptions: {
        mailboxes: getOperatorMailboxOptions(),
        calendars: [
          {
            value: "primary",
            label: "Primary calendar",
            description: "Use the primary Google calendar for today’s summary and approval drafts.",
          },
        ],
      },
      health: {
        inboxSyncError: "",
        calendarSyncError: "",
        contactsError: "",
      },
      connectedAccounts: [],
      inbox: {
        threads: [],
        attentionCount: 0,
      },
      calendar: {
        events: [],
        suggestedSlots: [],
        dailySummary: "Operator Workspace v1 is currently turned off for this deployment.",
        missedBookingOpportunities: [],
      },
      automations: {
        tasks: [],
        campaigns: [],
        followUps: [],
      },
      contacts: {
        list: [],
        filters: {
          quick: [],
          sources: [],
        },
        summary: {
          totalContacts: 0,
          contactsNeedingAttention: 0,
          complaintRiskContacts: 0,
          leadsWithoutNextStep: 0,
          customersAwaitingFollowUp: 0,
        },
        health: {
          persistenceAvailable: true,
          migrationRequired: false,
          loadError: "",
          partialData: false,
        },
      },
      summary: buildOperatorSummary(),
    };
  }

  const connectedAccount = await getPrimaryConnectedAccount(supabase, {
    agentId: agent.id,
    ownerUserId,
  });
  const syncErrors = {
    inboxSyncError: "",
    calendarSyncError: "",
    contactsError: "",
    globalError: "",
  };

  if (
    connectedAccount?.status === "connected"
    && options.forceSync === true
    && googleConfigReady
    && persistence.persistenceAvailable !== false
  ) {
    const [inboxSyncResult, calendarSyncResult] = await Promise.allSettled([
      syncInboxWorkspace(supabase, {
        agent,
        ownerUserId,
        connectedAccount,
      }, deps),
      syncCalendarWorkspace(supabase, {
        agent,
        ownerUserId,
        connectedAccount,
      }, deps),
    ]);

    if (inboxSyncResult.status === "rejected") {
      syncErrors.inboxSyncError = cleanText(inboxSyncResult.reason?.message) || "Inbox sync failed.";
      console.warn("[operator] Inbox sync failed:", syncErrors.inboxSyncError);
    }

    if (calendarSyncResult.status === "rejected") {
      syncErrors.calendarSyncError = cleanText(calendarSyncResult.reason?.message) || "Calendar sync failed.";
      console.warn("[operator] Calendar sync failed:", syncErrors.calendarSyncError);
    }
  }

  const [
    accountsResult,
    threadsResult,
    eventsResult,
    tasksResult,
    campaignsResult,
    followUpsResult,
    activationResult,
    leadCapturesResult,
    outcomesResult,
  ] = await Promise.allSettled([
    listConnectedAccountsInternal(supabase, {
      agentId: agent.id,
      ownerUserId,
    }),
    listStoredInboxThreads(supabase, {
      agentId: agent.id,
      ownerUserId,
    }),
    listStoredCalendarEvents(supabase, {
      agentId: agent.id,
      ownerUserId,
    }),
    listStoredTasks(supabase, {
      agentId: agent.id,
      ownerUserId,
    }),
    listStoredCampaigns(supabase, {
      agentId: agent.id,
      ownerUserId,
    }),
    listFollowUpWorkflows(supabase, {
      agentId: agent.id,
      ownerUserId,
    }),
    getOperatorActivationState(supabase, {
      agent,
      ownerUserId,
      createIfMissing: true,
    }),
    listLeadCaptures(supabase, {
      agentId: agent.id,
      ownerUserId,
    }),
    listConversionOutcomesForAgent(supabase, {
      agentId: agent.id,
      ownerUserId,
    }),
  ]);

  const accounts = getSettledValue(accountsResult, []);
  const threads = getSettledValue(threadsResult, []);
  const events = getSettledValue(eventsResult, []);
  const tasks = getSettledValue(tasksResult, []);
  const campaigns = getSettledValue(campaignsResult, []);
  const followUpResult = getSettledValue(followUpsResult, { records: [], persistenceAvailable: true });
  const activationState = getSettledValue(activationResult, createDefaultOperatorActivationState({
    agentId: agent.id,
    businessId: agent.businessId,
    ownerUserId,
    operatorWorkspaceEnabled: true,
    persistenceAvailable: persistence.persistenceAvailable !== false,
    migrationRequired: persistence.migrationRequired === true,
  }));
  const leadCaptureResult = getSettledValue(leadCapturesResult, { records: [], persistenceAvailable: true });
  const conversionOutcomeResult = getSettledValue(outcomesResult, { records: [], persistenceAvailable: true });

  const threadMessagesResult = await Promise.allSettled([
    listStoredInboxMessages(supabase, {
      threadIds: threads.map((thread) => thread.id),
    }),
  ]);
  const threadMessages = getSettledValue(threadMessagesResult[0], []);
  const enrichedThreads = attachThreadMessages(threads, threadMessages);
  const partialLoadErrors = [
    getSettledErrorMessage(accountsResult),
    getSettledErrorMessage(threadsResult),
    getSettledErrorMessage(eventsResult),
    getSettledErrorMessage(tasksResult),
    getSettledErrorMessage(campaignsResult),
    getSettledErrorMessage(followUpsResult),
    getSettledErrorMessage(activationResult),
    getSettledErrorMessage(leadCapturesResult),
    getSettledErrorMessage(outcomesResult),
    getSettledErrorMessage(threadMessagesResult[0]),
  ].filter(Boolean);
  const suggestedSlots = suggestCalendarSlots(events);
  const summary = buildOperatorSummary({
    threads: enrichedThreads,
    events,
    tasks,
    campaigns,
    followUps: followUpResult.records || [],
    suggestedSlots,
  });
  const missedBookingOpportunities = buildMissedBookingOpportunities(
    leadCaptureResult.records || [],
    events
  );
  const googleConnected = accounts.some((account) => account.status === "connected");
  const normalizedActivation = createDefaultOperatorActivationState({
    ...activationState,
    operatorWorkspaceEnabled: true,
    googleConnected: googleConnected || activationState.googleConnected,
    inboxSynced:
      activationState.inboxSynced
      || Boolean((activationState.metadata || {}).inboxLastSyncedAt)
      || Boolean(threads.length)
      || Boolean(accounts.find((account) => account.status === "connected" && account.lastSyncAt)),
    calendarSynced:
      activationState.calendarSynced
      || Boolean((activationState.metadata || {}).calendarLastSyncedAt)
      || Boolean(events.length)
      || Boolean(accounts.find((account) => account.status === "connected" && account.lastSyncAt)),
    persistenceAvailable:
      activationState.persistenceAvailable !== false
      && persistence.persistenceAvailable !== false,
    migrationRequired:
      activationState.migrationRequired === true
      || persistence.migrationRequired === true,
  });
  const contactsWorkspace = await getOperatorContactsWorkspace(supabase, {
    agent,
    ownerUserId,
    leads: leadCaptureResult.records || [],
    threads: enrichedThreads,
    events,
    tasks,
    campaigns,
    followUps: followUpResult.records || [],
    outcomes: conversionOutcomeResult.records || [],
    loadError: partialLoadErrors[0] || "",
  });
  syncErrors.contactsError = cleanText(contactsWorkspace.health?.loadError);
  syncErrors.globalError = partialLoadErrors.length > 1
    ? `${partialLoadErrors.length} workspace data source${partialLoadErrors.length === 1 ? "" : "s"} returned partial data.`
    : "";
  const status = {
    enabled: true,
    featureEnabled: true,
    googleConfigReady,
    googleConnectReady: googleConfigReady && normalizedActivation.migrationRequired !== true,
    googleConnected,
    persistenceAvailable: normalizedActivation.persistenceAvailable !== false,
    migrationRequired: normalizedActivation.migrationRequired === true,
    syncRequested: options.forceSync === true,
  };
  const nextAction = buildOperatorSingleNextAction({
    status,
    activation: normalizedActivation,
    summary,
    tasks,
    threads: enrichedThreads,
    followUps: followUpResult.records || [],
    campaigns,
    events,
    suggestedSlots,
  });
  const checklist = buildOperatorActivationChecklist({
    activation: normalizedActivation,
    status,
    threads: enrichedThreads,
    events,
    suggestedSlots,
  });
  const completedCount = checklist.filter((step) => step.complete).length;
  const activation = {
    ...normalizedActivation,
    checklist,
    completedCount,
    totalCount: checklist.length,
    isComplete: checklist.length > 0 && completedCount === checklist.length,
  };
  const briefing = buildOperatorBriefing({
    status,
    activation,
    summary,
    tasks,
    nextAction,
    events,
    suggestedSlots,
    followUps: followUpResult.records || [],
  });
  const today = buildOperatorTodaySummary({
    summary,
    tasks,
    events,
    suggestedSlots,
    campaigns,
    followUps: followUpResult.records || [],
    outcomesSummary: conversionOutcomeResult.summary || {},
    recentOutcomes: conversionOutcomeResult.recentOutcomes || [],
    contacts: contactsWorkspace.list || [],
    contactsSummary: contactsWorkspace.summary,
  });

  return {
    enabled: true,
    featureEnabled: true,
    status,
    activation,
    briefing,
    nextAction,
    today,
    contextOptions: {
      mailboxes: getOperatorMailboxOptions(),
      calendars: [
        {
          value: "primary",
          label: "Primary calendar",
          description: "Use the primary Google calendar for today’s summary and approval drafts.",
        },
      ],
    },
    health: syncErrors,
    connectedAccounts: accounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      status: account.status,
      accountEmail: account.accountEmail,
      displayName: account.displayName,
      selectedMailbox: account.selectedMailbox,
      scopes: account.scopes,
      scopeAudit: account.scopeAudit,
      lastRefreshedAt: account.lastRefreshedAt,
      lastSyncAt: account.lastSyncAt,
      lastError: account.lastError,
    })),
    inbox: {
      threads: enrichedThreads,
      attentionCount: summary.inboxNeedingAttention,
    },
    calendar: {
      events,
      suggestedSlots,
      dailySummary: buildCalendarDailySummary({
        events,
        tasks,
        slots: suggestedSlots,
      }),
      missedBookingOpportunities,
    },
    automations: {
      tasks,
      campaigns,
      followUps: followUpResult.records || [],
    },
    outcomes: {
      summary: conversionOutcomeResult.summary || null,
      recentOutcomes: conversionOutcomeResult.recentOutcomes || [],
      persistenceAvailable: conversionOutcomeResult.persistenceAvailable !== false,
    },
    contacts: contactsWorkspace,
    summary,
  };
}

export async function draftInboxReply(supabase, options = {}) {
  const agent = options.agent || {};
  const ownerUserId = cleanText(options.ownerUserId);
  const threadId = cleanText(options.threadId);

  if (!threadId || !cleanText(agent.id) || !ownerUserId) {
    const error = new Error("thread_id, agent, and owner_user_id are required");
    error.statusCode = 400;
    throw error;
  }

  const { data: threadRow, error } = await supabase
    .from(OPERATOR_INBOX_THREAD_TABLE)
    .select(INBOX_THREAD_SELECT)
    .eq("id", threadId)
    .eq("agent_id", agent.id)
    .eq("owner_user_id", ownerUserId)
    .single();

  if (error) {
    throw error;
  }

  const thread = mapInboxThreadRow(threadRow);
  const messages = await listStoredInboxMessages(supabase, { threadIds: [thread.id] });
  const draft = buildReplyDraft({
    ...thread,
    messages,
  }, {
    businessName: cleanText(agent.assistantName || agent.name),
    senderName: cleanText(agent.assistantName || agent.name),
  });

  const draftMessage = await upsertInboxMessage(supabase, {
    thread_id: thread.id,
    connected_account_id: thread.connectedAccountId,
    agent_id: agent.id,
    business_id: agent.businessId || null,
    owner_user_id: ownerUserId,
    provider_message_id: `draft-${thread.providerThreadId}`,
    direction: "draft",
    approval_status: "pending_owner",
    message_state: "draft_ready",
    sender: agent.assistantName || agent.name || "Vonza",
    recipients: draft.to ? [draft.to] : [],
    cc: [],
    subject: draft.subject,
    body_preview: cleanText(draft.body).slice(0, 180),
    body_text: draft.body,
    sent_at: null,
    metadata: {
      threadId: thread.id,
    },
  });

  await writeAuditLog(supabase, {
    agentId: agent.id,
    businessId: agent.businessId,
    ownerUserId,
    connectedAccountId: thread.connectedAccountId,
    actorType: "owner",
    actorId: ownerUserId,
    actionType: "inbox_reply_drafted",
    targetType: "inbox_thread",
    targetId: thread.id,
    details: {
      classification: thread.classification,
      subject: draft.subject,
    },
  });

  await patchOperatorActivationState(supabase, {
    agent,
    ownerUserId,
    changes: {
      firstReplyDraftCreated: true,
    },
  });

  return {
    thread,
    draft: draftMessage,
  };
}

export async function sendInboxReply(supabase, options = {}, deps = {}) {
  const agent = options.agent || {};
  const ownerUserId = cleanText(options.ownerUserId);
  const threadId = cleanText(options.threadId);
  const body = cleanText(options.body);
  const subject = cleanText(options.subject);

  if (!threadId || !subject || !body) {
    const error = new Error("thread_id, subject, and body are required");
    error.statusCode = 400;
    throw error;
  }

  const account = await getPrimaryConnectedAccount(supabase, {
    agentId: agent.id,
    ownerUserId,
  });

  if (!account || account.status !== "connected") {
    const error = new Error("Connect Google before sending replies.");
    error.statusCode = 409;
    throw error;
  }

  const { data: threadRow, error } = await supabase
    .from(OPERATOR_INBOX_THREAD_TABLE)
    .select(INBOX_THREAD_SELECT)
    .eq("id", threadId)
    .eq("agent_id", agent.id)
    .eq("owner_user_id", ownerUserId)
    .single();

  if (error) {
    throw error;
  }

  const thread = mapInboxThreadRow(threadRow);
  const threadMessages = await listStoredInboxMessages(supabase, { threadIds: [thread.id] });
  const latestInbound = threadMessages
    .slice()
    .reverse()
    .find((message) => message.direction === "inbound");
  const to = normalizeEmail(latestInbound?.sender || latestInbound?.recipients?.[0]);

  if (!to) {
    const error = new Error("This thread does not have a sendable recipient email.");
    error.statusCode = 400;
    throw error;
  }

  const accessToken = await ensureFreshGoogleAccessToken(supabase, account, deps);
  const googleApi = buildGoogleApi(deps);
  const raw = toMimeRaw({
    from: account.accountEmail || agent.assistantName || "Vonza",
    to,
    subject,
    body,
    threadId: thread.providerThreadId,
  });
  const sendResult = await googleApi.sendMessage({
    accessToken,
    raw,
  });

  const sentMessage = await upsertInboxMessage(supabase, {
    thread_id: thread.id,
    connected_account_id: account.id,
    agent_id: agent.id,
    business_id: agent.businessId || null,
    owner_user_id: ownerUserId,
    provider_message_id: cleanText(sendResult.id) || `sent-${thread.providerThreadId}-${Date.now()}`,
    direction: "outbound",
    approval_status: "approved",
    message_state: "sent",
    sender: account.accountEmail || null,
    recipients: [to],
    cc: [],
    subject,
    body_preview: body.slice(0, 180),
    body_text: body,
    sent_at: new Date().toISOString(),
    metadata: {
      gmailThreadId: cleanText(sendResult.threadId) || thread.providerThreadId,
    },
  });

  await supabase
    .from(OPERATOR_INBOX_THREAD_TABLE)
    .update({
      status: "waiting",
      needs_reply: false,
      complaint_state: thread.classification === "complaint" ? "responded" : thread.complaintState,
      follow_up_state: "owner_replied",
      updated_at: new Date().toISOString(),
    })
    .eq("id", thread.id);

  if (thread.relatedActionKey) {
    try {
      await updateActionQueueStatus(supabase, {
        agentId: agent.id,
        ownerUserId,
        actionKey: thread.relatedActionKey,
        status: "done",
        followUpNeeded: false,
        followUpCompleted: true,
        outcome: "Replied from connected inbox.",
      });
    } catch (queueError) {
      console.warn("[operator] Could not sync sent inbox reply to action queue:", queueError.message);
    }
  }

  await writeAuditLog(supabase, {
    agentId: agent.id,
    businessId: agent.businessId,
    ownerUserId,
    connectedAccountId: account.id,
    actorType: "owner",
    actorId: ownerUserId,
    actionType: "inbox_reply_sent",
    targetType: "inbox_thread",
    targetId: thread.id,
    details: {
      to,
      subject,
    },
  });

  return {
    threadId: thread.id,
    message: sentMessage,
  };
}

export async function draftCalendarAction(supabase, options = {}) {
  const agent = options.agent || {};
  const ownerUserId = cleanText(options.ownerUserId);
  const actionType = cleanText(options.actionType || "create");
  const eventId = cleanText(options.eventId);
  const title = cleanText(options.title);
  const startAt = cleanText(options.startAt);
  const endAt = cleanText(options.endAt);

  if (!cleanText(agent.id) || !ownerUserId || !actionType) {
    const error = new Error("agent, owner_user_id, and action_type are required");
    error.statusCode = 400;
    throw error;
  }

  if (actionType === "create" && (!title || !startAt || !endAt)) {
    const error = new Error("title, start_at, and end_at are required for calendar drafts");
    error.statusCode = 400;
    throw error;
  }

  let existingEvent = null;

  if (eventId) {
    const { data, error } = await supabase
      .from(OPERATOR_CALENDAR_EVENT_TABLE)
      .select(CALENDAR_EVENT_SELECT)
      .eq("id", eventId)
      .eq("agent_id", agent.id)
      .eq("owner_user_id", ownerUserId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    existingEvent = mapCalendarEventRow(data);
  }

  const event = await upsertCalendarEvent(supabase, {
    connected_account_id: existingEvent?.connectedAccountId || null,
    agent_id: agent.id,
    business_id: agent.businessId || null,
    owner_user_id: ownerUserId,
    provider_event_id: existingEvent?.providerEventId || null,
    action_type: actionType,
    source_kind: existingEvent ? "calendar_mutation" : "owner_draft",
    status: existingEvent?.status || "tentative",
    approval_status: "pending_owner",
    title: title || existingEvent?.title || "New event",
    description: cleanText(options.description) || existingEvent?.description || null,
    attendee_emails: uniqueText(
      normalizeArray(options.attendeeEmails || options.attendee_emails).concat(existingEvent?.attendeeEmails || [])
    ),
    start_at: startAt || existingEvent?.startAt || null,
    end_at: endAt || existingEvent?.endAt || null,
    timezone: cleanText(options.timezone) || existingEvent?.timezone || "UTC",
    location: cleanText(options.location) || existingEvent?.location || null,
    contact_id: cleanText(options.contactId) || existingEvent?.contactId || null,
    lead_id: cleanText(options.leadId) || existingEvent?.leadId || null,
    related_action_key: cleanText(options.relatedActionKey) || existingEvent?.relatedActionKey || null,
    conflict_state: existingEvent?.conflictState || "clear",
    metadata: {
      ...(existingEvent?.metadata || {}),
      mutationRequestedAt: new Date().toISOString(),
      cancelRequested: actionType === "cancel",
    },
  });

  await upsertOperatorTask(supabase, agent, ownerUserId, {
    sourceType: "calendar_event",
    sourceId: event.id,
    taskType: actionType === "cancel" ? "calendar_cancel_approval" : "calendar_mutation_approval",
    title: actionType === "cancel"
      ? `Approve cancellation for ${event.title || "event"}`
      : `Approve calendar ${actionType} for ${event.title || "event"}`,
    description: "Calendar changes stay approval-first in v1.",
    status: "open",
    priority: "medium",
    approvalRequired: true,
    relatedEventId: event.id,
    relatedLeadId: event.leadId,
    relatedActionKey: event.relatedActionKey,
    taskState: {
      actionType,
      startAt: event.startAt,
      endAt: event.endAt,
    },
  });

  return {
    event,
  };
}

export async function approveCalendarAction(supabase, options = {}, deps = {}) {
  const agent = options.agent || {};
  const ownerUserId = cleanText(options.ownerUserId);
  const eventId = cleanText(options.eventId);

  if (!eventId) {
    const error = new Error("event_id is required");
    error.statusCode = 400;
    throw error;
  }

  const { data, error } = await supabase
    .from(OPERATOR_CALENDAR_EVENT_TABLE)
    .select(CALENDAR_EVENT_SELECT)
    .eq("id", eventId)
    .eq("agent_id", agent.id)
    .eq("owner_user_id", ownerUserId)
    .single();

  if (error) {
    throw error;
  }

  const event = mapCalendarEventRow(data);
  const account = await getPrimaryConnectedAccount(supabase, {
    agentId: agent.id,
    ownerUserId,
  });

  if (!account || account.status !== "connected") {
    const syncError = new Error("Connect Google Calendar before approving calendar changes.");
    syncError.statusCode = 409;
    throw syncError;
  }

  const accessToken = await ensureFreshGoogleAccessToken(supabase, account, deps);
  const googleApi = buildGoogleApi(deps);
  let providerEventId = event.providerEventId;
  let providerStatus = event.status;

  if (event.actionType === "cancel" && providerEventId) {
    await googleApi.cancelCalendarEvent({
      accessToken,
      eventId: providerEventId,
    });
    providerStatus = "cancelled";
  } else if (event.actionType === "update" && providerEventId) {
    const updated = await googleApi.updateCalendarEvent({
      accessToken,
      eventId: providerEventId,
      event: {
        summary: event.title,
        description: event.description,
        location: event.location,
        attendees: event.attendeeEmails.map((email) => ({ email })),
        start: {
          dateTime: event.startAt,
          timeZone: event.timezone || "UTC",
        },
        end: {
          dateTime: event.endAt,
          timeZone: event.timezone || "UTC",
        },
      },
    });
    providerStatus = cleanText(updated.status) || "confirmed";
  } else {
    const created = await googleApi.createCalendarEvent({
      accessToken,
      event: {
        summary: event.title,
        description: event.description,
        location: event.location,
        attendees: event.attendeeEmails.map((email) => ({ email })),
        start: {
          dateTime: event.startAt,
          timeZone: event.timezone || "UTC",
        },
        end: {
          dateTime: event.endAt,
          timeZone: event.timezone || "UTC",
        },
      },
    });
    providerEventId = cleanText(created.id);
    providerStatus = cleanText(created.status) || "confirmed";
  }

  const { data: updatedRow, error: updateError } = await supabase
    .from(OPERATOR_CALENDAR_EVENT_TABLE)
    .update({
      connected_account_id: account.id,
      provider_event_id: providerEventId || null,
      approval_status: "approved",
      status: providerStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id)
    .select(CALENDAR_EVENT_SELECT)
    .single();

  if (updateError) {
    throw updateError;
  }

  const updatedEvent = mapCalendarEventRow(updatedRow);

  if (cleanText(updatedEvent.status) !== "cancelled") {
    await recordOutcomeEvent(supabase, {
      agentId: agent.id,
      businessId: agent.businessId,
      ownerUserId,
      outcomeType: "booking_confirmed",
      sourceType: "calendar_event",
      confirmationLevel: "confirmed",
      contactId: updatedEvent.contactId || "",
      leadId: updatedEvent.leadId || "",
      actionKey: updatedEvent.relatedActionKey || "",
      calendarEventId: updatedEvent.id,
      occurredAt: updatedEvent.startAt || updatedEvent.updatedAt || new Date().toISOString(),
      dedupeKey: [
        agent.id,
        updatedEvent.id,
        "booking_confirmed",
      ].join("::"),
      attributionPath: "calendar_booking",
      sourceRecordType: "operator_calendar_event",
      sourceRecordId: updatedEvent.id,
    });
  }

  await writeAuditLog(supabase, {
    agentId: agent.id,
    businessId: agent.businessId,
    ownerUserId,
    connectedAccountId: account.id,
    actorType: "owner",
    actorId: ownerUserId,
    actionType: "calendar_action_approved",
    targetType: "calendar_event",
    targetId: event.id,
    details: {
      actionType: event.actionType,
      providerEventId,
    },
  });

  await patchOperatorActivationState(supabase, {
    agent,
    ownerUserId,
    changes: {
      firstCalendarActionReviewed: true,
    },
  });

  return {
    event: updatedEvent,
  };
}

export async function createCampaignDraft(supabase, options = {}) {
  const agent = options.agent || {};
  const ownerUserId = cleanText(options.ownerUserId);
  const goal = cleanText(options.goal).toLowerCase();
  const directContactEmail = normalizeEmail(options.contactEmail || options.contact_email);
  const directContactName = cleanText(options.contactName || options.contact_name);
  const directContactId = cleanText(options.contactId || options.contact_id);
  const directLeadId = cleanText(options.leadId || options.lead_id);
  const directPersonKey = cleanText(options.personKey || options.person_key);

  if (!CAMPAIGN_GOALS.includes(goal)) {
    const error = new Error("Enter a valid campaign goal.");
    error.statusCode = 400;
    throw error;
  }

  const leadCaptureResult = await listLeadCaptures(supabase, {
    agentId: agent.id,
    ownerUserId,
  });
  const fallbackRecipients = (leadCaptureResult.records || [])
    .filter((lead) => normalizeEmail(lead.contactEmail))
    .filter((lead) => {
      if (goal === "complaint_recovery") {
        return /complaint|support|refund|issue/i.test(cleanText(lead.captureReason));
      }

      if (goal === "review_request") {
        return lead.captureState === "captured";
      }

      return true;
    })
    .slice(0, 50);
  const recipients = directContactEmail
    ? [{
      id: "",
      contactId: directContactId || null,
      leadId: directLeadId || null,
      personKey: directPersonKey || null,
      contactName: directContactName || null,
      contactEmail: directContactEmail,
      latestActionKey: cleanText(options.latestActionKey || options.latest_action_key) || null,
    }]
    : fallbackRecipients;
  const steps = buildCampaignSequence(goal, cleanText(agent.assistantName || agent.name) || "Vonza");

  const { data: campaignRow, error: campaignError } = await supabase
    .from(OPERATOR_CAMPAIGN_TABLE)
    .insert({
      agent_id: agent.id,
      business_id: agent.businessId || null,
      owner_user_id: ownerUserId,
      goal,
      title: buildCampaignTitle(goal),
      status: "draft",
      approval_status: "pending_owner",
      recipient_source: cleanText(options.recipientSource) || "captured_leads",
      source_filters: {},
      schedule_config: {
        sendWindowHour: Number(options.sendWindowHour || 10) || 10,
      },
      sequence_summary: `${steps.length} approval-first email step${steps.length === 1 ? "" : "s"} prepared.`,
      reply_handling_mode: "manual_review",
      metadata: {
        recipientCount: recipients.length,
      },
      updated_at: new Date().toISOString(),
    })
    .select(CAMPAIGN_SELECT)
    .single();

  if (campaignError) {
    throw campaignError;
  }

  const campaign = mapCampaignRow(campaignRow);

  if (steps.length) {
    const { error: stepError } = await supabase.from(OPERATOR_CAMPAIGN_STEP_TABLE).insert(
      steps.map((step) => ({
        campaign_id: campaign.id,
        agent_id: agent.id,
        business_id: agent.businessId || null,
        owner_user_id: ownerUserId,
        step_order: step.stepOrder,
        channel: "email",
        timing_offset_hours: step.timingOffsetHours,
        subject: step.subject,
        body: step.body,
        approval_status: "pending_owner",
      }))
    );

    if (stepError) {
      throw stepError;
    }
  }

  if (recipients.length) {
    const { error: recipientError } = await supabase
      .from(OPERATOR_CAMPAIGN_RECIPIENT_TABLE)
      .insert(
        recipients.map((lead) => ({
          campaign_id: campaign.id,
          agent_id: agent.id,
          business_id: agent.businessId || null,
          owner_user_id: ownerUserId,
          contact_id: lead.contactId || null,
          lead_id: lead.leadId || lead.id,
          person_key: lead.personKey || null,
          contact_name: lead.contactName || null,
          contact_email: lead.contactEmail || null,
          status: "pending",
          current_step_index: 0,
          next_send_at: null,
          reply_state: "awaiting_reply",
          metadata: {
            latestActionKey: lead.latestActionKey,
          },
        }))
      );

    if (recipientError) {
      throw recipientError;
    }
  }

  await upsertOperatorTask(supabase, agent, ownerUserId, {
    sourceType: "campaign",
    sourceId: campaign.id,
    taskType: "campaign_approval",
    title: `Approve campaign: ${campaign.title}`,
    description: "Campaigns stay draft-first until the owner approves activation.",
    status: "open",
    priority: "medium",
    approvalRequired: true,
    relatedCampaignId: campaign.id,
    taskState: {
      goal,
      recipientCount: recipients.length,
    },
  });

  await writeAuditLog(supabase, {
    agentId: agent.id,
    businessId: agent.businessId,
    ownerUserId,
    actorType: "owner",
    actorId: ownerUserId,
    actionType: "campaign_drafted",
    targetType: "campaign",
    targetId: campaign.id,
    details: {
      goal,
      recipientCount: recipients.length,
    },
  });

  await patchOperatorActivationState(supabase, {
    agent,
    ownerUserId,
    changes: {
      firstCampaignDraftCreated: true,
    },
  });

  return getCampaignById(supabase, {
    campaignId: campaign.id,
    agentId: agent.id,
    ownerUserId,
  });
}

async function getCampaignById(supabase, options = {}) {
  const { campaignId, agentId, ownerUserId } = options;
  const campaigns = await listStoredCampaigns(supabase, {
    agentId,
    ownerUserId,
  });
  return campaigns.find((campaign) => campaign.id === campaignId) || null;
}

export async function approveCampaignDraft(supabase, options = {}) {
  const agent = options.agent || {};
  const ownerUserId = cleanText(options.ownerUserId);
  const campaignId = cleanText(options.campaignId);
  const sendWindowHour = Number(options.sendWindowHour || 10) || 10;

  const campaign = await getCampaignById(supabase, {
    campaignId,
    agentId: agent.id,
    ownerUserId,
  });

  if (!campaign) {
    const error = new Error("Campaign not found");
    error.statusCode = 404;
    throw error;
  }

  const now = new Date();
  now.setHours(sendWindowHour, 0, 0, 0);
  if (now.getTime() < Date.now()) {
    now.setDate(now.getDate() + 1);
  }

  const [{ error: campaignError }, { error: stepError }, { error: recipientError }] = await Promise.all([
    supabase
      .from(OPERATOR_CAMPAIGN_TABLE)
      .update({
        status: "active",
        approval_status: "approved",
        approved_at: new Date().toISOString(),
        activated_at: new Date().toISOString(),
        schedule_config: {
          ...(campaign.scheduleConfig || {}),
          sendWindowHour,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaign.id),
    supabase
      .from(OPERATOR_CAMPAIGN_STEP_TABLE)
      .update({
        approval_status: "approved",
        updated_at: new Date().toISOString(),
      })
      .eq("campaign_id", campaign.id),
    supabase
      .from(OPERATOR_CAMPAIGN_RECIPIENT_TABLE)
      .update({
        status: "queued",
        next_send_at: now.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("campaign_id", campaign.id),
  ]);

  if (campaignError) {
    throw campaignError;
  }

  if (stepError) {
    throw stepError;
  }

  if (recipientError) {
    throw recipientError;
  }

  await writeAuditLog(supabase, {
    agentId: agent.id,
    businessId: agent.businessId,
    ownerUserId,
    actorType: "owner",
    actorId: ownerUserId,
    actionType: "campaign_approved",
    targetType: "campaign",
    targetId: campaign.id,
    details: {
      sendWindowHour,
    },
  });

  return getCampaignById(supabase, {
    campaignId: campaign.id,
    agentId: agent.id,
    ownerUserId,
  });
}

export async function sendDueCampaignSteps(supabase, options = {}, deps = {}) {
  const agent = options.agent || {};
  const ownerUserId = cleanText(options.ownerUserId);
  const campaignId = cleanText(options.campaignId);
  const account = await getPrimaryConnectedAccount(supabase, {
    agentId: agent.id,
    ownerUserId,
  });

  if (!account || account.status !== "connected") {
    const error = new Error("Connect Google before sending campaign steps.");
    error.statusCode = 409;
    throw error;
  }

  const campaign = await getCampaignById(supabase, {
    campaignId,
    agentId: agent.id,
    ownerUserId,
  });

  if (!campaign) {
    const error = new Error("Campaign not found");
    error.statusCode = 404;
    throw error;
  }

  const accessToken = await ensureFreshGoogleAccessToken(supabase, account, deps);
  const googleApi = buildGoogleApi(deps);
  const dueRecipients = (campaign.recipients || []).filter((recipient) =>
    ["queued", "active"].includes(recipient.status)
    && recipient.nextSendAt
    && parseTimestamp(recipient.nextSendAt) <= Date.now()
  );
  const sentRecipients = [];

  for (const recipient of dueRecipients) {
    const step = (campaign.steps || []).find((candidate) => candidate.stepOrder === recipient.currentStepIndex);

    if (!step) {
      continue;
    }

    const raw = toMimeRaw({
      from: account.accountEmail || agent.assistantName || "Vonza",
      to: recipient.contactEmail,
      subject: step.subject,
      body: step.body,
    });
    const sendResult = await googleApi.sendMessage({
      accessToken,
      raw,
    });
    const nextStep = (campaign.steps || []).find((candidate) => candidate.stepOrder === recipient.currentStepIndex + 1);
    const nextSendAt = nextStep
      ? new Date(Date.now() + nextStep.timingOffsetHours * 60 * 60 * 1000).toISOString()
      : null;

    const { data, error } = await supabase
      .from(OPERATOR_CAMPAIGN_RECIPIENT_TABLE)
      .update({
        status: nextStep ? "active" : "completed",
        current_step_index: recipient.currentStepIndex + 1,
        next_send_at: nextSendAt,
        last_contacted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {
          ...(recipient.metadata || {}),
          lastProviderMessageId: cleanText(sendResult.id),
        },
      })
      .eq("id", recipient.id)
      .select(CAMPAIGN_RECIPIENT_SELECT)
      .single();

    if (error) {
      throw error;
    }

    const sentRecipient = mapCampaignRecipientRow(data);
    sentRecipients.push(sentRecipient);

    await recordOutcomeEvent(supabase, {
      agentId: agent.id,
      businessId: agent.businessId,
      ownerUserId,
      outcomeType: "campaign_sent",
      sourceType: "campaign",
      confirmationLevel: "observed",
      contactId: sentRecipient.contactId || "",
      leadId: sentRecipient.leadId || "",
      actionKey: cleanText(sentRecipient.metadata?.latestActionKey),
      campaignId: campaign.id,
      campaignRecipientId: sentRecipient.id,
      occurredAt: sentRecipient.lastContactedAt || new Date().toISOString(),
      dedupeKey: [
        agent.id,
        campaign.id,
        sentRecipient.id,
        sentRecipient.currentStepIndex,
        "campaign_sent",
      ].join("::"),
      attributionPath: "campaign",
      sourceRecordType: "operator_campaign_recipient",
      sourceRecordId: sentRecipient.id,
    });
  }

  await writeAuditLog(supabase, {
    agentId: agent.id,
    businessId: agent.businessId,
    ownerUserId,
    connectedAccountId: account.id,
    actorType: "owner",
    actorId: ownerUserId,
    actionType: "campaign_send_run",
    targetType: "campaign",
    targetId: campaign.id,
    details: {
      sentRecipients: sentRecipients.length,
    },
  });

  return {
    campaignId: campaign.id,
    sentRecipients,
  };
}

export async function updateOperatorTaskStatus(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);
  const taskId = cleanText(options.taskId);
  const status = cleanText(options.status) || "open";

  const { data, error } = await supabase
    .from(OPERATOR_TASK_TABLE)
    .update({
      status,
      resolved_at: status === "resolved" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
      task_state: options.taskState && typeof options.taskState === "object"
        ? options.taskState
        : {},
    })
    .eq("id", taskId)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .select(TASK_SELECT)
    .single();

  if (error) {
    throw error;
  }

  const task = mapTaskRow(data);

  if (
    status === "resolved"
    && ["complaint_queue", "support_follow_up"].includes(cleanText(task.taskType))
  ) {
    await recordOutcomeEvent(supabase, {
      agentId,
      businessId: cleanText(data.business_id),
      ownerUserId,
      outcomeType: "complaint_resolved",
      sourceType: "operator_task",
      confirmationLevel: "manual",
      contactId: task.contactId || "",
      leadId: task.relatedLeadId || "",
      actionKey: task.relatedActionKey || "",
      inboxThreadId: task.relatedThreadId || "",
      operatorTaskId: task.id,
      occurredAt: task.resolvedAt || new Date().toISOString(),
      dedupeKey: [
        agentId,
        task.id,
        "complaint_resolved",
      ].join("::"),
      attributionPath: cleanText(task.relatedThreadId) ? "inbox_thread" : "manual_owner",
      sourceRecordType: "operator_task",
      sourceRecordId: task.id,
    });
  }

  return task;
}

import { getPublicAppUrl } from "../../config/env.js";
import { cleanText } from "../../utils/text.js";
import { getHostnameFromUrl } from "../../utils/url.js";

const AGENT_INSTALLATIONS_TABLE = "agent_installations";
const AGENTS_TABLE = "agents";
const BUSINESSES_TABLE = "businesses";
const WIDGET_CONFIGS_TABLE = "widget_configs";
const INSTALL_STATUS_STALE_HOURS = 72;
const VERIFICATION_STATUS = {
  FOUND: "found",
  NOT_FOUND: "not_found",
  MISMATCH: "mismatch",
  FETCH_ERROR: "fetch_error",
  NO_WEBSITE: "no_website",
};

export function isMissingRelationError(error, relationName) {
  const message = cleanText(error?.message || "").toLowerCase();
  return (
    error?.code === "PGRST205" ||
    error?.code === "42P01" ||
    message.includes(`'public.${relationName}'`) ||
    message.includes(`${relationName} was not found`)
  );
}

function parseAbsoluteUrl(value) {
  const normalizedValue = cleanText(value);

  if (!normalizedValue) {
    return null;
  }

  try {
    const parsed = new URL(normalizedValue);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeTimestamp(value) {
  const normalized = cleanText(value);

  if (!normalized) {
    return "";
  }

  const timestamp = new Date(normalized);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "";
}

function normalizeOriginValue(value) {
  const parsed = parseAbsoluteUrl(value);
  return parsed ? parsed.origin.toLowerCase() : "";
}

function normalizeHost(value) {
  const parsed = parseAbsoluteUrl(value);

  if (parsed) {
    return parsed.hostname.replace(/^www\./i, "").toLowerCase();
  }

  return cleanText(value).replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "").toLowerCase();
}

function normalizeDomainToken(value) {
  const normalized = normalizeHost(value);
  return normalized || "";
}

export function normalizeAllowedDomains(value, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  const values = Array.isArray(value)
    ? value
    : cleanText(value)
      ? String(value)
          .split(/[\n,]/g)
          .map((item) => item.trim())
      : [];
  const deduped = [...new Set(values.map((item) => normalizeDomainToken(item)).filter(Boolean))];

  if (deduped.length || allowEmpty) {
    return deduped;
  }

  return [];
}

export function deriveAllowedDomains(allowedDomains, websiteUrl) {
  const explicitDomains = normalizeAllowedDomains(allowedDomains, { allowEmpty: true });

  if (explicitDomains.length) {
    return explicitDomains;
  }

  const websiteHost = normalizeDomainToken(websiteUrl);
  return websiteHost ? [websiteHost] : [];
}

export function isOriginAllowed(origin, allowedDomains = []) {
  const normalizedOrigin = normalizeOriginValue(origin);
  const normalizedOriginHost = normalizeHost(normalizedOrigin);
  const normalizedAllowedDomains = normalizeAllowedDomains(allowedDomains, { allowEmpty: true });

  if (!normalizedOrigin || !normalizedOriginHost || !normalizedAllowedDomains.length) {
    return false;
  }

  return normalizedAllowedDomains.includes(normalizedOriginHost);
}

function getRecentThresholdMs() {
  return INSTALL_STATUS_STALE_HOURS * 60 * 60 * 1000;
}

function readVerificationDetails(row) {
  const details = row?.last_verification_details;
  return details && typeof details === "object" ? details : {};
}

function pickInstalledAt(rows = [], widgetConfigRow) {
  const seenAt = rows
    .map((row) => row?.first_seen_at || row?.last_seen_at)
    .filter(Boolean)
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0] || null;
  const verificationDetails = readVerificationDetails(widgetConfigRow);
  const verifiedAt = verificationDetails?.matchedInstallId
    ? widgetConfigRow?.last_verified_at || null
    : null;

  return seenAt || verifiedAt || null;
}

function buildVerificationCopy(widgetConfigRow, websiteUrl) {
  const verificationStatus = cleanText(widgetConfigRow?.last_verification_status);
  const verificationTargetUrl = cleanText(widgetConfigRow?.last_verification_target_url || websiteUrl);
  const verificationOrigin = cleanText(widgetConfigRow?.last_verification_origin);
  const details = readVerificationDetails(widgetConfigRow);

  return {
    verificationStatus,
    verificationTargetUrl: verificationTargetUrl || null,
    verificationOrigin: verificationOrigin || null,
    verificationDetails: details,
  };
}

export function buildInstallStatus(rows = [], widgetConfigRow = null, websiteUrl = "") {
  const sortedRows = [...rows].sort((left, right) => {
    return new Date(right.last_seen_at || 0).getTime() - new Date(left.last_seen_at || 0).getTime();
  });
  const latestSeenRow = sortedRows[0] || null;
  const now = Date.now();
  const lastSeenAtMs = latestSeenRow?.last_seen_at ? new Date(latestSeenRow.last_seen_at).getTime() : 0;
  const lastSeenRecently = Boolean(lastSeenAtMs && now - lastSeenAtMs <= getRecentThresholdMs());
  const verification = buildVerificationCopy(widgetConfigRow, websiteUrl);
  const verificationStatus = verification.verificationStatus;
  const matchedInstallId = verification.verificationDetails?.matchedInstallId === true;
  const expectedDomain = normalizeDomainToken(websiteUrl);
  const allowedDomains = deriveAllowedDomains(widgetConfigRow?.allowed_domains, websiteUrl);
  const installedAt = pickInstalledAt(sortedRows, widgetConfigRow);
  const defaultStatus = {
    state: "not_installed",
    label: "Not installed yet",
    host: "",
    pageUrl: null,
    lastSeenAt: null,
    lastSeenUrl: null,
    lastVerifiedAt: widgetConfigRow?.last_verified_at || null,
    verificationStatus: verificationStatus || null,
    verificationTargetUrl: verification.verificationTargetUrl,
    verificationOrigin: verification.verificationOrigin,
    verificationDetails: verification.verificationDetails,
    installId: widgetConfigRow?.install_id || null,
    allowedDomains,
    expectedDomain: expectedDomain || "",
    installedAt,
  };

  if (latestSeenRow) {
    return {
      ...defaultStatus,
      state: lastSeenRecently ? "seen_recently" : "seen_stale",
      label: lastSeenRecently
        ? `Seen recently on ${latestSeenRow.host}`
        : `Seen before on ${latestSeenRow.host}`,
      host: latestSeenRow.host,
      pageUrl: latestSeenRow.page_url || null,
      lastSeenUrl: latestSeenRow.page_url || null,
      lastSeenAt: latestSeenRow.last_seen_at || null,
    };
  }

  if (verificationStatus === VERIFICATION_STATUS.FOUND && matchedInstallId) {
    const targetHost = normalizeDomainToken(verification.verificationTargetUrl) || expectedDomain;

    return {
      ...defaultStatus,
      state: "installed_unseen",
      label: targetHost
        ? `Install detected on ${targetHost}, waiting for first live ping`
        : "Install detected, waiting for first live ping",
      host: targetHost,
    };
  }

  if (verificationStatus === VERIFICATION_STATUS.MISMATCH) {
    return {
      ...defaultStatus,
      state: "domain_mismatch",
      label: "Install mismatch detected",
    };
  }

  if (
    verificationStatus === VERIFICATION_STATUS.NOT_FOUND ||
    verificationStatus === VERIFICATION_STATUS.FETCH_ERROR ||
    verificationStatus === VERIFICATION_STATUS.NO_WEBSITE
  ) {
    return {
      ...defaultStatus,
      state: "verify_failed",
      label: verificationStatus === VERIFICATION_STATUS.NO_WEBSITE
        ? "Website URL missing for verification"
        : "Verification needs attention",
    };
  }

  return defaultStatus;
}

function buildInstallVerificationHints(result) {
  const hints = [];

  if (result.status === VERIFICATION_STATUS.NOT_FOUND) {
    hints.push("Make sure the Vonza snippet is in the live site head or global footer template.");
    hints.push("If your CMS or CDN caches HTML, clear cache and reload the published page.");
    hints.push("Check that the workspace website URL points at the same production environment you updated.");
  }

  if (result.status === VERIFICATION_STATUS.MISMATCH) {
    hints.push("This page appears to load a different Vonza install id than the current assistant.");
    hints.push("Replace older Vonza snippets in your CMS theme or custom code area with the latest install snippet.");
  }

  if (result.status === VERIFICATION_STATUS.FETCH_ERROR) {
    hints.push("The site may block server-side fetches or require a published public page.");
    hints.push("Verify the website URL resolves publicly without login, IP allowlists, or bot protection.");
  }

  return hints;
}

function collectInstallIdsFromHtml(html) {
  const installIds = new Set();
  const patterns = [
    /data-install-id=["']([^"']+)["']/gi,
    /install[_-]id=([a-f0-9-]+)/gi,
  ];

  patterns.forEach((pattern) => {
    let match = pattern.exec(html);
    while (match) {
      const installId = cleanText(match[1]);
      if (installId) {
        installIds.add(installId);
      }
      match = pattern.exec(html);
    }
  });

  return [...installIds];
}

function inspectInstallMarkup(html, installId, publicAppUrl) {
  const rawHtml = String(html || "");
  const normalizedHtml = rawHtml.toLowerCase();
  const normalizedInstallId = cleanText(installId);
  const publicAppHost = normalizeDomainToken(publicAppUrl);
  const foundEmbedScript = normalizedHtml.includes("/embed.js") || (publicAppHost && normalizedHtml.includes(publicAppHost));
  const foundInstallIds = collectInstallIdsFromHtml(rawHtml);
  const matchedInstallId = Boolean(
    normalizedInstallId &&
    (foundInstallIds.includes(normalizedInstallId) || rawHtml.includes(normalizedInstallId))
  );

  if (matchedInstallId) {
    return {
      status: VERIFICATION_STATUS.FOUND,
      found: true,
      matchedInstallId: true,
      foundEmbedScript,
      foundInstallIds,
    };
  }

  if (foundInstallIds.length || foundEmbedScript) {
    return {
      status: VERIFICATION_STATUS.MISMATCH,
      found: true,
      matchedInstallId: false,
      foundEmbedScript,
      foundInstallIds,
    };
  }

  return {
    status: VERIFICATION_STATUS.NOT_FOUND,
    found: false,
    matchedInstallId: false,
    foundEmbedScript: false,
    foundInstallIds: [],
  };
}

function logStructured(message, payload, method = "info") {
  const logger = console[method] || console.log;
  logger(`[install] ${message}`, payload);
}

async function getWidgetConfigRowByAgentId(supabase, agentId) {
  const { data, error } = await supabase
    .from(WIDGET_CONFIGS_TABLE)
    .select(
      "agent_id, install_id, allowed_domains, assistant_name, welcome_message, button_label, primary_color, secondary_color, launcher_text, theme_mode, last_verification_status, last_verified_at, last_verification_origin, last_verification_target_url, last_verification_details"
    )
    .eq("agent_id", agentId)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error, WIDGET_CONFIGS_TABLE)) {
      return null;
    }

    console.error(error);
    throw error;
  }

  return data || null;
}

async function getWidgetConfigRowByInstallId(supabase, installId) {
  const normalizedInstallId = cleanText(installId);

  if (!normalizedInstallId) {
    return null;
  }

  const { data, error } = await supabase
    .from(WIDGET_CONFIGS_TABLE)
    .select(
      "agent_id, install_id, allowed_domains, assistant_name, welcome_message, button_label, primary_color, secondary_color, launcher_text, theme_mode, last_verification_status, last_verified_at, last_verification_origin, last_verification_target_url, last_verification_details"
    )
    .eq("install_id", normalizedInstallId)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error, WIDGET_CONFIGS_TABLE)) {
      return null;
    }

    console.error(error);
    throw error;
  }

  return data || null;
}

async function getAgentAndBusinessByAgentId(supabase, agentId) {
  const normalizedAgentId = cleanText(agentId);

  if (!normalizedAgentId) {
    return null;
  }

  const { data: agentRow, error: agentError } = await supabase
    .from(AGENTS_TABLE)
    .select("id, business_id, public_agent_key, name, is_active")
    .eq("id", normalizedAgentId)
    .maybeSingle();

  if (agentError) {
    if (isMissingRelationError(agentError, AGENTS_TABLE)) {
      return null;
    }

    console.error(agentError);
    throw agentError;
  }

  if (!agentRow) {
    return null;
  }

  const { data: businessRow, error: businessError } = await supabase
    .from(BUSINESSES_TABLE)
    .select("id, name, website_url")
    .eq("id", agentRow.business_id)
    .maybeSingle();

  if (businessError) {
    if (isMissingRelationError(businessError, BUSINESSES_TABLE)) {
      return {
        agent: agentRow,
        business: null,
      };
    }

    console.error(businessError);
    throw businessError;
  }

  return {
    agent: agentRow,
    business: businessRow || null,
  };
}

export async function getWidgetInstallContextByInstallId(supabase, installId) {
  const widgetConfigRow = await getWidgetConfigRowByInstallId(supabase, installId);

  if (!widgetConfigRow?.agent_id) {
    return null;
  }

  const context = await getAgentAndBusinessByAgentId(supabase, widgetConfigRow.agent_id);

  if (!context?.agent || context.agent.is_active === false) {
    return null;
  }

  return {
    ...context,
    widgetConfigRow,
    allowedDomains: deriveAllowedDomains(widgetConfigRow.allowed_domains, context.business?.website_url || ""),
  };
}

export async function getWidgetInstallContextByAgentId(supabase, agentId) {
  const normalizedAgentId = cleanText(agentId);
  const widgetConfigRow = await getWidgetConfigRowByAgentId(supabase, normalizedAgentId);
  const context = await getAgentAndBusinessByAgentId(supabase, normalizedAgentId);

  if (!context?.agent) {
    return null;
  }

  return {
    ...context,
    widgetConfigRow,
    allowedDomains: deriveAllowedDomains(widgetConfigRow?.allowed_domains, context.business?.website_url || ""),
  };
}

export async function updateInstallVerificationState(supabase, agentId, payload = {}) {
  const normalizedAgentId = cleanText(agentId);

  if (!normalizedAgentId) {
    return;
  }

  const { error } = await supabase
    .from(WIDGET_CONFIGS_TABLE)
    .update({
      last_verification_status: cleanText(payload.status) || null,
      last_verified_at: payload.verifiedAt || new Date().toISOString(),
      last_verification_origin: cleanText(payload.origin) || null,
      last_verification_target_url: cleanText(payload.targetUrl) || null,
      last_verification_details:
        payload.details && typeof payload.details === "object" ? payload.details : {},
    })
    .eq("agent_id", normalizedAgentId);

  if (error) {
    if (isMissingRelationError(error, WIDGET_CONFIGS_TABLE)) {
      return;
    }

    console.error(error);
    throw error;
  }
}

export function logWidgetInitFailure(payload = {}) {
  logStructured(
    "widget_init_failure",
    {
      reason: cleanText(payload.reason) || "unknown",
      installId: cleanText(payload.installId) || null,
      origin: cleanText(payload.origin) || null,
      pageUrl: cleanText(payload.pageUrl) || null,
      allowedDomains: normalizeAllowedDomains(payload.allowedDomains, { allowEmpty: true }),
      message: cleanText(payload.message) || null,
    },
    "warn"
  );
}

export async function recordInstallPing(
  supabase,
  { installId, origin, pageUrl, sessionId, fingerprint, timestamp }
) {
  const context = await getWidgetInstallContextByInstallId(supabase, installId);
  const normalizedOrigin = normalizeOriginValue(origin);
  const parsedPageUrl = parseAbsoluteUrl(pageUrl);
  const normalizedPageUrl = parsedPageUrl ? parsedPageUrl.toString() : "";
  const seenAt = normalizeTimestamp(timestamp) || new Date().toISOString();

  if (!context) {
    const error = new Error("Install not found");
    error.statusCode = 404;
    throw error;
  }

  if (!normalizedOrigin) {
    const error = new Error("origin is required");
    error.statusCode = 400;
    throw error;
  }

  if (!isOriginAllowed(normalizedOrigin, context.allowedDomains)) {
    logWidgetInitFailure({
      reason: "domain_blocked",
      installId,
      origin: normalizedOrigin,
      pageUrl: normalizedPageUrl,
      allowedDomains: context.allowedDomains,
      message: "Origin is not on the install allowlist.",
    });
    const error = new Error("Origin is not allowed for this install.");
    error.statusCode = 403;
    error.code = "domain_blocked";
    throw error;
  }

  const host = normalizeHost(normalizedOrigin);
  const { data: existingRow, error: lookupError } = await supabase
    .from(AGENT_INSTALLATIONS_TABLE)
    .select("id")
    .eq("agent_id", context.agent.id)
    .eq("host", host)
    .maybeSingle();

  if (lookupError) {
    if (isMissingRelationError(lookupError, AGENT_INSTALLATIONS_TABLE)) {
      return { ok: false, skipped: true };
    }

    console.error(lookupError);
    throw lookupError;
  }

  const payload = {
    agent_id: context.agent.id,
    host,
    origin: normalizedOrigin,
    page_url: normalizedPageUrl || null,
    last_seen_at: seenAt,
    last_session_id: cleanText(sessionId) || null,
    last_fingerprint: cleanText(fingerprint) || null,
  };

  if (existingRow?.id) {
    const { error: updateError } = await supabase
      .from(AGENT_INSTALLATIONS_TABLE)
      .update(payload)
      .eq("id", existingRow.id);

    if (updateError) {
      console.error(updateError);
      throw updateError;
    }
  } else {
    const { error: insertError } = await supabase
      .from(AGENT_INSTALLATIONS_TABLE)
      .insert({
        ...payload,
        first_seen_at: seenAt,
      });

    if (insertError) {
      if (isMissingRelationError(insertError, AGENT_INSTALLATIONS_TABLE)) {
        return { ok: false, skipped: true };
      }

      console.error(insertError);
      throw insertError;
    }
  }

  return {
    ok: true,
    agentId: context.agent.id,
    installId: context.widgetConfigRow?.install_id || null,
    host,
    origin: normalizedOrigin,
  };
}

export async function recordInstallPresence(supabase, { installId, origin, pageUrl, sessionId, fingerprint, timestamp }) {
  return recordInstallPing(supabase, {
    installId,
    origin,
    pageUrl,
    sessionId,
    fingerprint,
    timestamp,
  });
}

export async function verifyAgentInstallation(supabase, { agentId, fetchImpl = fetch } = {}) {
  const context = await getWidgetInstallContextByAgentId(supabase, agentId);

  if (!context?.agent) {
    const error = new Error("Agent not found");
    error.statusCode = 404;
    throw error;
  }

  const websiteUrl = cleanText(context.business?.website_url || "");
  const installId = cleanText(context.widgetConfigRow?.install_id || "");

  if (!websiteUrl) {
    const result = {
      ok: false,
      status: VERIFICATION_STATUS.NO_WEBSITE,
      found: false,
      matchedInstallId: false,
      targetUrl: null,
      httpStatus: null,
      hints: buildInstallVerificationHints({ status: VERIFICATION_STATUS.NO_WEBSITE }),
    };

    await updateInstallVerificationState(supabase, context.agent.id, {
      status: result.status,
      targetUrl: null,
      origin: null,
      details: {
        found: false,
        matchedInstallId: false,
        httpStatus: null,
        hints: result.hints,
      },
    });

    return result;
  }

  const verifiedAt = new Date().toISOString();

  try {
    const response = await fetchImpl(websiteUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "VonzaInstallVerifier/1.0",
        accept: "text/html,application/xhtml+xml",
      },
    });
    const html = await response.text();
    const inspected = inspectInstallMarkup(html, installId, getPublicAppUrl());
    const targetUrl = cleanText(response.url || websiteUrl) || websiteUrl;
    const origin = normalizeOriginValue(targetUrl) || null;
    const result = {
      ok: inspected.status === VERIFICATION_STATUS.FOUND,
      status: inspected.status,
      found: inspected.found,
      matchedInstallId: inspected.matchedInstallId,
      installId,
      targetUrl,
      origin,
      httpStatus: response.status,
      foundInstallIds: inspected.foundInstallIds,
      foundEmbedScript: inspected.foundEmbedScript,
      hints: buildInstallVerificationHints(inspected),
    };

    await updateInstallVerificationState(supabase, context.agent.id, {
      status: result.status,
      verifiedAt,
      targetUrl,
      origin,
      details: {
        found: result.found,
        matchedInstallId: result.matchedInstallId,
        foundInstallIds: result.foundInstallIds,
        foundEmbedScript: result.foundEmbedScript,
        httpStatus: result.httpStatus,
        hints: result.hints,
      },
    });

    logStructured("verification_result", {
      agentId: context.agent.id,
      installId,
      status: result.status,
      httpStatus: result.httpStatus,
      targetUrl: result.targetUrl,
      matchedInstallId: result.matchedInstallId,
      foundInstallIds: result.foundInstallIds,
    });

    return result;
  } catch (error) {
    const status = VERIFICATION_STATUS.FETCH_ERROR;
    const result = {
      ok: false,
      status,
      found: false,
      matchedInstallId: false,
      installId,
      targetUrl: websiteUrl,
      origin: normalizeOriginValue(websiteUrl) || null,
      httpStatus: null,
      error: error.message || "Verification failed",
      hints: buildInstallVerificationHints({ status }),
    };

    await updateInstallVerificationState(supabase, context.agent.id, {
      status,
      verifiedAt,
      targetUrl: websiteUrl,
      origin: result.origin,
      details: {
        found: false,
        matchedInstallId: false,
        httpStatus: null,
        error: result.error,
        hints: result.hints,
      },
    });

    logStructured(
      "verification_result",
      {
        agentId: context.agent.id,
        installId,
        status,
        targetUrl: websiteUrl,
        error: result.error,
      },
      "warn"
    );

    return result;
  }
}

export async function listInstallStatusByAgentIds(supabase, agentIds = []) {
  if (!agentIds.length) {
    return new Map();
  }

  const { data: installRows, error: installError } = await supabase
    .from(AGENT_INSTALLATIONS_TABLE)
    .select("agent_id, host, origin, page_url, first_seen_at, last_seen_at, last_session_id, last_fingerprint")
    .in("agent_id", agentIds);

  if (installError) {
    if (isMissingRelationError(installError, AGENT_INSTALLATIONS_TABLE)) {
      return new Map();
    }

    console.error(installError);
    throw installError;
  }

  const { data: widgetRows, error: widgetError } = await supabase
    .from(WIDGET_CONFIGS_TABLE)
    .select(
      "agent_id, install_id, allowed_domains, last_verification_status, last_verified_at, last_verification_origin, last_verification_target_url, last_verification_details"
    )
    .in("agent_id", agentIds);

  if (widgetError) {
    if (isMissingRelationError(widgetError, WIDGET_CONFIGS_TABLE)) {
      return new Map();
    }

    console.error(widgetError);
    throw widgetError;
  }

  const { data: agentRows, error: agentError } = await supabase
    .from(AGENTS_TABLE)
    .select("id, business_id")
    .in("id", agentIds);

  if (agentError) {
    if (isMissingRelationError(agentError, AGENTS_TABLE)) {
      return new Map();
    }

    console.error(agentError);
    throw agentError;
  }

  const businessIds = [...new Set((agentRows || []).map((row) => row.business_id).filter(Boolean))];
  let businessesById = new Map();

  if (businessIds.length) {
    const { data: businessRows, error: businessError } = await supabase
      .from(BUSINESSES_TABLE)
      .select("id, website_url")
      .in("id", businessIds);

    if (businessError) {
      if (!isMissingRelationError(businessError, BUSINESSES_TABLE)) {
        console.error(businessError);
        throw businessError;
      }
    } else {
      businessesById = new Map((businessRows || []).map((row) => [row.id, row]));
    }
  }

  const agentRowsById = new Map((agentRows || []).map((row) => [row.id, row]));
  const widgetRowsByAgentId = new Map((widgetRows || []).map((row) => [row.agent_id, row]));
  const installRowsByAgentId = new Map();

  (installRows || []).forEach((row) => {
    const existingRows = installRowsByAgentId.get(row.agent_id) || [];
    existingRows.push(row);
    installRowsByAgentId.set(row.agent_id, existingRows);
  });

  return new Map(
    agentIds.map((agentId) => {
      const agentRow = agentRowsById.get(agentId) || null;
      const businessWebsiteUrl = businessesById.get(agentRow?.business_id)?.website_url || "";
      return [
        agentId,
        buildInstallStatus(
          installRowsByAgentId.get(agentId) || [],
          widgetRowsByAgentId.get(agentId) || null,
          businessWebsiteUrl
        ),
      ];
    })
  );
}

export async function assertInstallSchemaReady(supabase) {
  const checks = [
    {
      table: WIDGET_CONFIGS_TABLE,
      columns: "install_id, allowed_domains, last_verification_status, last_verified_at, last_verification_origin, last_verification_target_url, last_verification_details",
    },
    {
      table: AGENT_INSTALLATIONS_TABLE,
      columns: "origin, last_session_id, last_fingerprint",
    },
  ];

  for (const check of checks) {
    const { error } = await supabase.from(check.table).select(check.columns).limit(1);

    if (error) {
      if (isMissingRelationError(error, check.table) || error?.code === "42703") {
        const schemaError = new Error(
          `[startup] Missing required install schema for '${check.table}'. Apply the latest database migration before starting this build.`
        );
        schemaError.statusCode = 500;
        throw schemaError;
      }

      throw error;
    }
  }
}

import { MESSAGES_TABLE } from "../../config/constants.js";
import { cleanText } from "../../utils/text.js";

function isMissingMessagesTable(error) {
  const message = cleanText(error?.message || "").toLowerCase();
  return (
    error?.code === "PGRST205" ||
    error?.code === "42P01" ||
    message.includes(`'public.${MESSAGES_TABLE}'`) ||
    message.includes(`${MESSAGES_TABLE} was not found`)
  );
}

export async function storeAgentMessages(supabase, agentId, entries = []) {
  const normalizedAgentId = cleanText(agentId);
  const seenEntries = new Set();
  const payload = entries
    .map((entry) => ({
      agent_id: normalizedAgentId,
      role: cleanText(entry.role),
      content: cleanText(entry.content),
      created_at: new Date().toISOString(),
    }))
    .filter((entry) => {
      if (!normalizedAgentId || !entry.role || !entry.content) {
        return false;
      }

      const dedupeKey = `${entry.role}::${entry.content}`;

      if (seenEntries.has(dedupeKey)) {
        return false;
      }

      seenEntries.add(dedupeKey);
      return true;
    });

  if (!payload.length) {
    return;
  }

  const { error } = await supabase.from(MESSAGES_TABLE).insert(payload);

  if (error) {
    if (isMissingMessagesTable(error)) {
      console.warn(`Messages table '${MESSAGES_TABLE}' is missing; skipping message storage.`);
      return;
    }

    console.error(error);
    throw error;
  }
}

export async function listAgentMessages(supabase, agentId) {
  const normalizedAgentId = cleanText(agentId);

  if (!normalizedAgentId) {
    const error = new Error("agent_id is required");
    error.statusCode = 400;
    throw error;
  }

  const { data, error } = await supabase
    .from(MESSAGES_TABLE)
    .select("id, agent_id, role, content, created_at")
    .eq("agent_id", normalizedAgentId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    if (isMissingMessagesTable(error)) {
      return [];
    }

    console.error(error);
    throw error;
  }

  return (data || []).map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export async function getAgentMessageStats(supabase, agentIds = []) {
  const normalizedAgentIds = agentIds.map((agentId) => cleanText(agentId)).filter(Boolean);

  if (!normalizedAgentIds.length) {
    return new Map();
  }

  const { data, error } = await supabase
    .from(MESSAGES_TABLE)
    .select("agent_id, created_at")
    .in("agent_id", normalizedAgentIds)
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingMessagesTable(error)) {
      return new Map();
    }

    console.error(error);
    throw error;
  }

  const stats = new Map();

  for (const row of data || []) {
    const agentId = row.agent_id;
    const existing = stats.get(agentId);

    if (!existing) {
      stats.set(agentId, {
        messageCount: 1,
        lastMessageAt: row.created_at || null,
      });
      continue;
    }

    existing.messageCount += 1;
  }

  return stats;
}

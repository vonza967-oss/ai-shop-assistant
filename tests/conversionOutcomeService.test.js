import test from "node:test";
import assert from "node:assert/strict";

import {
  detectConversionOutcomesForPage,
  listConversionOutcomesForAgent,
  markManualConversionOutcome,
  recordOutcomeEvent,
  recordTrackedCtaClick,
} from "../src/services/conversion/conversionOutcomeService.js";

function createSupabaseStub(initialState = {}) {
  const state = {
    agents: (initialState.agents || []).map((row) => ({ ...row })),
    businesses: (initialState.businesses || []).map((row) => ({ ...row })),
    widget_configs: (initialState.widget_configs || []).map((row) => ({ ...row })),
    agent_contact_leads: (initialState.agent_contact_leads || []).map((row) => ({ ...row })),
    agent_conversion_outcomes: (initialState.agent_conversion_outcomes || []).map((row) => ({ ...row })),
    agent_action_queue_statuses: (initialState.agent_action_queue_statuses || []).map((row) => ({ ...row })),
  };

  class QueryBuilder {
    constructor(table) {
      this.table = table;
      this.operation = "select";
      this.filters = [];
      this.values = null;
      this.limitCount = null;
      this.sortColumn = null;
      this.sortAscending = true;
      this.selectUsed = false;
    }

    select() {
      this.selectUsed = true;
      return this;
    }

    eq(column, value) {
      this.filters.push((row) => row[column] === value);
      return this;
    }

    in(column, values) {
      const lookup = new Set(values);
      this.filters.push((row) => lookup.has(row[column]));
      return this;
    }

    order(column, options = {}) {
      this.sortColumn = column;
      this.sortAscending = options.ascending !== false;
      return this;
    }

    limit(count) {
      this.limitCount = count;
      return this;
    }

    update(values) {
      this.operation = "update";
      this.values = values;
      return this;
    }

    insert(values) {
      this.operation = "insert";
      this.values = values;
      return this;
    }

    upsert(values) {
      this.operation = "upsert";
      this.values = values;
      return this;
    }

    maybeSingle() {
      return Promise.resolve(this.#executeSingle());
    }

    single() {
      return Promise.resolve(this.#executeSingle());
    }

    then(resolve, reject) {
      return Promise.resolve(this.#execute()).then(resolve, reject);
    }

    #rows() {
      return state[this.table];
    }

    #matches() {
      let rows = this.#rows().filter((row) => this.filters.every((filter) => filter(row)));

      if (this.sortColumn) {
        rows = rows.slice().sort((left, right) => {
          const leftValue = new Date(left[this.sortColumn] || 0).getTime();
          const rightValue = new Date(right[this.sortColumn] || 0).getTime();
          return this.sortAscending ? leftValue - rightValue : rightValue - leftValue;
        });
      }

      if (this.limitCount !== null) {
        rows = rows.slice(0, this.limitCount);
      }

      return rows;
    }

    #executeSingle() {
      const result = this.#execute();
      const rows = Array.isArray(result.data) ? result.data : [];
      return {
        data: rows[0] ? { ...rows[0] } : null,
        error: result.error || null,
      };
    }

    #execute() {
      if (this.operation === "select") {
        return {
          data: this.#matches().map((row) => ({ ...row })),
          error: null,
        };
      }

      if (this.operation === "update") {
        const matches = this.#matches();
        matches.forEach((row) => Object.assign(row, this.values));
        return {
          data: matches.map((row) => ({ ...row })),
          error: null,
        };
      }

      if (this.operation === "insert") {
        const values = Array.isArray(this.values) ? this.values : [this.values];
        const rows = this.#rows();

        if (this.table === "agent_conversion_outcomes") {
          const duplicate = values.find((value) => rows.some((row) => row.dedupe_key === value.dedupe_key));
          if (duplicate) {
            return {
              data: null,
              error: {
                code: "23505",
                message: "duplicate key value violates unique constraint",
              },
            };
          }
        }

        values.forEach((value, index) => {
          rows.push({
            id: value.id || `${this.table}-${rows.length + index + 1}`,
            ...value,
          });
        });

        return {
          data: values.map((value, index) => ({
            id: value.id || `${this.table}-${rows.length - values.length + index + 1}`,
            ...value,
          })),
          error: null,
        };
      }

      if (this.operation === "upsert") {
        const values = Array.isArray(this.values) ? this.values : [this.values];
        const rows = this.#rows();
        const data = [];

        values.forEach((value, index) => {
          let existing = null;

          if (this.table === "agent_action_queue_statuses") {
            existing = rows.find((row) => row.agent_id === value.agent_id && row.action_key === value.action_key);
          }

          if (existing) {
            Object.assign(existing, value);
            data.push({ ...existing });
            return;
          }

          const nextRow = {
            id: value.id || `${this.table}-${rows.length + index + 1}`,
            ...value,
          };
          rows.push(nextRow);
          data.push({ ...nextRow });
        });

        return {
          data,
          error: null,
        };
      }

      throw new Error(`Unsupported operation ${this.operation}`);
    }
  }

  return {
    from(table) {
      return new QueryBuilder(table);
    },
    state,
  };
}

function createOutcomeState() {
  return createSupabaseStub({
    agents: [
      {
        id: "agent-1",
        business_id: "business-1",
        owner_user_id: "owner-1",
        public_agent_key: "agent-key",
        name: "Vonza",
        is_active: true,
      },
    ],
    businesses: [
      {
        id: "business-1",
        name: "Example Co",
        website_url: "https://example.com",
      },
    ],
    widget_configs: [
      {
        id: "widget-1",
        agent_id: "agent-1",
        install_id: "11111111-1111-1111-1111-111111111111",
        allowed_domains: ["example.com"],
        booking_success_url: "https://example.com/book/thanks",
        quote_success_url: "https://example.com/quote/thanks",
        checkout_success_url: "https://example.com/checkout/complete",
        success_url_match_mode: "path_prefix",
      },
    ],
    agent_contact_leads: [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        agent_id: "agent-1",
        owner_user_id: "owner-1",
        lead_key: "person:person-1",
        person_key: "person-1",
        visitor_session_key: "session-1",
        latest_action_type: "booking_intent",
        latest_action_key: "action-1",
        related_action_keys: ["action-1"],
        related_follow_up_id: null,
        contact_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      },
      {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        agent_id: "agent-1",
        owner_user_id: "owner-1",
        lead_key: "person:person-2",
        person_key: "person-2",
        visitor_session_key: "session-2",
        latest_action_type: "pricing_interest",
        latest_action_key: "action-2",
        related_action_keys: ["action-2"],
        related_follow_up_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        contact_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      },
    ],
  });
}

test("tracked booking CTA click is persisted and keeps attribution context", async () => {
  const supabase = createOutcomeState();

  const result = await recordTrackedCtaClick(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    sessionId: "session-1",
    ctaType: "booking",
    targetType: "url",
    targetUrl: "https://example.com/book",
    actionKey: "action-1",
    leadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    personKey: "person-1",
    relatedIntentType: "booking",
    pageUrl: "https://example.com/pricing",
  });

  assert.equal(result.ok, true);
  assert.equal(supabase.state.agent_conversion_outcomes.length, 1);
  assert.equal(supabase.state.agent_conversion_outcomes[0].outcome_type, "booking_started");
  assert.equal(supabase.state.agent_conversion_outcomes[0].action_key, "action-1");
  assert.equal(supabase.state.agent_conversion_outcomes[0].lead_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  assert.equal(supabase.state.agent_conversion_outcomes[0].contact_id, "dddddddd-dddd-dddd-dddd-dddddddddddd");
  assert.match(result.redirectUrl, /vz_cta_event_id=/);
});

test("booking success page creates booking_confirmed and resolves the related queue state", async () => {
  const supabase = createOutcomeState();
  const click = await recordTrackedCtaClick(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    sessionId: "session-1",
    ctaType: "booking",
    targetType: "url",
    targetUrl: "https://example.com/book",
    actionKey: "action-1",
    leadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    personKey: "person-1",
    relatedIntentType: "booking",
  });

  const detected = await detectConversionOutcomesForPage(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    sessionId: "session-1",
    ctaEventId: click.ctaEventId,
    pageUrl: `https://example.com/book/thanks?v=1&vz_cta_event_id=${click.ctaEventId}`,
  });

  assert.equal(detected.matched, true);
  assert.equal(detected.detectedOutcomes[0].outcomeType, "booking_confirmed");
  assert.equal(supabase.state.agent_conversion_outcomes.length, 2);
  assert.equal(supabase.state.agent_action_queue_statuses.length, 1);
  assert.equal(supabase.state.agent_action_queue_statuses[0].status, "done");
  assert.equal(supabase.state.agent_action_queue_statuses[0].follow_up_completed, true);
});

test("quote and checkout success paths create the right canonical outcomes", async () => {
  const supabase = createOutcomeState();
  const quoteClick = await recordTrackedCtaClick(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    sessionId: "session-2",
    ctaType: "quote",
    targetType: "url",
    targetUrl: "https://example.com/quote",
    actionKey: "action-2",
    leadId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    followUpId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    personKey: "person-2",
    relatedIntentType: "pricing",
  });
  await detectConversionOutcomesForPage(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    sessionId: "session-2",
    ctaEventId: quoteClick.ctaEventId,
    pageUrl: `https://example.com/quote/thanks?vz_cta_event_id=${quoteClick.ctaEventId}`,
  });

  const checkoutClick = await recordTrackedCtaClick(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    sessionId: "session-3",
    ctaType: "checkout",
    targetType: "url",
    targetUrl: "https://example.com/checkout",
    actionKey: "action-3",
    relatedIntentType: "pricing",
  });
  await detectConversionOutcomesForPage(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    sessionId: "session-3",
    ctaEventId: checkoutClick.ctaEventId,
    pageUrl: `https://example.com/checkout/complete?vz_cta_event_id=${checkoutClick.ctaEventId}`,
  });

  const outcomeTypes = supabase.state.agent_conversion_outcomes.map((row) => row.outcome_type);
  assert.ok(outcomeTypes.includes("quote_requested"));
  assert.ok(outcomeTypes.includes("checkout_completed"));

  const summary = await listConversionOutcomesForAgent(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
  });

  assert.equal(summary.summary.bookingConfirmed, 0);
  assert.equal(summary.summary.quoteRequested, 1);
  assert.equal(summary.summary.checkoutCompleted, 1);
  assert.equal(summary.summary.followUpAssistedOutcomeCount, 1);
});

test("contact clicks are tracked separately from confirmed conversions", async () => {
  const supabase = createOutcomeState();

  await recordTrackedCtaClick(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    sessionId: "session-4",
    ctaType: "contact",
    targetType: "phone",
    targetUrl: "tel:+15555555555",
    actionKey: "action-4",
    relatedIntentType: "contact",
  });

  const summary = await listConversionOutcomesForAgent(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
  });

  assert.equal(summary.summary.phoneClicked, 1);
  assert.equal(summary.summary.confirmedBusinessOutcomes, 0);
  assert.equal(summary.summary.assistedConversions, 1);
});

test("manual outcome marking dedupes repeated marks and keeps reload-safe reporting", async () => {
  const supabase = createOutcomeState();

  const first = await markManualConversionOutcome(supabase, {
    agentId: "agent-1",
    businessId: "business-1",
    ownerUserId: "owner-1",
    outcomeType: "checkout_completed",
    actionKey: "action-5",
    note: "Owner confirmed this manually.",
  });
  const duplicate = await markManualConversionOutcome(supabase, {
    agentId: "agent-1",
    businessId: "business-1",
    ownerUserId: "owner-1",
    outcomeType: "checkout_completed",
    actionKey: "action-5",
    note: "Owner confirmed this manually.",
  });

  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(supabase.state.agent_conversion_outcomes.length, 1);

  const summary = await listConversionOutcomesForAgent(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
  });

  assert.equal(summary.summary.checkoutCompleted, 1);
  assert.equal(summary.recentOutcomes.length, 1);
});

test("cross-channel operator outcomes persist contact-linked context and dedupe safely", async () => {
  const supabase = createOutcomeState();

  const first = await recordOutcomeEvent(supabase, {
    agentId: "agent-1",
    businessId: "business-1",
    ownerUserId: "owner-1",
    outcomeType: "campaign_replied",
    sourceType: "campaign",
    confirmationLevel: "confirmed",
    contactId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    leadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    campaignId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    campaignRecipientId: "99999999-9999-9999-9999-999999999999",
    inboxThreadId: "88888888-8888-8888-8888-888888888888",
    dedupeKey: "campaign-reply-1",
  });
  const duplicate = await recordOutcomeEvent(supabase, {
    agentId: "agent-1",
    businessId: "business-1",
    ownerUserId: "owner-1",
    outcomeType: "campaign_replied",
    sourceType: "campaign",
    confirmationLevel: "confirmed",
    contactId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    leadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    campaignId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    campaignRecipientId: "99999999-9999-9999-9999-999999999999",
    inboxThreadId: "88888888-8888-8888-8888-888888888888",
    dedupeKey: "campaign-reply-1",
  });

  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(supabase.state.agent_conversion_outcomes.length, 1);
  assert.equal(supabase.state.agent_conversion_outcomes[0].contact_id, "dddddddd-dddd-dddd-dddd-dddddddddddd");
  assert.equal(supabase.state.agent_conversion_outcomes[0].campaign_id, "ffffffff-ffff-ffff-ffff-ffffffffffff");
  assert.equal(supabase.state.agent_conversion_outcomes[0].campaign_recipient_id, "99999999-9999-9999-9999-999999999999");
  assert.equal(supabase.state.agent_conversion_outcomes[0].inbox_thread_id, "88888888-8888-8888-8888-888888888888");

  const summary = await listConversionOutcomesForAgent(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
  });

  assert.equal(summary.summary.campaignReplied, 1);
  assert.equal(summary.summary.pathCounts.campaign, 1);
});

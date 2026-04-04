const FEATURE_STATES = Object.freeze({
  STABLE: "stable",
  BETA: "beta",
  HIDDEN: "hidden",
});

const PUBLIC_COHORT_V1_MATRIX = Object.freeze({
  marketing_site: {
    state: FEATURE_STATES.STABLE,
    label: "Marketing site",
  },
  signup_auth: {
    state: FEATURE_STATES.STABLE,
    label: "Signup and auth",
  },
  checkout: {
    state: FEATURE_STATES.STABLE,
    label: "Checkout",
  },
  front_desk: {
    state: FEATURE_STATES.STABLE,
    label: "AI front desk",
  },
  website_import: {
    state: FEATURE_STATES.STABLE,
    label: "Website import",
  },
  widget_install: {
    state: FEATURE_STATES.STABLE,
    label: "Widget install",
  },
  today: {
    state: FEATURE_STATES.STABLE,
    label: "Today",
  },
  contacts: {
    state: FEATURE_STATES.STABLE,
    label: "Contacts",
  },
  outcomes: {
    state: FEATURE_STATES.STABLE,
    label: "Outcomes",
  },
  customize: {
    state: FEATURE_STATES.STABLE,
    label: "Customize",
  },
  lead_capture: {
    state: FEATURE_STATES.STABLE,
    label: "Lead capture",
  },
  google_connect: {
    state: FEATURE_STATES.BETA,
    label: "Google connect",
  },
  inbox: {
    state: FEATURE_STATES.BETA,
    label: "Inbox",
  },
  calendar: {
    state: FEATURE_STATES.BETA,
    label: "Calendar",
  },
  automations: {
    state: FEATURE_STATES.BETA,
    label: "Automations",
  },
  advanced_guidance: {
    state: FEATURE_STATES.HIDDEN,
    label: "Advanced guidance",
  },
  manual_outcome_marks: {
    state: FEATURE_STATES.HIDDEN,
    label: "Manual outcome marks",
  },
  knowledge_fix_workflows: {
    state: FEATURE_STATES.HIDDEN,
    label: "Knowledge-fix workflows",
  },
});

function cloneMatrix(matrix) {
  return Object.fromEntries(
    Object.entries(matrix).map(([key, value]) => [key, { ...value }])
  );
}

function buildStateLists(matrix) {
  const entries = Object.entries(matrix);

  return {
    stable: entries.filter(([, value]) => value.state === FEATURE_STATES.STABLE).map(([key]) => key),
    beta: entries.filter(([, value]) => value.state === FEATURE_STATES.BETA).map(([key]) => key),
    hidden: entries.filter(([, value]) => value.state === FEATURE_STATES.HIDDEN).map(([key]) => key),
  };
}

export function getPublicLaunchProfile({ operatorWorkspaceEnabled = false } = {}) {
  const matrix = cloneMatrix(PUBLIC_COHORT_V1_MATRIX);

  if (!operatorWorkspaceEnabled) {
    matrix.google_connect.state = FEATURE_STATES.HIDDEN;
    matrix.inbox.state = FEATURE_STATES.HIDDEN;
    matrix.calendar.state = FEATURE_STATES.HIDDEN;
    matrix.automations.state = FEATURE_STATES.HIDDEN;
    matrix.contacts.state = FEATURE_STATES.HIDDEN;
  }

  return {
    mode: "public_cohort_v1",
    product: {
      name: "Vonza Front Desk",
      headline: "AI front desk for service businesses with a daily owner workspace.",
      purchaseSummary:
        "The first public offer is the AI front desk plus Today, Contacts, Outcomes, website import, and install. Google-connected Inbox, Calendar, and Automations stay optional beta surfaces when enabled.",
    },
    icp: {
      key: "service_businesses_with_inbound_leads",
      label: "Service businesses with inbound leads",
      shortLabel: "Service businesses",
      examples: ["home services", "clinics", "studios", "agencies", "consultants"],
      positioning:
        "Best for SMBs that already get website visitors asking for quotes, bookings, callbacks, or availability and need a reliable front desk before a bigger back-office system.",
    },
    matrix,
    ...buildStateLists(matrix),
  };
}

export { FEATURE_STATES };

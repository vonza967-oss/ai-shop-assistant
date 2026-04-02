// Root DOM references and persisted dashboard state
const rootEl = document.getElementById("dashboard-root");
const statusBanner = document.getElementById("status-banner");
const topbarMeta = document.getElementById("topbar-meta");

const CLIENT_ID_STORAGE_KEY = "vonza_client_id";
const INSTALL_STORAGE_PREFIX = "vonza_install_progress_";
const LAUNCH_STORAGE_KEY = "vonza_launch_state";
const DASHBOARD_FOCUS_KEY = "vonza_dashboard_focus";
const HANDOFF_STORAGE_KEY = "vonza_dashboard_handoff_seen";
const DASHBOARD_SOURCE_KEY = "vonza_dashboard_source";
const DASHBOARD_SECTION_KEY = "vonza_dashboard_section";
const CLAIM_DISMISS_PREFIX = "vonza_claim_dismissed_";
const LIMITED_CONTENT_MARKER = "Limited content available. This assistant may give general answers.";
const LAUNCH_STEPS = [
  {
    title: "Creating your assistant",
    copy: "Setting up the core identity of your assistant."
  },
  {
    title: "Connecting your website",
    copy: "Saving the website and brand details your assistant should represent."
  },
  {
    title: "Importing website knowledge",
    copy: "Reading the most useful parts of your website. This can take a moment."
  },
  {
    title: "Preparing your preview",
    copy: "Getting the live experience ready so you can try it right away."
  },
  {
    title: "Finalizing setup",
    copy: "Putting the finishing touches in place before we bring you into the studio."
  }
];
const trackedEventKeys = new Set();
const SHELL_SECTIONS = ["overview", "customize", "analytics"];
const ACTION_QUEUE_STATUSES = ["new", "reviewed", "done", "dismissed"];
const AUTH_VIEW_MODES = {
  SIGN_IN: "sign-in",
  SIGN_UP: "sign-up",
  RESET: "reset",
  MAGIC: "magic",
  UPDATE_PASSWORD: "update-password",
};
let authClient = null;
let authSession = null;
let authUser = null;
let authViewMode = AUTH_VIEW_MODES.SIGN_UP;
let authFeedback = null;
let authStateListenerBound = false;

function isDevFakeBillingEnabled() {
  return Boolean(window.VONZA_DEV_FAKE_BILLING);
}

function getPublicAppUrl() {
  return (window.VONZA_PUBLIC_APP_URL || window.location.origin).replace(/\/$/, "");
}

function hasAuthConfig() {
  return Boolean(window.VONZA_SUPABASE_URL && window.VONZA_SUPABASE_ANON_KEY && window.supabase?.createClient);
}

function getAuthHeaders(additionalHeaders = {}) {
  const headers = { ...additionalHeaders };

  if (authSession?.access_token) {
    headers.Authorization = `Bearer ${authSession.access_token}`;
  }

  return headers;
}

function renderTopbarMeta() {
  if (!topbarMeta) {
    return;
  }

  if (authUser?.email) {
    topbarMeta.innerHTML = `
      <span class="topbar-email">${escapeHtml(authUser.email)}</span>
      <button class="topbar-button" type="button" id="sign-out-button">Sign out</button>
    `;
    document.getElementById("sign-out-button")?.addEventListener("click", async () => {
      if (!authClient) {
        return;
      }

      await authClient.auth.signOut();
      authSession = null;
      authUser = null;
      clearAuthFlowStateFromUrl();
      setAuthFeedback(null, "");
      setStatus("Signed out.");
      await boot();
    });
    return;
  }

  topbarMeta.innerHTML = "";
}

async function ensureAuthClient() {
  if (authClient || !hasAuthConfig()) {
    return authClient;
  }

  authClient = window.supabase.createClient(
    window.VONZA_SUPABASE_URL,
    window.VONZA_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        detectSessionInUrl: true,
      },
    }
  );

  if (!authStateListenerBound && typeof authClient.auth?.onAuthStateChange === "function") {
    authClient.auth.onAuthStateChange((event, session) => {
      authSession = session || null;
      authUser = authSession?.user || null;
      renderTopbarMeta();

      if (event === "PASSWORD_RECOVERY") {
        authViewMode = AUTH_VIEW_MODES.UPDATE_PASSWORD;
        setAuthFeedback("info", "Choose a new password for your Vonza account.");
        renderAuthEntry();
      }
    });
    authStateListenerBound = true;
  }

  const { data } = await authClient.auth.getSession();
  authSession = data.session || null;
  authUser = authSession?.user || null;
  renderTopbarMeta();

  return authClient;
}

function getArrivalContext() {
  const params = new URLSearchParams(window.location.search);
  const from = trimText(params.get("from")).toLowerCase();
  const firstArrival = !window.localStorage.getItem(HANDOFF_STORAGE_KEY);
  const arrivedFromSite = from === "site";

  if (from) {
    window.sessionStorage.setItem(DASHBOARD_SOURCE_KEY, from);
  }

  return {
    from,
    firstArrival,
    arrivedFromSite,
    showHandoff: arrivedFromSite || firstArrival,
  };
}

function getPaymentState() {
  const params = new URLSearchParams(window.location.search);
  return {
    payment: trimText(params.get("payment")).toLowerCase(),
    sessionId: trimText(params.get("session_id") || params.get("sessionId")),
  };
}

function clearPaymentStateFromUrl() {
  const url = new URL(window.location.href);
  let changed = false;

  ["payment", "session_id", "sessionId"].forEach((key) => {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  });

  if (changed) {
    window.history.replaceState({}, "", url.toString());
  }
}

function getAuthFlowType() {
  const searchParams = new URLSearchParams(window.location.search);
  const hashValue = typeof window.location.hash === "string" ? window.location.hash : "";
  const hashParams = new URLSearchParams(hashValue.replace(/^#/, ""));
  return trimText(searchParams.get("type") || hashParams.get("type")).toLowerCase();
}

function clearAuthFlowStateFromUrl() {
  const url = new URL(window.location.href);
  let changed = false;

  if (url.searchParams.has("type")) {
    url.searchParams.delete("type");
    changed = true;
  }

  if (url.hash) {
    const hashParams = new URLSearchParams(String(url.hash || "").replace(/^#/, ""));

    if (hashParams.has("type") || hashParams.has("access_token") || hashParams.has("refresh_token")) {
      url.hash = "";
      changed = true;
    }
  }

  if (changed) {
    window.history.replaceState({}, "", url.toString());
  }
}

function setAuthFeedback(type, message) {
  authFeedback = message
    ? {
      type,
      message,
    }
    : null;
}

function getAuthFeedbackMarkup() {
  if (!authFeedback?.message) {
    return "";
  }

  return `
    <div class="auth-feedback ${escapeHtml(authFeedback.type || "info")}">
      ${escapeHtml(authFeedback.message)}
    </div>
  `;
}

function getAuthRedirectUrl() {
  const redirectUrl = new URL("/dashboard", window.location.origin);
  const arrival = getArrivalContext();

  if (arrival.from) {
    redirectUrl.searchParams.set("from", arrival.from);
  }

  return redirectUrl.toString();
}

function getAuthModeConfig(mode, arrival) {
  const configs = {
    [AUTH_VIEW_MODES.SIGN_UP]: {
      eyebrow: arrival.arrivedFromSite ? "Step 1 of 3" : "Create your Vonza account",
      headline: "Create your Vonza account",
      copy: "Use email and password to open your Vonza account, then continue straight into the app flow where checkout and workspace setup already live.",
      submitLabel: "Create account",
      note: "You can sign back in with the same email and password whenever you return.",
    },
    [AUTH_VIEW_MODES.SIGN_IN]: {
      eyebrow: arrival.arrivedFromSite ? "Step 1 of 3" : "Sign in to Vonza",
      headline: "Sign in to continue into Vonza",
      copy: "Use your email and password to return to Vonza. After sign-in, unpaid accounts go to checkout and paid accounts go straight into the workspace.",
      submitLabel: "Sign in",
      note: "Use the same email and password you created for this workspace.",
    },
    [AUTH_VIEW_MODES.RESET]: {
      eyebrow: "Reset your password",
      headline: "Send a password reset email",
      copy: "Enter your account email and we’ll send a reset link that brings you back into Vonza so you can choose a new password cleanly.",
      submitLabel: "Send reset link",
      note: "The reset link opens a secure password update flow inside Vonza.",
    },
    [AUTH_VIEW_MODES.MAGIC]: {
      eyebrow: "Email link fallback",
      headline: "Use a magic link instead",
      copy: "If you do not want to use your password right now, Vonza can still send a one-time email link as a secondary sign-in option.",
      submitLabel: "Send magic link",
      note: "This keeps the old auth path available without making it the main flow.",
    },
    [AUTH_VIEW_MODES.UPDATE_PASSWORD]: {
      eyebrow: "Secure password update",
      headline: "Choose your new password",
      copy: "Set a new password for your Vonza account, then we’ll bring you back into the app immediately.",
      submitLabel: "Update password",
      note: "Use a strong password you can return with later.",
    },
  };

  return configs[mode] || configs[AUTH_VIEW_MODES.SIGN_IN];
}

function renderAuthFields(mode) {
  if (mode === AUTH_VIEW_MODES.UPDATE_PASSWORD) {
    return `
      <div class="field">
        <label for="auth-password">New password</label>
        <input id="auth-password" name="password" type="password" placeholder="Create a strong password" autocomplete="new-password">
      </div>
      <div class="field">
        <label for="auth-password-confirm">Confirm new password</label>
        <input id="auth-password-confirm" name="confirm_password" type="password" placeholder="Repeat your new password" autocomplete="new-password">
      </div>
    `;
  }

  const needsPassword = mode === AUTH_VIEW_MODES.SIGN_IN || mode === AUTH_VIEW_MODES.SIGN_UP;
  const needsConfirmation = mode === AUTH_VIEW_MODES.SIGN_UP;

  return `
    <div class="field">
      <label for="auth-email">Email address</label>
      <input id="auth-email" name="email" type="email" placeholder="you@yourbusiness.com" autocomplete="email">
    </div>
    ${needsPassword ? `
      <div class="field">
        <label for="auth-password">Password</label>
        <input id="auth-password" name="password" type="password" placeholder="${mode === AUTH_VIEW_MODES.SIGN_UP ? "Create a password" : "Enter your password"}" autocomplete="${mode === AUTH_VIEW_MODES.SIGN_UP ? "new-password" : "current-password"}">
      </div>
    ` : ""}
    ${needsConfirmation ? `
      <div class="field">
        <label for="auth-password-confirm">Confirm password</label>
        <input id="auth-password-confirm" name="confirm_password" type="password" placeholder="Repeat your password" autocomplete="new-password">
      </div>
    ` : ""}
  `;
}

function renderAuthSecondaryLinks(mode) {
  if (mode === AUTH_VIEW_MODES.UPDATE_PASSWORD) {
    return "";
  }

  if (mode === AUTH_VIEW_MODES.SIGN_UP) {
    return `
      <div class="auth-links-row">
        <button class="auth-text-button" type="button" data-auth-mode="${AUTH_VIEW_MODES.SIGN_IN}">Already have an account? Sign in</button>
        <button class="auth-text-button" type="button" data-auth-mode="${AUTH_VIEW_MODES.MAGIC}">Use email link instead</button>
      </div>
    `;
  }

  if (mode === AUTH_VIEW_MODES.SIGN_IN) {
    return `
      <div class="auth-links-row">
        <button class="auth-text-button" type="button" data-auth-mode="${AUTH_VIEW_MODES.RESET}">Forgot password?</button>
        <button class="auth-text-button" type="button" data-auth-mode="${AUTH_VIEW_MODES.MAGIC}">Use email link instead</button>
      </div>
    `;
  }

  return `
    <div class="auth-links-row">
      <button class="auth-text-button" type="button" data-auth-mode="${AUTH_VIEW_MODES.SIGN_IN}">Back to password sign in</button>
      <button class="auth-text-button" type="button" data-auth-mode="${AUTH_VIEW_MODES.SIGN_UP}">Create account instead</button>
    </div>
  `;
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function markHandoffSeen() {
  window.localStorage.setItem(HANDOFF_STORAGE_KEY, "1");

  const url = new URL(window.location.href);
  if (url.searchParams.has("from")) {
    url.searchParams.delete("from");
    window.history.replaceState({}, "", url.toString());
  }
}

function getEventSource() {
  const params = new URLSearchParams(window.location.search);
  const from = trimText(params.get("from")).toLowerCase();

  if (from) {
    window.sessionStorage.setItem(DASHBOARD_SOURCE_KEY, from);
    return from;
  }

  return trimText(window.sessionStorage.getItem(DASHBOARD_SOURCE_KEY));
}

function trackProductEvent(eventName, options = {}) {
  const clientId = getClientId();
  const source = options.source ?? (getEventSource() || null);
  const onceKey = options.onceKey || null;

  if (!clientId || !eventName) {
    return;
  }

  if (onceKey && trackedEventKeys.has(onceKey)) {
    return;
  }

  if (onceKey) {
    trackedEventKeys.add(onceKey);
  }

  fetch("/product-events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    keepalive: true,
    body: JSON.stringify({
      client_id: clientId,
      agent_id: options.agentId || null,
      event_name: eventName,
      source,
      metadata: options.metadata || null,
    }),
  }).catch(() => {
    // Keep the product experience smooth even if analytics logging fails.
  });
}

function getClientId() {
  let clientId = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);

  if (!clientId) {
    clientId = window.crypto?.randomUUID?.() || `client_${Date.now()}`;
    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
  }

  return clientId;
}

function getInstallStorageKey(agentId) {
  return `${INSTALL_STORAGE_PREFIX}${agentId}`;
}

function getInstallProgress(agentId) {
  try {
    const rawValue = window.localStorage.getItem(getInstallStorageKey(agentId));
    return rawValue
      ? JSON.parse(rawValue)
      : { codeCopied: false, previewOpened: false, installed: false };
  } catch {
    return { codeCopied: false, previewOpened: false, installed: false };
  }
}

function saveInstallProgress(agentId, nextValue) {
  const mergedValue = {
    ...getInstallProgress(agentId),
    ...nextValue,
  };
  window.localStorage.setItem(getInstallStorageKey(agentId), JSON.stringify(mergedValue));
  return mergedValue;
}

function getLaunchState() {
  try {
    const rawValue = window.localStorage.getItem(LAUNCH_STORAGE_KEY);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch {
    return null;
  }
}

function saveLaunchState(nextValue) {
  window.localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify({
    ...nextValue,
    updatedAt: new Date().toISOString(),
  }));
}

function clearLaunchState() {
  window.localStorage.removeItem(LAUNCH_STORAGE_KEY);
}

function setDashboardFocus(target) {
  if (!target) {
    window.localStorage.removeItem(DASHBOARD_FOCUS_KEY);
    return;
  }

  window.localStorage.setItem(DASHBOARD_FOCUS_KEY, target);
}

function getDashboardFocus() {
  return window.localStorage.getItem(DASHBOARD_FOCUS_KEY);
}

function clearDashboardFocus() {
  window.localStorage.removeItem(DASHBOARD_FOCUS_KEY);
}

function getClaimDismissKey() {
  return `${CLAIM_DISMISS_PREFIX}${authUser?.id || "anonymous"}`;
}

function isClaimDismissed() {
  return window.localStorage.getItem(getClaimDismissKey()) === "1";
}

function dismissClaimBridge() {
  window.localStorage.setItem(getClaimDismissKey(), "1");
}

function clearClaimBridgeDismissal() {
  window.localStorage.removeItem(getClaimDismissKey());
}

function getActiveShellSection(setup) {
  const storedSection = trimText(window.localStorage.getItem(DASHBOARD_SECTION_KEY)).toLowerCase();

  if (SHELL_SECTIONS.includes(storedSection)) {
    return storedSection;
  }

  return "overview";
}

function setActiveShellSection(section) {
  if (!SHELL_SECTIONS.includes(section)) {
    return;
  }

  window.localStorage.setItem(DASHBOARD_SECTION_KEY, section);
}

function setStatus(message) {
  statusBanner.textContent = message || "";
}

function buildScript(agentKey) {
  return `<script src="${getPublicAppUrl()}/embed.js" data-agent-key="${agentKey}"><\/script>`;
}

function buildWidgetUrl(agentKey) {
  return `${getPublicAppUrl()}/widget?agent_key=${encodeURIComponent(agentKey)}`;
}

function buildPreviewMarkup(agentKey) {
  const publicAppUrl = getPublicAppUrl();
  return `<!DOCTYPE html>
<html>
  <body style="margin:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;background:linear-gradient(180deg,#f8fafc 0%,#e2e8f0 100%);color:#0f172a;">
<main style="padding:32px;">
  <h2 style="margin:0 0 8px;">Preview site</h2>
  <p style="margin:0;max-width:520px;color:#475569;line-height:1.6;">This simulates how your assistant will appear when installed on a real website.</p>
</main>
<script src="${publicAppUrl}/embed.js" data-agent-key="${agentKey}"><\/script>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function trimText(value) {
  return String(value || "").trim();
}

function formatSeenAt(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString();
}

function isMeaningfulWebsite(value) {
  const normalized = trimText(value);
  return normalized && !normalized.endsWith(".local");
}

function classifyImportResult(result) {
  const content = trimText(result?.content || "");

  if (!content) {
    return {
      knowledgeState: "missing",
      label: "Not ready",
      description: "Website knowledge is not available yet. Import it again once your site is live.",
    };
  }

  if (content.includes(LIMITED_CONTENT_MARKER)) {
    return {
      knowledgeState: "limited",
      label: "Limited",
      description: "Some website content was imported, but the assistant still needs a better knowledge pass.",
    };
  }

  return {
    knowledgeState: "ready",
    label: "Ready",
    description: "Your assistant has website knowledge and is ready to answer real customer questions.",
  };
}

function inferSetup(agent) {
  const knowledge = agent.knowledge || {
    state: "missing",
    description: "Website knowledge has not been imported yet.",
    contentLength: 0,
    pageCount: 0,
  };
  const personalityReady = Boolean(trimText(agent.assistantName) && trimText(agent.welcomeMessage) && trimText(agent.tone));
  const hasWebsite = isMeaningfulWebsite(agent.websiteUrl);
  const knowledgeState = hasWebsite ? (knowledge.state || "missing") : "missing";
  const previewReady = Boolean(trimText(agent.publicAgentKey));
  const installReady = previewReady;

  return {
    personalityReady,
    hasWebsite,
    websiteConnected: hasWebsite,
    knowledgeState,
    knowledgeReady: knowledgeState === "ready",
    knowledgeLimited: knowledgeState === "limited",
    knowledgeMissing: knowledgeState === "missing",
    knowledgeDescription: hasWebsite
      ? (knowledge.description || "Website knowledge has not been imported yet.")
      : "Add a real website to import knowledge.",
    knowledgePageCount: Number(knowledge.pageCount || 0),
    knowledgeContentLength: Number(knowledge.contentLength || 0),
    previewReady,
    installReady,
    isReady: personalityReady && hasWebsite && knowledgeState === "ready" && previewReady && installReady,
  };
}

function getBadgeClass(type) {
  if (type === "Ready") {
    return "badge success";
  }
  if (type === "Limited" || type === "Needs attention") {
    return "badge warning";
  }
  return "badge pending";
}

function normalizeAccessStatus(value) {
  const normalized = trimText(value).toLowerCase();
  return ["pending", "active", "suspended"].includes(normalized) ? normalized : "pending";
}

function getAccessCopy(agent) {
  if (!agent?.id) {
    return {
      eyebrow: "Purchase step",
      headline: "Unlock Vonza to open your setup workspace.",
      copy: "Start with secure checkout. Right after payment, Vonza will take you into the workspace where you customize your assistant, connect your website, and add it to your business.",
    };
  }

  const accessStatus = normalizeAccessStatus(agent?.accessStatus);

  if (accessStatus === "active") {
    return {
      eyebrow: "Workspace active",
      headline: "Your assistant workspace is open.",
      copy: "Everything is in place and you can manage how Vonza appears, responds, and performs for your business.",
    };
  }

  if (accessStatus === "suspended") {
    return {
      eyebrow: "Access paused",
      headline: "Your assistant workspace is currently paused.",
      copy: "Your assistant record is still here, but workspace access is not active right now. Once access is restored, you will land straight back in your Vonza workspace.",
    };
  }

  return {
    eyebrow: "Access pending",
    headline: "Your assistant is set up, and workspace access is not active yet.",
    copy: "Your assistant is connected to your account, but full workspace access still needs to be activated before you can manage it here.",
  };
}

function renderAccessLocked(agent) {
  renderTopbarMeta();
  const access = getAccessCopy(agent);
  const accessStatus = normalizeAccessStatus(agent?.accessStatus);
  const unlockLabel = accessStatus === "suspended" ? "Restore access" : "Unlock Vonza";
  const showDevTools = isDevFakeBillingEnabled();
  const hasAssistant = Boolean(agent?.id);
  const arrival = getArrivalContext();
  const handoffMarkup = !hasAssistant && arrival.showHandoff
    ? `
      <section class="handoff-card">
        <span class="handoff-step">${arrival.arrivedFromSite ? "Step 2 of 3" : "Welcome to your workspace"}</span>
        <h2 class="handoff-title">The next step is simple: unlock Vonza, then set everything up in one place.</h2>
        <p class="handoff-copy">You do not need to fully customize anything before payment. Once checkout is complete, you will land straight in your setup workspace with Overview, Customize, and Analytics ready to use.</p>
      </section>
    `
    : "";
  const detailsMarkup = hasAssistant
    ? `
      <div class="overview-grid" style="margin-top:24px;">
        <div class="overview-card">
          <p class="overview-label">Assistant</p>
          <p class="overview-value">${escapeHtml(agent.assistantName || agent.name || "Your assistant")}</p>
        </div>
        <div class="overview-card">
          <p class="overview-label">Website</p>
          <p class="overview-value">${escapeHtml(agent.websiteUrl || "No website connected yet")}</p>
        </div>
        <div class="overview-card">
          <p class="overview-label">Access status</p>
          <p class="overview-value">${escapeHtml(accessStatus)}</p>
        </div>
      </div>
    `
    : `
      <div class="overview-grid" style="margin-top:24px;">
        <div class="overview-card">
          <p class="overview-label">1. Purchase</p>
          <p class="overview-card-copy">Use hosted Stripe Checkout to unlock Vonza securely.</p>
        </div>
        <div class="overview-card">
          <p class="overview-label">2. Setup workspace</p>
          <p class="overview-card-copy">Customize the assistant, connect your website, and review install progress.</p>
        </div>
        <div class="overview-card">
          <p class="overview-label">3. Add to website</p>
          <p class="overview-card-copy">Copy the install code and place Vonza on the live site when you are ready.</p>
        </div>
      </div>
    `;

  rootEl.innerHTML = `
    ${handoffMarkup}
    <section class="access-card">
      <span class="eyebrow">${escapeHtml(access.eyebrow)}</span>
      <h1 class="headline">${escapeHtml(access.headline)}</h1>
      <p class="auth-copy">${escapeHtml(access.copy)}</p>

      <div class="pricing-card">
        <div>
          <p class="overview-label">Vonza access</p>
          <h2 class="pricing-title">One premium workspace</h2>
          <p class="pricing-copy">Unlock your assistant studio, live preview, analytics, install flow, and customer-facing customization in one place.</p>
          <div class="pricing-bullets">
            <div class="pill">Appearance and brand studio</div>
            <div class="pill">Website-grounded assistant setup</div>
            <div class="pill">Live preview and install tools</div>
            <div class="pill">Real usage and message insights</div>
          </div>
        </div>
        <div class="pricing-actions">
          <button id="unlock-vonza-button" class="primary-button" type="button">${unlockLabel}</button>
          ${showDevTools ? '<button id="simulate-unlock-button" class="ghost-button" type="button">Simulate unlock (dev only)</button>' : ""}
          ${showDevTools ? '<button id="setup-doctor-button" class="ghost-button" type="button">Check local setup</button>' : ""}
          <button id="locked-signout-button" class="ghost-button" type="button">Sign out</button>
        </div>
      </div>
      ${detailsMarkup}
      <p class="auth-note">Once payment completes successfully, Vonza will unlock your account and bring you straight into the setup workspace.</p>
      ${showDevTools ? '<div id="setup-doctor-results" class="auth-note" style="margin-top:16px;"></div>' : ""}
    </section>
  `;

  if (!hasAssistant && arrival.showHandoff) {
    markHandoffSeen();
  }

  document.getElementById("unlock-vonza-button")?.addEventListener("click", async () => {
    try {
      setStatus("Opening secure checkout...");
      const result = await fetchJson("/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: authUser?.email || null,
        }),
      });

      if (!result?.url) {
        throw new Error("Checkout is not available right now.");
      }

      window.location.assign(result.url);
    } catch (error) {
      setStatus(error.message || "We could not open checkout right now.");
    }
  });

  document.getElementById("simulate-unlock-button")?.addEventListener("click", async () => {
    try {
      setStatus("Dev billing simulation is activating access...");
      await fetchJson("/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "simulate",
        }),
      });
      setStatus("Dev simulation complete. Opening your workspace...");
      await boot();
    } catch (error) {
      setStatus(error.message || "We could not simulate access right now.");
    }
  });

  document.getElementById("setup-doctor-button")?.addEventListener("click", async () => {
    const resultsEl = document.getElementById("setup-doctor-results");

    try {
      if (resultsEl) {
        resultsEl.textContent = "Checking your local setup...";
      }

      const result = await fetchJson("/setup-doctor");
      const checks = Array.isArray(result?.checks) ? result.checks : [];
      const missing = checks.filter((check) => !check.present).map((check) => check.key);

      if (!resultsEl) {
        return;
      }

      if (!missing.length) {
        resultsEl.textContent = "Local setup looks ready. All required env values are present.";
        return;
      }

      resultsEl.textContent = `Missing locally: ${missing.join(", ")}`;
    } catch (error) {
      if (resultsEl) {
        resultsEl.textContent = error.message || "We could not run the local setup check.";
      }
    }
  });

  document.getElementById("locked-signout-button")?.addEventListener("click", async () => {
    if (!authClient) {
      return;
    }

    await authClient.auth.signOut();
    authSession = null;
    authUser = null;
    clearAuthFlowStateFromUrl();
    setAuthFeedback(null, "");
    setStatus("Signed out.");
    await boot();
  });
}

function renderErrorState(title, copy) {
  renderTopbarMeta();
  rootEl.innerHTML = `
    <section class="auth-card">
      <span class="eyebrow">Workspace issue</span>
      <h1 class="headline">${escapeHtml(title || "We couldn't open your workspace.")}</h1>
      <p class="auth-copy">${escapeHtml(copy || "Please refresh and try again. If the issue continues, your existing setup and payment state are still safe.")}</p>
      <div class="auth-actions">
        <button id="workspace-retry-button" class="primary-button" type="button">Try again</button>
      </div>
    </section>
  `;

  document.getElementById("workspace-retry-button")?.addEventListener("click", () => {
    window.location.reload();
  });
}

async function confirmPaymentReturn() {
  const paymentState = getPaymentState();

  if (paymentState.payment !== "success" || !paymentState.sessionId) {
    return false;
  }

  setStatus("Confirming your payment...");

  await fetchJson("/create-checkout-session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "confirm",
      session_id: paymentState.sessionId,
    }),
  });

  return true;
}

async function waitForActiveAccessAfterPayment() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { agents, bridgeAgent } = await loadAgents();
    const agent = agents[0] || null;

    if (agent && normalizeAccessStatus(agent.accessStatus) === "active") {
      clearPaymentStateFromUrl();
      setStatus("Payment received. Your Vonza workspace is now unlocked.");
      return { agents, bridgeAgent, activated: true };
    }

    if (attempt < 5) {
      setStatus("Payment confirmed. We’re finishing access activation...");
      await wait(1500);
    }
  }

  return { activated: false, timedOut: true };
}

// Entry states and shell rendering
function renderAuthEntry() {
  renderTopbarMeta();
  const arrival = getArrivalContext();
  const mode = getAuthFlowType() === "recovery"
    ? AUTH_VIEW_MODES.UPDATE_PASSWORD
    : authViewMode;
  const config = getAuthModeConfig(mode, arrival);
  const showModeTabs = mode !== AUTH_VIEW_MODES.UPDATE_PASSWORD;

  rootEl.innerHTML = `
    <section class="auth-card">
      <span class="eyebrow">${escapeHtml(config.eyebrow)}</span>
      <h1 class="headline">${escapeHtml(config.headline)}</h1>
      <p class="auth-copy">${escapeHtml(config.copy)}</p>
      ${showModeTabs ? `
        <div class="auth-mode-tabs" role="tablist" aria-label="Account access modes">
          <button class="auth-mode-tab ${mode === AUTH_VIEW_MODES.SIGN_UP ? "active" : ""}" type="button" data-auth-mode="${AUTH_VIEW_MODES.SIGN_UP}">Create account</button>
          <button class="auth-mode-tab ${mode === AUTH_VIEW_MODES.SIGN_IN ? "active" : ""}" type="button" data-auth-mode="${AUTH_VIEW_MODES.SIGN_IN}">Sign in</button>
        </div>
      ` : ""}
      ${getAuthFeedbackMarkup()}
      <form id="auth-form" class="auth-form">
        ${renderAuthFields(mode)}
        <div class="auth-actions">
          <button id="auth-submit" class="primary-button" type="submit">${escapeHtml(config.submitLabel)}</button>
          <span class="auth-note">${escapeHtml(config.note)}</span>
        </div>
        ${renderAuthSecondaryLinks(mode)}
      </form>
    </section>
  `;

  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      authViewMode = button.dataset.authMode || AUTH_VIEW_MODES.SIGN_IN;
      if (authViewMode !== AUTH_VIEW_MODES.UPDATE_PASSWORD) {
        clearAuthFlowStateFromUrl();
      }
      setAuthFeedback(null, "");
      renderAuthEntry();
    });
  });

  document.getElementById("auth-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!authClient) {
      setStatus("Supabase Auth is not configured yet.");
      return;
    }

    const form = event.currentTarget;
    const formData = new FormData(form);
    const email = trimText(formData.get("email"));
    const password = trimText(formData.get("password"));
    const confirmPassword = trimText(formData.get("confirm_password"));
    const submitButton = document.getElementById("auth-submit");

    if (mode !== AUTH_VIEW_MODES.UPDATE_PASSWORD && !email) {
      setStatus("Enter your email first.");
      return;
    }

    if ((mode === AUTH_VIEW_MODES.SIGN_IN || mode === AUTH_VIEW_MODES.SIGN_UP || mode === AUTH_VIEW_MODES.UPDATE_PASSWORD) && password.length < 8) {
      setAuthFeedback("error", "Use a password with at least 8 characters.");
      renderAuthEntry();
      setStatus("Use a password with at least 8 characters.");
      return;
    }

    if ((mode === AUTH_VIEW_MODES.SIGN_UP || mode === AUTH_VIEW_MODES.UPDATE_PASSWORD) && password !== confirmPassword) {
      setAuthFeedback("error", "Your password confirmation does not match.");
      renderAuthEntry();
      setStatus("Your password confirmation does not match.");
      return;
    }

    submitButton.disabled = true;
    setAuthFeedback(null, "");

    try {
      if (mode === AUTH_VIEW_MODES.SIGN_UP) {
        setStatus("Creating your account...");
        const { data, error } = await authClient.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: getAuthRedirectUrl(),
          },
        });

        if (error) {
          throw error;
        }

        if (data?.session?.user) {
          authSession = data.session;
          authUser = data.session.user;
          setStatus("Account created. Opening your Vonza app...");
          await boot();
          return;
        }

        authViewMode = AUTH_VIEW_MODES.SIGN_IN;
        setAuthFeedback("success", "Account created. Check your email to confirm your address, then sign in with your password.");
        renderAuthEntry();
        setStatus("Check your email to confirm your account.");
        return;
      }

      if (mode === AUTH_VIEW_MODES.SIGN_IN) {
        setStatus("Signing you in...");
        const { data, error } = await authClient.auth.signInWithPassword({
          email,
          password,
        });

        if (error) {
          throw error;
        }

        authSession = data.session || null;
        authUser = data.user || data.session?.user || null;
        setStatus("Signed in. Opening your Vonza app...");
        await boot();
        return;
      }

      if (mode === AUTH_VIEW_MODES.RESET) {
        setStatus("Sending your reset link...");
        const { error } = await authClient.auth.resetPasswordForEmail(email, {
          redirectTo: getAuthRedirectUrl(),
        });

        if (error) {
          throw error;
        }

        setAuthFeedback("success", "Password reset email sent. Use the link in your inbox to choose a new password.");
        renderAuthEntry();
        setStatus("Password reset email sent.");
        return;
      }

      if (mode === AUTH_VIEW_MODES.MAGIC) {
        setStatus("Sending your magic link...");
        const { error } = await authClient.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: getAuthRedirectUrl(),
          },
        });

        if (error) {
          throw error;
        }

        setAuthFeedback("success", "Magic link sent. Open the email from this device to continue into Vonza.");
        renderAuthEntry();
        setStatus("Magic link sent.");
        return;
      }

      if (mode === AUTH_VIEW_MODES.UPDATE_PASSWORD) {
        setStatus("Updating your password...");
        const { error } = await authClient.auth.updateUser({
          password,
        });

        if (error) {
          throw error;
        }

        clearAuthFlowStateFromUrl();
        setAuthFeedback(null, "");
        setStatus("Password updated. Opening your Vonza app...");
        await boot();
      }
    } catch (error) {
      setAuthFeedback("error", error.message || "We could not complete authentication just yet.");
      renderAuthEntry();
      setStatus(error.message || "We could not complete authentication just yet.");
    } finally {
      submitButton.disabled = false;
    }
  });
}

function renderClaimAssistant(bridgeAgent) {
  renderTopbarMeta();
  rootEl.innerHTML = `
    <section class="claim-card">
      <span class="eyebrow">Claim your assistant</span>
      <h1 class="headline">We found an assistant created in this browser.</h1>
      <p class="auth-copy">Claim it to your signed-in Vonza account so you can access the same workspace from any browser or device.</p>
      <div class="overview-list">
        <div class="overview-list-item">
          <p class="overview-list-title">${escapeHtml(bridgeAgent.assistantName || bridgeAgent.name || "Your assistant")}</p>
          <p class="overview-list-copy">${escapeHtml(bridgeAgent.websiteUrl || "No website connected yet")}</p>
        </div>
      </div>
      <div class="auth-actions" style="margin-top:24px;">
        <button id="claim-assistant-button" class="primary-button" type="button">Claim this assistant</button>
        <button id="start-fresh-button" class="ghost-button" type="button">Start with a new assistant</button>
      </div>
    </section>
  `;

  document.getElementById("claim-assistant-button")?.addEventListener("click", async () => {
    try {
      setStatus("Claiming your assistant...");
      await fetchJson("/agents/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_id: bridgeAgent.id,
          client_id: getClientId(),
        }),
      });
      clearClaimBridgeDismissal();
      setStatus("Assistant claimed successfully.");
      await boot();
    } catch (error) {
      setStatus(error.message || "We could not claim that assistant just yet.");
    }
  });

  document.getElementById("start-fresh-button")?.addEventListener("click", () => {
    dismissClaimBridge();
    setStatus("You can create a fresh assistant in this workspace.");
    renderOnboarding();
  });
}

function renderOnboarding() {
  renderTopbarMeta();
  const arrival = getArrivalContext();
  const handoffMarkup = arrival.showHandoff
    ? `
      <section class="handoff-card">
        <span class="handoff-step">${arrival.arrivedFromSite ? "Step 1 of 4" : "Welcome to Vonza"}</span>
        <h2 class="handoff-title">${arrival.arrivedFromSite ? "You’re now in the place where your assistant comes to life." : "This is where you create your website AI assistant."}</h2>
        <p class="handoff-copy">${arrival.arrivedFromSite ? "You’ve moved from the Vonza site into your assistant workspace. In the next step, you’ll connect your website, shape the voice, and try the live experience before you install it." : "Connect your website, shape the assistant around your brand, and see how it answers real customer questions before you launch it."}</p>
        <div class="handoff-actions">
          <button id="handoff-start-button" class="primary-button" type="button">Start creating</button>
          <span class="handoff-note">A few focused details are enough to get your assistant ready to try.</span>
        </div>
      </section>
    `
    : "";

  rootEl.innerHTML = `
    ${handoffMarkup}
    <section class="hero-card">
      <span class="eyebrow">Create your AI assistant</span>
      <h1 class="headline">Create a website-based AI assistant for your business.</h1>
      <p class="subtext">Launch an assistant that learns from your website, answers customer questions clearly, and helps visitors move toward contact, consultation, or purchase.</p>
    </section>

    <div class="state-grid">
      <section id="onboarding-create" class="section-card">
        <h2 class="section-heading">Create your assistant</h2>
        <p class="section-copy">Start with the essentials. We’ll turn your website into a customer-facing assistant you can shape, preview, and install with confidence.</p>
        <form id="create-assistant-form" class="form-grid spacer">
          <div class="field">
            <label for="create-website-url">Website URL</label>
            <input id="create-website-url" name="website_url" type="text" placeholder="https://yourwebsite.com">
          </div>
          <div class="field">
            <label for="create-assistant-name">Assistant name</label>
            <input id="create-assistant-name" name="assistant_name" type="text" placeholder="Your brand assistant">
          </div>
          <div class="field">
            <label for="create-tone">Tone</label>
            <select id="create-tone" name="tone">
              <option value="friendly">friendly</option>
              <option value="professional">professional</option>
              <option value="sales">sales</option>
              <option value="support">support</option>
            </select>
          </div>
          <div class="field">
            <label for="create-welcome-message">Welcome message</label>
            <textarea id="create-welcome-message" name="welcome_message" placeholder="Welcome your visitors in a warm, helpful way."></textarea>
          </div>
          <div class="field">
            <label for="create-primary-color">Primary color</label>
            <input id="create-primary-color" name="primary_color" type="color" value="#14b8a6">
          </div>
          <div class="inline-actions">
            <button id="create-assistant-button" class="primary-button" type="submit">Create your assistant</button>
          </div>
        </form>
      </section>

      <section class="section-card">
        <h2 class="section-heading">What you get</h2>
        <p class="section-copy">Your assistant becomes a polished front door for your business.</p>
        <div class="pill-row">
          <div class="pill">Answers real customer questions</div>
          <div class="pill">Matches your brand voice</div>
          <div class="pill">Installs with one embed code</div>
          <div class="pill">Uses your website as the source</div>
        </div>
      </section>
    </div>
  `;

  document.getElementById("create-assistant-form").addEventListener("submit", createAssistant);
  document.getElementById("create-assistant-form").addEventListener("focusin", () => {
    trackProductEvent("onboarding_started", {
      onceKey: "onboarding_started",
      metadata: { entry: "form_focus" },
    });
  }, { once: true });
  document.getElementById("handoff-start-button")?.addEventListener("click", () => {
    document.getElementById("onboarding-create")?.scrollIntoView({ behavior: "smooth", block: "start" });
    trackProductEvent("onboarding_started", {
      onceKey: "onboarding_started",
      metadata: { entry: "handoff_cta" },
    });
    markHandoffSeen();
  });

  if (arrival.showHandoff) {
    markHandoffSeen();
  }
}

function renderLaunchSequence(launchState = {}) {
  renderTopbarMeta();
  const currentStepIndex = Number.isFinite(launchState.stepIndex) ? launchState.stepIndex : 0;
  const detail = launchState.detail || "This can take a moment if your website is larger or slower to load.";
  const note = launchState.note || "Stay on this page while we prepare everything. If you refresh, we will reconnect you to the right place.";

  rootEl.innerHTML = `
    <section class="launch-card">
      <div class="launch-layout">
        <div class="launch-copy">
          <span class="eyebrow">${launchState.recovering ? "Picking up where you left off" : "Preparing your assistant"}</span>
          <h1 class="headline">${escapeHtml(launchState.headline || "Your assistant is taking shape.")}</h1>
          <p class="launch-meta">${escapeHtml(detail)}</p>
          <p class="launch-note">${escapeHtml(note)}</p>
        </div>

        <div class="launch-steps">
          ${LAUNCH_STEPS.map((step, index) => {
            const state = index < currentStepIndex ? "done" : index === currentStepIndex ? "active" : "pending";
            const label = state === "done" ? "Done" : state === "active" ? "In progress" : "Pending";

            return `
              <div class="launch-step ${state}">
                <div class="launch-step-index">${index + 1}</div>
                <div>
                  <p class="launch-step-title">${escapeHtml(step.title)}</p>
                  <p class="launch-step-copy">${escapeHtml(step.copy)}</p>
                </div>
                <div class="launch-step-state">${label}</div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderLaunchSuccess(agent, options = {}) {
  renderTopbarMeta();
  const accessStatus = normalizeAccessStatus(options.accessStatus);
  const ready = options.nextState === "ready";
  const isLocked = accessStatus !== "active";
  const actionLabel = isLocked
    ? "Continue"
    : ready
      ? "Try your assistant"
      : "Finish setup";
  const copy = isLocked
    ? "Your assistant has been created successfully. The next screen will show your workspace access and what to do next."
    : ready
      ? "Your assistant is ready to answer customer questions and show what your business offers."
      : "Your assistant is created and close to ready. One more website knowledge pass can make the experience even stronger.";

  rootEl.innerHTML = `
    <section class="launch-card">
      <div class="launch-success">
        <span class="eyebrow">${ready ? "Ready to try" : "Ready for final setup"}</span>
        <h1 class="headline">${ready ? "Your assistant is ready." : "Your assistant is created."}</h1>
        <p class="launch-success-copy">${escapeHtml(copy)}</p>
        <h2 class="assistant-name">${escapeHtml(agent.assistantName || agent.name || "Your assistant")}</h2>
        <div class="launch-action-row">
          <button id="launch-success-button" class="primary-button" type="button">${actionLabel}</button>
          <span class="save-state">Taking you there now...</span>
        </div>
      </div>
    </section>
  `;

  const focusTarget = ready ? "preview" : "setup";
  let hasContinued = false;
  const goNext = async () => {
    if (hasContinued) {
      return;
    }

    hasContinued = true;
    clearLaunchState();
    setDashboardFocus(focusTarget);
    await boot();
  };

  document.getElementById("launch-success-button")?.addEventListener("click", goNext);
  if (!isLocked) {
    window.setTimeout(goNext, 1300);
  }
}

function buildWorkspaceTabs(activeSection, setup) {
  return `
    <nav class="workspace-tabs" aria-label="Workspace sections">
      <button class="workspace-tab ${activeSection === "overview" ? "active" : ""}" type="button" data-shell-target="overview">
        <span class="nav-label">Overview</span>
        <span class="nav-note">${setup.isReady ? "Install, preview, and next steps" : "See progress and what comes next"}</span>
      </button>
      <button class="workspace-tab ${activeSection === "customize" ? "active" : ""}" type="button" data-shell-target="customize">
        <span class="nav-label">Customize</span>
        <span class="nav-note">Name, website, welcome message, colors, behavior</span>
      </button>
      <button class="workspace-tab ${activeSection === "analytics" ? "active" : ""}" type="button" data-shell-target="analytics">
        <span class="nav-label">Analytics</span>
        <span class="nav-note">Usage, action queue signals, and where the assistant needs work</span>
      </button>
    </nav>
  `;
}

function buildOverviewPanel(agent, messages, setup, actionQueue) {
  return `
    <section class="workspace-panel workspace-panel-overview" data-shell-section="overview">
      ${buildOverviewSection(agent, messages, setup, actionQueue)}
      <div class="workspace-utility-grid">
        <section class="preview-card">
          ${buildPreviewSection(agent, setup)}
        </section>

        <section class="install-card">
          <div class="workspace-panel-header">
            <h2 class="workspace-panel-title">Install</h2>
            <p class="workspace-panel-copy">When you are ready to go live, use this embed script to add Vonza to the website.</p>
          </div>
          ${buildInstallSection(agent, { upcoming: !setup.isReady })}
        </section>
      </div>
    </section>
  `;
}

function buildCustomizePanel(agent, setup) {
  const knowledgeActionLabel = setup.knowledgeState === "limited" ? "Retry website import" : "Import website knowledge";
  const behaviorSummary = buildBehaviorSummary(agent.tone, agent.systemPrompt);

  return `
    <section class="workspace-panel" data-shell-section="customize" hidden>
      <div class="workspace-panel-header">
        <h2 class="workspace-panel-title">Customize</h2>
        <p class="workspace-panel-copy">Shape how Vonza looks, sounds, and connects to the business before you add it to the live site.</p>
      </div>
      <form data-settings-form data-form-kind="customize">
        <div class="studio-layout">
          <div class="studio-groups">
            <section class="studio-group">
              <p class="studio-kicker">Assistant basics</p>
              <h3 class="studio-group-title">Set the identity your customers will meet.</h3>
              <p class="studio-group-copy">Use these core settings to make the assistant feel like part of the business from the very first interaction.</p>
              <div class="form-grid two-col">
                <div class="field">
                  <label for="assistant-name">Assistant name</label>
                  <input id="assistant-name" name="assistant_name" type="text" value="${escapeHtml(agent.assistantName || agent.name)}">
                </div>
                <div class="field">
                  <label for="assistant-tone">Conversation tone</label>
                  <select id="assistant-tone" name="tone">
                    <option value="friendly" ${agent.tone === "friendly" ? "selected" : ""}>friendly</option>
                    <option value="professional" ${agent.tone === "professional" ? "selected" : ""}>professional</option>
                    <option value="sales" ${agent.tone === "sales" ? "selected" : ""}>sales</option>
                    <option value="support" ${agent.tone === "support" ? "selected" : ""}>support</option>
                  </select>
                </div>
                <div class="field">
                  <label for="assistant-button-label">Launcher text</label>
                  <input id="assistant-button-label" name="button_label" type="text" value="${escapeHtml(agent.buttonLabel || "")}">
                </div>
                <div class="field">
                  <label for="assistant-website">Website URL</label>
                  <input id="assistant-website" name="website_url" type="text" value="${escapeHtml(agent.websiteUrl || "")}">
                  <p class="field-help">This should be the main website Vonza learns from and represents.</p>
                </div>
              </div>
              <div class="form-grid">
                <div class="field">
                  <label for="assistant-welcome">Welcome message</label>
                  <textarea id="assistant-welcome" name="welcome_message">${escapeHtml(agent.welcomeMessage || "")}</textarea>
                </div>
              </div>
            </section>

            <section class="studio-group">
              <h3 class="studio-group-title">Brand colors</h3>
              <p class="studio-group-copy">Keep the assistant aligned with the brand your customers already know.</p>
              <div class="form-grid two-col">
                <div class="field">
                  <label for="assistant-primary-color">Primary color</label>
                  <input id="assistant-primary-color" name="primary_color" type="color" value="${escapeHtml(agent.primaryColor || "#14b8a6")}">
                </div>
                <div class="field">
                  <label for="assistant-secondary-color">Secondary color</label>
                  <input id="assistant-secondary-color" name="secondary_color" type="color" value="${escapeHtml(agent.secondaryColor || "#0f766e")}">
                </div>
              </div>
            </section>

            <section class="studio-group">
              <h3 class="studio-group-title">Website knowledge</h3>
              <p class="studio-group-copy">Run an import after adding or changing your website so Vonza can answer with the right context.</p>
              <div class="inline-actions">
                <button class="ghost-button" type="button" data-action="import-knowledge">${knowledgeActionLabel}</button>
              </div>
              <p class="section-note">${escapeHtml(setup.knowledgeDescription)}</p>
            </section>

            <section class="studio-group secondary">
              <h3 class="studio-group-title">Advanced guidance</h3>
              <p class="studio-group-copy">Optional guidance for emphasis, tone, and edge cases. Keep it focused on how the assistant should represent the business.</p>
              <div class="form-grid">
                <div class="field">
                  <label for="assistant-instructions">Advanced guidance</label>
                  <textarea id="assistant-instructions" name="system_prompt">${escapeHtml(agent.systemPrompt || "")}</textarea>
                </div>
              </div>
            </section>

            <div class="studio-save-row">
              <button class="primary-button" type="submit">Save changes</button>
              <span data-save-state class="save-state">No changes yet.</span>
            </div>
          </div>

          <aside class="studio-summary">
            <p class="studio-summary-label">Live summary</p>
            <h3 id="studio-summary-name" class="studio-summary-name">${escapeHtml(agent.assistantName || agent.name)}</h3>
            <p id="studio-summary-copy" class="studio-summary-copy">${escapeHtml(agent.welcomeMessage || "Your assistant is ready to greet visitors with a clear, helpful first message.")}</p>
            <div class="studio-summary-badge-row">
              <span id="studio-summary-tone" class="badge success">${escapeHtml(agent.tone || "friendly")}</span>
              <span id="studio-summary-button" class="pill">${escapeHtml(agent.buttonLabel || "Chat")}</span>
            </div>
            <div class="studio-swatch-row">
              <div id="studio-swatch-primary" class="studio-swatch" style="--swatch-color:${escapeHtml(agent.primaryColor || "#14b8a6")}">Primary</div>
              <div id="studio-swatch-secondary" class="studio-swatch" style="--swatch-color:${escapeHtml(agent.secondaryColor || "#0f766e")}">Secondary</div>
            </div>
            <div class="overview-list">
              <div class="overview-list-item">
                <p class="overview-list-title">Current website</p>
                <p class="overview-list-copy">${escapeHtml(agent.websiteUrl || "Add your website to import real business knowledge.")}</p>
              </div>
              <div class="overview-list-item">
                <p class="overview-list-title">Install status</p>
                <p class="overview-list-copy">${escapeHtml(agent.installStatus?.label || "Not detected on a live site yet")}</p>
              </div>
              <div class="overview-list-item">
                <p id="behavior-summary-title" class="overview-list-title">${escapeHtml(behaviorSummary.title)}</p>
                <p id="behavior-summary-copy" class="overview-list-copy">${escapeHtml(behaviorSummary.copy)}</p>
              </div>
            </div>
          </aside>
        </div>
      </form>
    </section>
  `;
}

// Workspace sections
function buildAppearanceStudio(agent) {
  return `
    <section class="workspace-panel" data-shell-section="appearance">
      <div class="workspace-panel-header">
        <h2 class="workspace-panel-title">Brand studio</h2>
        <p class="workspace-panel-copy">Shape how Vonza appears to your visitors so the experience feels polished, branded, and ready to represent your business.</p>
      </div>
      <form data-settings-form data-form-kind="appearance">
        <input name="system_prompt" type="hidden" value="${escapeHtml(agent.systemPrompt || "")}">
        <div class="studio-layout">
          <div class="studio-groups">
            <section class="studio-group">
              <p class="studio-kicker">Brand direction</p>
              <h3 class="studio-group-title">Choose the first impression your visitors feel.</h3>
              <p class="studio-group-copy">These quick starting points only adjust real current appearance settings like wording and colors. You can fine-tune everything below.</p>
              <div class="preset-row">
                <button class="preset-chip" type="button" data-appearance-preset="clean">Clean</button>
                <button class="preset-chip" type="button" data-appearance-preset="bold">Bold</button>
                <button class="preset-chip" type="button" data-appearance-preset="minimal">Minimal</button>
              </div>
            </section>

            <section class="studio-group">
              <h3 class="studio-group-title">Assistant identity</h3>
              <p class="studio-group-copy">Set the name customers will associate with your business when the assistant appears on your site.</p>
              <div class="form-grid">
                <div class="field">
                  <label for="assistant-name">Assistant name</label>
                  <input id="assistant-name" name="assistant_name" type="text" value="${escapeHtml(agent.assistantName || agent.name)}">
                  <p class="field-help">Use the name you want customers to see in the widget header and first interaction.</p>
                </div>
              </div>
            </section>

            <section class="studio-group">
              <h3 class="studio-group-title">Opening moment</h3>
              <p class="studio-group-copy">Refine the text that frames the first customer interaction and makes the assistant feel welcoming.</p>
              <div class="form-grid two-col">
                <div class="field">
                  <label for="assistant-button-label">Launcher text</label>
                  <input id="assistant-button-label" name="button_label" type="text" value="${escapeHtml(agent.buttonLabel || "")}">
                  <p class="field-help">Keep this short, clear, and inviting.</p>
                </div>
                <div class="field">
                  <label for="assistant-welcome">Welcome message</label>
                  <textarea id="assistant-welcome" name="welcome_message">${escapeHtml(agent.welcomeMessage || "")}</textarea>
                  <p class="field-help">This becomes the first message visitors see when they open the assistant.</p>
                </div>
              </div>
            </section>

            <section class="studio-group">
              <h3 class="studio-group-title">Brand color system</h3>
              <p class="studio-group-copy">Use your primary and secondary colors so the assistant feels like a natural extension of your website.</p>
              <div class="form-grid two-col">
                <div class="field">
                  <label for="assistant-primary-color">Primary color</label>
                  <input id="assistant-primary-color" name="primary_color" type="color" value="${escapeHtml(agent.primaryColor || "#14b8a6")}">
                  <p class="field-help">Used for the strongest accents and primary brand moments.</p>
                </div>
                <div class="field">
                  <label for="assistant-secondary-color">Secondary color</label>
                  <input id="assistant-secondary-color" name="secondary_color" type="color" value="${escapeHtml(agent.secondaryColor || "#0f766e")}">
                  <p class="field-help">Used to support the main color and add depth to the widget feel.</p>
                </div>
              </div>
              <p class="section-note">More appearance controls like logo upload and richer widget variants can come later. For now, Vonza uses your real live text and colors only.</p>
            </section>

            <div class="studio-save-row">
              <button class="primary-button" type="submit">Save appearance</button>
              <span data-save-state class="save-state">No changes yet.</span>
            </div>
          </div>

          <aside class="studio-summary">
            <p class="studio-summary-label">Live appearance preview</p>
            <h3 id="studio-summary-name" class="studio-summary-name">${escapeHtml(agent.assistantName || agent.name)}</h3>
            <p id="studio-summary-copy" class="studio-summary-copy">${escapeHtml(agent.welcomeMessage || "Your assistant is ready to greet visitors with a clear, helpful first message.")}</p>
            <div class="studio-summary-badge-row">
              <span id="studio-summary-tone" class="badge success">${escapeHtml(agent.tone || "friendly")}</span>
              <span id="studio-summary-button" class="pill">${escapeHtml(agent.buttonLabel || "Chat")}</span>
            </div>
            <div class="studio-swatch-row">
              <div id="studio-swatch-primary" class="studio-swatch" style="--swatch-color:${escapeHtml(agent.primaryColor || "#14b8a6")}">Primary</div>
              <div id="studio-swatch-secondary" class="studio-swatch" style="--swatch-color:${escapeHtml(agent.secondaryColor || "#0f766e")}">Secondary</div>
            </div>
            <div class="brand-preview-shell">
              <div class="brand-preview-stage">
                <div class="brand-widget" id="brand-widget-preview">
                  <div class="brand-widget-header">
                    <div id="brand-widget-avatar" class="brand-widget-avatar" style="--brand-primary:${escapeHtml(agent.primaryColor || "#14b8a6")};--brand-secondary:${escapeHtml(agent.secondaryColor || "#0f766e")}">V</div>
                    <div>
                      <p id="brand-widget-title" class="brand-widget-title">${escapeHtml(agent.assistantName || agent.name)}</p>
                      <p class="brand-widget-subtitle">Your website assistant</p>
                    </div>
                  </div>
                  <div id="brand-widget-message" class="brand-message">${escapeHtml(agent.welcomeMessage || "Welcome. I’m here to answer questions and help your visitors find the right next step.")}</div>
                  <div class="brand-cta-row">
                    <span class="brand-cta-note">This preview reflects the real name, opening message, button text, and brand colors you support today.</span>
                    <div id="brand-launcher" class="brand-launcher" style="--brand-primary:${escapeHtml(agent.primaryColor || "#14b8a6")};--brand-secondary:${escapeHtml(agent.secondaryColor || "#0f766e")}">
                      <span class="brand-launcher-dot"></span>
                      <span id="brand-launcher-label">${escapeHtml(agent.buttonLabel || "Chat")}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </form>
    </section>
  `;
}

function buildConfigurationStudio(agent, setup) {
  const knowledgeActionLabel = setup.knowledgeState === "limited" ? "Retry website import" : "Import website knowledge";

  return `
    <section class="workspace-panel" data-shell-section="configuration" hidden>
      <div class="workspace-panel-header">
        <h2 class="workspace-panel-title">Business behavior</h2>
        <p class="workspace-panel-copy">Shape how Vonza talks to customers, what it should emphasize, and which website knowledge it should rely on.</p>
      </div>
      <form data-settings-form data-form-kind="configuration">
        <div class="workspace-section-stack">
          <section class="workspace-card-soft">
            <p class="studio-kicker">Behavior preset</p>
            <h3 class="studio-group-title">Choose the kind of customer conversation you want Vonza to lead.</h3>
            <p class="studio-group-copy">These quick starting points only shape real existing controls like tone and advanced guidance. You can still edit them manually right after.</p>
            <div class="preset-row">
              <button class="preset-chip" type="button" data-configuration-preset="general">General business assistant</button>
              <button class="preset-chip" type="button" data-configuration-preset="sales">Sales assistant</button>
              <button class="preset-chip" type="button" data-configuration-preset="support">Customer support</button>
            </div>
          </section>

          <section class="workspace-card-soft">
            <h3 class="studio-group-title">How Vonza sounds</h3>
            <p class="studio-group-copy">Choose the style customers should feel in the first few messages and throughout the conversation.</p>
            <div class="behavior-mode-grid">
              <label class="behavior-mode-card ${agent.tone === "friendly" ? "active" : ""}" data-tone-card="friendly">
                <input type="radio" name="tone" value="friendly" ${agent.tone === "friendly" ? "checked" : ""}>
                <p class="behavior-mode-title">Friendly</p>
                <p class="behavior-mode-copy">Warm, welcoming, and approachable without sounding casual or unstructured.</p>
              </label>
              <label class="behavior-mode-card ${agent.tone === "professional" ? "active" : ""}" data-tone-card="professional">
                <input type="radio" name="tone" value="professional" ${agent.tone === "professional" ? "checked" : ""}>
                <p class="behavior-mode-title">Professional</p>
                <p class="behavior-mode-copy">Clear, calm, and polished for businesses that want a more formal brand voice.</p>
              </label>
              <label class="behavior-mode-card ${agent.tone === "sales" ? "active" : ""}" data-tone-card="sales">
                <input type="radio" name="tone" value="sales" ${agent.tone === "sales" ? "checked" : ""}>
                <p class="behavior-mode-title">Sales-focused</p>
                <p class="behavior-mode-copy">Helpful and persuasive, with more emphasis on services, value, and moving visitors forward.</p>
              </label>
              <label class="behavior-mode-card ${agent.tone === "support" ? "active" : ""}" data-tone-card="support">
                <input type="radio" name="tone" value="support" ${agent.tone === "support" ? "checked" : ""}>
                <p class="behavior-mode-title">Support-focused</p>
                <p class="behavior-mode-copy">Reassuring and solution-oriented, designed to reduce friction and answer practical questions clearly.</p>
              </label>
            </div>
          </section>

          <section class="workspace-card-soft">
            <h3 class="studio-group-title">Website knowledge</h3>
            <p class="studio-group-copy">This is the website Vonza should represent and learn from when answering customer questions.</p>
            <div class="form-grid">
              <div class="field">
                <label for="assistant-website">Website URL</label>
                <input id="assistant-website" name="website_url" type="text" value="${escapeHtml(agent.websiteUrl || "")}">
                <p class="field-help">Use the main public website your customers actually visit.</p>
              </div>
            </div>
            <div class="inline-actions">
              <button class="ghost-button" type="button" data-action="import-knowledge">${knowledgeActionLabel}</button>
            </div>
            <p class="section-note">${escapeHtml(setup.knowledgeDescription)}</p>
          </section>

          <section class="workspace-card-soft">
            <h3 class="studio-group-title">Advanced guidance</h3>
            <p class="studio-group-copy">Use this to tell Vonza what to emphasize, how direct it should be, or what it should avoid. Keep it focused and business-facing.</p>
            <div class="form-grid">
              <div class="field">
                <label for="assistant-instructions">Advanced guidance</label>
                <textarea id="assistant-instructions" name="system_prompt">${escapeHtml(agent.systemPrompt || "")}</textarea>
                <p class="field-help">For example: highlight premium service, stay concise, avoid sounding pushy, or guide pricing questions toward a quote.</p>
              </div>
            </div>
          </section>

          <section class="workspace-card-soft">
            <div class="behavior-summary">
              <p class="behavior-summary-label">How Vonza will respond</p>
              <h3 id="behavior-summary-title" class="behavior-summary-title">A calm, helpful business assistant.</h3>
              <p id="behavior-summary-copy" class="behavior-summary-copy">Right now, Vonza is set up to answer customer questions in a clear way using your website as the source of truth.</p>
            </div>
          </section>

          <section class="workspace-card-soft">
            <div class="guidance-card">
              <h3 class="studio-group-title">What this setup is designed for</h3>
              <p class="studio-group-copy">Vonza works best when your website clearly explains your business, services, and next steps.</p>
              <div class="guidance-list">
                <div class="guidance-item">Grounded in your website, not in a separate knowledge system.</div>
                <div class="guidance-item">Answers best when website knowledge is strong and up to date.</div>
                <div class="guidance-item">Calendar and booking automation can come later, but they are not part of the product yet.</div>
              </div>
            </div>
          </section>

          <div class="studio-save-row">
            <button class="primary-button" type="submit">Save behavior</button>
            <span data-save-state class="save-state">No changes yet.</span>
          </div>
        </div>
      </form>
    </section>
  `;
}

function getActivityLevel(messageCount, lastMessageAt) {
  if (!messageCount) {
    return {
      label: "Just getting started",
      description: "There is not enough conversation activity yet to show a clear pattern.",
    };
  }

  if (lastMessageAt) {
    const lastMessageDate = new Date(lastMessageAt);
    const hoursSinceLastMessage = Number.isFinite(lastMessageDate.getTime())
      ? (Date.now() - lastMessageDate.getTime()) / (1000 * 60 * 60)
      : null;

    if (hoursSinceLastMessage !== null && hoursSinceLastMessage <= 24 && messageCount >= 6) {
      return {
        label: "Active recently",
        description: "Customers have been using the assistant recently, which is a good sign that it is visible and useful.",
      };
    }

    if (hoursSinceLastMessage !== null && hoursSinceLastMessage <= 72 && messageCount >= 3) {
      return {
        label: "Steady early activity",
        description: "You are seeing real usage, with fresh conversations in the last few days.",
      };
    }
  }

  return {
    label: "Light activity",
    description: "The assistant has some conversation history, but there is still room to build usage and repeat visits.",
  };
}

function categorizeIntent(message) {
  const normalized = trimText(String(message || "")).toLowerCase();

  if (!normalized) {
    return "general";
  }

  if (
    normalized.includes("book")
    || normalized.includes("booking")
    || normalized.includes("appointment")
    || normalized.includes("schedule")
    || normalized.includes("availability")
    || normalized.includes("calendar")
    || normalized.includes("reserve")
    || normalized.includes("consultation")
    || normalized.includes("consult")
    || normalized.includes("meeting")
    || normalized.includes("demo")
  ) {
    return "booking";
  }

  if (
    normalized.includes("price")
    || normalized.includes("pricing")
    || normalized.includes("cost")
    || normalized.includes("quote")
    || normalized.includes("fee")
    || normalized.includes("buy")
    || normalized.includes("purchase")
    || normalized.includes("plan")
    || normalized.includes("package")
    || normalized.includes("how much")
  ) {
    return "pricing";
  }

  if (
    normalized.includes("problem")
    || normalized.includes("issue")
    || normalized.includes("broken")
    || normalized.includes("not working")
    || normalized.includes("complaint")
    || normalized.includes("refund")
    || normalized.includes("cancel")
    || normalized.includes("unhappy")
    || normalized.includes("support")
    || normalized.includes("frustrated")
    || normalized.includes("late")
  ) {
    return "support";
  }

  if (
    normalized.includes("contact")
    || normalized.includes("reach")
    || normalized.includes("call")
    || normalized.includes("email")
    || normalized.includes("phone")
    || normalized.includes("talk to")
    || normalized.includes("speak to")
    || normalized.includes("get in touch")
    || normalized.includes("someone")
  ) {
    return "contact";
  }

  if (
    normalized.includes("service")
    || normalized.includes("offer")
    || normalized.includes("product")
    || normalized.includes("help with")
    || normalized.includes("do you do")
    || normalized.includes("what do you do")
  ) {
    return "services";
  }

  return "general";
}

function normalizeQuestion(message) {
  return trimText(String(message || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getIntentLabel(intent) {
  switch (intent) {
    case "contact":
      return "Lead / contact";
    case "booking":
      return "Booking";
    case "pricing":
      return "Pricing / purchase";
    case "support":
      return "Support / complaint";
    case "services":
      return "Services";
    default:
      return "General";
  }
}

function getIntentDescription(intent) {
  switch (intent) {
    case "contact":
      return "Visitors are trying to speak to someone, call, email, or take a direct lead step.";
    case "booking":
      return "Visitors are asking to book, schedule, reserve, or check availability.";
    case "pricing":
      return "Visitors want pricing, quote, package, or purchase clarity.";
    case "support":
      return "Visitors may have a problem, concern, or support-style need.";
    case "services":
      return "Visitors are still learning what the business offers.";
    default:
      return "Questions are broad and exploratory rather than clearly commercial yet.";
  }
}

function getMessageTimestamp(message) {
  const value = new Date(message?.createdAt || "").getTime();
  return Number.isFinite(value) ? value : 0;
}

function getMessagesChronologically(messages) {
  return [...messages].sort((left, right) => getMessageTimestamp(left) - getMessageTimestamp(right));
}

function hasWeakAssistantReply(reply) {
  const normalized = trimText(String(reply || "")).toLowerCase();

  if (!normalized) {
    return true;
  }

  return [
    "i don't know",
    "i do not know",
    "i'm not sure",
    "i am not sure",
    "i don't have",
    "i do not have",
    "i couldn't find",
    "i could not find",
    "i can't find",
    "i cannot find",
    "not available on the website",
    "not mentioned on the website",
    "not provided on the website",
    "please contact the business directly",
    "please reach out directly",
    "reach out to the business directly",
  ].some((snippet) => normalized.includes(snippet));
}

function createEmptyIntentCounts() {
  return {
    general: 0,
    services: 0,
    pricing: 0,
    contact: 0,
    booking: 0,
    support: 0,
  };
}

function getUsageTrend(userMessages) {
  if (!userMessages.length) {
    return {
      label: "No real customer usage yet",
      copy: "Once visitors start using the assistant on a live site, Vonza will show what they ask about and which conversations need help.",
      recentCount: 0,
      previousCount: 0,
    };
  }

  const now = Date.now();
  const recentWindowStart = now - 7 * 24 * 60 * 60 * 1000;
  const previousWindowStart = now - 14 * 24 * 60 * 60 * 1000;
  let recentCount = 0;
  let previousCount = 0;
  let timestampedCount = 0;

  userMessages.forEach((message) => {
    const timestamp = getMessageTimestamp(message);

    if (!timestamp) {
      return;
    }

    timestampedCount += 1;

    if (timestamp >= recentWindowStart) {
      recentCount += 1;
      return;
    }

    if (timestamp >= previousWindowStart) {
      previousCount += 1;
    }
  });

  if (recentCount > 0 && previousCount === 0) {
    return {
      label: "First real usage is coming in",
      copy: `${recentCount} visitor question${recentCount === 1 ? "" : "s"} came in during the last 7 days.`,
      recentCount,
      previousCount,
    };
  }

  if (recentCount > previousCount) {
    return {
      label: "Usage is increasing",
      copy: `${recentCount} recent visitor question${recentCount === 1 ? "" : "s"} versus ${previousCount} in the previous 7-day window.`,
      recentCount,
      previousCount,
    };
  }

  if (recentCount > 0 && recentCount === previousCount) {
    return {
      label: "Usage is steady",
      copy: `${recentCount} visitor question${recentCount === 1 ? "" : "s"} came in during both recent 7-day windows.`,
      recentCount,
      previousCount,
    };
  }

  if (previousCount > recentCount) {
    return {
      label: "Usage slowed recently",
      copy: `${recentCount} visitor question${recentCount === 1 ? "" : "s"} arrived in the last 7 days versus ${previousCount} in the previous window.`,
      recentCount,
      previousCount,
    };
  }

  if (timestampedCount === 0) {
    return {
      label: "Early signal only",
      copy: `${userMessages.length} visitor question${userMessages.length === 1 ? "" : "s"} have been captured, but there is not enough dated history yet to show a time trend.`,
      recentCount: userMessages.length,
      previousCount: 0,
    };
  }

  return {
    label: "Early signal only",
    copy: "There is some conversation history, but not enough recent live usage to show a stronger trend yet.",
    recentCount,
    previousCount,
  };
}

function analyzeConversationSignals(messages) {
  const chronologicalMessages = getMessagesChronologically(messages);
  const userMessages = chronologicalMessages.filter((message) => message.role === "user" && trimText(message.content || ""));
  const intentCounts = createEmptyIntentCounts();
  const questionThemes = new Map();
  const weakAnswerExamples = [];
  let weakAnswerCount = 0;

  userMessages.forEach((message) => {
    const content = trimText(message.content || "");
    const intent = categorizeIntent(content);
    const normalizedQuestion = normalizeQuestion(content);
    intentCounts[intent] += 1;

    if (!normalizedQuestion) {
      return;
    }

    const existing = questionThemes.get(normalizedQuestion) || {
      label: content,
      count: 0,
      intent,
    };

    existing.count += 1;
    if (content.length < existing.label.length) {
      existing.label = content;
    }
    questionThemes.set(normalizedQuestion, existing);
  });

  chronologicalMessages.forEach((message, index) => {
    if (message.role !== "user") {
      return;
    }

    const question = trimText(message.content || "");
    if (!question) {
      return;
    }

    let reply = "";

    for (let cursor = index + 1; cursor < chronologicalMessages.length; cursor += 1) {
      const nextMessage = chronologicalMessages[cursor];

      if (nextMessage.role === "user") {
        break;
      }

      if (nextMessage.role === "assistant") {
        reply = trimText(nextMessage.content || "");
        break;
      }
    }

    if (!hasWeakAssistantReply(reply)) {
      return;
    }

    weakAnswerCount += 1;
    if (weakAnswerExamples.length < 4) {
      weakAnswerExamples.push(question);
    }
  });

  const topQuestions = [...questionThemes.values()]
    .sort((left, right) => right.count - left.count || left.label.length - right.label.length)
    .slice(0, 4);
  const topIntentEntries = Object.entries(intentCounts)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1]);
  const recentQuestions = [...userMessages]
    .slice(-3)
    .reverse()
    .map((message) => trimText(message.content || ""))
    .filter(Boolean);
  const highValueIntentCount =
    intentCounts.contact + intentCounts.booking + intentCounts.pricing + intentCounts.support;
  const usageTrend = getUsageTrend(userMessages);

  return {
    userMessages,
    userMessageCount: userMessages.length,
    recentQuestions,
    topQuestions,
    intentCounts,
    topIntentEntries,
    highValueIntentCount,
    weakAnswerCount,
    weakAnswerExamples,
    usageTrend,
  };
}

function createEmptyActionQueue() {
  return {
    items: [],
    people: [],
    peopleSummary: {
      total: 0,
      returning: 0,
      linkedQueueItems: 0,
    },
    summary: {
      total: 0,
      new: 0,
      reviewed: 0,
      done: 0,
      dismissed: 0,
      followUpNeeded: 0,
      followUpCompleted: 0,
      resolved: 0,
      attentionNeeded: 0,
    },
    persistenceAvailable: true,
    migrationRequired: false,
    followUpWorkflowAvailable: true,
    followUpWorkflowMigrationRequired: false,
  };
}

function normalizeActionQueueStatus(value) {
  const normalized = trimText(value).toLowerCase();
  return ACTION_QUEUE_STATUSES.includes(normalized) ? normalized : "new";
}

function getActionQueueStatusLabel(status) {
  switch (normalizeActionQueueStatus(status)) {
    case "reviewed":
      return "Reviewed";
    case "done":
      return "Done";
    case "dismissed":
      return "Dismissed";
    default:
      return "New";
  }
}

function getActionQueueStatusBadgeClass(status) {
  switch (normalizeActionQueueStatus(status)) {
    case "done":
      return "badge success";
    case "reviewed":
      return "badge warning";
    default:
      return "badge pending";
  }
}

function normalizeActionQueueBoolean(value) {
  if (value === true || value === false) {
    return value;
  }

  const normalized = trimText(value).toLowerCase();

  if (["yes", "true", "1"].includes(normalized)) {
    return true;
  }

  if (["no", "false", "0"].includes(normalized)) {
    return false;
  }

  return null;
}

function getFollowUpBooleanLabel(value) {
  if (value === true) {
    return "Yes";
  }

  if (value === false) {
    return "No";
  }

  return "Not set";
}

function getContactStatusLabel(value) {
  const normalized = trimText(value).toLowerCase();

  switch (normalized) {
    case "attempted":
      return "Attempted";
    case "contacted":
      return "Contacted";
    case "qualified":
      return "Qualified";
    case "not_contacted":
      return "Not contacted";
    default:
      return "Not set";
  }
}

function hasActionQueueOwnerHandoff(item = {}) {
  return Boolean(
    trimText(item.note)
    || trimText(item.outcome)
    || trimText(item.nextStep)
    || normalizeActionQueueBoolean(item.followUpNeeded) !== null
    || normalizeActionQueueBoolean(item.followUpCompleted) !== null
    || trimText(item.contactStatus)
  );
}

function getActionQueueOwnerWorkflow(item = {}) {
  if (item.ownerWorkflow && typeof item.ownerWorkflow === "object") {
    return {
      key: trimText(item.ownerWorkflow.key) || "needs_review",
      label: trimText(item.ownerWorkflow.label) || "Needs owner review",
      copy: trimText(item.ownerWorkflow.copy) || "This flagged conversation still needs an owner decision on what happened next.",
      attention: item.ownerWorkflow.attention !== false,
      resolved: item.ownerWorkflow.resolved === true,
      rank: Number.isFinite(Number(item.ownerWorkflow.rank)) ? Number(item.ownerWorkflow.rank) : 99,
    };
  }

  const status = normalizeActionQueueStatus(item.status);
  const followUpCompleted = normalizeActionQueueBoolean(item.followUpCompleted);
  const followUpNeeded = normalizeActionQueueBoolean(item.followUpNeeded);
  const handoffStarted = hasActionQueueOwnerHandoff(item);
  const resolved = followUpCompleted === true || status === "done";

  if (status === "dismissed") {
    return {
      key: "dismissed",
      label: "Dismissed",
      copy: "This item was intentionally dismissed from the owner follow-up workflow.",
      attention: false,
      resolved: false,
      rank: 5,
    };
  }

  if (resolved) {
    return {
      key: "resolved",
      label: "Resolved",
      copy: trimText(item.outcome)
        ? "A resolution is recorded and this queue item no longer needs active follow-up."
        : "This queue item is marked complete and no longer needs active follow-up.",
      attention: false,
      resolved: true,
      rank: 4,
    };
  }

  if (followUpNeeded === true) {
    return {
      key: handoffStarted ? "follow_up_in_progress" : "follow_up_needed",
      label: handoffStarted ? "Follow-up in progress" : "Needs follow-up",
      copy: trimText(item.nextStep)
        ? `Next step: ${trimText(item.nextStep)}`
        : "The owner still needs to follow up on this conversation signal.",
      attention: true,
      resolved: false,
      rank: handoffStarted ? 1 : 0,
    };
  }

  if (status === "reviewed" || handoffStarted) {
    return {
      key: "reviewed_pending",
      label: "Reviewed",
      copy: trimText(item.outcome)
        ? "Owner context is recorded, but the item is not marked resolved yet."
        : "The owner has started reviewing this item, but the final outcome is not recorded yet.",
      attention: true,
      resolved: false,
      rank: 2,
    };
  }

  return {
    key: "needs_review",
    label: "Needs owner review",
    copy: "This flagged conversation still needs an owner decision on what happened next.",
    attention: true,
    resolved: false,
    rank: 3,
  };
}

function getActionQueueOwnerWorkflowBadgeClass(item = {}) {
  const workflow = getActionQueueOwnerWorkflow(item);

  if (workflow.key === "resolved") {
    return "badge success";
  }

  if (workflow.key === "follow_up_in_progress" || workflow.key === "reviewed_pending") {
    return "badge warning";
  }

  if (workflow.key === "dismissed") {
    return "pill";
  }

  return "badge pending";
}

function formatActionQueueContact(item) {
  const name = trimText(item?.contactInfo?.name);
  const email = trimText(item?.contactInfo?.email);
  const phone = trimText(item?.contactInfo?.phone);

  if (name && email && phone) {
    return `${name} · ${email} · ${phone}`;
  }

  if (name && email) {
    return `${name} · ${email}`;
  }

  if (name && phone) {
    return `${name} · ${phone}`;
  }

  if (name) {
    return name;
  }

  if (email && phone) {
    return `${email} · ${phone}`;
  }

  if (email) {
    return email;
  }

  if (phone) {
    return phone;
  }

  return "Contact not captured yet";
}

function getActionQueueTypeLabel(type) {
  if (type === "weak_answer") {
    return "Weak answers";
  }

  if (type === "repeat_high_intent") {
    return "Repeat visitor";
  }

  return getIntentLabel(type);
}

function getOperatorActionTypeLabel(item = {}) {
  switch (trimText(item.actionType).toLowerCase()) {
    case "lead_follow_up":
      return "Lead follow-up";
    case "pricing_interest":
      return "Pricing interest";
    case "booking_intent":
      return "Booking intent";
    case "repeat_high_intent_visitor":
      return "Repeat high-intent visitor";
    case "knowledge_gap":
      return "Knowledge gap";
    case "unanswered_question":
      return "Unanswered question";
    default:
      return getActionQueueTypeLabel(item.type);
  }
}

function getFollowUpStatusLabel(value) {
  const normalized = trimText(value).toLowerCase();

  switch (normalized) {
    case "draft":
      return "Draft";
    case "ready":
      return "Ready";
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
    case "dismissed":
      return "Dismissed";
    case "missing_contact":
      return "Missing contact";
    default:
      return "Not prepared";
  }
}

function getFollowUpStatusBadgeClass(value) {
  const normalized = trimText(value).toLowerCase();

  if (normalized === "sent") {
    return "badge success";
  }

  if (normalized === "dismissed") {
    return "pill";
  }

  if (normalized === "failed" || normalized === "missing_contact") {
    return "badge pending";
  }

  if (normalized === "ready") {
    return "badge warning";
  }

  return "badge pending";
}

function formatFollowUpChannel(value) {
  const normalized = trimText(value).toLowerCase();

  switch (normalized) {
    case "email":
      return "Email";
    case "phone":
      return "Phone / text";
    case "manual":
      return "Manual";
    default:
      return "Not set";
  }
}

function buildActionQueueSummaryPills(summary = {}) {
  const counts = {
    ...createEmptyActionQueue().summary,
    ...summary,
  };

  return [
    `${counts.total} total`,
    `${counts.attentionNeeded} need attention`,
    `${counts.followUpNeeded} follow-up needed`,
    `${counts.resolved} resolved`,
  ];
}

function buildPeopleSummaryPills(summary = {}) {
  const counts = {
    ...createEmptyActionQueue().peopleSummary,
    ...summary,
  };

  return [
    `${counts.total} people`,
    `${counts.returning} returning`,
    `${counts.linkedQueueItems} with queue items`,
  ];
}

function formatPersonIdentity(person = {}) {
  const name = trimText(person.name);
  const email = trimText(person.email);
  const phone = trimText(person.phone);

  if (name && email && phone) {
    return `${name} · ${email} · ${phone}`;
  }

  if (name && email) {
    return `${name} · ${email}`;
  }

  if (name && phone) {
    return `${name} · ${phone}`;
  }

  if (name || email || phone) {
    return name || email || phone;
  }

  if (trimText(person.identityType) === "session") {
    return "Session continuity only";
  }

  return "Identity unknown";
}

function formatPersonIntents(person = {}) {
  if (!Array.isArray(person.keyIntents) || !person.keyIntents.length) {
    return "No clear intent pattern yet";
  }

  return person.keyIntents
    .map((entry) => `${trimText(entry.label) || getIntentLabel(entry.intent)}${Number(entry.count) > 1 ? ` (${entry.count})` : ""}`)
    .join(" · ");
}

function buildPeopleMarkup(actionQueue = createEmptyActionQueue()) {
  const people = Array.isArray(actionQueue.people) ? actionQueue.people : [];
  const peopleSummary = {
    ...createEmptyActionQueue().peopleSummary,
    ...(actionQueue.peopleSummary || {}),
  };

  if (!people.length) {
    return `
      <section class="workspace-card-soft people-shell">
        <div class="people-header">
          <div>
            <h3 class="studio-group-title">People view</h3>
            <p class="studio-group-copy">When Vonza sees strong enough repeat-visitor signals, it stitches them into a lightweight person thread here.</p>
          </div>
        </div>
        <div class="placeholder-card">No repeat-visitor stitching yet. As soon as Vonza can confidently connect multiple interactions to the same person, this view will show their snippets, intents, timeline, and follow-up state.</div>
      </section>
    `;
  }

  return `
    <section class="workspace-card-soft people-shell">
      <div class="people-header">
        <div>
          <h3 class="studio-group-title">People view</h3>
          <p class="studio-group-copy">This is the lightweight person layer behind the queue. It helps the owner see when the same lead comes back or the same issue keeps evolving.</p>
        </div>
        <div class="action-queue-summary">
          ${buildPeopleSummaryPills(peopleSummary).map((label) => `
            <span class="pill">${escapeHtml(label)}</span>
          `).join("")}
        </div>
      </div>
      <div class="people-list">
        ${people.slice(0, 6).map((person) => `
          <article class="person-card">
            <div class="person-card-top">
              <div class="action-queue-headline">
                <div class="action-queue-badges">
                  <span class="pill">${escapeHtml(person.label || "Unknown visitor")}</span>
                  <span class="pill">${escapeHtml(`${person.interactionCount || 0} interaction${person.interactionCount === 1 ? "" : "s"}`)}</span>
                  <span class="pill">${escapeHtml(`${person.queueItemCount || 0} queue item${person.queueItemCount === 1 ? "" : "s"}`)}</span>
                  <span class="${person.followUp?.attentionCount > 0 ? "badge pending" : person.followUp?.key === "resolved" ? "badge success" : "pill"}">${escapeHtml(person.followUp?.label || "No queue items yet")}</span>
                </div>
                <h4 class="action-queue-title">${escapeHtml(person.story || "Person-level thread")}</h4>
                <p class="action-queue-copy">${escapeHtml(person.isReturning ? "Vonza detected repeat visitor signals across these interactions." : "Vonza has one stitched interaction for this visitor so far.")}</p>
              </div>
              <div class="action-queue-meta-inline">${escapeHtml(person.lastSeenAt ? `Last seen ${formatSeenAt(person.lastSeenAt)}` : "Recent signal")}</div>
            </div>
            <div class="action-queue-details">
              <div class="action-queue-detail">
                <span class="action-queue-detail-label">Identity signal</span>
                <strong class="action-queue-detail-value">${escapeHtml(formatPersonIdentity(person))}</strong>
              </div>
              <div class="action-queue-detail">
                <span class="action-queue-detail-label">Key intents</span>
                <strong class="action-queue-detail-value">${escapeHtml(formatPersonIntents(person))}</strong>
              </div>
              <div class="action-queue-detail">
                <span class="action-queue-detail-label">Follow-up status</span>
                <strong class="action-queue-detail-value">${escapeHtml(person.followUp?.label || "No queue items yet")}</strong>
                <p class="action-queue-copy">${escapeHtml(person.followUp?.copy || "This visitor has no queue-linked follow-up yet.")}</p>
              </div>
              <div class="action-queue-detail">
                <span class="action-queue-detail-label">Timeline</span>
                <strong class="action-queue-detail-value">${escapeHtml(person.firstSeenAt && person.lastSeenAt && person.firstSeenAt !== person.lastSeenAt ? `${formatSeenAt(person.firstSeenAt)} to ${formatSeenAt(person.lastSeenAt)}` : person.lastSeenAt ? formatSeenAt(person.lastSeenAt) : "Recent signal")}</strong>
              </div>
            </div>
            <div class="person-snippets">
              <div class="person-subsection">
                <span class="action-queue-detail-label">Combined conversation snippets</span>
                <div class="question-list">
                  ${Array.isArray(person.snippets) && person.snippets.length ? person.snippets.map((snippet) => `
                    <div class="question-row">${escapeHtml(snippet.text || "No snippet stored yet.")}</div>
                  `).join("") : `<div class="placeholder-card">No stored snippets yet.</div>`}
                </div>
              </div>
              <div class="person-subsection">
                <span class="action-queue-detail-label">Basic timeline</span>
                <div class="timeline-list">
                  ${Array.isArray(person.timeline) && person.timeline.length ? person.timeline.map((entry) => `
                    <div class="timeline-row">
                      <strong>${escapeHtml(entry.at ? formatSeenAt(entry.at) : "Recent")}</strong>
                      <span>${escapeHtml(entry.summary || entry.label || "Conversation signal")}</span>
                    </div>
                  `).join("") : `<div class="placeholder-card">No timeline yet.</div>`}
                </div>
              </div>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function buildActionQueueMarkup(agent, actionQueue = createEmptyActionQueue(), options = {}) {
  const items = Array.isArray(actionQueue.items) ? actionQueue.items : [];
  const summary = {
    ...createEmptyActionQueue().summary,
    ...(actionQueue.summary || {}),
  };
  const persistenceAvailable = actionQueue.persistenceAvailable !== false;
  const migrationRequired = actionQueue.migrationRequired === true;
  const followUpWorkflowAvailable = actionQueue.followUpWorkflowAvailable !== false;
  const followUpWorkflowMigrationRequired = actionQueue.followUpWorkflowMigrationRequired === true;
  const compact = Boolean(options.compact);
  const allowStatusUpdates = options.allowStatusUpdates !== false && persistenceAvailable;
  const visibleItems = compact ? items.slice(0, 3) : items;
  const sectionTitle = compact ? "Action queue feed" : "Action queue";
  const sectionCopy = compact
    ? "Analytics turns into action here. These are the individual conversations that deserve owner follow-up or a better answer path."
    : "These items are surfaced from real visitor conversations so the owner can work specific follow-up moments instead of broad signal buckets.";
  const emptyCopy = compact
    ? "No conversation-derived actions yet. As soon as visitors show stronger commercial intent or Vonza gives a weak answer, the next owner actions will appear here."
    : "No actionable items yet. Once Vonza sees high-intent conversations or weak answers, the next owner actions will appear here instead of a fake busy state.";

  const buildStatusOptions = (currentStatus) =>
    ACTION_QUEUE_STATUSES.map((status) => `
      <option value="${status}" ${normalizeActionQueueStatus(currentStatus) === status ? "selected" : ""}>${getActionQueueStatusLabel(status)}</option>
    `).join("");

  const buildContactStatusOptions = (currentValue) => {
    const normalized = trimText(currentValue).toLowerCase();

    return [
      { value: "", label: "Not set" },
      { value: "not_contacted", label: "Not contacted" },
      { value: "attempted", label: "Attempted" },
      { value: "contacted", label: "Contacted" },
      { value: "qualified", label: "Qualified" },
    ].map((option) => `
      <option value="${option.value}" ${normalized === option.value ? "selected" : ""}>${option.label}</option>
    `).join("");
  };

  const itemsMarkup = visibleItems.map((item, index) => {
    const workflow = getActionQueueOwnerWorkflow(item);
    const handoffOpenByDefault = !compact && workflow.attention && index === 0;
    const recencyLabel = item.lastSeenAt ? formatSeenAt(item.lastSeenAt) : "Recent signal";
    const metaLine = item.updatedAt
      ? `Flagged ${recencyLabel} · Updated ${formatSeenAt(item.updatedAt)}`
      : `Flagged ${recencyLabel}`;
    const personThreadLabel = item.person?.relatedInteractionCount > 1
      ? `${item.person.label || "Returning visitor"} · ${item.person.relatedInteractionCount} interactions`
      : "";
    const followUp = item.followUp && typeof item.followUp === "object" ? item.followUp : null;
    const followUpStatus = trimText(followUp?.status).toLowerCase();
    const followUpSupported = item.followUpSupported === true;
    const followUpActionsDisabled = !allowStatusUpdates || !followUpWorkflowAvailable || !followUp?.id;
    const followUpNeedsContact = followUpStatus === "missing_contact";
    const followUpReadOnly = followUpStatus === "sent" || followUpStatus === "dismissed";
    const toggleOpenLabel = item.note || item.outcome || item.nextStep || item.contactStatus
      ? "Edit owner handoff"
      : "Open owner handoff";
    const followUpSummary = followUpSupported
      ? `
        ${followUpWorkflowMigrationRequired ? `<div class="placeholder-card">Prepared follow-up is read-only until the workflow migration is applied. Run db/agent_follow_up_workflows.sql before using this live.</div>` : ""}
        ${followUp ? `
          <form class="action-queue-follow-up-form" data-follow-up-form data-follow-up-id="${escapeHtml(followUp.id || "")}" data-action-key="${escapeHtml(item.key || "")}">
            <div class="action-queue-handoff-summary">
              <div class="action-queue-handoff-item">
                <span class="action-queue-detail-label">Operator action</span>
                <strong class="action-queue-detail-value">${escapeHtml(getOperatorActionTypeLabel(item))}</strong>
              </div>
              <div class="action-queue-handoff-item">
                <span class="action-queue-detail-label">Follow-up status</span>
                <strong class="action-queue-detail-value">${escapeHtml(getFollowUpStatusLabel(followUp.status))}</strong>
              </div>
              <div class="action-queue-handoff-item">
                <span class="action-queue-detail-label">Channel</span>
                <strong class="action-queue-detail-value">${escapeHtml(formatFollowUpChannel(followUp.channel))}</strong>
              </div>
              <div class="action-queue-handoff-item">
                <span class="action-queue-detail-label">Why this was prepared</span>
                <strong class="action-queue-detail-value">${escapeHtml(followUp.whyPrepared || item.whyFlagged || "Prepared from this queue item.")}</strong>
              </div>
            </div>
            <div class="action-queue-secondary-action">
              ${item.messageId ? `<button class="ghost-button" type="button" data-open-conversation data-message-id="${escapeHtml(item.messageId)}">Open related conversation</button>` : ""}
              <button class="ghost-button" type="button" data-copy-follow-up ${trimText(followUp.draftContent) ? "" : "disabled"}>Copy draft</button>
            </div>
            <div class="form-grid two-col">
              <div class="field">
                <label for="follow-up-subject-${escapeHtml(item.key || "")}">Subject</label>
                <input id="follow-up-subject-${escapeHtml(item.key || "")}" name="subject" type="text" value="${escapeHtml(followUp.subject || "")}" ${followUpActionsDisabled || followUpReadOnly ? "disabled" : ""}>
              </div>
              <div class="field">
                <label for="follow-up-status-${escapeHtml(item.key || "")}">Current status</label>
                <input id="follow-up-status-${escapeHtml(item.key || "")}" type="text" value="${escapeHtml(getFollowUpStatusLabel(followUp.status))}" disabled>
                <p class="field-help">${escapeHtml(followUpNeedsContact ? "No sendable contact is stored yet. Keep the draft context, review the conversation, and wait for contact capture." : followUpStatus === "sent" ? "This follow-up is resolved unless you deliberately reopen it." : "Mark sent after you send this outreach outside Vonza." )}</p>
              </div>
            </div>
            <div class="field">
              <label for="follow-up-draft-${escapeHtml(item.key || "")}">Draft</label>
              <textarea id="follow-up-draft-${escapeHtml(item.key || "")}" name="draft_content" ${followUpActionsDisabled || followUpReadOnly ? "disabled" : ""}>${escapeHtml(followUp.draftContent || "")}</textarea>
            </div>
            ${followUp.lastError ? `<p class="action-queue-copy">${escapeHtml(`Last failure: ${followUp.lastError}`)}</p>` : ""}
            <div class="action-queue-form-actions">
              <button class="primary-button" type="submit" ${followUpActionsDisabled || followUpReadOnly ? "disabled" : ""}>Save draft</button>
              <button class="ghost-button" type="button" data-follow-up-status-action data-next-status="ready" ${followUpActionsDisabled || followUpNeedsContact || followUpReadOnly ? "disabled" : ""}>Mark ready</button>
              <button class="ghost-button" type="button" data-follow-up-status-action data-next-status="sent" ${followUpActionsDisabled || followUpNeedsContact || followUpReadOnly ? "disabled" : ""}>Mark sent</button>
              <button class="ghost-button" type="button" data-follow-up-status-action data-next-status="dismissed" ${followUpActionsDisabled || followUpStatus === "sent" ? "disabled" : ""}>Dismiss</button>
              <span class="action-queue-meta-inline">${escapeHtml(followUpNeedsContact ? "Vonza kept the draft context but blocked sending until contact capture exists." : "This draft stays deterministic and grounded in the captured conversation context.")}</span>
            </div>
          </form>
        ` : `<div class="placeholder-card">Vonza will prepare a follow-up workflow for this queue item as soon as the server bridge syncs it.</div>`}
      `
      : "";

    return `
    <article
      class="action-queue-item"
      data-action-queue-item
      data-action-key="${escapeHtml(item.key || "")}"
      data-action-queue-type="${escapeHtml(item.type || "")}"
      data-action-queue-status="${escapeHtml(normalizeActionQueueStatus(item.status))}"
    >
      <div class="action-queue-item-top">
        <div class="action-queue-headline">
          <div class="action-queue-badges">
            <span class="pill">${escapeHtml(getOperatorActionTypeLabel(item))}</span>
            <span class="${getActionQueueStatusBadgeClass(item.status)}">${escapeHtml(getActionQueueStatusLabel(item.status))}</span>
            <span class="${getActionQueueOwnerWorkflowBadgeClass(item)}">${escapeHtml(workflow.label)}</span>
            ${followUp ? `<span class="${getFollowUpStatusBadgeClass(followUp.status)}">${escapeHtml(getFollowUpStatusLabel(followUp.status))}</span>` : ""}
            <span class="pill">${escapeHtml(`${item.count || 0} conversation${item.count === 1 ? "" : "s"}`)}</span>
            ${personThreadLabel ? `<span class="pill">${escapeHtml(personThreadLabel)}</span>` : ""}
          </div>
          <h4 class="action-queue-title">${escapeHtml(item.label || getActionQueueTypeLabel(item.type))}</h4>
          <p class="action-queue-copy">${escapeHtml(item.whyFlagged || "Flagged from recent conversation activity.")}</p>
        </div>
        ${allowStatusUpdates ? `
          <label class="action-queue-control">
            <span class="action-queue-control-label">Status</span>
            <select
              data-action-queue-status
              data-action-key="${escapeHtml(item.key || "")}"
              ${allowStatusUpdates ? "" : "disabled"}
            >
              ${buildStatusOptions(item.status)}
            </select>
          </label>
        ` : `
          <div class="action-queue-meta-inline">${escapeHtml(metaLine)}</div>
        `}
      </div>
      <div class="action-queue-details">
        <div class="action-queue-detail">
          <span class="action-queue-detail-label">Conversation summary</span>
          <strong class="action-queue-detail-value">${escapeHtml(item.snippet || "No customer question stored yet.")}</strong>
        </div>
        <div class="action-queue-detail">
          <span class="action-queue-detail-label">Why it was flagged</span>
          <strong class="action-queue-detail-value">${escapeHtml(item.whyFlagged || "Flagged from recent conversation activity.")}</strong>
        </div>
        <div class="action-queue-detail">
          <span class="action-queue-detail-label">Operator action</span>
          <strong class="action-queue-detail-value">${escapeHtml(getOperatorActionTypeLabel(item))}</strong>
        </div>
        <div class="action-queue-detail">
          <span class="action-queue-detail-label">Contact</span>
          <strong class="action-queue-detail-value">${escapeHtml(formatActionQueueContact(item))}</strong>
        </div>
        <div class="action-queue-detail">
          <span class="action-queue-detail-label">Visitor thread</span>
          <strong class="action-queue-detail-value">${escapeHtml(item.person?.label || "Unknown visitor")}</strong>
          <p class="action-queue-copy">${escapeHtml(item.person?.story || "Vonza could not confidently stitch this item to another visitor interaction yet.")}</p>
        </div>
        <div class="action-queue-detail">
          <span class="action-queue-detail-label">Owner follow-up state</span>
          <strong class="action-queue-detail-value">${escapeHtml(workflow.label)}</strong>
          <p class="action-queue-copy">${escapeHtml(workflow.copy)}</p>
        </div>
        <div class="action-queue-detail">
          <span class="action-queue-detail-label">Suggested next action</span>
          <strong class="action-queue-detail-value">${escapeHtml(item.suggestedAction || "Review the conversation pattern and improve the assistant or website flow.")}</strong>
        </div>
        <div class="action-queue-detail">
          <span class="action-queue-detail-label">Recency</span>
          <strong class="action-queue-detail-value">${escapeHtml(recencyLabel)}</strong>
        </div>
      </div>
      ${allowStatusUpdates ? `<p class="action-queue-meta-inline">${escapeHtml(metaLine)}</p>` : ""}
      ${compact ? "" : `
        <div class="action-queue-handoff">
          ${followUpSummary}
          <div class="action-queue-handoff-summary">
            <div class="action-queue-handoff-item">
              <span class="action-queue-detail-label">Owner note</span>
              <strong class="action-queue-detail-value">${escapeHtml(item.note || "No owner note yet.")}</strong>
            </div>
            <div class="action-queue-handoff-item">
              <span class="action-queue-detail-label">Outcome</span>
              <strong class="action-queue-detail-value">${escapeHtml(item.outcome || "No outcome recorded yet.")}</strong>
            </div>
            <div class="action-queue-handoff-item">
              <span class="action-queue-detail-label">Next step</span>
              <strong class="action-queue-detail-value">${escapeHtml(item.nextStep || "No next step recorded yet.")}</strong>
            </div>
            <div class="action-queue-handoff-item">
              <span class="action-queue-detail-label">Follow-up needed</span>
              <strong class="action-queue-detail-value">${escapeHtml(getFollowUpBooleanLabel(item.followUpNeeded))}</strong>
            </div>
            <div class="action-queue-handoff-item">
              <span class="action-queue-detail-label">Follow-up completed</span>
              <strong class="action-queue-detail-value">${escapeHtml(getFollowUpBooleanLabel(item.followUpCompleted))}</strong>
            </div>
            <div class="action-queue-handoff-item">
              <span class="action-queue-detail-label">Contact status</span>
              <strong class="action-queue-detail-value">${escapeHtml(item.contactCaptured ? getContactStatusLabel(item.contactStatus) : "Contact not captured")}</strong>
            </div>
          </div>
          <div class="action-queue-secondary-action">
            <button
              class="ghost-button"
              type="button"
              data-action-queue-toggle
              data-action-key="${escapeHtml(item.key || "")}"
              data-open-label="${escapeHtml(toggleOpenLabel)}"
              data-close-label="Hide owner handoff"
            >
              ${handoffOpenByDefault ? "Hide owner handoff" : escapeHtml(toggleOpenLabel)}
            </button>
          </div>
          <form class="action-queue-form" data-action-queue-form data-action-key="${escapeHtml(item.key || "")}" ${handoffOpenByDefault ? "" : "hidden"}>
            <div class="form-grid two-col">
              <div class="field">
                <label for="queue-note-${escapeHtml(item.key || "")}">Owner note</label>
                <textarea id="queue-note-${escapeHtml(item.key || "")}" name="note" ${allowStatusUpdates ? "" : "disabled"}>${escapeHtml(item.note || "")}</textarea>
              </div>
              <div class="field">
                <label for="queue-outcome-${escapeHtml(item.key || "")}">Outcome / resolution</label>
                <textarea id="queue-outcome-${escapeHtml(item.key || "")}" name="outcome" ${allowStatusUpdates ? "" : "disabled"}>${escapeHtml(item.outcome || "")}</textarea>
              </div>
            </div>
            <div class="form-grid two-col">
              <div class="field">
                <label for="queue-next-step-${escapeHtml(item.key || "")}">Next step</label>
                <input id="queue-next-step-${escapeHtml(item.key || "")}" name="next_step" type="text" value="${escapeHtml(item.nextStep || "")}" ${allowStatusUpdates ? "" : "disabled"}>
              </div>
              <div class="field">
                <label for="queue-contact-status-${escapeHtml(item.key || "")}">Contact status</label>
                <select id="queue-contact-status-${escapeHtml(item.key || "")}" name="contact_status" ${allowStatusUpdates && item.contactCaptured ? "" : "disabled"}>
                  ${buildContactStatusOptions(item.contactStatus)}
                </select>
                <p class="field-help">${escapeHtml(item.contactCaptured ? "Use this if the conversation captured contact details." : "Contact status becomes relevant once contact information is captured.")}</p>
              </div>
            </div>
            <div class="form-grid two-col">
              <div class="field">
                <label for="queue-follow-up-needed-${escapeHtml(item.key || "")}">Follow-up needed</label>
                <select id="queue-follow-up-needed-${escapeHtml(item.key || "")}" name="follow_up_needed" ${allowStatusUpdates ? "" : "disabled"}>
                  <option value="" ${item.followUpNeeded === null || item.followUpNeeded === undefined ? "selected" : ""}>Not set</option>
                  <option value="true" ${item.followUpNeeded === true ? "selected" : ""}>Yes</option>
                  <option value="false" ${item.followUpNeeded === false ? "selected" : ""}>No</option>
                </select>
              </div>
              <div class="field">
                <label for="queue-follow-up-completed-${escapeHtml(item.key || "")}">Follow-up completed</label>
                <select id="queue-follow-up-completed-${escapeHtml(item.key || "")}" name="follow_up_completed" ${allowStatusUpdates ? "" : "disabled"}>
                  <option value="" ${item.followUpCompleted === null || item.followUpCompleted === undefined ? "selected" : ""}>Not set</option>
                  <option value="true" ${item.followUpCompleted === true ? "selected" : ""}>Yes</option>
                  <option value="false" ${item.followUpCompleted === false ? "selected" : ""}>No</option>
                </select>
              </div>
            </div>
            <div class="action-queue-form-actions">
              <button class="primary-button" type="submit" ${allowStatusUpdates ? "" : "disabled"}>Save owner handoff</button>
              <span class="action-queue-meta-inline">${escapeHtml(migrationRequired ? "Apply the action queue migration before follow-up can be saved." : "Keep this lightweight: note what happened, record the outcome, and decide whether follow-up is still needed.")}</span>
            </div>
          </form>
        </div>
      `}
    </article>
  `;
  }).join("");

  return `
    <section class="${compact ? "workspace-card-soft action-queue-shell compact" : "overview-card overview-card-queue action-queue-shell"}" ${compact ? "" : 'data-action-queue-section'}>
      <div class="action-queue-header">
        <div>
          <h3 class="${compact ? "studio-group-title" : "overview-card-title"}">${sectionTitle}</h3>
          <p class="${compact ? "studio-group-copy" : "overview-card-copy"}">${escapeHtml(sectionCopy)}</p>
        </div>
        <div class="action-queue-summary">
          ${buildActionQueueSummaryPills(summary).map((label) => `
            <span class="pill">${escapeHtml(label)}</span>
          `).join("")}
        </div>
      </div>
      ${migrationRequired ? `<div class="placeholder-card">Action queue follow-up is currently read-only because the database migration for persistent queue fields is not applied yet. Apply db/action_queue_statuses.sql before using this operational handoff live.</div>` : ""}
      ${!migrationRequired && followUpWorkflowMigrationRequired ? `<div class="placeholder-card">Prepared follow-up workflows are read-only because the workflow migration is not applied yet. Apply db/agent_follow_up_workflows.sql before using outbound follow-up from the queue.</div>` : ""}
      ${visibleItems.length ? `
        ${compact ? `
          <div class="action-queue-secondary-action">
            <button class="ghost-button" type="button" data-overview-target="overview">Review in Overview</button>
          </div>
        ` : `
          <div class="action-queue-filter-row">
            <label class="action-queue-filter">
              <span class="action-queue-filter-label">Filter by type</span>
              <select data-action-queue-filter-type>
                <option value="all">All types</option>
                <option value="contact">Lead / contact</option>
                <option value="booking">Booking</option>
                <option value="pricing">Pricing / purchase</option>
                <option value="repeat_high_intent">Repeat high intent</option>
                <option value="support">Support / complaint</option>
                <option value="weak_answer">Weak answers</option>
              </select>
            </label>
            <label class="action-queue-filter">
              <span class="action-queue-filter-label">Filter by status</span>
              <select data-action-queue-filter-status>
                <option value="all">All statuses</option>
                ${ACTION_QUEUE_STATUSES.map((status) => `
                  <option value="${status}">${getActionQueueStatusLabel(status)}</option>
                `).join("")}
              </select>
            </label>
          </div>
        `}
        <div class="action-queue-list">
          ${itemsMarkup}
        </div>
        ${compact ? "" : `<div class="placeholder-card action-queue-filter-empty" hidden>No action items match the current filters. Adjust the filters to see the queue again.</div>`}
      ` : `<div class="placeholder-card">${escapeHtml(emptyCopy)}</div>`}
    </section>
  `;
}

function buildOverviewState(agent, messages, setup, actionQueue = createEmptyActionQueue()) {
  const installStatus = agent.installStatus || {
    state: "not_detected",
    label: "Not detected on a live site yet",
    host: "",
    lastSeenAt: null,
  };
  const signals = analyzeConversationSignals(messages);
  const messageCount = Number(agent.messageCount || messages.length || 0);
  const lastActivity = agent.lastMessageAt || installStatus.lastSeenAt || null;
  const activity = getActivityLevel(signals.userMessageCount || messageCount, agent.lastMessageAt);
  const topIntent = signals.topIntentEntries[0];
  const recentQuestions = signals.recentQuestions || [];
  const queueSummary = {
    ...createEmptyActionQueue().summary,
    ...(actionQueue.summary || {}),
  };
  const peopleSummary = {
    ...createEmptyActionQueue().peopleSummary,
    ...(actionQueue.peopleSummary || {}),
  };

  const nextActions = [];
  let primaryAction = null;
  let title = "Your assistant workspace";
  let copy = "Your assistant is set up in Vonza and ready for the next step.";

  if (!setup.isReady) {
    title = "Your workspace is open. The next step is finishing setup.";
    copy = "Use Customize to shape the assistant, confirm the website, and make sure everything feels right before you install it.";
    primaryAction = {
      label: "Continue setup",
      type: "section",
      value: "customize",
    };
    if (trimText(agent.publicAgentKey)) {
      nextActions.push({
        label: "Try your assistant",
        type: "preview",
      });
    }
  } else if (installStatus.state === "live") {
    if (queueSummary.attentionNeeded > 0) {
      title = `Your assistant is live and ${queueSummary.attentionNeeded} follow-up item${queueSummary.attentionNeeded === 1 ? "" : "s"} need attention`;
      copy = `Vonza is live on ${installStatus.host || "your site"} and is surfacing visitor conversations that deserve owner follow-up or a stronger answer path.`;
      primaryAction = {
        label: "Review action queue",
        type: "focus",
        value: "action-queue",
      };
      nextActions.push({
        label: "Review analytics",
        type: "section",
        value: "analytics",
      });
    } else if (signals.weakAnswerCount > 0) {
      title = "Your assistant is live, and a few answers need strengthening";
      copy = `Vonza is active on ${installStatus.host || "your site"}, and some real customer questions are showing where the assistant still needs help.`;
      primaryAction = {
        label: "Review weak answers",
        type: "section",
        value: "analytics",
      };
      nextActions.push({
        label: "Refine setup",
        type: "section",
        value: "customize",
      });
    } else if (signals.highValueIntentCount > 0) {
      title = "Your assistant is live and showing real buyer intent";
      copy = `Vonza is live on ${installStatus.host || "your site"} and is already capturing high-value visitor intent you can act on.`;
      primaryAction = {
        label: "Review analytics",
        type: "section",
        value: "analytics",
      };
      nextActions.push({
        label: "Refine setup",
        type: "section",
        value: "customize",
      });
    } else if (messageCount > 0) {
      title = "Your assistant is live and already working";
      copy = `Vonza is live on ${installStatus.host || "your site"} and has already started handling real customer questions.`;
      primaryAction = {
        label: "Review analytics",
        type: "section",
        value: "analytics",
      };
      nextActions.push({
        label: "Refine setup",
        type: "section",
        value: "customize",
      });
    } else {
      title = "Your assistant is live";
      copy = `Vonza has been detected on ${installStatus.host || "your site"} and is ready for customer questions, even if activity is still early.`;
      primaryAction = {
        label: "Try your assistant",
        type: "preview",
      };
      nextActions.push({
        label: "Improve setup",
        type: "section",
        value: "customize",
      });
      nextActions.push({
        label: "Try your assistant",
        type: "preview",
      });
    }
  } else if (installStatus.state === "test") {
    title = "Your assistant is ready for a live launch";
    copy = "Vonza has been seen in preview or test environments. The next step is placing it on your live site so customers can actually use it.";
    primaryAction = {
      label: "Add to website",
      type: "focus",
      value: "install",
    };
    nextActions.push({
      label: "Copy install code",
      type: "install",
    });
  } else {
    title = "Your assistant is almost ready to go live";
    copy = "The setup is in place, and the next step is getting the widget onto your live site so Vonza can start helping visitors.";
    primaryAction = {
      label: "Add to website",
      type: "focus",
      value: "install",
    };
    nextActions.push({
      label: "Copy install code",
      type: "install",
    });
  }

  if (!setup.knowledgeReady) {
    if (primaryAction) {
      nextActions.unshift(primaryAction);
    }
    primaryAction = {
      label: "Strengthen website knowledge",
      type: "import",
    };
  }

  const progressItems = [
    {
      title: "Workspace unlocked",
      copy: "You are inside the paid Vonza workspace.",
      done: true,
    },
    {
      title: "Assistant setup",
      copy: setup.isReady
        ? "The assistant has the core details it needs."
        : "The assistant still needs a few setup details before launch.",
      done: setup.isReady,
    },
    {
      title: "Website install",
      copy: installStatus.state === "live"
        ? "Vonza has already been detected on the live site."
        : "The next milestone is getting Vonza onto the live website.",
      done: installStatus.state === "live",
    },
  ];

  const cards = [];

  if (installStatus.state === "live" && messageCount === 0) {
    cards.push({
      title: "Now help visitors notice it",
      copy: "Make the launcher text and welcome message stronger, then test a few common customer questions to make sure the first interaction feels clear and helpful.",
    });
  }

  if (installStatus.state === "live" && messageCount > 0) {
    const topIntentLabelMap = {
      general: "general business questions",
      services: "services and what the business offers",
      pricing: "pricing and purchase intent",
      contact: "direct contact or lead intent",
      booking: "booking and availability",
      support: "support or complaint-style requests",
    };

    cards.push({
      title: "Customers are already using it",
      copy: topIntent?.[1]
        ? `Recent activity suggests customers are asking most often about ${topIntentLabelMap[topIntent[0]]}.`
        : "Recent activity shows customers are starting to use the assistant on your site.",
    });

    if (recentQuestions.length) {
      cards.push({
        title: "Recent questions",
        copy: recentQuestions.join(" • "),
      });
    }
  }

  if (!cards.length) {
    cards.push({
      title: "Next best move",
      copy: installStatus.state === "live"
        ? "Keep testing the assistant on your site and review the wording, welcome message, and response style until it feels like a natural part of the business."
        : "Once the assistant is installed on a live site, Vonza will start showing real usage and recent customer questions here.",
    });
  }

  return {
    installStatus,
    messageCount,
    lastActivity,
    activity,
    signals,
    queueSummary,
    peopleSummary,
    cards,
    primaryAction,
    nextActions: nextActions.slice(0, 2),
    progressItems,
    title,
    copy,
  };
}

function buildOverviewSection(agent, messages, setup, actionQueue = createEmptyActionQueue()) {
  const overview = buildOverviewState(agent, messages, setup, actionQueue);
  const attentionItems = (actionQueue.items || [])
    .filter((item) => getActionQueueOwnerWorkflow(item).attention)
    .slice(0, 3);
  const topQuestionMarkup = overview.signals.topQuestions.length
    ? overview.signals.topQuestions.map((item) => `
      <div class="overview-list-item">
        <p class="overview-list-title">${escapeHtml(item.label)}${item.count > 1 ? ` (${item.count})` : ""}</p>
        <p class="overview-list-copy">${escapeHtml(`${getIntentLabel(item.intent)} signal from real visitor questions.`)}</p>
      </div>
    `).join("")
    : `<div class="placeholder-card">No real customer question themes yet. Once the assistant is live and visitors start using it, Vonza will group the strongest recurring questions here.</div>`;
  const highIntentSignals = overview.signals.highValueIntentCount;
  const recentUsageValue = overview.signals.usageTrend.recentCount > 0
    ? `${overview.signals.usageTrend.recentCount} recent`
    : overview.signals.userMessageCount > 0
      ? `${overview.signals.userMessageCount} captured`
      : "No usage yet";
  const recommendationTitle = !setup.knowledgeReady
    ? "Strengthen website knowledge"
    : overview.installStatus.state !== "live"
      ? "Finish live install"
      : overview.queueSummary.attentionNeeded > 0
        ? "Review action queue"
      : overview.queueSummary.total > 0
          ? "Close the loop on follow-up"
      : overview.signals.weakAnswerCount > 0
        ? "Review weak answers"
        : highIntentSignals > 0
          ? "Review buyer intent"
          : "Keep learning from live usage";
  const recommendationCopy = !setup.knowledgeReady
    ? "Run another website import so the assistant can answer with stronger business context."
    : overview.installStatus.state !== "live"
      ? "Place Vonza on the live site so it can start detecting real visitor behavior and customer intent."
      : overview.queueSummary.attentionNeeded > 0
        ? "Important high-intent or weak-answer items are in the Action Queue. Review them first so the owner knows which visitors or answer paths still need attention."
        : overview.queueSummary.total > 0
          ? "The Action Queue already holds important conversation follow-up. Keep moving items through review so the assistant becomes more operational, not just informative."
      : overview.signals.weakAnswerCount > 0
        ? "Several live questions ended in weak or uncertain answers. Use Analytics to review those conversations, then refine website knowledge or assistant setup."
        : highIntentSignals > 0
          ? "High-intent questions are already coming in. Review Analytics to see whether visitors want pricing, booking, contact, or support help most."
          : "Keep an eye on the first real visitor questions so you can tighten the welcome, website copy, or install placement if needed.";
  const weakAnswerMarkup = overview.signals.weakAnswerExamples.length
    ? overview.signals.weakAnswerExamples.map((question) => `
      <div class="overview-list-item">
        <p class="overview-list-title">${escapeHtml(question)}</p>
        <p class="overview-list-copy">This question ended in a weak or uncertain answer and is a good candidate for improvement.</p>
      </div>
    `).join("")
    : `<div class="placeholder-card">No weak-answer signal yet. Once customers ask questions that Vonza struggles to answer, they will show up here instead of being hidden behind a fake success state.</div>`;
  const attentionMarkup = attentionItems.length
    ? attentionItems.map((item) => {
      const workflow = getActionQueueOwnerWorkflow(item);
      const nextLine = trimText(item.nextStep)
        ? `Next step: ${trimText(item.nextStep)}`
        : workflow.copy;
      const recencyLine = item.lastSeenAt ? `Flagged ${formatSeenAt(item.lastSeenAt)}` : "Recent signal";

      return `
        <div class="overview-list-item">
          <p class="overview-list-title">${escapeHtml(item.label || getActionQueueTypeLabel(item.type))} · ${escapeHtml(workflow.label)}</p>
          <p class="overview-list-copy">${escapeHtml(item.snippet || item.whyFlagged || "Flagged from recent conversation activity.")}</p>
          <p class="overview-list-copy">${escapeHtml(recencyLine)}</p>
          <p class="overview-list-copy">${escapeHtml(nextLine)}</p>
        </div>
      `;
    }).join("")
    : `<div class="placeholder-card">No queue items need owner attention right now. Resolved items and dismissed items stay out of the way here.</div>`;

  const renderAction = (action, options = {}) => {
    const buttonClass = options.primary ? "primary-button" : "ghost-button";

    if (action.type === "section") {
      return `<button class="${buttonClass}" type="button" data-overview-target="${action.value}">${action.label}</button>`;
    }

    if (action.type === "focus") {
      return `<button class="${buttonClass}" type="button" data-overview-focus="${action.value}">${action.label}</button>`;
    }

    if (action.type === "import") {
      return `<button class="${buttonClass}" type="button" data-action="import-knowledge">${action.label}</button>`;
    }

    if (action.type === "install") {
      return `<button class="${options.primary ? "primary-button" : "ghost-button"}" type="button" data-action="copy-install" ${trimText(agent.publicAgentKey) ? "" : "disabled"}>${action.label}</button>`;
    }

    if (action.type === "preview") {
      return `<a class="${options.primary ? "primary-button" : "test-link"}" data-action="open-preview" href="${buildWidgetUrl(agent.publicAgentKey)}" target="_blank" rel="noreferrer">${action.label}</a>`;
    }

    return "";
  };

  return `
    <section class="overview-shell">
      <section class="overview-hero">
        <span class="eyebrow">${overview.installStatus.state === "live" ? "Live performance" : "Assistant overview"}</span>
        <h2 class="overview-title">${escapeHtml(overview.title)}</h2>
        <p class="overview-copy">${escapeHtml(overview.copy)}</p>
        <div class="overview-metric-grid">
          <div class="overview-metric">
            <div class="overview-metric-label">Install status</div>
            <div class="overview-metric-value">${escapeHtml(overview.installStatus.state === "live" ? overview.installStatus.host || "Live" : overview.installStatus.state === "test" ? "Preview only" : "Not live")}</div>
          </div>
          <div class="overview-metric">
            <div class="overview-metric-label">Visitor questions</div>
            <div class="overview-metric-value">${escapeHtml(recentUsageValue)}</div>
          </div>
          <div class="overview-metric">
            <div class="overview-metric-label">Follow-up needed</div>
            <div class="overview-metric-value">${overview.queueSummary.followUpNeeded || 0}</div>
          </div>
          <div class="overview-metric">
            <div class="overview-metric-label">Attention now</div>
            <div class="overview-metric-value">${overview.queueSummary.attentionNeeded || 0}</div>
          </div>
          <div class="overview-metric">
            <div class="overview-metric-label">Resolved items</div>
            <div class="overview-metric-value">${overview.queueSummary.resolved || 0}</div>
          </div>
          <div class="overview-metric">
            <div class="overview-metric-label">Returning people</div>
            <div class="overview-metric-value">${overview.peopleSummary.returning || 0}</div>
          </div>
        </div>
        <div class="overview-action-row">
          ${overview.primaryAction ? renderAction(overview.primaryAction, { primary: true }) : ""}
          ${overview.nextActions.map((action) => renderAction(action)).join("")}
        </div>
        <div class="overview-progress-row">
          ${overview.progressItems.map((item) => `
            <div class="progress-card ${item.done ? "done" : ""}">
              <p class="progress-label">${escapeHtml(item.title)}</p>
              <p class="progress-copy">${escapeHtml(item.copy)}</p>
            </div>
          `).join("")}
        </div>
      </section>

      <div class="overview-grid">
        ${buildActionQueueMarkup(agent, actionQueue)}

        <section class="overview-card">
          <h3 class="overview-card-title">Top customer question themes</h3>
          <p class="overview-card-copy">${escapeHtml(
            overview.signals.topQuestions.length
              ? "These are the strongest recurring questions or themes showing up in real visitor usage."
              : "Vonza will show grouped customer question themes here as soon as real usage comes in."
          )}</p>
          <div class="overview-list">
            ${topQuestionMarkup}
          </div>
        </section>

        <section class="overview-card">
          <h3 class="overview-card-title">Owner attention now</h3>
          <p class="overview-card-copy">These are the flagged conversations that still need an owner decision, follow-up, or final resolution.</p>
          <div class="overview-list">
            ${attentionMarkup}
          </div>
        </section>

        <section class="overview-card">
          <h3 class="overview-card-title">Intent signals</h3>
          <p class="overview-card-copy">A fast read on the kinds of conversations visitors are trying to have with the business.</p>
          <div class="overview-list">
            ${["contact", "booking", "pricing", "support"].map((intent) => `
              <div class="overview-list-item">
                <p class="overview-list-title">${escapeHtml(`${getIntentLabel(intent)}: ${overview.signals.intentCounts[intent] || 0}`)}</p>
                <p class="overview-list-copy">${escapeHtml(getIntentDescription(intent))}</p>
              </div>
            `).join("")}
          </div>
        </section>

        <section class="overview-card">
          <h3 class="overview-card-title">What to do next</h3>
          <p class="overview-card-copy">${escapeHtml(recommendationCopy)}</p>
          <div class="overview-list">
            <div class="overview-list-item">
              <p class="overview-list-title">${escapeHtml(recommendationTitle)}</p>
              <p class="overview-list-copy">${escapeHtml(recommendationCopy)}</p>
            </div>
            ${weakAnswerMarkup}
          </div>
        </section>
      </div>
    </section>
  `;
}

function buildAnalyticsPanel(agent, messages, setup, actionQueue = createEmptyActionQueue()) {
  const signals = analyzeConversationSignals(messages);
  const { intentCounts } = signals;
  const activity = getActivityLevel(agent.messageCount || messages.length || 0, agent.lastMessageAt);
  const recentInteractions = messages.slice(0, 12);
  const peopleSummary = {
    ...createEmptyActionQueue().peopleSummary,
    ...(actionQueue.peopleSummary || {}),
  };
  const installStatus = agent.installStatus || {
    state: "not_detected",
    label: "Not detected on a live site yet",
    host: "",
    lastSeenAt: null,
  };
  const opportunityItems = [];

  if (setup.knowledgeLimited || setup.knowledgeMissing) {
    opportunityItems.push({
      title: "Strengthen website knowledge",
      copy: setup.knowledgeLimited
        ? "Your assistant has some website knowledge, but another import could help it answer with more confidence."
        : "Your assistant still needs website knowledge before it can answer customer questions in a grounded way.",
      subtle: "Run website import again after your site is updated or fully live.",
    });
  }

  if (installStatus.state !== "live") {
    opportunityItems.push({
      title: "No live install detected yet",
      copy: installStatus.state === "test"
        ? "The assistant has been seen in preview or test environments, but not yet on a live external site."
        : "Vonza has not yet detected the assistant on a live site.",
      subtle: "Once the widget is loaded from a real external host, this status will update automatically.",
    });
  }

  if (intentCounts.pricing >= 2) {
    opportunityItems.push({
      title: "Customers ask about pricing",
      copy: "Pricing questions are coming up more than once, which usually means visitors want clearer guidance before reaching out.",
      subtle: "Consider adding pricing context or quote guidance to your website copy.",
    });
  }

  if (intentCounts.contact >= 2) {
    opportunityItems.push({
      title: "Customers want a next step",
      copy: "Contact-focused questions are appearing repeatedly, which suggests visitors are ready to move forward.",
      subtle: "Make your contact route easier to find on the site and in the assistant responses.",
    });
  }

  if (signals.weakAnswerCount > 0) {
    opportunityItems.unshift({
      title: "Weak answers need review",
      copy: `${signals.weakAnswerCount} customer question${signals.weakAnswerCount === 1 ? "" : "s"} ended in a weak or uncertain answer.`,
      subtle: "Review the weak-answer list below, then improve website knowledge or adjust the assistant setup.",
    });
  }

  if (peopleSummary.returning > 0) {
    opportunityItems.unshift({
      title: "Repeat visitors are showing up",
      copy: `${peopleSummary.returning} stitched visitor thread${peopleSummary.returning === 1 ? "" : "s"} already show returning behavior.`,
      subtle: "Use the People view to see whether the same lead came back or the same support issue kept evolving.",
    });
  }

  if (!opportunityItems.length) {
    opportunityItems.push({
      title: "Your assistant is in a healthy early state",
      copy: "There are no strong warning signals in the current data yet, which is a good baseline as more real usage comes in.",
      subtle: "More insights will appear as customers ask more questions.",
    });
  }

  return `
    <section class="workspace-panel" data-shell-section="analytics" hidden>
      <div class="workspace-panel-header">
        <h2 class="workspace-panel-title">Analytics</h2>
        <p class="workspace-panel-copy">See what customers are asking, where the assistant is active, and where a small improvement could make the experience stronger.</p>
      </div>
      <div class="analytics-stack">
        <div class="metric-grid">
          <div class="metric-card">
            <div class="metric-label">Total messages</div>
            <div class="metric-value">${agent.messageCount || messages.length || 0}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Visitor questions</div>
            <div class="metric-value">${signals.usageTrend.recentCount || signals.userMessageCount || 0}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">High-intent signals</div>
            <div class="metric-value">${signals.highValueIntentCount}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Answers needing work</div>
            <div class="metric-value">${signals.weakAnswerCount || 0}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Returning people</div>
            <div class="metric-value">${peopleSummary.returning || 0}</div>
          </div>
        </div>

        <div class="analytics-grid">
          <section class="workspace-card-soft">
            <h3 class="studio-group-title">Overview</h3>
            <p class="studio-group-copy">A quick read on what the product really knows right now.</p>
            <div class="analytics-list">
              <div class="analytics-item">
                <p class="analytics-item-title">Assistant visibility</p>
                <p class="analytics-item-copy">${escapeHtml(installStatus.label)}</p>
                <p class="analytics-subtle">${escapeHtml(installStatus.lastSeenAt ? `Last seen ${formatSeenAt(installStatus.lastSeenAt)}.` : "Live detection updates when the widget is seen on a real site or test environment.")}</p>
              </div>
              <div class="analytics-item">
                <p class="analytics-item-title">Recent activity</p>
                <p class="analytics-item-copy">${escapeHtml(activity.description)}</p>
                <p class="analytics-subtle">${escapeHtml(signals.usageTrend.copy)}</p>
              </div>
              <div class="analytics-item">
                <p class="analytics-item-title">Knowledge state</p>
                <p class="analytics-item-copy">${escapeHtml(setup.knowledgeDescription)}</p>
                <p class="analytics-subtle">${escapeHtml(setup.knowledgePageCount ? `${setup.knowledgePageCount} imported page${setup.knowledgePageCount === 1 ? "" : "s"} currently support the assistant.` : "Website knowledge is still being built from your site.")}</p>
              </div>
              <div class="analytics-item">
                <p class="analytics-item-title">Operator signal</p>
                <p class="analytics-item-copy">${escapeHtml(signals.highValueIntentCount > 0 ? `${signals.highValueIntentCount} high-intent customer signal${signals.highValueIntentCount === 1 ? "" : "s"} have already appeared.` : "There is not a strong lead, booking, pricing, or support signal yet.")}</p>
                <p class="analytics-subtle">${escapeHtml(signals.weakAnswerCount > 0 ? `${signals.weakAnswerCount} question${signals.weakAnswerCount === 1 ? "" : "s"} may need a better answer path.` : "No weak-answer signal has been detected yet.")}</p>
              </div>
            </div>
          </section>

          <section class="workspace-card-soft">
            <h3 class="studio-group-title">Customer intent</h3>
            <p class="studio-group-copy">These counts show the kinds of commercial or support intent Vonza is seeing in real visitor questions.</p>
            <div class="intent-grid">
              ${["contact", "booking", "pricing", "support"].map((intent) => `
                <div class="intent-card">
                  <p class="intent-label">${escapeHtml(getIntentLabel(intent))}</p>
                  <p class="intent-value">${signals.intentCounts[intent] || 0}</p>
                  <p class="intent-copy">${escapeHtml(getIntentDescription(intent))}</p>
                </div>
              `).join("")}
            </div>
          </section>
        </div>

        <section class="workspace-card-soft">
          <h3 class="studio-group-title">Top customer questions</h3>
          <p class="studio-group-copy">These are the strongest recurring question themes from real visitor usage. Similar wording is grouped lightly so you can see what customers care about most.</p>
          ${signals.topQuestions.length ? `
            <div class="question-list">
              ${signals.topQuestions.map((item) => `
                <div class="question-row">${escapeHtml(item.label)}${item.count > 1 ? ` (${item.count})` : ""} · ${escapeHtml(getIntentLabel(item.intent))}</div>
              `).join("")}
            </div>
          ` : `<div class="placeholder-card">No strong question themes yet. As soon as visitors start asking recurring questions, Vonza will group them here so the owner can see what the assistant is really handling.</div>`}
        </section>

        <section class="workspace-card-soft">
          <h3 class="studio-group-title">Answers needing work</h3>
          <p class="studio-group-copy">These are the clearest places where Vonza may have responded with weak, uncertain, or missing answers.</p>
          ${signals.weakAnswerExamples.length ? `
            <div class="question-list">
              ${signals.weakAnswerExamples.map((question) => `
                <div class="question-row">${escapeHtml(question)}</div>
              `).join("")}
            </div>
          ` : `<div class="placeholder-card">No weak-answer signal yet. If visitors ask questions that Vonza cannot answer well, they will appear here so the owner knows what to improve next.</div>`}
        </section>

        ${buildActionQueueMarkup(agent, actionQueue, { compact: true, allowStatusUpdates: false })}

        ${buildPeopleMarkup(actionQueue)}

        <section class="workspace-card-soft">
          <h3 class="studio-group-title">What needs attention</h3>
          <p class="studio-group-copy">Practical opportunities surfaced from current usage, install state, and assistant behavior.</p>
          <div class="analytics-list">
            ${opportunityItems.slice(0, 4).map((item) => `
              <div class="analytics-item">
                <p class="analytics-item-title">${escapeHtml(item.title)}</p>
                <p class="analytics-item-copy">${escapeHtml(item.copy)}</p>
                <p class="analytics-subtle">${escapeHtml(item.subtle)}</p>
              </div>
            `).join("")}
          </div>
        </section>

        <section class="workspace-card-soft">
          <h3 class="studio-group-title">Recent conversations</h3>
          <p class="studio-group-copy">A readable view of the most recent interactions stored for this assistant.</p>
          ${recentInteractions.length ? `
            <div class="messages-list">
              ${recentInteractions.map((message) => `
                <div class="message-row ${escapeHtml(message.role || "")}" data-conversation-message="${escapeHtml(message.id || "")}">
                  <div class="message-role">${escapeHtml(message.role === "user" ? "Customer" : "Assistant")}</div>
                  <div class="message-content">${escapeHtml(message.content)}</div>
                </div>
              `).join("")}
            </div>
          ` : `<div class="placeholder-card">Recent interactions will appear here once customers start using the assistant.</div>`}
          ${recentInteractions.length ? `<p class="analytics-subtle">This section shows recent stored messages, not full reconstructed chat threads.</p>` : ""}
        </section>
      </div>
    </section>
  `;
}

function buildCalendarPanel() {
  return `
    <section class="workspace-panel" data-shell-section="calendar" hidden>
      <div class="workspace-panel-header">
        <h2 class="workspace-panel-title">Calendar</h2>
        <p class="workspace-panel-copy">Calendar and booking automation are not part of the product yet, but this is where they can live later.</p>
      </div>
      <div class="placeholder-card">
        Calendar and booking automation coming later. For now, Vonza focuses on website-based AI assistant setup, appearance, behavior, preview, and installation.
      </div>
    </section>
  `;
}

function renderAssistantShell(agent, messages, setup, actionQueue = createEmptyActionQueue()) {
  renderTopbarMeta();
  const activeSection = getActiveShellSection(setup);
  const shellStatus = setup.isReady ? "Setup complete" : "Setup in progress";
  const primaryAction = setup.isReady
    ? `<button class="primary-button" data-action="copy-install" ${trimText(agent.publicAgentKey) ? "" : "disabled"}>Add to website</button>`
    : `<button class="primary-button" type="button" data-shell-target="customize">Continue setup</button>`;
  const secondaryAction = trimText(agent.publicAgentKey)
    ? `<a class="test-link" data-action="open-preview" href="${buildWidgetUrl(agent.publicAgentKey)}" target="_blank" rel="noreferrer">Try assistant</a>`
    : "";

  rootEl.innerHTML = `
    <div class="workspace-shell">
      <section class="workspace-header">
        <div class="workspace-header-top">
          <div>
            <span class="eyebrow">${setup.isReady ? "Workspace" : "Post-purchase setup"}</span>
            <h1 class="workspace-title">${escapeHtml(agent.assistantName || agent.name)}</h1>
            <p class="workspace-subtitle">${escapeHtml(agent.websiteUrl || "No website connected yet")}</p>
            <div class="workspace-badge-row">
              <span class="${getBadgeClass(shellStatus)}">${shellStatus}</span>
              <span class="${getBadgeClass(setup.knowledgeReady ? "Ready" : setup.knowledgeLimited ? "Limited" : "Not imported")}">${setup.knowledgeReady ? "Knowledge ready" : setup.knowledgeLimited ? "Knowledge limited" : "Knowledge not imported"}</span>
              <span class="${getBadgeClass(agent.installStatus?.state === "live" ? "Ready" : agent.installStatus?.state === "test" ? "Limited" : "Not imported")}">${escapeHtml(agent.installStatus?.label || "Not detected on a live site yet")}</span>
            </div>
          </div>
          <div class="workspace-actions">
            ${secondaryAction}
            ${primaryAction}
            ${!setup.knowledgeReady ? `<button class="ghost-button" data-action="import-knowledge">Retry website import</button>` : ""}
          </div>
        </div>
        ${buildWorkspaceTabs(activeSection, setup)}
      </section>

      ${!setup.isReady ? `
        <div class="shell-status-banner">
          Your assistant is unlocked and this is now your setup workspace. Finish the key details in Customize, then use Overview to preview and add Vonza to the website.
        </div>
      ` : ""}

      ${buildOverviewPanel(agent, messages, setup, actionQueue)}
      ${buildCustomizePanel(agent, setup)}
      ${buildAnalyticsPanel(agent, messages, setup, actionQueue)}
    </div>
  `;

  bindSharedDashboardEvents(agent, messages, setup, actionQueue);
}

function renderSetupState(agent, messages, setup, actionQueue) {
  renderAssistantShell(agent, messages, setup, actionQueue);
}

function renderReadyState(agent, messages, actionQueue) {
  renderAssistantShell(agent, messages, inferSetup(agent), actionQueue);
}

function buildPreviewSection(agent, setup) {
  const statusPills = [
    `<span class="preview-status-pill">Website connected</span>`,
    setup.knowledgeState === "ready"
      ? `<span class="preview-status-pill">Knowledge imported</span>`
      : setup.knowledgeState === "limited"
        ? `<span class="preview-status-pill">Knowledge limited</span>`
        : `<span class="preview-status-pill">Knowledge not imported</span>`,
    setup.knowledgePageCount
      ? `<span class="preview-status-pill">${escapeHtml(`${setup.knowledgePageCount} page${setup.knowledgePageCount === 1 ? "" : "s"} imported`)}</span>`
      : "",
  ].join("");

  const warning = setup.knowledgeState !== "ready"
    ? `<p class="preview-warning">Your assistant can already be tested here, but the website knowledge is still ${setup.knowledgeState === "limited" ? "limited" : "incomplete"}. Run another import if you want a stronger launch-ready result.</p>`
    : "";

  return `
    <div class="preview-header">
      <h2 class="section-heading">Try your assistant</h2>
      <p class="section-copy">See how your assistant answers real customer questions.</p>
      <div class="preview-status-row">
        ${statusPills}
        <span class="preview-status-pill">${escapeHtml(agent.websiteUrl || "No website URL")}</span>
      </div>
      ${warning}
      <div class="prompt-chip-row">
        <button class="prompt-chip" type="button" data-preview-prompt="What services do you offer?">What services do you offer?</button>
        <button class="prompt-chip" type="button" data-preview-prompt="How much does it cost?">How much does it cost?</button>
        <button class="prompt-chip" type="button" data-preview-prompt="How can I contact you?">How can I contact you?</button>
        <button class="prompt-chip" type="button" data-preview-prompt="What makes this business different?">What makes this business different?</button>
      </div>
    </div>
    <div class="preview-control-row">
      <a class="test-link" data-action="open-preview" href="${buildWidgetUrl(agent.publicAgentKey)}" target="_blank" rel="noreferrer">Open full preview</a>
      <button class="ghost-button" type="button" data-action="reset-preview">Reset conversation</button>
      ${setup.knowledgeState !== "ready" ? `<button class="ghost-button" type="button" data-action="import-knowledge">Retry import</button>` : ""}
    </div>
    <iframe
      id="preview-frame"
      class="preview-frame"
      title="Widget preview"
      src="${buildWidgetUrl(agent.publicAgentKey)}"
    ></iframe>
  `;
}

function buildInstallSection(agent, options = {}) {
  const { upcoming = false } = options;
  const hasInstall = Boolean(trimText(agent.publicAgentKey));
  const progress = getInstallProgress(agent.id);
  const script = hasInstall ? buildScript(agent.publicAgentKey) : "";
  const installStatus = agent.installStatus || {
    state: "not_detected",
    label: "Not detected on a live site yet",
    host: "",
    lastSeenAt: null,
  };
  const statusCopy = installStatus.state === "live"
    ? `Live install detected on ${installStatus.host}${installStatus.lastSeenAt ? `, last seen ${formatSeenAt(installStatus.lastSeenAt)}` : ""}.`
    : installStatus.state === "test"
      ? `Seen on a test or preview site${installStatus.host ? ` (${installStatus.host})` : ""}${installStatus.lastSeenAt ? `, last seen ${formatSeenAt(installStatus.lastSeenAt)}` : ""}.`
      : "Not detected on a live site yet. Once the real widget is seen on an external host, this status will update automatically.";

  return `
    ${upcoming ? `<p class="install-upcoming">This becomes the final step once your assistant feels ready to go live.</p>` : ""}
    <p class="section-copy">${escapeHtml(installStatus.label)}</p>
    <p class="install-help">${escapeHtml(statusCopy)}</p>
    <div class="install-steps">
      <div class="install-step">
        <div class="install-step-number">1</div>
        <div>
          <p class="install-step-title">Copy code</p>
          <p class="install-step-copy">Use one clean embed snippet to place your assistant on your website.</p>
        </div>
        <div class="step-check ${progress.codeCopied ? "done" : ""}">${progress.codeCopied ? "Done" : "Pending"}</div>
      </div>
      <div class="install-step">
        <div class="install-step-number">2</div>
        <div>
          <p class="install-step-title">Add it to your site</p>
          <p class="install-step-copy">Paste it before </body>, or add it in your footer or custom code settings.</p>
        </div>
        <div class="step-check ${progress.installed ? "done" : ""}">${progress.installed ? "Confirmed" : "Pending"}</div>
      </div>
      <div class="install-step">
        <div class="install-step-number">3</div>
        <div>
          <p class="install-step-title">Test your assistant</p>
          <p class="install-step-copy">Open a live preview and make sure the experience feels right before you publish.</p>
        </div>
        <div class="step-check ${progress.previewOpened ? "done" : ""}">${progress.previewOpened ? "Done" : "Pending"}</div>
      </div>
    </div>
    <div class="install-cta-row">
      <button class="primary-button" data-action="copy-install" ${hasInstall ? "" : "disabled"}>Copy install code</button>
      <button class="ghost-button" data-action="copy-install-instructions" ${hasInstall ? "" : "disabled"}>Copy instructions</button>
      <a class="test-link ${hasInstall ? "" : "disabled"}" data-action="open-preview" href="${hasInstall ? buildWidgetUrl(agent.publicAgentKey) : "#"}" target="_blank" rel="noreferrer">Test assistant</a>
      <button class="ghost-button" data-action="mark-installed" ${hasInstall ? "" : "disabled"}>${progress.installed ? "Added to site (you confirmed)" : "Confirm added to site"}</button>
    </div>
    <p class="install-help">${hasInstall ? "Keep it simple: paste the code before </body>, or place it in your site footer or custom code area. Your confirmation is optional and separate from live detection." : "Install will be available as soon as your assistant has a live embed key."}</p>
    <details class="code-toggle">
      <summary>View code</summary>
      <textarea id="install-script-output" readonly>${script}</textarea>
    </details>
  `;
}

function buildCustomizationForm(agent, compact) {
  return `
    <form id="assistant-settings-form" class="spacer">
      <div class="studio-layout">
        <div class="studio-groups">
          <section class="studio-group">
            <h3 class="studio-group-title">Identity</h3>
            <p class="studio-group-copy">Shape the name and voice your customers will recognize.</p>
            <div class="form-grid two-col">
              <div class="field">
                <label for="assistant-name">Assistant name</label>
                <input id="assistant-name" name="assistant_name" type="text" value="${escapeHtml(agent.assistantName || agent.name)}">
                <p class="field-help">This is the name customers will see in the assistant.</p>
              </div>
              <div class="field">
                <label for="assistant-tone">Brand voice</label>
                <select id="assistant-tone" name="tone">
                  <option value="friendly" ${agent.tone === "friendly" ? "selected" : ""}>friendly</option>
                  <option value="professional" ${agent.tone === "professional" ? "selected" : ""}>professional</option>
                  <option value="sales" ${agent.tone === "sales" ? "selected" : ""}>sales</option>
                  <option value="support" ${agent.tone === "support" ? "selected" : ""}>support</option>
                </select>
                <p class="field-help">Choose the tone that feels most natural for your business.</p>
              </div>
            </div>
          </section>

          <section class="studio-group">
            <h3 class="studio-group-title">First impression</h3>
            <p class="studio-group-copy">Define the first thing people read and the action they take.</p>
            <div class="form-grid two-col">
              <div class="field">
                <label for="assistant-button-label">Button text</label>
                <input id="assistant-button-label" name="button_label" type="text" value="${escapeHtml(agent.buttonLabel || "")}">
                <p class="field-help">Keep this short, clear, and welcoming.</p>
              </div>
              <div class="field">
                <label for="assistant-website">Website</label>
                <input id="assistant-website" name="website_url" type="text" value="${escapeHtml(agent.websiteUrl || "")}">
                <p class="field-help">This is the website your assistant should represent.</p>
              </div>
            </div>
            <div class="form-grid">
              <div class="field">
                <label for="assistant-welcome">Welcome message</label>
                <textarea id="assistant-welcome" name="welcome_message">${escapeHtml(agent.welcomeMessage || "")}</textarea>
                <p class="field-help">Set the tone of the first customer interaction.</p>
              </div>
            </div>
          </section>

          <section class="studio-group">
            <h3 class="studio-group-title">Brand look</h3>
            <p class="studio-group-copy">Use your colors so the assistant feels like part of your brand.</p>
            <div class="form-grid two-col">
              <div class="field">
                <label for="assistant-primary-color">Primary color</label>
                <input id="assistant-primary-color" name="primary_color" type="color" value="${escapeHtml(agent.primaryColor || "#14b8a6")}">
              </div>
              <div class="field">
                <label for="assistant-secondary-color">Secondary color</label>
                <input id="assistant-secondary-color" name="secondary_color" type="color" value="${escapeHtml(agent.secondaryColor || "#0f766e")}">
              </div>
            </div>
          </section>

          <section class="studio-group secondary">
            <h3 class="studio-group-title">Advanced guidance</h3>
            <p class="studio-group-copy">Optional guidance for how the assistant should think and respond in edge cases.</p>
            <div class="form-grid">
              <div class="field">
                <label for="assistant-instructions">Advanced guidance</label>
                <textarea id="assistant-instructions" name="system_prompt">${escapeHtml(agent.systemPrompt || "")}</textarea>
                <p class="field-help">Use this only if you want to fine-tune behavior beyond the core brand settings.</p>
              </div>
            </div>
          </section>

          <div class="studio-save-row">
            <button class="primary-button" type="submit">Save changes</button>
            <span id="studio-save-state" class="save-state">No changes yet.</span>
          </div>
        </div>

        <aside class="studio-summary">
          <p class="studio-summary-label">Live summary</p>
          <h3 id="studio-summary-name" class="studio-summary-name">${escapeHtml(agent.assistantName || agent.name)}</h3>
          <p id="studio-summary-copy" class="studio-summary-copy">${escapeHtml(agent.welcomeMessage || "Your assistant is ready to greet visitors with a clear, helpful first message.")}</p>
          <div class="studio-summary-badge-row">
            <span id="studio-summary-tone" class="badge success">${escapeHtml(agent.tone || "friendly")}</span>
            <span id="studio-summary-button" class="pill">${escapeHtml(agent.buttonLabel || "Chat")}</span>
          </div>
          <div class="studio-swatch-row">
            <div id="studio-swatch-primary" class="studio-swatch" style="--swatch-color:${escapeHtml(agent.primaryColor || "#14b8a6")}">Primary</div>
            <div id="studio-swatch-secondary" class="studio-swatch" style="--swatch-color:${escapeHtml(agent.secondaryColor || "#0f766e")}">Secondary</div>
          </div>
        </aside>
      </div>
    </form>
  `;
}

// Data loading and persistence helpers
async function fetchJson(url, options) {
  const nextOptions = { ...(options || {}) };
  nextOptions.headers = options?.auth === false
    ? { ...(options?.headers || {}) }
    : getAuthHeaders(options?.headers || {});

  const response = await fetch(url, nextOptions);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }

  return data;
}

async function loadAgents() {
  const url = new URL("/agents/list", window.location.origin);
  url.searchParams.set("client_id", getClientId());
  const data = await fetchJson(url.toString());
  return {
    agents: data.agents || [],
    bridgeAgent: data.bridgeAgent || null,
  };
}

async function loadAgentMessages(agentId) {
  const url = new URL("/agents/messages", window.location.origin);
  url.searchParams.set("agent_id", agentId);
  url.searchParams.set("client_id", getClientId());
  const data = await fetchJson(url.toString());
  return data.messages || [];
}

async function loadActionQueue(agentId) {
  const url = new URL("/agents/action-queue", window.location.origin);
  url.searchParams.set("agent_id", agentId);
  url.searchParams.set("client_id", getClientId());

  try {
    const data = await fetchJson(url.toString());
    return {
      items: Array.isArray(data.items) ? data.items : [],
      people: Array.isArray(data.people) ? data.people : [],
      peopleSummary: {
        ...createEmptyActionQueue().peopleSummary,
        ...(data.peopleSummary || {}),
      },
      summary: {
        ...createEmptyActionQueue().summary,
        ...(data.summary || {}),
      },
      persistenceAvailable: data.persistenceAvailable !== false,
      migrationRequired: data.migrationRequired === true,
      followUpWorkflowAvailable: data.followUpWorkflowAvailable !== false,
      followUpWorkflowMigrationRequired: data.followUpWorkflowMigrationRequired === true,
    };
  } catch (error) {
    console.warn("[action queue] Could not load the action queue:", error.message);
    return createEmptyActionQueue();
  }
}

async function importKnowledge(agent, options = {}) {
  try {
    const importData = await fetchJson("/knowledge/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      auth: options.auth,
      body: JSON.stringify({
        agent_key: agent.publicAgentKey,
        client_id: options.clientId || getClientId(),
      })
    });

    const nextSetup = classifyImportResult(importData);
    trackProductEvent(
      nextSetup.knowledgeState === "ready" ? "knowledge_imported" : "knowledge_limited",
      {
        agentId: agent.id,
        metadata: {
          pageCount: Number(importData?.pageCount || 0),
          contentLength: trimText(importData?.content || "").length,
        },
      }
    );
    return {
      ...nextSetup,
      hadError: false,
    };
  } catch (error) {
    const fallbackSetup = {
      knowledgeState: "limited",
      label: "Limited",
      description: "Your assistant was created, but the website knowledge needs another pass before it feels fully grounded.",
    };

    trackProductEvent("knowledge_limited", {
      agentId: agent.id,
      metadata: {
        importError: error.message || "Import failed",
      },
    });

    return {
      ...fallbackSetup,
      hadError: true,
      errorMessage: error.message || "Import failed. The assistant may have limited knowledge.",
    };
  }
}

async function runKnowledgeImport(agent) {
  setStatus("Importing website knowledge...");
  const nextSetup = await importKnowledge(agent);

  try {
    setStatus(nextSetup.knowledgeState === "ready"
      ? "Website knowledge is ready."
      : "Website knowledge was imported with limited detail."
    );
    await boot();
  } catch (error) {
    setStatus(nextSetup.errorMessage || error.message || "Import failed. The assistant may have limited knowledge.");
    await boot();
  }
}

async function createAssistant(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const formData = new FormData(form);

  const websiteUrl = trimText(formData.get("website_url"));
  const assistantName = trimText(formData.get("assistant_name"));
  const tone = trimText(formData.get("tone"));
  const welcomeMessage = trimText(formData.get("welcome_message"));
  const primaryColor = trimText(formData.get("primary_color"));

  if (!websiteUrl) {
    setStatus("Add your website first.");
    return;
  }

  trackProductEvent("onboarding_started", {
    onceKey: "onboarding_started",
    metadata: { entry: "form_submit" },
  });

  submitButton.disabled = true;
  const launchState = {
    status: "running",
    stepIndex: 0,
    headline: "We’re preparing your assistant.",
    detail: "We’re setting up your assistant, connecting your website, and getting a preview ready for you.",
    note: "Website import can take a little longer if your site is larger or slower to respond.",
    websiteUrl,
  };

  saveLaunchState(launchState);
  renderLaunchSequence(launchState);
  setStatus("Creating your assistant...");

  try {
    const createData = await fetchJson("/agents/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_id: getClientId(),
        business_name: assistantName || websiteUrl,
        website_url: websiteUrl,
        assistant_name: assistantName || websiteUrl,
        tone,
        welcome_message: welcomeMessage,
        primary_color: primaryColor,
      })
    });

    saveLaunchState({
      ...getLaunchState(),
      stepIndex: 1,
      agentId: createData.agent_id,
      agentKey: createData.agent_key,
      detail: "Your assistant is created. Now we’re saving the website and brand details it should represent.",
    });
    trackProductEvent("assistant_created", {
      agentId: createData.agent_id,
      metadata: {
        websiteUrl,
      },
    });
    renderLaunchSequence(getLaunchState());

    window.localStorage.setItem("vonza_agent_key", createData.agent_key);

    saveLaunchState({
      ...getLaunchState(),
      stepIndex: 2,
      detail: "We’re now reading the most useful parts of your website so the assistant can answer with confidence.",
    });
    renderLaunchSequence(getLaunchState());

    const nextSetup = await importKnowledge({
      id: createData.agent_id,
      publicAgentKey: createData.agent_key,
    }, {
      auth: false,
      clientId: getClientId(),
    });

    saveLaunchState({
      ...getLaunchState(),
      stepIndex: 3,
      detail: nextSetup.knowledgeState === "ready"
        ? "Your website knowledge is in place. We’re preparing your preview now."
        : "Your assistant is created. The website knowledge needs another pass, and we’re preparing the next best setup view for you.",
      knowledgeState: nextSetup.knowledgeState,
    });
    renderLaunchSequence(getLaunchState());

    saveLaunchState({
      ...getLaunchState(),
      stepIndex: 4,
      detail: nextSetup.knowledgeState === "ready"
        ? "Everything is coming together. We’re opening the best next view for you now."
        : "Your assistant is ready for final setup. You’ll be able to retry website import from the next screen.",
      nextState: nextSetup.knowledgeState === "ready" ? "ready" : "setup",
    });
    renderLaunchSequence(getLaunchState());

    saveLaunchState({
      ...getLaunchState(),
      status: "success",
    });

    setStatus(nextSetup.knowledgeState === "ready"
      ? "Your assistant is ready to try."
      : nextSetup.errorMessage || "Your assistant is created. Website knowledge needs another pass."
    );

    const successAgent = {
      id: createData.agent_id,
      name: assistantName || websiteUrl,
      assistantName: assistantName || websiteUrl,
      publicAgentKey: createData.agent_key,
    };

    renderLaunchSuccess(successAgent, {
      accessStatus: createData.access_status,
      nextState: nextSetup.knowledgeState === "ready" ? "ready" : "setup",
    });
  } catch (error) {
    clearLaunchState();
    setStatus(error.message || "Failed to create your assistant.");
    renderOnboarding();
  } finally {
    submitButton.disabled = false;
  }
}

async function saveAssistant(event, agent) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const saveState = form.querySelector("[data-save-state]");
  const formData = new FormData(form);
  const nextWebsiteUrl = trimText(formData.get("website_url"));
  const websiteChanged = Boolean(nextWebsiteUrl && nextWebsiteUrl !== trimText(agent.websiteUrl));

  const getNextValue = (fieldName, fallbackValue = "") => {
    if (formData.has(fieldName)) {
      return formData.get(fieldName);
    }

    return fallbackValue;
  };
  const payload = {
    client_id: getClientId(),
    agent_id: agent.id,
    assistant_name: getNextValue("assistant_name", agent.assistantName || agent.name || ""),
    tone: getNextValue("tone", agent.tone || ""),
    system_prompt: getNextValue("system_prompt", agent.systemPrompt || ""),
    welcome_message: getNextValue("welcome_message", agent.welcomeMessage || ""),
    button_label: getNextValue("button_label", agent.buttonLabel || ""),
    website_url: getNextValue("website_url", agent.websiteUrl || ""),
    primary_color: getNextValue("primary_color", agent.primaryColor || ""),
    secondary_color: getNextValue("secondary_color", agent.secondaryColor || ""),
  };

  submitButton.disabled = true;
  if (saveState) {
    saveState.textContent = "Saving changes...";
    saveState.className = "save-state saving";
    saveState.removeAttribute("title");
  }
  setStatus("Saving your assistant...");

  try {
    const updateData = await fetchJson("/agents/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (websiteChanged) {
      await runKnowledgeImport({
        id: agent.id,
        publicAgentKey: updateData.agent?.publicAgentKey || agent.publicAgentKey,
      });
      return;
    }

    setStatus("Your assistant has been updated.");
    if (saveState) {
      saveState.textContent = "Changes saved.";
      saveState.className = "save-state saved";
      saveState.removeAttribute("title");
    }
    await boot();
  } catch (error) {
    const message = error.message || "We couldn't save those changes just yet.";
    console.error("[dashboard customize] Failed to save assistant settings:", {
      agentId: agent.id,
      payload,
      message,
    });
    setStatus(message);
    if (saveState) {
      saveState.textContent = "Could not save changes.";
      saveState.className = "save-state unsaved";
      saveState.title = message;
    }
  } finally {
    submitButton.disabled = false;
  }
}

async function copyInstallCode(agent) {
  const script = buildScript(agent.publicAgentKey);

  try {
    await navigator.clipboard.writeText(script);
    saveInstallProgress(agent.id, { codeCopied: true });
    trackProductEvent("install_code_copied", { agentId: agent.id });
    setStatus("Install code copied. You can paste it into your website when you are ready.");
  } catch (_error) {
    const textarea = document.getElementById("install-script-output");
    if (textarea) {
      textarea.select();
      document.execCommand("copy");
    }
    saveInstallProgress(agent.id, { codeCopied: true });
    trackProductEvent("install_code_copied", { agentId: agent.id });
    setStatus("Install code copied. You can paste it into your website when you are ready.");
  }

  await boot();
}

async function copyInstallInstructions(agent) {
  const installBlock = [
    "Paste this into your website's footer or custom code area.",
    "If you can edit the site code directly, place it before </body>.",
    "",
    buildScript(agent.publicAgentKey),
  ].join("\n");

  try {
    await navigator.clipboard.writeText(installBlock);
    saveInstallProgress(agent.id, { codeCopied: true });
    trackProductEvent("install_instructions_copied", { agentId: agent.id });
    setStatus("Instructions copied with the install code.");
  } catch (_error) {
    const textarea = document.getElementById("install-script-output");
    if (textarea) {
      textarea.value = installBlock;
      textarea.select();
      document.execCommand("copy");
      textarea.value = buildScript(agent.publicAgentKey);
    }
    saveInstallProgress(agent.id, { codeCopied: true });
    trackProductEvent("install_instructions_copied", { agentId: agent.id });
    setStatus("Instructions copied with the install code.");
  }

  await boot();
}

function getPreviewFrame() {
  return document.getElementById("preview-frame");
}

function resetPreview(agent) {
  const previewFrame = getPreviewFrame();

  if (!previewFrame) {
    return;
  }

  previewFrame.src = buildWidgetUrl(agent.publicAgentKey);
  setStatus("Preview reset.");
}

async function sendPromptToPreview(agent, prompt) {
  if (!trimText(prompt)) {
    return;
  }

  const previewFrame = getPreviewFrame();

  if (!previewFrame) {
    setStatus("Preview is not available yet.");
    return;
  }

  const trySend = () => {
    try {
      const frameWindow = previewFrame.contentWindow;
      const frameDocument = previewFrame.contentDocument || frameWindow?.document;
      const input = frameDocument?.getElementById("input");

      if (!input || typeof frameWindow?.sendMessage !== "function") {
        return false;
      }

      input.value = prompt;
      frameWindow.sendMessage();
      setStatus(`Testing: ${prompt}`);
      saveInstallProgress(agent.id, { previewOpened: true });
      trackProductEvent("starter_prompt_used", {
        agentId: agent.id,
        metadata: { prompt },
      });
      trackProductEvent("preview_opened", {
        agentId: agent.id,
        onceKey: `preview_opened:${agent.id}`,
      });
      return true;
    } catch {
      return false;
    }
  };

  if (trySend()) {
    await boot();
    return;
  }

  const onLoad = async () => {
    previewFrame.removeEventListener("load", onLoad);
    trySend();
    await boot();
  };

  previewFrame.addEventListener("load", onLoad, { once: true });
  previewFrame.src = buildWidgetUrl(agent.publicAgentKey);
}

function updateStudioSummary(
  form = document.querySelector('form[data-form-kind="customize"]'),
  fallbackAgent = {}
) {
  const nameEl = document.getElementById("studio-summary-name");
  const copyEl = document.getElementById("studio-summary-copy");
  const toneEl = document.getElementById("studio-summary-tone");
  const buttonEl = document.getElementById("studio-summary-button");
  const primarySwatch = document.getElementById("studio-swatch-primary");
  const secondarySwatch = document.getElementById("studio-swatch-secondary");
  const brandWidgetTitle = document.getElementById("brand-widget-title");
  const brandWidgetMessage = document.getElementById("brand-widget-message");
  const brandLauncherLabel = document.getElementById("brand-launcher-label");
  const brandWidgetAvatar = document.getElementById("brand-widget-avatar");
  const brandLauncher = document.getElementById("brand-launcher");

  if (!form || !nameEl || !copyEl || !toneEl || !buttonEl || !primarySwatch || !secondarySwatch) {
    return;
  }

  const formData = new FormData(form);
  const getSummaryValue = (fieldName, fallbackValue = "") => {
    if (formData.has(fieldName)) {
      return trimText(formData.get(fieldName));
    }

    return trimText(fallbackValue);
  };
  const assistantName = getSummaryValue("assistant_name", fallbackAgent.assistantName || fallbackAgent.name) || "Your assistant";
  const welcomeMessage = getSummaryValue("welcome_message", fallbackAgent.welcomeMessage)
    || "Your assistant is ready to greet visitors with a clear, helpful first message.";
  const tone = getSummaryValue("tone", fallbackAgent.tone) || "friendly";
  const buttonLabel = getSummaryValue("button_label", fallbackAgent.buttonLabel) || "Chat";
  const primaryColor = getSummaryValue("primary_color", fallbackAgent.primaryColor) || "#14b8a6";
  const secondaryColor = getSummaryValue("secondary_color", fallbackAgent.secondaryColor) || "#0f766e";

  nameEl.textContent = assistantName;
  copyEl.textContent = welcomeMessage;
  toneEl.textContent = tone;
  buttonEl.textContent = buttonLabel;
  primarySwatch.style.setProperty("--swatch-color", primaryColor);
  secondarySwatch.style.setProperty("--swatch-color", secondaryColor);

  if (brandWidgetTitle) {
    brandWidgetTitle.textContent = assistantName;
  }

  if (brandWidgetMessage) {
    brandWidgetMessage.textContent = welcomeMessage;
  }

  if (brandLauncherLabel) {
    brandLauncherLabel.textContent = buttonLabel;
  }

  if (brandWidgetAvatar) {
    brandWidgetAvatar.style.setProperty("--brand-primary", primaryColor);
    brandWidgetAvatar.style.setProperty("--brand-secondary", secondaryColor);
  }

  if (brandLauncher) {
    brandLauncher.style.setProperty("--brand-primary", primaryColor);
    brandLauncher.style.setProperty("--brand-secondary", secondaryColor);
  }
}

function applyAppearancePreset(form, presetName) {
  if (!form) {
    return;
  }

  const assistantNameInput = form.querySelector('[name="assistant_name"]');
  const welcomeMessageInput = form.querySelector('[name="welcome_message"]');
  const buttonLabelInput = form.querySelector('[name="button_label"]');
  const primaryColorInput = form.querySelector('[name="primary_color"]');
  const secondaryColorInput = form.querySelector('[name="secondary_color"]');

  const presets = {
    clean: {
      buttonLabel: "Ask us",
      welcomeMessage: "Welcome. I’m here to answer questions clearly and help visitors find the right next step.",
      primaryColor: "#14b8a6",
      secondaryColor: "#0f766e",
    },
    bold: {
      buttonLabel: "Start here",
      welcomeMessage: "Welcome. Ask anything about our business and I’ll guide you quickly to the right service or next step.",
      primaryColor: "#7c3aed",
      secondaryColor: "#4c1d95",
    },
    minimal: {
      buttonLabel: "Chat",
      welcomeMessage: "Hi, I’m here to answer questions about our business and point you in the right direction.",
      primaryColor: "#334155",
      secondaryColor: "#0f172a",
    },
  };

  const preset = presets[presetName];

  if (!preset) {
    return;
  }

  if (assistantNameInput && !trimText(assistantNameInput.value)) {
    assistantNameInput.value = "Your assistant";
  }

  if (welcomeMessageInput) {
    welcomeMessageInput.value = preset.welcomeMessage;
  }

  if (buttonLabelInput) {
    buttonLabelInput.value = preset.buttonLabel;
  }

  if (primaryColorInput) {
    primaryColorInput.value = preset.primaryColor;
  }

  if (secondaryColorInput) {
    secondaryColorInput.value = preset.secondaryColor;
  }

  form.dispatchEvent(new Event("input", { bubbles: true }));
  form.dispatchEvent(new Event("change", { bubbles: true }));
}

function buildBehaviorSummary(tone, systemPrompt) {
  const normalizedTone = trimText(tone) || "friendly";
  const guidance = trimText(systemPrompt);

  const toneMap = {
    friendly: {
      title: "Warm and welcoming",
      copy: "Vonza will sound approachable and reassuring while still staying useful and clear.",
    },
    professional: {
      title: "Concise and professional",
      copy: "Vonza will speak in a polished, steady way that feels credible and business-ready.",
    },
    sales: {
      title: "Focused on moving visitors forward",
      copy: "Vonza will put more emphasis on services, value, and helping customers take the next step.",
    },
    support: {
      title: "Helpful and support-oriented",
      copy: "Vonza will prioritize clarity, reassurance, and practical answers to customer questions.",
    },
  };

  const base = toneMap[normalizedTone] || toneMap.friendly;

  if (!guidance) {
    return base;
  }

  return {
    title: base.title,
    copy: `${base.copy} Your advanced guidance will further shape what Vonza emphasizes and how direct it feels.`,
  };
}

function updateBehaviorSummary(form, fallbackAgent = {}) {
  const summaryTitle = document.getElementById("behavior-summary-title");
  const summaryCopy = document.getElementById("behavior-summary-copy");

  if (!form || !summaryTitle || !summaryCopy) {
    return;
  }

  const formData = new FormData(form);
  const tone = formData.has("tone") ? trimText(formData.get("tone")) : trimText(fallbackAgent.tone);
  const systemPrompt = formData.has("system_prompt")
    ? trimText(formData.get("system_prompt"))
    : trimText(fallbackAgent.systemPrompt);
  const summary = buildBehaviorSummary(tone, systemPrompt);

  summaryTitle.textContent = summary.title;
  summaryCopy.textContent = summary.copy;
}

function applyConfigurationPreset(form, presetName) {
  if (!form) {
    return;
  }

  const toneInputs = form.querySelectorAll('input[name="tone"]');
  const guidanceInput = form.querySelector('[name="system_prompt"]');

  const presets = {
    general: {
      tone: "professional",
      guidance: "Focus on explaining what the business does clearly, answer service questions directly, and guide visitors toward the best next step without sounding pushy.",
    },
    sales: {
      tone: "sales",
      guidance: "Emphasize value, key services, and reasons to choose this business. Be confident, direct, and helpful when moving visitors toward contact or a quote.",
    },
    support: {
      tone: "support",
      guidance: "Prioritize clarity, reassurance, and practical next steps. Reduce friction, answer common concerns directly, and keep the tone calm.",
    },
  };

  const preset = presets[presetName];

  if (!preset) {
    return;
  }

  toneInputs.forEach((input) => {
    input.checked = input.value === preset.tone;
  });

  if (guidanceInput) {
    guidanceInput.value = preset.guidance;
  }

  form.dispatchEvent(new Event("input", { bubbles: true }));
  form.dispatchEvent(new Event("change", { bubbles: true }));
}

function bindStudioState(form, agent) {
  const saveState = form?.querySelector("[data-save-state]");

  if (!form || !saveState) {
    return;
  }

  const initialSnapshot = JSON.stringify(Object.fromEntries(new FormData(form).entries()));

  const syncState = () => {
    updateStudioSummary(form, agent);
    updateBehaviorSummary(form, agent);
    document.querySelectorAll("[data-tone-card]").forEach((toneCard) => {
      const input = toneCard.querySelector('input[name="tone"]');
      toneCard.classList.toggle("active", Boolean(input?.checked));
    });
    const currentSnapshot = JSON.stringify(Object.fromEntries(new FormData(form).entries()));

    if (currentSnapshot === initialSnapshot) {
      saveState.textContent = "No changes yet.";
      saveState.className = "save-state";
      return;
    }

    saveState.textContent = "Unsaved changes";
    saveState.className = "save-state unsaved";
  };

  form.addEventListener("input", syncState);
  form.addEventListener("change", syncState);
  updateStudioSummary(form, agent);
  updateBehaviorSummary(form, agent);
}

// Event wiring for the rendered shell
function bindSharedDashboardEvents(agent, messages, setup, actionQueue) {
  const settingsForms = document.querySelectorAll("form[data-settings-form]");
  const appearancePresetButtons = document.querySelectorAll("[data-appearance-preset]");
  const configurationPresetButtons = document.querySelectorAll("[data-configuration-preset]");
  const toneCards = document.querySelectorAll("[data-tone-card]");
  const overviewSectionButtons = document.querySelectorAll("[data-overview-target]");
  const overviewFocusButtons = document.querySelectorAll("[data-overview-focus]");
  const importButtons = document.querySelectorAll('[data-action="import-knowledge"]');
  const copyButtons = document.querySelectorAll('[data-action="copy-install"]');
  const copyInstructionsButtons = document.querySelectorAll('[data-action="copy-install-instructions"]');
  const previewLinks = document.querySelectorAll('[data-action="open-preview"]');
  const markInstalledButton = document.querySelector('[data-action="mark-installed"]');
  const resetPreviewButton = document.querySelector('[data-action="reset-preview"]');
  const promptButtons = document.querySelectorAll('[data-preview-prompt]');
  const sectionButtons = document.querySelectorAll("[data-shell-target]");
  const actionQueueSections = document.querySelectorAll("[data-action-queue-section]");
  const actionQueueStatusInputs = document.querySelectorAll("[data-action-queue-status]");
  const actionQueueForms = document.querySelectorAll("[data-action-queue-form]");
  const actionQueueToggleButtons = document.querySelectorAll("[data-action-queue-toggle]");
  const followUpForms = document.querySelectorAll("[data-follow-up-form]");
  const followUpStatusButtons = document.querySelectorAll("[data-follow-up-status-action]");
  const openConversationButtons = document.querySelectorAll("[data-open-conversation]");
  const copyFollowUpButtons = document.querySelectorAll("[data-copy-follow-up]");

  const showShellSection = (targetSection) => {
    if (!SHELL_SECTIONS.includes(targetSection)) {
      return;
    }

    setActiveShellSection(targetSection);

    document.querySelectorAll("[data-shell-target]").forEach((navButton) => {
      navButton.classList.toggle("active", navButton.dataset.shellTarget === targetSection);
    });

    document.querySelectorAll("[data-shell-section]").forEach((section) => {
      section.hidden = section.dataset.shellSection !== targetSection;
    });
  };

  const saveFollowUp = async (form, nextStatus = "") => {
    const formData = new FormData(form);
    const followUpId = form.dataset.followUpId;
    const submitButton = form.querySelector('button[type="submit"]');

    if (submitButton) {
      submitButton.disabled = true;
    }

    setStatus(nextStatus
      ? `Updating follow-up to ${getFollowUpStatusLabel(nextStatus).toLowerCase()}...`
      : "Saving prepared follow-up...");

    try {
      const result = await fetchJson("/agents/follow-ups/update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: getClientId(),
          agent_id: agent.id,
          follow_up_id: followUpId,
          status: nextStatus || undefined,
          subject: trimText(formData.get("subject")),
          draft_content: trimText(formData.get("draft_content")),
        }),
      });

      setDashboardFocus("action-queue");
      setStatus(result.message || "Follow-up updated.");
      await boot();
    } catch (error) {
      setStatus(error.message || "We couldn't update that follow-up.");
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  };

  const applyActionQueueFilters = (section) => {
    const typeFilter = section.querySelector("[data-action-queue-filter-type]")?.value || "all";
    const statusFilter = section.querySelector("[data-action-queue-filter-status]")?.value || "all";
    const items = section.querySelectorAll("[data-action-queue-item]");
    let visibleCount = 0;

    items.forEach((item) => {
      const matchesType = typeFilter === "all" || item.dataset.actionQueueType === typeFilter;
      const matchesStatus = statusFilter === "all" || item.dataset.actionQueueStatus === statusFilter;
      const visible = matchesType && matchesStatus;
      item.hidden = !visible;
      if (visible) {
        visibleCount += 1;
      }
    });

    const filteredEmptyState = section.querySelector(".action-queue-filter-empty");
    if (filteredEmptyState) {
      filteredEmptyState.hidden = visibleCount > 0;
    }
  };

  settingsForms.forEach((form) => {
    form.addEventListener("submit", (event) => saveAssistant(event, agent));
    bindStudioState(form, agent);
  });

  appearancePresetButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const appearanceForm = document.querySelector('form[data-form-kind="appearance"]');
      applyAppearancePreset(appearanceForm, button.dataset.appearancePreset || "");
      setStatus("Appearance direction updated. Review the preview and save when it feels right.");
    });
  });

  configurationPresetButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const configurationForm = document.querySelector('form[data-form-kind="configuration"]');
      applyConfigurationPreset(configurationForm, button.dataset.configurationPreset || "");
      setStatus("Behavior direction updated. Review the summary and save when it feels right.");
    });
  });

  toneCards.forEach((card) => {
    card.addEventListener("click", () => {
      const targetTone = card.dataset.toneCard;
      const targetInput = card.querySelector(`input[value="${targetTone}"]`);

      if (targetInput) {
        targetInput.checked = true;
        targetInput.dispatchEvent(new Event("change", { bubbles: true }));
      }

      document.querySelectorAll("[data-tone-card]").forEach((toneCard) => {
        toneCard.classList.toggle("active", toneCard.dataset.toneCard === targetTone);
      });
    });
  });

  overviewSectionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const targetSection = button.dataset.overviewTarget;

      showShellSection(targetSection);

      const sectionEl = document.querySelector(`[data-shell-section="${targetSection}"]`);
      if (sectionEl) {
        sectionEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  overviewFocusButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.overviewFocus;

      if (!target) {
        return;
      }

      setDashboardFocus(target);
      boot();
    });
  });

  actionQueueSections.forEach((section) => {
    section.querySelector("[data-action-queue-filter-type]")?.addEventListener("change", () => {
      applyActionQueueFilters(section);
    });
    section.querySelector("[data-action-queue-filter-status]")?.addEventListener("change", () => {
      applyActionQueueFilters(section);
    });
    applyActionQueueFilters(section);
  });

  actionQueueStatusInputs.forEach((input) => {
    input.addEventListener("change", async () => {
      const previousStatus = input.dataset.previousStatus || "new";
      const nextStatus = input.value;
      input.disabled = true;
      setStatus("Updating action queue item...");

      try {
        await fetchJson("/agents/action-queue/status", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: getClientId(),
            agent_id: agent.id,
            action_key: input.dataset.actionKey,
            status: nextStatus,
          }),
        });
        input.dataset.previousStatus = nextStatus;
        setDashboardFocus("action-queue");
        setStatus(`Action item marked ${getActionQueueStatusLabel(nextStatus).toLowerCase()}.`);
        await boot();
      } catch (error) {
        input.value = previousStatus;
        setStatus(error.message || "We couldn't update that action item.");
      } finally {
        input.disabled = false;
      }
    });
    input.dataset.previousStatus = input.value;
  });

  actionQueueToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const actionKey = button.dataset.actionKey;
      const form = document.querySelector(`[data-action-queue-form][data-action-key="${actionKey}"]`);

      if (!form) {
        return;
      }

      const opening = form.hidden;
      form.hidden = !form.hidden;
      button.textContent = opening
        ? (button.dataset.closeLabel || "Hide owner handoff")
        : (button.dataset.openLabel || "Open owner handoff");
    });
  });

  actionQueueForms.forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const actionKey = form.dataset.actionKey;
      const submitButton = form.querySelector('button[type="submit"]');
      const itemEl = form.closest("[data-action-queue-item]");
      const statusInput = itemEl?.querySelector('[data-action-queue-status]');

      submitButton.disabled = true;
      setStatus("Saving owner handoff...");

      try {
        const result = await fetchJson("/agents/action-queue/status", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: getClientId(),
            agent_id: agent.id,
            action_key: actionKey,
            status: statusInput?.value || "new",
            note: trimText(formData.get("note")),
            outcome: trimText(formData.get("outcome")),
            next_step: trimText(formData.get("next_step")),
            follow_up_needed: formData.get("follow_up_needed"),
            follow_up_completed: formData.get("follow_up_completed"),
            contact_status: trimText(formData.get("contact_status")),
          }),
        });

        setDashboardFocus("action-queue");
        if (result.migrationRequired) {
          setStatus("Follow-up could not be persisted yet. Apply the action queue migration first.");
        } else {
          setStatus("Owner handoff saved.");
        }
        await boot();
      } catch (error) {
        setStatus(error.message || "We couldn't save that follow-up yet.");
      } finally {
        submitButton.disabled = false;
      }
    });
  });

  followUpForms.forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveFollowUp(form);
    });
  });

  followUpStatusButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const form = button.closest("[data-follow-up-form]");

      if (!form) {
        return;
      }

      await saveFollowUp(form, button.dataset.nextStatus || "");
    });
  });

  openConversationButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const messageId = button.dataset.messageId;

      showShellSection("analytics");

      const sectionEl = document.querySelector('[data-shell-section="analytics"]');
      if (sectionEl) {
        sectionEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }

      window.setTimeout(() => {
        const row = document.querySelector(`[data-conversation-message="${messageId}"]`);

        if (row) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          row.classList.add("active");
          window.setTimeout(() => row.classList.remove("active"), 1500);
        }
      }, 120);
    });
  });

  copyFollowUpButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const form = button.closest("[data-follow-up-form]");
      const draftValue = trimText(form?.querySelector('textarea[name="draft_content"]')?.value || "");

      if (!draftValue) {
        setStatus("There is no draft content to copy yet.");
        return;
      }

      try {
        await navigator.clipboard.writeText(draftValue);
        setStatus("Follow-up draft copied.");
      } catch (error) {
        setStatus("We couldn't copy that draft.");
      }
    });
  });

  importButtons.forEach((button) => {
    button.addEventListener("click", () => runKnowledgeImport(agent));
  });

  copyButtons.forEach((button) => {
    button.addEventListener("click", () => copyInstallCode(agent));
  });

  copyInstructionsButtons.forEach((button) => {
    button.addEventListener("click", () => copyInstallInstructions(agent));
  });

  previewLinks.forEach((link) => {
    link.addEventListener("click", () => {
      saveInstallProgress(agent.id, { previewOpened: true });
      trackProductEvent("preview_opened", {
        agentId: agent.id,
        onceKey: `preview_opened:${agent.id}`,
      });
    });
  });

  if (resetPreviewButton) {
    resetPreviewButton.addEventListener("click", () => {
      resetPreview(agent);
    });
  }

  promptButtons.forEach((button) => {
    button.addEventListener("click", () => {
      sendPromptToPreview(agent, button.dataset.previewPrompt || "");
    });
  });

  if (markInstalledButton) {
    markInstalledButton.addEventListener("click", async () => {
      const progress = getInstallProgress(agent.id);
      saveInstallProgress(agent.id, { installed: !progress.installed });
      if (!progress.installed) {
        trackProductEvent("added_to_site_confirmed", {
          agentId: agent.id,
          onceKey: `added_to_site_confirmed:${agent.id}`,
        });
      }
      setStatus(!progress.installed ? "Marked as added to your site." : "Added-to-site confirmation reset.");
      await boot();
    });
  }

  sectionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const targetSection = button.dataset.shellTarget;

      if (!SHELL_SECTIONS.includes(targetSection)) {
        return;
      }

      setActiveShellSection(targetSection);

      document.querySelectorAll("[data-shell-target]").forEach((navButton) => {
        navButton.classList.toggle("active", navButton.dataset.shellTarget === targetSection);
      });

      document.querySelectorAll("[data-shell-section]").forEach((section) => {
        section.hidden = section.dataset.shellSection !== targetSection;
      });
    });
  });

  const initialSection = getActiveShellSection(setup);
  document.querySelectorAll("[data-shell-section]").forEach((section) => {
    section.hidden = section.dataset.shellSection !== initialSection;
  });

  const focusTarget = getDashboardFocus();

  if (focusTarget) {
    const focusMap = {
      preview: ".preview-card",
      install: ".install-card",
      setup: '[data-shell-section="customize"]',
      "action-queue": "[data-action-queue-section]",
    };
    const selector = focusMap[focusTarget];
    const target = selector ? document.querySelector(selector) : null;

    if (target) {
      if (focusTarget === "setup") {
        setActiveShellSection("customize");
        document.querySelectorAll("[data-shell-target]").forEach((navButton) => {
          navButton.classList.toggle("active", navButton.dataset.shellTarget === "customize");
        });
        document.querySelectorAll("[data-shell-section]").forEach((section) => {
          section.hidden = section.dataset.shellSection !== "customize";
        });
      }

      window.requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    clearDashboardFocus();
  }
}

// Dashboard bootstrapping
async function boot() {
  trackProductEvent("dashboard_arrived", {
    onceKey: "dashboard_arrived",
    metadata: {
      path: window.location.pathname,
    },
  });

  if (!hasAuthConfig()) {
    setStatus("Supabase Auth is not configured yet.");
    renderAuthEntry();
    return;
  }

  await ensureAuthClient();
  renderTopbarMeta();

  if (!authSession || !authUser) {
    clearLaunchState();
    renderAuthEntry();
    return;
  }

  if (getAuthFlowType() === "recovery") {
    authViewMode = AUTH_VIEW_MODES.UPDATE_PASSWORD;
    renderAuthEntry();
    return;
  }

  setAuthFeedback(null, "");

  const paymentState = getPaymentState();

  if (paymentState.payment === "cancel") {
    setStatus("Checkout was canceled. You can unlock Vonza whenever you're ready.");
    clearPaymentStateFromUrl();
  } else if (paymentState.payment === "success") {
    try {
      await confirmPaymentReturn();
    } catch (error) {
      clearPaymentStateFromUrl();
      setStatus(error.message || "Payment completed, but we could not activate access yet.");
    }
  }

  const launchState = getLaunchState();

  if (launchState?.status === "running") {
    renderLaunchSequence({
      ...launchState,
      recovering: true,
      headline: "We’re checking your assistant setup.",
      detail: "If your website import was still in progress, we’ll reconnect you to the right next step.",
      note: "You do not need to start over unless the assistant was never created.",
    });
  }

  try {
    let data = null;

    if (paymentState.payment === "success" && paymentState.sessionId) {
      data = await waitForActiveAccessAfterPayment();

      if (data?.timedOut) {
        setStatus("Payment confirmed. Access is still being activated. Please refresh in a moment if the workspace does not open yet.");
        data = null;
      }
    }

    const { agents, bridgeAgent } = data || await loadAgents();

    if (!agents.length) {
      if (bridgeAgent && !isClaimDismissed()) {
        clearLaunchState();
        renderClaimAssistant(bridgeAgent);
        return;
      }

      if (launchState?.status === "running") {
        clearLaunchState();
        setStatus("Setup was interrupted before your assistant was created. You can start again whenever you're ready.");
      }
      setStatus("Sign in complete. Unlock Vonza to open your setup workspace.");
      renderAccessLocked(null);
      return;
    }

    const agent = agents[0];
    const accessStatus = normalizeAccessStatus(agent.accessStatus);

    if (accessStatus !== "active") {
      clearLaunchState();
      setStatus(accessStatus === "suspended"
        ? "Workspace access is currently paused."
        : "Finish payment to open your Vonza setup workspace."
      );
      renderAccessLocked(agent);
      return;
    }

    const messages = await loadAgentMessages(agent.id);
    const actionQueue = await loadActionQueue(agent.id);
    const setup = inferSetup(agent);

    clearLaunchState();

    if (setup.isReady) {
      renderReadyState(agent, messages, actionQueue);
      return;
    }

    renderSetupState(agent, messages, setup, actionQueue);
  } catch (error) {
    clearLaunchState();
    setStatus(error.message || "We couldn't load your Vonza workspace right now.");
    renderErrorState(
      "We couldn't load your Vonza workspace.",
      error.message || "Please refresh and try again. If the issue continues, your account and payment state are still safe."
    );
  }
}

boot();

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
let authClient = null;
let authSession = null;
let authUser = null;

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
  rootEl.innerHTML = `
    <section class="auth-card">
      <span class="eyebrow">${arrival.arrivedFromSite ? "Step 1 of 3" : "Client access"}</span>
      <h1 class="headline">Sign in to continue into Vonza</h1>
      <p class="auth-copy">Use your email to sign up or sign back in. Vonza will send a secure magic link, then bring you into the app where you can unlock the product and set up your assistant.</p>
      <form id="auth-form" class="auth-form">
        <div class="field">
          <label for="auth-email">Email address</label>
          <input id="auth-email" name="email" type="email" placeholder="you@yourbusiness.com" autocomplete="email">
        </div>
        <div class="auth-actions">
          <button id="auth-submit" class="primary-button" type="submit">Continue with email</button>
          <span class="auth-note">You can use the same email to return to this workspace later.</span>
        </div>
      </form>
    </section>
  `;

  document.getElementById("auth-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!authClient) {
      setStatus("Supabase Auth is not configured yet.");
      return;
    }

    const form = event.currentTarget;
    const formData = new FormData(form);
    const email = trimText(formData.get("email"));
    const submitButton = document.getElementById("auth-submit");

    if (!email) {
      setStatus("Enter your email first.");
      return;
    }

    submitButton.disabled = true;
    setStatus("Sending your login link...");

    try {
      const redirectUrl = new URL("/dashboard", window.location.origin);
      if (arrival.from) {
        redirectUrl.searchParams.set("from", arrival.from);
      }

      const { error } = await authClient.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: redirectUrl.toString(),
        },
      });

      if (error) {
        throw error;
      }

      setStatus("Magic link sent. Open it from your email to access your assistant workspace.");
    } catch (error) {
      setStatus(error.message || "We could not send the login link just yet.");
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
        <span class="nav-note">Usage, common questions, and empty-state insights</span>
      </button>
    </nav>
  `;
}

function buildOverviewPanel(agent, messages, setup) {
  return `
    <section class="workspace-panel workspace-panel-overview" data-shell-section="overview">
      ${buildOverviewSection(agent, messages, setup)}
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
    normalized.includes("price")
    || normalized.includes("pricing")
    || normalized.includes("cost")
    || normalized.includes("quote")
    || normalized.includes("how much")
  ) {
    return "pricing";
  }

  if (
    normalized.includes("contact")
    || normalized.includes("reach")
    || normalized.includes("call")
    || normalized.includes("email")
    || normalized.includes("book")
    || normalized.includes("appointment")
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

function buildOverviewState(agent, messages, setup) {
  const installStatus = agent.installStatus || {
    state: "not_detected",
    label: "Not detected on a live site yet",
    host: "",
    lastSeenAt: null,
  };
  const messageCount = Number(agent.messageCount || messages.length || 0);
  const lastActivity = agent.lastMessageAt || installStatus.lastSeenAt || null;
  const activity = getActivityLevel(messageCount, agent.lastMessageAt);
  const userMessages = messages.filter((message) => message.role === "user");
  const recentQuestions = userMessages
    .map((message) => trimText(message.content || ""))
    .filter(Boolean)
    .slice(0, 3);
  const intentCounts = {
    general: 0,
    services: 0,
    pricing: 0,
    contact: 0,
  };

  userMessages.forEach((message) => {
    intentCounts[categorizeIntent(message.content || "")] += 1;
  });

  const topIntent = Object.entries(intentCounts)
    .sort((left, right) => right[1] - left[1])[0];

  const nextActions = [];
  let title = "Your assistant workspace";
  let copy = "Your assistant is set up in Vonza and ready for the next step.";

  if (installStatus.state === "live") {
    if (messageCount > 0) {
      title = "Your assistant is live and already working";
      copy = `Vonza is live on ${installStatus.host || "your site"} and has already started handling real customer questions.`;
      nextActions.push({
        label: "Review analytics",
        type: "section",
        value: "analytics",
      });
      nextActions.push({
        label: "Refine setup",
        type: "section",
        value: "customize",
      });
    } else {
      title = "Your assistant is live";
      copy = `Vonza has been detected on ${installStatus.host || "your site"} and is ready for customer questions, even if activity is still early.`;
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
    nextActions.push({
      label: "Go to install",
      type: "focus",
      value: "install",
    });
    nextActions.push({
      label: "Copy install code",
      type: "install",
    });
  } else {
    title = "Your assistant is almost ready to go live";
    copy = "The setup is in place, and the next step is getting the widget onto your live site so Vonza can start helping visitors.";
    nextActions.push({
      label: "Go to install",
      type: "focus",
      value: "install",
    });
    nextActions.push({
      label: "Copy install code",
      type: "install",
    });
  }

  if (!setup.knowledgeReady) {
    nextActions.unshift({
      label: "Strengthen website knowledge",
      type: "import",
    });
  }

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
      pricing: "pricing and quote expectations",
      contact: "how to contact the business",
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
    cards,
    nextActions: nextActions.slice(0, 3),
    title,
    copy,
  };
}

function buildOverviewSection(agent, messages, setup) {
  const overview = buildOverviewState(agent, messages, setup);

  const renderAction = (action) => {
    if (action.type === "section") {
      return `<button class="ghost-button" type="button" data-overview-target="${action.value}">${action.label}</button>`;
    }

    if (action.type === "focus") {
      return `<button class="ghost-button" type="button" data-overview-focus="${action.value}">${action.label}</button>`;
    }

    if (action.type === "import") {
      return `<button class="ghost-button" type="button" data-action="import-knowledge">${action.label}</button>`;
    }

    if (action.type === "install") {
      return `<button class="primary-button" type="button" data-action="copy-install" ${trimText(agent.publicAgentKey) ? "" : "disabled"}>${action.label}</button>`;
    }

    if (action.type === "preview") {
      return `<a class="test-link" data-action="open-preview" href="${buildWidgetUrl(agent.publicAgentKey)}" target="_blank" rel="noreferrer">${action.label}</a>`;
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
            <div class="overview-metric-label">Live host</div>
            <div class="overview-metric-value">${escapeHtml(overview.installStatus.host || (overview.installStatus.state === "test" ? "Test or preview" : "Not detected"))}</div>
          </div>
          <div class="overview-metric">
            <div class="overview-metric-label">Last seen</div>
            <div class="overview-metric-value">${escapeHtml(overview.installStatus.lastSeenAt ? formatSeenAt(overview.installStatus.lastSeenAt) : "Not detected yet")}</div>
          </div>
          <div class="overview-metric">
            <div class="overview-metric-label">Total messages</div>
            <div class="overview-metric-value">${overview.messageCount}</div>
          </div>
          <div class="overview-metric">
            <div class="overview-metric-label">Last activity</div>
            <div class="overview-metric-value">${escapeHtml(overview.lastActivity ? formatSeenAt(overview.lastActivity) : "No activity yet")}</div>
          </div>
        </div>
        <div class="overview-action-row">
          ${overview.nextActions.map(renderAction).join("")}
        </div>
      </section>

      <div class="overview-grid">
        <section class="overview-card">
          <h3 class="overview-card-title">What Vonza sees right now</h3>
          <p class="overview-card-copy">${escapeHtml(overview.activity.description)}</p>
          <div class="overview-list">
            ${overview.cards.map((card) => `
              <div class="overview-list-item">
                <p class="overview-list-title">${escapeHtml(card.title)}</p>
                <p class="overview-list-copy">${escapeHtml(card.copy)}</p>
              </div>
            `).join("")}
          </div>
        </section>

        <section class="overview-card">
          <h3 class="overview-card-title">What to do next</h3>
          <p class="overview-card-copy">${escapeHtml(
            overview.installStatus.state !== "live"
              ? "Your strongest next step is getting the assistant onto the live site so Vonza can start detecting real usage."
              : overview.messageCount === 0
              ? "Your assistant is live. Now the goal is making the first interaction strong enough that visitors actually use it."
                : "Your assistant is live and active. The best next move is refining what visitors see and how Vonza responds to the most common questions."
          )}</p>
          <div class="overview-list">
            <div class="overview-list-item">
              <p class="overview-list-title">${escapeHtml(
                overview.installStatus.state !== "live"
                  ? "Finish install"
                  : overview.messageCount === 0
                    ? "Increase first-use confidence"
                    : "Review recent usage"
              )}</p>
              <p class="overview-list-copy">${escapeHtml(
                overview.installStatus.state !== "live"
                  ? "Copy the install code, place it on the live site, and let Vonza detect the real host automatically."
                  : overview.messageCount === 0
                    ? "Strengthen the welcome message and launcher text, then test common customer questions in preview."
                    : "Check Analytics for top customer questions, then use Customize to sharpen the assistant if you want it to feel stronger."
              )}</p>
            </div>
            ${!setup.knowledgeReady ? `
              <div class="overview-list-item">
                <p class="overview-list-title">Keep knowledge strong</p>
                <p class="overview-list-copy">Website knowledge is still ${setup.knowledgeLimited ? "limited" : "not fully ready"}. Another import can improve the quality of real customer answers.</p>
              </div>
            ` : ""}
          </div>
        </section>
      </div>
    </section>
  `;
}

function buildAnalyticsPanel(agent, messages, setup) {
  const userMessages = messages.filter((message) => message.role === "user");
  const recentInteractions = messages.slice(0, 12);
  const frequentQuestionMap = new Map();
  const intentCounts = {
    general: 0,
    services: 0,
    pricing: 0,
    contact: 0,
  };

  userMessages.forEach((message) => {
    const content = trimText(message.content || "");
    const normalizedQuestion = normalizeQuestion(content);

    if (normalizedQuestion) {
      const current = frequentQuestionMap.get(normalizedQuestion) || {
        label: content,
        count: 0,
      };

      current.count += 1;
      if (content.length < current.label.length) {
        current.label = content;
      }
      frequentQuestionMap.set(normalizedQuestion, current);
    }

    const intent = categorizeIntent(content);
    intentCounts[intent] += 1;
  });

  const topQuestions = [...frequentQuestionMap.values()]
    .sort((left, right) => right.count - left.count || left.label.length - right.label.length)
    .slice(0, 4);
  const activity = getActivityLevel(agent.messageCount || messages.length || 0, agent.lastMessageAt);
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
            <div class="metric-label">Last message</div>
            <div class="metric-value">${escapeHtml(agent.lastMessageAt ? formatSeenAt(agent.lastMessageAt) : "No messages yet")}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Install status</div>
            <div class="metric-value">${escapeHtml(installStatus.state === "live" ? installStatus.host || "Live" : installStatus.state === "test" ? "Test or preview" : "Not detected")}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Activity level</div>
            <div class="metric-value">${escapeHtml(activity.label)}</div>
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
                <p class="analytics-subtle">${escapeHtml(agent.lastMessageAt ? `Most recent message: ${formatSeenAt(agent.lastMessageAt)}.` : "No recent messages yet.")}</p>
              </div>
              <div class="analytics-item">
                <p class="analytics-item-title">Knowledge state</p>
                <p class="analytics-item-copy">${escapeHtml(setup.knowledgeDescription)}</p>
                <p class="analytics-subtle">${escapeHtml(setup.knowledgePageCount ? `${setup.knowledgePageCount} imported page${setup.knowledgePageCount === 1 ? "" : "s"} currently support the assistant.` : "Website knowledge is still being built from your site.")}</p>
              </div>
            </div>
          </section>

          <section class="workspace-card-soft">
            <h3 class="studio-group-title">Needs attention</h3>
            <p class="studio-group-copy">A few practical opportunities surfaced from the current real usage and setup signals.</p>
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
        </div>

        <section class="workspace-card-soft">
          <h3 class="studio-group-title">Top customer questions</h3>
          <p class="studio-group-copy">Based on repeated recent user messages. Similar questions are grouped lightly by normalized wording, not by a full AI clustering system.</p>
          ${topQuestions.length ? `
            <div class="question-list">
              ${topQuestions.map((item) => `
                <div class="question-row">${escapeHtml(item.label)}${item.count > 1 ? ` (${item.count})` : ""}</div>
              `).join("")}
            </div>
          ` : `<div class="placeholder-card">Once customers start asking questions more than once, you’ll see the strongest themes here.</div>`}
        </section>

        <section class="workspace-card-soft">
          <h3 class="studio-group-title">What customers ask about</h3>
          <p class="studio-group-copy">A lightweight breakdown based on simple message cues from recent user questions.</p>
          ${userMessages.length ? `
            <div class="intent-grid">
              <div class="intent-card">
                <p class="intent-label">General</p>
                <p class="intent-value">${intentCounts.general}</p>
                <p class="intent-copy">Broad questions about the business, what it does, or what makes it different.</p>
              </div>
              <div class="intent-card">
                <p class="intent-label">Services</p>
                <p class="intent-value">${intentCounts.services}</p>
                <p class="intent-copy">Questions about offerings, services, and what customers can hire or buy.</p>
              </div>
              <div class="intent-card">
                <p class="intent-label">Pricing</p>
                <p class="intent-value">${intentCounts.pricing}</p>
                <p class="intent-copy">Questions that suggest visitors want cost expectations or quote guidance.</p>
              </div>
              <div class="intent-card">
                <p class="intent-label">Contact</p>
                <p class="intent-value">${intentCounts.contact}</p>
                <p class="intent-copy">Questions from visitors who may be ready to reach out or take a next step.</p>
              </div>
            </div>
          ` : `<div class="placeholder-card">Once people start using the assistant, Vonza will show a simple breakdown of what they ask about most.</div>`}
        </section>

        <section class="workspace-card-soft">
          <h3 class="studio-group-title">Recent conversations</h3>
          <p class="studio-group-copy">A readable view of the most recent interactions stored for this assistant.</p>
          ${recentInteractions.length ? `
            <div class="messages-list">
              ${recentInteractions.map((message) => `
                <div class="message-row ${escapeHtml(message.role || "")}">
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

function renderAssistantShell(agent, messages, setup) {
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

      ${buildOverviewPanel(agent, messages, setup)}
      ${buildCustomizePanel(agent, setup)}
      ${buildAnalyticsPanel(agent, messages, setup)}
    </div>
  `;

  bindSharedDashboardEvents(agent, messages, setup);
}

function renderSetupState(agent, messages, setup) {
  renderAssistantShell(agent, messages, setup);
}

function renderReadyState(agent, messages) {
  renderAssistantShell(agent, messages, inferSetup(agent));
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

  submitButton.disabled = true;
  if (saveState) {
    saveState.textContent = "Saving changes...";
    saveState.className = "save-state saving";
  }
  setStatus("Saving your assistant...");

  try {
    const updateData = await fetchJson("/agents/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
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
      })
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
    }
    await boot();
  } catch (error) {
    setStatus("We couldn't save those changes just yet.");
    if (saveState) {
      saveState.textContent = "Could not save changes.";
      saveState.className = "save-state unsaved";
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
function bindSharedDashboardEvents(agent, messages, setup) {
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
    const setup = inferSetup(agent);

    clearLaunchState();

    if (setup.isReady) {
      renderReadyState(agent, messages);
      return;
    }

    renderSetupState(agent, messages, setup);
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

(function initVonzaMarketing() {
  const authLink = document.getElementById("site-auth-link");
  const primaryCta = document.getElementById("site-primary-cta");
  const appLinks = Array.from(document.querySelectorAll("[data-app-link]"));

  function hasAuthConfig() {
    return Boolean(
      window.VONZA_SUPABASE_URL
      && window.VONZA_SUPABASE_ANON_KEY
      && window.supabase?.createClient
    );
  }

  function getAppHref(isSignedIn) {
    return isSignedIn ? "/dashboard" : "/dashboard?from=site";
  }

  function getAuthStorageKey() {
    try {
      const projectRef = new URL(window.VONZA_SUPABASE_URL).hostname.split(".")[0];
      return projectRef ? `sb-${projectRef}-auth-token` : "";
    } catch {
      return "";
    }
  }

  function extractStoredSession(value) {
    if (!value) {
      return null;
    }

    if (Array.isArray(value)) {
      return value.map(extractStoredSession).find(Boolean) || null;
    }

    if (typeof value !== "object") {
      return null;
    }

    if (value.user && (value.access_token || value.refresh_token || value.expires_at || value.expires_in)) {
      return value;
    }

    return extractStoredSession(value.currentSession || value.session || null);
  }

  function getStoredSession() {
    try {
      const storageKey = getAuthStorageKey();

      if (!storageKey || !window.localStorage) {
        return null;
      }

      const rawValue = window.localStorage.getItem(storageKey);

      if (!rawValue) {
        return null;
      }

      return extractStoredSession(JSON.parse(rawValue));
    } catch {
      return null;
    }
  }

  function syncMarketingCtas(session) {
    const isSignedIn = Boolean(session?.user);
    const href = getAppHref(isSignedIn);

    appLinks.forEach((link) => {
      link.setAttribute("href", href);
    });

    if (primaryCta) {
      primaryCta.textContent = isSignedIn ? "My Account" : "Get started";
      primaryCta.setAttribute("href", href);
    }

    if (authLink) {
      authLink.hidden = isSignedIn;
      authLink.setAttribute("href", href);
      authLink.textContent = "Sign in";
    }
  }

  async function bootMarketingAuth() {
    const storedSession = getStoredSession();
    syncMarketingCtas(storedSession);

    if (!hasAuthConfig()) {
      return;
    }

    const authClient = window.supabase.createClient(
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
    syncMarketingCtas(data?.session || storedSession || null);

    if (typeof authClient.auth?.onAuthStateChange === "function") {
      authClient.auth.onAuthStateChange((_event, session) => {
        syncMarketingCtas(session || null);
      });
    }
  }

  bootMarketingAuth().catch((error) => {
    console.warn("[marketing auth] Could not load session state:", error?.message || error);
    syncMarketingCtas(null);
  });
}());

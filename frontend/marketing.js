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
    syncMarketingCtas(null);

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
    syncMarketingCtas(data?.session || null);

    authClient.auth.onAuthStateChange((_event, session) => {
      syncMarketingCtas(session || null);
    });
  }

  bootMarketingAuth().catch((error) => {
    console.warn("[marketing auth] Could not load session state:", error?.message || error);
    syncMarketingCtas(null);
  });
}());

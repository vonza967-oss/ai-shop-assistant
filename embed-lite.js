(() => {
  const ROOT_ID = "vonza-widget-lite";
  const FLAG = "__VonzaWidgetLiteLoaded__";
  if (window[FLAG] || document.getElementById(ROOT_ID)) return;

  const script =
    document.currentScript ||
    [...document.getElementsByTagName("script")]
      .reverse()
      .find((node) => /\/embed-lite\.js(?:\?|$)/.test(node.src));
  const config = window.VonzaWidgetConfig || {};
  const fallbackUrl = script?.src
    ? new URL(script.src, window.location.href)
    : new URL(window.location.href);
  const baseUrl = (
    script?.dataset.baseUrl ||
    config.baseUrl ||
    fallbackUrl.origin
  ).replace(/\/$/, "");
  const businessId =
    script?.dataset.businessId ||
    config.businessId ||
    "";
  const websiteUrl =
    script?.dataset.websiteUrl ||
    config.websiteUrl ||
    (/^https?:$/.test(window.location.protocol) ? window.location.origin : "");
  const label =
    script?.dataset.buttonLabel ||
    config.buttonLabel ||
    "Chat with Vonza";
  const widgetUrl = new URL("/widget", baseUrl);

  widgetUrl.searchParams.set("embedded", "1");
  if (businessId) widgetUrl.searchParams.set("business_id", businessId);
  if (websiteUrl) widgetUrl.searchParams.set("website_url", websiteUrl);

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <style>
      #${ROOT_ID}{position:fixed;right:20px;bottom:20px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #${ROOT_ID} *{box-sizing:border-box}
      #${ROOT_ID} .vonza-lite-button{width:58px;height:58px;border:0;border-radius:999px;cursor:pointer;background:radial-gradient(circle at 28% 24%,rgba(255,255,255,.26),transparent 30%),linear-gradient(145deg,#6D28D9 0%,#9333EA 52%,#C084FC 100%);color:#fff;font:900 24px/1 inherit;letter-spacing:-.12em;text-shadow:0 4px 18px rgba(76,29,149,.32);box-shadow:0 18px 42px rgba(76,29,149,.34),0 0 22px rgba(192,132,252,.22),inset 0 1px 0 rgba(255,255,255,.2);transition:transform .22s ease,box-shadow .22s ease}
      #${ROOT_ID} .vonza-lite-button:hover{transform:translateY(-2px) scale(1.05);box-shadow:0 22px 50px rgba(76,29,149,.4),0 0 28px rgba(192,132,252,.34),inset 0 1px 0 rgba(255,255,255,.24)}
      #${ROOT_ID} .vonza-lite-modal{position:fixed;inset:0;display:none;align-items:flex-end;justify-content:flex-end;padding:18px;background:rgba(3,8,18,.24)}
      #${ROOT_ID} .vonza-lite-modal[data-open="true"]{display:flex}
      #${ROOT_ID} .vonza-lite-panel{position:relative;width:min(390px,calc(100vw - 24px));height:min(680px,calc(100vh - 24px));overflow:hidden;border-radius:24px;background:#09101d;box-shadow:0 32px 96px rgba(0,0,0,.34)}
      #${ROOT_ID} .vonza-lite-close{position:absolute;top:12px;right:12px;width:34px;height:34px;border:0;border-radius:999px;cursor:pointer;background:rgba(8,13,25,.7);color:#fff;font:400 20px/1 inherit;z-index:1}
      #${ROOT_ID} .vonza-lite-frame{width:100%;height:100%;border:0;background:#09101d}
      @media (max-width:640px){#${ROOT_ID}{right:16px;bottom:16px}#${ROOT_ID} .vonza-lite-button{width:56px;height:56px}#${ROOT_ID} .vonza-lite-modal{padding:0}#${ROOT_ID} .vonza-lite-panel{width:100vw;height:100vh;border-radius:0}}
    </style>
    <button class="vonza-lite-button" type="button" aria-label="${label}">V</button>
    <div class="vonza-lite-modal" data-open="false" aria-hidden="true">
      <div class="vonza-lite-panel" role="dialog" aria-modal="true" aria-label="Vonza assistant">
        <button class="vonza-lite-close" type="button" aria-label="Close">&times;</button>
        <iframe class="vonza-lite-frame" title="Vonza Assistant" referrerpolicy="strict-origin-when-cross-origin"></iframe>
      </div>
    </div>
  `;

  document.body.appendChild(root);
  window[FLAG] = true;

  const button = root.querySelector(".vonza-lite-button");
  const modal = root.querySelector(".vonza-lite-modal");
  const panel = root.querySelector(".vonza-lite-panel");
  const closeButton = root.querySelector(".vonza-lite-close");
  const frame = root.querySelector(".vonza-lite-frame");
  let loaded = false;
  let previousBodyOverflow = "";
  let previousHtmlOverflow = "";

  function open() {
    modal.dataset.open = "true";
    modal.setAttribute("aria-hidden", "false");
    previousBodyOverflow = document.body.style.overflow;
    previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (!loaded) {
      frame.src = widgetUrl.toString();
      loaded = true;
      console.log("[Vonza lite] iframe:", frame.src);
    }
  }

  function close() {
    modal.dataset.open = "false";
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = previousBodyOverflow;
    document.documentElement.style.overflow = previousHtmlOverflow;
  }

  button.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  panel.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
})();

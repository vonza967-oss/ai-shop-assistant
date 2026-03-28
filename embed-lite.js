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
      #${ROOT_ID} .vonza-lite-button{width:58px;height:58px;border:0;border-radius:999px;cursor:pointer;background:radial-gradient(circle at 28% 24%,rgba(192,132,252,.12),transparent 34%),linear-gradient(145deg,#0F0A1F 0%,#181028 52%,#25163b 100%);color:transparent;font:500 22px/1 inherit;letter-spacing:.08em;background-clip:padding-box;text-shadow:0 0 10px rgba(196,181,253,.18),0 0 18px rgba(147,51,234,.12);box-shadow:0 14px 30px rgba(6,4,17,.34),0 0 18px rgba(147,51,234,.14),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .22s ease,box-shadow .22s ease}
      #${ROOT_ID} .vonza-lite-button:hover{transform:translateY(-1px) scale(1.05);box-shadow:0 18px 36px rgba(6,4,17,.38),0 0 24px rgba(147,51,234,.2),inset 0 1px 0 rgba(255,255,255,.1)}
      #${ROOT_ID} .vonza-lite-mark{display:inline-block;background:linear-gradient(180deg,#c4b5fd 0%,#ede9fe 58%,#faf5ff 100%);background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 0 6px rgba(147,51,234,.16))}
      #${ROOT_ID} .vonza-lite-mark.is-opening{animation:vonzaLiteLogoPulse .28s cubic-bezier(.22,1,.36,1)}
      #${ROOT_ID} .vonza-lite-modal{position:fixed;inset:0;display:flex;align-items:flex-end;justify-content:flex-end;padding:18px;background:rgba(3,8,18,.24);opacity:0;pointer-events:none;transition:opacity .28s cubic-bezier(.22,1,.36,1)}
      #${ROOT_ID} .vonza-lite-modal[data-open="true"]{opacity:1;pointer-events:auto}
      #${ROOT_ID} .vonza-lite-panel{position:relative;width:min(390px,calc(100vw - 24px));height:min(680px,calc(100vh - 24px));overflow:hidden;border-radius:24px;background:#09101d;box-shadow:0 32px 96px rgba(0,0,0,.34);transform:translateY(10px) scale(.95);opacity:0;transition:transform .28s cubic-bezier(.22,1,.36,1),opacity .28s cubic-bezier(.22,1,.36,1)}
      #${ROOT_ID} .vonza-lite-modal[data-open="true"] .vonza-lite-panel{transform:translateY(0) scale(1);opacity:1}
      #${ROOT_ID} .vonza-lite-close{position:absolute;top:12px;right:12px;width:34px;height:34px;border:0;border-radius:999px;cursor:pointer;background:rgba(8,13,25,.7);color:#fff;font:400 20px/1 inherit;z-index:1}
      #${ROOT_ID} .vonza-lite-frame{width:100%;height:100%;border:0;background:#09101d}
      @keyframes vonzaLiteLogoPulse{0%{transform:translateY(10px) scale(.95);opacity:0;filter:drop-shadow(0 0 3px rgba(147,51,234,.12))}55%{transform:translateY(0) scale(1.04);opacity:1;filter:drop-shadow(0 0 12px rgba(196,181,253,.22))}100%{transform:translateY(0) scale(1);opacity:1;filter:drop-shadow(0 0 6px rgba(147,51,234,.16))}}
      @media (max-width:640px){#${ROOT_ID}{right:16px;bottom:16px}#${ROOT_ID} .vonza-lite-button{width:56px;height:56px}#${ROOT_ID} .vonza-lite-modal{padding:0}#${ROOT_ID} .vonza-lite-panel{width:100vw;height:100vh;border-radius:0}}
    </style>
    <button class="vonza-lite-button" type="button" aria-label="${label}"><span class="vonza-lite-mark">V</span></button>
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
  const mark = root.querySelector(".vonza-lite-mark");
  const modal = root.querySelector(".vonza-lite-modal");
  const panel = root.querySelector(".vonza-lite-panel");
  const closeButton = root.querySelector(".vonza-lite-close");
  const frame = root.querySelector(".vonza-lite-frame");
  let loaded = false;
  let previousBodyOverflow = "";
  let previousHtmlOverflow = "";

  function pulseMark() {
    mark.classList.remove("is-opening");
    void mark.offsetWidth;
    mark.classList.add("is-opening");
    window.setTimeout(() => mark.classList.remove("is-opening"), 320);
  }

  function open() {
    modal.dataset.open = "true";
    modal.setAttribute("aria-hidden", "false");
    pulseMark();
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

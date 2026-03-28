(() => {
  const GLOBAL_FLAG = "__VonzaAssistantWidgetLoaded__";
  const ROOT_ID = "vonza-widget-root";
  const LOG_PREFIX = "[Vonza widget]";

  if (window[GLOBAL_FLAG] || document.getElementById(ROOT_ID)) {
    console.warn(`${LOG_PREFIX} widget already injected, skipping duplicate load.`);
    return;
  }

  function resolveCurrentScript() {
    if (document.currentScript) {
      return document.currentScript;
    }

    const scripts = Array.from(document.getElementsByTagName("script"));
    return scripts.reverse().find((script) => /\/embed\.js(?:\?|$)/.test(script.src));
  }

  function createLogger(enabled) {
    return {
      log: (...args) => {
        if (enabled) {
          console.log(LOG_PREFIX, ...args);
        }
      },
      warn: (...args) => console.warn(LOG_PREFIX, ...args),
      error: (...args) => console.error(LOG_PREFIX, ...args),
    };
  }

  function getConfig(currentScript) {
    const fallbackUrl = currentScript?.src
      ? new URL(currentScript.src, window.location.href)
      : new URL(window.location.href);
    const scriptConfig = window.VonzaWidgetConfig || {};

    const baseUrl = (
      currentScript?.dataset.baseUrl ||
      scriptConfig.baseUrl ||
      fallbackUrl.origin
    ).replace(/\/$/, "");

    return {
      baseUrl,
      businessId:
        currentScript?.dataset.businessId ||
        scriptConfig.businessId ||
        "",
      websiteUrl:
        currentScript?.dataset.websiteUrl ||
        scriptConfig.websiteUrl ||
        (/^https?:$/.test(window.location.protocol) ? window.location.origin : ""),
      buttonLabel:
        currentScript?.dataset.buttonLabel ||
        scriptConfig.buttonLabel ||
        "Chat with Vonza",
      debug:
        currentScript?.dataset.debug === "true" ||
        scriptConfig.debug === true,
    };
  }

  function buildWidgetUrl(baseUrl, businessId, websiteUrl) {
    const url = new URL("/widget", baseUrl);
    url.searchParams.set("embedded", "1");

    if (businessId) {
      url.searchParams.set("business_id", businessId);
    }

    if (websiteUrl) {
      url.searchParams.set("website_url", websiteUrl);
    }

    return url;
  }

  function createTemplate(buttonLabel) {
    return `
      <style>
        :host {
          all: initial;
        }

        *, *::before, *::after {
          box-sizing: border-box;
        }

        .widget-shell {
          position: fixed;
          right: 20px;
          bottom: 20px;
          z-index: 2147483647;
          font-family: "Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .launcher {
          width: 60px;
          height: 60px;
          border: none;
          border-radius: 999px;
          position: relative;
          display: grid;
          place-items: center;
          cursor: pointer;
          color: #effff8;
          background:
            radial-gradient(circle at 26% 22%, rgba(255, 255, 255, 0.24), transparent 22%),
            linear-gradient(145deg, #0fb896 0%, #15839c 54%, #122441 100%);
          box-shadow:
            0 22px 42px rgba(6, 15, 29, 0.34),
            0 10px 24px rgba(16, 163, 127, 0.22),
            inset 0 1px 0 rgba(255, 255, 255, 0.18);
          transition:
            transform 220ms cubic-bezier(0.22, 1, 0.36, 1),
            box-shadow 220ms ease;
        }

        .launcher:hover {
          transform: translateY(-2px) scale(1.015);
          box-shadow:
            0 26px 52px rgba(6, 15, 29, 0.38),
            0 14px 28px rgba(16, 163, 127, 0.28),
            inset 0 1px 0 rgba(255, 255, 255, 0.24);
        }

        .launcher::before {
          content: "";
          position: absolute;
          inset: -8px;
          border-radius: 999px;
          border: 1px solid rgba(16, 163, 127, 0.18);
          opacity: 0.9;
          transform: scale(0.92);
          animation: ring 2.6s infinite ease-out;
          pointer-events: none;
        }

        .launcher-badge {
          width: 38px;
          height: 38px;
          border-radius: 14px;
          display: grid;
          place-items: center;
          font-size: 18px;
          font-weight: 800;
          letter-spacing: -0.08em;
          background: rgba(255, 255, 255, 0.12);
          border: 1px solid rgba(255, 255, 255, 0.18);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
          backdrop-filter: blur(10px);
        }

        .launcher-label {
          position: absolute;
          right: 72px;
          top: 50%;
          transform: translateY(-50%) translateX(10px);
          padding: 10px 14px;
          border-radius: 999px;
          white-space: nowrap;
          color: #e8edf9;
          background: rgba(8, 13, 25, 0.86);
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: 0 20px 40px rgba(4, 10, 20, 0.28);
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.02em;
          opacity: 0;
          pointer-events: none;
          transition:
            opacity 180ms ease,
            transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
        }

        .widget-shell:hover .launcher-label {
          opacity: 1;
          transform: translateY(-50%) translateX(0);
        }

        .modal {
          position: fixed;
          inset: 0;
          display: flex;
          align-items: flex-end;
          justify-content: flex-end;
          padding: 18px;
          background: rgba(4, 10, 20, 0.28);
          backdrop-filter: blur(6px);
          opacity: 0;
          pointer-events: none;
          transition:
            opacity 220ms ease,
            backdrop-filter 220ms ease;
        }

        .modal[data-open="true"] {
          opacity: 1;
          pointer-events: auto;
        }

        .panel {
          position: relative;
          width: min(392px, calc(100vw - 24px));
          height: min(680px, calc(100vh - 24px));
          border-radius: 26px;
          overflow: hidden;
          box-shadow:
            0 32px 96px rgba(0, 0, 0, 0.42),
            0 10px 24px rgba(4, 10, 20, 0.28);
          border: 1px solid rgba(255, 255, 255, 0.1);
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0)),
            #09101d;
          transform: translateY(24px) scale(0.96);
          opacity: 0;
          transition:
            transform 280ms cubic-bezier(0.22, 1, 0.36, 1),
            opacity 220ms ease;
        }

        .modal[data-open="true"] .panel {
          transform: translateY(0) scale(1);
          opacity: 1;
        }

        .panel::before {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), transparent 16%);
          pointer-events: none;
          z-index: 1;
        }

        .frame {
          width: 100%;
          height: 100%;
          border: none;
          display: block;
          background: #09101d;
        }

        .status-layer {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 14px;
          padding: 28px;
          text-align: center;
          color: #e8edf9;
          background:
            linear-gradient(180deg, rgba(9, 14, 28, 0.94), rgba(9, 14, 28, 0.88)),
            radial-gradient(circle at top left, rgba(16, 163, 127, 0.12), transparent 34%);
          z-index: 2;
          transition: opacity 180ms ease;
        }

        .status-layer[hidden] {
          opacity: 0;
          pointer-events: none;
        }

        .status-spinner {
          width: 34px;
          height: 34px;
          border-radius: 999px;
          border: 3px solid rgba(255, 255, 255, 0.16);
          border-top-color: #10a37f;
          animation: spin 850ms linear infinite;
        }

        .status-title {
          font-size: 15px;
          font-weight: 700;
          line-height: 1.4;
        }

        .status-copy {
          font-size: 13px;
          line-height: 1.5;
          color: rgba(232, 237, 249, 0.74);
        }

        .status-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: center;
        }

        .status-button {
          border: none;
          border-radius: 999px;
          padding: 10px 14px;
          background: linear-gradient(135deg, #10a37f, #0f766e);
          color: #ffffff;
          font: inherit;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          box-shadow: 0 12px 24px rgba(16, 163, 127, 0.2);
        }

        .status-button.secondary {
          background: rgba(255, 255, 255, 0.08);
          box-shadow: none;
        }

        .close {
          position: absolute;
          top: 12px;
          right: 12px;
          width: 34px;
          height: 34px;
          border: none;
          border-radius: 999px;
          display: grid;
          place-items: center;
          color: #f5f7fb;
          background: rgba(8, 13, 25, 0.68);
          border: 1px solid rgba(255, 255, 255, 0.08);
          font: inherit;
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          z-index: 3;
          transition:
            transform 180ms ease,
            background 180ms ease;
        }

        .close:hover {
          transform: scale(1.04);
          background: rgba(14, 22, 40, 0.92);
        }

        @keyframes ring {
          0% {
            opacity: 0.5;
            transform: scale(0.92);
          }
          70% {
            opacity: 0;
            transform: scale(1.2);
          }
          100% {
            opacity: 0;
            transform: scale(1.2);
          }
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        @media (max-width: 640px) {
          .widget-shell {
            right: 16px;
            bottom: 16px;
          }

          .launcher {
            width: 56px;
            height: 56px;
          }

          .launcher-badge {
            width: 34px;
            height: 34px;
            font-size: 16px;
          }

          .launcher-label {
            display: none;
          }

          .modal {
            padding: 0;
            align-items: stretch;
            justify-content: stretch;
          }

          .panel {
            width: 100vw;
            height: 100vh;
            border-radius: 0;
            border: none;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .launcher,
          .launcher-label,
          .modal,
          .panel,
          .status-layer,
          .close {
            transition: none;
          }

          .launcher::before,
          .status-spinner {
            animation: none;
          }
        }
      </style>
      <div class="widget-shell">
        <button class="launcher" type="button" aria-label="${buttonLabel}">
          <span class="launcher-badge">V</span>
        </button>
        <div class="launcher-label">${buttonLabel}</div>
        <div class="modal" data-open="false" aria-hidden="true">
          <div class="panel" role="dialog" aria-modal="true" aria-label="Vonza assistant">
            <button class="close" type="button" aria-label="Close">&times;</button>
            <div class="status-layer">
              <div class="status-spinner"></div>
              <div class="status-title">Loading assistant</div>
              <div class="status-copy">The widget is connecting to Vonza.</div>
              <div class="status-actions" hidden>
                <button class="status-button" type="button" data-action="retry">Retry</button>
                <button class="status-button secondary" type="button" data-action="close">Close</button>
              </div>
            </div>
            <iframe class="frame" title="Vonza Assistant" referrerpolicy="strict-origin-when-cross-origin"></iframe>
          </div>
        </div>
      </div>
    `;
  }

  function createWidget() {
    const currentScript = resolveCurrentScript();
    const config = getConfig(currentScript);
    const logger = createLogger(config.debug);
    const widgetUrl = buildWidgetUrl(
      config.baseUrl,
      config.businessId,
      config.websiteUrl
    );

    if (!config.businessId && !config.websiteUrl) {
      logger.warn(
        "No business identifier was provided. Pass data-business-id or data-website-url on the script tag."
      );
    }

    logger.log("Initializing", {
      baseUrl: config.baseUrl,
      businessId: config.businessId || null,
      websiteUrl: config.websiteUrl || null,
      widgetUrl: widgetUrl.toString(),
    });

    const host = document.createElement("div");
    host.id = ROOT_ID;
    document.body.appendChild(host);
    window[GLOBAL_FLAG] = true;

    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = createTemplate(config.buttonLabel);

    const launcher = shadowRoot.querySelector(".launcher");
    const modal = shadowRoot.querySelector(".modal");
    const panel = shadowRoot.querySelector(".panel");
    const closeButton = shadowRoot.querySelector(".close");
    const iframe = shadowRoot.querySelector(".frame");
    const statusLayer = shadowRoot.querySelector(".status-layer");
    const statusTitle = shadowRoot.querySelector(".status-title");
    const statusCopy = shadowRoot.querySelector(".status-copy");
    const statusActions = shadowRoot.querySelector(".status-actions");
    const retryButton = shadowRoot.querySelector('[data-action="retry"]');
    const fallbackCloseButton = shadowRoot.querySelector('[data-action="close"]');

    let hasLoadedFrame = false;
    let loadTimer = null;
    let previousBodyOverflow = "";
    let previousHtmlOverflow = "";

    function showLoadingState() {
      statusLayer.hidden = false;
      statusActions.hidden = true;
      statusTitle.textContent = "Loading assistant";
      statusCopy.textContent = "The widget is connecting to Vonza.";
    }

    function showErrorState() {
      statusLayer.hidden = false;
      statusActions.hidden = false;
      statusTitle.textContent = "Assistant unavailable";
      statusCopy.textContent =
        "The widget could not load right now. Please try again in a moment.";
      logger.error("Widget iframe did not finish loading in time.");
    }

    function hideStatusLayer() {
      statusLayer.hidden = true;
    }

    function clearLoadTimer() {
      if (loadTimer) {
        window.clearTimeout(loadTimer);
        loadTimer = null;
      }
    }

    function startLoadTimer() {
      clearLoadTimer();
      loadTimer = window.setTimeout(showErrorState, 12000);
    }

    function loadIframe(forceReload = false) {
      if (forceReload || !iframe.src) {
        const nextUrl = new URL(widgetUrl.toString());

        if (forceReload) {
          nextUrl.searchParams.set("_ts", String(Date.now()));
        }

        iframe.src = nextUrl.toString();
        logger.log("Loading iframe", iframe.src);
      }

      showLoadingState();
      startLoadTimer();
    }

    function openModal() {
      modal.setAttribute("data-open", "true");
      modal.setAttribute("aria-hidden", "false");
      previousBodyOverflow = document.body.style.overflow;
      previousHtmlOverflow = document.documentElement.style.overflow;
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";

      if (!hasLoadedFrame) {
        loadIframe(false);
      }

      logger.log("Opened widget");
    }

    function closeModal() {
      modal.setAttribute("data-open", "false");
      modal.setAttribute("aria-hidden", "true");
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      clearLoadTimer();
      logger.log("Closed widget");
    }

    launcher.addEventListener("click", openModal);
    closeButton.addEventListener("click", closeModal);
    fallbackCloseButton.addEventListener("click", closeModal);
    retryButton.addEventListener("click", () => {
      logger.log("Retrying widget load");
      hasLoadedFrame = false;
      loadIframe(true);
    });

    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        closeModal();
      }
    });

    iframe.addEventListener("load", () => {
      clearLoadTimer();
      hasLoadedFrame = true;
      hideStatusLayer();
      logger.log("Iframe loaded successfully");
    });

    iframe.addEventListener("error", () => {
      clearLoadTimer();
      showErrorState();
      logger.error("Iframe failed to load.");
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeModal();
      }
    });

    panel.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createWidget, { once: true });
  } else {
    createWidget();
  }
})();

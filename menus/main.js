// Core/Infrastructure
import"./anon-auth.js";
import"./median-guard.js";
import"./theme.js";
import"./runtime-ext.js";
import"./text-render.js";
import"./cloud-sync.js";
import"./cache.js";
import"./force-update.js";
import"./ui-feedback.js";
import"./notification-manager.js";
import"./device-session.js";
import"./auth.js";

// UI Components
import"./modal-backbutton.js";
import"./bottom-nav.js";
import"./search-overlay.js";
import"./loaders.js";
import"./progress-rings.js";

// Screens
import"./guest-dashboard.js";
import"./gate-screen.js";
import"./picker-screen.js";
import"./home-screen.js";
import"./progress-page.js";
import "./resources.js";

// Learning Features
import"./quiz-engine.js";
import"./learn-mode.js";
import"./exam-cards.js";
import"./ask-ai.js";
import"./submit-summary.js";
import"./class-chat.js";

// Onboarding & Boot
import"./onboarding-tour.js";
import"./lock.js";
import"./scroll-guard.js";
import"./boot.js";

// Deferred: not needed for first paint. Loaded when the browser is idle (and instantly on first touch/keypress),
// straight from the service-worker cache after the first visit.
const loadDeferred = () => { import("./buy-modal.js"); import("./quiz-live.js"); };
let deferredStarted = false;
const startDeferred = () => { if (deferredStarted) return; deferredStarted = true; loadDeferred(); };
const whenIdle = () => ("requestIdleCallback" in window) ? requestIdleCallback(startDeferred, { timeout: 2500 }) : setTimeout(startDeferred, 1500);
if (document.readyState === "complete") whenIdle(); else window.addEventListener("load", whenIdle, { once: true });
["pointerdown", "keydown"].forEach(ev => window.addEventListener(ev, startDeferred, { once: true, passive: true }));

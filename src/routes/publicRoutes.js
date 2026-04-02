import express from "express";
import path from "path";
import {
  getPublicAppUrl,
  getSupabaseAnonKey,
  getSupabasePublicUrl,
  isLocalDevBillingRequestAllowed,
} from "../config/env.js";

const SETUP_DOCTOR_KEYS = [
  "PUBLIC_APP_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "ADMIN_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_ID",
  "STRIPE_WEBHOOK_SECRET",
];

export function createPublicRouter({ rootDir }) {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.sendFile(path.join(rootDir, "frontend", "index.html"));
  });

  router.get("/widget", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.sendFile(path.join(rootDir, "frontend", "widget.html"));
  });

  router.get("/embed.js", (_req, res) => {
    res.type("application/javascript");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(path.join(rootDir, "embed.js"));
  });

  router.get("/embed-lite.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(path.join(rootDir, "embed-lite.js"));
  });

  router.get("/generator", (_req, res) => {
    res.redirect("/dashboard");
  });

  router.get("/dashboard", (_req, res) => {
    res.sendFile(path.join(rootDir, "dashboard.html"));
  });

  router.get("/public-config.js", (req, res) => {
    res.type("application/javascript");
    res.send(`
window.VONZA_PUBLIC_APP_URL = ${JSON.stringify(getPublicAppUrl())};
window.VONZA_SUPABASE_URL = ${JSON.stringify(getSupabasePublicUrl())};
window.VONZA_SUPABASE_ANON_KEY = ${JSON.stringify(getSupabaseAnonKey())};
window.VONZA_DEV_FAKE_BILLING = ${JSON.stringify(isLocalDevBillingRequestAllowed(req))};
`.trim());
  });

  router.get("/setup-doctor", (req, res) => {
    if (!isLocalDevBillingRequestAllowed(req)) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const checks = SETUP_DOCTOR_KEYS.map((key) => ({
      key,
      present: Boolean(String(process.env[key] || "").trim()),
    }));

    res.json({
      ok: checks.every((check) => check.present),
      dev_fake_billing: true,
      checks,
    });
  });

  router.get("/supabase-auth.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(
      path.join(rootDir, "node_modules", "@supabase", "supabase-js", "dist", "umd", "supabase.js")
    );
  });

  router.get("/admin", (req, res) => {
    const configuredToken = process.env.ADMIN_TOKEN;
    const providedToken = req.query.token;

    if (!configuredToken || !providedToken || providedToken !== configuredToken) {
      res.status(403).send("Forbidden");
      return;
    }

    res.sendFile(path.join(rootDir, "admin.html"));
  });

  router.get("/manifest.json", (_req, res) => {
    res.sendFile(path.join(rootDir, "manifest.json"));
  });

  router.get("/service-worker.js", (_req, res) => {
    res.sendFile(path.join(rootDir, "service-worker.js"));
  });

  router.get("/icon-192.svg", (_req, res) => {
    res.sendFile(path.join(rootDir, "icon-192.svg"));
  });

  router.get("/icon-512.svg", (_req, res) => {
    res.sendFile(path.join(rootDir, "icon-512.svg"));
  });

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  return router;
}

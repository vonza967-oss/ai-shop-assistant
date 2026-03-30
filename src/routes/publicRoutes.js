import express from "express";
import path from "path";
import { getPublicAppUrl } from "../config/env.js";

export function createPublicRouter({ rootDir }) {
  const router = express.Router();

  router.get("/widget", (_req, res) => {
    res.sendFile(path.join(rootDir, "frontend", "index.html"));
  });

  router.get("/embed.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(rootDir, "embed.js"));
  });

  router.get("/embed-lite.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.sendFile(path.join(rootDir, "embed-lite.js"));
  });

  router.get("/generator", (_req, res) => {
    res.redirect("/dashboard");
  });

  router.get("/dashboard", (_req, res) => {
    res.sendFile(path.join(rootDir, "dashboard.html"));
  });

  router.get("/public-config.js", (_req, res) => {
    res.type("application/javascript");
    res.send(`window.VONZA_PUBLIC_APP_URL = ${JSON.stringify(getPublicAppUrl())};`);
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

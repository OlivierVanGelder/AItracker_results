import "dotenv/config";
import fs from "fs";
import path from "path";
import { chromium } from "@playwright/test";
import { uploadFile } from "./upload.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function writeDebugArtifacts(page, extra = {}) {
  const debugDir = path.resolve("debug");
  ensureDir(debugDir);

  const ts = new Date().toISOString().replace(/[:.]/g, "_");
  const screenshotPath = path.join(debugDir, `fail-${ts}.png`);
  const htmlPath = path.join(debugDir, `fail-${ts}.html`);
  const jsonPath = path.join(debugDir, `fail-${ts}.json`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  fs.writeFileSync(htmlPath, html, "utf8");

  fs.writeFileSync(jsonPath, JSON.stringify(extra, null, 2), "utf8");

  console.log("Debug artifacts saved:", screenshotPath, htmlPath, jsonPath);
}

function filenameFromContentDisposition(cd) {
  if (!cd) return null;

  const m1 = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (m1 && m1[1]) {
    try {
      return decodeURIComponent(m1[1].trim().replace(/(^"|"$)/g, ""));
    } catch {
      return m1[1].trim().replace(/(^"|"$)/g, "");
    }
  }

  const m2 = cd.match(/filename\s*=\s*("?)([^";]+)\1/i);
  if (m2 && m2[2]) return m2[2].trim();

  return null;
}

function extFromContentType(ct, preferredFormat) {
  const t = (ct || "").toLowerCase();
  if (t.includes("text/csv")) return "csv";
  if (t.includes("spreadsheetml")) return "xlsx";
  if (t.includes("application/vnd.ms-excel")) return "xls";
  if (preferredFormat === "CSV") return "csv";
  return "xlsx";
}

function looksLikeExportUrl(url) {
  const u = (url || "").toLowerCase();
  return u.includes("export") || u.includes("download") || u.includes("file");
}

function pickSafeHeaders(allHeaders) {
  const h = {};
  const allow = new Set([
    "accept",
    "accept-language",
    "content-type",
    "x-requested-with",
    "origin",
    "referer"
  ]);

  for (const [k, v] of Object.entries(allHeaders || {})) {
    const key = k.toLowerCase();
    if (allow.has(key)) h[key] = v;
  }
  return h;
}

async function fetchLikeBrowser(context, req, timeoutMs) {
  const url = req.url();
  const method = req.method();
  const headersAll = await req.allHeaders().catch(() => ({}));
  const headers = pickSafeHeaders(headersAll);

  const postDataBuffer = req.postDataBuffer ? req.postDataBuffer() : null;

  const res = await context.request.fetch(url, {
    method,
    headers,
    data: postDataBuffer || undefined,
    timeout: timeoutMs,
    maxRedirects: 10
  });

  const resHeaders = res.headers();
  const status = res.status();
  const ok = res.ok();

  let buffer = null;
  let text = null;

  try {
    buffer = await res.body();
  } catch {
    buffer = null;
  }

  if (!buffer || buffer.length === 0) {
    try {
      text = await res.text();
    } catch {
      text = null;
    }
  }

  return { ok, status, resHeaders, buffer, text, url, method };
}

function findDownloadUrlInJsonText(txt) {
  if (!txt) return null;

  try {
    const j = JSON.parse(txt);

    const candidates = [
      j.download_url,
      j.downloadUrl,
      j.file_url,
      j.fileUrl,
      j.url,
      j.result?.url,
      j.data?.url,
      j.data?.download_url,
      j.data?.downloadUrl
    ].filter(Boolean);

    const first = candidates.find((x) => typeof x === "string" && x.startsWith("http"));
    return first || null;
  } catch {
    return null;
  }
}

async function main() {
  const guestUrl = requireEnv("SE_RANKING_GUEST_URL");
  const webhookUrl = requireEnv("WEBHOOK_URL");

  const exportTimeoutMs = Number(process.env.EXPORT_TIMEOUT_MS || "240000");
  const preferredFormat = (process.env.EXPORT_FORMAT || "CSV").toUpperCase();

  const downloadsDir = path.resolve("downloads");
  ensureDir(downloadsDir);

  const debugNetwork = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 }
  });

  const page = await context.newPage();

  page.on("console", (msg) => {
    console.log(`[browser ${msg.type()}] ${msg.text()}`);
  });

  page.on("pageerror", (err) => {
    console.log("[pageerror]", err?.message || String(err));
  });

  page.on("request", (req) => {
    const url = req.url();
    if (looksLikeExportUrl(url)) {
      debugNetwork.push({
        type: "request",
        url,
        method: req.method(),
        ts: new Date().toISOString()
      });
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (!looksLikeExportUrl(url)) return;

    const headers = await res.allHeaders().catch(() => ({}));
    debugNetwork.push({
      type: "response",
      url,
      status: res.status(),
      headers: {
        "content-type": headers["content-type"] || headers["Content-Type"],
        "content-disposition": headers["content-disposition"] || headers["Content-Disposition"]
      },
      ts: new Date().toISOString()
    });
  });

  try {
    await page.goto(guestUrl, { waitUntil: "domcontentloaded", timeout: exportTimeoutMs });
    await page.waitForTimeout(1500);

    // 1) Bovenste export knop: file_upload icon
    const topExportBtn = page
      .locator("button:visible")
      .filter({ has: page.locator("i.material-icons:has-text('file_upload')") })
      .first();

    await topExportBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });
    await topExportBtn.click();

    // 2) Popup zichtbaar
    const formatRoot = page.locator(".export-format-buttons").first();
    await formatRoot.waitFor({ state: "visible", timeout: exportTimeoutMs });

    const csvLabel = page.locator(".export-format-buttons__btn-label:has-text('CSV(.csv)')").first();
    const xlsxLabel = page.locator(".export-format-buttons__btn-label:has-text('Excel (.xlsx)')").first();

    if (preferredFormat === "CSV") {
      await csvLabel.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await csvLabel.click();
    } else {
      await xlsxLabel.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await xlsxLabel.click();
    }

    // 3) Klik laatste actieknop in popup container
    const popupContainer = formatRoot.locator(
      "xpath=ancestor::*[.//div[contains(@class,'export-format-buttons')] and .//button[contains(@class,'se-button-2')]][1]"
    );
    await popupContainer.waitFor({ state: "visible", timeout: exportTimeoutMs });

    const actionButtons = popupContainer.locator("button.se-button-2:visible");
    const btnCount = await actionButtons.count();
    if (btnCount === 0) throw new Error("Geen actieknoppen gevonden in de export popup.");

    const finalBtn = actionButtons.nth(btnCount - 1);
    await finalBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });

    // 4) Strategie: download event, of export request kopieren en via context.request.fetch uitvoeren
    const downloadWait = context.waitForEvent("download", { timeout: exportTimeoutMs }).catch(() => null);

    const exportRequestWait = page.waitForRequest(
      (req) => looksLikeExportUrl(req.url()) && (req.method() === "POST" || req.method() === "GET"),
      { timeout: exportTimeoutMs }
    ).catch(() => null);

    await finalBtn.click({ timeout: exportTimeoutMs, force: true });

    const maybeDownload = await Promise.race([
      downloadWait.then((d) => ({ kind: "download", value: d })),
      exportRequestWait.then((r) => ({ kind: "request", value: r })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "none", value: null }), exportTimeoutMs))
    ]);

    if (maybeDownload.kind === "download" && maybeDownload.value) {
      const download = maybeDownload.value;
      const suggestedName =
        download.suggestedFilename() || `export.${preferredFormat === "CSV" ? "csv" : "xlsx"}`;
      const filePath = path.join(downloadsDir, suggestedName);

      await download.saveAs(filePath);

      const result = await uploadFile({
        webhookUrl,
        filePath,
        extraFields: {
          source: "se-ranking-ai-search-guest-export",
          filename: suggestedName,
          format: preferredFormat,
          method: "download-event"
        }
      });

      console.log("Export downloaded:", filePath);
      console.log("Webhook response:", result || "(empty)");
      return;
    }

    if (maybeDownload.kind !== "request" || !maybeDownload.value) {
      throw new Error("Geen download event en geen export request gezien na export klik.");
    }

    const exportReq = maybeDownload.value;

    // 5) Voer dezelfde export call nogmaals uit via API request context
    const fetched = await fetchLikeBrowser(context, exportReq, exportTimeoutMs);

    const ct = fetched.resHeaders["content-type"] || fetched.resHeaders["Content-Type"];
    const cd = fetched.resHeaders["content-disposition"] || fetched.resHeaders["Content-Disposition"];

    const isAttachment = cd && /attachment/i.test(cd);
    const looksLikeFile =
      (ct || "").toLowerCase().includes("text/csv") ||
      (ct || "").toLowerCase().includes("spreadsheetml") ||
      (ct || "").toLowerCase().includes("application/vnd.ms-excel");

    if (fetched.ok && (isAttachment || looksLikeFile) && fetched.buffer && fetched.buffer.length > 0) {
      const ext = extFromContentType(ct, preferredFormat);
      const nameFromHeader = filenameFromContentDisposition(cd);
      const suggestedName = nameFromHeader || `export.${ext}`;
      const filePath = path.join(downloadsDir, suggestedName);

      fs.writeFileSync(filePath, fetched.buffer);

      const result = await uploadFile({
        webhookUrl,
        filePath,
        extraFields: {
          source: "se-ranking-ai-search-guest-export",
          filename: suggestedName,
          format: preferredFormat,
          method: "request-fetch-bytes"
        }
      });

      console.log("Export saved:", filePath);
      console.log("Webhook response:", result || "(empty)");
      return;
    }

    // 6) Als het JSON teruggeeft met een download URL, haal die alsnog op
    const downloadUrlFromJson = findDownloadUrlInJsonText(fetched.text);

    if (fetched.ok && downloadUrlFromJson) {
      const res2 = await context.request.get(downloadUrlFromJson, { timeout: exportTimeoutMs, maxRedirects: 10 });
      if (!res2.ok()) {
        throw new Error(`Download URL ophalen faalde: ${res2.status()} ${res2.statusText()}`);
      }

      const h2 = res2.headers();
      const ct2 = h2["content-type"] || h2["Content-Type"];
      const cd2 = h2["content-disposition"] || h2["Content-Disposition"];

      const ext2 = extFromContentType(ct2, preferredFormat);
      const name2 = filenameFromContentDisposition(cd2) || `export.${ext2}`;
      const filePath = path.join(downloadsDir, name2);

      const buf2 = await res2.body();
      fs.writeFileSync(filePath, buf2);

      const result = await uploadFile({
        webhookUrl,
        filePath,
        extraFields: {
          source: "se-ranking-ai-search-guest-export",
          filename: name2,
          format: preferredFormat,
          method: "json-to-download-url"
        }
      });

      console.log("Export saved via download URL:", filePath);
      console.log("Webhook response:", result || "(empty)");
      return;
    }

    // 7) Niks bruikbaars, dump meer info in debug
    throw new Error(
      `Export request uitgevoerd, maar geen bestand ontvangen. status=${fetched.status} ct=${ct || ""} cd=${cd || ""}`
    );
  } catch (err) {
    console.error(err);
    await writeDebugArtifacts(page, {
      error: String(err?.message || err),
      network: debugNetwork.slice(-80)
    });
    throw err;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

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

function extFromContentType(ct, fallback = "csv") {
  const t = (ct || "").toLowerCase();
  if (t.includes("text/csv")) return "csv";
  if (t.includes("spreadsheetml")) return "xlsx";
  if (t.includes("application/vnd.ms-excel")) return "xls";
  return fallback;
}

function looksLikeFileResponse(headers) {
  const ct = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
  const cd = (headers["content-disposition"] || headers["Content-Disposition"] || "").toLowerCase();

  const isAttachment = cd.includes("attachment");
  const isCsv = ct.includes("text/csv");
  const isXlsx = ct.includes("spreadsheetml") || ct.includes("application/vnd.ms-excel");

  // let op: image/gif is hier juist NIET goed
  const isGif = ct.includes("image/gif");

  if (isGif) return { ok: false, reason: "gif" };
  if (isAttachment || isCsv || isXlsx) return { ok: true, ct, cd };
  return { ok: false, reason: "not-file" };
}

async function main() {
  const guestUrl = requireEnv("SE_RANKING_GUEST_URL");
  const webhookUrl = requireEnv("WEBHOOK_URL");

  const exportTimeoutMs = Number(process.env.EXPORT_TIMEOUT_MS || "240000");
  const preferredFormat = (process.env.EXPORT_FORMAT || "CSV").toUpperCase();

  const downloadsDir = path.resolve("downloads");
  ensureDir(downloadsDir);

  const networkLog = [];
  let fileCandidate = null;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 }
  });

  const page = await context.newPage();

  page.on("console", (msg) => console.log(`[browser ${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => console.log("[pageerror]", err?.message || String(err)));

  page.on("request", (req) => {
    const url = req.url();
    if (
      url.includes("export") ||
      url.includes("download") ||
      url.includes("llm_rankings.rankings.export") ||
      url.endsWith(".csv") ||
      url.endsWith(".xlsx")
    ) {
      networkLog.push({
        type: "request",
        url,
        method: req.method(),
        ts: new Date().toISOString()
      });
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    const status = res.status();
    const headers = await res.allHeaders().catch(() => ({}));

    const interesting =
      url.includes("export") ||
      url.includes("download") ||
      url.includes("llm_rankings.rankings.export") ||
      url.endsWith(".csv") ||
      url.endsWith(".xlsx");

    if (interesting) {
      networkLog.push({
        type: "response",
        url,
        status,
        headers: {
          "content-type": headers["content-type"] || headers["Content-Type"] || "",
          "content-disposition": headers["content-disposition"] || headers["Content-Disposition"] || "",
          location: headers["location"] || headers["Location"] || ""
        },
        ts: new Date().toISOString()
      });
    }

    // Detecteer het echte bestand
    const verdict = looksLikeFileResponse(headers);
    if (!verdict.ok) return;

    // We pakken de eerste geldige file response en bewaren hem
    if (!fileCandidate) {
      fileCandidate = { res, headers, url, status };
    }
  });

  try {
    await page.goto(guestUrl, { waitUntil: "domcontentloaded", timeout: exportTimeoutMs });
    await page.waitForTimeout(1500);

    // Open export popup via file_upload icon
    const topExportBtn = page
      .locator("button:visible")
      .filter({ has: page.locator("i.material-icons:has-text('file_upload')") })
      .first();

    await topExportBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });
    await topExportBtn.click();

    const formatRoot = page.locator(".export-format-buttons").first();
    await formatRoot.waitFor({ state: "visible", timeout: exportTimeoutMs });

    // Kies formaat
    const csvLabel = page.locator(".export-format-buttons__btn-label:has-text('CSV(.csv)')").first();
    const xlsxLabel = page.locator(".export-format-buttons__btn-label:has-text('Excel (.xlsx)')").first();

    if (preferredFormat === "CSV") {
      await csvLabel.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await csvLabel.click();
    } else {
      await xlsxLabel.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await xlsxLabel.click();
    }

    // Vind popup container en klik laatste export knop
    const popupContainer = formatRoot.locator(
      "xpath=ancestor::*[.//div[contains(@class,'export-format-buttons')] and .//button[contains(@class,'se-button-2')]][1]"
    );
    await popupContainer.waitFor({ state: "visible", timeout: exportTimeoutMs });

    const actionButtons = popupContainer.locator("button.se-button-2:visible");
    const btnCount = await actionButtons.count();
    if (btnCount === 0) throw new Error("Geen actieknoppen gevonden in de export popup.");

    const finalBtn = actionButtons.nth(btnCount - 1);
    await finalBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });

    // Wacht op download event, of een file response die we via response listener vinden
    const downloadWait = context.waitForEvent("download", { timeout: exportTimeoutMs }).catch(() => null);

    await finalBtn.click({ timeout: exportTimeoutMs, force: true });
    // Na de laatste klik: wacht op "export bezig" popup en dat hij weer verdwijnt
    const exportingDialog = page.locator("text=Exporteren van bestand is bezig").first();

    // soms komt hij niet altijd, dus: try wachten op zichtbaar, maar fail niet hard
    await exportingDialog.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});

    // nu wachten tot hij weg is (export klaar)
    await exportingDialog.waitFor({ state: "hidden", timeout: exportTimeoutMs }).catch(() => {
    // Als hij blijft hangen, maken we debug, maar we gooien nog niet direct
    });

    // Extra buffer voor het moment dat de download pas ná het sluiten start
    await page.waitForTimeout(2000);


    // Poll op fileCandidate, omdat responses async binnenkomen
    const started = Date.now();
    while (!fileCandidate && Date.now() - started < exportTimeoutMs) {
      const dl = await Promise.race([
        downloadWait,
        new Promise((r) => setTimeout(() => r(null), 500))
      ]);

      if (dl) {
        const suggestedName =
          dl.suggestedFilename() || `export.${preferredFormat === "CSV" ? "csv" : "xlsx"}`;
        const filePath = path.join(downloadsDir, suggestedName);
        await dl.saveAs(filePath);

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
    }

    // Als we een response met bestand headers hebben gevonden, body opslaan
    if (fileCandidate) {
      const { res, headers } = fileCandidate;

      const ct = headers["content-type"] || headers["Content-Type"] || "";
      const cd = headers["content-disposition"] || headers["Content-Disposition"] || "";

      const ext = extFromContentType(ct, preferredFormat === "CSV" ? "csv" : "xlsx");
      const nameFromHeader = filenameFromContentDisposition(cd);
      const suggestedName = nameFromHeader || `export.${ext}`;
      const filePath = path.join(downloadsDir, suggestedName);

      const buf = await res.body().catch(() => null);
      if (!buf || buf.length === 0) {
        throw new Error(`Bestand response gevonden maar body is leeg. ct=${ct} cd=${cd}`);
      }

      fs.writeFileSync(filePath, buf);

      const result = await uploadFile({
        webhookUrl,
        filePath,
        extraFields: {
          source: "se-ranking-ai-search-guest-export",
          filename: suggestedName,
          format: preferredFormat,
          method: "file-response-body"
        }
      });

      console.log("Export saved from response:", filePath);
      console.log("Webhook response:", result || "(empty)");
      return;
    }

    // Geen download event, geen file response
    throw new Error("Export geklikt, maar geen download event en geen file response gezien.");
  } catch (err) {
    console.error(err);
    await writeDebugArtifacts(page, {
      error: String(err?.message || err),
      network: networkLog.slice(-120)
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

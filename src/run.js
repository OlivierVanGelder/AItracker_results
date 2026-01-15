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

async function writeDebugArtifacts(page) {
  const debugDir = path.resolve("debug");
  ensureDir(debugDir);

  const ts = new Date().toISOString().replace(/[:.]/g, "_");
  const screenshotPath = path.join(debugDir, `fail-${ts}.png`);
  const htmlPath = path.join(debugDir, `fail-${ts}.html`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  fs.writeFileSync(htmlPath, html, "utf8");

  console.log("Debug artifacts saved:", screenshotPath, htmlPath);
}

function filenameFromContentDisposition(cd) {
  if (!cd) return null;

  // filename*=UTF-8''... of filename="..."
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
  if (t.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) return "xlsx";
  if (t.includes("application/vnd.ms-excel")) return "xls";
  if (preferredFormat === "CSV") return "csv";
  return "xlsx";
}

async function main() {
  const guestUrl = requireEnv("SE_RANKING_GUEST_URL");
  const webhookUrl = requireEnv("WEBHOOK_URL");

  const exportTimeoutMs = Number(process.env.EXPORT_TIMEOUT_MS || "180000");
  const preferredFormat = (process.env.EXPORT_FORMAT || "CSV").toUpperCase(); // CSV of XLSX

  const downloadsDir = path.resolve("downloads");
  ensureDir(downloadsDir);

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

  try {
    await page.goto(guestUrl, { waitUntil: "domcontentloaded", timeout: exportTimeoutMs });
    await page.waitForTimeout(1500);

    // 1) Eerste export knop: button met material icon file_upload
    const topExportBtn = page
      .locator("button:visible")
      .filter({ has: page.locator("i.material-icons:has-text('file_upload')") })
      .first();

    await topExportBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });
    await topExportBtn.click();

    // 2) Export popup: format sectie
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

    // 3) Vind popup container met footerknoppen en klik de primaire knop (laatste se-button-2)
    const popupContainer = formatRoot.locator(
      "xpath=ancestor::*[.//div[contains(@class,'export-format-buttons')] and .//button[contains(@class,'se-button-2')]][1]"
    );

    await popupContainer.waitFor({ state: "visible", timeout: exportTimeoutMs });

    const actionButtons = popupContainer.locator("button.se-button-2:visible");
    const btnCount = await actionButtons.count();

    if (btnCount === 0) {
      throw new Error("Geen actieknoppen gevonden in de export popup container.");
    }

    const finalBtn = actionButtons.nth(btnCount - 1);
    await finalBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });

    // 4) Wacht op download event of op een response die een attachment lijkt
    // Download event (klassiek)
    const downloadWait = context.waitForEvent("download", { timeout: exportTimeoutMs }).catch(() => null);

    // Attachment response (API download)
    const responseWait = page
      .waitForResponse(
        async (res) => {
          try {
            const headers = await res.allHeaders();
            const cd = headers["content-disposition"] || headers["Content-Disposition"];
            const ct = headers["content-type"] || headers["Content-Type"];

            if (cd && /attachment/i.test(cd)) return true;

            // Soms geen attachment header maar wel een excel/csv content type op export endpoint
            const url = res.url().toLowerCase();
            const looksLikeExportUrl =
              url.includes("export") || url.includes("download") || url.includes("file");

            const looksLikeFileType =
              (ct || "").toLowerCase().includes("text/csv") ||
              (ct || "").toLowerCase().includes("spreadsheetml") ||
              (ct || "").toLowerCase().includes("application/vnd.ms-excel");

            if (looksLikeExportUrl && looksLikeFileType) return true;

            return false;
          } catch {
            return false;
          }
        },
        { timeout: exportTimeoutMs }
      )
      .catch(() => null);

    // Klik export (force omdat er soms overlays zijn)
    await finalBtn.click({ timeout: exportTimeoutMs, force: true });

    // Race: download of response
    const winner = await Promise.race([
      downloadWait.then((d) => ({ kind: "download", value: d })),
      responseWait.then((r) => ({ kind: "response", value: r })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "none", value: null }), exportTimeoutMs))
    ]);

    if (winner.kind === "download" && winner.value) {
      const download = winner.value;
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

    if (winner.kind === "response" && winner.value) {
      const res = winner.value;
      const headers = await res.allHeaders();
      const cd = headers["content-disposition"] || headers["Content-Disposition"];
      const ct = headers["content-type"] || headers["Content-Type"];

      const ext = extFromContentType(ct, preferredFormat);
      const nameFromHeader = filenameFromContentDisposition(cd);
      const suggestedName = nameFromHeader || `export.${ext}`;

      const body = await res.body();
      if (!body || body.length === 0) {
        throw new Error("Export response ontvangen, maar body is leeg.");
      }

      const filePath = path.join(downloadsDir, suggestedName);
      fs.writeFileSync(filePath, body);

      const result = await uploadFile({
        webhookUrl,
        filePath,
        extraFields: {
          source: "se-ranking-ai-search-guest-export",
          filename: suggestedName,
          format: preferredFormat,
          method: "attachment-response"
        }
      });

      console.log("Export saved from response:", filePath);
      console.log("Webhook response:", result || "(empty)");
      return;
    }

    throw new Error("Geen download event en geen attachment response gezien na export klik.");
  } catch (err) {
    console.error(err);
    await writeDebugArtifacts(page);
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

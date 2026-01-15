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

    // 1) Eerste knop: export dropdown met file_upload icoon
    // We zoeken een zichtbare button die een material icon "file_upload" bevat
    const topExportBtn = page
      .locator("button:visible")
      .filter({
        has: page.locator("i.material-icons:has-text('file_upload')")
      })
      .first();

    await topExportBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });
    await topExportBtn.click();

    // 2) Popup moet nu export format buttons tonen
    const csvLabel = page.locator(".export-format-buttons__btn-label:has-text('CSV(.csv)')").first();
    const xlsxLabel = page.locator(".export-format-buttons__btn-label:has-text('Excel (.xlsx)')").first();

    if (preferredFormat === "CSV") {
      await csvLabel.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await csvLabel.click();
    } else {
      await xlsxLabel.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await xlsxLabel.click();
    }

    // 3) Laatste exportknop in de popup
    // We bepalen de popup container via de export format buttons sectie
    const popup = page.locator(".export-format-buttons").first();
    await popup.waitFor({ state: "visible", timeout: exportTimeoutMs });

    // Zoek binnen dezelfde popup context alle zichtbare buttons met "Exporteren"
    // Pak de laatste, dat is doorgaans de knop die de download start
    const exportButtonsInPopup = popup
      .locator("xpath=ancestor::*[self::div or self::section][1]")
      .locator("button:visible")
      .filter({ has: page.locator(".se-button-2__text:has-text('Exporteren')") });

    await exportButtonsInPopup.first().waitFor({ state: "visible", timeout: exportTimeoutMs });

    const finalExportBtn = exportButtonsInPopup.last();

    // Download watcher en klik altijd samen afhandelen
    const downloadWait = context.waitForEvent("download", { timeout: exportTimeoutMs });
    const clickWait = finalExportBtn.click({ timeout: exportTimeoutMs, force: true });

    const [downloadResult, clickResult] = await Promise.allSettled([downloadWait, clickWait]);

    if (clickResult.status === "rejected") {
      await downloadWait.catch(() => {});
      throw clickResult.reason;
    }

    if (downloadResult.status === "rejected") {
      throw downloadResult.reason;
    }

    const download = downloadResult.value;

    const ext = preferredFormat === "CSV" ? "csv" : "xlsx";
    const suggestedName = download.suggestedFilename() || `export.${ext}`;
    const filePath = path.join(downloadsDir, suggestedName);

    await download.saveAs(filePath);

    const result = await uploadFile({
      webhookUrl,
      filePath,
      extraFields: {
        source: "se-ranking-ai-search-guest-export",
        filename: suggestedName,
        format: preferredFormat
      }
    });

    console.log("Export downloaded:", filePath);
    console.log("Webhook response:", result || "(empty)");
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

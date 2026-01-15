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

    // 1) Bovenste exportknop: herkenbaar aan het material icon "file_upload"
    const topExportBtn = page
      .locator("button:visible")
      .filter({ has: page.locator("i.material-icons:has-text('file_upload')") })
      .first();

    await topExportBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });
    await topExportBtn.click();

    // 2) Wacht tot export popup aanwezig is: export format buttons
    const formatRoot = page.locator(".export-format-buttons").first();
    await formatRoot.waitFor({ state: "visible", timeout: exportTimeoutMs });

    const csvBtn = page.locator(".export-format-buttons__btn-label:has-text('CSV(.csv)')").first();
    const xlsxBtn = page.locator(".export-format-buttons__btn-label:has-text('Excel (.xlsx)')").first();

    if (preferredFormat === "CSV") {
      await csvBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await csvBtn.click();
    } else {
      await xlsxBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await xlsxBtn.click();
    }

    // 3) Vind de popup container die óók de footerknoppen bevat
    // We lopen omhoog vanaf .export-format-buttons tot we een container hebben met minimaal 2 se-button-2 knoppen
    const popupContainer = formatRoot.locator(
      "xpath=ancestor::*[.//div[contains(@class,'export-format-buttons')] and .//button[contains(@class,'se-button-2')]][1]"
    );

    await popupContainer.waitFor({ state: "visible", timeout: exportTimeoutMs });

    // Pak alle zichtbare buttons met class se-button-2 binnen de popup
    const actionButtons = popupContainer.locator("button.se-button-2:visible");

    const btnCount = await actionButtons.count();
    if (btnCount === 0) {
      throw new Error("Geen actieknoppen gevonden in de export popup container.");
    }

    // In vrijwel alle popups is de primaire actie de rechterknop, dus de laatste
    const finalBtn = actionButtons.nth(btnCount - 1);
    await finalBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });

    // Download watcher en klik altijd beide afhandelen
    const downloadWait = context.waitForEvent("download", { timeout: exportTimeoutMs });
    const clickWait = finalBtn.click({ timeout: exportTimeoutMs, force: true });

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

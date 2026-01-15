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

    // 1) Klik de bovenste knop EXPORTEREN om de modal te openen
    const topExportBtn = page.getByRole("button", { name: "EXPORTEREN" }).first();
    await topExportBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });
    await topExportBtn.click();

    // 2) Wacht tot de modal zichtbaar is (niet via ARIA role, maar via zichtbare titeltekst)
    const modalTitle = page.getByText("Exporteren", { exact: true }).first();
    await modalTitle.waitFor({ state: "visible", timeout: exportTimeoutMs });

    // 3) Kies formaat in de modal
    if (preferredFormat === "CSV") {
      const csvCard = page.getByText(/CSV\(\.csv\)/i).first();
      await csvCard.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await csvCard.click();
    } else {
      const xlsxCard = page.getByText(/Excel\s*\(\.xlsx\)/i).first();
      await xlsxCard.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await xlsxCard.click();
    }

    // 4) Vind de tweede EXPORTEREN knop (in de modal)
    const modalExportBtn = page
      .locator("text=Exporteren")
      .first()
      .locator("xpath=following::button[normalize-space()='EXPORTEREN'][1]");

    await modalExportBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });

    // 5) Klik + download watcher altijd beide afhandelen
    const downloadWait = context.waitForEvent("download", { timeout: exportTimeoutMs });
    const clickWait = modalExportBtn.click({ timeout: exportTimeoutMs, force: true });

    const [downloadResult, clickResult] = await Promise.allSettled([downloadWait, clickWait]);

    // Zorg dat er geen "hanging" download promise blijft bestaan
    if (clickResult.status === "rejected") {
      await downloadWait.catch(() => {});
      throw clickResult.reason;
    }

    if (downloadResult.status === "rejected") {
      throw downloadResult.reason;
    }

    const download = downloadResult.value;

    const suggestedName = download.suggestedFilename() || `export.${preferredFormat === "CSV" ? "csv" : "xlsx"}`;
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
    // Sluit altijd netjes af
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

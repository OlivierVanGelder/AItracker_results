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

async function maybeClick(locator, timeoutMs = 1500) {
  try {
    await locator.first().waitFor({ timeout: timeoutMs });
    await locator.first().click();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const guestUrl = requireEnv("SE_RANKING_GUEST_URL");
  const webhookUrl = requireEnv("WEBHOOK_URL");

  const exportButtonText = process.env.EXPORT_BUTTON_TEXT || "EXPORTEREN";
  const exportTimeoutMs = Number(process.env.EXPORT_TIMEOUT_MS || "180000");

  const preferredFormat = (process.env.EXPORT_FORMAT || "CSV").toUpperCase(); // CSV of XLSX
  const downloadsDir = path.resolve("downloads");
  const debugDir = path.resolve("debug");

  ensureDir(downloadsDir);
  ensureDir(debugDir);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  page.on("console", (msg) => {
    const line = `[browser ${msg.type()}] ${msg.text()}`;
    console.log(line);
  });

  page.on("pageerror", (err) => {
    console.log("[pageerror]", err?.message || String(err));
  });

  try {
    await page.goto(guestUrl, { waitUntil: "domcontentloaded", timeout: exportTimeoutMs });

    // Kleine buffer voor async rendering
    await page.waitForTimeout(1500);

    const exportBtn = page.getByRole("button", { name: exportButtonText }).first();
    await exportBtn.waitFor({ timeout: exportTimeoutMs });

    // Luister naar downloads op context, dit pakt ook nieuwe tabs en andere pages mee
    const downloadPromise = context.waitForEvent("download", { timeout: exportTimeoutMs }).catch(() => null);

    // Klik Exporteren
    await exportBtn.click();

    // Soms opent er nu een dropdown of modal met formaten
    // Probeer eerst het gewenste formaat te klikken als het zichtbaar is
    const formatClicked =
      (preferredFormat === "CSV" &&
        (await maybeClick(page.getByRole("menuitem", { name: /csv/i })) ||
          await maybeClick(page.getByRole("button", { name: /csv/i })) ||
          await maybeClick(page.getByText(/csv/i)))) ||
      (preferredFormat === "XLSX" &&
        (await maybeClick(page.getByRole("menuitem", { name: /xls|xlsx/i })) ||
          await maybeClick(page.getByRole("button", { name: /xls|xlsx/i })) ||
          await maybeClick(page.getByText(/xls|xlsx/i))));

    // Soms moet je nog bevestigen met iets als "Export" of "Download"
    // We proberen een paar veelvoorkomende knoppen
    await maybeClick(page.getByRole("button", { name: /download/i }), 1000);
    await maybeClick(page.getByRole("button", { name: /export/i }), 1000);
    await maybeClick(page.getByRole("button", { name: /ok|bevestigen|confirm/i }), 1000);

    // Wacht op download
    let download = await downloadPromise;

    // Fallback: soms verschijnt er pas later een download link of knop
    if (!download) {
      // Geef de UI even tijd om de export te genereren
      await page.waitForTimeout(4000);

      const downloadBtnClicked =
        (await maybeClick(page.getByRole("button", { name: /download/i }), 2000)) ||
        (await maybeClick(page.getByRole("link", { name: /download/i }), 2000)) ||
        (await maybeClick(page.getByText(/download/i), 2000));

      if (downloadBtnClicked) {
        download = await context.waitForEvent("download", { timeout: exportTimeoutMs }).catch(() => null);
      }
    }

    if (!download) {
      // Debug artefacts voor GitHub Actions
      const ts = new Date().toISOString().replace(/[:.]/g, "_");
      const screenshotPath = path.join(debugDir, `no-download-${ts}.png`);
      const htmlPath = path.join(debugDir, `no-download-${ts}.html`);

      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => "");
      fs.writeFileSync(htmlPath, html, "utf8");

      throw new Error(
        `Geen download event gezien. Mogelijk opent export een menu, een tweede stap, of genereert het alleen een link.\nDebug: ${screenshotPath} en ${htmlPath}`
      );
    }

    const suggestedName = download.suggestedFilename();
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
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

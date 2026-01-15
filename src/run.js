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

async function clickFirstVisible(locator, timeoutMs = 5000) {
  await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
  await locator.first().click();
}

async function main() {
  const guestUrl = requireEnv("SE_RANKING_GUEST_URL");
  const webhookUrl = requireEnv("WEBHOOK_URL");

  const exportTimeoutMs = Number(process.env.EXPORT_TIMEOUT_MS || "180000");
  const preferredFormat = (process.env.EXPORT_FORMAT || "CSV").toUpperCase(); // CSV of XLSX

  const downloadsDir = path.resolve("downloads");
  ensureDir(downloadsDir);

  const browser = await chromium.launch({
    headless: true
  });

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

    // 1) Open export popup: klik de exportknop rechtsboven
    // We vertrouwen hier niet op tekst, maar op het feit dat het een button is in de header.
    // Als er meerdere buttons staan, pakken we degene die "export" in attributes of tekst heeft,
    // en vallen we terug op de eerste button in de rechterheader.
    const exportBtnCandidates = page.locator("button").filter({
      has: page.locator("svg, span, i")
    });

    // Eerst proberen: knop met "export" in tekst of aria-label (case insensitive)
    const exportByAttrOrText = page.locator(
      "button[aria-label*='export' i], button:has-text('Export'):has-text('e'), button:has-text('EXPORT')"
    );

    if (await exportByAttrOrText.first().isVisible().catch(() => false)) {
      await exportByAttrOrText.first().click();
    } else {
      // Fallback: jouw UI heeft exportknop rechtsboven, vaak de eerste/ tweede in dat cluster.
      // We pakken de eerste zichtbare button die niet “Voeg prompts toe” is.
      const safeExportBtn = page
        .locator("button")
        .filter({ hasNot: page.getByText(/Voeg prompts toe/i) })
        .first();

      await safeExportBtn.click();
    }

    // 2) Wacht op export popup door te zoeken naar elementen die typisch in die popup zitten:
    // een optie met .csv en/of .xlsx
    const csvOption = page.locator("text=/\\.csv/i").first();
    const xlsxOption = page.locator("text=/\\.xlsx/i").first();

    await Promise.race([
      csvOption.waitFor({ state: "visible", timeout: exportTimeoutMs }).catch(() => {}),
      xlsxOption.waitFor({ state: "visible", timeout: exportTimeoutMs }).catch(() => {})
    ]);

    const csvVisible = await csvOption.isVisible().catch(() => false);
    const xlsxVisible = await xlsxOption.isVisible().catch(() => false);

    if (!csvVisible && !xlsxVisible) {
      throw new Error("Export popup lijkt niet geopend: geen .csv of .xlsx optie gevonden.");
    }

    // 3) Klik formaat
    if (preferredFormat === "CSV") {
      if (!csvVisible) {
        throw new Error("CSV optie niet zichtbaar in export popup.");
      }
      await csvOption.click();
    } else {
      if (!xlsxVisible) {
        throw new Error("XLSX optie niet zichtbaar in export popup.");
      }
      await xlsxOption.click();
    }

    // 4) Klik primaire actieknop in popup (de rechterknop in footer)
    // We pakken knoppen die in de buurt staan van de opties.
    // Vervolgens kiezen we de laatste zichtbare button in dat popup gebied.
    const popupRegion = csvOption.locator("xpath=ancestor::*[self::div or self::section][1]");
    const actionButtons = popupRegion.locator("button");

    await actionButtons.first().waitFor({ state: "visible", timeout: exportTimeoutMs });

    // Vaak staan er 2 knoppen: Annuleren links, Exporteren rechts.
    // Kies de laatste zichtbare button.
    const lastButton = actionButtons.last();

    // 5) Download watcher + click altijd samen afhandelen
    const downloadWait = context.waitForEvent("download", { timeout: exportTimeoutMs });
    const clickWait = lastButton.click({ timeout: exportTimeoutMs, force: true });

    const [downloadResult, clickResult] = await Promise.allSettled([downloadWait, clickWait]);

    if (clickResult.status === "rejected") {
      await downloadWait.catch(() => {});
      throw clickResult.reason;
    }

    if (downloadResult.status === "rejected") {
      throw downloadResult.reason;
    }

    const download = downloadResult.value;
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

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

async function main() {
  const guestUrl = requireEnv("SE_RANKING_GUEST_URL");
  const webhookUrl = requireEnv("WEBHOOK_URL");

  const exportTimeoutMs = Number(process.env.EXPORT_TIMEOUT_MS || "180000");
  const preferredFormat = (process.env.EXPORT_FORMAT || "CSV").toUpperCase(); // CSV of XLSX

  const downloadsDir = path.resolve("downloads");
  const debugDir = path.resolve("debug");
  ensureDir(downloadsDir);
  ensureDir(debugDir);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(guestUrl, { waitUntil: "domcontentloaded", timeout: exportTimeoutMs });
    await page.waitForTimeout(1500);

    // 1) Klik bovenste Exporteren (opent modal)
    await page.getByRole("button", { name: "EXPORTEREN" }).first().click();

    // 2) Wacht op het modal-venster via zichtbare tekst in de UI
    // We zoeken specifiek naar de kop "Exporteren" die in de modal staat.
    const modalTitle = page.getByText("Exporteren", { exact: true }).first();
    await modalTitle.waitFor({ timeout: exportTimeoutMs });

    // 3) Pak een container rondom de modal.
    // We nemen het dichtstbijzijnde element dat de modal inhoud bevat.
    // Dit is een pragmatische aanpak voor UI's zonder goede ARIA roles.
    const modal = modalTitle.locator("xpath=ancestor::*[self::div or self::section][1]");

    // 4) Kies formaat binnen de modal
    if (preferredFormat === "CSV") {
      await page.getByText(/CSV\(/i).first().click();
    } else {
      await page.getByText(/Excel\s*\(\.xlsx\)/i).first().click();
    }

    // 5) Nu wachten op download en klik op de tweede EXPORTEREN knop in de modal footer
    const downloadPromise = context.waitForEvent("download", { timeout: exportTimeoutMs });

    // Let op: er zijn 2 knoppen met "EXPORTEREN". We willen die in de modal.
    // Daarom zoeken we vanaf de titel naar een knop "EXPORTEREN" die NA de titel voorkomt.
    const modalExportBtn = page
      .locator("text=Exporteren")
      .first()
      .locator("xpath=following::button[normalize-space()='EXPORTEREN'][1]");

    await modalExportBtn.click();

    const download = await downloadPromise;

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
  } catch (e) {
    // Debug bij falen
    const ts = new Date().toISOString().replace(/[:.]/g, "_");
    await page.screenshot({ path: path.join(debugDir, `fail-${ts}.png`), fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => "");
    fs.writeFileSync(path.join(debugDir, `fail-${ts}.html`), html, "utf8");
    throw e;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

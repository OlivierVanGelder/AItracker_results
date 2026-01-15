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
  ensureDir(downloadsDir);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(guestUrl, { waitUntil: "domcontentloaded", timeout: exportTimeoutMs });

    // 1) Klik op Exporteren rechtsboven (opent modal)
    const topExportBtn = page.getByRole("button", { name: "EXPORTEREN" }).first();
    await topExportBtn.waitFor({ timeout: exportTimeoutMs });
    await topExportBtn.click();

    // 2) Wacht tot modal zichtbaar is
    const modal = page.getByRole("dialog", { name: "Exporteren" });
    await modal.waitFor({ timeout: exportTimeoutMs });

    // 3) Kies formaat (CSV of XLSX) in modal
    // In jouw screenshot zijn dit "CSV(.csv)" en "Excel (.xlsx)"
    if (preferredFormat === "CSV") {
      await modal.getByText(/CSV/i).first().click();
    } else {
      await modal.getByText(/Excel/i).first().click();
    }

    // 4) Nu pas luisteren naar de download + klik op de tweede Exporteren knop (in modal)
    const downloadPromise = context.waitForEvent("download", { timeout: exportTimeoutMs });

    const modalExportBtn = modal.getByRole("button", { name: "EXPORTEREN" }).first();
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
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

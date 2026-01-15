// src/run.js
// ES module versie (package.json heeft "type": "module")
//
// Env vars:
//   GUEST_URL            = volledige gastenlink naar de rankings pagina
//   WEBHOOK_URL          = webhook waar je het csv bestand heen post (optioneel)
//   DOWNLOAD_DIR         = map voor download (default: ./downloads)
//   HEADLESS             = "true" of "false" (default: true)
//   EXPORT_TIMEOUT_MS    = timeout voor export (default: 240000)
//   DEBUG                = "true" of "false" (default: true)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "_");
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function saveDebugArtifacts(page, debugDir, prefix) {
  try {
    const ts = nowStamp();
    const png = path.join(debugDir, `${prefix}-${ts}.png`);
    const html = path.join(debugDir, `${prefix}-${ts}.html`);
    await page.screenshot({ path: png, fullPage: true });
    const content = await page.content();
    await fs.promises.writeFile(html, content, "utf8");
    console.log("Debug artifacts saved:", png, html);
  } catch (e) {
    console.log("Kon debug artifacts niet opslaan:", e?.message || e);
  }
}

function pickCsvFilenameFromHeaders(headers) {
  const cd = headers["content-disposition"] || headers["Content-Disposition"] || "";
  const m = cd.match(/filename="([^"]+)"/i) || cd.match(/filename=([^;]+)/i);
  if (!m) return null;
  return m[1].replace(/(^"|"$)/g, "").trim();
}

async function postToWebhook(webhookUrl, filePath) {
  const data = await fs.promises.readFile(filePath);
  const filename = path.basename(filePath);

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "x-filename": filename,
    },
    body: data,
  });

  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Webhook error status=${res.status} body=${txt.slice(0, 500)}`);
  }
  console.log("Webhook OK:", res.status);
}

async function main() {
  const GUEST_URL = process.env.SE_RANKING_GUEST_URL;
  if (!GUEST_URL) throw new Error("Zet env var GUEST_URL");

  const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
  const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), "downloads");
  const DEBUG = (process.env.DEBUG || "true").toLowerCase() === "true";
  const HEADLESS = (process.env.HEADLESS || "true").toLowerCase() === "true";
  const EXPORT_TIMEOUT_MS = Number(process.env.EXPORT_TIMEOUT_MS || "240000");

  const debugDir = path.join(process.cwd(), "debug");
  await ensureDir(DOWNLOAD_DIR);
  await ensureDir(debugDir);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu"],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
  });

  const page = await context.newPage();

  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error") console.log("[browser error]", msg.text());
    if (t === "warning") console.log("[browser warning]", msg.text());
  });

  try {
    console.log("Open:", GUEST_URL);
    await page.goto(GUEST_URL, { waitUntil: "domcontentloaded", timeout: 120000 });

    await page.waitForTimeout(1500);

    // 1) Bovenste Exporteren knop (dropdown)
    const topExportBtn = page
      .locator("button:visible", {
        has: page.locator(".se-button-2__text", { hasText: "Exporteren" }),
      })
      .first();

    await topExportBtn.waitFor({ state: "visible", timeout: 120000 });
    await topExportBtn.click();

    // 2) Popup zichtbaar
    await page.locator("text=Exporteren").first().waitFor({ state: "visible", timeout: 120000 });

    // 3) CSV tegel
    const csvTile = page
      .locator(".export-format-buttons__btn", {
        has: page.locator(".export-format-buttons__btn-label", { hasText: "CSV" }),
      })
      .first();

    await csvTile.waitFor({ state: "visible", timeout: 120000 });
    await csvTile.click();

    // 4) Exporteren knop in footer popup
    const footerExportBtn = page
      .locator(".export-popup-wrapper__footer button:visible", {
        has: page.locator(".se-button-2__text", { hasText: "Exporteren" }),
      })
      .first();

    await footerExportBtn.waitFor({ state: "visible", timeout: 120000 });

    // Wacht specifiek op de uiteindelijke download response (do=download + text/csv)
    const csvResponsePromise = page.waitForResponse(
      (resp) => {
        const url = resp.url();
        if (!url.includes("api.llm_rankings.rankings.export.html")) return false;
        if (!url.includes("do=download")) return false;
        const h = resp.headers();
        const ct = (h["content-type"] || "").toLowerCase();
        return ct.includes("text/csv");
      },
      { timeout: EXPORT_TIMEOUT_MS }
    );

    await footerExportBtn.click();

    const csvResp = await csvResponsePromise;

    const headers = csvResp.headers();
    const filenameFromHeader = pickCsvFilenameFromHeaders(headers);
    const filename = filenameFromHeader || `export-${nowStamp()}.csv`;
    const outPath = path.join(DOWNLOAD_DIR, filename);

    // Soms is response.body leeg in CI. Dan refetchen we via page.request.
    let buf = await csvResp.body().catch(() => Buffer.from(""));
    if (!buf || buf.length === 0) {
      console.log("CSV body leeg via response.body, refetch via page.request:", csvResp.url());
      const refetch = await page.request.get(csvResp.url(), { timeout: EXPORT_TIMEOUT_MS });
      if (!refetch.ok()) {
        throw new Error(`Refetch faalt status=${refetch.status()} url=${csvResp.url()}`);
      }
      const refBuf = await refetch.body();
      if (!refBuf || refBuf.length === 0) {
        throw new Error("CSV body blijft leeg na refetch");
      }
      buf = refBuf;
    }

    await fs.promises.writeFile(outPath, buf);
    console.log("CSV opgeslagen:", outPath, "bytes:", buf.length);

    if (WEBHOOK_URL) {
      await postToWebhook(WEBHOOK_URL, outPath);
    } else {
      console.log("WEBHOOK_URL niet gezet, alleen lokaal opgeslagen.");
    }

    await browser.close();
  } catch (err) {
    console.log("Fatal:", err?.message || err);
    if (DEBUG) await saveDebugArtifacts(page, path.join(process.cwd(), "debug"), "fail");
    await browser.close();
    process.exit(1);
  }
}

main();

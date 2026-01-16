// src/run.js
// ES module versie (package.json heeft "type": "module")
//
// Gebruik:
//   node src/run.js --guestUrl "https://..." --project "TMC" --company "The Member Company"
//
// Env vars (fallback):
//   SE_RANKING_GUEST_URL
//   PROJECT_NAME
//   COMPANY_NAME
//   WEBHOOK_URL
//   DOWNLOAD_DIR
//   HEADLESS
//   EXPORT_TIMEOUT_MS
//   DEBUG

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

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

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function buildWebhookUrl(baseUrl, meta) {
  // Zet project/company als query params, zodat je ze altijd terugziet in n8n webhook node
  // In n8n komt dit binnen als $json.query.project enz.
  const u = new URL(baseUrl);
  if (meta.project) u.searchParams.set("project", meta.project);
  if (meta.company) u.searchParams.set("company", meta.company);
  if (meta.guestUrl) u.searchParams.set("guestUrl", meta.guestUrl);
  return u.toString();
}

async function postToWebhook(webhookUrl, filePath, meta) {
  const data = await fs.promises.readFile(filePath);
  const filename = path.basename(filePath);

  const finalUrl = buildWebhookUrl(webhookUrl, meta);

  const res = await fetch(finalUrl, {
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "x-filename": filename,
      // Extra zekerheid: ook in headers meesturen
      "x-project": meta.project || "",
      "x-company": meta.company || "",
      "x-guest-url": meta.guestUrl || "",
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
  const args = parseArgs(process.argv.slice(2));

  // Guest url kan nu uit CLI argument komen, met env als fallback
  const GUEST_URL = args.guestUrl || args.guesturl || process.env.SE_RANKING_GUEST_URL;
  if (!GUEST_URL) {
    console.error('SE_RANKING_GUEST_URL ontbreekt en er is geen --guestUrl meegegeven');
    process.exit(1);
  }

  // Project of company kan uit CLI argument komen, met env als fallback
  const meta = {
    project: args.project || process.env.PROJECT_NAME || "",
    company: args.company || process.env.COMPANY_NAME || "",
    guestUrl: GUEST_URL,
  };

  const WEBHOOK_URL = args.webhookUrl || args.webhookurl || process.env.WEBHOOK_URL || "";
  const DOWNLOAD_DIR = args.downloadDir || args.downloaddir || process.env.DOWNLOAD_DIR || path.join(process.cwd(), "downloads");
  const DEBUG = String(args.debug || process.env.DEBUG || "true").toLowerCase() === "true";
  const HEADLESS = String(args.headless || process.env.HEADLESS || "true").toLowerCase() === "true";
  const EXPORT_TIMEOUT_MS = Number(args.exportTimeoutMs || args.exporttimeoutms || process.env.EXPORT_TIMEOUT_MS || "600000");

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

    const topExportBtn = page
      .locator("button:visible", {
        has: page.locator(".se-button-2__text", { hasText: "Exporteren" }),
      })
      .first();

    await topExportBtn.waitFor({ state: "visible", timeout: 120000 });
    await topExportBtn.click();

    await page.locator("text=Exporteren").first().waitFor({ state: "visible", timeout: 120000 });

    const csvTile = page
      .locator(".export-format-buttons__btn", {
        has: page.locator(".export-format-buttons__btn-label", { hasText: "CSV" }),
      })
      .first();

    await csvTile.waitFor({ state: "visible", timeout: 120000 });
    await csvTile.click();

    const footerExportBtn = page
      .locator(".export-popup-wrapper__footer button:visible", {
        has: page.locator(".se-button-2__text", { hasText: "Exporteren" }),
      })
      .first();

    await footerExportBtn.waitFor({ state: "visible", timeout: 120000 });

    const downloadPromise = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS }).catch(() => null);

    const csvResponsePromise = page
      .waitForResponse(
        (resp) => {
          const url = resp.url();
          if (!url.includes("api.llm_rankings.rankings.export.html")) return false;
          if (!url.includes("do=download")) return false;
          const h = resp.headers();
          const ct = (h["content-type"] || "").toLowerCase();
          return ct.includes("text/csv");
        },
        { timeout: EXPORT_TIMEOUT_MS }
      )
      .catch(() => null);

    await footerExportBtn.click();

    let outPath = "";
    const dl = await downloadPromise;

    if (dl) {
      const suggested = dl.suggestedFilename();
      const filename = suggested || `export-${nowStamp()}.csv`;
      outPath = path.join(DOWNLOAD_DIR, filename);
      await dl.saveAs(outPath);
      console.log("Download event opgeslagen:", outPath);
    } else {
      const resp = await csvResponsePromise;
      if (!resp) {
        throw new Error("Geen download event en geen CSV response gezien. Mogelijk is export nog bezig of UI blokkeert.");
      }

      const headers = resp.headers();
      const filenameFromHeader = pickCsvFilenameFromHeaders(headers);
      const filename = filenameFromHeader || `export-${nowStamp()}.csv`;
      outPath = path.join(DOWNLOAD_DIR, filename);

      const buf = await resp.body().catch(() => Buffer.from(""));
      if (!buf || buf.length === 0) {
        throw new Error("CSV response gevonden maar body is leeg.");
      }

      await fs.promises.writeFile(outPath, buf);
      console.log("CSV via response body opgeslagen:", outPath, "bytes:", buf.length);
    }

    // Upload naar webhook
    if (WEBHOOK_URL) {
      await postToWebhook(WEBHOOK_URL, outPath, meta);
    } else {
      console.log("WEBHOOK_URL niet gezet, alleen lokaal opgeslagen.");
    }

    await context.close();
    await browser.close();
  } catch (err) {
    console.log("Fatal:", err?.message || err);
    if (DEBUG) {
      await saveDebugArtifacts(page, path.join(process.cwd(), "debug"), "fail");
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

main();

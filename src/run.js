// src/run.js
// ES module versie (package.json heeft "type": "module")
//
// Doel:
// - Open SE Ranking guest URL
// - Projectnaam ophalen via breadcrumb link: a.se-breadcrumbs__link
// - Export popup openen
// - In export popup "Alle zoekmachines" selecteren
// - CSV exporteren
// - Post CSV naar webhook met project en guestUrl als query params en headers
//
// Input:
// - CLI argument: --guestUrl "https://..."
// - Fallback env: SE_RANKING_GUEST_URL
//
// Env vars:
//   WEBHOOK_URL
//   DOWNLOAD_DIR          (default: ./downloads)
//   HEADLESS              ("true" of "false", default: true)
//   EXPORT_TIMEOUT_MS     (default: 600000)
//   DEBUG                 ("true" of "false", default: true)

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

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

async function scrapeProjectName(page) {
  try {
    const breadcrumbLink = page.locator("a.se-breadcrumbs__link").first();
    await breadcrumbLink.waitFor({ state: "visible", timeout: 30000 });
    const txt = cleanText(await breadcrumbLink.innerText().catch(() => ""));
    if (txt && txt.length >= 2 && txt.length <= 140) return txt;
  } catch {}

  try {
    const lastBreadcrumb = page.locator("a.se-breadcrumbs__link").last();
    const count = await lastBreadcrumb.count().catch(() => 0);
    if (count) {
      const txt = cleanText(await lastBreadcrumb.innerText().catch(() => ""));
      if (txt && txt.length >= 2 && txt.length <= 140) return txt;
    }
  } catch {}

  const title = cleanText(await page.title().catch(() => ""));
  return title && title.length <= 200 ? title : "";
}

function buildWebhookUrl(baseUrl, meta) {
  const u = new URL(baseUrl);
  if (meta.project) u.searchParams.set("project", meta.project);
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
      "x-project": meta.project || "",
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

async function selectAllEnginesInExportPopup(page) {
  // We werken binnen de export popup om misclicks te voorkomen
  const popup = page.locator(".export-popup-wrapper").first();
  await popup.waitFor({ state: "visible", timeout: 60000 });

  // Open de zoekmachine dropdown (button wrapper)
  // Dit is robuust: we klikken de button binnen de engines dropdown container
  const dropdownButton = popup.locator(".engines-dropdown .se-button-2__wrapper").first();

  // Sommige builds hebben een iets andere structuur, daarom fallback
  const dropdownFallback = popup.locator(".engines-dropdown").first();

  if ((await dropdownButton.count().catch(() => 0)) > 0) {
    await dropdownButton.click({ timeout: 30000 });
  } else {
    await dropdownFallback.click({ timeout: 30000 });
  }

  // Wacht tot de lijst zichtbaar is en klik "Alle zoekmachines"
  // De tekst komt in jouw screenshot terug als: <span>Alle zoekmachines</span>
  const allEnginesItem = page
    .locator(".engines-dropdown__item", {
      has: page.locator("text=Alle zoekmachines"),
    })
    .first();

  await allEnginesItem.waitFor({ state: "visible", timeout: 30000 });
  await allEnginesItem.click();

  // Kleine pauze zodat de keuze wordt toegepast
  await page.waitForTimeout(300);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const GUEST_URL = args.guestUrl || args.guesturl || process.env.SE_RANKING_GUEST_URL;
  if (!GUEST_URL) {
    console.error("Geen guest URL. Geef --guestUrl mee of zet SE_RANKING_GUEST_URL.");
    process.exit(1);
  }

  const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
  const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), "downloads");
  const DEBUG = (process.env.DEBUG || "true").toLowerCase() === "true";
  const HEADLESS = (process.env.HEADLESS || "true").toLowerCase() === "true";
  const EXPORT_TIMEOUT_MS = Number(process.env.EXPORT_TIMEOUT_MS || "600000");

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
    await page.waitForTimeout(2500);

    const projectName = await scrapeProjectName(page);
    console.log("Projectnaam:", projectName || "(niet gevonden)");

    const meta = {
      project: projectName || "",
      guestUrl: GUEST_URL,
    };

    // 1) Bovenste Exporteren knop
    const topExportBtn = page
      .locator("button:visible", {
        has: page.locator(".se-button-2__text", { hasText: "Exporteren" }),
      })
      .first();

    await topExportBtn.waitFor({ state: "visible", timeout: 120000 });
    await topExportBtn.click();

    // 2) Popup zichtbaar
    await page.locator("text=Exporteren").first().waitFor({ state: "visible", timeout: 120000 });

    // 2a) Selecteer "Alle zoekmachines" zodat je alle resultaten krijgt
    await selectAllEnginesInExportPopup(page);

    // 3) CSV tegel selecteren
    const csvTile = page
      .locator(".export-format-buttons__btn", {
        has: page.locator(".export-format-buttons__btn-label", { hasText: "CSV" }),
      })
      .first();

    await csvTile.waitFor({ state: "visible", timeout: 120000 });
    await csvTile.click();

    // 4) Exporteren knop in popup footer
    const footerExportBtn = page
      .locator(".export-popup-wrapper__footer button:visible", {
        has: page.locator(".se-button-2__text", { hasText: "Exporteren" }),
      })
      .first();

    await footerExportBtn.waitFor({ state: "visible", timeout: 120000 });

    // 5) Download via download event, fallback via response
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
        throw new Error("Geen download event en geen CSV response gezien.");
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

    // 6) Upload naar webhook
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
      await saveDebugArtifacts(page, debugDir, "fail");
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

main();
// src/run.js
// ES module versie (package.json heeft "type": "module")
//
// Doel:
// - Open SE Ranking guest URL
// - Projectnaam ophalen via breadcrumb link: a.se-breadcrumbs__link
// - Export popup openen (se-popup-window-2)
// - Selecteer "Alle zoekmachines"
// - Selecteer CSV
// - Klik Exporteren
// - Wacht op download en post naar webhook met project en guestUrl

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
    await breadcrumbLink.waitFor({ state: "visible", timeout: 45000 });
    const txt = cleanText(await breadcrumbLink.innerText().catch(() => ""));
    if (txt && txt.length >= 2 && txt.length <= 140) return txt;
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

async function openExportPopup(page) {
  // Klik op de export knop die de dropdown opent
  const topExportBtn = page
    .locator("button:visible", {
      has: page.locator(".se-button-2__text", { hasText: "Exporteren" }),
    })
    .first();

  await topExportBtn.waitFor({ state: "visible", timeout: 120000 });
  await topExportBtn.click();

  // Wacht op de echte popup container
  const popup = page.locator(".se-popup-window-2__box:visible").first();
  await popup.waitFor({ state: "visible", timeout: 60000 });

  // Verifieer dat dit de export popup is
  const title = popup.locator(".se-popup-window-2__title", { hasText: "Exporteren" }).first();
  await title.waitFor({ state: "visible", timeout: 30000 });

  return popup;
}

async function selectAllEnginesInPopup(page, popup) {
  // Open dropdown (button staat in engines-dropdown)
  const enginesBtn = popup.locator(".se-dropdown-slot.engines-dropdown button").first();
  await enginesBtn.waitFor({ state: "visible", timeout: 30000 });
  await enginesBtn.click();

  // Klik "Alle zoekmachines"
  const allEnginesItem = page
    .locator(".engines-dropdown__item", {
      has: page.locator(".engines-dropdown__item-text span", { hasText: "Alle zoekmachines" }),
    })
    .first();

  await allEnginesItem.waitFor({ state: "visible", timeout: 30000 });
  await allEnginesItem.click();

  await page.waitForTimeout(300);
}

async function selectCsvInPopup(popup) {
  // Als CSV al geselecteerd is: klaar
  const already = popup.locator(
    '.export-format-buttons__btn_selected .export-format-buttons__btn-label'
  );

  if ((await already.count().catch(() => 0)) > 0) {
    const t = (await already.first().innerText().catch(() => "")).trim();
    if (t === "CSV(.csv)" || t.includes("CSV")) return;
  }

  // 1) Vind de label div die letterlijk "CSV(.csv)" bevat
  const label = popup.locator(".export-format-buttons__btn-label").filter({
    hasText: "CSV(.csv)",
  });

  await label.first().waitFor({ state: "visible", timeout: 30000 });

  // 2) Klik de parent tegel (de div export-format-buttons__btn)
  const tile = label.first().locator("xpath=ancestor::div[contains(@class,'export-format-buttons__btn')][1]");
  await tile.waitFor({ state: "visible", timeout: 30000 });
  await tile.click({ force: true });

  // 3) Verifieer selectie
  await popup
    .locator(".export-format-buttons__btn_selected .export-format-buttons__btn-label")
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
}



async function clickExportInPopup(popup) {
  // Primair: pak de knop "Exporteren" binnen de footer van de popup
  const btn = popup
    .locator(".export-popup-wrapper__footer button", {
      has: popup.locator(".se-button-2__text", { hasText: "Exporteren" }),
    })
    .last();

  // Wacht op "attached" (staat in DOM), niet op visible
  await btn.waitFor({ state: "attached", timeout: 30000 });

  // Zorg dat hij in beeld is en klik geforceerd
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ force: true, timeout: 30000 });
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

    const meta = { project: projectName || "", guestUrl: GUEST_URL };

    // Popup openen
    const popup = await openExportPopup(page);

    // Alle zoekmachines selecteren
    await selectAllEnginesInPopup(page, popup);

    // CSV selecteren
    await selectCsvInPopup(popup);

    // Download wachtpunten klaarzetten vóór de export klik
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

    // Exporteren in popup
    await clickExportInPopup(popup);

    // Download opslaan
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

    // Upload
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

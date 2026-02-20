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

async function forceCloseAiSearchNudge(page, opts = {}) {
  const {
    timeoutMs = 15000,
    pollIntervalMs = 300,
    maxClicks = 3,
  } = opts;

  const closeSelector = 'button[data-testid="nudge-step-close-button"][aria-label="Close modal"]';

  const start = Date.now();
  let clicks = 0;

  while (Date.now() - start < timeoutMs) {
    const closeBtn = page.locator(closeSelector).first();

    const isVisible = await closeBtn.isVisible().catch(() => false);
    if (!isVisible) {
      // Popup is (nog) niet aanwezig of al weg
      await page.waitForTimeout(pollIntervalMs);
      continue;
    }

    try {
      await closeBtn.scrollIntoViewIfNeeded().catch(() => {});
      await closeBtn.click({ force: true, timeout: 2000 });
      clicks++;

      await page.waitForTimeout(400);

      const stillVisible = await closeBtn.isVisible().catch(() => false);
      if (!stillVisible) {
        return true;
      }

      if (clicks >= maxClicks) {
        return true;
      }
    } catch {
      await page.waitForTimeout(pollIntervalMs);
    }
  }

  return false;
}


async function safeClick(locator, page, opts = {}) {
  // Voor klikacties die soms geblokkeerd worden door de popup
  await forceCloseAiSearchNudge(page);

  try {
    await locator.click(opts);
    return;
  } catch {
    // Popup kan net opkomen tussen wait en click
    await forceCloseAiSearchNudge(page);
    await locator.click({ ...opts, force: true });
  }
}


function pickCsvFilenameFromHeaders(headers) {
  const cd = headers["content-disposition"] || headers["Content-Disposition"] || "";
  const m = cd.match(/filename="([^"]+)"/i) || cd.match(/filename=([^;]+)/i);
  if (!m) return null;
  return m[1].replace(/(^"|"$)/g, "").trim();
}

function parseGuestUrls(args) {
  const env = process.env.SE_RANKING_GUEST_URLS || process.env.SE_RANKING_GUEST_URL || "";

  const fromArgs =
    args.guestUrls ||
    args.guesturls ||
    args.guestUrl ||
    args.guesturl ||
    "";

  const collect = [];

  const add = (v) => {
    if (!v) return;
    if (Array.isArray(v)) {
      v.forEach(add);
      return;
    }
    String(v)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((u) => collect.push(u));
  };

  add(fromArgs);
  if (collect.length === 0) add(env);

  // dedupe
  const uniq = Array.from(new Set(collect));

  return uniq;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      // boolean flag
      if (args[key] === undefined) args[key] = "true";
      continue;
    }

    // allow repeated keys
    if (args[key] === undefined) {
      args[key] = next;
    } else if (Array.isArray(args[key])) {
      args[key].push(next);
    } else {
      args[key] = [args[key], next];
    }

    i++;
  }
  return args;
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

async function scrapeProjectName(page) {
  await forceCloseAiSearchNudge(page).catch(() => {});

  const blacklist = new Set([
    "SE Ranking",
    "AI Search",
    "AI-Resultaten Tracker",
    "Rankings",
    "Ranking",
    "Projecten",
    "Projects",
    "keyboard_arrow_down",
    "expand_more",
    "keyboard_arrow_downexpand_more",
  ]);

  const looksOk = (t) => {
    const s = cleanText(t);
    if (!s) return false;
    if (s.length < 2 || s.length > 200) return false;
    if (blacklist.has(s)) return false;

    // filter icon restjes
    if (/keyboard_arrow|expand_more|unfold_more/i.test(s)) return false;

    return true;
  };

  // 1) Primair: exact het tekstdivje met de projectnaam (jouw HTML snippet)
  try {
    const nameDiv = page.locator(".left-menu-project-select__toggler-button-text").first();
    const ok = await nameDiv.waitFor({ state: "attached", timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    if (ok) {
      const txt = cleanText(await nameDiv.innerText().catch(() => ""));
      if (looksOk(txt)) {
        console.log("Projectnaam bron: left-menu name div");
        return txt;
      }
    }
  } catch {}

  // 2) Als de sidebar een native select gebruikt: pak geselecteerde option tekst
  try {
    const select = page.locator(".left-menu select, aside select, nav select").first();
    const ok = await select.waitFor({ state: "attached", timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    if (ok) {
      const selectedText = await select.evaluate((el) => {
        const opt = el.selectedOptions && el.selectedOptions[0];
        return (opt && opt.textContent) ? opt.textContent.trim() : "";
      }).catch(() => "");

      const txt = cleanText(selectedText);
      if (looksOk(txt)) {
        console.log("Projectnaam bron: sidebar select selected option");
        return txt;
      }
    }
  } catch {}

  // 3) Dropdown lijst: actieve item (jouw HTML snippet bevat dit ook)
  try {
    const active = page.locator(".projects-list-link-list__main-item_active .text-project-name").first();
    const ok = await active.waitFor({ state: "attached", timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    if (ok) {
      const txt = cleanText(await active.innerText().catch(() => ""));
      if (looksOk(txt)) {
        console.log("Projectnaam bron: active dropdown item");
        return txt;
      }
    }
  } catch {}

  // 4) Breadcrumbs als fallback, maar filter generieke items
  try {
    const crumbs = page.locator("a.se-breadcrumbs__link").first();
    const ok = await crumbs.waitFor({ state: "attached", timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    if (ok) {
      const all = (await page.locator("a.se-breadcrumbs__link").allInnerTexts().catch(() => []))
        .map(cleanText)
        .filter(Boolean);

      const candidate = all.find((t) => looksOk(t));
      if (candidate) {
        console.log("Projectnaam bron: breadcrumbs");
        return candidate;
      }
    }
  } catch {}

  console.log("Projectnaam niet gevonden, return leeg");
  return "";
}


function buildWebhookUrl(baseUrl, meta) {
  const u = new URL(baseUrl);
  if (meta.project) u.searchParams.set("project", meta.project);
  if (meta.guestUrl) u.searchParams.set("guestUrl", meta.guestUrl);
  return u.toString();
}

async function postBatchToWebhook(webhookUrl, files, metaList) {
  // files: [{ path, filename }]
  // metaList: [{ project, guestUrl, filename, bytes, ok, error }]

  const form = new FormData();

  // Manifest mee (handig voor backend)
  form.append(
    "manifest",
    new Blob([JSON.stringify({ items: metaList }, null, 2)], { type: "application/json" }),
    "manifest.json"
  );

  // Alle CSV bestanden toevoegen
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const data = await fs.promises.readFile(f.path);
    form.append(
      "files",
      new Blob([data], { type: "text/csv" }),
      f.filename
    );
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    body: form,
  });

  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Webhook batch error status=${res.status} body=${txt.slice(0, 500)}`);
  }

  console.log("Webhook batch OK:", res.status);
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
  await safeClick(topExportBtn, page);

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

  // Soms is er maar één optie en gedraagt de dropdown zich anders
  try {
    await enginesBtn.click({ timeout: 10000 });
  } catch {
    // Als de knop niet klikbaar is, gaan we ervan uit dat de enige optie al geselecteerd is
    return;
  }

  // Wacht tot er items zichtbaar zijn
  const items = page.locator(".engines-dropdown__item");
  const anyItemVisible = await items.first().waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);

  if (!anyItemVisible) {
    // Geen menu zichtbaar gekregen, laat selectie staan
    return;
  }

  // Probeer "Alle zoekmachines"
  const allEnginesItem = page
    .locator(".engines-dropdown__item", {
      has: page.locator(".engines-dropdown__item-text span", { hasText: "Alle zoekmachines" }),
    })
    .first();

  const hasAllEngines = (await allEnginesItem.count().catch(() => 0)) > 0;

  if (hasAllEngines) {
    await allEnginesItem.click();
  } else {
    // Geen "Alle zoekmachines" aanwezig, kies de eerste optie
    await items.first().click();
  }

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
  // Zoek binnen de popup naar knoppen met tekst Exporteren
  // In de popup is dat meestal precies 1 knop, maar we pakken bewust de laatste match
  const exportBtn = popup.locator("button", { hasText: "Exporteren" }).last();

  // Wacht alleen tot hij in de DOM hangt
  await exportBtn.waitFor({ state: "attached", timeout: 30000 });

  // Zorg dat hij klikbaar is
  await exportBtn.scrollIntoViewIfNeeded().catch(() => {});
  await exportBtn.click({ force: true, timeout: 30000 });
}



async function main() {
  const args = parseArgs(process.argv.slice(2));

  const GUEST_URLS = parseGuestUrls(args);
  if (!GUEST_URLS.length) {
    console.error("Geen guest URL's. Geef --guestUrls mee of zet SE_RANKING_GUEST_URLS.");
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
  const results = [];
  const fileUploads = [];

  for (let idx = 0; idx < GUEST_URLS.length; idx++) {
    const guestUrl = GUEST_URLS[idx];
    console.log(`Open (${idx + 1}/${GUEST_URLS.length}):`, guestUrl);

    const page = await context.newPage();

    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error") console.log("[browser error]", msg.text());
      if (t === "warning") console.log("[browser warning]", msg.text());
    });

    let projectName = "";
    let outPath = "";

    try {
      await page.goto(guestUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForTimeout(2500);
      await forceCloseAiSearchNudge(page);

      projectName = await scrapeProjectName(page);
      console.log("Projectnaam:", projectName || "(niet gevonden)");

      const meta = { project: projectName || "", guestUrl };

      const popup = await openExportPopup(page);
      await selectAllEnginesInPopup(page, popup);
      await selectCsvInPopup(popup);

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

      await clickExportInPopup(popup);

      const dl = await downloadPromise;

      if (dl) {
        const suggested = dl.suggestedFilename();
        const filename = suggested || `export-${nowStamp()}.csv`;
        outPath = path.join(DOWNLOAD_DIR, filename);
        await dl.saveAs(outPath);
        console.log("Download event opgeslagen:", outPath);
      } else {
        const resp = await csvResponsePromise;
        if (!resp) throw new Error("Geen download event en geen CSV response gezien.");

        const headers = resp.headers();
        const filenameFromHeader = pickCsvFilenameFromHeaders(headers);
        const filename = filenameFromHeader || `export-${nowStamp()}.csv`;
        outPath = path.join(DOWNLOAD_DIR, filename);

        const buf = await resp.body().catch(() => Buffer.from(""));
        if (!buf || buf.length === 0) throw new Error("CSV response gevonden maar body is leeg.");

        await fs.promises.writeFile(outPath, buf);
        console.log("CSV via response body opgeslagen:", outPath, "bytes:", buf.length);
      }

      const stat = await fs.promises.stat(outPath).catch(() => null);
      const bytes = stat ? stat.size : 0;

      results.push({
        ok: true,
        project: projectName || "",
        guestUrl,
        filename: path.basename(outPath),
        bytes,
      });

      fileUploads.push({
        path: outPath,
        filename: path.basename(outPath),
      });

      await page.close();
    } catch (err) {
      console.log("Project failed:", guestUrl, err?.message || err);

      results.push({
        ok: false,
        project: projectName || "",
        guestUrl,
        filename: outPath ? path.basename(outPath) : "",
        bytes: 0,
        error: err?.message || String(err),
      });

      if (DEBUG) {
        await saveDebugArtifacts(page, debugDir, `fail-${idx + 1}`);
      }

      await page.close().catch(() => {});
      // doorgaan met volgende project
    }
  }

  // Als er niks gelukt is: stop
  const okCount = results.filter((r) => r.ok).length;
  if (okCount === 0) {
    throw new Error("Geen enkel project kon worden geëxporteerd.");
  }

  // Batch upload: één call
  if (WEBHOOK_URL) {
    await postBatchToWebhook(WEBHOOK_URL, fileUploads, results);
  } else {
    console.log("WEBHOOK_URL niet gezet, alleen lokaal opgeslagen.");
  }

  await context.close();
  await browser.close();

  // Optioneel: als er failures waren toch exit code 1, maar export is wel verstuurd
  const failCount = results.filter((r) => !r.ok).length;
  if (failCount > 0) {
    console.log(`Let op: ${failCount} project(en) faalden, maar batch is verzonden met ${okCount} bestand(en).`);
    process.exit(1);
  }
} catch (err) {
  console.log("Fatal:", err?.message || err);
  // page kan hier niet bestaan, dus alleen globale cleanup
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(1);
}
}

main();

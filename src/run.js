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

function filenameFromContentDisposition(cd) {
  if (!cd) return null;

  const m1 = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (m1 && m1[1]) {
    try {
      return decodeURIComponent(m1[1].trim().replace(/(^"|"$)/g, ""));
    } catch {
      return m1[1].trim().replace(/(^"|"$)/g, "");
    }
  }

  const m2 = cd.match(/filename\s*=\s*("?)([^";]+)\1/i);
  if (m2 && m2[2]) return m2[2].trim();

  return null;
}

function extFromContentType(ct, preferredFormat) {
  const t = (ct || "").toLowerCase();
  if (t.includes("text/csv")) return "csv";
  if (t.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) return "xlsx";
  if (t.includes("application/vnd.ms-excel")) return "xls";
  if (preferredFormat === "CSV") return "csv";
  return "xlsx";
}

async function fetchBinaryViaRequest(context, url, timeoutMs) {
  // context.request gebruikt dezelfde browsercontext (cookies, auth state)
  const res = await context.request.get(url, {
    timeout: timeoutMs,
    maxRedirects: 10
  });

  if (!res.ok()) {
    const txt = await res.text().catch(() => "");
    throw new Error(`context.request.get failed: ${res.status()} ${res.statusText()} url=${url} body=${txt.slice(0, 500)}`);
  }

  const headers = res.headers();
  const buffer = await res.body();
  return { headers, buffer };
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

    // 1) Eerste export knop: file_upload icon
    const topExportBtn = page
      .locator("button:visible")
      .filter({ has: page.locator("i.material-icons:has-text('file_upload')") })
      .first();

    await topExportBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });
    await topExportBtn.click();

    // 2) Export popup
    const formatRoot = page.locator(".export-format-buttons").first();
    await formatRoot.waitFor({ state: "visible", timeout: exportTimeoutMs });

    const csvLabel = page.locator(".export-format-buttons__btn-label:has-text('CSV(.csv)')").first();
    const xlsxLabel = page.locator(".export-format-buttons__btn-label:has-text('Excel (.xlsx)')").first();

    if (preferredFormat === "CSV") {
      await csvLabel.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await csvLabel.click();
    } else {
      await xlsxLabel.waitFor({ state: "visible", timeout: exportTimeoutMs });
      await xlsxLabel.click();
    }

    // 3) Klik primaire knop (laatste se-button-2 in popup container)
    const popupContainer = formatRoot.locator(
      "xpath=ancestor::*[.//div[contains(@class,'export-format-buttons')] and .//button[contains(@class,'se-button-2')]][1]"
    );

    await popupContainer.waitFor({ state: "visible", timeout: exportTimeoutMs });

    const actionButtons = popupContainer.locator("button.se-button-2:visible");
    const btnCount = await actionButtons.count();
    if (btnCount === 0) throw new Error("Geen actieknoppen gevonden in de export popup container.");

    const finalBtn = actionButtons.nth(btnCount - 1);
    await finalBtn.waitFor({ state: "visible", timeout: exportTimeoutMs });

    // 4) Wacht op download of op een export response URL
    const downloadWait = context.waitForEvent("download", { timeout: exportTimeoutMs }).catch(() => null);

    const responseWait = page
      .waitForResponse(
        async (res) => {
          try {
            const url = res.url().toLowerCase();
            if (!(url.includes("export") || url.includes("download") || url.includes("file"))) return false;

            const headers = await res.allHeaders();
            const cd = headers["content-disposition"] || headers["Content-Disposition"];
            const ct = headers["content-type"] || headers["Content-Type"];

            if (cd && /attachment/i.test(cd)) return true;

            const ctLower = (ct || "").toLowerCase();
            if (ctLower.includes("text/csv") || ctLower.includes("spreadsheetml") || ctLower.includes("application/vnd.ms-excel")) {
              return true;
            }

            return false;
          } catch {
            return false;
          }
        },
        { timeout: exportTimeoutMs }
      )
      .catch(() => null);

    await finalBtn.click({ timeout: exportTimeoutMs, force: true });

    const winner = await Promise.race([
      downloadWait.then((d) => ({ kind: "download", value: d })),
      responseWait.then((r) => ({ kind: "response", value: r })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "none", value: null }), exportTimeoutMs))
    ]);

    if (winner.kind === "download" && winner.value) {
      const download = winner.value;
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
          format: preferredFormat,
          method: "download-event"
        }
      });

      console.log("Export downloaded:", filePath);
      console.log("Webhook response:", result || "(empty)");
      return;
    }

    if (winner.kind === "response" && winner.value) {
      const res = winner.value;

      // Probeer metadata uit de originele response te halen
      const originalHeaders = await res.allHeaders().catch(() => ({}));
      const cd = originalHeaders["content-disposition"] || originalHeaders["Content-Disposition"];
      const ct = originalHeaders["content-type"] || originalHeaders["Content-Type"];

      const url = res.url();

      // Body ophalen via context.request (stabieler dan response.body())
      const fetched = await fetchBinaryViaRequest(context, url, exportTimeoutMs);
      const fetchedCd = fetched.headers["content-disposition"] || fetched.headers["Content-Disposition"] || cd;
      const fetchedCt = fetched.headers["content-type"] || fetched.headers["Content-Type"] || ct;

      const ext = extFromContentType(fetchedCt, preferredFormat);
      const nameFromHeader = filenameFromContentDisposition(fetchedCd);
      const suggestedName = nameFromHeader || `export.${ext}`;

      if (!fetched.buffer || fetched.buffer.length === 0) {
        throw new Error("Export fetch via context.request gaf een lege body.");
      }

      const filePath = path.join(downloadsDir, suggestedName);
      fs.writeFileSync(filePath, fetched.buffer);

      const result = await uploadFile({
        webhookUrl,
        filePath,
        extraFields: {
          source: "se-ranking-ai-search-guest-export",
          filename: suggestedName,
          format: preferredFormat,
          method: "request-get"
        }
      });

      console.log("Export saved via context.request:", filePath);
      console.log("Webhook response:", result || "(empty)");
      return;
    }

    throw new Error("Geen download event en geen bruikbare export response gezien na export klik.");
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
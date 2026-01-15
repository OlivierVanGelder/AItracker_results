import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";

export async function uploadFile({ webhookUrl, filePath, extraFields = {} }) {
  const form = new FormData();

  for (const [key, value] of Object.entries(extraFields)) {
    form.append(key, String(value));
  }

  form.append("file", fs.createReadStream(filePath));

  const res = await fetch(webhookUrl, {
    method: "POST",
    body: form,
    headers: form.getHeaders()
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook upload failed: ${res.status} ${res.statusText}\n${text}`);
  }

  return res.text().catch(() => "");
}

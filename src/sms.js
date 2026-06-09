import { db, nowIso } from "./db.js";
import fs from "node:fs";

const AYISUN_USERS_PATH = "/opt/businesshelpy/app/users.json";

function readAyisunUsers() {
  const raw = fs.readFileSync(AYISUN_USERS_PATH, "utf-8");
  return JSON.parse(raw);
}

function writeAyisunUsers(data) {
  fs.writeFileSync(AYISUN_USERS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/** Get Doticare user's SMS credit balance from Ayisun's users.json (case-insensitive match) */
export function getAyisunDoticareCredits() {
  try {
    const data = readAyisunUsers();
    const users = data.users || {};
    const key = Object.keys(users).find(k => k.toLowerCase() === "doticare");
    if (!key) return 0;
    return users[key].sms_credits || 0;
  } catch (e) {
    console.error("Failed to read Ayisun credits:", e.message);
    return 0;
  }
}

/** Deduct credits from Doticare user in Ayisun's users.json */
export function deductAyisunDoticareCredits(amount) {
  try {
    const data = readAyisunUsers();
    const users = data.users || {};
    const key = Object.keys(users).find(k => k.toLowerCase() === "doticare");
    if (!key) return false;
    users[key].sms_credits = Math.max(0, (users[key].sms_credits || 0) - amount);
    writeAyisunUsers(data);
    return true;
  } catch (e) {
    console.error("Failed to deduct Ayisun credits:", e.message);
    return false;
  }
}

/** Add credits to Doticare user in Ayisun's users.json (called after Paystack payment) */
export function addAyisunDoticareCredits(amount) {
  try {
    const data = readAyisunUsers();
    const users = data.users || {};
    const key = Object.keys(users).find(k => k.toLowerCase() === "doticare");
    if (!key) return false;
    users[key].sms_credits = (users[key].sms_credits || 0) + amount;
    writeAyisunUsers(data);
    return true;
  } catch (e) {
    console.error("Failed to add Ayisun credits:", e.message);
    return false;
  }
}

export function getSenderId() {
  return (process.env.SMS_SENDER_ID || "Doticare").toString();
}

function normalizePhone(toPhone) {
  return toPhone.toString().trim().replace(/^\+/, "");
}

export function enqueueSms({ toPhone, body, branch = "Konongo", customerId = null, saleId = null, templateId = null, createdByUserId = null }) {
  const senderId = getSenderId();

  const insert = db
    .prepare(
      `INSERT INTO sms_messages
        (branch, customer_id, sale_id, template_id, to_phone, sender_id, body, status, provider_message_id, error_message, created_by_user_id, sent_at, created_at)
       VALUES
        (@branch, @customer_id, @sale_id, @template_id, @to_phone, @sender_id, @body, @status, @provider_message_id, @error_message, @created_by_user_id, @sent_at, @created_at)`
    )
    .run({
      branch,
      customer_id: customerId,
      sale_id: saleId,
      template_id: templateId,
      to_phone: normalizePhone(toPhone),
      sender_id: senderId,
      body,
      status: "Queued",
      provider_message_id: null,
      error_message: null,
      created_by_user_id: createdByUserId,
      sent_at: null,
      created_at: nowIso()
    });

  return insert.lastInsertRowid;
}

/** Send a single SMS message via Arkesel V2 API */
export async function deliverSmsMessage(messageId) {
  const row = db.prepare(`SELECT * FROM sms_messages WHERE id = @id`).get({ id: messageId });
  if (!row) return null;

  return sendArkeselBulk([row.to_phone], row.body, (results) => {
    if (!results || results.length === 0) {
      db.prepare(
        `UPDATE sms_messages SET status = @status, error_message = @error_message, sent_at = @sent_at WHERE id = @id`
      ).run({ status: "Retry", error_message: "No response from provider", sent_at: nowIso(), id: messageId });
      return;
    }

    const result = results[0];
    if (result && result.status === "Sent" && result.id) {
      db.prepare(
        `UPDATE sms_messages SET status = @status, sender_id = @sender_id, provider_message_id = @provider_message_id, sent_at = @sent_at WHERE id = @id`
      ).run({
        status: "Sent",
        sender_id: getSenderId(),
        provider_message_id: result.id,
        sent_at: nowIso(),
        id: messageId
      });
    } else {
      db.prepare(
        `UPDATE sms_messages SET status = @status, sender_id = @sender_id, error_message = @error_message, sent_at = @sent_at WHERE id = @id`
      ).run({
        status: "Retry",
        sender_id: getSenderId(),
        error_message: String(result ? result.error || "Unknown" : "No response"),
        sent_at: nowIso(),
        id: messageId
      });
    }
  });
}

/** Deliver multiple queued SMS messages via a single Arkesel V2 bulk request */
export async function deliverBulkMessages(messageIds) {
  if (!messageIds || messageIds.length === 0) return { status: "empty" };

  const rows = db
    .prepare(`SELECT * FROM sms_messages WHERE id IN (${messageIds.map(() => "?").join(",")})`)
    .all(...messageIds);

  if (rows.length === 0) return { status: "empty" };

  const recipients = [];
  const body = rows[0].body;
  for (const r of rows) {
    recipients.push(normalizePhone(r.to_phone));
  }

  return sendArkeselBulk(recipients, body, (results) => {
    const sentAt = nowIso();
    const senderId = getSenderId();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const result = results ? results[i] : null;

      if (result && result.status === "Sent" && result.id) {
        db.prepare(
          `UPDATE sms_messages SET status = @status, sender_id = @sender_id, provider_message_id = @provider_message_id, sent_at = @sent_at WHERE id = @id`
        ).run({ status: "Sent", sender_id: senderId, provider_message_id: result.id, sent_at: sentAt, id: row.id });
      } else if (result && result.status === "Failed") {
        db.prepare(
          `UPDATE sms_messages SET status = @status, sender_id = @sender_id, error_message = @error_message, sent_at = @sent_at WHERE id = @id`
        ).run({ status: "Retry", sender_id: senderId, error_message: String(result.error || "Unknown error").slice(0, 2000), sent_at: sentAt, id: row.id });
      } else {
        db.prepare(
          `UPDATE sms_messages SET status = @status, sender_id = @sender_id, error_message = @error_message, sent_at = @sent_at WHERE id = @id`
        ).run({ status: "Retry", sender_id: senderId, error_message: "No result returned", sent_at: sentAt, id: row.id });
      }
    }
  });
}

/** Core Arkesel V2 API call */
async function sendArkeselBulk(recipients, message, onSuccess) {
  const apiKey = process.env.ARKESEL_API_KEY ? process.env.ARKESEL_API_KEY.toString() : "";
  const senderId = getSenderId();
  const endpoint = (process.env.ARKESEL_ENDPOINT || "https://sms.arkesel.com/api/v2/sms/send").toString();

  if (!apiKey) {
    //  Simulated mode — no API key set
    const sentAt = nowIso();
    //  The caller passes a callback that updates the DB; we simulate it here
    const simulated = recipients.map((r, i) => ({
      recipient: r,
      id: `sim-${Date.now()}-${i}`,
      status: "Simulated"
    }));

    if (onSuccess) onSuccess(simulated);
    return { status: "Simulated", data: simulated };
  }

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sender: senderId,
        recipients,
        message
      })
    });

    const json = await resp.json();

    if (!resp.ok || json.status === "error") {
      const errMsg = json.message || `HTTP ${resp.status}`;
      const failed = recipients.map((r) => ({
        recipient: r,
        id: null,
        status: "Failed",
        error: errMsg
      }));
      if (onSuccess) onSuccess(failed);
      return { status: "Failed", error: errMsg, data: failed };
    }

    //  Arkesel V2 returns: { status: "success", message: "...", data: [{recipient, id, status, message_id}, ...] }
    //  Some entries may have status: "error" or "Invalid number"
    const rawData = Array.isArray(json.data) ? json.data : [];

    const results = recipients.map((r, i) => {
      const match = rawData.find(
        (entry) =>
          entry.recipient === r ||
          entry.recipient === "+" + r ||
          String(entry.recipient || "").replace(/^\+/, "") === r.replace(/^\+/, "")
      );
      if (!match) {
        return { recipient: r, id: null, status: "Failed", error: "No response from provider for this number" };
      }
      if (match.status === "error" || match.code === "error" || match.message_id === "Invalid number" || String(match.message || "").includes("invalid")) {
        return { recipient: r, id: match.id || null, status: "Failed", error: match.message || "Invalid number" };
      }
      return { recipient: r, id: match.id || match.message_id || String(Date.now()) + "-" + i, status: "Sent" };
    });

    if (onSuccess) onSuccess(results);
    return { status: "success", data: results };
  } catch (e) {
    const sentAt = nowIso();
    const errMsg = String(e.message || e).slice(0, 2000);

    const failed = recipients.map((r) => ({
      recipient: r,
      id: null,
      status: "Failed",
      error: errMsg
    }));

    if (onSuccess) onSuccess(failed);
    return { status: "Failed", error: errMsg };
  }
}

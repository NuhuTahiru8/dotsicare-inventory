import { db, nowIso } from "./db.js";

export function getSenderId() {
  return (process.env.SMS_SENDER_ID || "Dotsicare").toString();
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

export async function deliverSmsMessage(messageId) {
  const row = db.prepare(`SELECT * FROM sms_messages WHERE id = @id`).get({ id: messageId });
  if (!row) return null;

  const senderId = getSenderId();
  const apiKey = process.env.TERMII_API_KEY ? process.env.TERMII_API_KEY.toString() : "";
  const endpoint = (process.env.TERMII_ENDPOINT || "https://api.ng.termii.com/api/sms/send").toString();
  const channel = (process.env.TERMII_CHANNEL || "dnd").toString();
  const type = (process.env.TERMII_TYPE || "plain").toString();

  if (!apiKey) {
    db.prepare(`UPDATE sms_messages SET status = @status, sender_id = @sender_id, sent_at = @sent_at WHERE id = @id`).run({
      status: "Simulated",
      sender_id: senderId,
      sent_at: nowIso(),
      id: messageId
    });
    return { status: "Simulated" };
  }

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        to: row.to_phone,
        from: senderId,
        sms: row.body,
        type,
        channel
      })
    });

    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!resp.ok) {
      db.prepare(`UPDATE sms_messages SET status = @status, sender_id = @sender_id, error_message = @error_message, sent_at = @sent_at WHERE id = @id`).run({
        status: "Failed",
        sender_id: senderId,
        error_message: text.slice(0, 2000),
        sent_at: nowIso(),
        id: messageId
      });
      return { status: "Failed", response: json || text };
    }

    const providerMessageId =
      (json && (json.message_id || json.messageId || json.sms_id || json.smsId || json.data?.message_id || json.data?.messageId)) || null;

    db.prepare(
      `UPDATE sms_messages
       SET status = @status, sender_id = @sender_id, provider_message_id = @provider_message_id, error_message = NULL, sent_at = @sent_at
       WHERE id = @id`
    ).run({
      status: "Sent",
      sender_id: senderId,
      provider_message_id: providerMessageId,
      sent_at: nowIso(),
      id: messageId
    });

    return { status: "Sent", response: json || text };
  } catch (e) {
    db.prepare(`UPDATE sms_messages SET status = @status, sender_id = @sender_id, error_message = @error_message, sent_at = @sent_at WHERE id = @id`).run({
      status: "Failed",
      sender_id: senderId,
      error_message: String(e.message || e).slice(0, 2000),
      sent_at: nowIso(),
      id: messageId
    });
    return { status: "Failed", error: String(e.message || e) };
  }
}

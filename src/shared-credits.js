/**
 * shared-credits.js
 *
 * Reads/Writes Ayisun's users.json for the "Doticare" user.
 * This is the shared SMS credit pool between Ayisun and DotiCare.
 * Both systems use the same credits — source of truth is Ayisun's users.json.
 */

import fs from "node:fs";
import path from "node:path";

const AYISUN_USERS_FILE = process.env.AYISUN_USERS_FILE || "/opt/businesshelpy/app/users.json";
const SHARED_USERNAME = (process.env.AYISUN_SHARED_USER || "Doticare").toLowerCase();

function readStore() {
  try {
    const raw = fs.readFileSync(AYISUN_USERS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[shared-credits] Failed to read users.json:", e.message);
    return null;
  }
}

function writeStore(store) {
  try {
    const tmp = AYISUN_USERS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    fs.renameSync(tmp, AYISUN_USERS_FILE);
    return true;
  } catch (e) {
    console.error("[shared-credits] Failed to write users.json:", e.message);
    return false;
  }
}

function findSharedUser(store) {
  if (!store || !store.users) return null;
  // Case-insensitive match
  for (const [key, user] of Object.entries(store.users)) {
    if (key.toLowerCase() === SHARED_USERNAME) {
      return { key, user };
    }
  }
  return null;
}

/** Get the shared SMS credit balance from Ayisun */
export function getSharedBalance() {
  const store = readStore();
  if (!store) return 0;
  const found = findSharedUser(store);
  if (!found) return 0;
  return Number(found.user.sms_credits) || 0;
}

/** Deduct credits from the shared pool. Returns new balance or -1 on error. */
export function deductSharedCredits(amount) {
  const store = readStore();
  if (!store) return -1;
  const found = findSharedUser(store);
  if (!found) return -1;

  const current = Number(found.user.sms_credits) || 0;
  if (amount <= 0) return current;
  const newBalance = Math.max(0, current - amount);
  found.user.sms_credits = newBalance;

  if (writeStore(store)) {
    return newBalance;
  }
  return -1;
}

/** Add credits to the shared pool. Returns new balance or -1 on error. */
export function addSharedCredits(amount) {
  const store = readStore();
  if (!store) return -1;
  const found = findSharedUser(store);
  if (!found) return -1;

  const current = Number(found.user.sms_credits) || 0;
  if (amount <= 0) return current;
  found.user.sms_credits = current + amount;

  if (writeStore(store)) {
    return found.user.sms_credits;
  }
  return -1;
}

/** Check if a username matches the shared Doticare user (case insensitive) */
export function isSharedUsername(username) {
  return (username || "").toString().trim().toLowerCase() === SHARED_USERNAME;
}

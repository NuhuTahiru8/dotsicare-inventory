import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import multer from "multer";
import { db, moneyToInt, nowIso } from "./db.js";
import { enqueueSms, deliverSmsMessage, deliverBulkMessages, getSenderId, getAyisunDoticareCredits, deductAyisunDoticareCredits, addAyisunDoticareCredits } from "./sms.js";
// import https from "node:https"; // not needed

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "src", "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static(path.join(process.cwd(), "src", "public")));

const uploadsDir = path.join(process.cwd(), "src", "public", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `${unique}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
    cb(null, allowed.includes(file.mimetype));
  }
});

const lowStockThreshold = Number(process.env.LOW_STOCK_THRESHOLD) || 3;
const sessionSecret = (process.env.SESSION_SECRET || "dev-secret-change-me").toString();
const branches = Object.freeze([
  { key: "Konongo", name: "Konongo" },
  { key: "Agogo", name: "Agogo" },
  { key: "Heroes Gate", name: "Heroes Gate" }
]);
const storeCategories = Object.freeze([
  "Smartphones & Mobiles",
  "Tablets",
  "Covers & Cases",
  "Chargers",
  "Cables",
  "Smart Watches",
  "Cameras",
  "Power Banks",
  "PlayStation",
  "Accessories"
]);
const defaultWhatsappPhone = (process.env.STORE_WHATSAPP_PHONE || process.env.WHATSAPP_PHONE || "").toString();
const storeSeoDescription =
  "DOT'S iCARE is a trusted phone and iPhone shop in Konongo, Ghana. Browse iPhones, Android phones, chargers, power banks, PlayStation consoles, smart watches, and accessories.";

function normalizeBranch(value) {
  const raw = (value || "").toString().trim().toLowerCase();
  const branch = branches.find((b) => b.key.toLowerCase() === raw);
  return branch ? branch.key : null;
}

function getBranchName(value) {
  const key = normalizeBranch(value);
  return branches.find((b) => b.key === key)?.name || "";
}

function renderLogin(res, { error = null, selectedBranch = "Konongo" } = {}) {
  res.render("auth/login", {
    error,
    branches,
    selectedBranch: normalizeBranch(selectedBranch) || "Konongo"
  });
}

function sessionPayload(req, branch) {
  return {
    userId: req.user.id,
    branch,
    exp: Date.now() + 1000 * 60 * 60 * 12
  };
}

function baseUrl(req) {
  const configured = (process.env.PUBLIC_SITE_URL || "").toString().trim().replace(/\/+$/, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host")}`;
}

function absoluteUrl(req, value) {
  if (!value) return `${baseUrl(req)}/public/logo.png`;
  const raw = value.toString().trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${baseUrl(req)}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

function slugify(value) {
  const slug = (value || "")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `item-${Date.now()}`;
}

function uniqueListingSlug(title, existingId = null) {
  const base = slugify(title);
  let slug = base;
  let count = 2;
  while (true) {
    const existing = db.prepare(`SELECT id FROM store_listings WHERE slug = @slug`).get({ slug });
    if (!existing || (existingId && existing.id === existingId)) return slug;
    slug = `${base}-${count++}`;
  }
}

function parseImageUrls(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => v.toString().trim()).filter(Boolean);
  const raw = value.toString().trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((v) => v.toString().trim()).filter(Boolean);
  } catch {
    // Newline/comma parsing below is the normal admin form path.
  }
  return raw
    .split(/\r?\n|,/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function stringifyImages(value) {
  return JSON.stringify(parseImageUrls(value));
}

function listingImages(row) {
  const images = parseImageUrls(row?.image_urls);
  return images.length > 0 ? images : ["/public/logo.png"];
}

function enrichListing(row, req = null) {
  const images = listingImages(row);
  return {
    ...row,
    images,
    first_image: images[0],
    absolute_first_image: req ? absoluteUrl(req, images[0]) : images[0],
    whatsapp_phone_digits: whatsappNumber(row.whatsapp_phone),
    specs_lines: (row.specs || "").split(/\r?\n/).map((v) => v.trim()).filter(Boolean)
  };
}

function whatsappNumber(value) {
  return (value || defaultWhatsappPhone || "").toString().replace(/[^\d]/g, "");
}

function storeItemUrl(req, listing) {
  return `${baseUrl(req)}/store/${listing.slug}`;
}

function whatsappLink(req, listing, imageUrl = null) {
  const phone = whatsappNumber(listing.whatsapp_phone);
  if (!phone) return "";
  const itemUrl = storeItemUrl(req, listing);
  const message = [
    `Hello DOT'S iCARE, I am interested in this item: ${listing.title}.`,
    `Product link: ${itemUrl}`,
    imageUrl ? `Selected image: ${absoluteUrl(req, imageUrl)}` : null,
    "Please send me the current price and availability."
  ]
    .filter(Boolean)
    .join("\n");
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

function getStoreListings({ branch = "Konongo", category = "", activeOnly = true } = {}) {
  const conditions = [];
  const params = {};
  const normalizedBranch = normalizeBranch(branch);
  if (normalizedBranch) {
    conditions.push("branch = @branch");
    params.branch = normalizedBranch;
  }
  if (category) {
    conditions.push("category = @category");
    params.category = category;
  }
  if (activeOnly) conditions.push("active = 1");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT *
       FROM store_listings
       ${where}
       ORDER BY featured DESC, id DESC`
    )
    .all(params);
}

function getStoreCategoryCards(branch) {
  const rows = getStoreListings({ branch, activeOnly: true });
  return storeCategories.map((name) => {
    const first = rows.find((row) => row.category === name);
    return {
      name,
      image: first ? listingImages(first)[0] : "/public/logo.png",
      count: rows.filter((row) => row.category === name).length
    };
  });
}

function readListingBody(body, branch) {
  return {
    branch: normalizeBranch(body.branch) || branch || "Konongo",
    title: (body.title || "").toString().trim(),
    category: storeCategories.includes((body.category || "").toString()) ? body.category.toString() : "Smartphones & Mobiles",
    specs: (body.specs || "").toString().trim() || null,
    description: (body.description || "").toString().trim() || null,
    image_urls: stringifyImages(body.image_urls),
    whatsapp_phone: (body.whatsapp_phone || "").toString().trim() || defaultWhatsappPhone || null,
    featured: body.featured === "on" ? 1 : 0,
    active: body.active === "on" || body.active === "1" ? 1 : 0
  };
}

function xmlEscape(value) {
  return value.toString().replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;"
  })[char]);
}

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) return result;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    result[k] = decodeURIComponent(rest.join("=") || "");
  }
  return result;
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(str) {
  const pad = 4 - (str.length % 4 || 4);
  const s = str + "=".repeat(pad);
  return Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

function hmac(input) {
  return base64UrlEncode(crypto.createHmac("sha256", sessionSecret).update(input).digest());
}

function setSessionCookie(res, payload) {
  const json = JSON.stringify(payload);
  const b64 = base64UrlEncode(json);
  const sig = hmac(b64);
  const value = `${b64}.${sig}`;
  res.setHeader(
    "Set-Cookie",
    `dotsicare_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "dotsicare_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
}

function findUserById(id) {
  return db.prepare(`SELECT id, name, role FROM users WHERE id = @id`).get({ id });
}

function findUserForLogin(name) {
  return db
    .prepare(`SELECT id, name, role, branch, password FROM users WHERE lower(name) = lower(@name)`)
    .get({ name });
}

function ensureRole(req, role) {
  return req.user && req.user.role === role;
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect("/login");
  if (!req.branch) {
    clearSessionCookie(res);
    return res.redirect("/login?branch=required");
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect("/login");
  if (!req.branch) {
    clearSessionCookie(res);
    return res.redirect("/login?branch=required");
  }
  if (!ensureRole(req, "Admin")) return res.status(403).send("Forbidden");
  next();
}

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies.dotsicare_session;
  req.user = null;
  req.branch = null;
  if (raw) {
    const token = raw.toString();
    const [b64, sig] = token.split(".");
    const expected = b64 ? hmac(b64) : "";
    if (b64 && sig && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      try {
        const payload = JSON.parse(base64UrlDecode(b64).toString("utf-8"));
        if (payload && payload.userId && (!payload.exp || payload.exp > Date.now())) {
          const user = findUserById(Number(payload.userId));
          const branch = normalizeBranch(payload.branch);
          if (user) {
            req.user = user;
            req.branch = branch;
          }
        }
      } catch {
        req.user = null;
        req.branch = null;
      }
    }
  }

  res.locals.currentUser = req.user;
  res.locals.currentBranch = req.branch ? { key: req.branch, name: getBranchName(req.branch) } : null;
  res.locals.branches = branches;
  res.locals.storeCategories = storeCategories;
  res.locals.siteName = "DOT'S iCARE";
  res.locals.defaultSeoDescription = storeSeoDescription;
  res.locals.jsonAttr = (value) => encodeURIComponent(JSON.stringify(value || []));
  res.locals.pendingCreditRequests = (req.user && req.user.role === 'Admin')
    ? db.prepare("SELECT COUNT(*) as cnt FROM credit_requests WHERE status = 'pending'").get().cnt
    : 0;

  // Birthday count for nav badge
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const now = new Date();
  const bdayMonth = monthNames[now.getMonth()];
  const bdayDay = now.getDate();
  res.locals.birthdayCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM customers
     WHERE branch = @branch
       AND birth_month = @todayMonth
       AND birth_day = @todayDay`
  ).get({ branch: req.branch, todayMonth: bdayMonth, todayDay: bdayDay }).cnt;
  next();
});

function currency(n) {
  if (n == null) return "";
  return new Intl.NumberFormat("en-GH").format(n);
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDateFilter(value) {
  const raw = (value || "").toString().trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function computeInstallmentStatus({ balance, dueDateIso }) {
  if (balance <= 0) return "PaidOff";
  const due = dueDateIso.slice(0, 10);
  return due < todayIsoDate() ? "Overdue" : "Active";
}

function hasAnyUsers() {
  return db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c > 0;
}

function getAdminUsers() {
  return db
    .prepare(
      `SELECT u.id, u.name, u.role, u.branch, u.created_at, COUNT(s.id) AS sale_count
       FROM users u
       LEFT JOIN sales s ON s.created_by_user_id = u.id
       GROUP BY u.id
       ORDER BY u.id DESC`
    )
    .all();
}

function renderAdminUsers(res, { status = 200, error = null, message = null, form = null } = {}) {
  const users = getAdminUsers();
  return res.status(status).render("admin/users", { users, error, message, form });
}

function normalizeStockBatchName(value) {
  const name = (value || "").toString().trim().replace(/\s+/g, " ");
  return name || "Opening Stock";
}

function findOrCreateStockBatch(branch, name, note = null) {
  const batchName = normalizeStockBatchName(name);
  const existing = db.prepare(`SELECT id FROM stock_batches WHERE branch = @branch AND name = @name`).get({
    branch,
    name: batchName
  });
  if (existing) return existing.id;

  try {
    const inserted = db
      .prepare(
        `INSERT INTO stock_batches (branch, name, note, created_at)
         VALUES (@branch, @name, @note, @created_at)`
      )
      .run({
        branch,
        name: batchName,
        note,
        created_at: nowIso()
      });
    return inserted.lastInsertRowid;
  } catch {
    return db.prepare(`SELECT id FROM stock_batches WHERE branch = @branch AND name = @name`).get({
      branch,
      name: batchName
    })?.id;
  }
}

function getStockBatches(branch) {
  return db.prepare(`SELECT * FROM stock_batches WHERE branch = @branch ORDER BY id DESC`).all({ branch });
}

function getDistinctDeviceValues(branch) {
  const models = db.prepare(`SELECT DISTINCT model FROM devices WHERE branch = @branch AND model IS NOT NULL AND model <> '' ORDER BY model`).all({ branch }).map((r) => r.model);
  const storages = db.prepare(`SELECT DISTINCT storage FROM devices WHERE branch = @branch AND storage IS NOT NULL AND storage <> '' ORDER BY storage`).all({ branch }).map((r) => r.storage);
  const colors = db.prepare(`SELECT DISTINCT color FROM devices WHERE branch = @branch AND color IS NOT NULL AND color <> '' ORDER BY color`).all({ branch }).map((r) => r.color);
  return { models, storages, colors };
}

function defaultStockBatchName() {
  const date = new Date();
  const month = date.toLocaleString("en", { month: "short" });
  return `${month} ${date.getFullYear()} Stock`;
}

function getBranchDashboard(branch) {
  const stock = db
    .prepare(
      `SELECT
         COUNT(*) AS total_items,
         COALESCE(SUM(CASE WHEN status = 'InStock' THEN 1 ELSE 0 END), 0) AS in_stock,
         COALESCE(SUM(CASE WHEN status = 'Sold' THEN 1 ELSE 0 END), 0) AS sold,
         COALESCE(SUM(CASE WHEN status = 'InStock' THEN cost_price ELSE 0 END), 0) AS inventory_value
       FROM devices
       WHERE branch = @branch`
    )
    .get({ branch });

  const sales = db
    .prepare(
      `SELECT
         COUNT(*) AS sales_count,
         COALESCE(SUM(s.sale_price - s.discount), 0) AS sales_value,
         COALESCE(SUM(d.cost_price), 0) AS sold_cost,
         COALESCE(SUM(COALESCE(ti.trade_in_value, 0)), 0) AS trade_in_credit
       FROM sales s
       JOIN devices d ON d.id = s.device_id
       LEFT JOIN trade_ins ti ON ti.sale_id = s.id
       WHERE s.branch = @branch AND s.is_returned = 0`
    )
    .get({ branch });

  const installmentBalance = db
    .prepare(
      `SELECT COALESCE(SUM(ip.balance), 0) AS balance
       FROM installment_plans ip
       JOIN sales s ON s.id = ip.sale_id
       WHERE s.branch = @branch AND ip.balance > 0`
    )
    .get({ branch }).balance;

  const batches = db
    .prepare(
      `SELECT
         sb.id,
         sb.name,
         sb.created_at,
         COUNT(d.id) AS total_items,
         COALESCE(SUM(CASE WHEN d.status = 'InStock' THEN 1 ELSE 0 END), 0) AS in_stock,
         COALESCE(SUM(CASE WHEN d.status = 'Sold' THEN 1 ELSE 0 END), 0) AS sold,
         COALESCE(SUM(CASE WHEN d.status = 'InStock' THEN d.cost_price ELSE 0 END), 0) AS inventory_value
       FROM stock_batches sb
       LEFT JOIN devices d ON d.stock_batch_id = sb.id AND d.branch = sb.branch
       WHERE sb.branch = @branch
       GROUP BY sb.id
       ORDER BY sb.id DESC
       LIMIT 6`
    )
    .all({ branch });

  const salesValue = sales.sales_value || 0;
  const soldCost = sales.sold_cost || 0;
  const tradeInCredit = sales.trade_in_credit || 0;
  return {
    ...stock,
    sales_count: sales.sales_count || 0,
    sales_value: salesValue,
    sold_cost: soldCost,
    trade_in_credit: tradeInCredit,
    cash_payable: Math.max(0, salesValue - tradeInCredit),
    gross_profit: salesValue - soldCost,
    installment_balance: installmentBalance || 0,
    batches
  };
}

function getProfitReport(branch, filters = {}) {
  const from = normalizeDateFilter(filters.from);
  const to = normalizeDateFilter(filters.to);
  const conditions = [`s.branch = @branch`, `s.is_returned = 0`];
  const params = { branch };

  if (from) {
    conditions.push(`substr(s.created_at, 1, 10) >= @from`);
    params.from = from;
  }

  if (to) {
    conditions.push(`substr(s.created_at, 1, 10) <= @to`);
    params.to = to;
  }

  const rows = db
    .prepare(
      `SELECT
         s.id,
         s.invoice_no,
         s.sale_type,
         s.sale_price,
         s.discount,
         s.created_at,
         c.name AS customer_name,
         d.model AS device_model,
         d.cost_price AS device_cost,
         COALESCE(ti.trade_in_value, 0) AS trade_in_value,
         COALESCE(p.cash_collected, 0) AS cash_collected,
         COALESCE(NULLIF(s.created_by_user_name, ''), u.name, 'Unknown') AS salesperson_name
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       JOIN devices d ON d.id = s.device_id
       LEFT JOIN trade_ins ti ON ti.sale_id = s.id
       LEFT JOIN users u ON u.id = s.created_by_user_id
       LEFT JOIN (
         SELECT sale_id, COALESCE(SUM(amount), 0) AS cash_collected
         FROM payments
         GROUP BY sale_id
       ) p ON p.sale_id = s.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.id DESC`
    )
    .all(params)
    .map((row) => {
      const grossSales = row.sale_price || 0;
      const discount = row.discount || 0;
      const netSales = Math.max(0, grossSales - discount);
      const deviceCost = row.device_cost || 0;
      const tradeInCredit = row.trade_in_value || 0;
      const cashExpected = Math.max(0, netSales - tradeInCredit);
      const cashCollected = row.cash_collected || 0;
      const outstandingCash = Math.max(0, cashExpected - cashCollected);
      const grossProfit = netSales - deviceCost;
      const margin = netSales > 0 ? (grossProfit / netSales) * 100 : 0;

      return {
        ...row,
        gross_sales: grossSales,
        net_sales: netSales,
        device_cost: deviceCost,
        trade_in_credit: tradeInCredit,
        cash_expected: cashExpected,
        cash_collected: cashCollected,
        outstanding_cash: outstandingCash,
        gross_profit: grossProfit,
        margin
      };
    });

  const summary = rows.reduce(
    (total, row) => ({
      sales_count: total.sales_count + 1,
      gross_sales: total.gross_sales + row.gross_sales,
      discounts: total.discounts + (row.discount || 0),
      net_sales: total.net_sales + row.net_sales,
      device_cost: total.device_cost + row.device_cost,
      trade_in_credit: total.trade_in_credit + row.trade_in_credit,
      cash_expected: total.cash_expected + row.cash_expected,
      cash_collected: total.cash_collected + row.cash_collected,
      outstanding_cash: total.outstanding_cash + row.outstanding_cash,
      gross_profit: total.gross_profit + row.gross_profit
    }),
    {
      sales_count: 0,
      gross_sales: 0,
      discounts: 0,
      net_sales: 0,
      device_cost: 0,
      trade_in_credit: 0,
      cash_expected: 0,
      cash_collected: 0,
      outstanding_cash: 0,
      gross_profit: 0
    }
  );

  summary.margin = summary.net_sales > 0 ? (summary.gross_profit / summary.net_sales) * 100 : 0;

  const salespersonMap = new Map();
  for (const row of rows) {
    const name = row.salesperson_name || "Unknown";
    const existing =
      salespersonMap.get(name) ||
      {
        salesperson_name: name,
        sales_count: 0,
        net_sales: 0,
        device_cost: 0,
        cash_collected: 0,
        outstanding_cash: 0,
        gross_profit: 0
      };

    existing.sales_count += 1;
    existing.net_sales += row.net_sales;
    existing.device_cost += row.device_cost;
    existing.cash_collected += row.cash_collected;
    existing.outstanding_cash += row.outstanding_cash;
    existing.gross_profit += row.gross_profit;
    existing.margin = existing.net_sales > 0 ? (existing.gross_profit / existing.net_sales) * 100 : 0;
    salespersonMap.set(name, existing);
  }

  const bySalesperson = Array.from(salespersonMap.values()).sort((a, b) => b.gross_profit - a.gross_profit);

  //  Monthly breakdown
  const monthMap = new Map();
  for (const row of rows) {
    const monthKey = (row.created_at || "").slice(0, 7); //  YYYY-MM
    if (!monthKey) continue;
    const existing =
      monthMap.get(monthKey) ||
      {
        month: monthKey,
        sales_count: 0,
        net_sales: 0,
        device_cost: 0,
        discount: 0,
        trade_in_credit: 0,
        cash_collected: 0,
        outstanding_cash: 0,
        gross_profit: 0
      };
    existing.sales_count += 1;
    existing.net_sales += row.net_sales;
    existing.device_cost += row.device_cost;
    existing.discount += (row.discount || 0);
    existing.trade_in_credit += row.trade_in_credit;
    existing.cash_collected += row.cash_collected;
    existing.outstanding_cash += row.outstanding_cash;
    existing.gross_profit += row.gross_profit;
    existing.margin = existing.net_sales > 0 ? (existing.gross_profit / existing.net_sales) * 100 : 0;
    monthMap.set(monthKey, existing);
  }

  const byMonth = Array.from(monthMap.values()).sort((a, b) => b.month.localeCompare(a.month));

  const monthLabels = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  for (const m of byMonth) {
    const parts = m.month.split("-");
    const monthIndex = parseInt(parts[1] || "0", 10) - 1;
    m.label = `${monthLabels[monthIndex] || ""} ${parts[0]}`;
  }

  return {
    filters: { from, to },
    rows,
    summary,
    bySalesperson,
    byMonth
  };
}

app.get("/setup", (req, res) => {
  if (hasAnyUsers()) return res.redirect("/login");
  res.render("auth/setup", { error: null });
});

app.post("/setup", (req, res) => {
  if (hasAnyUsers()) return res.redirect("/login");

  const name = (req.body.name || "").toString().trim();
  const password = (req.body.password || "").toString();
  if (!name || password.length < 6) {
    return res.status(400).render("auth/setup", { error: "Enter a username and password (6+ characters)." });
  }

  db.prepare(
    `INSERT INTO users (name, role, password, created_at)
     VALUES (@name, 'Admin', @password, @created_at)`
  ).run({ name, password, created_at: nowIso() });

  res.redirect("/login");
});

app.get("/login", (req, res) => {
  if (!hasAnyUsers()) return res.redirect("/setup");
  if (req.user && req.branch) return res.redirect(req.user.role === "Admin" ? "/admin" : "/sales");
  renderLogin(res, {
    error: req.query.branch === "required" ? "Choose the shop you are entering." : null
  });
});

app.post("/login", (req, res) => {
  if (!hasAnyUsers()) return res.redirect("/setup");

  const name = (req.body.name || "").toString().trim();
  const password = (req.body.password || "").toString();

  const user = findUserForLogin(name);
  if (!user || !user.password) {
    const branch = normalizeBranch(req.body.branch);
    return renderLogin(res.status(401), { error: "Invalid login.", selectedBranch: branch || undefined });
  }

  const ok = password === user.password;
  if (!ok) {
    const branch = normalizeBranch(req.body.branch);
    return renderLogin(res.status(401), { error: "Invalid login.", selectedBranch: branch || undefined });
  }

  // Employees are locked to their assigned branch; admins pick from the form
  var branch;
  if (user.role === "Employee") {
    branch = normalizeBranch(user.branch);
    if (!branch) {
      return renderLogin(res.status(400), { error: "Your account has no branch assigned. Ask an admin.", selectedBranch: undefined });
    }
  } else {
    branch = normalizeBranch(req.body.branch);
    if (!branch) {
      return renderLogin(res.status(400), { error: "Pick a shop.", selectedBranch: req.body.branch });
    }
  }

  setSessionCookie(res, { userId: user.id, branch, exp: Date.now() + 1000 * 60 * 60 * 12 });
  return res.redirect(user.role === "Admin" ? "/admin" : "/sales");
});

app.post("/branch", requireAuth, (req, res) => {
  // Employees cannot switch branches — locked to their assigned shop
  if (req.user.role === "Employee") {
    return res.status(403).send("Your branch is locked. Contact an admin to change it.");
  }

  const branch = normalizeBranch(req.body.branch);
  if (branch) setSessionCookie(res, sessionPayload(req, branch));
  // Redirect back to same page, or dashboard as fallback
  var back = (req.get("Referer") || "").toString();
  var host = (req.get("Host") || "").toString();
  if (back && host && back.indexOf(host) !== -1 && back.indexOf("/login") === -1) {
    res.redirect(back);
  } else {
    res.redirect("/dashboard");
  }
});

app.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.redirect("/login");
});

app.get("/", (req, res) => {
  const branch = normalizeBranch(req.query.branch) || "Konongo";
  const category = storeCategories.includes((req.query.category || "").toString()) ? req.query.category.toString() : "";
  const listings = getStoreListings({ branch, category, activeOnly: true }).map((row) => {
    const listing = enrichListing(row, req);
    return {
      ...listing,
      url: `/store/${listing.slug}`,
      absolute_url: storeItemUrl(req, listing),
      whatsapp_url: whatsappLink(req, listing)
    };
  });
  const categories = getStoreCategoryCards(branch);
  const canonical = `${baseUrl(req)}/`;
  const logoUrl = absoluteUrl(req, "/public/logo.png");
  const defaultWhatsappLink = `https://wa.me/${whatsappNumber(defaultWhatsappPhone)}?text=${encodeURIComponent("Hello DOT'S iCARE, I am interested in your products. Please send me your catalog or price list.")}`;

  res.render("store/home", {
    title: "DOT'S iCARE | Best iPhone & Phone Shop in Konongo, Ghana",
    description: storeSeoDescription,
    keywords: "iPhone shop Konongo, phone shop Ghana, best phone shop Konongo, DOT'S iCARE phones, chargers, power banks, PlayStation Ghana",
    canonical,
    ogTitle: "DOT'S iCARE Phone Shop in Konongo, Ghana",
    ogImage: logoUrl,
    ogType: "website",
    bodyClass: "store-body",
    listings,
    categories,
    selectedBranch: branch,
    selectedCategory: category,
    defaultWhatsapp: defaultWhatsappLink,
    whatsappPhone: whatsappNumber(defaultWhatsappPhone),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "ElectronicsStore",
      name: "DOT'S iCARE",
      url: canonical,
      logo: logoUrl,
      image: logoUrl,
      address: {
        "@type": "PostalAddress",
        addressLocality: branch,
        addressCountry: "GH"
      },
      areaServed: ["Konongo", "Agogo", "Heroes Gate", "Ghana"],
      description: storeSeoDescription,
      sameAs: []
    }
  });
});

app.get("/store", (req, res) => {
  res.redirect("/");
});

app.get("/store/:slug", (req, res) => {
  const row = db.prepare(`SELECT * FROM store_listings WHERE slug = @slug AND active = 1`).get({ slug: req.params.slug });
  if (!row) return res.status(404).send("Product not found");

  const item = enrichListing(row, req);
  const selectedImageIndex = Math.max(0, Math.min(Number(req.query.image || 0) || 0, item.images.length - 1));
  const selectedImage = item.images[selectedImageIndex] || item.first_image;
  const related = getStoreListings({ branch: item.branch, category: item.category, activeOnly: true })
    .filter((listing) => listing.id !== item.id)
    .slice(0, 4)
    .map((listing) => {
      const enriched = enrichListing(listing, req);
      return { ...enriched, url: `/store/${enriched.slug}`, whatsapp_url: whatsappLink(req, enriched) };
    });

  const whatsappBase = whatsappLink(req, item);
  res.render("store/detail", {
    title: `${item.title} | DOT'S iCARE Phone Shop Ghana`,
    description: `${item.title} at DOT'S iCARE ${item.branch}. Ask for current price and availability on WhatsApp. ${item.description || ""}`.slice(0, 155),
    keywords: `${item.title}, ${item.category}, phone shop Konongo, iPhone shop Ghana, DOT'S iCARE`,
    canonical: storeItemUrl(req, item),
    ogTitle: `${item.title} | DOT'S iCARE`,
    ogImage: absoluteUrl(req, selectedImage),
    ogType: "product",
    bodyClass: "store-body",
    item: {
      ...item,
      selected_image: selectedImage,
      selected_image_index: selectedImageIndex,
      whatsapp_url: whatsappLink(req, item, selectedImage),
      whatsapp_base: whatsappBase
    },
    related,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Product",
      name: item.title,
      image: item.images.map((image) => absoluteUrl(req, image)),
      description: item.description || item.specs || item.title,
      category: item.category,
      brand: {
        "@type": "Brand",
        name: "DOT'S iCARE"
      }
    }
  });
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
});

app.get("/sitemap.xml", (req, res) => {
  const listings = db.prepare(`SELECT slug, updated_at, created_at FROM store_listings WHERE active = 1 ORDER BY id DESC`).all();
  const urls = [
    { loc: `${baseUrl(req)}/`, lastmod: nowIso() },
    ...listings.map((listing) => ({
      loc: `${baseUrl(req)}/store/${listing.slug}`,
      lastmod: listing.updated_at || listing.created_at || nowIso()
    }))
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((url) => `  <url><loc>${xmlEscape(url.loc)}</loc><lastmod>${xmlEscape(url.lastmod.slice(0, 10))}</lastmod></url>`)
    .join("\n")}\n</urlset>\n`;
  res.type("application/xml").send(xml);
});

function normalizeModel(model) {
  if (!model) return model;
  var m = model.trim();
  var lower = m.toLowerCase();
  // Step 1: Fix brand prefix
  var brands = [
    ['iphone', 'iPhone'],
    ['ipad', 'iPad'],
    ['macbook', 'MacBook'],
    ['samsung galaxy', 'Samsung Galaxy'],
    ['samsung', 'Samsung'],
    ['google pixel', 'Google Pixel'],
    ['oneplus', 'OnePlus'],
    ['xiaomi', 'Xiaomi'],
    ['oppo', 'Oppo'],
    ['vivo', 'Vivo'],
    ['realme', 'Realme'],
    ['tecno', 'Tecno'],
    ['infinix', 'Infinix'],
    ['nokia', 'Nokia'],
    ['huawei', 'Huawei'],
    ['honor', 'Honor'],
    ['motorola', 'Motorola'],
    ['sony', 'Sony'],
    ['htc', 'HTC']
  ];
  for (var i = 0; i < brands.length; i++) {
    if (lower.startsWith(brands[i][0])) {
      m = brands[i][1] + m.slice(brands[i][0].length);
      break;
    }
  }
  // Step 2: Fix model suffixes (Pro Max, Plus, Ultra, FE, Lite, Mini, SE, etc.)
  var suffixFixes = [
    [/\bpro max\b/gi, 'Pro Max'],
    [/\bpro plus\b/gi, 'Pro Plus'],
    [/\bpro\b/g, 'Pro'],
    [/\bplus\b/gi, 'Plus'],
    [/\bultra\b/gi, 'Ultra'],
    [/\bfe\b/g, 'FE'],
    [/\blite\b/gi, 'Lite'],
    [/\bmini\b/gi, 'Mini'],
    [/\bmax\b/gi, 'Max'],
    [/\bse\b/gi, 'SE'],
    [/\bz fold\b/gi, 'Z Fold'],
    [/\bz flip\b/gi, 'Z Flip'],
    [/\bs(\d+)\b/gi, 'S$1'],
    [/\ba(\d+)\b/gi, 'A$1'],
    [/\bz(\d+)\b/gi, 'Z$1'],
    [/\bm(\d+)\b/gi, 'M$1'],
    [/\bp(\d+)\b/gi, 'P$1']
  ];
  for (var j = 0; j < suffixFixes.length; j++) {
    m = m.replace(suffixFixes[j][0], suffixFixes[j][1]);
  }
  return m;
}

function normalizeStorage(storage) {
  if (!storage) return storage;
  var s = storage.toString().trim();
  // Already has GB/TB suffix → just uppercase it
  if (/^\d+\s*(GB|TB|gb|tb)$/i.test(s)) {
    return s.replace(/\s*(gb|tb)$/i, function(_, unit) { return unit.toUpperCase(); });
  }
  // Bare number → append GB
  if (/^\d+$/.test(s)) {
    return s + 'GB';
  }
  return s;
}

function insertDeviceFromBody(body) {
  const branch = normalizeBranch(body.branch);
  var { model, storage, color, condition, cost_price, sale_price, imei1, imei2, stock_batch_name, product_type, os } = body;
  model = product_type === "Accessory" ? (model || "").toString().trim() : normalizeModel(model);
  model = model || null;
  storage = product_type === "Accessory" ? (storage || null) : normalizeStorage(storage);
  const cost = moneyToInt(cost_price);
  const sale = moneyToInt(sale_price);
  if (cost < 0 || sale < 0) return { ok: false, error: "Price cannot be negative" };
  let imeis = [imei1, imei2].map((v) => (v || "").trim()).filter(Boolean);
  // Auto-detect OS from model name when not explicitly provided
  var detectedOs = os || null;
  var detectedType = product_type || "Phone";
  var isAccessory = detectedType === "Accessory";
  if (!isAccessory && !detectedOs && model) {
    var m = model.toString().toLowerCase();
    if (m.includes("iphone") || m.includes("ipad") || m.includes("macbook") || m.includes("apple") ||
        m === "se" || m === "se2" || m === "se3") {
      detectedOs = "iOS";
    } else if (m.includes("samsung") || m.includes("galaxy") || m.includes("google pixel") ||
               m.includes("oneplus") || m.includes("xiaomi") || m.includes("oppo") ||
               m.includes("vivo") || m.includes("realme") || m.includes("tecno") ||
               m.includes("infinix") || m.includes("nokia") || m.includes("huawei") ||
               m.includes("honor") || m.includes("motorola") || m.includes("sony") ||
               m.includes("lg ") || m.includes("htc") || m.includes("android")) {
      detectedOs = "Android";
    }
  }

  if (!branch) {
    return { ok: false, error: "Pick a shop first." };
  }

  if (isAccessory) {
    // Accessories: model name + prices only — no IMEI or condition required
    condition = condition || "New";
    detectedOs = null;
    if (!model || cost == null || sale == null) {
      return { ok: false, error: "Accessory name, cost, and selling price are required." };
    }
  } else {
    if (!model || !condition || cost == null || sale == null || imeis.length === 0) {
      return { ok: false, error: "Model, condition, cost, price and IMEI are required." };
    }
  }

  // Skip IMEIs that already exist in the system to avoid UNIQUE constraint crash
  if (!isAccessory && imeis.length > 0) {
    var dupImeis = [];
    var freshImeis = [];
    for (var di = 0; di < imeis.length; di++) {
      var existing = db.prepare('SELECT imei FROM device_imeis WHERE imei = ?').get(imeis[di]);
      if (existing) {
        dupImeis.push(imeis[di]);
      } else {
        freshImeis.push(imeis[di]);
      }
    }
    if (freshImeis.length === 0) {
      return { ok: false, error: 'IMEI already in stock: ' + dupImeis.join(', ') };
    }
    imeis = freshImeis;
  }

  const tx = db.transaction(() => {
    const stockBatchId = findOrCreateStockBatch(branch, stock_batch_name, "Created from stock entry");
    const ins = db
      .prepare(
        `INSERT INTO devices (branch, stock_batch_id, model, storage, color, condition, cost_price, sale_price, status, created_by_user_id, created_at, product_type, os)
         VALUES (@branch, @stock_batch_id, @model, @storage, @color, @condition, @cost_price, @sale_price, 'InStock', @created_by_user_id, @created_at, @product_type, @os)`
      )
      .run({
        branch,
        stock_batch_id: stockBatchId,
        model,
        storage: storage || null,
        color: color || null,
        condition,
        cost_price: cost,
        sale_price: sale,
        product_type: detectedType,
        os: detectedOs,
        created_by_user_id: body.created_by_user_id || null,
        created_at: nowIso()
      });

    const deviceId = ins.lastInsertRowid;
    const stmt = db.prepare(`INSERT INTO device_imeis (device_id, imei, created_at) VALUES (@device_id, @imei, @created_at)`);
    for (const imei of imeis) {
      stmt.run({ device_id: deviceId, imei, created_at: nowIso() });
    }
  });

  try {
    tx();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function getDeviceWithImeis(id, branch) {
  return db
    .prepare(
      `SELECT d.*, d.product_type, d.os, sb.name AS stock_batch_name, group_concat(di.imei, ', ') AS imeis
       FROM devices d
       LEFT JOIN device_imeis di ON di.device_id = d.id
       LEFT JOIN stock_batches sb ON sb.id = d.stock_batch_id
       WHERE d.id = @id AND d.branch = @branch
       GROUP BY d.id`
    )
    .get({ id, branch });
}

function updateDeviceFromBody(id, branch, body) {
  var { model, storage, color, condition, cost_price, sale_price, imei1, imei2, stock_batch_name, product_type, os } = body;
  var isAccessory = (product_type || "").toString() === "Accessory";
  model = isAccessory ? (model || "").toString().trim() : normalizeModel(model);
  model = model || null;
  storage = isAccessory ? (storage || null) : normalizeStorage(storage);
  const cost = moneyToInt(cost_price);
  const sale = moneyToInt(sale_price);
  if (cost < 0 || sale < 0) return { ok: false, error: "Price cannot be negative" };
  const imeis = [imei1, imei2].map((v) => (v || "").trim()).filter(Boolean);

  // Auto-detect OS from model name when not explicitly provided
  var detectedOs = os || null;
  var detectedType = product_type || "Phone";
  if (!isAccessory && !detectedOs && model) {
    var m = model.toString().toLowerCase();
    if (m.includes("iphone") || m.includes("ipad") || m.includes("macbook") || m.includes("apple") ||
        m === "se" || m === "se2" || m === "se3") {
      detectedOs = "iOS";
    } else if (m.includes("samsung") || m.includes("galaxy") || m.includes("google pixel") ||
               m.includes("oneplus") || m.includes("xiaomi") || m.includes("oppo") ||
               m.includes("vivo") || m.includes("realme") || m.includes("tecno") ||
               m.includes("infinix") || m.includes("nokia") || m.includes("huawei") ||
               m.includes("honor") || m.includes("motorola") || m.includes("sony") ||
               m.includes("lg ") || m.includes("htc") || m.includes("android")) {
      detectedOs = "Android";
    }
  }

  if (isAccessory) {
    condition = condition || "New";
    detectedOs = null;
    if (!model || cost == null || sale == null) {
      return { ok: false, error: "Accessory name, cost, and selling price are required." };
    }
  } else {
    if (!model || !condition || cost == null || sale == null || imeis.length === 0) {
      return { ok: false, error: "Model, condition, cost, price and IMEI are required." };
    }
  }

  const existing = getDeviceWithImeis(id, branch);
  if (!existing) return { ok: false, error: "Stock item not found in this shop." };

  const tx = db.transaction(() => {
    const stockBatchId = findOrCreateStockBatch(branch, stock_batch_name, "Created while editing stock");
    db.prepare(
      `UPDATE devices
       SET model = @model,
           stock_batch_id = @stock_batch_id,
           storage = @storage,
           color = @color,
           condition = @condition,
           cost_price = @cost_price,
           sale_price = @sale_price,
           product_type = @product_type,
           os = @os
       WHERE id = @id AND branch = @branch`
    ).run({
      id,
      branch,
      stock_batch_id: stockBatchId,
      model,
      storage: storage || null,
      color: color || null,
      condition,
      cost_price: cost,
      sale_price: sale,
      product_type: detectedType,
      os: detectedOs
    });

    db.prepare(`DELETE FROM device_imeis WHERE device_id = @device_id`).run({ device_id: id });
    const stmt = db.prepare(`INSERT INTO device_imeis (device_id, imei, created_at) VALUES (@device_id, @imei, @created_at)`);
    for (const imei of imeis) {
      stmt.run({ device_id: id, imei, created_at: nowIso() });
    }
  });

  try {
    tx();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

app.get("/dashboard", requireAdmin, (req, res) => {
  var stockCounts = db.prepare(
    "SELECT product_type, os, COUNT(*) as cnt FROM devices WHERE branch = @branch AND status = 'InStock' GROUP BY product_type, os"
  ).all({ branch: req.branch });
  
  var inStock = { total: 0, iOS: 0, Android: 0, Accessory: 0 };
  var sold = db.prepare(
    "SELECT COUNT(*) as cnt FROM devices WHERE branch = @branch AND status = 'Sold'"
  ).get({ branch: req.branch })?.cnt || 0;
  
  stockCounts.forEach(function(r) {
    var cat = r.product_type === 'Accessory' ? 'Accessory' : r.os === 'iOS' ? 'iOS' : r.os === 'Android' ? 'Android' : 'Other';
    if (cat === 'iOS') inStock.iOS += r.cnt;
    else if (cat === 'Android') inStock.Android += r.cnt;
    else if (cat === 'Accessory') inStock.Accessory += r.cnt;
    inStock.total += r.cnt;
  });
  
  var lastSale = db.prepare(
    "SELECT s.*, d.model, d.storage, c.name as customer_name FROM sales s LEFT JOIN devices d ON s.device_id = d.id LEFT JOIN customers c ON s.customer_id = c.id WHERE s.branch = @branch ORDER BY s.id DESC LIMIT 5"
  ).all({ branch: req.branch });
  if (!hasAnyUsers()) return res.redirect("/setup");
  const dashboard = getBranchDashboard(req.branch);

  const overdueCount = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM installment_plans ip
       JOIN sales s ON s.id = ip.sale_id
       WHERE s.branch = @branch
         AND ip.status IN ('Active','Overdue')
         AND ip.balance > 0
         AND substr(ip.due_date,1,10) < @today`
    )
    .get({ branch: req.branch, today: todayIsoDate() }).c;

  var todayDate = todayIsoDate();
  var todaySales = db.prepare(
    `SELECT s.*, d.model, d.storage, c.name as customer_name
     FROM sales s
     LEFT JOIN devices d ON s.device_id = d.id
     LEFT JOIN customers c ON s.customer_id = c.id
     WHERE s.branch = @branch AND substr(s.created_at, 1, 10) = @today
     ORDER BY s.id DESC`
  ).all({ branch: req.branch, today: todayDate });

  var todayCount = todaySales.length;
  var todayRevenue = todaySales.reduce(function(sum, s) {
    return sum + Math.max(0, (s.sale_price || 0) - (s.discount || 0));
  }, 0);

  const pendingCreditRequests = db.prepare("SELECT COUNT(*) as cnt FROM credit_requests WHERE status = 'pending'").get().cnt;

  // Birthday alert — customers with birthday today
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const now = new Date();
  const todayMonth = monthNames[now.getMonth()];
  const todayDay = now.getDate();
  const birthdayCustomers = db.prepare(
    `SELECT id, name, phone, birth_day, birth_month FROM customers
     WHERE branch = @branch
       AND birth_month = @todayMonth
       AND birth_day = @todayDay`
  ).all({ branch: req.branch, todayMonth, todayDay });

  res.render("home", { inStock, soldCount: sold, lastSales: lastSale || [], counts: dashboard, dashboard, overdueCount, todaySales, todayCount, todayRevenue, todayDate, currency, lowStockThreshold, pendingCreditRequests, birthdayCustomers });
});

// ─── DASHBOARD API: per-model breakdown ───
app.get("/api/dashboard/models", requireAuth, (req, res) => {
  var status = (req.query.status || "InStock").toString();
  var type = (req.query.type || "").toString();

  if (!["InStock", "Sold"].includes(status)) status = "InStock";

  var sql = "SELECT d.model, d.product_type, d.os, COUNT(*) as cnt FROM devices d WHERE d.branch = @branch AND d.status = @status";
  var params = { branch: req.branch, status: status };

  if (type === "iOS") {
    sql += " AND d.product_type != 'Accessory' AND lower(d.os) = 'ios'";
  } else if (type === "Android") {
    sql += " AND d.product_type != 'Accessory' AND lower(d.os) = 'android'";
  } else if (type === "Accessory") {
    sql += " AND d.product_type = 'Accessory'";
  }

  sql += " GROUP BY d.model ORDER BY cnt DESC";

  var rows = db.prepare(sql).all(params);
  res.json(rows);
});

// ─── Stock Lookup API (for Add Stock live search) ───
app.get("/api/stock-lookup", requireAuth, (req, res) => {
  var q = (req.query.q || "").toString().trim().toLowerCase();
  if (!q) return res.json([]);
  var rows = db.prepare(
    "SELECT d.model, d.storage, COUNT(*) as cnt FROM devices d WHERE d.branch = @branch AND d.status = 'InStock' AND lower(d.model) LIKE @q GROUP BY d.model, COALESCE(d.storage,'')"
  ).all({ branch: req.branch, q: '%' + q + '%' });
  res.json(rows);
});

app.get("/admin", requireAdmin, (req, res) => {
  const recentStock = db
    .prepare(
      `SELECT d.*, d.product_type, d.os, sb.name AS stock_batch_name, group_concat(di.imei, ', ') AS imeis
       FROM devices d
       LEFT JOIN device_imeis di ON di.device_id = d.id
       LEFT JOIN stock_batches sb ON sb.id = d.stock_batch_id
       WHERE d.branch = @branch
       GROUP BY d.id
       ORDER BY d.id DESC
       LIMIT 10`
    )
    .all({ branch: req.branch });

  // Birthday alert — customers with birthday today
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const today = new Date();
  const birthdayCustomers = db.prepare(
    `SELECT id, name, phone, birth_day, birth_month FROM customers
     WHERE branch = @branch
       AND birth_month = @todayMonth
       AND birth_day = @todayDay`
  ).all({ branch: req.branch, todayMonth: monthNames[today.getMonth()], todayDay: today.getDate() });

  const ok = req.query.ok === "1";
  const users = db.prepare(`SELECT id, name, role, created_at FROM users ORDER BY id DESC`).all();
  res.render("admin/dashboard", {
    error: null,
    ok,
    recentStock,
    currency,
    users,
    userOk: req.query.user_ok === "1",
    userError: null,
    form: null,
    batches: getStockBatches(req.branch),
    defaultBatchName: defaultStockBatchName(),
    birthdayCustomers
  });
});

app.post("/admin/store/upload", requireAdmin, upload.array("images", 10), (req, res) => {
  const urls = (req.files || []).map((f) => `/public/uploads/${f.filename}`);
  res.json({ urls });
});

app.get("/admin/store", requireAdmin, (req, res) => {
  const listings = getStoreListings({ branch: req.branch, activeOnly: false }).map((row) => enrichListing(row, req));
  res.render("admin/store", {
    listings,
    categories: storeCategories,
    error: null,
    message:
      req.query.created === "1"
        ? "Website post created."
        : req.query.updated === "1"
          ? "Website post updated."
          : req.query.deleted === "1"
            ? "Website post deleted."
            : null,
    form: {
      branch: req.branch,
      category: "Smartphones & Mobiles",
      whatsapp_phone: defaultWhatsappPhone,
      active: 1,
      featured: 0
    }
  });
});

app.post("/admin/store", requireAdmin, (req, res) => {
  const form = readListingBody(req.body, req.branch);
  const images = parseImageUrls(form.image_urls);
  const listings = getStoreListings({ branch: req.branch, activeOnly: false }).map((row) => enrichListing(row, req));

  if (!form.title || images.length === 0) {
    return res.status(400).render("admin/store", {
      listings,
      categories: storeCategories,
      error: "Add a title and at least 1 image.",
      message: null,
      form: { ...form, image_urls: images.join("\n") }
    });
  }

  const slug = uniqueListingSlug(form.title);
  db.prepare(
    `INSERT INTO store_listings
      (branch, title, slug, category, specs, description, image_urls, whatsapp_phone, featured, active, created_by_user_id, created_at, updated_at)
     VALUES
      (@branch, @title, @slug, @category, @specs, @description, @image_urls, @whatsapp_phone, @featured, @active, @created_by_user_id, @created_at, @updated_at)`
  ).run({
    ...form,
    slug,
    created_by_user_id: req.user.id,
    created_at: nowIso(),
    updated_at: nowIso()
  });

  res.redirect("/admin/store?created=1");
});

app.get("/admin/store/:id/edit", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM store_listings WHERE id = @id AND branch = @branch`).get({ id, branch: req.branch });
  if (!row) return res.status(404).send("Website post not found");
  res.render("admin/store-edit", {
    item: { ...row, image_urls: listingImages(row).join("\n") },
    categories: storeCategories,
    error: null
  });
});

app.post("/admin/store/:id/edit", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM store_listings WHERE id = @id AND branch = @branch`).get({ id, branch: req.branch });
  if (!existing) return res.status(404).send("Website post not found");

  const form = readListingBody(req.body, req.branch);
  const images = parseImageUrls(form.image_urls);
  if (!form.title || images.length === 0) {
    return res.status(400).render("admin/store-edit", {
      item: { ...existing, ...form, image_urls: images.join("\n") },
      categories: storeCategories,
      error: "Add a title and at least 1 image."
    });
  }

  const slug = uniqueListingSlug(form.title, id);
  db.prepare(
    `UPDATE store_listings
     SET branch = @branch,
         title = @title,
         slug = @slug,
         category = @category,
         specs = @specs,
         description = @description,
         image_urls = @image_urls,
         whatsapp_phone = @whatsapp_phone,
         featured = @featured,
         active = @active,
         updated_at = @updated_at
     WHERE id = @id`
  ).run({
    ...form,
    slug,
    updated_at: nowIso(),
    id
  });

  res.redirect("/admin/store?updated=1");
});

app.post("/admin/store/:id/toggle", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const listing = db.prepare(`SELECT * FROM store_listings WHERE id = @id AND branch = @branch`).get({ id, branch: req.branch });
  if (listing) {
    db.prepare(`UPDATE store_listings SET active = @active, updated_at = @updated_at WHERE id = @id`).run({
      active: listing.active ? 0 : 1,
      updated_at: nowIso(),
      id
    });
  }
  res.redirect("/admin/store?updated=1");
});

app.post("/admin/store/:id/delete", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM store_listings WHERE id = @id AND branch = @branch`).run({ id, branch: req.branch });
  res.redirect("/admin/store?deleted=1");
});

app.post("/admin/stock", requireAdmin, (req, res) => {
  const recentStock = db
    .prepare(
      `SELECT d.*, d.product_type, d.os, sb.name AS stock_batch_name, group_concat(di.imei, ', ') AS imeis
       FROM devices d
       LEFT JOIN device_imeis di ON di.device_id = d.id
       LEFT JOIN stock_batches sb ON sb.id = d.stock_batch_id
       WHERE d.branch = @branch
       GROUP BY d.id
       ORDER BY d.id DESC
       LIMIT 10`
    )
    .all({ branch: req.branch });

  const result = insertDeviceFromBody({ ...req.body, branch: req.branch, created_by_user_id: req.user.id });
  if (!result.ok) {
    const users = db.prepare(`SELECT id, name, role, created_at FROM users ORDER BY id DESC`).all();
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const today = new Date();
    const birthdayCustomers = db.prepare(
      `SELECT id, name, phone, birth_day, birth_month FROM customers
       WHERE branch = @branch
         AND birth_month = @todayMonth
         AND birth_day = @todayDay`
    ).all({ branch: req.branch, todayMonth: monthNames[today.getMonth()], todayDay: today.getDate() });
    return res.status(400).render("admin/dashboard", {
      error: result.error,
      ok: false,
      recentStock,
      currency,
      users,
      birthdayCustomers,
      userOk: false,
      userError: null,
      batches: getStockBatches(req.branch),
      defaultBatchName: normalizeStockBatchName(req.body.stock_batch_name) || defaultStockBatchName(),
      form: {
        model: (req.body.model || "").toString(),
        storage: (req.body.storage || "").toString(),
        color: (req.body.color || "").toString(),
        condition: (req.body.condition || "").toString(),
        cost_price: (req.body.cost_price || "").toString(),
        sale_price: (req.body.sale_price || "").toString(),
        imei1: (req.body.imei1 || "").toString(),
        imei2: (req.body.imei2 || "").toString(),
        product_type: (req.body.product_type || "").toString(),
        os: (req.body.os || "").toString(),
        stock_batch_name: (req.body.stock_batch_name || "").toString()
      }
    });
  }
  res.redirect("/admin?ok=1");
});

app.get("/admin/bulk", requireAdmin, (req, res) => {
  const dv = getDistinctDeviceValues(req.branch);
  res.render("admin/bulk-stock", {
    error: null,
    ok: null,
    batches: getStockBatches(req.branch),
    defaultBatchName: defaultStockBatchName(),
    models: dv.models,
    storages: dv.storages,
    colors: dv.colors
  });
});

app.post("/admin/bulk", requireAdmin, (req, res) => {
  const branch = normalizeBranch(req.branch);
  const stockBatchName = normalizeStockBatchName(req.body.stock_batch_name) || defaultStockBatchName();

  // qs (extended:true) parses row[0][model] → req.body.row = [{model:...}, ...]
  const rawRows = Array.isArray(req.body.row) ? req.body.row : [];

  const validRows = rawRows.filter(
    (r) => r && String(r.model || "").trim() && String(r.condition || "").trim() && String(r.imei1 || "").trim()
  );

  if (validRows.length === 0) {
    const dv = getDistinctDeviceValues(branch);
    return res.status(400).render("admin/bulk-stock", {
      error: "Each row needs model, condition, and IMEI.",
      ok: null,
      batches: getStockBatches(branch),
      defaultBatchName: stockBatchName,
      models: dv.models,
      storages: dv.storages,
      colors: dv.colors,
      formRows: rawRows.map((r) => ({
        model: (r.model || "").toString(),
        storage: (r.storage || "").toString(),
        color: (r.color || "").toString(),
        product_type: (r.product_type || "Phone").toString(),
        os: (r.os || "").toString(),
        condition: (r.condition || "").toString(),
        cost_price: (r.cost_price || "").toString(),
        sale_price: (r.sale_price || "").toString(),
        imei1: (r.imei1 || "").toString(),
        imei2: (r.imei2 || "").toString()
      }))
    });
  }

  const results = [];
  const errors = [];
  const failedRows = [];

  for (const row of validRows) {
    const result = insertDeviceFromBody({
      branch,
      model: String(row.model || "").trim(),
      storage: String(row.storage || "").trim() || null,
      color: String(row.color || "").trim() || null,
      condition: String(row.condition || "").trim(),
      cost_price: row.cost_price || 0,
      sale_price: row.sale_price || 0,
      imei1: String(row.imei1 || "").trim(),
      imei2: String(row.imei2 || "").trim() || null,
      stock_batch_name: stockBatchName,
      product_type: row.product_type || 'Phone',
      os: row.os || null,
      created_by_user_id: req.user.id
    });
    if (result.ok) {
      results.push(row.model);
    } else {
      errors.push((row.model || "Unknown") + ": " + result.error);
      failedRows.push(row);
    }
  }

  const dv = getDistinctDeviceValues(branch);
  res.render("admin/bulk-stock", {
    error: errors.length ? errors.join("; ") : null,
    ok: results,
    batches: getStockBatches(branch),
    defaultBatchName: stockBatchName,
    models: dv.models,
    storages: dv.storages,
    colors: dv.colors,
    formRows: failedRows.map((r) => ({
      model: (r.model || "").toString(),
      storage: (r.storage || "").toString(),
      color: (r.color || "").toString(),
      product_type: (r.product_type || "Phone").toString(),
      os: (r.os || "").toString(),
      condition: (r.condition || "").toString(),
      cost_price: (r.cost_price || "").toString(),
      sale_price: (r.sale_price || "").toString(),
      imei1: (r.imei1 || "").toString(),
      imei2: (r.imei2 || "").toString()
    }))
  });
});

app.get("/admin/users", requireAdmin, (req, res) => {
  const message =
    req.query.created === "1"
      ? "User created successfully!"
      : req.query.password === "1"
        ? "Password updated successfully!"
        : req.query.deleted === "1"
          ? "User deleted."
          : req.query.edited === "1"
            ? "User updated successfully!"
            : null;
  renderAdminUsers(res, { message });
});

app.post("/admin/users", requireAdmin, (req, res) => {
  const name = (req.body.name || "").toString().trim();
  const role = (req.body.role || "").toString().trim();
  const password = (req.body.password || "").toString();
  const employeeBranch = normalizeBranch(req.body.employee_branch);

  // Only Employee accounts can be created — admin is locked to Boss
  if (!name || role !== "Employee" || password.length < 6) {
    return renderAdminUsers(res, { status: 400, error: "Please enter a username, choose a role, and use a password of at least 6 characters.", form: { name, role: "Employee", employee_branch: employeeBranch || "" } });
  }

  if (role === "Employee" && !employeeBranch) {
    return renderAdminUsers(res, { status: 400, error: "An employee needs a branch — please pick one from the dropdown.", form: { name, role, employee_branch: "" } });
  }

  const existing = db.prepare(`SELECT id FROM users WHERE lower(name) = lower(@name)`).get({ name });
  if (existing) {
    return renderAdminUsers(res, { status: 400, error: "That username is already taken — try a different one.", form: { name, role, employee_branch: employeeBranch || "" } });
  }

  try {
    db.prepare(
      `INSERT INTO users (name, role, branch, password, created_at)
       VALUES (@name, @role, @branch, @password, @created_at)`
    ).run({ name, role, branch: employeeBranch || null, password, created_at: nowIso() });
    res.redirect("/admin/users?created=1");
  } catch (e) {
    renderAdminUsers(res, { status: 400, error: String(e.message || e) });
  }
});

app.post("/admin/users/:id/password", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const password = (req.body.password || "").toString();
  const target = findUserById(id);

  if (!target) return renderAdminUsers(res, { status: 404, error: "User not found." });
  if (password.length < 6) {
    return renderAdminUsers(res, { status: 400, error: "Password must be at least 6 characters, please." });
  }

  db.prepare(
    `UPDATE users
     SET password = @password
     WHERE id = @id`
  ).run({ id, password });

  res.redirect("/admin/users?password=1");
});

app.post("/admin/users/:id/edit", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const target = findUserById(id);
  if (!target) return renderAdminUsers(res, { status: 404, error: "Hmm, that user doesn't exist." });

  const name = (req.body.name || "").toString().trim();
  const role = (req.body.role || "").toString().trim();
  const employeeBranch = normalizeBranch(req.body.employee_branch);

  // Employees can only stay Employee — no new admin accounts allowed
  const allowedRoles = target.role === "Admin" ? ["Admin", "Employee"] : ["Employee"];
  if (!name || !allowedRoles.includes(role)) {
    return renderAdminUsers(res, { status: 400, error: "Please enter a username and choose a role." });
  }

  if (role === "Employee" && !employeeBranch) {
    return renderAdminUsers(res, { status: 400, error: "An employee needs a branch — please pick one." });
  }

  // Check if name is taken by someone else
  const dup = db.prepare(`SELECT id FROM users WHERE lower(name) = lower(@name) AND id != @id`).get({ name, id });
  if (dup) {
    return renderAdminUsers(res, { status: 400, error: "That username is already taken by someone else." });
  }

  // Prevent demoting last admin
  if (target.role === "Admin" && role !== "Admin") {
    const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'Admin'`).get().c;
    if (adminCount <= 1) {
      return renderAdminUsers(res, { status: 400, error: "You can't change this user — there must be at least one admin." });
    }
  }

  db.prepare(
    `UPDATE users SET name = @name, role = @role, branch = @branch WHERE id = @id`
  ).run({ id, name, role, branch: role === "Employee" ? employeeBranch : null });

  res.redirect("/admin/users?edited=1");
});

app.post("/admin/users/:id/delete", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const target = findUserById(id);

  if (!target) return renderAdminUsers(res, { status: 404, error: "Hmm, that user doesn't exist." });
  if (target.id === req.user.id) {
    return renderAdminUsers(res, { status: 400, error: "You can't delete your own account, silly!" });
  }
  if (target.role === "Admin") {
    const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'Admin'`).get().c;
    if (adminCount <= 1) {
      return renderAdminUsers(res, { status: 400, error: "You need at least one admin — can't delete the last one." });
    }
  }

  db.prepare(`DELETE FROM users WHERE id = @id`).run({ id });
  res.redirect("/admin/users?deleted=1");
});

app.get("/reports/profit", requireAdmin, (req, res) => {
  const report = getProfitReport(req.branch, {
    from: req.query.from,
    to: req.query.to
  });

  res.render("reports/profit", { report, currency });
});


app.get("/inventory/summary", requireAuth, (req, res) => {
  const items = db
    .prepare(
      `SELECT d.model, d.storage, d.color, d.product_type, d.os, MIN(d.sale_price) as sale_price,
         COUNT(DISTINCT CASE WHEN d.status='InStock' THEN d.id END) as in_stock,
         COUNT(DISTINCT CASE WHEN d.status='Sold' THEN d.id END) as sold,
         group_concat(CASE WHEN d.status='InStock' THEN di.imei END, ', ') AS imeis
       FROM devices d LEFT JOIN device_imeis di ON di.device_id = d.id
       WHERE d.branch = @branch
       GROUP BY d.model, COALESCE(d.storage,''), COALESCE(d.color,''), d.product_type, COALESCE(d.os,'')
       ORDER BY d.product_type, d.os, d.model, d.storage`
    )
    .all({ branch: req.branch });

  var inStock = { total: 0, iOS: 0, Android: 0, Accessory: 0, byModel: {}, byModelType: {}, byModelOnly: {}, byModelOnlyType: {} };
  var sold = { total: 0, iOS: 0, Android: 0, Accessory: 0, byModel: {}, byModelType: {}, byModelOnly: {}, byModelOnlyType: {} };

  items.forEach(function(d) {
    var key = d.model + " " + (d.storage||"");
    var modelKey = d.model;
    var cat = d.product_type === "Accessory" ? "Accessory" : d.os === "iOS" ? "iOS" : d.os === "Android" ? "Android" : "Other";
    var inCnt = d.in_stock || 0;
    var soldCnt = d.sold || 0;

    if (inCnt > 0) {
      inStock.total += inCnt;
      if (cat === "iOS") inStock.iOS += inCnt;
      else if (cat === "Android") inStock.Android += inCnt;
      else if (cat === "Accessory") inStock.Accessory += inCnt;
      if (!inStock.byModel[key]) inStock.byModel[key] = 0;
      inStock.byModel[key] += inCnt;
      inStock.byModelType[key] = cat;
      if (!inStock.byModelOnly[modelKey]) inStock.byModelOnly[modelKey] = 0;
      inStock.byModelOnly[modelKey] += inCnt;
      inStock.byModelOnlyType[modelKey] = cat;
    }

    if (soldCnt > 0) {
      sold.total += soldCnt;
      if (cat === "iOS") sold.iOS += soldCnt;
      else if (cat === "Android") sold.Android += soldCnt;
      else if (cat === "Accessory") sold.Accessory += soldCnt;
      if (!sold.byModel[key]) sold.byModel[key] = 0;
      sold.byModel[key] += soldCnt;
      sold.byModelType[key] = cat;
      if (!sold.byModelOnly[modelKey]) sold.byModelOnly[modelKey] = 0;
      sold.byModelOnly[modelKey] += soldCnt;
      sold.byModelOnlyType[modelKey] = cat;
    }
  });

  res.render("inventory/summary", { inStock, sold, branch: getBranchName(req.branch) });
});

app.get("/inventory", requireAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 20;
  const offset = (page - 1) * perPage;

  const countRow = db
    .prepare(
      `SELECT COUNT(*) as total FROM (
         SELECT d.model, d.storage, d.sale_price
         FROM devices d
         WHERE d.branch = @branch
         GROUP BY d.model, d.storage, d.sale_price
       )`
    )
    .get({ branch: req.branch });
  const totalCount = countRow ? countRow.total : 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));

  const items = db
    .prepare(
      `SELECT MIN(d.id) AS id, d.model, d.storage, d.color, d.product_type, d.os, d.sale_price,
              SUM(CASE WHEN d.status = 'InStock' OR d.status = 'Returned' THEN 1 ELSE 0 END) as in_stock,
              SUM(CASE WHEN d.status = 'Sold' THEN 1 ELSE 0 END) as sold
       FROM devices d
       WHERE d.branch = @branch
       GROUP BY d.model, d.storage, d.sale_price
       ORDER BY d.model, d.storage
       LIMIT @limit OFFSET @offset`
    )
    .all({ branch: req.branch, limit: perPage, offset });
  res.render("inventory/list", {
    items,
    currency,
    page, perPage, totalPages, totalCount,
    lowStockThreshold,
    message: req.query.updated === "1" ? "Stock updated successfully." : req.query.deleted === "1" ? "Stock deleted successfully." : null,
    error: req.query.error || null
  });
});

app.get("/inventory/new", requireAdmin, (req, res) => {
  const dv = getDistinctDeviceValues(req.branch);
  res.render("inventory/new", {
    form: null,
    error: null,
    batches: getStockBatches(req.branch),
    defaultBatchName: defaultStockBatchName(),
    models: dv.models
  });
});

app.post("/inventory/new", requireAdmin, (req, res) => {
  const result = insertDeviceFromBody({ ...req.body, branch: req.branch, created_by_user_id: req.user.id });
  if (!result.ok) {
    const dv = getDistinctDeviceValues(req.branch);
    return res.status(400).render("inventory/new", {
      error: result.error,
      batches: getStockBatches(req.branch),
      defaultBatchName: normalizeStockBatchName(req.body.stock_batch_name),
      models: dv.models,
      form: {
        model: (req.body.model || "").toString(),
        storage: (req.body.storage || "").toString(),
        color: (req.body.color || "").toString(),
        condition: (req.body.condition || "").toString(),
        cost_price: (req.body.cost_price || "").toString(),
        sale_price: (req.body.sale_price || "").toString(),
        imei1: (req.body.imei1 || "").toString(),
        imei2: (req.body.imei2 || "").toString(),
        product_type: (req.body.product_type || "").toString(),
        os: (req.body.os || "").toString()
      }
    });
  }
  res.redirect("/inventory");
});

// ─── ACCESSORIES ───
app.get("/inventory/accessory/new", requireAdmin, (req, res) => {
  res.render("inventory/accessory-new", {
    form: null,
    error: null
  });
});

app.post("/inventory/accessory/new", requireAdmin, (req, res) => {
  var quantity = Math.max(1, Math.min(100, parseInt(req.body.quantity) || 1));
  var formData = {
    model: (req.body.model || "").toString(),
    cost_price: (req.body.cost_price || "").toString(),
    sale_price: (req.body.sale_price || "").toString(),
    quantity: quantity
  };
  for (var i = 0; i < quantity; i++) {
    var body = { ...req.body, branch: req.branch, created_by_user_id: req.user.id, product_type: "Accessory" };
    var result = insertDeviceFromBody(body);
    if (!result.ok) {
      return res.status(400).render("inventory/accessory-new", {
        error: result.error,
        form: formData
      });
    }
  }
  res.redirect("/inventory?added=" + quantity);
});

app.get("/inventory/:id/edit", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const item = getDeviceWithImeis(id, req.branch);
  if (!item) return res.status(404).send("Stock item not found");

  const dv = getDistinctDeviceValues(req.branch);
  const imeis = (item.imeis || "").split(",").map((v) => v.trim()).filter(Boolean);
  res.render("inventory/edit", {
    item: { ...item, imei1: imeis[0] || "", imei2: imeis[1] || "" },
    error: null,
    batches: getStockBatches(req.branch),
    models: dv.models
  });
});

app.post("/inventory/:id/edit", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const result = updateDeviceFromBody(id, req.branch, req.body);
  if (!result.ok) {
    const item = getDeviceWithImeis(id, req.branch);
    if (!item) return res.status(404).send("Stock item not found");
    const dv = getDistinctDeviceValues(req.branch);
    return res.status(400).render("inventory/edit", {
      item: { ...item, ...req.body },
      error: result.error,
      batches: getStockBatches(req.branch),
      models: dv.models
    });
  }
  res.redirect("/inventory?updated=1");
});

app.post("/inventory/:id/delete", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare(`SELECT * FROM devices WHERE id = @id AND branch = @branch`).get({ id, branch: req.branch });
  if (!item) return res.redirect("/inventory?error=" + encodeURIComponent("Stock item not found."));

  const linkedSale = db.prepare(`SELECT id FROM sales WHERE device_id = @id AND branch = @branch LIMIT 1`).get({ id, branch: req.branch });
  if (linkedSale || item.status !== "InStock") {
    return res.render("inventory/edit", {
      currentBranch: req.currentBranch,
      branch: req.branch,
      branches: allBranches(),
      item: formatDevice(item),
      models: distinctDeviceModels(req.branch),
      error: "This item is linked to a sale and cannot be deleted. Only InStock items (without sales) can be removed."
    });
  }

  db.prepare(`DELETE FROM device_imeis WHERE device_id = @id`).run({ id });
  db.prepare(`DELETE FROM devices WHERE id = @id AND branch = @branch`).run({ id, branch: req.branch });
  res.redirect("/inventory?deleted=1");
});

app.get("/customers", requireAuth, (req, res) => {
  const customers = db.prepare(`SELECT * FROM customers WHERE branch = @branch AND (customer_type IS NULL OR customer_type = 'Customer') ORDER BY id DESC`).all({ branch: req.branch });
  const dealers = db.prepare(`SELECT * FROM customers WHERE branch = @branch AND customer_type = 'Dealer' ORDER BY id DESC`).all({ branch: req.branch });
  res.render("customers/list", { customers, dealers, message: req.query.updated ? "Customer updated." : null });
});

app.get("/customers/new", requireAuth, (req, res) => {
  res.render("customers/new", { form: null, error: null });
});

app.post("/customers/new", requireAuth, (req, res) => {
  const { name, phone, address, id_type, id_number, customer_type, ghana_card, id_held, birth_day, birth_month } = req.body;
  if (!name || !phone) return res.status(400).render("customers/new", {
    error: "Enter name and phone.",
    form: {
      name: (name || "").toString(),
      phone: (phone || "").toString(),
      address: (address || "").toString(),
      ghana_card: (ghana_card || "").toString(),
      customer_type: (customer_type || "Customer").toString(),
      id_held: (id_held === "1" || id_held === "on"),
      birth_day: Number(birth_day) || null,
      birth_month: birth_month || null
    }
  });
  const type = customer_type === "Dealer" ? "Dealer" : "Customer";
  const card = String(ghana_card || "").trim() || null;
  const holdId = id_held === "1" || id_held === "on";
  const bday = Number(birth_day) || null;
  const bmonth = birth_month || null;
  db.prepare(
    `INSERT INTO customers (branch, name, phone, address, id_type, id_number, customer_type, ghana_card, id_held, id_held_at, birth_day, birth_month, created_at)
     VALUES (@branch, @name, @phone, @address, @id_type, @id_number, @customer_type, @ghana_card, @id_held, @id_held_at, @birth_day, @birth_month, @created_at)`
  ).run({
    branch: req.branch,
    name,
    phone,
    address: address || null,
    id_type: id_type || null,
    id_number: id_number || null,
    customer_type: type,
    ghana_card: card,
    id_held: holdId ? 1 : 0,
    id_held_at: holdId ? nowIso() : null,
    birth_day: bday,
    birth_month: bmonth,
    created_at: nowIso()
  });
  res.redirect("/customers");
});

app.get("/customers/:id/edit", requireAuth, (req, res) => {
  const customer = db.prepare(`SELECT * FROM customers WHERE id = @id AND branch = @branch`).get({ id: Number(req.params.id), branch: req.branch });
  if (!customer) return res.status(404).send("Customer not found");
  res.render("customers/edit", { customer, error: null });
});

app.post("/customers/:id/edit", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const customer = db.prepare(`SELECT * FROM customers WHERE id = @id AND branch = @branch`).get({ id, branch: req.branch });
  if (!customer) return res.status(404).send("Customer not found");

  const { name, phone, address, id_type, id_number, customer_type, ghana_card, id_held, birth_day, birth_month } = req.body;
  if (!name || !phone) return res.status(400).render("customers/edit", {
    customer: { ...customer, name: (name||"").toString(), phone: (phone||"").toString(), address: (address||"").toString(), customer_type: (customer_type||"Customer").toString(), ghana_card: (ghana_card||"").toString(), id_held: (id_held === "1" || id_held === "on") ? 1 : 0, birth_day: Number(birth_day) || null, birth_month: birth_month || null },
    error: "Enter name and phone."
  });
  const type = customer_type === "Dealer" ? "Dealer" : "Customer";
  const card = String(ghana_card || "").trim() || null;
  const holdId = id_held === "1" || id_held === "on";
  const bday = Number(birth_day) || null;
  const bmonth = birth_month || null;
  db.prepare(
    `UPDATE customers SET name = @name, phone = @phone, address = @address, id_type = @id_type, id_number = @id_number, customer_type = @customer_type, ghana_card = @ghana_card, id_held = @id_held, id_held_at = @id_held_at, birth_day = @birth_day, birth_month = @birth_month WHERE id = @id AND branch = @branch`
  ).run({
    name, phone,
    address: address || null,
    id_type: id_type || null,
    id_number: id_number || null,
    customer_type: type,
    ghana_card: card,
    id_held: holdId ? 1 : 0,
    id_held_at: holdId ? nowIso() : null,
    birth_day: bday,
    birth_month: bmonth,
    id,
    branch: req.branch
  });
  res.redirect("/customers?updated=1");
});

app.get("/sales", requireAuth, (req, res) => {
  var filterToday = req.query.today === "1";
  var fromDate = req.query.from || "";
  var toDate = req.query.to || "";
  var searchMonth = req.query.month || "";
  var searchCustomer = (req.query.customer || "").trim();
  var searchSalesperson = (req.query.salesperson || "").trim();
  var showReturned = req.query.show_returned === "1";
  var page = Math.max(1, parseInt(req.query.page) || 1);
  var perPage = 20;
  var offset = (page - 1) * perPage;

  var conditions = [];
  var params = { branch: req.branch };

  if (showReturned) {
    conditions.push("s.is_returned = 1");
  } else {
    conditions.push("s.is_returned = 0");
  }
  if (filterToday) {
    conditions.push("substr(s.created_at, 1, 10) = @today");
    params.today = todayIsoDate();
  }
  if (fromDate) {
    conditions.push("date(s.created_at) >= @fromDate");
    params.fromDate = fromDate;
  }
  if (toDate) {
    conditions.push("date(s.created_at) <= @toDate");
    params.toDate = toDate;
  }
  if (searchMonth) {
    conditions.push("substr(s.created_at, 1, 7) = @searchMonth");
    params.searchMonth = searchMonth;
  }
  if (searchCustomer) {
    conditions.push("c.name LIKE @searchCustomer");
    params.searchCustomer = "%" + searchCustomer + "%";
  }
  if (searchSalesperson) {
    conditions.push("COALESCE(NULLIF(s.created_by_user_name, ''), u.name, 'Unknown') = @searchSalesperson");
    params.searchSalesperson = searchSalesperson;
  }

  var filterSql = conditions.length > 0 ? " AND " + conditions.join(" AND ") : "";

  var countRow = db
    .prepare(
      `SELECT COUNT(*) as total
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.branch = @branch${filterSql}`
    )
    .get(params);
  var totalCount = countRow ? countRow.total : 0;
  var totalPages = Math.max(1, Math.ceil(totalCount / perPage));

  params.limit = perPage;
  params.offset = offset;

  const sales = db
    .prepare(
      `SELECT s.*,
              c.name AS customer_name,
              d.model AS device_model,
              COALESCE(NULLIF(s.created_by_user_name, ''), u.name, 'Unknown') AS salesperson_name,
              (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       JOIN devices d ON d.id = s.device_id
       LEFT JOIN users u ON u.id = s.created_by_user_id
       WHERE s.branch = @branch${filterSql}
       ORDER BY s.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all(params);
  const trade = db
    .prepare(
      `SELECT ti.sale_id, ti.trade_in_value
       FROM trade_ins ti
       JOIN sales s ON s.id = ti.sale_id
       WHERE s.branch = @branch`
    )
    .all({ branch: req.branch });
  const tradeMap = new Map(trade.map((t) => [t.sale_id, t.trade_in_value]));
  const enriched = sales.map((s) => {
    const net = Math.max(0, s.sale_price - s.discount);
    const tradeValue = tradeMap.get(s.id) || 0;
    const payable = Math.max(0, net - tradeValue);
    return { ...s, net, trade_in_value: tradeValue, payable };
  });
  const salesUsers = db.prepare(`SELECT DISTINCT COALESCE(NULLIF(s.created_by_user_name, ''), u.name, 'Unknown') AS name FROM sales s LEFT JOIN users u ON u.id = s.created_by_user_id WHERE s.branch = @branch ORDER BY name`).all({ branch: req.branch }).map(r => r.name);
  res.render("sales/list", { sales: enriched, currency, filterToday, fromDate, toDate, searchMonth, searchCustomer, searchSalesperson, salesUsers, showReturned, page, perPage, totalPages, totalCount });
});

app.get("/sales/new", requireAuth, (req, res) => {
  const devices = db
    .prepare(
      `SELECT d.*, d.product_type, d.os, sb.name AS stock_batch_name, group_concat(di.imei, ', ') AS imeis
       FROM devices d
       LEFT JOIN device_imeis di ON di.device_id = d.id
       LEFT JOIN stock_batches sb ON sb.id = d.stock_batch_id
       WHERE d.branch = @branch AND d.status = 'InStock'
       GROUP BY d.id
       ORDER BY d.id DESC`
    )
    .all({ branch: req.branch });
  const customers = db.prepare(`SELECT * FROM customers WHERE branch = @branch ORDER BY customer_type DESC, name ASC`).all({ branch: req.branch });
  res.render("sales/new", { devices, customers, error: null });
});

app.post("/sales/new", requireAuth, (req, res) => {
  const {
    customer_id,
    create_customer,
    customer_name,
    customer_phone,
    customer_address,
    customer_id_type,
    customer_id_number,
    customer_type,
    ghana_card,
    id_held,
    sale_type,
    sale_price,
    discount,
    down_payment,
    payment_method,
    trade_model,
    trade_storage,
    trade_color,
    trade_condition,
    trade_in_value,
    trade_imei1,
    trade_imei2
  } = req.body;

  // --- PARSE CART ITEMS ---
  let cartDevices = req.body.devices || [];
  let cartPrices = req.body.prices || [];
  let cartDiscounts = req.body.item_discounts || [];
  let cartQuantities = req.body.quantities || [];
  // Ensure arrays (express may send single value if only one item)
  if (!Array.isArray(cartDevices)) cartDevices = [cartDevices];
  if (!Array.isArray(cartPrices)) cartPrices = [cartPrices];
  if (!Array.isArray(cartDiscounts)) cartDiscounts = [cartDiscounts];
  if (!Array.isArray(cartQuantities)) cartQuantities = [cartQuantities];

  // Build cart items
  const cartItems = cartDevices.map((did, i) => ({
    device_id: Number(did),
    unit_price: moneyToInt(cartPrices[i] || 0) || 0,
    discount: moneyToInt(cartDiscounts[i] || 0) || 0,
    quantity: Math.max(1, parseInt(cartQuantities[i]) || 1)
  })).filter(item => item.device_id > 0 && item.unit_price > 0);

  const totalSalePrice = cartItems.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
  const totalDiscount = cartItems.reduce((sum, item) => sum + item.discount, 0);
  const firstDeviceId = cartItems.length > 0 ? cartItems[0].device_id : 0;

  const normalizedTradeModel = normalizeModel(trade_model);
  const deviceId = firstDeviceId;
  const selectedCustomerId = Number(customer_id);
  const shouldCreateCustomer = create_customer === "on";
  const newCustomerName = (customer_name || "").toString().trim();
  const newCustomerPhone = (customer_phone || "").toString().trim();
  const newCustomerAddress = (customer_address || "").toString().trim() || null;
  const newCustomerIdType = (customer_id_type || "").toString().trim() || null;
  const newCustomerIdNumber = (customer_id_number || "").toString().trim() || null;
  const salePrice = totalSalePrice;
  const discountInt = totalDiscount;
  const downPaymentInt = moneyToInt(down_payment || 0) ?? 0;
  const tradeValueInt = moneyToInt(trade_in_value || 0) ?? 0;
  const isSwap = sale_type === "SwapFull" || sale_type === "SwapInstallment";
  const isInstallment = sale_type === "Installment" || sale_type === "SwapInstallment";

  const devices = db
    .prepare(
      `SELECT d.*, d.product_type, d.os, sb.name AS stock_batch_name, group_concat(di.imei, ', ') AS imeis
       FROM devices d
       LEFT JOIN device_imeis di ON di.device_id = d.id
       LEFT JOIN stock_batches sb ON sb.id = d.stock_batch_id
       WHERE d.branch = @branch AND d.status = 'InStock'
       GROUP BY d.id
       ORDER BY d.id DESC`
    )
    .all({ branch: req.branch });
  const customers = db.prepare(`SELECT * FROM customers WHERE branch = @branch ORDER BY customer_type DESC, name ASC`).all({ branch: req.branch });

  const formData = {
    sale_type: sale_type || "",
    product_type: (req.body.product_type || "Phone").toString(),
    device_os: (req.body.device_os || "").toString(),
    device_id: deviceId || 0,
    customer_id: selectedCustomerId || 0,
    create_customer: shouldCreateCustomer,
    customer_name: newCustomerName,
    customer_phone: newCustomerPhone,
    customer_address: newCustomerAddress || "",
    ghana_card: (ghana_card || "").toString(),
    id_held: id_held === "1" || id_held === "on",
    sale_price: (sale_price || "").toString(),
    discount: (discount || "").toString(),
    down_payment: (down_payment || "").toString(),
    payment_method: (payment_method || "Cash").toString(),
    trade_model: (trade_model || "").toString(),
    trade_storage: (trade_storage || "").toString(),
    trade_color: (trade_color || "").toString(),
    trade_condition: (trade_condition || "").toString(),
    trade_in_value: (trade_in_value || "").toString(),
    trade_imei1: (trade_imei1 || "").toString(),
    trade_imei2: (trade_imei2 || "").toString(),
    cart: cartItems.map(item => {
      const d = db.prepare(`SELECT model, storage, color, condition FROM devices WHERE id = @id`).get({ id: item.device_id });
      return {
        device_id: item.device_id,
        model: d ? d.model : 'Unknown',
        variant: d ? [d.storage, d.color, d.condition].filter(Boolean).join(' / ') : '',
        imeis: '',
        unit_price: item.unit_price,
        discount: item.discount,
        quantity: item.quantity
      };
    })
  };

  if (cartItems.length === 0 || !sale_type || salePrice == null) {
    return res.status(400).render("sales/new", { devices, customers, form: formData, error: "Add at least one device to cart, select a sale type, and enter prices." });
  }

  if (shouldCreateCustomer) {
    if (!newCustomerName || !newCustomerPhone) {
      return res.status(400).render("sales/new", { devices, customers, form: formData, error: "Enter customer name and phone." });
    }
    if (isInstallment && !String(ghana_card || "").trim()) {
      return res.status(400).render("sales/new", { devices, customers, form: formData, error: "Ghana Card is required for installment." });
    }
  } else {
    if (!selectedCustomerId) {
      return res.status(400).render("sales/new", { devices, customers, form: formData, error: "Pick a customer or click '+ New'." });
    }
    const selectedCustomer = db
      .prepare(`SELECT * FROM customers WHERE id = @id AND branch = @branch`)
      .get({ id: selectedCustomerId, branch: req.branch });
    if (!selectedCustomer) {
      return res.status(400).render("sales/new", { devices, customers, form: formData, error: "Customer not in this shop." });
    }
    if (isInstallment && !(selectedCustomer.ghana_card || "").trim() && !String(req.body.ghana_card_existing || req.body.ghana_card || "").trim()) {
      return res.status(400).render("sales/new", { devices, customers, form: formData, error: "This customer has no Ghana Card. Enter it below." });
    }
  }

  if (!["Full", "Installment", "SwapFull", "SwapInstallment"].includes(sale_type)) {
    return res.status(400).render("sales/new", { devices, customers, form: formData, error: "Choose a sale type." });
  }

  const tradeImeis = [trade_imei1, trade_imei2].map((v) => (v || "").trim()).filter(Boolean);
  if (isSwap) {
    if (!normalizedTradeModel || !trade_condition || tradeValueInt <= 0 || tradeImeis.length === 0) {
      return res.status(400).render("sales/new", { devices, customers, form: formData, error: "Swap needs model, condition, value, and at least 1 IMEI." });
    }
  }

  // Validate all cart devices are in stock
  for (const item of cartItems) {
    const d = db.prepare(`SELECT * FROM devices WHERE id = @id AND branch = @branch`).get({ id: item.device_id, branch: req.branch });
    if (!d || d.status !== "InStock") {
      return res.status(400).render("sales/new", { devices, customers, form: formData, error: `Device #${item.device_id} is no longer in stock. Remove it from cart and try again.` });
    }
  }
  const firstDevice = db.prepare(`SELECT * FROM devices WHERE id = @id AND branch = @branch`).get({ id: firstDeviceId, branch: req.branch });

  const invoiceNo = `INV-${Date.now()}`;

  const tx = db.transaction(() => {
    let customerId = selectedCustomerId;
    if (shouldCreateCustomer) {
      const dealerType = customer_type === "Dealer" ? "Dealer" : "Customer";
      const card = String(ghana_card || "").trim() || null;
      const holdId = id_held === "1" || id_held === "on";
      const insCustomer = db
        .prepare(
          `INSERT INTO customers (branch, name, phone, address, id_type, id_number, customer_type, ghana_card, id_held, id_held_at, created_at)
           VALUES (@branch, @name, @phone, @address, @id_type, @id_number, @customer_type, @ghana_card, @id_held, @id_held_at, @created_at)`
        )
        .run({
          branch: req.branch,
          name: newCustomerName,
          phone: newCustomerPhone,
          address: newCustomerAddress,
          id_type: newCustomerIdType,
          id_number: newCustomerIdNumber,
          customer_type: dealerType,
          ghana_card: card,
          id_held: holdId ? 1 : 0,
          id_held_at: holdId ? nowIso() : null,
          created_at: nowIso()
        });
      customerId = insCustomer.lastInsertRowid;
    }

    // Update existing customer's Ghana Card if provided via inline field
    const ghanaCardExisting = String(req.body.ghana_card_existing || req.body.ghana_card || "").trim();
    if (!shouldCreateCustomer && ghanaCardExisting) {
      db.prepare(`UPDATE customers SET ghana_card = @card WHERE id = @id AND branch = @branch`).run({
        card: ghanaCardExisting,
        id: customerId,
        branch: req.branch
      });
    }

    const saleIns = db
      .prepare(
        `INSERT INTO sales (branch, invoice_no, sale_type, customer_id, device_id, sale_price, discount, created_by_user_id, created_by_user_name, created_at)
         VALUES (@branch, @invoice_no, @sale_type, @customer_id, @device_id, @sale_price, @discount, @created_by_user_id, @created_by_user_name, @created_at)`
      )
      .run({
        branch: req.branch,
        invoice_no: invoiceNo,
        sale_type,
        customer_id: customerId,
        device_id: firstDeviceId,
        sale_price: salePrice,
        discount: discountInt,
        created_by_user_id: req.user.id,
        created_by_user_name: req.user.name,
        created_at: nowIso()
      });

    const saleId = saleIns.lastInsertRowid;

    // Insert all cart items and mark each device as Sold
    const stmtItem = db.prepare(
      `INSERT INTO sale_items (sale_id, device_id, unit_price, discount, created_at)
       VALUES (@sale_id, @device_id, @unit_price, @discount, @created_at)`
    );
    const stmtSold = db.prepare(`UPDATE devices SET status = 'Sold' WHERE id = @id AND branch = @branch`);
    for (const item of cartItems) {
      const itemDiscount = Math.round(item.discount / item.quantity); // split discount across units
      // Sell each individual device (quantity may be >1 for accessories)
      let devicesToSell = [{ id: item.device_id }];
      if (item.quantity > 1) {
        // Find additional InStock devices of the same model
        const modelRow = db.prepare(`SELECT model FROM devices WHERE id = @id`).get({ id: item.device_id });
        if (modelRow) {
          const extras = db.prepare(
            `SELECT id FROM devices WHERE branch = @branch AND model = @model AND status = 'InStock' AND id != @id ORDER BY id LIMIT @limit`
          ).all({ branch: req.branch, model: modelRow.model, id: item.device_id, limit: item.quantity - 1 });
          for (const ext of extras) devicesToSell.push(ext);
        }
        if (devicesToSell.length < item.quantity) {
          throw new Error(`Not enough "${modelRow?.model || 'Unknown'}" in stock. Need ${item.quantity}, have ${devicesToSell.length}.`);
        }
      }
      for (const dev of devicesToSell) {
        stmtItem.run({
          sale_id: saleId,
          device_id: dev.id,
          unit_price: item.unit_price,
          discount: itemDiscount,
          created_at: nowIso()
        });
        stmtSold.run({ id: dev.id, branch: req.branch });
      }
    }

    const net = Math.max(0, salePrice - discountInt);
    const payable = Math.max(0, net - (isSwap ? tradeValueInt : 0));

    if (isSwap) {
      const ti = db
        .prepare(
          `INSERT INTO trade_ins (sale_id, device_model, storage, color, device_condition, trade_in_value, created_at)
           VALUES (@sale_id, @device_model, @storage, @color, @device_condition, @trade_in_value, @created_at)`
        )
        .run({
          sale_id: saleId,
          device_model: normalizedTradeModel,
          storage: trade_storage || null,
          color: trade_color || null,
          device_condition: trade_condition,
          trade_in_value: tradeValueInt,
          created_at: nowIso()
        });

      const tradeInId = ti.lastInsertRowid;
      const stmtTi = db.prepare(`INSERT INTO trade_in_imeis (trade_in_id, imei, created_at) VALUES (@trade_in_id, @imei, @created_at)`);
      for (const imei of tradeImeis) {
        stmtTi.run({ trade_in_id: tradeInId, imei, created_at: nowIso() });
      }

      // Auto-detect OS for trade-in device so it appears in sales tabs
      var tradeOs = null;
      if (normalizedTradeModel) {
        var m = normalizedTradeModel.toString().toLowerCase();
        if (m.includes("iphone") || m.includes("ipad") || m.includes("macbook") || m.includes("apple") ||
            m === "se" || m === "se2" || m === "se3") {
          tradeOs = "iOS";
        } else if (m.includes("samsung") || m.includes("galaxy") || m.includes("google pixel") ||
                   m.includes("oneplus") || m.includes("xiaomi") || m.includes("oppo") ||
                   m.includes("vivo") || m.includes("realme") || m.includes("tecno") ||
                   m.includes("infinix") || m.includes("nokia") || m.includes("huawei") ||
                   m.includes("honor") || m.includes("motorola") || m.includes("sony") ||
                   m.includes("lg ") || m.includes("htc") || m.includes("android")) {
          tradeOs = "Android";
        }
      }

      const inv = db
        .prepare(
          `INSERT INTO devices (branch, stock_batch_id, model, storage, color, condition, cost_price, sale_price, status, created_by_user_id, created_at, os)
           VALUES (@branch, @stock_batch_id, @model, @storage, @color, @condition, @cost_price, @sale_price, 'InStock', @created_by_user_id, @created_at, @os)`
        )
        .run({
          branch: req.branch,
          stock_batch_id: findOrCreateStockBatch(req.branch, "Trade-ins", "Phones received through swap sales"),
          model: normalizedTradeModel,
          storage: trade_storage || null,
          color: trade_color || null,
          condition: trade_condition,
          cost_price: tradeValueInt,
          sale_price: tradeValueInt,
          os: tradeOs,
          created_by_user_id: req.user.id,
          created_at: nowIso()
        });

      const tradeDeviceId = inv.lastInsertRowid;
      const stmtImei = db.prepare(`INSERT INTO device_imeis (device_id, imei, created_at) VALUES (@device_id, @imei, @created_at)`);
      for (const imei of tradeImeis) {
        stmtImei.run({ device_id: tradeDeviceId, imei, created_at: nowIso() });
      }
    }

    if (isInstallment) {
      const dp2 = Math.min(payable, downPaymentInt);
      const balance = Math.max(0, payable - dp2);
      const start = new Date();
      const due = addMonths(start, 3);

      db.prepare(
        `INSERT INTO installment_plans (sale_id, down_payment, balance, start_date, due_date, status)
         VALUES (@sale_id, @down_payment, @balance, @start_date, @due_date, @status)`
      ).run({
        sale_id: saleId,
        down_payment: dp2,
        balance,
        start_date: start.toISOString(),
        due_date: due.toISOString(),
        status: computeInstallmentStatus({ balance, dueDateIso: due.toISOString() })
      });

      if (dp2 > 0) {
        db.prepare(
          `INSERT INTO payments (sale_id, amount, method, reference, created_by_user_id, paid_at)
           VALUES (@sale_id, @amount, @method, @reference, @created_by_user_id, @paid_at)`
        ).run({
          sale_id: saleId,
          amount: dp2,
          method: payment_method || "Cash",
          reference: null,
          created_by_user_id: req.user.id,
          paid_at: nowIso()
        });
      }

      const customer = db.prepare(`SELECT * FROM customers WHERE id = @id AND branch = @branch`).get({ id: customerId, branch: req.branch });
      if (customer && customer.id_held === 0) {
        db.prepare(`UPDATE customers SET id_held = 1, id_held_at = @at WHERE id = @id AND branch = @branch`).run({
          at: nowIso(),
          id: customerId,
          branch: req.branch
        });
      }
    } else {
      db.prepare(
        `INSERT INTO payments (sale_id, amount, method, reference, created_by_user_id, paid_at)
         VALUES (@sale_id, @amount, @method, @reference, @created_by_user_id, @paid_at)`
      ).run({
        sale_id: saleId,
        amount: payable,
        method: payment_method || "Cash",
        reference: null,
        created_by_user_id: req.user.id,
        paid_at: nowIso()
      });
    }
  });

  try {
    tx();
    res.redirect("/sales");
  } catch (e) {
    res.status(400).render("sales/new", { devices, customers, form: formData, error: String(e.message || e) });
  }
});

// ── CSV EXPORTS ──────────────────────────────────────────────
app.get("/sales/export", requireAuth, (req, res) => {
  var filterToday = req.query.today === "1";
  var fromDate = req.query.from || "";
  var toDate = req.query.to || "";
  var searchMonth = req.query.month || "";
  var searchCustomer = (req.query.customer || "").trim();
  var searchSalesperson = (req.query.salesperson || "").trim();
  var showReturned = req.query.show_returned === "1";

  var conditions = [];
  var params = { branch: req.branch };
  if (showReturned) {
    conditions.push("s.is_returned = 1");
  } else {
    conditions.push("s.is_returned = 0");
  }
  if (filterToday) { conditions.push("substr(s.created_at, 1, 10) = @today"); params.today = todayIsoDate(); }
  if (fromDate) { conditions.push("date(s.created_at) >= @fromDate"); params.fromDate = fromDate; }
  if (toDate) { conditions.push("date(s.created_at) <= @toDate"); params.toDate = toDate; }
  if (searchMonth) { conditions.push("substr(s.created_at, 1, 7) = @searchMonth"); params.searchMonth = searchMonth; }
  if (searchCustomer) { conditions.push("c.name LIKE @searchCustomer"); params.searchCustomer = "%" + searchCustomer + "%"; }
  if (searchSalesperson) { conditions.push("COALESCE(NULLIF(s.created_by_user_name, ''), u.name, 'Unknown') = @searchSalesperson"); params.searchSalesperson = searchSalesperson; }
  var filterSql = conditions.length > 0 ? " AND " + conditions.join(" AND ") : "";

  const rows = db.prepare(
    `SELECT s.id, s.invoice_no, c.name AS customer_name, c.phone AS customer_phone,
            d.model AS device_model, d.product_type,
            COALESCE(NULLIF(s.created_by_user_name, ''), u.name, 'Unknown') AS salesperson_name,
            s.sale_type, s.sale_price, s.discount,
            s.created_at, s.is_returned
     FROM sales s
     JOIN customers c ON c.id = s.customer_id
     JOIN devices d ON d.id = s.device_id
     LEFT JOIN users u ON u.id = s.created_by_user_id
     WHERE s.branch = @branch${filterSql}
     ORDER BY s.id DESC`
  ).all(params);

  const tradeMap = new Map();
  const trades = db.prepare(`SELECT ti.sale_id, ti.trade_in_value FROM trade_ins ti JOIN sales s ON s.id = ti.sale_id WHERE s.branch = @branch`).all({ branch: req.branch });
  trades.forEach(t => tradeMap.set(t.sale_id, t.trade_in_value));

  const csvRows = [];
  csvRows.push(["Invoice", "Customer", "Phone", "Device", "Type", "Salesperson", "Sale Type", "Price", "Discount", "Trade-in", "Net", "Date", "Returned"].map(esc).join(","));
  for (const r of rows) {
    const tradeVal = tradeMap.get(r.id) || 0;
    const net = Math.max(0, r.sale_price - r.discount) - tradeVal;
    csvRows.push([
      r.invoice_no, r.customer_name, r.customer_phone, r.device_model, r.product_type,
      r.salesperson_name, r.sale_type, r.sale_price, r.discount, tradeVal, net,
      (r.created_at || "").slice(0, 10), r.is_returned ? "Yes" : "No"
    ].map(esc).join(","));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=sales_" + todayIsoDate() + ".csv");
  res.send("\uFEFF" + csvRows.join("\n"));
});

app.get("/sales/:id", requireAuth, (req, res) => {
  const saleId = Number(req.params.id);
  const sale = db
    .prepare(
      `SELECT s.*,
              c.name AS customer_name,
              c.phone AS customer_phone,
              d.model AS device_model,
              COALESCE(NULLIF(s.created_by_user_name, ''), u.name, 'Unknown') AS salesperson_name,
              (SELECT group_concat(di.imei, ', ') FROM device_imeis di WHERE di.device_id = d.id) AS device_imeis
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       JOIN devices d ON d.id = s.device_id
       LEFT JOIN users u ON u.id = s.created_by_user_id
       WHERE s.id = @id AND s.branch = @branch`
    )
    .get({ id: saleId, branch: req.branch });

  if (!sale) return res.status(404).send("Sale not found");

  // Fetch all sale items (cart)
  const saleItems = db
    .prepare(
      `SELECT si.*, d.model, d.storage, d.color, d.condition, d.product_type,
              (SELECT group_concat(di.imei, ', ') FROM device_imeis di WHERE di.device_id = d.id) AS imeis
       FROM sale_items si
       JOIN devices d ON d.id = si.device_id
       WHERE si.sale_id = @sale_id
       ORDER BY si.id`
    )
    .all({ sale_id: saleId });

  const plan = db.prepare(`SELECT * FROM installment_plans WHERE sale_id = @sale_id`).get({ sale_id: saleId });
  const payments = db.prepare(`SELECT * FROM payments WHERE sale_id = @sale_id ORDER BY id DESC`).all({ sale_id: saleId });
  const tradeIn = db
    .prepare(
      `SELECT ti.*, group_concat(tii.imei, ', ') AS imeis
       FROM trade_ins ti
       LEFT JOIN trade_in_imeis tii ON tii.trade_in_id = ti.id
       WHERE ti.sale_id = @sale_id
       GROUP BY ti.id`
    )
    .get({ sale_id: saleId });

  const returnRecord = db.prepare(`SELECT * FROM returns WHERE sale_id = @sale_id`).get({ sale_id: saleId });

  let exchangeSale = null;
  if (returnRecord && returnRecord.exchange_sale_id) {
    exchangeSale = db.prepare(`
      SELECT s.*, d.model AS device_model,
             (SELECT group_concat(di.imei, ', ') FROM device_imeis di WHERE di.device_id = d.id) AS device_imeis
      FROM sales s
      JOIN devices d ON d.id = s.device_id
      WHERE s.id = @id
    `).get({ id: returnRecord.exchange_sale_id });
  }

  const net = Math.max(0, sale.sale_price - sale.discount);
  const tradeValue = tradeIn ? tradeIn.trade_in_value : 0;
  const payable = Math.max(0, net - tradeValue);

  res.render("sales/detail", {
    sale, saleItems, plan, payments, tradeIn, returnRecord, exchangeSale, currency, error: null,
    net, tradeValue, payable
  });
});

app.post("/sales/:id/payments", requireAuth, (req, res) => {
  const saleId = Number(req.params.id);
  const amount = moneyToInt(req.body.amount);
  const method = req.body.method || "Cash";
  const reference = (req.body.reference || "").trim() || null;

  const sale = db.prepare(`SELECT * FROM sales WHERE id = @id AND branch = @branch`).get({ id: saleId, branch: req.branch });
  if (!sale) return res.status(404).send("Sale not found");
  if (amount == null || amount <= 0) return res.redirect(`/sales/${saleId}`);

  const plan = db.prepare(`SELECT * FROM installment_plans WHERE sale_id = @sale_id`).get({ sale_id: saleId });
  if (!plan) return res.redirect(`/sales/${saleId}`);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO payments (sale_id, amount, method, reference, created_by_user_id, paid_at)
       VALUES (@sale_id, @amount, @method, @reference, @created_by_user_id, @paid_at)`
    ).run({
      sale_id: saleId,
      amount,
      method,
      reference,
      created_by_user_id: req.user.id,
      paid_at: nowIso()
    });

    const newBalance = Math.max(0, plan.balance - amount);
    const newStatus = computeInstallmentStatus({ balance: newBalance, dueDateIso: plan.due_date });
    db.prepare(`UPDATE installment_plans SET balance = @balance, status = @status WHERE id = @id`).run({
      balance: newBalance,
      status: newStatus,
      id: plan.id
    });
  });

  tx();
  res.redirect(`/sales/${saleId}`);
});

// ─── RETURNS ───

app.get("/returns", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, s.invoice_no, c.name AS customer_name, c.phone AS customer_phone,
              c.customer_type, c.ghana_card, c.id_held,
              d.model AS device_model,
              COALESCE(u.name, 'Unknown') AS created_by_name
       FROM returns r
       JOIN sales s ON s.id = r.sale_id
       JOIN customers c ON c.id = s.customer_id
       JOIN devices d ON d.id = r.device_id
       LEFT JOIN users u ON u.id = r.created_by_user_id
       WHERE s.branch = @branch
       ORDER BY r.id DESC`
    )
    .all({ branch: req.branch });
  res.render("returns/list", { returns: rows, currency, message: req.query.ok ? "Return saved." : null });
});

app.get("/sales/:id/return", requireAuth, (req, res) => {
  const saleId = Number(req.params.id);
  const sale = db
    .prepare(
      `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone,
              c.customer_type, c.ghana_card, c.id_held,
              d.model AS device_model,
              (SELECT group_concat(di.imei, ', ') FROM device_imeis di WHERE di.device_id = d.id) AS device_imeis
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       JOIN devices d ON d.id = s.device_id
       WHERE s.id = @id AND s.branch = @branch`
    )
    .get({ id: saleId, branch: req.branch });
  if (!sale) return res.status(404).send("Sale not found");

  const existingReturn = db.prepare(`SELECT * FROM returns WHERE sale_id = @sale_id`).get({ sale_id: saleId });
  res.render("returns/new", { sale, existingReturn, error: null, form: null });
});

app.post("/sales/:id/return", requireAuth, (req, res) => {
  const saleId = Number(req.params.id);
  const reason = String(req.body.reason || "").trim();
  const faultDescription = String(req.body.fault_description || "").trim() || null;
  const imei = String(req.body.imei || "").trim() || null;
  const refundAmount = moneyToInt(req.body.refund_amount) || 0;
  const notes = String(req.body.notes || "").trim() || null;

  const sale = db
    .prepare(
      `SELECT s.*, c.customer_type, c.ghana_card, c.id_held, c.id AS customer_id
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.id = @id AND s.branch = @branch`
    )
    .get({ id: saleId, branch: req.branch });
  if (!sale) return res.status(404).send("Sale not found");

  const existingReturn = db.prepare(`SELECT * FROM returns WHERE sale_id = @sale_id`).get({ sale_id: saleId });

  if (!reason) {
    const saleForRender = db
      .prepare(
        `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone,
                c.customer_type, c.ghana_card, c.id_held,
                d.model AS device_model,
                (SELECT group_concat(di.imei, ', ') FROM device_imeis di WHERE di.device_id = d.id) AS device_imeis
         FROM sales s JOIN customers c ON c.id = s.customer_id JOIN devices d ON d.id = s.device_id
         WHERE s.id = @id`
      )
      .get({ id: saleId });
    return res.status(400).render("returns/new", {
      sale: saleForRender,
      existingReturn,
      error: "Choose a return reason.",
      form: {
        reason: reason,
        fault_description: faultDescription || "",
        imei: imei || "",
        refund_amount: (req.body.refund_amount || "").toString(),
        notes: notes || ""
      }
    });
  }

  const tx = db.transaction(() => {
    if (existingReturn) {
      db.prepare(
        `UPDATE returns SET reason = @reason, fault_description = @fault_description, imei = @imei,
           refund_amount = @refund_amount, status = @status, notes = @notes, resolved_at = @resolved_at
         WHERE id = @id`
      ).run({
        reason, fault_description: faultDescription, imei, refund_amount,
        status: req.body.status || existingReturn.status,
        notes,
        resolved_at: (req.body.status === "Resolved" && !existingReturn.resolved_at) ? nowIso() : existingReturn.resolved_at,
        id: existingReturn.id
      });
    } else {
      db.prepare(
        `INSERT INTO returns (sale_id, device_id, reason, fault_description, imei, refund_amount, status, notes, created_by_user_id, created_at)
         VALUES (@sale_id, @device_id, @reason, @fault_description, @imei, @refund_amount, @status, @notes, @created_by_user_id, @created_at)`
      ).run({
        sale_id: saleId,
        device_id: sale.device_id,
        reason,
        fault_description: faultDescription,
        imei,
        refund_amount: refundAmount,
        status: "Customer Return",
        notes,
        created_by_user_id: req.user.id,
        created_at: nowIso()
      });
    }

    db.prepare(`UPDATE sales SET is_returned = 1 WHERE id = @id`).run({ id: saleId });
    db.prepare(`UPDATE devices SET status = 'Returned' WHERE id = @device_id`).run({ device_id: sale.device_id });

    //  Release dealer's held ID/Ghana Card if applicable
    if (sale.customer_type === "Dealer" && sale.id_held) {
      db.prepare(`UPDATE customers SET id_held = 0, id_held_at = NULL WHERE id = @id`).run({ id: sale.customer_id });
    }

    //  Reverse installment if any
    const plan = db.prepare(`SELECT * FROM installment_plans WHERE sale_id = @sale_id`).get({ sale_id: saleId });
    if (plan && plan.status !== "PaidOff") {
      db.prepare(`UPDATE installment_plans SET status = 'Cancelled' WHERE id = @id`).run({ id: plan.id });
    }
  });

  tx();
  res.redirect(`/sales/${saleId}?returned=1`);
});

// ───────────── EXCHANGE ─────────────

// GET /sales/:id/exchange — show exchange page (pick replacement device)
app.get("/sales/:id/exchange", requireAuth, (req, res) => {
  const saleId = Number(req.params.id);
  const sale = db
    .prepare(
      `SELECT s.*,
              c.name AS customer_name, c.phone AS customer_phone,
              d.model AS device_model,
              (SELECT group_concat(di.imei, ', ') FROM device_imeis di WHERE di.device_id = d.id) AS device_imeis
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       JOIN devices d ON d.id = s.device_id
       WHERE s.id = @id AND s.branch = @branch`
    )
    .get({ id: saleId, branch: req.branch });
  if (!sale) return res.status(404).send("Sale not found");

  const returnRecord = db.prepare(`SELECT * FROM returns WHERE sale_id = @sale_id`).get({ sale_id: saleId });
  if (!returnRecord) return res.status(400).send("No return record found. Process the return first.");
  if (returnRecord.exchange_sale_id) {
    return res.redirect(`/sales/${returnRecord.exchange_sale_id}`);
  }

  const devices = db
    .prepare(
      `SELECT d.*, group_concat(di.imei, ', ') AS imeis
       FROM devices d
       LEFT JOIN device_imeis di ON di.device_id = d.id
       WHERE d.branch = @branch AND d.status = 'InStock'
       GROUP BY d.id
       ORDER BY d.id DESC`
    )
    .all({ branch: req.branch });

  res.render("sales/exchange", {
    sale,
    returnRecord,
    devices,
    currency,
    error: null
  });
});

// POST /sales/:id/exchange — create exchange sale
app.post("/sales/:id/exchange", requireAuth, (req, res) => {
  const saleId = Number(req.params.id);
  const deviceId = Number(req.body.device_id);
  const salePrice = moneyToInt(req.body.sale_price);

  const sale = db
    .prepare(
      `SELECT s.*,
              c.name AS customer_name, c.phone AS customer_phone,
              c.id AS customer_id,
              d.model AS device_model,
              (SELECT group_concat(di.imei, ', ') FROM device_imeis di WHERE di.device_id = d.id) AS device_imeis
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       JOIN devices d ON d.id = s.device_id
       WHERE s.id = @id AND s.branch = @branch`
    )
    .get({ id: saleId, branch: req.branch });
  if (!sale) return res.status(404).send("Sale not found");

  const returnRecord = db.prepare(`SELECT * FROM returns WHERE sale_id = @sale_id`).get({ sale_id: saleId });
  if (!returnRecord) return res.status(400).send("No return record. Process the return first.");
  if (returnRecord.exchange_sale_id) {
    return res.redirect(`/sales/${returnRecord.exchange_sale_id}`);
  }

  if (!deviceId || !salePrice) {
    const devices = db
      .prepare(`SELECT d.*, group_concat(di.imei, ', ') AS imeis FROM devices d LEFT JOIN device_imeis di ON di.device_id = d.id WHERE d.branch = @branch AND d.status = 'InStock' GROUP BY d.id ORDER BY d.id DESC`)
      .all({ branch: req.branch });
    return res.status(400).render("sales/exchange", {
      sale, returnRecord, devices, currency,
      error: "Select a replacement device."
    });
  }

  const device = db.prepare(`SELECT * FROM devices WHERE id = @id AND branch = @branch AND status = 'InStock'`).get({ id: deviceId, branch: req.branch });
  if (!device) {
    const devices = db
      .prepare(`SELECT d.*, group_concat(di.imei, ', ') AS imeis FROM devices d LEFT JOIN device_imeis di ON di.device_id = d.id WHERE d.branch = @branch AND d.status = 'InStock' GROUP BY d.id ORDER BY d.id DESC`)
      .all({ branch: req.branch });
    return res.status(400).render("sales/exchange", {
      sale, returnRecord, devices, currency,
      error: "That device is no longer in stock."
    });
  }

  const invoiceNo = `INV-${Date.now()}`;

  const tx = db.transaction(() => {
    // Create the exchange sale
    const saleIns = db
      .prepare(
        `INSERT INTO sales (branch, invoice_no, sale_type, customer_id, device_id, sale_price, discount, created_by_user_id, created_by_user_name, created_at)
         VALUES (@branch, @invoice_no, @sale_type, @customer_id, @device_id, @sale_price, @discount, @created_by_user_id, @created_by_user_name, @created_at)`
      )
      .run({
        branch: req.branch,
        invoice_no: invoiceNo,
        sale_type: "Exchange",
        customer_id: sale.customer_id,
        device_id: deviceId,
        sale_price: salePrice,
        discount: 0,
        created_by_user_id: req.user.id,
        created_by_user_name: req.user.name,
        created_at: nowIso()
      });

    const exchangeSaleId = saleIns.lastInsertRowid;

    // Insert sale_item
    db.prepare(
      `INSERT INTO sale_items (sale_id, device_id, unit_price, discount, created_at)
       VALUES (@sale_id, @device_id, @unit_price, @discount, @created_at)`
    ).run({
      sale_id: exchangeSaleId,
      device_id: deviceId,
      unit_price: salePrice,
      discount: 0,
      created_at: nowIso()
    });

    // Mark replacement device as Sold
    db.prepare(`UPDATE devices SET status = 'Sold' WHERE id = @id AND branch = @branch`).run({ id: deviceId, branch: req.branch });

    // Link return to exchange sale
    db.prepare(`UPDATE returns SET exchange_sale_id = @exchange_sale_id WHERE id = @id`).run({ exchange_sale_id: exchangeSaleId, id: returnRecord.id });
  });

  tx();
  res.redirect(`/sales/${saleId}?returned=1&exchanged=1`);
});

app.post("/returns/:id/status", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const newStatus = String(req.body.status || "").trim();
  const validStatuses = ["Customer Return", "Sent to Supplier", "Resolved"];
  if (!validStatuses.includes(newStatus)) return res.status(400).send("Invalid status");

  const resolvedAt = newStatus === "Resolved" ? nowIso() : null;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE returns SET status = @status, resolved_at = @resolved_at WHERE id = @id`).run({ status: newStatus, resolved_at: resolvedAt, id });

    // When resolved, put the device back in stock so it shows in sales search
    if (newStatus === "Resolved") {
      const ret = db.prepare(`SELECT device_id FROM returns WHERE id = @id`).get({ id });
      if (ret && ret.device_id) {
        db.prepare(`UPDATE devices SET status = 'InStock' WHERE id = @device_id`).run({ device_id: ret.device_id });
      }
    }
  });
  tx();

  res.redirect("/returns?ok=1");
});

app.post("/sales/:id/delete", requireAdmin, (req, res) => {
  const saleId = Number(req.params.id);

  const sale = db
    .prepare(`SELECT s.*, d.id AS device_id FROM sales s JOIN devices d ON d.id = s.device_id WHERE s.id = @id AND s.branch = @branch`)
    .get({ id: saleId, branch: req.branch });
  if (!sale) return res.status(404).send("Sale not found");

  const tx = db.transaction(() => {
    // 1. Find and delete trade-in IMEIs and trade-in records
    const tradeIns = db.prepare(`SELECT id, device_model FROM trade_ins WHERE sale_id = @sale_id`).all({ sale_id: saleId });
    for (const ti of tradeIns) {
      db.prepare(`DELETE FROM trade_in_imeis WHERE trade_in_id = @id`).run({ id: ti.id });
    }
    db.prepare(`DELETE FROM trade_ins WHERE sale_id = @sale_id`).run({ sale_id: saleId });

    // 2. Find and delete any trade-in device that was created during swap (orphaned stock entry)
    for (const ti of tradeIns) {
      const tradeBatch = db.prepare(`SELECT id FROM stock_batches WHERE branch = @branch AND name = 'Trade-ins'`).get({ branch: req.branch });
      if (tradeBatch) {
        const orphanDevices = db.prepare(
          `SELECT id FROM devices WHERE branch = @branch AND stock_batch_id = @batch_id AND model = @model AND status = 'InStock' ORDER BY id DESC LIMIT 1`
        ).all({ branch: req.branch, batch_id: tradeBatch.id, model: ti.device_model });
        for (const dev of orphanDevices) {
          db.prepare(`DELETE FROM device_imeis WHERE device_id = @id`).run({ id: dev.id });
          db.prepare(`DELETE FROM devices WHERE id = @id`).run({ id: dev.id });
        }
      }
    }

    // 3. Delete installment plan
    db.prepare(`DELETE FROM installment_plans WHERE sale_id = @sale_id`).run({ sale_id: saleId });

    // 4. Delete payments
    db.prepare(`DELETE FROM payments WHERE sale_id = @sale_id`).run({ sale_id: saleId });

    // 5. Delete returns
    db.prepare(`DELETE FROM returns WHERE sale_id = @sale_id`).run({ sale_id: saleId });

    // 6. Set all cart devices back to InStock
    const allItems = db.prepare(`SELECT device_id FROM sale_items WHERE sale_id = @sale_id`).all({ sale_id: saleId });
    for (const item of allItems) {
      db.prepare(`UPDATE devices SET status = 'InStock' WHERE id = @device_id AND branch = @branch`).run({ device_id: item.device_id, branch: req.branch });
    }

    // 7. Delete the sale
    db.prepare(`DELETE FROM sales WHERE id = @id AND branch = @branch`).run({ id: saleId, branch: req.branch });
  });

  try {
    tx();
    res.redirect("/sales?deleted=1");
  } catch (e) {
    res.status(400).send(String(e.message || e));
  }
});

app.get("/installments", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT
         ip.*,
         s.invoice_no,
         s.sale_price,
         s.discount,
         c.id AS customer_id,
         c.name AS customer_name,
         c.phone AS customer_phone,
         d.model AS device_model
       FROM installment_plans ip
       JOIN sales s ON s.id = ip.sale_id
       JOIN customers c ON c.id = s.customer_id
       JOIN devices d ON d.id = s.device_id
       WHERE s.branch = @branch AND ip.balance > 0
       ORDER BY substr(ip.due_date,1,10) ASC`
    )
    .all({ branch: req.branch });

  const today = todayIsoDate();
  const items = rows.map((r) => ({
    ...r,
    computed_status: r.status === "PaidOff" ? "PaidOff" : substrDate(r.due_date) < today ? "Overdue" : "Active"
  }));

  res.render("installments/dashboard", { items, currency, today });
});

function substrDate(iso) {
  return (iso || "").slice(0, 10);
}

function getAllCustomers(branch) {
  return db
    .prepare(
      `SELECT id, name, phone FROM customers WHERE branch = @branch AND (customer_type IS NULL OR customer_type = 'Customer') ORDER BY name ASC`
    )
    .all({ branch });
}


// Credits page — works for both Admin and Employee
app.get("/credits", requireAuth, (req, res) => {
  // Read credits from Ayisun shared Doticare pool
  const smsCredits = getAyisunDoticareCredits();
  const userName = req.user?.name || "user";
  const isAdmin = req.user.role === "Admin";
  const allUsers = isAdmin ? db.prepare("SELECT id, name, sms_credits FROM users ORDER BY name").all() : [];
  
  // Admin: get all pending requests | Employee: get own requests
  const pendingRequests = isAdmin
    ? db.prepare(`SELECT cr.id, cr.amount, cr.status, cr.created_at, u.name as user_name, u.id as user_id
                  FROM credit_requests cr
                  JOIN users u ON cr.user_id = u.id
                  WHERE cr.status = 'pending'
                  ORDER BY cr.created_at ASC`).all()
    : db.prepare(`SELECT id, amount, status, created_at, fulfilled_at
                  FROM credit_requests
                  WHERE user_id = @uid
                  ORDER BY created_at DESC
                  LIMIT 5`).all({ uid: req.user.id });
  
  res.render("credits", { smsCredits, userName, allUsers, isAdmin, pendingRequests });
});

// Employee: Request airtime credits from admin
app.post("/credits/request", requireAuth, (req, res) => {
  const amount = Number(req.body.amount) || 0;
  // Check if user already has a pending request
  const existing = db.prepare("SELECT id FROM credit_requests WHERE user_id = @uid AND status = 'pending'").get({ uid: req.user.id });
  if (existing) {
    return res.json({ status: "error", message: "You already have a pending request. Please wait for admin to fulfill it." });
  }
  db.prepare("INSERT INTO credit_requests (user_id, amount, status) VALUES (@uid, @amount, 'pending')")
    .run({ uid: req.user.id, amount: amount || null });
  res.json({ status: "success", message: "Your airtime request has been sent to the admin." });
});

// Admin: Top up SMS credits for any user (deducts from Ayisun Doticare pool)
app.post("/credits/topup", requireAdmin, (req, res) => {
  const userId = Number(req.body.user_id);
  const amount = Number(req.body.amount);
  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ status: "error", message: "Invalid user or amount" });
  }
  // Check Ayisun Doticare credit balance
  const adminCredits = getAyisunDoticareCredits();
  if (adminCredits < amount) {
    return res.json({ status: "error", message: "Not enough credits in Ayisun Doticare pool! Available: " + adminCredits + ", needed: " + amount + ". Please buy credits from Ayisun first." });
  }
  // Deduct from Ayisun shared Doticare pool
  deductAyisunDoticareCredits(amount);
  // Add to employee's local credits
  db.prepare("UPDATE users SET sms_credits = sms_credits + @amount WHERE id = @id").run({ amount, id: userId });
  const updated = db.prepare("SELECT name, sms_credits FROM users WHERE id = @id").get({ id: userId });
  const adminAfter = getAyisunDoticareCredits();
  res.json({ status: "success", user: updated.name, credits_added: amount, new_balance: updated.sms_credits, admin_remaining: adminAfter });
});

// Admin: Fulfill a credit request (assign credits from Ayisun pool + mark fulfilled)
app.post("/credits/fulfill/:id", requireAdmin, (req, res) => {
  const requestId = Number(req.params.id);
  const amount = Number(req.body.amount);
  if (!requestId || !amount || amount <= 0) {
    return res.status(400).json({ status: "error", message: "Invalid request or amount" });
  }
  const cr = db.prepare("SELECT * FROM credit_requests WHERE id = @id AND status = 'pending'").get({ id: requestId });
  if (!cr) {
    return res.status(404).json({ status: "error", message: "Request not found or already fulfilled." });
  }
  // Check Ayisun Doticare credit balance
  const adminCredits = getAyisunDoticareCredits();
  if (adminCredits < amount) {
    return res.json({ status: "error", message: "Not enough credits in Ayisun Doticare pool! Available: " + adminCredits + ", needed: " + amount + ". Please buy credits from Ayisun first." });
  }
  // Deduct from Ayisun shared Doticare pool
  deductAyisunDoticareCredits(amount);
  // Add credits to the employee's local balance
  db.prepare("UPDATE users SET sms_credits = sms_credits + @amount WHERE id = @id").run({ amount, id: cr.user_id });
  // Mark request as fulfilled
  db.prepare("UPDATE credit_requests SET status = 'fulfilled', amount = @amount, fulfilled_at = datetime('now'), fulfilled_by_user_id = @adminId WHERE id = @id")
    .run({ amount, adminId: req.user.id, id: requestId });
  const updated = db.prepare("SELECT name, sms_credits FROM users WHERE id = @id").get({ id: cr.user_id });
  const adminAfter = getAyisunDoticareCredits();
  res.json({ status: "success", user: updated.name, credits_added: amount, new_balance: updated.sms_credits, admin_remaining: adminAfter, request_id: requestId });
});

// API: Pending credit requests count (for dashboard badge)
app.get("/api/credit-requests/pending-count", requireAuth, (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as cnt FROM credit_requests WHERE status = 'pending'").get().cnt;
  res.json({ pending: count });
});


// Internal API: Add SMS credits (called by BusinessHelpy after payment)
app.post("/api/internal/add-credits", (req, res) => {
  const secret = req.headers["x-api-secret"] || "";
  if (secret !== process.env.API_SECRET) {
    return res.status(403).json({ status: "error", message: "Unauthorized" });
  }
  const { phone, credits } = req.body;
  if (!phone || !credits) {
    return res.status(400).json({ status: "error", message: "Missing phone or credits" });
  }
  
  // Update Ayisun's users.json (the shared Doticare credit pool)
  addAyisunDoticareCredits(Number(credits));
  
  // Also update local SQLite for backward compatibility
  const norm = phone.toString().replace(/\+/g, "").trim();
  const user = db.prepare("SELECT id, sms_credits FROM users WHERE name LIKE @phone OR name = @phone2")
    .get({ phone: "%" + norm.slice(-9), phone2: norm });
  if (user) {
    db.prepare("UPDATE users SET sms_credits = sms_credits + @credits WHERE id = @id")
      .run({ credits: Number(credits), id: user.id });
  }
  
  const newBalance = getAyisunDoticareCredits();
  res.json({ status: "success", phone, credits_added: Number(credits), new_balance: newBalance });
});


app.get("/sms", requireAuth, (req, res) => {
  const templates = db.prepare(`SELECT * FROM message_templates WHERE branch = @branch ORDER BY use_count DESC, id DESC LIMIT 4`).all({ branch: req.branch });
  const filter = (req.query.filter || "overdue").toString();
  const view = (req.query.view || "installment").toString();

  // Birthday customers for SMS center (always fetched for the top panel)
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const now = new Date();
  const bdayMonth = monthNames[now.getMonth()];
  const bdayDay = now.getDate();
  const birthdayCustomers = db.prepare(
    `SELECT id, name, phone, birth_day, birth_month FROM customers
     WHERE branch = @branch
       AND birth_month = @todayMonth
       AND birth_day = @todayDay`
  ).all({ branch: req.branch, todayMonth: bdayMonth, todayDay: bdayDay });

  let recipients;
  if (view === "all") {
    recipients = getAllCustomers(req.branch);
  } else if (view === "birthday") {
    recipients = birthdayCustomers;
  } else if (view === "manual") {
    recipients = db.prepare(
      `SELECT id, phone, COALESCE(name, '') AS name, source_text, created_at FROM manual_contacts WHERE branch = @branch ORDER BY id DESC`
    ).all({ branch: req.branch });
  } else {
    recipients = getRecipientsByFilter(filter, req.branch);
  }

  const selectedTemplateId = req.query.template_id ? Number(req.query.template_id) : null;
  let selectedTemplate = null;
  if (selectedTemplateId) {
    selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
    if (!selectedTemplate) {
      selectedTemplate = db.prepare(`SELECT * FROM message_templates WHERE id = @id AND branch = @branch`).get({ id: selectedTemplateId, branch: req.branch });
    }
  }
  const message = selectedTemplate ? selectedTemplate.body : "";
  const smsCredits = getAyisunDoticareCredits();

  res.render("sms/center", { templates, recipients, filter, view, senderId: getSenderId(), error: null, selectedTemplateId, message, smsCredits, birthdayCustomers });
});

function getRecipientsByFilter(filter, branch) {
  const today = todayIsoDate();
  if (filter === "all-active") {
    return db
      .prepare(
        `SELECT DISTINCT c.id AS customer_id, c.name, c.phone, ip.balance, ip.due_date, s.id AS sale_id, s.invoice_no
         FROM installment_plans ip
         JOIN sales s ON s.id = ip.sale_id
         JOIN customers c ON c.id = s.customer_id
         WHERE s.branch = @branch AND ip.balance > 0 AND ip.status IN ('Active','Overdue')
         ORDER BY c.id DESC`
      )
      .all({ branch })
      .map((r) => ({ ...r, due_date_short: substrDate(r.due_date), status: substrDate(r.due_date) < today ? "Overdue" : "Active" }));
  }

  if (filter === "due-soon") {
    const in7 = new Date();
    in7.setDate(in7.getDate() + 7);
    const in7Iso = in7.toISOString().slice(0, 10);
    return db
      .prepare(
        `SELECT DISTINCT c.id AS customer_id, c.name, c.phone, ip.balance, ip.due_date, s.id AS sale_id, s.invoice_no
         FROM installment_plans ip
         JOIN sales s ON s.id = ip.sale_id
         JOIN customers c ON c.id = s.customer_id
         WHERE s.branch = @branch AND ip.balance > 0 AND substr(ip.due_date,1,10) BETWEEN @today AND @in7
         ORDER BY substr(ip.due_date,1,10) ASC`
      )
      .all({ branch, today, in7: in7Iso })
      .map((r) => ({ ...r, due_date_short: substrDate(r.due_date), status: "Active" }));
  }

  return db
    .prepare(
      `SELECT DISTINCT c.id AS customer_id, c.name, c.phone, ip.balance, ip.due_date, s.id AS sale_id, s.invoice_no
       FROM installment_plans ip
       JOIN sales s ON s.id = ip.sale_id
       JOIN customers c ON c.id = s.customer_id
       WHERE s.branch = @branch AND ip.balance > 0 AND substr(ip.due_date,1,10) < @today
       ORDER BY substr(ip.due_date,1,10) ASC`
    )
    .all({ branch, today })
    .map((r) => ({ ...r, due_date_short: substrDate(r.due_date), status: "Overdue" }));
}

app.post("/sms/send", requireAuth, async (req, res) => {
  const { message, template_id, save_as_template, template_name, filter, view } = req.body;
  const viewType = (view || "installment").toString();
  let recipients;
  if (viewType === "all") {
    recipients = getAllCustomers(req.branch);
  } else if (viewType === "birthday") {
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const now = new Date();
    recipients = db.prepare(
      `SELECT id, name, phone FROM customers
       WHERE branch = @branch
         AND birth_month = @todayMonth
         AND birth_day = @todayDay`
    ).all({ branch: req.branch, todayMonth: monthNames[now.getMonth()], todayDay: now.getDate() });
  } else if (viewType === "manual") {
    recipients = db.prepare(
      `SELECT id, phone, COALESCE(name, '') AS name FROM manual_contacts WHERE branch = @branch ORDER BY id DESC`
    ).all({ branch: req.branch });
  } else {
    recipients = getRecipientsByFilter((filter || "overdue").toString(), req.branch);
  }
  const selected = Array.isArray(req.body.recipient) ? req.body.recipient : req.body.recipient ? [req.body.recipient] : [];
  const pasteNumbers = Array.isArray(req.body.paste_recipient) ? req.body.paste_recipient : req.body.paste_recipient ? [req.body.paste_recipient] : [];

  const templateId = template_id ? Number(template_id) : null;
  const template = templateId
    ? db.prepare(`SELECT * FROM message_templates WHERE id = @id AND branch = @branch`).get({ id: templateId, branch: req.branch })
    : null;
  const body = ((message || "").toString().trim() || (template ? template.body : "")).trim();

  const templates = db.prepare(`SELECT * FROM message_templates WHERE branch = @branch ORDER BY use_count DESC, id DESC LIMIT 4`).all({ branch: req.branch });
  if (!body) {
    const smsCredits = getAyisunDoticareCredits();
    return res.status(400).render("sms/center", {
      templates,
      recipients,
      filter,
      view: viewType,
      senderId: getSenderId(),
      error: "Type a message.",
      selectedTemplateId: templateId,
      message: "",
      smsCredits
    });
  }
  if (selected.length === 0 && pasteNumbers.length === 0) {
    const smsCredits = getAyisunDoticareCredits();
    return res.status(400).render("sms/center", {
      templates,
      recipients,
      filter,
      view: viewType,
      senderId: getSenderId(),
      error: "Pick at least 1 recipient or paste contacts.",
      selectedTemplateId: templateId,
      message: body,
      smsCredits
    });
  }

  // Check SMS credits — read from Ayisun shared Doticare pool
  const availableCredits = getAyisunDoticareCredits();
  const neededCredits = selected.length + pasteNumbers.length;
  if (availableCredits < neededCredits) {
    return res.status(400).render("sms/center", {
      templates, recipients, filter, view: viewType, senderId: getSenderId(),
      error: "Not enough SMS credit. You have " + availableCredits + " credit" + (availableCredits === 1 ? "" : "s") + " but you are trying to send to " + neededCredits + " number" + (neededCredits === 1 ? "" : "s") + ". You need " + (neededCredits - availableCredits) + " more credit" + ((neededCredits - availableCredits) === 1 ? "" : "s") + ". Please buy credits from Ayisun.",
      selectedTemplateId: templateId, message: body, smsCredits: availableCredits
    });
  }

  let queuedIds = [];
  const tx = db.transaction(() => {
    let savedTemplateId = templateId;
    if (save_as_template === "on") {
      const name = (template_name || "").toString().trim();
      if (name) {
        const ins = db
          .prepare(
            `INSERT INTO message_templates (branch, name, body, active, use_count, created_by_user_id, created_at)
             VALUES (@branch, @name, @body, 1, 1, @created_by_user_id, @created_at)`
          )
          .run({ branch: req.branch, name, body, created_by_user_id: req.user.id, created_at: nowIso() });
        savedTemplateId = ins.lastInsertRowid;
      }
    }

    // Increment use_count for the template used
    if (savedTemplateId) {
      db.prepare(`UPDATE message_templates SET use_count = use_count + 1 WHERE id = @id`).run({ id: savedTemplateId });
    }

    //  Debtor / All-customer recipients
    const recipientSet = new Set(selected.map((s) => Number(s)));
    for (const r of recipients) {
      const recipientId = (viewType === "installment") ? r.sale_id : r.id;
      if (!recipientSet.has(recipientId)) continue;
      const id = enqueueSms({
        toPhone: r.phone,
        body,
        branch: req.branch,
        customerId: (viewType === "installment") ? r.customer_id : (viewType === "manual" ? null : r.id),
        saleId: (viewType === "installment") ? r.sale_id : null,
        templateId: savedTemplateId,
        createdByUserId: req.user.id
      });
      queuedIds.push(id);
    }

    //  Pasted contacts
    for (const phone of pasteNumbers) {
      const clean = String(phone).trim().replace(/^\+/, "").replace(/^0/, "233").replace(/\D/g, "");
      if (!clean || clean.length < 10) continue;
      const id = enqueueSms({
        toPhone: clean,
        body,
        branch: req.branch,
        customerId: null,
        saleId: null,
        templateId: savedTemplateId,
        createdByUserId: req.user.id
      });
      queuedIds.push(id);
    }
  });

  tx();
  if (queuedIds.length > 0) {
    await deliverBulkMessages(queuedIds);
  }
  // Deduct credits from Ayisun shared Doticare pool
  if (queuedIds.length > 0) {
    deductAyisunDoticareCredits(queuedIds.length);
  }

  // Save paste numbers that are NOT customers to manual_contacts
  if (pasteNumbers.length > 0) {
    const upsertContact = db.prepare(
      `INSERT OR IGNORE INTO manual_contacts (branch, phone, created_by_user_id, created_at)
       VALUES (@branch, @phone, @uid, @now)`
    );
    for (const phone of pasteNumbers) {
      const clean = String(phone).trim();
      if (!clean || clean.length < 10) continue;
      const digits = clean.replace(/\D/g, '');
      // Normalize: convert 233 prefix to 0 (Ghana local format) to match DB
      const digits0 = digits.replace(/^233/, '0');
      const digits233 = digits.replace(/^0/, '233');
      // Check if this phone belongs to a customer (try both 0xxx and 233xxx formats)
      const isCustomer = db.prepare(
        `SELECT 1 FROM customers WHERE branch = @branch AND (REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', '') = @digits0 OR REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', '') = @digits233)`
      ).get({ branch: req.branch, digits0, digits233 });
      if (!isCustomer) {
        upsertContact.run({ branch: req.branch, phone: clean, uid: req.user.id, now: nowIso() });
      }
    }
  }

  res.redirect("/sms/logs?sent=" + queuedIds.length);
});

app.post("/sms/logs/retry/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM sms_messages WHERE id = @id`).get({ id });
  if (!row) return res.status(404).send("Not found");

  db.prepare(`UPDATE sms_messages SET status = @status, error_message = @error_message WHERE id = @id`).run({
    status: "Queued",
    error_message: null,
    id
  });

  await deliverSmsMessage(id);
  res.redirect("/sms/logs?retried=1");
});

app.post("/sms/logs/delete/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM sms_messages WHERE id = @id AND status IN ('Retry', 'Queued')`).run({ id });
  res.redirect("/sms/logs?deleted=1");
});

app.post("/sms/logs/retry-all", requireAuth, async (req, res) => {
  const rows = db.prepare(`SELECT id FROM sms_messages WHERE status = 'Retry' ORDER BY id`).all();
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    db.prepare(`UPDATE sms_messages SET status = 'Queued', error_message = NULL WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    await deliverBulkMessages(ids);
  }
  res.redirect(`/sms/logs?retried=${ids.length}`);
});

app.get("/sms/templates", requireAuth, (req, res) => {
  const templates = db.prepare(`SELECT * FROM message_templates WHERE branch = @branch ORDER BY id DESC`).all({ branch: req.branch });
  res.render("sms/templates", { templates });
});

app.post("/sms/templates/:id/toggle", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare(`SELECT * FROM message_templates WHERE id = @id AND branch = @branch`).get({ id, branch: req.branch });
  if (!t) return res.redirect("/sms/templates");
  db.prepare(`UPDATE message_templates SET active = @active WHERE id = @id AND branch = @branch`).run({
    active: t.active ? 0 : 1,
    id,
    branch: req.branch
  });
  res.redirect("/sms/templates");
});

app.post("/sms/templates/:id/delete", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare(`SELECT * FROM message_templates WHERE id = @id AND branch = @branch`).get({ id, branch: req.branch });
  if (!t) return res.redirect("/sms/templates");
  // Clear template reference from all SMS messages that used this template
  db.prepare(`UPDATE sms_messages SET template_id = NULL WHERE template_id = @id AND branch = @branch`).run({ id, branch: req.branch });
  // Now safe to delete the template
  db.prepare(`DELETE FROM message_templates WHERE id = @id AND branch = @branch`).run({ id, branch: req.branch });
  res.redirect("/sms/templates");
});

app.get("/sms/logs", requireAuth, (req, res) => {
  const logs = db
    .prepare(
      `SELECT sm.*, c.name AS customer_name, s.invoice_no
       FROM sms_messages sm
       LEFT JOIN customers c ON c.id = sm.customer_id
       LEFT JOIN sales s ON s.id = sm.sale_id
       WHERE sm.branch = @branch
       ORDER BY sm.id DESC
       LIMIT 200`
    )
    .all({ branch: req.branch });
  res.render("sms/logs", { logs, query: req.query });
});

// ── CSV EXPORTS ──────────────────────────────────────────────
app.get("/inventory/export", requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT d.model, d.storage, d.color, d.product_type, d.os, d.sale_price,
            SUM(CASE WHEN d.status = 'InStock' OR d.status = 'Returned' THEN 1 ELSE 0 END) as in_stock,
            SUM(CASE WHEN d.status = 'Sold' THEN 1 ELSE 0 END) as sold
     FROM devices d
     WHERE d.branch = @branch
     GROUP BY d.model, d.storage, d.sale_price
     ORDER BY d.model, d.storage`
  ).all({ branch: req.branch });

  const csvRows = [];
  csvRows.push(["Model", "Storage", "Color", "Type", "OS", "Price", "In Stock", "Sold"].map(esc).join(","));
  for (const r of rows) {
    csvRows.push([
      r.model, r.storage || "", r.color || "", r.product_type || "", r.os || "",
      r.sale_price, r.in_stock, r.sold
    ].map(esc).join(","));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=inventory_" + todayIsoDate() + ".csv");
  res.send("\uFEFF" + csvRows.join("\n"));
});

function esc(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  process.stdout.write(`Server running on http://localhost:${port}\n`);
});

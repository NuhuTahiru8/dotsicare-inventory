import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import multer from "multer";
import { db, moneyToInt, nowIso } from "./db.js";
import { enqueueSms, deliverSmsMessage, deliverBulkMessages, getSenderId } from "./sms.js";

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "src", "views"));

app.use(express.urlencoded({ extended: true }));
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

function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    password_salt: salt,
    password_hash: scryptHash(password, salt)
  };
}

function findUserById(id) {
  return db.prepare(`SELECT id, name, role FROM users WHERE id = @id`).get({ id });
}

function findUserForLogin(name) {
  return db
    .prepare(`SELECT id, name, role, password_salt, password_hash FROM users WHERE lower(name) = lower(@name)`)
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
      `SELECT u.id, u.name, u.role, u.created_at, COUNT(s.id) AS sale_count
       FROM users u
       LEFT JOIN sales s ON s.created_by_user_id = u.id
       GROUP BY u.id
       ORDER BY u.id DESC`
    )
    .all();
}

function renderAdminUsers(res, { status = 200, error = null, message = null } = {}) {
  const users = getAdminUsers();
  return res.status(status).render("admin/users", { users, error, message });
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
       WHERE s.branch = @branch`
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

  const { password_salt, password_hash } = hashPassword(password);

  db.prepare(
    `INSERT INTO users (name, role, password_salt, password_hash, created_at)
     VALUES (@name, 'Admin', @password_salt, @password_hash, @created_at)`
  ).run({ name, password_salt, password_hash, created_at: nowIso() });

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
  const branch = normalizeBranch(req.body.branch);
  if (!branch) {
    return renderLogin(res.status(400), { error: "Pick a shop.", selectedBranch: req.body.branch });
  }

  const user = findUserForLogin(name);
  if (!user || !user.password_salt || !user.password_hash) {
    return renderLogin(res.status(401), { error: "Invalid login.", selectedBranch: branch });
  }

  const hash = scryptHash(password, user.password_salt);
  const ok = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.password_hash));
  if (!ok) return renderLogin(res.status(401), { error: "Invalid login.", selectedBranch: branch });

  setSessionCookie(res, { userId: user.id, branch, exp: Date.now() + 1000 * 60 * 60 * 12 });
  return res.redirect(user.role === "Admin" ? "/admin" : "/sales");
});

app.post("/branch", requireAuth, (req, res) => {
  const branch = normalizeBranch(req.body.branch);
  if (branch) setSessionCookie(res, sessionPayload(req, branch));
  res.redirect("/dashboard");
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

function insertDeviceFromBody(body) {
  const branch = normalizeBranch(body.branch);
  const { model, storage, color, condition, cost_price, sale_price, imei1, imei2, stock_batch_name } = body;
  const cost = moneyToInt(cost_price);
  const sale = moneyToInt(sale_price);
  const imeis = [imei1, imei2].map((v) => (v || "").trim()).filter(Boolean);

  if (!branch) {
    return { ok: false, error: "Pick a shop first." };
  }

  if (!model || !condition || cost == null || sale == null || imeis.length === 0) {
    return { ok: false, error: "Model, condition, cost, price and IMEI are required." };
  }

  const tx = db.transaction(() => {
    const stockBatchId = findOrCreateStockBatch(branch, stock_batch_name, "Created from stock entry");
    const ins = db
      .prepare(
        `INSERT INTO devices (branch, stock_batch_id, model, storage, color, condition, cost_price, sale_price, status, created_by_user_id, created_at)
         VALUES (@branch, @stock_batch_id, @model, @storage, @color, @condition, @cost_price, @sale_price, 'InStock', @created_by_user_id, @created_at)`
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
      `SELECT d.*, sb.name AS stock_batch_name, group_concat(di.imei, ', ') AS imeis
       FROM devices d
       LEFT JOIN device_imeis di ON di.device_id = d.id
       LEFT JOIN stock_batches sb ON sb.id = d.stock_batch_id
       WHERE d.id = @id AND d.branch = @branch
       GROUP BY d.id`
    )
    .get({ id, branch });
}

function updateDeviceFromBody(id, branch, body) {
  const { model, storage, color, condition, cost_price, sale_price, imei1, imei2, stock_batch_name } = body;
  const cost = moneyToInt(cost_price);
  const sale = moneyToInt(sale_price);
  const imeis = [imei1, imei2].map((v) => (v || "").trim()).filter(Boolean);

  if (!model || !condition || cost == null || sale == null || imeis.length === 0) {
    return { ok: false, error: "Model, condition, cost, price and IMEI are required." };
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
           sale_price = @sale_price
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
      sale_price: sale
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

app.get("/dashboard", requireAuth, (req, res) => {
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

  res.render("home", { counts: dashboard, dashboard, overdueCount, currency });
});

app.get("/admin", requireAdmin, (req, res) => {
  const recentStock = db
    .prepare(
      `SELECT d.*, sb.name AS stock_batch_name, group_concat(di.imei, ', ') AS imeis
       FROM devices d
       LEFT JOIN device_imeis di ON di.device_id = d.id
       LEFT JOIN stock_batches sb ON sb.id = d.stock_batch_id
       WHERE d.branch = @branch
       GROUP BY d.id
       ORDER BY d.id DESC
       LIMIT 10`
    )
    .all({ branch: req.branch });

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
    batches: getStockBatches(req.branch),
    defaultBatchName: defaultStockBatchName()
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
      `SELECT d.*, sb.name AS stock_batch_name, group_concat(di.imei, ', ') AS imeis
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
    return res.status(400).render("admin/dashboard", {
      error: result.error,
      ok: false,
      recentStock,
      currency,
      users,
      userOk: false,
      userError: null,
      batches: getStockBatches(req.branch),
      defaultBatchName: normalizeStockBatchName(req.body.stock_batch_name) || defaultStockBatchName()
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
      colors: dv.colors
    });
  }

  const results = [];
  const errors = [];

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
      created_by_user_id: req.user.id
    });
    if (result.ok) {
      results.push(row.model);
    } else {
      errors.push((row.model || "Unknown") + ": " + result.error);
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
    colors: dv.colors
  });
});

app.get("/admin/users", requireAdmin, (req, res) => {
  const message =
    req.query.created === "1"
      ? "User created"
      : req.query.password === "1"
        ? "Password updated"
        : req.query.deleted === "1"
          ? "User deleted"
          : null;
  renderAdminUsers(res, { message });
});

app.post("/admin/users", requireAdmin, (req, res) => {
  const name = (req.body.name || "").toString().trim();
  const role = (req.body.role || "").toString().trim();
  const password = (req.body.password || "").toString();

  if (!name || !["Admin", "Employee"].includes(role) || password.length < 6) {
    return renderAdminUsers(res, { status: 400, error: "Enter name, role, and password (6+ characters)." });
  }

  const existing = db.prepare(`SELECT id FROM users WHERE lower(name) = lower(@name)`).get({ name });
  if (existing) {
    return renderAdminUsers(res, { status: 400, error: "Username taken." });
  }

  const { password_salt, password_hash } = hashPassword(password);
  try {
    db.prepare(
      `INSERT INTO users (name, role, password_salt, password_hash, created_at)
       VALUES (@name, @role, @password_salt, @password_hash, @created_at)`
    ).run({ name, role, password_salt, password_hash, created_at: nowIso() });
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
    return renderAdminUsers(res, { status: 400, error: "Password: 6+ characters." });
  }

  const { password_salt, password_hash } = hashPassword(password);
  db.prepare(
    `UPDATE users
     SET password_salt = @password_salt,
         password_hash = @password_hash
     WHERE id = @id`
  ).run({ id, password_salt, password_hash });

  res.redirect("/admin/users?password=1");
});

app.post("/admin/users/:id/delete", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const target = findUserById(id);

  if (!target) return renderAdminUsers(res, { status: 404, error: "User not found." });
  if (target.id === req.user.id) {
    return renderAdminUsers(res, { status: 400, error: "Can't delete your own account." });
  }
  if (target.role === "Admin") {
    const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'Admin'`).get().c;
    if (adminCount <= 1) {
      return renderAdminUsers(res, { status: 400, error: "Keep at least 1 admin." });
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

app.get("/inventory", requireAuth, (req, res) => {
  const items = db
    .prepare(
      `SELECT d.*, sb.name AS stock_batch_name, group_concat(di.imei, ', ') AS imeis
       FROM devices d
       LEFT JOIN device_imeis di ON di.device_id = d.id
       LEFT JOIN stock_batches sb ON sb.id = d.stock_batch_id
       WHERE d.branch = @branch
       GROUP BY d.id
       ORDER BY d.id DESC`
    )
    .all({ branch: req.branch });
  res.render("inventory/list", {
    items,
    currency,
    message: req.query.updated === "1" ? "Stock updated successfully." : req.query.deleted === "1" ? "Stock deleted successfully." : null,
    error: req.query.error || null
  });
});

app.get("/inventory/new", requireAdmin, (req, res) => {
  res.render("inventory/new", {
    error: null,
    batches: getStockBatches(req.branch),
    defaultBatchName: defaultStockBatchName()
  });
});

app.post("/inventory/new", requireAdmin, (req, res) => {
  const result = insertDeviceFromBody({ ...req.body, branch: req.branch, created_by_user_id: req.user.id });
  if (!result.ok) {
    return res.status(400).render("inventory/new", {
      error: result.error,
      batches: getStockBatches(req.branch),
      defaultBatchName: normalizeStockBatchName(req.body.stock_batch_name)
    });
  }
  res.redirect("/inventory");
});

app.get("/inventory/:id/edit", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const item = getDeviceWithImeis(id, req.branch);
  if (!item) return res.status(404).send("Stock item not found");

  const imeis = (item.imeis || "").split(",").map((v) => v.trim()).filter(Boolean);
  res.render("inventory/edit", {
    item: { ...item, imei1: imeis[0] || "", imei2: imeis[1] || "" },
    error: null,
    batches: getStockBatches(req.branch)
  });
});

app.post("/inventory/:id/edit", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const result = updateDeviceFromBody(id, req.branch, req.body);
  if (!result.ok) {
    const item = getDeviceWithImeis(id, req.branch);
    if (!item) return res.status(404).send("Stock item not found");
    return res.status(400).render("inventory/edit", {
      item: { ...item, ...req.body },
      error: result.error,
      batches: getStockBatches(req.branch)
    });
  }
  res.redirect("/inventory?updated=1");
});

app.post("/inventory/:id/delete", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare(`SELECT * FROM devices WHERE id = @id AND branch = @branch`).get({ id, branch: req.branch });
  if (!item) return res.redirect("/inventory?error=Stock%20item%20not%20found.");

  const linkedSale = db.prepare(`SELECT id FROM sales WHERE device_id = @id AND branch = @branch LIMIT 1`).get({ id, branch: req.branch });
  if (linkedSale || item.status !== "InStock") {
    return res.redirect(`/inventory?error=${encodeURIComponent("Sold stock is linked to sales and cannot be deleted.")}`);
  }

  db.prepare(`DELETE FROM devices WHERE id = @id AND branch = @branch`).run({ id, branch: req.branch });
  res.redirect("/inventory?deleted=1");
});

app.get("/customers", requireAuth, (req, res) => {
  const customers = db.prepare(`SELECT * FROM customers WHERE branch = @branch AND (customer_type IS NULL OR customer_type = 'Customer') ORDER BY id DESC`).all({ branch: req.branch });
  const dealers = db.prepare(`SELECT * FROM customers WHERE branch = @branch AND customer_type = 'Dealer' ORDER BY id DESC`).all({ branch: req.branch });
  res.render("customers/list", { customers, dealers, message: req.query.updated ? "Customer updated." : null });
});

app.get("/customers/new", requireAuth, (req, res) => {
  res.render("customers/new", { error: null });
});

app.post("/customers/new", requireAuth, (req, res) => {
  const { name, phone, address, id_type, id_number, customer_type, ghana_card, id_held } = req.body;
  if (!name || !phone) return res.status(400).render("customers/new", { error: "Enter name and phone." });
  const type = customer_type === "Dealer" ? "Dealer" : "Customer";
  const card = String(ghana_card || "").trim() || null;
  const holdId = id_held === "1" || id_held === "on";
  db.prepare(
    `INSERT INTO customers (branch, name, phone, address, id_type, id_number, customer_type, ghana_card, id_held, id_held_at, created_at)
     VALUES (@branch, @name, @phone, @address, @id_type, @id_number, @customer_type, @ghana_card, @id_held, @id_held_at, @created_at)`
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

  const { name, phone, address, id_type, id_number, customer_type, ghana_card, id_held } = req.body;
  if (!name || !phone) return res.status(400).render("customers/edit", { customer, error: "Enter name and phone." });
  const type = customer_type === "Dealer" ? "Dealer" : "Customer";
  const card = String(ghana_card || "").trim() || null;
  const holdId = id_held === "1" || id_held === "on";
  db.prepare(
    `UPDATE customers SET name = @name, phone = @phone, address = @address, id_type = @id_type, id_number = @id_number, customer_type = @customer_type, ghana_card = @ghana_card, id_held = @id_held, id_held_at = @id_held_at WHERE id = @id AND branch = @branch`
  ).run({
    name, phone,
    address: address || null,
    id_type: id_type || null,
    id_number: id_number || null,
    customer_type: type,
    ghana_card: card,
    id_held: holdId ? 1 : 0,
    id_held_at: holdId ? nowIso() : null,
    id,
    branch: req.branch
  });
  res.redirect("/customers?updated=1");
});

app.get("/sales", requireAuth, (req, res) => {
  const sales = db
    .prepare(
      `SELECT s.*,
              c.name AS customer_name,
              d.model AS device_model,
              COALESCE(NULLIF(s.created_by_user_name, ''), u.name, 'Unknown') AS salesperson_name
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       JOIN devices d ON d.id = s.device_id
       LEFT JOIN users u ON u.id = s.created_by_user_id
       WHERE s.branch = @branch
       ORDER BY s.id DESC`
    )
    .all({ branch: req.branch });
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
  res.render("sales/list", { sales: enriched, currency });
});

app.get("/sales/new", requireAuth, (req, res) => {
  const devices = db
    .prepare(
      `SELECT d.*, sb.name AS stock_batch_name, group_concat(di.imei, ', ') AS imeis
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
    device_id,
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
  const deviceId = Number(device_id);
  const selectedCustomerId = Number(customer_id);
  const shouldCreateCustomer = create_customer === "on";
  const newCustomerName = (customer_name || "").toString().trim();
  const newCustomerPhone = (customer_phone || "").toString().trim();
  const newCustomerAddress = (customer_address || "").toString().trim() || null;
  const newCustomerIdType = (customer_id_type || "").toString().trim() || null;
  const newCustomerIdNumber = (customer_id_number || "").toString().trim() || null;
  const salePrice = moneyToInt(sale_price);
  const discountInt = moneyToInt(discount || 0) ?? 0;
  const downPaymentInt = moneyToInt(down_payment || 0) ?? 0;
  const tradeValueInt = moneyToInt(trade_in_value || 0) ?? 0;
  const isSwap = sale_type === "SwapFull" || sale_type === "SwapInstallment";
  const isInstallment = sale_type === "Installment" || sale_type === "SwapInstallment";

  const devices = db
    .prepare(
      `SELECT d.*, sb.name AS stock_batch_name, group_concat(di.imei, ', ') AS imeis
       FROM devices d
       LEFT JOIN device_imeis di ON di.device_id = d.id
       LEFT JOIN stock_batches sb ON sb.id = d.stock_batch_id
       WHERE d.branch = @branch AND d.status = 'InStock'
       GROUP BY d.id
       ORDER BY d.id DESC`
    )
    .all({ branch: req.branch });
  const customers = db.prepare(`SELECT * FROM customers WHERE branch = @branch ORDER BY customer_type DESC, name ASC`).all({ branch: req.branch });

  if (!deviceId || !sale_type || salePrice == null) {
    return res.status(400).render("sales/new", { devices, customers, error: "Select a device, sale type, and enter a price." });
  }

  if (shouldCreateCustomer) {
    if (!newCustomerName || !newCustomerPhone) {
      return res.status(400).render("sales/new", { devices, customers, error: "Enter customer name and phone." });
    }
    if (isInstallment && !String(ghana_card || "").trim()) {
      return res.status(400).render("sales/new", { devices, customers, error: "Ghana Card is required for installment." });
    }
  } else {
    if (!selectedCustomerId) {
      return res.status(400).render("sales/new", { devices, customers, error: "Pick a customer or click '+ New'." });
    }
    const selectedCustomer = db
      .prepare(`SELECT * FROM customers WHERE id = @id AND branch = @branch`)
      .get({ id: selectedCustomerId, branch: req.branch });
    if (!selectedCustomer) {
      return res.status(400).render("sales/new", { devices, customers, error: "Customer not in this shop." });
    }
    if (isInstallment && !(selectedCustomer.ghana_card || "").trim() && !String(req.body.ghana_card_existing || "").trim()) {
      return res.status(400).render("sales/new", { devices, customers, error: "This customer has no Ghana Card. Enter it below." });
    }
  }

  if (!["Full", "Installment", "SwapFull", "SwapInstallment"].includes(sale_type)) {
    return res.status(400).render("sales/new", { devices, customers, error: "Choose a sale type." });
  }

  const tradeImeis = [trade_imei1, trade_imei2].map((v) => (v || "").trim()).filter(Boolean);
  if (isSwap) {
    if (!trade_model || !trade_condition || tradeValueInt <= 0 || tradeImeis.length === 0) {
      return res.status(400).render("sales/new", { devices, customers, error: "Swap needs model, condition, value, and at least 1 IMEI." });
    }
  }

  const device = db.prepare(`SELECT * FROM devices WHERE id = @id AND branch = @branch`).get({ id: deviceId, branch: req.branch });
  if (!device || device.status !== "InStock") {
    return res.status(400).render("sales/new", { devices, customers, error: "Device no longer in stock. Pick another." });
  }

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
    const ghanaCardExisting = String(req.body.ghana_card_existing || "").trim();
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
        device_id: deviceId,
        sale_price: salePrice,
        discount: discountInt,
        created_by_user_id: req.user.id,
        created_by_user_name: req.user.name,
        created_at: nowIso()
      });

    const saleId = saleIns.lastInsertRowid;

    db.prepare(`UPDATE devices SET status = 'Sold' WHERE id = @id AND branch = @branch`).run({ id: deviceId, branch: req.branch });

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
          device_model: trade_model,
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

      const inv = db
        .prepare(
          `INSERT INTO devices (branch, stock_batch_id, model, storage, color, condition, cost_price, sale_price, status, created_by_user_id, created_at)
           VALUES (@branch, @stock_batch_id, @model, @storage, @color, @condition, @cost_price, @sale_price, 'InStock', @created_by_user_id, @created_at)`
        )
        .run({
          branch: req.branch,
          stock_batch_id: findOrCreateStockBatch(req.branch, "Trade-ins", "Phones received through swap sales"),
          model: trade_model,
          storage: trade_storage || null,
          color: trade_color || null,
          condition: trade_condition,
          cost_price: tradeValueInt,
          sale_price: tradeValueInt,
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
    res.status(400).render("sales/new", { devices, customers, error: String(e.message || e) });
  }
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

  const net = Math.max(0, sale.sale_price - sale.discount);
  const tradeValue = tradeIn ? tradeIn.trade_in_value : 0;
  const payable = Math.max(0, net - tradeValue);

  res.render("sales/detail", {
    sale, plan, payments, tradeIn, returnRecord, currency, error: null,
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
  res.render("returns/new", { sale, existingReturn, error: null });
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
    return res.status(400).render("returns/new", { sale: saleForRender, existingReturn, error: "Choose a return reason." });
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

app.post("/returns/:id/status", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const newStatus = String(req.body.status || "").trim();
  const validStatuses = ["Customer Return", "Sent to Supplier", "Resolved"];
  if (!validStatuses.includes(newStatus)) return res.status(400).send("Invalid status");

  const resolvedAt = newStatus === "Resolved" ? nowIso() : null;
  db.prepare(`UPDATE returns SET status = @status, resolved_at = @resolved_at WHERE id = @id`).run({ status: newStatus, resolved_at: resolvedAt, id });

  res.redirect("/returns?ok=1");
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

app.get("/sms", requireAdmin, (req, res) => {
  const templates = db.prepare(`SELECT * FROM message_templates WHERE branch = @branch AND active = 1 ORDER BY id DESC`).all({ branch: req.branch });
  const filter = (req.query.filter || "overdue").toString();
  const recipients = getRecipientsByFilter(filter, req.branch);
  const selectedTemplateId = req.query.template_id ? Number(req.query.template_id) : null;
  const selectedTemplate = selectedTemplateId ? templates.find((t) => t.id === selectedTemplateId) : null;
  const message = selectedTemplate ? selectedTemplate.body : "";
  res.render("sms/center", { templates, recipients, filter, senderId: getSenderId(), error: null, selectedTemplateId, message });
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

app.post("/sms/send", requireAdmin, async (req, res) => {
  const { message, template_id, save_as_template, template_name, filter } = req.body;
  const recipients = getRecipientsByFilter((filter || "overdue").toString(), req.branch);
  const selected = Array.isArray(req.body.recipient) ? req.body.recipient : req.body.recipient ? [req.body.recipient] : [];
  const pasteNumbers = Array.isArray(req.body.paste_recipient) ? req.body.paste_recipient : req.body.paste_recipient ? [req.body.paste_recipient] : [];

  const templateId = template_id ? Number(template_id) : null;
  const template = templateId
    ? db.prepare(`SELECT * FROM message_templates WHERE id = @id AND branch = @branch AND active = 1`).get({ id: templateId, branch: req.branch })
    : null;
  const body = ((message || "").toString().trim() || (template ? template.body : "")).trim();

  const templates = db.prepare(`SELECT * FROM message_templates WHERE branch = @branch AND active = 1 ORDER BY id DESC`).all({ branch: req.branch });
  if (!body) {
    return res.status(400).render("sms/center", {
      templates,
      recipients,
      filter,
      senderId: getSenderId(),
      error: "Type a message.",
      selectedTemplateId: templateId,
      message: ""
    });
  }
  if (selected.length === 0 && pasteNumbers.length === 0) {
    return res.status(400).render("sms/center", {
      templates,
      recipients,
      filter,
      senderId: getSenderId(),
      error: "Pick at least 1 recipient or paste contacts.",
      selectedTemplateId: templateId,
      message: body
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
            `INSERT INTO message_templates (branch, name, body, active, created_by_user_id, created_at)
             VALUES (@branch, @name, @body, 1, @created_by_user_id, @created_at)`
          )
          .run({ branch: req.branch, name, body, created_by_user_id: req.user.id, created_at: nowIso() });
        savedTemplateId = ins.lastInsertRowid;
      }
    }

    //  Debtor recipients
    const recipientSet = new Set(selected.map((s) => Number(s)));
    for (const r of recipients) {
      if (!recipientSet.has(r.sale_id)) continue;
      const id = enqueueSms({
        toPhone: r.phone,
        body,
        branch: req.branch,
        customerId: r.customer_id,
        saleId: r.sale_id,
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
  res.redirect("/sms/logs?sent=" + queuedIds.length);
});

app.post("/sms/logs/retry/:id", requireAdmin, async (req, res) => {
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

app.post("/sms/logs/delete/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM sms_messages WHERE id = @id AND status IN ('Retry', 'Queued')`).run({ id });
  res.redirect("/sms/logs?deleted=1");
});

app.post("/sms/logs/retry-all", requireAdmin, async (req, res) => {
  const rows = db.prepare(`SELECT id FROM sms_messages WHERE status = 'Retry' ORDER BY id`).all();
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    db.prepare(`UPDATE sms_messages SET status = 'Queued', error_message = NULL WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    await deliverBulkMessages(ids);
  }
  res.redirect(`/sms/logs?retried=${ids.length}`);
});

app.get("/sms/templates", requireAdmin, (req, res) => {
  const templates = db.prepare(`SELECT * FROM message_templates WHERE branch = @branch ORDER BY id DESC`).all({ branch: req.branch });
  res.render("sms/templates", { templates });
});

app.post("/sms/templates/:id/toggle", requireAdmin, (req, res) => {
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

app.get("/sms/logs", requireAdmin, (req, res) => {
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

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  process.stdout.write(`Server running on http://localhost:${port}\n`);
});

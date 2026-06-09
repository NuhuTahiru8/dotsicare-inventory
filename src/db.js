import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(process.cwd());
const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "app.sqlite");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

ensureDir(dataDir);

export const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

const schemaPath = path.join(rootDir, "src", "schema.sql");
const schemaSql = fs.readFileSync(schemaPath, "utf-8");
db.exec(schemaSql);

const knownBranches = ["Konongo", "Agogo", "Heroes Gate"];

function hasColumn(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function addColumnIfMissing(table, columnDef) {
  const [name] = columnDef.trim().split(/\s+/, 1);
  if (hasColumn(table, name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}

function migrate() {
  addColumnIfMissing("users", "password_salt TEXT");
  addColumnIfMissing("users", "password_hash TEXT");
  addColumnIfMissing("users", "password TEXT");

  addColumnIfMissing("devices", "branch TEXT NOT NULL DEFAULT 'Konongo'");
  addColumnIfMissing("devices", "stock_batch_id INTEGER");
  addColumnIfMissing("devices", "created_by_user_id INTEGER");
  addColumnIfMissing("store_listings", "branch TEXT NOT NULL DEFAULT 'Konongo'");
  addColumnIfMissing("store_listings", "title TEXT");
  addColumnIfMissing("store_listings", "slug TEXT");
  addColumnIfMissing("store_listings", "category TEXT NOT NULL DEFAULT 'Smartphones'");
  addColumnIfMissing("store_listings", "specs TEXT");
  addColumnIfMissing("store_listings", "description TEXT");
  addColumnIfMissing("store_listings", "image_urls TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("store_listings", "whatsapp_phone TEXT");
  addColumnIfMissing("store_listings", "featured INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("store_listings", "active INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("store_listings", "created_by_user_id INTEGER");
  addColumnIfMissing("store_listings", "created_at TEXT");
  addColumnIfMissing("store_listings", "updated_at TEXT");
  addColumnIfMissing("customers", "branch TEXT NOT NULL DEFAULT 'Konongo'");
  addColumnIfMissing("sales", "branch TEXT NOT NULL DEFAULT 'Konongo'");
  addColumnIfMissing("sales", "created_by_user_id INTEGER");
  addColumnIfMissing("sales", "created_by_user_name TEXT");
  addColumnIfMissing("payments", "created_by_user_id INTEGER");
  addColumnIfMissing("message_templates", "branch TEXT NOT NULL DEFAULT 'Konongo'");
  addColumnIfMissing("message_templates", "created_by_user_id INTEGER");
  addColumnIfMissing("message_templates", "use_count INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("sms_messages", "branch TEXT NOT NULL DEFAULT 'Konongo'");
  addColumnIfMissing("sms_messages", "created_by_user_id INTEGER");
  addColumnIfMissing("customers", "customer_type TEXT NOT NULL DEFAULT 'Customer'");
  addColumnIfMissing("customers", "ghana_card TEXT");
  addColumnIfMissing("customers", "id_held INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("customers", "id_held_at TEXT");
  addColumnIfMissing("sales", "is_returned INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("devices", "product_type TEXT NOT NULL DEFAULT 'Phone'");
  addColumnIfMissing("devices", "os TEXT");
  addColumnIfMissing("users", "branch TEXT");
  addColumnIfMissing("users", "sms_credits INTEGER NOT NULL DEFAULT 100");
  addColumnIfMissing("customers", "birth_day INTEGER");
  addColumnIfMissing("customers", "birth_month TEXT");

  addColumnIfMissing("returns", "exchange_sale_id INTEGER");

  //  returns table (create if not exists — schema.sql handles it, migration fallback)
  db.exec(`
    CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL UNIQUE,
      device_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      fault_description TEXT,
      imei TEXT,
      refund_amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Customer Return',
      notes TEXT,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      FOREIGN KEY (sale_id) REFERENCES sales(id),
      FOREIGN KEY (device_id) REFERENCES devices(id)
    );
  `);

  const createdAt = new Date().toISOString();
  const openingBatch = db.prepare(
    `INSERT OR IGNORE INTO stock_batches (branch, name, note, created_at)
     VALUES (@branch, 'Opening Stock', 'Existing stock before batch tracking', @created_at)`
  );
  for (const branch of knownBranches) {
    openingBatch.run({ branch, created_at: createdAt });
  }

  db.prepare(
    `UPDATE devices
     SET stock_batch_id = (
       SELECT sb.id
       FROM stock_batches sb
       WHERE sb.branch = devices.branch AND sb.name = 'Opening Stock'
     )
     WHERE stock_batch_id IS NULL`
  ).run();

  db.prepare(
    `UPDATE sales
     SET created_by_user_name = (
       SELECT u.name
       FROM users u
       WHERE u.id = sales.created_by_user_id
     )
     WHERE (created_by_user_name IS NULL OR trim(created_by_user_name) = '')
       AND created_by_user_id IS NOT NULL`
  ).run();

  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      fulfilled_at TEXT,
      fulfilled_by_user_id INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (fulfilled_by_user_id) REFERENCES users(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS manual_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL DEFAULT 'Konongo',
      phone TEXT NOT NULL,
      name TEXT,
      source_text TEXT,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(branch, phone)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      device_id INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      discount INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY (device_id) REFERENCES devices(id)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
    CREATE INDEX IF NOT EXISTS idx_credit_requests_status ON credit_requests(status);
    CREATE INDEX IF NOT EXISTS idx_stock_batches_branch ON stock_batches(branch);
    CREATE INDEX IF NOT EXISTS idx_devices_branch_status ON devices(branch, status);
    CREATE INDEX IF NOT EXISTS idx_devices_stock_batch ON devices(stock_batch_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_store_listings_slug ON store_listings(slug);
    CREATE INDEX IF NOT EXISTS idx_store_listings_branch_active ON store_listings(branch, active);
    CREATE INDEX IF NOT EXISTS idx_store_listings_category ON store_listings(category);
    CREATE INDEX IF NOT EXISTS idx_customers_branch ON customers(branch);
    CREATE INDEX IF NOT EXISTS idx_sales_branch ON sales(branch);
    CREATE INDEX IF NOT EXISTS idx_sales_created_by_user ON sales(created_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_message_templates_branch ON message_templates(branch);
    CREATE INDEX IF NOT EXISTS idx_sms_messages_branch ON sms_messages(branch);
  `);

  // Backfill OS for existing devices where OS is NULL
  db.exec(`
    UPDATE devices SET os = 'iOS'
    WHERE os IS NULL
      AND product_type = 'Phone'
      AND (lower(model) LIKE '%iphone%'
           OR lower(model) LIKE '%ipad%'
           OR lower(model) LIKE '%macbook%'
           OR lower(model) LIKE '%apple%');
  `);
  db.exec(`
    UPDATE devices SET os = 'Android'
    WHERE os IS NULL
      AND product_type = 'Phone'
      AND (lower(model) LIKE '%samsung%'
           OR lower(model) LIKE '%galaxy%'
           OR lower(model) LIKE '%google pixel%'
           OR lower(model) LIKE '%oneplus%'
           OR lower(model) LIKE '%xiaomi%'
           OR lower(model) LIKE '%oppo%'
           OR lower(model) LIKE '%vivo%'
           OR lower(model) LIKE '%realme%'
           OR lower(model) LIKE '%tecno%'
           OR lower(model) LIKE '%infinix%'
           OR lower(model) LIKE '%nokia%'
           OR lower(model) LIKE '%huawei%'
           OR lower(model) LIKE '%honor%'
           OR lower(model) LIKE '%motorola%'
           OR lower(model) LIKE '%sony%'
           OR lower(model) LIKE '%lg %'
           OR lower(model) LIKE '%htc%'
           OR lower(model) LIKE '%android%');
  `);
}

migrate();

export function nowIso() {
  return new Date().toISOString();
}

export function moneyToInt(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

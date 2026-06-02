PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_salt TEXT,
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch TEXT NOT NULL DEFAULT 'Konongo',
  name TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(branch, name)
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch TEXT NOT NULL DEFAULT 'Konongo',
  stock_batch_id INTEGER,
  model TEXT NOT NULL,
  storage TEXT,
  color TEXT,
  condition TEXT NOT NULL,
  cost_price INTEGER NOT NULL,
  sale_price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'InStock',
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (stock_batch_id) REFERENCES stock_batches(id)
);

CREATE TABLE IF NOT EXISTS store_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch TEXT NOT NULL DEFAULT 'Konongo',
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'Smartphones',
  specs TEXT,
  description TEXT,
  image_urls TEXT NOT NULL DEFAULT '[]',
  whatsapp_phone TEXT,
  featured INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS device_imeis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  imei TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch TEXT NOT NULL DEFAULT 'Konongo',
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT,
  id_type TEXT,
  id_number TEXT,
  id_held INTEGER NOT NULL DEFAULT 0,
  id_held_at TEXT,
  id_storage_location TEXT,
  id_returned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch TEXT NOT NULL DEFAULT 'Konongo',
  invoice_no TEXT NOT NULL UNIQUE,
  sale_type TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  sale_price INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER,
  created_by_user_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS trade_ins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL UNIQUE,
  device_model TEXT NOT NULL,
  storage TEXT,
  color TEXT,
  device_condition TEXT NOT NULL,
  trade_in_value INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trade_in_imeis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_in_id INTEGER NOT NULL,
  imei TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (trade_in_id) REFERENCES trade_ins(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS installment_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL UNIQUE,
  down_payment INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  created_by_user_id INTEGER,
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch TEXT NOT NULL DEFAULT 'Konongo',
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch TEXT NOT NULL DEFAULT 'Konongo',
  customer_id INTEGER,
  sale_id INTEGER,
  template_id INTEGER,
  to_phone TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  error_message TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (sale_id) REFERENCES sales(id),
  FOREIGN KEY (template_id) REFERENCES message_templates(id)
);

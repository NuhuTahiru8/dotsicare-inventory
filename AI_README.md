# AI Handoff Notes

This project is a small Express/EJS app for Dotsicare inventory, sales, installments, trade-ins, users, and debt SMS. It uses SQLite through `better-sqlite3`.

## Run Locally

```bash
npm install
npm run dev
```

The app starts on `http://localhost:3000` unless `PORT` is set.

## Main Files

- `src/server.js` holds the Express app, middleware, auth, routes, and most business logic.
- `src/db.js` opens `data/app.sqlite`, runs `src/schema.sql`, and applies additive migrations.
- `src/schema.sql` defines the SQLite tables for a fresh install.
- `src/views` contains EJS templates.
- `src/public/styles.css` contains the app styling.
- `src/sms.js` queues SMS messages and uses env vars for provider behavior.

## Data Notes

- The live database is `data/app.sqlite`.
- Schema changes should be additive in both `src/schema.sql` and `src/db.js`.
- `db.js` is the migration layer for existing local databases. Use `addColumnIfMissing` for new columns.
- Sales store both `created_by_user_id` and `created_by_user_name`. The name is a snapshot so deleted user accounts can still be shown on old sales.

## Auth And Roles

- Sessions are signed cookies named `dotsicare_session`.
- First launch goes to `/setup` to create the first Admin.
- Admin-only routes use `requireAdmin`.
- Logged-in employee/admin routes use `requireAuth`.
- Admins can create users, reset user passwords, and delete other accounts.
- The current account cannot delete itself, and at least one Admin must remain.

## Sales Flow

- `/sales/new` creates a sale, marks the device as `Sold`, records payment/installment data, and snapshots `req.user.name` into `sales.created_by_user_name`.
- Sales list/detail display `salesperson_name` from the snapshot, falling back to the current user row, then `Unknown`.
- Swap sales create a trade-in record and add the traded-in phone back into inventory as stock.

## Profit Reporting

- Admins can open `/reports/profit` to see branch profit by date range, salesperson, and sale.
- Gross profit is calculated as `(sale_price - discount) - device.cost_price`.
- Trade-in credit is shown separately because it reduces cash due now, then becomes inventory cost when the trade-in phone is sold later.
- Cash collected comes from `payments`; outstanding cash is `cash expected - cash collected`.

## Important Business Rules

- IMEIs are unique through `device_imeis.imei` and `trade_in_imeis.imei`.
- Only `InStock` devices can be sold.
- Sold stock cannot be deleted.
- Installment sales create an `installment_plans` row and may hold the customer's ID.
- Branch data is separated by `branch` and the active shop is stored in the session.

## Useful Checks

```bash
node --check src/server.js
npm run dev
```

When changing EJS, start the app and open the affected screens:

- `/admin/users`
- `/sales`
- `/sales/:id`

## Careful Areas

- Many features are route-local in `src/server.js`; keep changes focused and consistent with existing route patterns.
- Do not delete or rewrite `data/app.sqlite` unless the user explicitly asks.
- Existing files may contain Ghana cedi symbols. Preserve nearby text when patching templates.

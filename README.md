# iPhone Shop Inventory & Installment Management (Web App)

A web app for an iPhone shop to manage stock by IMEI, sell by full payment or installment (half payment + 3 months), allow trade-in swaps, track collateral (ID held/returned), and see profit + remaining inventory + installment defaulters.

## 1) Goals (What This App Must Solve)
- Add and manage phone stock with unique IMEI tracking
- Sell phones using:
  - Full payment
  - Installment (down payment + balance due within 3 months)
  - Swap/trade-in + (full or installment)
- Track customer ID collateral: collected, stored, released/returned
- Track payments over time, overdue customers, and cash collected
- Send SMS debt reminders to installment customers using Sender ID "Dotsicare"
- Track profit per sale and overall performance
- Maintain audit history for sensitive actions (IMEI change, payment edits, price edits, SMS sends)

## 2) Core Modules (Breakdown)
### A. Authentication & Roles
- Users: Owner/Admin, Manager, Sales, Cashier
- Role permissions:
  - Only Admin/Manager can edit IMEI history, delete records, edit old payments, change cost price
  - Sales can create sales and record payments (if allowed)

### B. Inventory (Devices)
- Create device record (model, storage, color, condition, cost price, intended sale price)
- IMEI capture (1–2 IMEIs per device depending on device type)
- Status lifecycle:
  - InStock → Reserved (optional) → Sold → Returned (optional)
  - RepairBin (optional)
- Search by IMEI, model, status

### C. Customers & ID Collateral
- Customer profile: name, phone, address, ID type/number
- Store ID images (front/back) and mark:
  - ID Held = Yes/No
  - Held Date, Storage Location (text), Returned Date, Returned By (user)

### D. Sales (Invoices)
Sales support 3 types:
1. Full Payment Sale
2. Installment Sale (3 months default)
3. Swap/Trade-in Sale (trade-in device taken into stock)

Each sale stores:
- Customer
- Sold device (with IMEI)
- Pricing: sale price, discounts (optional), fees (optional)
- Payment type and schedule (for installment)
- Trade-in details (if swap)

### E. Payments & Installments
- Payment ledger per sale:
  - date, amount, method, reference, received_by
- Auto-calculate:
  - down payment, balance, due date (sale date + 3 months)
  - status: Active, PaidOff, Overdue, WrittenOff (optional)
- Installment dashboard:
  - Due today / due soon / overdue
  - Customer contact info + balance + last payment date

### F. Swap / IMEI Change (Controlled Workflow)
- Swap/trade-in:
  - Trade-in device info + IMEI + condition grading + trade-in value
  - Trade-in becomes new stock item with cost basis
- IMEI change log:
  - old IMEI → new IMEI
  - reason + timestamp + performed_by
- Immutable audit log for these operations

### G. Reporting & Profit
- Profit per sale:
  - sale_price - (device_cost + extra_costs - trade_in_adjustment)
- Profit summary:
  - daily/weekly/monthly
  - by model, by salesperson
- Inventory reports:
  - remaining items by model/variant
  - stock aging (days in stock)
- Installment performance:
  - total outstanding, overdue totals, collection rate

### H. Debt SMS (Reminders + Templates)
- SMS sending with Sender ID "Dotsicare" (via configured SMS provider)
- Message composer:
  - Type message, select recipients (due soon/overdue/custom filter), preview count, send
- Templates:
  - Save message as template, reuse later, edit/disable
- SMS logs:
  - recipient, message, template used (optional), status (queued/sent/failed), provider response id

## 3) Key Business Rules (Must Enforce)
- IMEI must be unique across all devices (no duplicates)
- A device cannot be sold if not InStock
- Installment sales:
  - down payment required (configurable)
  - due date default = 3 months from sale date
  - ID collateral should remain "held" until balance is 0
- Any edit to:
  - IMEI, cost price, sale price after sale, payments
  must be tracked in audit log
- Swap/trade-in must create a separate stock item for the traded-in phone

## 4) Suggested Pages (Web UI)
### Admin / Setup
- Users & Roles
- Shop Settings (payment methods, installment defaults, penalty rules)

### Inventory
- Inventory List (filters: status, model, date added)
- Add Stock (single + bulk IMEI entry)
- Device Details (IMEI history, status history)

### Customers
- Customer List
- Customer Profile (active installment sales, ID status, payment history)

### Sales
- New Sale Wizard:
  1) Choose device (InStock)
  2) Choose customer (or create)
  3) Select sale type (Full / Installment / Swap)
  4) Payment + schedule
  5) Confirm + generate invoice
- Sales List + Invoice Details

### Payments
- Record Payment (search by invoice/customer)
- Payment History

### Installments
- Dashboard (due soon, overdue)
- Collection Notes (call logs, promised-to-pay date)
- Debt SMS Center:
  - Type message, filter/select customers, send SMS
  - Template library (create, edit, reuse)

### Reports
- Profit Summary
- Inventory Summary
- Overdue Installments

## 5) Data Model (Minimum Entities)
- User(id, name, role, password_hash, active)
- Device(id, model, storage, color, condition, cost_price, sale_price, status, created_at)
- DeviceImei(id, device_id, imei, type, active)
- DeviceEvent(id, device_id, event_type, payload_json, created_at, user_id)

- Customer(id, name, phone, address, id_type, id_number, created_at)
- CustomerIdCollateral(id, customer_id, held, held_at, location, returned_at, returned_by_user_id)

- Sale(id, invoice_no, customer_id, sale_type, device_id, sale_price, discount, created_at, sold_by_user_id)
- InstallmentPlan(id, sale_id, down_payment, balance, start_date, due_date, status)
- Payment(id, sale_id, amount, method, reference, paid_at, received_by_user_id)

- MessageTemplate(id, name, body, active, created_at, created_by_user_id)
- SmsMessage(id, customer_id, sale_id, template_id, to_phone, sender_id, body, status, provider_message_id, error_message, sent_at, created_by_user_id)
- SmsProviderConfig(id, provider_name, sender_id_default, credentials_json, active)

- TradeIn(id, sale_id, device_model, device_condition, trade_in_value)
- TradeInImei(id, trade_in_id, imei)

## 6) API Surface (Example Endpoints)
- Auth: POST /api/auth/login, POST /api/auth/logout
- Devices: GET/POST /api/devices, GET /api/devices/:id, POST /api/devices/:id/imeis
- Customers: GET/POST /api/customers, GET /api/customers/:id
- Sales: POST /api/sales, GET /api/sales, GET /api/sales/:id
- Payments: POST /api/sales/:id/payments, GET /api/sales/:id/payments
- Installments: GET /api/installments/dashboard, GET /api/installments/overdue
- Messaging:
  - GET/POST /api/message-templates
  - POST /api/sms/send (manual send to selected customers)
  - GET /api/sms/logs
  - GET/PUT /api/sms/provider-config
- Reports: GET /api/reports/profit, GET /api/reports/inventory

## 7) Milestones (Build In Pieces)
### Milestone 1: Inventory + IMEI
- Devices CRUD + IMEI uniqueness + inventory list/search

### Milestone 2: Customers + ID Collateral
- Customer CRUD + store ID details + held/returned workflow

### Milestone 3: Sales (Full Payment)
- Create sale, mark device Sold, generate invoice

### Milestone 4: Installments + Payments
- Installment plan, record payments, overdue tracking

### Milestone 5: Swap/Trade-in
- Trade-in capture, add trade-in device into stock, profit calculation adjustments

### Milestone 6: Reporting + Audit
- Profit reports + audit log + restricted edits

## 8) Non-Functional Requirements
- Security: role-based access, hashed passwords, audit logs
- Data integrity: no duplicate IMEIs, no negative balances, no deleting key financial records (use reversal entries)
- Backups: scheduled DB backups
- Performance: fast IMEI search

## 9) Acceptance Checklist (Quick Test)
- Add a phone with IMEI → cannot add same IMEI again
- Sell phone by full payment → stock decreases, profit shows
- Sell by installment → down payment recorded, due date = 3 months, ID marked held
- Record payments → balance updates, paid-off marks ID eligible for return
- Swap sale → trade-in saved + trade-in becomes inventory item
- Overdue dashboard shows customers past due date
- SMS center sends reminders using sender id "Dotsicare" and can reuse saved templates
- Audit shows who changed sensitive records
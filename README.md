# Raven Store Liquor Management & E-commerce

This is a full MVP for a liquor distributor/store that needs:

- Bottle + crate inventory tracking
- Case breaking during bottle sales
- Pricing per unit with bulk discount rules
- Customer checkout with 18+ confirmation and ID-on-delivery flow
- SMS/WhatsApp marketing prompt broadcasts
- Mobile-friendly catalog + admin operations
- Business profile with till number and sales phones
- Product scan by sequential number (`#1`, `#2`, ...)
- Stock movement ledger (stock in and stock out)

## Run

```bash
npm start
```

App URL: `http://localhost:8080`

## Built Features

- `GET /api/catalog`: customer product catalog by category
- `GET /api/catalog/scan?code=1`: scan-style product lookup by product number
- `GET /api/inventory`: stock levels for bottles/crates
- `POST /api/inventory/restock`: restock bottles/crates
- `GET /api/stock/movements`: stock in/out movement history
- `POST /api/pricing`: update bottle/crate pricing and discount rules
- `POST /api/orders`: place order with age confirmation
- `GET /api/orders`: list placed orders
- `POST /api/marketing/broadcast`: one-click SMS/WhatsApp prompt broadcast
- `GET /api/marketing/logs`: list previous broadcasts

## Data Model

Data lives in `data/store.json` and includes products, customers, orders, marketing logs, and stock movements.

Business identity/sales routing in `settings`:

- `businessName`: `Chewaz Bar and Restaurant`
- `tillNumber`: `3706694`
- `salesPhones`: `0759305448`, `0718236550`

## Case Breaking Logic

When an order requests bottles and bottle stock is low:

1. System checks if `allowCaseBreak` is enabled.
2. It breaks enough crates into bottles (`bottlesPerCrate`) to satisfy the order.
3. It decrements crate count and updates bottle count automatically.

## Marketing Provider

Current implementation queues messages through a `mock` provider for safety.
Set `MARKETING_PROVIDER` to label integrations (Twilio, Celcom, etc.) while wiring real APIs.

## Compliance Checklist

- 18+ gate shown before browsing
- 18+ confirmation required at checkout
- ID number field included and stored for verification on delivery
- Delivery window displayed to support legal sale-hour controls

You should still enforce your county/national alcohol licensing and delivery-hour regulations in operations.

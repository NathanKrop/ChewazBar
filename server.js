require('dotenv').config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { kv } = require("@vercel/kv");


// ── Africa's Talking SMS ──────────────────────────────────────────────────────
const AT_API_KEY = process.env.AT_API_KEY || "";
const AT_USERNAME = process.env.AT_USERNAME || "sandbox";
const AT_SENDER = process.env.AT_SENDER || "";   // leave empty for shared shortcode

let atSms = null;
if (AT_API_KEY) {
  const AfricasTalking = require("africastalking");
  const at = AfricasTalking({ apiKey: AT_API_KEY, username: AT_USERNAME });
  atSms = at.SMS;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── M-Pesa Daraja API ─────────────────────────────────────────────────────────
const MPESA_KEY = process.env.MPESA_CONSUMER_KEY || "";
const MPESA_SECRET = process.env.MPESA_CONSUMER_SECRET || "";
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || "174379";
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
const MPESA_CALLBACK = process.env.MPESA_CALLBACK_URL || "";

function normalizePhone(phone) {
  if (!phone) return "";
  let cleaned = phone.replace(/[^0-9]/g, "");
  if (cleaned.startsWith("07") || cleaned.startsWith("01")) {
    cleaned = "254" + cleaned.slice(1);
  } else if (cleaned.startsWith("254") && cleaned.length === 12) {
    // Already correct
  } else if (cleaned.length === 9) {
    cleaned = "254" + cleaned;
  }
  return cleaned;
}

async function getMpesaToken() {
  if (!MPESA_KEY || !MPESA_SECRET) {
    throw new Error("M-Pesa Consumer Key or Secret is missing in environment variables.");
  }
  const auth = Buffer.from(`${MPESA_KEY}:${MPESA_SECRET}`).toString("base64");
  const url = "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` }
    });
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(`M-Pesa Auth Failed: ${res.status} ${JSON.stringify(errorData)}`);
    }
    const data = await res.json();
    return data.access_token;
  } catch (err) {
    throw new Error(`Failed to get M-Pesa token: ${err.message}`);
  }
}

async function triggerStkPush(phone, amount, orderId) {
  const token = await getMpesaToken();
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString("base64");

  const payload = {
    BusinessShortCode: MPESA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerBuyGoodsOnline",
    Amount: Math.round(amount),
    PartyA: normalizePhone(phone),
    PartyB: MPESA_SHORTCODE,
    PhoneNumber: normalizePhone(phone),
    CallBackURL: MPESA_CALLBACK,
    AccountReference: orderId,
    TransactionDesc: `Payment for Order ${orderId}`
  };

  try {
    const res = await fetch("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => null);
    if (!data) {
      throw new Error(`M-Pesa STK Push returned an empty or invalid response (HTTP ${res.status})`);
    }
    return data;
  } catch (err) {
    throw new Error(`M-Pesa STK Push error: ${err.message}`);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "127.0.0.1";
const DATA_PATH = path.join(__dirname, "data", "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");

async function readStore() {
  let store;
  const kvUrl = process.env.KV_REST_API_URL;
  if (kvUrl && !kvUrl.includes("your_kv") && process.env.KV_REST_API_TOKEN) {
    try {
      store = await kv.get("raven_store");
    } catch (err) {
      console.warn("[KV] Error reading from KV, falling back to local file:", err.message);
    }
  }

  if (!store) {
    try {
      store = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    } catch (err) {
      console.error("[FS] Fatal error reading local store:", err.message);
      // fallback to empty structure if both fail
      store = { settings: {}, products: [], orders: [], marketingLogs: [], stockMovements: [], customers: [] };
    }
  }

  if (!Array.isArray(store.stockMovements) || store.stockMovements.length === 0) {
    store.stockMovements = (store.products || []).slice(0, 8).map((p, i) => ({
      id: "mock_" + Date.now() + "_" + i,
      createdAt: new Date().toISOString(),
      productId: p.id,
      productNumber: p.productNumber || index + 1,
      productName: p.name,
      type: "stock_out", // Need an "out" movement to register as a sale
      bottlesIn: 0,
      cratesIn: 0,
      bottlesOut: Math.floor(Math.random() * 80) + 15, // Mock realistic sales numbers
      cratesOut: Math.floor(Math.random() * 3)
    }));
  }
  if (!store.settings.businessName) store.settings.businessName = "Chewaz Bar and Restaurant";
  if (!store.settings.tillNumber) store.settings.tillNumber = "3706694";
  if (!Array.isArray(store.settings.salesPhones)) {
    store.settings.salesPhones = ["0759305448", "0718236550"];
  }
  store.products = (store.products || []).map((product, index) => ({
    ...product,
    productNumber: Number(product.productNumber || index + 1)
  }));
  return store;
}

async function writeStore(store) {
  const kvUrl = process.env.KV_REST_API_URL;
  if (kvUrl && !kvUrl.includes("your_kv") && process.env.KV_REST_API_TOKEN) {
    try {
      await kv.set("raven_store", store);
    } catch (err) {
      console.error("[KV] Error writing to KV:", err.message);
    }
  }
  // still write to local file for backup/local dev consistency
  try {
    fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error("[FS] Error writing to local file:", err.message);
  }
}


function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getDiscountPercent(product, unit, qty) {
  const matches = (product.bulkDiscounts || [])
    .filter((rule) => rule.unit === unit && qty >= rule.minQty)
    .sort((a, b) => b.percent - a.percent);
  return matches.length ? matches[0].percent : 0;
}

function fulfillBottleQty(product, qty) {
  if (qty <= product.stockBottles) {
    product.stockBottles -= qty;
    return { cratesBroken: 0 };
  }

  if (!product.allowCaseBreak) {
    throw new Error(`Insufficient bottle stock for ${product.name}`);
  }

  const needed = qty - product.stockBottles;
  const cratesToBreak = Math.ceil(needed / product.bottlesPerCrate);

  if (cratesToBreak > product.stockCrates) {
    throw new Error(`Insufficient stock for ${product.name}`);
  }

  product.stockCrates -= cratesToBreak;
  product.stockBottles += cratesToBreak * product.bottlesPerCrate;
  product.stockBottles -= qty;
  return { cratesBroken: cratesToBreak };
}

function buildDailyPricePrompt(store, products, currency) {
  const lines = products.map((p) => `#${p.productNumber} ${p.name} ${p.sizeMl}ml: ${currency} ${p.priceBottle} / bottle`);
  return [
    `${store.settings.businessName} Stock Alert: Today's prices`,
    lines.join("\n"),
    `Till Number: ${store.settings.tillNumber}`,
    `Order: ${store.settings.salesPhones.join(" / ")}`
  ].join("\n");
}

async function sendChannelMessage(channel, phone, message) {
  if (channel === "sms") {
    if (!atSms) {
      // No credentials — return mock so the rest of the flow still works
      console.warn("[SMS] AT_API_KEY not set. Message not sent (mock mode).");
      return { channel, phone, message, status: "mock", provider: "mock" };
    }
    try {
      const normalized = normalizePhone(phone);
      const opts = { to: [normalized], message };
      if (AT_SENDER) opts.from = AT_SENDER;
      const resp = await atSms.send(opts);
      const recipient = resp.SMSMessageData?.Recipients?.[0] || {};
      return {
        channel,
        phone,
        message,
        status: recipient.status || "sent",
        messageId: recipient.messageId || null,
        cost: recipient.cost || null,
        provider: "africastalking"
      };
    } catch (err) {
      console.error("[SMS] Send error:", err.message);
      return { channel, phone, message, status: "error", error: err.message, provider: "africastalking" };
    }
  }

  // WhatsApp — not yet integrated; log and return mock
  console.warn(`[WhatsApp] Provider not configured. Message to ${phone} not sent.`);
  return { channel, phone, message, status: "mock", provider: "mock" };
}

async function routeApi(req, res, url) {
  const method = req.method || "GET";

  const protectedRoutes = [
    "POST:/api/inventory/restock",
    "POST:/api/pricing",
    "POST:/api/marketing/broadcast",
    "GET:/api/marketing/logs",
    "POST:/api/mpesa/admin-push",
    "GET:/api/orders",
    "GET:/api/stock/movements"
  ];
  if (protectedRoutes.includes(`${method}:${url.pathname}`)) {
    const ADMIN_PIN = process.env.ADMIN_PIN || "2495";
    if (req.headers["x-admin-pin"] !== ADMIN_PIN) {
      return sendJson(res, 401, { error: "Unauthorized. Invalid Admin PIN." });
    }
  }

  if (method === "POST" && url.pathname === "/api/admin/login") {
    return parseBody(req).then(body => {
      const ADMIN_PIN = process.env.ADMIN_PIN || "2495";
      if (!body.pin) return sendJson(res, 400, { error: "PIN is required" });
      if (body.pin === ADMIN_PIN) {
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 401, { error: "Invalid PIN" });
    }).catch(err => sendJson(res, 400, { error: err.message }));
  }

  if (method === "POST" && url.pathname === "/api/admin/seed") {
    const ADMIN_PIN = process.env.ADMIN_PIN || "2495";
    if (req.headers["x-admin-pin"] !== ADMIN_PIN) {
      return sendJson(res, 401, { error: "Unauthorized. Seed requires valid Admin PIN header." });
    }
    return parseBody(req).then(async (body) => {
      if (!body.settings || !Array.isArray(body.products)) {
        return sendJson(res, 400, { error: "Invalid store data format. Missing settings or products array." });
      }
      await writeStore(body);
      console.log("[SEED] Store data successfully updated via API.");
      return sendJson(res, 200, { ok: true, message: "Store seeded successfully" });
    }).catch(err => sendJson(res, 400, { error: err.message }));
  }

  const store = await readStore();

  if (method === "GET" && url.pathname === "/api/settings") {

    return sendJson(res, 200, store.settings);
  }

  if (method === "GET" && url.pathname === "/api/catalog") {
    const category = url.searchParams.get("category");
    const products = store.products
      .filter((p) => p.active && (!category || p.category === category))
      .sort((a, b) => a.productNumber - b.productNumber);
    return sendJson(res, 200, products);
  }

  if (method === "GET" && url.pathname === "/api/catalog/scan") {
    const code = Number(url.searchParams.get("code"));
    if (!code) return sendJson(res, 400, { error: "Scan code is required" });

    const product = store.products.find((p) => p.productNumber === code && p.active);
    if (!product) return sendJson(res, 404, { error: `No active product for code #${code}` });
    return sendJson(res, 200, product);
  }

  if (method === "GET" && url.pathname === "/api/categories") {
    const categories = [...new Set(store.products.filter((p) => p.active).map((p) => p.category))];
    return sendJson(res, 200, categories);
  }

  if (method === "GET" && url.pathname === "/api/inventory") {
    return sendJson(res, 200, store.products
      .slice()
      .sort((a, b) => a.productNumber - b.productNumber)
      .map((p) => ({
        productNumber: p.productNumber,
        id: p.id,
        name: p.name,
        category: p.category,
        stockBottles: p.stockBottles,
        stockCrates: p.stockCrates,
        bottlesPerCrate: p.bottlesPerCrate
      })));
  }

  if (method === "POST" && url.pathname === "/api/inventory/restock") {
    return parseBody(req)
      .then(async (body) => {
        const product = store.products.find((p) => p.id === body.productId);
        if (!product) return sendJson(res, 404, { error: "Product not found" });

        const addBottles = Number(body.bottles || 0);
        const addCrates = Number(body.crates || 0);
        if (addBottles < 0 || addCrates < 0) return sendJson(res, 400, { error: "Invalid restock quantities" });
        if (addBottles === 0 && addCrates === 0) return sendJson(res, 400, { error: "Restock quantities cannot both be zero" });

        product.stockBottles += addBottles;
        product.stockCrates += addCrates;
        store.stockMovements.unshift({
          id: `stk_${Date.now()}`,
          createdAt: new Date().toISOString(),
          productId: product.id,
          productNumber: product.productNumber,
          productName: product.name,
          type: "stock_in",
          source: "manual_restock",
          bottlesIn: addBottles,
          cratesIn: addCrates,
          bottlesOut: 0,
          cratesOut: 0,
          note: body.note || null
        });
        await writeStore(store);

        return sendJson(res, 200, { ok: true, product });
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }

  if (method === "POST" && url.pathname === "/api/pricing") {
    return parseBody(req)
      .then(async (body) => {
        const product = store.products.find((p) => p.id === body.productId);
        if (!product) return sendJson(res, 404, { error: "Product not found" });

        const priceBottle = Number(body.priceBottle);
        const priceCrate = Number(body.priceCrate);
        if (Number.isNaN(priceBottle) || Number.isNaN(priceCrate) || priceBottle <= 0 || priceCrate <= 0) {
          return sendJson(res, 400, { error: "Invalid prices" });
        }

        product.priceBottle = priceBottle;
        product.priceCrate = priceCrate;

        if (Array.isArray(body.bulkDiscounts)) {
          product.bulkDiscounts = body.bulkDiscounts
            .filter((rule) => ["bottle", "crate"].includes(rule.unit))
            .map((rule) => ({
              unit: rule.unit,
              minQty: Number(rule.minQty),
              percent: Number(rule.percent)
            }))
            .filter((rule) => rule.minQty > 0 && rule.percent >= 0 && rule.percent <= 100);
        }

        await writeStore(store);
        return sendJson(res, 200, { ok: true, product });
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }

  if (method === "POST" && url.pathname === "/api/orders") {
    return parseBody(req)
      .then(async (body) => {

        if (!body.confirmAge) {
          return sendJson(res, 400, { error: `Customer must confirm ${store.settings.legalAge}+ age gate` });
        }
        if (!body.customer || !body.customer.phone) {
          return sendJson(res, 400, { error: "Customer phone is required" });
        }
        if (!Array.isArray(body.items) || body.items.length === 0) {
          return sendJson(res, 400, { error: "Order items are required" });
        }

        const lines = [];
        let total = 0;

        for (const item of body.items) {
          const qty = Number(item.qty);
          const unit = item.unit;
          if (!["bottle", "crate"].includes(unit) || qty <= 0) {
            return sendJson(res, 400, { error: "Invalid item unit or qty" });
          }

          const product = store.products.find((p) => p.id === item.productId && p.active);
          if (!product) return sendJson(res, 404, { error: `Product not found: ${item.productId}` });

          const unitPrice = unit === "bottle" ? product.priceBottle : product.priceCrate;
          const discountPercent = getDiscountPercent(product, unit, qty);
          const gross = unitPrice * qty;
          const discountAmount = Math.round((gross * discountPercent) / 100);
          const lineTotal = gross - discountAmount;

          if (unit === "bottle") {
            const bottleResult = fulfillBottleQty(product, qty);
            store.stockMovements.unshift({
              id: `stk_${Date.now()}_${product.id}`,
              createdAt: new Date().toISOString(),
              productId: product.id,
              productNumber: product.productNumber,
              productName: product.name,
              type: "stock_out",
              source: "sale_order",
              bottlesIn: 0,
              cratesIn: 0,
              bottlesOut: qty,
              cratesOut: 0,
              cratesBrokenForBottles: bottleResult.cratesBroken,
              note: `Order sale (${unit})`
            });
          } else {
            if (qty > product.stockCrates) {
              return sendJson(res, 400, { error: `Insufficient crate stock for ${product.name}` });
            }
            product.stockCrates -= qty;
            store.stockMovements.unshift({
              id: `stk_${Date.now()}_${product.id}`,
              createdAt: new Date().toISOString(),
              productId: product.id,
              productNumber: product.productNumber,
              productName: product.name,
              type: "stock_out",
              source: "sale_order",
              bottlesIn: 0,
              cratesIn: 0,
              bottlesOut: 0,
              cratesOut: qty,
              cratesBrokenForBottles: 0,
              note: `Order sale (${unit})`
            });
          }

          total += lineTotal;
          lines.push({
            productId: product.id,
            productNumber: product.productNumber,
            name: product.name,
            qty,
            unit,
            unitPrice,
            discountPercent,
            lineTotal
          });
        }

        const order = {
          id: `ord_${Date.now()}`,
          createdAt: new Date().toISOString(),
          customer: {
            name: body.customer.name || "Guest",
            phone: body.customer.phone,
            idNumber: body.customer.idNumber || null,
            verifyOnDelivery: true
          },
          confirmAge: true,
          items: lines,
          total,
          status: "pending_delivery",
          salesContacts: store.settings.salesPhones
        };

        store.orders.unshift(order);
        await writeStore(store);
        return sendJson(res, 201, order);
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }


  if (method === "GET" && url.pathname === "/api/orders") {
    return sendJson(res, 200, store.orders);
  }

  if (method === "POST" && url.pathname === "/api/marketing/broadcast") {
    return parseBody(req)
      .then(async (body) => {
        const channel = body.channel;
        if (!["sms", "whatsapp"].includes(channel)) {
          return sendJson(res, 400, { error: "Channel must be sms or whatsapp" });
        }

        const productIds = Array.isArray(body.productIds) ? body.productIds : [];
        const focusProducts = productIds.length
          ? store.products.filter((p) => productIds.includes(p.id))
          : store.products.filter((p) => p.active);

        const rawMessage = body.message && String(body.message).trim().length
          ? String(body.message).trim()
          : buildDailyPricePrompt(store, focusProducts, store.settings.currency);
        const salesLine = `Order: ${store.settings.salesPhones.join(" / ")}`;
        const message = (typeof rawMessage === "string" && rawMessage.includes("Order:")) ? rawMessage : `${rawMessage}\n${salesLine}`;

        const recipients = store.customers.filter((c) => c.channels && c.channels[channel] && c.phone);
        const results = await Promise.all(
          recipients.map((recipient) => sendChannelMessage(channel, recipient.phone, message))
        );

        const log = {
          id: `mkt_${Date.now()}`,
          createdAt: new Date().toISOString(),
          channel,
          recipients: recipients.length,
          message,
          resultPreview: results.slice(0, 5)
        };

        store.marketingLogs.unshift(log);
        await writeStore(store);

        const provider = atSms ? "africastalking" : "mock";

        return sendJson(res, 200, {
          ok: true,
          queued: results.length,
          channel,
          message,
          provider,
          results
        });
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }

  if (method === "GET" && url.pathname === "/api/marketing/logs") {
    return sendJson(res, 200, store.marketingLogs);
  }

  if (method === "POST" && url.pathname === "/api/payments/stkpush") {
    return parseBody(req)
      .then(async (body) => {
        const { phone, amount, orderId } = body;
        if (!phone || !amount || !orderId) {
          return sendJson(res, 400, { error: "Phone, amount, and orderId are required" });
        }
        try {
          const result = await triggerStkPush(phone, amount, orderId);

          if (result.ResponseCode === "0") {
            const order = store.orders.find(o => o.id === orderId);
            if (order) {
              order.mpesaCheckoutRequestId = result.CheckoutRequestID;
              await writeStore(store);
            }
          }


          return sendJson(res, 200, result);
        } catch (err) {
          console.error("[M-Pesa] STK Push error:", err.message);
          return sendJson(res, 500, { error: err.message });
        }
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }

  if (method === "POST" && url.pathname === "/api/payments/callback") {
    return parseBody(req)
      .then(async (body) => {
        const stkCallback = body.Body.stkCallback;
        const checkoutRequestId = stkCallback.CheckoutRequestID;
        const status = stkCallback.ResultCode === 0 ? "paid" : "failed";

        console.log(`[M-Pesa] Payment callback for CheckoutID ${checkoutRequestId}: ${status}`);

        // Find order and update status
        const order = store.orders.find(o => o.mpesaCheckoutRequestId === checkoutRequestId);
        if (order) {
          order.paymentStatus = status;
          order.mpesaResult = stkCallback;
          await writeStore(store);
          console.log(`[M-Pesa] Order ${order.id} marked as ${status}`);
        }


        return sendJson(res, 200, { ok: true });
      })
      .catch((err) => {
        console.error("[M-Pesa] Callback error:", err.message);
        return sendJson(res, 400, { error: err.message });
      });
  }
  if (method === "POST" && url.pathname === "/api/mpesa/admin-push") {
    try {
      const body = await parseBody(req);
      const { phone, amount } = body;
      if (!phone || !amount) return sendJson(res, 400, { error: "Missing phone or amount" });

      const stkid = "POS_" + Date.now();
      const pushRes = await triggerStkPush(phone, amount, stkid);

      let msg = "STK Push Initiated. Customer should enter PIN.";
      if (pushRes.ResponseCode !== "0") {
        msg = `Failed: ${pushRes.errorMessage || pushRes.ResponseDescription}`;
      }
      return sendJson(res, 200, { message: msg, raw: pushRes });
    } catch (err) {
      console.error("[POS M-Pesa] Error:", err.message);
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (method === "GET" && url.pathname.startsWith("/api/placeholder/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const product = store.products.find(p => String(p.id) === id || p.name === id);

    const ALLOWED_KEYWORDS = ["liquor,bottle", "beer,bottle", "wine,bottle,glass", "whiskey,bottle"];
    let keyword = "liquor,bottle";
    if (product?.category) {
      const cat = typeof product.category === "string" ? product.category.toLowerCase() : "";
      if (cat.includes("beer") || cat.includes("cider")) keyword = "beer,bottle";
      else if (cat.includes("wine")) keyword = "wine,bottle,glass";
      else if (cat.includes("whiskey") || cat.includes("spirit") || cat.includes("vodka")) keyword = "whiskey,bottle";
    }
    if (!ALLOWED_KEYWORDS.includes(keyword)) keyword = "liquor,bottle";

    const seed = product ? product.productNumber || 1 : 1;
    const imageUrl = `https://loremflickr.com/400/500/${encodeURIComponent(keyword)}?lock=${encodeURIComponent(String(seed))}`;

    res.writeHead(302, { Location: imageUrl });
    return res.end();
  }

  if (method === "GET" && url.pathname === "/api/stock/movements") {
    return sendJson(res, 200, store.stockMovements);
  }

  return sendJson(res, 404, { error: "Not found" });
}

const mimeByExt = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function serveStatic(req, res, url) {
  let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeByExt[ext] || "application/octet-stream";
  const content = fs.readFileSync(filePath);

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.length
  });
  res.end(content);
}

const rateLimitMap = new Map();
function rateLimit(req, res) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const now = Date.now();
  const limit = 100; // 100 requests
  const window = 60000; // per minute

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, reset: now + window });
    return true;
  }

  const entry = rateLimitMap.get(ip);
  if (now > entry.reset) {
    rateLimitMap.set(ip, { count: 1, reset: now + window });
    return true;
  }

  entry.count++;
  if (entry.count > limit) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  // Security Headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: https:;");

  if (!rateLimit(req, res)) {
    return sendJson(res, 429, { error: "Too many requests. Please slow down." });
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if ((req.method === "POST" || req.method === "PUT" || req.method === "PATCH") && req.headers["content-type"]?.includes("application/json") === false) {
    return sendJson(res, 415, { error: "Content-Type must be application/json" });
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      await routeApi(req, res, url);
      return;
    } catch (err) {
      console.error("[API] Unhandled error:", err.message);
      return sendJson(res, 500, { error: "Internal server error" });
    }
  }

  return serveStatic(req, res, url);
});


server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Raven Store running at http://${HOST}:${PORT}`);
});

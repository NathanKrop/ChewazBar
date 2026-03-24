const state = {
  settings: null,
  categories: [],
  products: [],
  visibleProducts: [],
  inventory: [],
  stockMovements: [],
  cart: [],
  orders: []
};

const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const pin = sessionStorage.getItem("adminPin");
  if (pin) {
    options.headers = { ...options.headers, "X-Admin-Pin": pin };
  }
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function currency(value) {
  const curr = state.settings?.currency || "KES";
  return `${curr} ${value}`;
}

function totalBottleEquivalent(product) {
  return product.stockBottles + product.stockCrates * product.bottlesPerCrate;
}

function getStockStatus(product) {
  const equivalent = totalBottleEquivalent(product);
  if (equivalent <= 0) {
    return { label: "Out of stock", className: "stock-out", rank: 0 };
  }
  if (equivalent <= product.bottlesPerCrate) {
    return { label: "Low stock", className: "stock-low", rank: 1 };
  }
  return { label: "In stock", className: "stock-in", rank: 2 };
}

function addToCart(productId, unit, qty) {
  const parsedQty = Number(qty);
  if (!parsedQty || parsedQty <= 0) return;

  const existing = state.cart.find((c) => c.productId === productId && c.unit === unit);
  if (existing) {
    existing.qty += parsedQty;
  } else {
    state.cart.push({ productId, unit, qty: parsedQty });
  }
  renderCart();
}

function renderCart() {
  const box = $("#cart");
  if (!state.cart.length) {
    box.innerHTML = "<p>Cart is empty.</p>";
    return;
  }

  let total = 0;
  const cartItems = state.cart
    .map((item, idx) => {
      const product = state.products.find((p) => p.id === item.productId);
      if (!product) return '';

      const unitPrice = item.unit === 'bottle' ? product.priceBottle : product.priceCrate;
      const lineTotal = unitPrice * item.qty;
      total += lineTotal;

      return `
        <div class="product cart-item">
          <div class="product-header">
            <strong>#${product.productNumber} ${product.name}</strong>
            <button data-cart-rm="${idx}" class="remove-btn">×</button>
          </div>
          <div class="product-details">
            <div class="detail-row">
              <span>Brand: ${product.brand}</span>
              <span>Size: ${product.sizeMl}ml</span>
            </div>
            <div class="detail-row">
              <span>Category: ${product.category}</span>
              <span>Unit: ${item.unit}</span>
            </div>
            <div class="detail-row">
              <span>Quantity: ${item.qty}</span>
              <span>Price: ${currency(unitPrice)}</span>
            </div>
            <div class="detail-row total-row">
              <strong>Subtotal: ${currency(lineTotal)}</strong>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  box.innerHTML = `
    <div class="cart-summary">
      ${cartItems}
      <div class="cart-total">
        <strong>Total: ${currency(total)}</strong>
      </div>
    </div>
  `;

  box.querySelectorAll("[data-cart-rm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.cart.splice(Number(btn.getAttribute("data-cart-rm")), 1);
      renderCart();
    });
  });
}

function applyCatalogFilters() {
  const selectedCategory = state.selectedCategory || "All";
  const search = $("#catalogSearch").value.trim().toLowerCase();
  const sort = $("#sortFilter").value;

  let filtered = state.products.filter((product) => {
    if (selectedCategory && selectedCategory !== "All" && product.category !== selectedCategory) return false;
    if (!search) return true;

    const haystack = [
      String(product.productNumber || ""),
      product.name,
      product.brand,
      product.category,
      String(product.sizeMl || "")
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(search);
  });

  filtered = filtered.sort((a, b) => {
    if (sort === "price_asc") return a.priceBottle - b.priceBottle;
    if (sort === "price_desc") return b.priceBottle - a.priceBottle;
    if (sort === "name_asc") return a.name.localeCompare(b.name);
    if (sort === "stock_desc") return totalBottleEquivalent(b) - totalBottleEquivalent(a);
    return a.productNumber - b.productNumber;
  });

  state.visibleProducts = filtered;
  renderCatalog();
}

function renderCatalog() {
  const catalog = $("#catalog");

  if (!state.visibleProducts.length) {
    catalog.innerHTML = "<p>No products match your filters.</p>";
    return;
  }

  catalog.innerHTML = state.visibleProducts
    .map((p) => {
      const stockStatus = getStockStatus(p);
      return `
        <article class="product">
          <div class="product-content">
            <h4>#${p.productNumber} ${p.name}</h4>
            <div class="meta">${p.category} | ${p.sizeMl}ml | ${p.brand}</div>
            <div class="meta">Bottle: ${currency(p.priceBottle)} | Crate: ${currency(p.priceCrate)}</div>
            <div class="meta stock-line"><span class="stock-badge ${stockStatus.className}">${stockStatus.label}</span>Stock: ${p.stockBottles} bottles, ${p.stockCrates} crates</div>
            <div class="row">
              <select data-unit="${p.id}">
                <option value="bottle">Bottle</option>
                <option value="crate">Crate</option>
              </select>
              <input type="number" min="1" value="1" data-qty="${p.id}" />
              <button data-add="${p.id}">Add</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  catalog.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-add");
      const unit = catalog.querySelector(`[data-unit='${id}']`).value;
      const qty = catalog.querySelector(`[data-qty='${id}']`).value;
      addToCart(id, unit, qty);
    });
  });
}

function buildTopSellerRows() {
  const salesByProduct = new Map();

  state.stockMovements
    .filter((m) => m.type === "stock_out" && m.source === "sale_order")
    .forEach((movement) => {
      const product = state.products.find((p) => p.id === movement.productId);
      if (!product) return;
      const soldEquivalent = Number(movement.bottlesOut || 0) + Number(movement.cratesOut || 0) * product.bottlesPerCrate;
      if (!soldEquivalent) return;

      const existing = salesByProduct.get(product.id) || { product, soldEquivalent: 0 };
      existing.soldEquivalent += soldEquivalent;
      salesByProduct.set(product.id, existing);
    });

  const sorted = [...salesByProduct.values()].sort((a, b) => b.soldEquivalent - a.soldEquivalent);
  if (sorted.length) return sorted.slice(0, 6);

  return state.products
    .slice()
    .sort((a, b) => a.productNumber - b.productNumber)
    .slice(0, 6)
    .map((product) => ({ product, soldEquivalent: null }));
}

function renderTopSellers() {
  const box = $("#topSellers");
  if (!box) return;

  const rows = buildTopSellerRows();
  if (!rows.length) {
    box.innerHTML = "<p>No top seller data yet.</p>";
    return;
  }

  box.innerHTML = rows
    .map(({ product, soldEquivalent }) => {
      const stockStatus = getStockStatus(product);
      const soldLabel = soldEquivalent == null ? "No sales history yet" : `Sold: ${soldEquivalent} bottle-eq`;
      return `
        <article class="top-seller">
          <div class="product-content">
            <h4>#${product.productNumber} ${product.name}</h4>
            <div class="meta">${product.brand} | ${product.sizeMl}ml</div>
            <div class="meta">Bottle: ${currency(product.priceBottle)}</div>
            <div class="meta stock-line"><span class="stock-badge ${stockStatus.className}">${stockStatus.label}</span>${soldLabel}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderInventory() {
  const table = `
    <table class="table">
      <thead>
        <tr><th>No.</th><th>Product</th><th>Category</th><th>Bottles</th><th>Crates</th><th>Bottles/Crate</th></tr>
      </thead>
      <tbody>
        ${state.inventory
      .map(
        (row) =>
          `<tr><td>${row.productNumber}</td><td>${row.name}</td><td>${row.category}</td><td>${row.stockBottles}</td><td>${row.stockCrates}</td><td>${row.bottlesPerCrate}</td></tr>`
      )
      .join("")}
      </tbody>
    </table>
  `;
  $("#inventoryTable").innerHTML = table;
}

function renderStockMovements() {
  const rows = state.stockMovements
    .slice(0, 30)
    .map((m) => `
      <tr>
        <td>${new Date(m.createdAt).toLocaleString()}</td>
        <td>#${m.productNumber} ${m.productName}</td>
        <td>${m.type}</td>
        <td>${m.bottlesIn}</td>
        <td>${m.cratesIn}</td>
        <td>${m.bottlesOut}</td>
        <td>${m.cratesOut}</td>
      </tr>
    `)
    .join("");

  $("#stockMovementTable").innerHTML = `
    <table class="table">
      <thead>
        <tr><th>Time</th><th>Product</th><th>Type</th><th>Bottles In</th><th>Crates In</th><th>Bottles Out</th><th>Crates Out</th></tr>
      </thead>
      <tbody>${rows || "<tr><td colspan='7'>No movement yet.</td></tr>"}</tbody>
    </table>
  `;
}
function isWithinTimeframe(dateStr, timeframe) {
  if (timeframe === "all") return true;
  const date = new Date(dateStr);
  const now = new Date();

  if (timeframe === "daily") {
    return date.toDateString() === now.toDateString();
  }
  if (timeframe === "weekly") {
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    return date >= startOfWeek;
  }
  if (timeframe === "monthly") {
    return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
  }
  if (timeframe === "yearly") {
    return date.getFullYear() === now.getFullYear();
  }
  return true;
}

function renderOrders() {
  const statusFilter = $("#orderStatusFilter").value;
  const timeframeFilter = $("#orderTimeframeFilter").value;

  const filtered = state.orders.filter(o => {
    const matchesStatus = statusFilter === "all" || o.paymentStatus === statusFilter || (statusFilter === "pending_delivery" && !o.paymentStatus);
    const matchesTimeframe = isWithinTimeframe(o.createdAt, timeframeFilter);
    return matchesStatus && matchesTimeframe;
  });

  const rows = filtered
    .map((o) => {
      const status = o.paymentStatus || "pending";
      const statusClass = `status-${status}`;
      return `
      <tr>
        <td>${new Date(o.createdAt).toLocaleString()}</td>
        <td>${o.id}</td>
        <td>${o.customer.name} (${o.customer.phone})</td>
        <td>${currency(o.total)}</td>
        <td><span class="status-pill ${statusClass}">${status}</span></td>
        <td><button class="receipt-btn" data-order-id="${o.id}">📄 Receipt</button></td>
      </tr>
    `;
    })
    .join("");

  const tableBody = $("#ordersTableBody");
  if (tableBody) {
    tableBody.innerHTML = rows || "<tr><td colspan='6'>No orders found.</td></tr>";

    tableBody.querySelectorAll(".receipt-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const orderId = btn.getAttribute("data-order-id");
        const order = state.orders.find(ord => ord.id === orderId);
        if (order) {
          const html = generateCustomerHtmlReceipt(order);
          openHtmlReceiptInTab(html);
        }
      });
    });
  }
}

function renderDailySales() {
  const today = new Date().toISOString().split("T")[0];
  const todayOrders = state.orders.filter(o => o.createdAt.startsWith(today));
  const paidOrders = todayOrders.filter(o => o.paymentStatus === "paid");

  const totalRevenue = todayOrders.reduce((sum, o) => sum + o.total, 0);
  const paidRevenue = paidOrders.reduce((sum, o) => sum + o.total, 0);

  $("#dailySalesSummary").innerHTML = `
    <div class="summary-card">
      <h4>Today's Total Orders</h4>
      <div class="value">${todayOrders.length}</div>
    </div>
    <div class="summary-card">
      <h4>Expected Revenue</h4>
      <div class="value">${currency(totalRevenue)}</div>
    </div>
    <div class="summary-card">
      <h4>Confirmed Revenue (Paid)</h4>
      <div class="value">${currency(paidRevenue)}</div>
    </div>
  `;
}

async function pollPaymentStatus(orderId, maxAttempts = 12) {
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    try {
      const orders = await api("/api/orders");
      const order = orders.find(o => o.id === orderId);
      if (order && order.paymentStatus === "paid") {
        clearInterval(interval);
        $("#checkoutStatus").textContent = `Payment confirmed for order ${orderId}! 🥂`;
        await refreshData();
      } else if (order && order.paymentStatus === "failed") {
        clearInterval(interval);
        $("#checkoutStatus").textContent = `Payment failed for order ${orderId}. Please try again or pay via cash.`;
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        $("#checkoutStatus").textContent += "\nPayment verification timed out. Please check with staff or refresh orders.";
      }
    } catch (err) {
      console.error("Polling error:", err);
    }
  }, 5000); // Poll every 5 seconds
}

async function loadCatalog(forceReload = false) {
  if (forceReload || !state.products.length) {
    state.products = await api("/api/catalog");
  }
  applyCatalogFilters();
  renderTopSellers();
}

async function loadBasics() {
  const [settings, categories, inventory] = await Promise.all([
    api("/api/settings"),
    api("/api/categories"),
    api("/api/inventory")
  ]);

  state.settings = settings;
  state.categories = categories;
  state.inventory = inventory;

  $("#businessName").textContent = settings.businessName;
  $("#businessMeta").textContent = `Till Number: ${settings.tillNumber}`;
  $("#salesPhones").textContent = `Sales: ${settings.salesPhones.join(" / ")}`;
  $("#deliveryHours").textContent = `Delivery: ${settings.deliveryHours}`;

  state.selectedCategory = "All";
  const tabs = $("#categoryTabs");
  const catList = ["All", ...categories];
  tabs.innerHTML = catList
    .map(c => `<button class="category-tab ${c === "All" ? "active" : ""}" data-cat="${c}">${c}</button>`)
    .join("");

  tabs.querySelectorAll(".category-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      tabs.querySelectorAll(".category-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.selectedCategory = btn.getAttribute("data-cat");
      applyCatalogFilters();
    });
  });

  const productOptions = inventory.map((p) => `<option value="${p.id}">#${p.productNumber} ${p.name}</option>`).join("");
  $("#restockProduct").innerHTML = productOptions;
  $("#priceProduct").innerHTML = productOptions;

  renderInventory();

  if (sessionStorage.getItem("adminPin")) {
    await loadAdminData();
  }
}

async function loadAdminData() {
  try {
    const [stockMovements, orders] = await Promise.all([
      api("/api/stock/movements"),
      api("/api/orders")
    ]);
    state.stockMovements = stockMovements;
    state.orders = orders;

    renderStockMovements();
    renderOrders();
    renderDailySales();
    renderTopSellers();
  } catch (err) {
    if (err.message.includes("Unauthorized") || err.message.includes("Admin PIN") || err.message.includes("Invalid PIN")) {
      sessionStorage.removeItem("adminPin");
      checkAdminPanelState();
    }
  }
}

async function onCheckout(ev) {
  ev.preventDefault();
  const form = new FormData(ev.target);

  const payload = {
    customer: {
      name: form.get("name"),
      phone: form.get("phone"),
      idNumber: form.get("idNumber")
    },
    confirmAge: Boolean(form.get("confirmAge")),
    items: state.cart
  };

  try {
    const order = await api("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const paymentMethod = form.get("paymentMethod");
    let statusText = `Order ${order.id} created. Total: ${currency(order.total)}.`;

    if (paymentMethod === "mpesa") {
      statusText += " Initializing M-Pesa payment prompt...";
      $("#checkoutStatus").textContent = statusText;

      try {
        const mpesaResult = await api("/api/payments/stkpush", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: payload.customer.phone,
            amount: order.total,
            orderId: order.id
          })
        });

        if (mpesaResult.ResponseCode === "0") {
          statusText = `Order ${order.id} created. Please check your phone for the M-Pesa PIN prompt to pay ${currency(order.total)}.`;
          pollPaymentStatus(order.id);
        } else {
          statusText = `Order ${order.id} created, but M-Pesa prompt failed: ${mpesaResult.ResponseDescription || "Unknown error"}. Please pay via cash on delivery.`;
        }
      } catch (err) {
        statusText = `Order ${order.id} created, but M-Pesa prompt failed: ${err.message}. Please pay via cash on delivery.`;
      }
    } else {
      statusText += ` Please pay ${currency(order.total)} via cash on delivery.`;
    }

    $("#checkoutStatus").textContent = statusText;
    state.cart = [];
    renderCart();
    await refreshData();

    // Generate and open professional HTML receipt
    const htmlReceipt = generateCustomerHtmlReceipt(order);
    openHtmlReceiptInTab(htmlReceipt);

  } catch (err) {
    $("#checkoutStatus").textContent = err.message;
  }
}

async function onRestock(ev) {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    await api("/api/inventory/restock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: form.get("productId"),
        bottles: Number(form.get("bottles")),
        crates: Number(form.get("crates"))
      })
    });
    await refreshData();
  } catch (err) {
    alert(err.message);
  }
}

async function onPricing(ev) {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    await api("/api/pricing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: form.get("productId"),
        priceBottle: Number(form.get("priceBottle")),
        priceCrate: Number(form.get("priceCrate"))
      })
    });
    await refreshData();
  } catch (err) {
    alert(err.message);
  }
}

async function onMarketing(ev) {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    const result = await api("/api/marketing/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: form.get("channel"),
        message: form.get("message"),
        salesPhones: state.settings.salesPhones
      })
    });
    $("#marketingStatus").textContent = `Queued ${result.queued} ${result.channel} prompts via ${result.provider}`;
  } catch (err) {
    $("#marketingStatus").textContent = err.message;
  }
}

async function refreshData() {
  const [inventory] = await Promise.all([
    api("/api/inventory")
  ]);

  state.inventory = inventory;

  renderInventory();
  await loadCatalog(true);

  if (sessionStorage.getItem("adminPin")) {
    await loadAdminData();
  }
}

async function onScanAdd() {
  const code = Number($("#scanCode").value);
  const unit = $("#scanUnit").value;
  const qty = Number($("#scanQty").value || 1);

  if (!code || qty <= 0) return;

  try {
    const product = await api(`/api/catalog/scan?code=${code}`);
    addToCart(product.id, unit, qty);
    $("#scanCode").value = "";
  } catch (err) {
    alert(err.message);
  }
}

async function onPosPush(ev) {
  ev.preventDefault();
  const form = new FormData(ev.target);
  const statusEl = $("#posPushStatus");
  statusEl.style.display = "block";
  statusEl.textContent = "Initiating push...";

  try {
    const res = await api("/api/mpesa/admin-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: form.get("phone"),
        amount: Number(form.get("amount"))
      })
    });
    statusEl.textContent = res.message || "Success";
    ev.target.reset();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
  }
}

function generateCustomerHtmlReceipt(order) {
  const businessName = state.settings?.businessName || "Chewaz Bar & Restaurant";
  const tillNumber = state.settings?.tillNumber || "3706694";
  const salesPhones = state.settings?.salesPhones?.join(" / ") || "N/A";
  const status = order.paymentStatus || "pending";
  const statusLabel = status.toUpperCase();

  const itemsHtml = order.items.map(item => `
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">
        <strong>${item.name}</strong><br>
        <small>Unit: ${item.unit} | Qty: ${item.qty}</small>
      </td>
      <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">
        ${currency(item.unitPrice)}
      </td>
      <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">
        ${currency(item.lineTotal)}
      </td>
    </tr>
  `).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Receipt - ${order.id}</title>
      <style>
        body { font-family: 'Lexend', sans-serif; color: #333; margin: 0; padding: 20px; background: #f9f9f9; }
        .receipt-card { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
        .header { text-align: center; border-bottom: 2px solid #d4af37; padding-bottom: 20px; margin-bottom: 30px; }
        .header h1 { color: #d4af37; margin: 0; font-size: 24px; text-transform: uppercase; }
        .header p { margin: 5px 0; color: #666; font-size: 14px; }
        .status-badge { display: inline-block; padding: 5px 15px; border-radius: 20px; font-size: 12px; font-weight: bold; text-transform: uppercase; margin-top: 10px; }
        .status-paid { background: #e6fffa; color: #2c7a7b; border: 1px solid #b2f5ea; }
        .status-pending { background: #fffaf0; color: #9c4221; border: 1px solid #feebc8; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
        .info-box h3 { font-size: 12px; color: #999; text-transform: uppercase; margin-bottom: 5px; }
        .info-box p { margin: 0; font-size: 15px; font-weight: 500; }
        .items-table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
        .items-table th { text-align: left; font-size: 12px; color: #999; text-transform: uppercase; padding: 10px; border-bottom: 2px solid #eee; }
        .total-section { border-top: 2px solid #d4af37; padding-top: 20px; text-align: right; }
        .total-row { font-size: 18px; font-weight: bold; color: #d4af37; }
        .footer { text-align: center; margin-top: 40px; font-size: 12px; color: #999; }
        @media print {
          body { background: white; padding: 0; }
          .receipt-card { box-shadow: none; border: 1px solid #eee; max-width: 100%; }
          .no-print { display: none; }
        }
      </style>
    </head>
    <body>
      <div class="receipt-card">
        <div class="header">
          <h1>${businessName}</h1>
          <p>Till Number: ${tillNumber} | Order: ${salesPhones}</p>
          <div class="status-badge status-${status}">${statusLabel}</div>
        </div>
        
        <div class="info-grid">
          <div class="info-box">
            <h3>Customer</h3>
            <p>${order.customer.name}</p>
            <p>${order.customer.phone}</p>
          </div>
          <div class="info-box" style="text-align: right;">
            <h3>Order Details</h3>
            <p><strong>ID:</strong> ${order.id}</p>
            <p><strong>Date:</strong> ${new Date(order.createdAt).toLocaleString()}</p>
          </div>
        </div>

        <table class="items-table">
          <thead>
            <tr>
              <th>Item</th>
              <th style="text-align: right;">Price</th>
              <th style="text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <div class="total-section">
          <div class="total-row">Total: ${currency(order.total)}</div>
          <p style="margin-top: 10px; font-size: 14px; color: #666;">Payment: ${order.paymentStatus === 'paid' ? 'Paid via M-Pesa' : 'Pay on Delivery'}</p>
        </div>

        <div class="footer">
          <p>Thank you for choosing ${businessName}!</p>
          <p>Please present this receipt for verification.</p>
        </div>
        
        <div class="no-print" style="margin-top: 30px; text-align: center;">
          <button onclick="window.print()" style="background: #d4af37; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;">Print / Save as PDF</button>
        </div>
      </div>
    </body>
    </html>
  `;
}

function openHtmlReceiptInTab(html) {
  try {
    const win = window.open('', '_blank');
    if (!win) throw new Error("Popup blocked");
    win.document.write(html);
    win.document.close();
  } catch (err) {
    console.error("Window open failed:", err);
    // Fallback: create a temporary modal if popup is blocked
    const modal = document.createElement("div");
    modal.style.position = "fixed";
    modal.style.top = "0";
    modal.style.left = "0";
    modal.style.width = "100%";
    modal.style.height = "100%";
    modal.style.background = "rgba(0,0,0,0.8)";
    modal.style.zIndex = "9999";
    modal.style.overflow = "auto";
    modal.innerHTML = `
      <div style="padding: 20px; max-width: 800px; margin: 20px auto;">
        <button onclick="this.parentElement.parentElement.remove()" style="margin-bottom: 20px; background: #d4af37; color: white; border: none; padding: 10px 20px; cursor: pointer;">Close & Return</button>
        <div style="background: white; border-radius: 8px;">${html}</div>
      </div>
    `;
    document.body.appendChild(modal);
  }
}

function generateCustomerReceipt(order) {
  const businessName = state.settings?.businessName || "Raven Store";
  const businessMeta = `Till Number: ${state.settings?.tillNumber || "N/A"}`;
  const salesPhones = state.settings?.salesPhones?.join(" / ") || "N/A";

  let receiptContent = `${businessName}\n`;
  receiptContent += `${businessMeta}\n`;
  receiptContent += `Sales: ${salesPhones}\n`;
  receiptContent += `Delivery: ${state.settings?.deliveryHours || "N/A"}\n\n`;

  receiptContent += `RECEIPT\n`;
  receiptContent += `Order ID: ${order.id}\n`;
  receiptContent += `Date: ${new Date(order.createdAt).toLocaleString()}\n`;
  receiptContent += `Customer: ${order.customer.name}\n`;
  receiptContent += `Phone: ${order.customer.phone}\n`;
  if (order.customer.idNumber) {
    receiptContent += `ID Number: ${order.customer.idNumber}\n`;
  }
  receiptContent += `\n`;

  receiptContent += `ITEMS:\n`;
  receiptContent += `-`.repeat(50) + `\n`;

  order.items.forEach(item => {
    receiptContent += `${item.productNumber} ${item.name}\n`;
    receiptContent += `  ${item.qty} x ${item.unit} @ ${currency(item.unitPrice)}\n`;
    if (item.discountPercent > 0) {
      receiptContent += `  Discount: ${item.discountPercent}%\n`;
    }
    receiptContent += `  Subtotal: ${currency(item.lineTotal)}\n\n`;
  });

  receiptContent += `-`.repeat(50) + `\n`;
  receiptContent += `TOTAL: ${currency(order.total)}\n`;
  receiptContent += `Payment Status: ${order.paymentStatus || "Pending"}\n\n`;

  receiptContent += `Thank you for your business!\n`;
  receiptContent += `Please verify ID on delivery.\n`;

  return receiptContent;
}

function downloadTextFile(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function onAdminLogin(ev) {
  ev.preventDefault();
  const form = new FormData(ev.target);
  const pin = form.get("pin");
  const errBox = $("#loginError");
  if (errBox) errBox.style.display = "none";

  try {
    await api("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    });
    sessionStorage.setItem("adminPin", pin);
    checkAdminPanelState();
    await loadAdminData();
    ev.target.reset();
  } catch (err) {
    if (errBox) {
      errBox.textContent = "Login failed: " + err.message;
      errBox.style.display = "block";
    } else {
      alert("Login failed: " + err.message);
    }
  }
}

function generateSellerReceipt(orders, timeframeFilter) {
  const businessName = state.settings?.businessName || "Raven Store";
  const businessMeta = `Till Number: ${state.settings?.tillNumber || "N/A"}`;

  let receiptContent = `${businessName} - SALES REPORT\n`;
  receiptContent += `${businessMeta}\n`;
  receiptContent += `Report Period: ${timeframeFilter === "all" ? "All Time" : timeframeFilter}\n`;
  receiptContent += `Generated: ${new Date().toLocaleString()}\n\n`;

  receiptContent += `SUMMARY:\n`;
  receiptContent += `-`.repeat(60) + `\n`;

  const totalOrders = orders.length;
  const paidOrders = orders.filter(o => o.paymentStatus === "paid");
  const totalRevenue = orders.reduce((sum, o) => sum + o.total, 0);
  const paidRevenue = paidOrders.reduce((sum, o) => sum + o.total, 0);

  receiptContent += `Total Orders: ${totalOrders}\n`;
  receiptContent += `Paid Orders: ${paidOrders.length}\n`;
  receiptContent += `Expected Revenue: ${currency(totalRevenue)}\n`;
  receiptContent += `Confirmed Revenue: ${currency(paidRevenue)}\n\n`;

  receiptContent += `DETAILED SALES:\n`;
  receiptContent += `-`.repeat(60) + `\n`;

  orders.forEach(order => {
    receiptContent += `Order ID: ${order.id}\n`;
    receiptContent += `Date: ${new Date(order.createdAt).toLocaleString()}\n`;
    receiptContent += `Customer: ${order.customer.name} (${order.customer.phone})\n`;
    receiptContent += `Status: ${order.paymentStatus || "pending"}\n`;
    receiptContent += `Items:\n`;

    order.items.forEach(item => {
      receiptContent += `  - ${item.productNumber} ${item.name}: ${item.qty} ${item.unit} @ ${currency(item.unitPrice)} = ${currency(item.lineTotal)}\n`;
    });

    receiptContent += `Total: ${currency(order.total)}\n\n`;
  });

  receiptContent += `-`.repeat(60) + `\n`;
  receiptContent += `END OF REPORT\n`;

  return receiptContent;
}

function onDownloadReceipts() {
  const statusFilter = $("#orderStatusFilter").value;
  const timeframeFilter = $("#orderTimeframeFilter").value;

  const filtered = state.orders.filter(o => {
    const matchesStatus = statusFilter === "all" || o.paymentStatus === statusFilter || (statusFilter === "pending_delivery" && !o.paymentStatus);
    const matchesTimeframe = isWithinTimeframe(o.createdAt, timeframeFilter);
    return matchesStatus && matchesTimeframe;
  });

  if (!filtered.length) {
    alert("No orders found for the selected filters.");
    return;
  }

  // Generate detailed seller receipt
  const receiptContent = generateSellerReceipt(filtered, timeframeFilter);
  const dateStr = timeframeFilter === "all" ? new Date().toISOString().split("T")[0] : `${timeframeFilter}_${new Date().toISOString().split("T")[0]}`;
  downloadTextFile(receiptContent, `sales_report_${dateStr}.txt`);
}

function checkAdminPanelState() {
  const isLoggedIn = !!sessionStorage.getItem("adminPin");
  if (isLoggedIn) {
    if ($("#adminLoginPanel")) $("#adminLoginPanel").style.display = "none";
    if ($("#adminDashboardPanel")) $("#adminDashboardPanel").style.display = "block";
  } else {
    if ($("#adminLoginPanel")) $("#adminLoginPanel").style.display = "block";
    if ($("#adminDashboardPanel")) $("#adminDashboardPanel").style.display = "none";
  }
}

function initAgeGate() {
  const accepted = localStorage.getItem("raven_age_ok") === "1";
  const gate = $("#ageGate");

  if (accepted) gate.classList.add("hidden");

  $("#ageConfirmBtn").addEventListener("click", () => {
    localStorage.setItem("raven_age_ok", "1");
    gate.classList.add("hidden");
  });
}

async function main() {
  initAgeGate();

  if ($("#adminLoginForm")) $("#adminLoginForm").addEventListener("submit", onAdminLogin);
  if ($("#adminLogoutBtn")) {
    $("#adminLogoutBtn").addEventListener("click", () => {
      sessionStorage.removeItem("adminPin");
      checkAdminPanelState();
    });
  }
  checkAdminPanelState();

  await loadBasics();
  await loadCatalog(true);
  renderCart();

  $("#reloadCatalog").addEventListener("click", () => loadCatalog(true));
  $("#catalogSearch").addEventListener("input", applyCatalogFilters);
  $("#sortFilter").addEventListener("change", applyCatalogFilters);
  $("#checkoutForm").addEventListener("submit", onCheckout);
  $("#restockForm").addEventListener("submit", onRestock);
  $("#pricingForm").addEventListener("submit", onPricing);
  $("#marketingForm").addEventListener("submit", onMarketing);
  $("#scanAddBtn").addEventListener("click", onScanAdd);

  $("#orderStatusFilter").addEventListener("change", renderOrders);
  $("#orderTimeframeFilter").addEventListener("change", renderOrders);
  $("#refreshOrders").addEventListener("click", refreshData);

  if ($("#posPushForm")) $("#posPushForm").addEventListener("submit", onPosPush);
  if ($("#downloadReceiptsBtn")) $("#downloadReceiptsBtn").addEventListener("click", onDownloadReceipts);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  alert(err.message);
});

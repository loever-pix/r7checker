// SellAuth REST client. Shop is the single source of truth for products,
// stock (serial deliverables), and orders (invoices).
//
// Endpoints confirmed against the live API (shop 243099):
//   GET  /v1/shops/{shop}/products                              → list
//   GET  /v1/shops/{shop}/products/{id}                         → one product (+ variants, images, stock_count)
//   GET  /v1/shops/{shop}/products/{id}/deliverables/{vid}      → ["serial", ...]
//   PUT  /v1/shops/{shop}/products/{id}/deliverables/append/{vid}    body {deliverables:[...]}
//   PUT  /v1/shops/{shop}/products/{id}/deliverables/overwrite/{vid} body {deliverables:[...]}
//   GET  /v1/shops/{shop}/invoices/{id}                         → one order (items[], email, status)

const { cfg } = require('./config');

class SellAuthError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SellAuthError';
    this.status = status;
    this.body = body;
  }
}

function base() {
  return `${cfg.sellauth.base}/v1/shops/${cfg.sellauth.shopId}`;
}

// Max 429 retries. SellAuth caps requests-per-shop; bulk maintenance (e.g.
// /checkall doing hundreds of moves) WILL hit it, so we back off and retry
// instead of failing the operation. Tune with SELLAUTH_RATE_RETRIES.
const RATE_RETRIES = Math.max(0, Number(process.env.SELLAUTH_RATE_RETRIES) || 6);

async function call(method, path, body, _attempt = 0) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.sellauth.key}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed;
  const text = await res.text();
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    // Rate limited → respect Retry-After (or the "try again after N minute(s)"
    // message), else exponential backoff, then retry.
    if (res.status === 429 && _attempt < RATE_RETRIES) {
      const hdr = Number(res.headers.get('retry-after'));
      const minMatch = /after\s+(\d+)\s+minute/i.exec(parsed && (parsed.message || parsed.error) || '');
      const waitMs = hdr > 0 ? hdr * 1000
        : (minMatch ? Number(minMatch[1]) * 60_000 : Math.min(60_000, 1000 * 2 ** _attempt));
      await new Promise(r => setTimeout(r, Math.max(1000, waitMs)));
      return call(method, path, body, _attempt + 1);
    }
    const msg = (parsed && (parsed.message || parsed.error)) || `HTTP ${res.status}`;
    throw new SellAuthError(`SellAuth ${method} ${path}: ${msg}`, res.status, parsed);
  }
  return parsed;
}

// Normalise the wildly nested product into the shape the bot cares about.
// We deliberately use the FIRST variant — these products are single-variant
// account listings. If a product ever grows multiple variants, restock/replace
// target variant[0]; surface that in the UI rather than silently guessing.
function shapeProduct(p) {
  if (!p) return null;
  const v = (p.variants || [])[0] || {};
  const img = (p.images || [])[0];
  return {
    id: p.id,
    name: p.name,
    variantId: v.id,
    variantName: v.name,
    variantCount: (p.variants || []).length,
    stock: p.stock_count != null ? p.stock_count : (v.stock != null ? v.stock : 0),
    deliverablesType: p.deliverables_type,
    image: img ? (img.url || img.image_url || null) : null,
    // Price lives on the variant; the product-level price is usually null.
    price: (v.price != null ? v.price : p.price),
    currency: p.currency,
  };
}

// Fetch EVERY product across all pages. SellAuth paginates /products (≈20/page),
// so a single GET misses later pages — which would make the VWI push fail to
// match existing products and create duplicates. We page through to last_page.
async function listProducts() {
  const all = [];
  let page = 1, lastPage = 1;
  do {
    const d = await call('GET', `/products?perPage=100&page=${page}`);
    const arr = Array.isArray(d) ? d : (d.data || d.products || []);
    for (const p of arr) all.push(p);
    if (Array.isArray(d) || !d) break;        // non-paginated response → done
    lastPage = Number(d.last_page) || 1;
    page++;
  } while (page <= lastPage && page <= 1000);  // hard stop guards a bad API reply
  return all.map(shapeProduct).filter(Boolean);
}

async function getProduct(id) {
  const d = await call('GET', `/products/${id}`);
  return shapeProduct(d.product || d);
}

// Full, un-shaped product object (every field + raw variants/images) — needed
// by the variant-split flow which must echo the whole product on update.
async function getProductRaw(id) {
  const d = await call('GET', `/products/${id}`);
  return d.product || d;
}

// Full-replace product update (PUT /products/{id}/update). Caller builds the
// payload with buildProductUpdate so nothing (images/config) is wiped.
async function updateProduct(id, payload) {
  return call('PUT', `/products/${id}/update`, payload);
}

// Returns the array of serial strings currently in stock for a variant.
async function getDeliverables(productId, variantId) {
  const d = await call('GET', `/products/${productId}/deliverables/${variantId}`);
  return Array.isArray(d) ? d : [];
}

// Append new serial lines. Returns the updated full array (so callers can read
// the new stock count without a second request).
async function appendStock(productId, variantId, lines) {
  const d = await call('PUT', `/products/${productId}/deliverables/append/${variantId}`, {
    deliverables: lines,
  });
  return Array.isArray(d) ? d : [];
}

async function overwriteStock(productId, variantId, lines) {
  const d = await call('PUT', `/products/${productId}/deliverables/overwrite/${variantId}`, {
    deliverables: lines,
  });
  return Array.isArray(d) ? d : [];
}

// Atomically (read-modify-write) remove and return ONE serial from a variant's
// stock. Returns { serial, remaining } or { serial: null } if stock is empty.
// SellAuth has no single-pop endpoint, so we read all, drop one, overwrite the
// rest. Callers must validate eligibility BEFORE calling this — once it returns
// a serial, that unit is gone from stock.
async function popOneSerial(productId, variantId) {
  const lines = await getDeliverables(productId, variantId);
  if (!lines.length) return { serial: null, remaining: 0 };
  const [serial, ...rest] = lines;
  await overwriteStock(productId, variantId, rest);
  return { serial, remaining: rest.length };
}

async function getInvoice(orderId) {
  const d = await call('GET', `/invoices/${encodeURIComponent(orderId)}`);
  return d.invoice || d;
}

// Recent invoices, most-recent first. SellAuth paginates: { data:[...] }.
// Used by the public sales feed to detect new/transitioning orders.
async function listInvoices(perPage = 25) {
  const d = await call('GET', `/invoices?perPage=${Math.max(1, Math.min(100, perPage))}`);
  return Array.isArray(d) ? d : (d.data || d.invoices || []);
}

// Drop null/undefined keys so we never *send* a null that the update endpoint
// would treat as "clear this field". Omitted-and-currently-null is a no-op;
// omitted-but-currently-set is data loss — which is exactly the bug we're
// avoiding, so we send every set field back.
function stripNullish(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// Echo a variant back into the shape the product-update endpoint expects,
// preserving EVERY field so a price change doesn't wipe variant config.
// Computed/relational fields (stock, product_id, order, timestamps) are left
// out — stock is derived from deliverables, which are stored separately and
// stay linked via the preserved variant id.
function variantPayload(v, priceOverride) {
  return stripNullish({
    id: v.id,
    name: v.name,
    description: v.description,
    price: String(priceOverride != null ? priceOverride : v.price),
    price_slash: v.price_slash,
    quantity_min: v.quantity_min,
    quantity_max: v.quantity_max,
    serial_selection_method: v.serial_selection_method,
    dynamic_url: v.dynamic_url,
    redirect_url: v.redirect_url,
    instructions: v.instructions,
    volume_discounts: v.volume_discounts || [],
    disable_volume_discounts_if_coupon: !!v.disable_volume_discounts_if_coupon,
    discord_roles: v.discord_roles || [],
    disabled_payment_method_ids: v.disabled_payment_method_ids,
  });
}

// Build the COMPLETE update payload for a product, changing only the first
// variant's price. PUT /products/{id}/update is a full replace: any field NOT
// in the body resets to default. So we echo back every product field —
// crucially image_ids (from p.images) so images aren't wiped — plus all
// variants. Returns the payload (caller PUTs it).
function buildProductUpdate(p, variants, newPrice) {
  return stripNullish({
    type: p.type,
    name: p.name,
    currency: p.currency,
    visibility: p.visibility,
    path: p.path,
    category_id: p.category_id,
    group_id: p.group_id,
    description: p.description,
    meta_title: p.meta_title,
    meta_description: p.meta_description,
    meta_image_id: p.meta_image_id,
    meta_twitter_card: p.meta_twitter_card,
    instructions: p.instructions,
    out_of_stock_message: p.out_of_stock_message,
    tax_inclusive: p.tax_inclusive,
    deliverables_type: p.deliverables_type,
    serial_selection_method: p.serial_selection_method,
    affiliate_percentage: p.affiliate_percentage,
    // The field that was being wiped — preserve linked images by id.
    image_ids: (p.images || []).map(i => i.id),
    status_color: p.status_color,
    status_text: p.status_text,
    show_views_count: p.show_views_count,
    show_sales_count: p.show_sales_count,
    show_sales_notifications: p.show_sales_notifications,
    sales_count_hours: p.sales_count_hours,
    hide_stock_count: p.hide_stock_count,
    discord_required: p.discord_required,
    deliverables_label: p.deliverables_label,
    is_mandatory: p.is_mandatory,
    sort_priority: p.sort_priority,
    quantity_min: p.quantity_min,
    quantity_max: p.quantity_max,
    product_tabs: p.product_tabs || [],
    product_badges: p.product_badges || [],
    custom_field_ids: (p.custom_fields || []).map(c => c.id),
    feedback_coupon_id: p.feedback_coupon_id,
    feedback_coupon_min_rating: p.feedback_coupon_min_rating,
    product_addons: p.product_addons || [],
    product_upsells: p.product_upsells || [],
    variants: variants.map((v, i) => variantPayload(v, i === 0 ? newPrice : null)),
  });
}

// Set the price of a product's (first) variant via the full-replace update
// endpoint, preserving every other product/variant field (including images).
// Returns { oldPrice, newPrice, name, image, currency, variantCount, stock }.
async function updatePrice(productId, newPrice) {
  const d = await call('GET', `/products/${productId}`);
  const p = d.product || d;
  const variants = p.variants || [];
  if (!variants.length) throw new SellAuthError('Product has no variants to price', 400, null);

  const oldPrice = parseFloat(variants[0].price);
  const payload = buildProductUpdate(p, variants, newPrice);
  await call('PUT', `/products/${productId}/update`, payload);

  const img = (p.images || [])[0];
  return {
    oldPrice,
    newPrice: parseFloat(Number(newPrice).toFixed(2)),
    name: p.name,
    image: img ? (img.url || img.image_url || null) : null,
    currency: p.currency || 'USD',
    variantCount: variants.length,
    stock: p.stock_count != null ? p.stock_count : (variants[0].stock || 0),
  };
}

// Re-link images to a product by id WITHOUT changing anything else (used to
// recover images that were unlinked). Same full-replace echo, but with the
// given image id list.
async function setProductImages(productId, imageIds) {
  const d = await call('GET', `/products/${productId}`);
  const p = d.product || d;
  const variants = p.variants || [];
  const payload = buildProductUpdate(p, variants, null);
  payload.image_ids = imageIds;
  await call('PUT', `/products/${productId}/update`, payload);
  return imageIds.length;
}

// Create a NEW product by CLONING an existing one's config (the create payload
// is the same shape as the update payload buildProductUpdate already produces).
// The clone gets ONE fresh, empty, id-less variant priced at `price`. We DROP the
// template's slug (`path`) and meta image so SellAuth derives a clean slug and we
// don't reference the template's art. No images are linked by default — the owner
// adds product art afterwards (a rank template's art would be wrong on a Glacier
// product). Returns the shaped new product (incl. id + variantId).
//   opts: { name (req), price (req), visibility?, variantName?, variantDescription?, imageIds? }
async function createProductFromTemplate(templateId, opts = {}) {
  if (!opts.name) throw new SellAuthError('createProductFromTemplate: name required', 400, null);
  const tpl = await getProductRaw(templateId);
  if (!tpl) throw new SellAuthError('template product not found', 404, null);
  const base = (tpl.variants || [])[0] || {};
  const price = String(opts.price != null ? opts.price : (base.price != null ? base.price : '1'));
  const variant = { ...base, name: opts.variantName || opts.name, price, description: opts.variantDescription != null ? opts.variantDescription : null };
  delete variant.id;                                   // id-less → SellAuth creates it
  const payload = buildProductUpdate(tpl, [variant], price);
  payload.name = opts.name;
  payload.visibility = opts.visibility || 'public';
  payload.image_ids = Array.isArray(opts.imageIds) ? opts.imageIds : [];
  delete payload.path;                                 // fresh slug from the new name (avoid collision)
  delete payload.meta_image_id;                        // don't reference the template's image
  payload.product_addons = payload.product_addons || [];
  payload.product_upsells = payload.product_upsells || [];
  const d = await call('POST', '/products', payload);
  return shapeProduct(d.product || d);
}

// Permanently delete a product. Used by the create-endpoint verification (a
// throwaway clone is created then removed) and never by the live VWI push.
async function deleteProduct(productId) {
  return call('DELETE', `/products/${productId}`);
}

// Look up a SellAuth customer by email. Returns the customer object (with .id)
// or null if no match. Tries the indexed query param first, then falls back to
// scanning the list (handles API variants).
async function findCustomerByEmail(email) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;
  try {
    const d = await call('GET', `/customers?email=${encodeURIComponent(wanted)}`);
    const arr = Array.isArray(d) ? d : (d.data || d.customers || (d.customer ? [d.customer] : []));
    const hit = arr.find(c => String(c.email || '').toLowerCase() === wanted);
    if (hit) return hit;
  } catch (e) {
    if (!(e instanceof SellAuthError) || e.status !== 404) throw e;
  }
  // Fallback: list-and-find. Bounded — SellAuth returns paged results; if the
  // shop ever grows huge we'd want a real search endpoint, but for now this is
  // the safety net when the ?email= query isn't indexed.
  const d = await call('GET', '/customers').catch(() => null);
  const arr = Array.isArray(d) ? d : (d?.data || d?.customers || []);
  return arr.find(c => String(c.email || '').toLowerCase() === wanted) || null;
}

// Add store credit to a SellAuth customer's balance. Empirically verified on
// the live API: method is PUT (not POST — POST returns 404 "" silently).
//   PUT /v1/shops/{shop}/customers/{id}/balance  body: { amount, description }
// Negative amount → outgoing/refund. Returns the balance transaction object.
async function addCustomerCredit(customerId, amount, description) {
  if (!customerId) throw new Error('customerId required');
  const n = Number(amount);
  if (!Number.isFinite(n) || n === 0) throw new Error('amount must be non-zero');
  const body = { amount: n };
  if (description) body.description = String(description).slice(0, 200);
  return call('PUT', `/customers/${encodeURIComponent(customerId)}/balance`, body);
}

module.exports = {
  SellAuthError,
  listProducts, getProduct, getProductRaw, getDeliverables,
  appendStock, overwriteStock, popOneSerial,
  getInvoice, listInvoices, updatePrice, updateProduct, setProductImages,
  buildProductUpdate, variantPayload,
  createProductFromTemplate, deleteProduct,
  findCustomerByEmail, addCustomerCredit,
};

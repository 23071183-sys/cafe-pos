const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
// libsql: drop-in, synchronous, better-sqlite3-compatible API + Turso cloud sync
const Database = require('libsql');

// Load .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
}

// Public base URL for QR codes & notification links.
// Set PUBLIC_URL env var to your deployed URL (e.g. https://your-app.onrender.com).
// Falls back to empty string → relative links work in-browser.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

// ── WhatsApp notifications via UltraMsg ────────────────────────────────────
// Setup: ultramsg.com → sign up → create instance → scan QR → copy creds
const UM_INSTANCE = process.env.ULTRAMSG_INSTANCE; // e.g. instance12345
const UM_TOKEN    = process.env.ULTRAMSG_TOKEN;     // your token

async function sendWhatsApp(phone, message) {
  if (!phone || !UM_INSTANCE || !UM_TOKEN) return; // skip if not configured
  try {
    const r = await fetch(
      `https://api.ultramsg.com/${UM_INSTANCE}/messages/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: UM_TOKEN,
          to:    `+91${phone}`,
          body:  message,
        }).toString(),
      }
    );
    const d = await r.json();
    if (d.sent === 'true' || d.sent === true) console.log(`[WA] ✓ sent to ${phone}`);
    else console.error(`[WA] ✗`, d);
  } catch (e) {
    console.error('[WA] fetch error:', e.message);
  }
}

function waOrderReceived(order) {
  if (!order.customer_phone) return;
  const name  = order.customer_name ? `, ${order.customer_name}` : '';
  const items = (order.items || []).map(i => `  • ${i.quantity}× ${i.item_name}`).join('\n');
  sendWhatsApp(order.customer_phone,
`🍽️ *My Restaurant* — Order Received!

Hi${name}! Your order *#${String(order.id).padStart(4,'0')}* is confirmed.
📍 Table ${order.table_number}
${items}
💰 Total: ₹${order.total}

Track your order live:
${PUBLIC_URL}/status?order=${order.id}`
  );
}

function waPreparingStarted(order) {
  if (!order.customer_phone) return;
  const name = order.customer_name ? `, ${order.customer_name}` : '';
  sendWhatsApp(order.customer_phone,
`👨‍🍳 *My Restaurant* — Kitchen Update

Hi${name}! Your order *#${String(order.id).padStart(4,'0')}* is now being prepared.
We'll notify you the moment it's ready! 🙌`
  );
}

function waOrderReady(order) {
  if (!order.customer_phone) return;
  const name = order.customer_name ? `, ${order.customer_name}` : '';
  sendWhatsApp(order.customer_phone,
`✅ *My Restaurant* — Order Ready!

Hi${name}! Your order *#${String(order.id).padStart(4,'0')}* is ready for pickup.
Please collect from the counter. Enjoy your meal! 🍴`
  );
}
// ───────────────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {

    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  }
});

// ── DATABASE SETUP ──────────────────────────────────────────────────────────
// If Turso creds are present, use an embedded replica (local file synced to the
// cloud) so data survives restarts. Otherwise fall back to a plain local file.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'orders.db');
const TURSO_URL   = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

let db, _syncEnabled = false;
if (TURSO_URL && TURSO_TOKEN) {
  db = new Database(dbPath, { syncUrl: TURSO_URL, authToken: TURSO_TOKEN });
  try { db.sync(); _syncEnabled = true; console.log('[db] Turso embedded replica — synced'); }
  catch (e) { console.error('[db] initial sync failed:', e.message); }
} else {
  db = new Database(dbPath);
  console.log('[db] local SQLite only (no Turso creds) — data is NOT durable');
}

// Push local writes up to Turso. Called after mutations + on an interval.
function dbSync() {
  if (!_syncEnabled) return;
  try { db.sync(); } catch (e) { console.error('[db] sync error:', e.message); }
}
if (_syncEnabled) setInterval(dbSync, 15000); // safety net every 15s

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    sort_order  INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS menu_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    description TEXT    DEFAULT '',
    price       REAL    NOT NULL,
    available   INTEGER DEFAULT 1,
    FOREIGN KEY (category_id) REFERENCES categories(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    table_number  INTEGER NOT NULL,
    customer_name TEXT    DEFAULT '',
    customer_phone TEXT   DEFAULT '',
    status        TEXT    DEFAULT 'pending',
    notes         TEXT    DEFAULT '',
    total         REAL    DEFAULT 0,
    created_at    TEXT    DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    INTEGER NOT NULL,
    item_id     INTEGER NOT NULL,
    item_name   TEXT    NOT NULL,
    item_price  REAL    NOT NULL,
    quantity    INTEGER DEFAULT 1,
    notes       TEXT    DEFAULT '',
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );
`);

// ── SEED DEFAULT MENU ───────────────────────────────────────────────────────
const { count: catCount } = db.prepare('SELECT COUNT(*) as count FROM categories').get();
if (catCount === 0) {
  const addCat  = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
  const addItem = db.prepare('INSERT INTO menu_items (category_id, name, description, price) VALUES (?, ?, ?, ?)');

  const whisky   = addCat.run('Whisky', 1).lastInsertRowid;
  const wine     = addCat.run('Wine', 2).lastInsertRowid;
  const beer     = addCat.run('Beer', 3).lastInsertRowid;
  const vodka    = addCat.run('Vodka', 4).lastInsertRowid;
  const rum      = addCat.run('Rum', 5).lastInsertRowid;
  const gin      = addCat.run('Gin', 6).lastInsertRowid;
  const brandy   = addCat.run('Brandy', 7).lastInsertRowid;
  const tequila  = addCat.run('Tequila', 8).lastInsertRowid;
  const liqueurs = addCat.run('Liqueurs', 9).lastInsertRowid;
  const sparkling= addCat.run('Champagne & Sparkling', 10).lastInsertRowid;
  const mixers   = addCat.run('Mixers & Sodas', 11).lastInsertRowid;
  const snacks   = addCat.run('Snacks', 12).lastInsertRowid;

  // Whisky
  addItem.run(whisky, 'Royal Stag 750ml',          'Blended Indian whisky',                      850);
  addItem.run(whisky, 'Blenders Pride 750ml',      'Premium blended whisky',                    1150);
  addItem.run(whisky, 'Black Dog 750ml',           'Triple gold reserve scotch blend',          2400);
  addItem.run(whisky, 'Jameson 750ml',             'Irish blended whiskey',                     3200);
  addItem.run(whisky, "Jack Daniel's 750ml",       'Tennessee sour-mash whiskey',               3600);
  addItem.run(whisky, 'Glenfiddich 12 Yr 750ml',   'Single malt Scotch, 12 years',              6500);
  addItem.run(whisky, 'Chivas Regal 12 Yr 750ml',  'Blended Scotch, 12 years',                  4200);

  // Wine
  addItem.run(wine, 'Sula Red 750ml',          'Indian Cabernet Shiraz, dry red',     950);
  addItem.run(wine, 'Sula White 750ml',        'Chenin Blanc, crisp white',           950);
  addItem.run(wine, 'Jacobs Creek Shiraz',     'Australian Shiraz Cabernet',         1450);
  addItem.run(wine, 'Fratelli Sangiovese',     'Medium-bodied Indian red',           1250);
  addItem.run(wine, 'Riesling White 750ml',    'Off-dry aromatic white',             1600);

  // Beer
  addItem.run(beer, 'Kingfisher Premium 650ml', 'Lager beer pint',          150);
  addItem.run(beer, 'Bira White 330ml',         'Wheat beer, citrusy',      140);
  addItem.run(beer, 'Budweiser 650ml',          'American lager pint',      180);
  addItem.run(beer, 'Corona Extra 355ml',       'Mexican pale lager',       250);
  addItem.run(beer, 'Heineken 500ml',           'Premium pilsner can',      220);

  // Vodka
  addItem.run(vodka, 'Magic Moments 750ml',  'Triple-distilled Indian vodka',  750);
  addItem.run(vodka, 'Smirnoff 750ml',       'No.21 triple-distilled vodka',   1100);
  addItem.run(vodka, 'Absolut 750ml',        'Swedish premium vodka',          2200);
  addItem.run(vodka, 'Grey Goose 750ml',     'French ultra-premium vodka',     5500);

  // Rum
  addItem.run(rum, 'Old Monk 750ml',        'Classic dark Indian rum',     560);
  addItem.run(rum, 'Bacardi White 750ml',   'Light white rum',             1050);
  addItem.run(rum, 'Captain Morgan 750ml',  'Spiced gold rum',             1150);

  // Gin
  addItem.run(gin, 'Bombay Sapphire 750ml', 'London dry gin',             2600);
  addItem.run(gin, 'Greater Than 750ml',    'Indian craft London dry gin', 1100);
  addItem.run(gin, 'Hendricks 750ml',       'Cucumber & rose infused gin', 3800);

  // Brandy
  addItem.run(brandy, 'Mansion House 750ml', 'Indian brandy',             720);
  addItem.run(brandy, 'Hennessy VS 750ml',   'Cognac, very special',      6800);

  // Tequila
  addItem.run(tequila, 'Camino Real 750ml',  'Blanco tequila',            1900);
  addItem.run(tequila, 'Jose Cuervo 750ml',  'Especial gold tequila',     2800);

  // Liqueurs
  addItem.run(liqueurs, 'Baileys Irish Cream 750ml', 'Cream liqueur',     2400);
  addItem.run(liqueurs, 'Jagermeister 700ml',        'Herbal liqueur',    2600);
  addItem.run(liqueurs, 'Cointreau 700ml',           'Orange liqueur',    3200);

  // Champagne & Sparkling
  addItem.run(sparkling, 'Chandon Brut 750ml',    'Indian sparkling brut',    1700);
  addItem.run(sparkling, 'Moet & Chandon 750ml',  'French champagne',         6500);

  // Mixers & Sodas
  addItem.run(mixers, 'Tonic Water 250ml',  'Premium Indian tonic',   60);
  addItem.run(mixers, 'Soda 750ml',         'Club soda',              40);
  addItem.run(mixers, 'Coke 750ml',         'Cola mixer',             70);
  addItem.run(mixers, 'Red Bull 250ml',     'Energy drink mixer',    125);
  addItem.run(mixers, 'Still Water 1L',     'Packaged drinking water', 40);

  // Snacks
  addItem.run(snacks, 'Salted Peanuts',    'Roasted & salted peanuts',   60);
  addItem.run(snacks, 'Potato Chips',      'Classic salted chips',       40);
  addItem.run(snacks, 'Masala Namkeen',    'Spiced savoury mix',         50);
  addItem.run(snacks, 'Chakna Mix',        'Assorted bar snack mix',     80);
}

// ── MIGRATION: add is_house_special column if missing ───────────────────────
const hsColExists = db.prepare("PRAGMA table_info(menu_items)").all().some(c => c.name === 'is_house_special');
if (!hsColExists) {
  db.prepare("ALTER TABLE menu_items ADD COLUMN is_house_special INTEGER DEFAULT 0").run();
  // Auto-mark known house items by description keyword
  db.prepare("UPDATE menu_items SET is_house_special = 1 WHERE description LIKE '%house%' OR name LIKE 'House%'").run();
  console.log('[Migration] is_house_special column added');
}

// ── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Landing page at root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Menu/ordering page
app.get('/menu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'menu.html')));

// Order status tracking page
app.get('/status', (req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));

// Admin panel
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Counter / POS dashboard
app.get('/counter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'counter.html')));

// QR codes print page — server-side generated with embedded data URIs
app.get('/qr-tables', async (req, res) => {
  const origin = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const BASE = `${origin}/menu?table=`;
  const cards = await Promise.all(
    Array.from({ length: 22 }, (_, i) => i + 1).map(async t => {
      const dataUrl = await QRCode.toDataURL(BASE + t, {
        width: 200, margin: 1,
        color: { dark: '#2c1810', light: '#ffffff' },
      });
      return `
        <div class="card">
          <div class="logo">My Restaurant</div>
          <div class="table-label">Table</div>
          <div class="table-num">${t}</div>
          <img src="${dataUrl}" alt="QR Table ${t}">
          <div class="scan-text">Scan to view menu &amp; order</div>
        </div>`;
    })
  );
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>My Restaurant — Table QR Codes</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Georgia',serif;background:#f5f0eb;padding:32px}
  h1{text-align:center;font-size:22px;color:#2c1810;margin-bottom:6px;letter-spacing:1px}
  p.sub{text-align:center;font-size:13px;color:#8a7060;margin-bottom:32px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;max-width:960px;margin:0 auto}
  .card{background:#fff;border-radius:16px;padding:20px 16px 16px;text-align:center;
    box-shadow:0 2px 12px rgba(0,0,0,.08);border:1px solid #e8ddd5;
    display:flex;flex-direction:column;align-items:center;gap:8px;break-inside:avoid}
  .logo{font-size:13px;font-weight:700;color:#c0855a;letter-spacing:1.5px;text-transform:uppercase}
  .table-label{font-size:11px;font-weight:700;color:#8a7060;letter-spacing:2px;text-transform:uppercase}
  .table-num{font-size:36px;font-weight:700;color:#2c1810;line-height:1}
  .card img{width:160px;height:160px;border-radius:8px}
  .scan-text{font-size:11px;color:#b0a090;letter-spacing:.5px}
  @media print{
    body{background:#fff;padding:16px}
    .no-print{display:none!important}
    .grid{gap:16px}
    .card{box-shadow:none;border:1.5px solid #ddd}
  }
</style></head><body>
<h1>My Restaurant</h1>
<p class="sub">Scan to order from your table</p>
<div class="no-print" style="text-align:center;margin-bottom:24px">
  <button onclick="window.print()" style="background:#c0855a;color:#fff;border:none;padding:10px 28px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer">
    🖨️ Print All QR Codes
  </button>
</div>
<div class="grid">${cards.join('')}</div>
</body></html>`);
});

// ── MENU API ─────────────────────────────────────────────────────────────────
app.get('/api/menu', (req, res) => {
  const cats  = db.prepare('SELECT * FROM categories ORDER BY sort_order').all();
  const items = db.prepare('SELECT * FROM menu_items ORDER BY category_id, name').all();
  res.json(cats.map(c => ({
    ...c,
    items: items.filter(i => i.category_id === c.id).map(i => ({ ...i, is_available: i.available === 1 }))
  })));
});

// ── SAFE MIGRATIONS ─────────────────────────────────────────────────────────
;(function () {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  if (!cols.includes('discount'))     db.prepare("ALTER TABLE orders ADD COLUMN discount     REAL DEFAULT 0").run();
  if (!cols.includes('tip'))          db.prepare("ALTER TABLE orders ADD COLUMN tip          REAL DEFAULT 0").run();
  if (!cols.includes('waiter_name'))  db.prepare("ALTER TABLE orders ADD COLUMN waiter_name  TEXT DEFAULT ''").run();
  if (!cols.includes('order_type'))   db.prepare("ALTER TABLE orders ADD COLUMN order_type   TEXT DEFAULT 'indoor'").run();
  if (!cols.includes('coupon_code'))  db.prepare("ALTER TABLE orders ADD COLUMN coupon_code  TEXT DEFAULT ''").run();

  // Tables — physical table slots per area
  db.prepare(`CREATE TABLE IF NOT EXISTS tables (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    area   TEXT    NOT NULL DEFAULT 'indoor',
    number INTEGER NOT NULL,
    label  TEXT    NOT NULL DEFAULT '',
    UNIQUE(area, number)
  )`).run();

  // Settings table — key/value store for site config
  db.prepare(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`).run();
  // Default: ordering disabled until admin enables it from POS
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('ordering_enabled', '0')").run();

  // Coupons table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS coupons (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      code           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      discount_type  TEXT    NOT NULL DEFAULT 'percent',
      discount_value REAL    NOT NULL DEFAULT 0,
      min_order      REAL    DEFAULT 0,
      max_uses       INTEGER DEFAULT 0,
      uses_count     INTEGER DEFAULT 0,
      expires_at     TEXT    DEFAULT NULL,
      active         INTEGER DEFAULT 1,
      description    TEXT    DEFAULT ''
    )
  `).run();

  // Seed sample coupons if none exist
  const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM coupons').get();
  if (cnt === 0) {
    const ins = db.prepare(`INSERT INTO coupons (code, discount_type, discount_value, min_order, max_uses, description)
                            VALUES (?, ?, ?, ?, ?, ?)`);
    ins.run('WELCOME10', 'percent', 10, 0,   100, '10% off for new customers');
    ins.run('FLAT50',    'flat',    50, 300, 50,  '₹50 off on orders above ₹300');
    ins.run('SAVE20',  'percent', 20, 0,   30,  '20% off your order');
  }

  // Ensure all percent-based coupons have no minimum order requirement
  db.prepare("UPDATE coupons SET min_order = 0 WHERE discount_type = 'percent'").run();
})();

// ── COUPON API ───────────────────────────────────────────────────────────────
app.get('/api/coupons/verify', (req, res) => {
  const code = (req.query.code || '').trim();
  const orderTotal = parseFloat(req.query.total) || 0;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE AND active = 1').get(code);
  if (!coupon) return res.status(404).json({ valid: false, error: 'Invalid coupon code' });

  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return res.status(400).json({ valid: false, error: 'This coupon has expired' });
  }
  if (coupon.max_uses > 0 && coupon.uses_count >= coupon.max_uses) {
    return res.status(400).json({ valid: false, error: 'This coupon has reached its usage limit' });
  }
  if (coupon.min_order > 0 && orderTotal < coupon.min_order) {
    return res.status(400).json({
      valid: false,
      error: `Minimum order of ₹${coupon.min_order} required for this coupon`
    });
  }

  const discountAmt = coupon.discount_type === 'percent'
    ? Math.min((orderTotal * coupon.discount_value) / 100, orderTotal)
    : Math.min(coupon.discount_value, orderTotal);

  res.json({
    valid: true,
    code: coupon.code,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    discount_amount: +discountAmt.toFixed(2),
    description: coupon.description,
    message: coupon.discount_type === 'percent'
      ? `${coupon.discount_value}% off — you save ₹${discountAmt.toFixed(0)}`
      : `₹${coupon.discount_value} off applied`,
  });
});

app.post('/api/coupons/redeem', (req, res) => {
  const code = ((req.body && req.body.code) || '').trim();
  if (!code) return res.status(400).json({ error: 'No code provided' });

  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE AND active = 1').get(code);
  if (!coupon) return res.status(404).json({ success: false, error: 'Invalid coupon code' });

  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return res.status(400).json({ success: false, error: 'This coupon has expired' });
  }
  if (coupon.max_uses > 0 && coupon.uses_count >= coupon.max_uses) {
    return res.status(400).json({ success: false, error: 'This coupon has already been used' });
  }

  db.prepare('UPDATE coupons SET uses_count = uses_count + 1 WHERE id = ?').run(coupon.id);
  res.json({ success: true, code: coupon.code });
});

// ── ORDER API ────────────────────────────────────────────────────────────────
app.post('/api/orders', (req, res) => {
  const { table_number, customer_name, customer_phone, notes, items, coupon_code, order_type } = req.body;
  if (!table_number || !items?.length) {
    return res.status(400).json({ error: 'table_number and items are required' });
  }
  // Phone optional for POS; only validate format if provided
  if (customer_phone && !/^[6-9]\d{9}$/.test(customer_phone)) {
    return res.status(400).json({ error: 'Enter a valid 10-digit phone number' });
  }

  const subtotal = items.reduce((s, i) => s + (i.price || i.item_price) * i.quantity, 0);

  // Apply coupon if provided
  let discountAmt = 0;
  let validCoupon = null;
  if (coupon_code) {
    const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE AND active = 1').get(coupon_code.trim());
    if (coupon && !(coupon.max_uses > 0 && coupon.uses_count >= coupon.max_uses)) {
      discountAmt = coupon.discount_type === 'percent'
        ? Math.min((subtotal * coupon.discount_value) / 100, subtotal)
        : Math.min(coupon.discount_value, subtotal);
      validCoupon = coupon;
    }
  }
  const total = +(subtotal - discountAmt).toFixed(2);

  const insertOrder = db.prepare(
    'INSERT INTO orders (table_number, customer_name, customer_phone, notes, total, discount, coupon_code, order_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertItem = db.prepare(
    'INSERT INTO order_items (order_id, item_id, item_name, item_price, quantity, notes) VALUES (?, ?, ?, ?, ?, ?)'
  );

  let orderId;
  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = insertOrder.run(
      table_number, customer_name || '', customer_phone || '', notes || '',
      total, discountAmt, coupon_code ? coupon_code.trim().toUpperCase() : '',
      (order_type || 'indoor').toLowerCase()
    );
    for (const item of items) {
      insertItem.run(lastInsertRowid, item.id || item.item_id, item.name || item.item_name || '', item.price || item.item_price, item.quantity, item.notes || '');
    }
    orderId = lastInsertRowid;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // Increment coupon usage
  if (validCoupon) {
    db.prepare('UPDATE coupons SET uses_count = uses_count + 1 WHERE id = ?').run(validCoupon.id);
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);

  const { cnt: activeCount } = db.prepare(
    "SELECT COUNT(*) as cnt FROM orders WHERE status IN ('pending','preparing') AND id != ?"
  ).get(orderId);
  const waitMinutes = Math.max(5, activeCount * 4 + 5);

  io.emit('new_order', order);  dbSync();
  waOrderReceived(order); // WhatsApp: order received
  res.json({ success: true, order_id: orderId, wait_minutes: waitMinutes, order });
});

app.get('/api/orders', (req, res) => {
  const { status, table } = req.query;
  let rows;
  if (table) {
    rows = status && status !== 'all'
      ? db.prepare('SELECT * FROM orders WHERE table_number = ? AND status = ? ORDER BY created_at DESC').all(Number(table), status)
      : db.prepare('SELECT * FROM orders WHERE table_number = ? ORDER BY created_at DESC LIMIT 50').all(Number(table));
  } else {
    rows = status && status !== 'all'
      ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC').all(status)
      : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all();
  }
  for (const o of rows) {
    o.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id);
  }
  res.json(rows);
});

app.get('/api/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  res.json(order);
});

app.patch('/api/orders/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'preparing', 'done', 'settled', 'cancelled', 'on_hold'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  io.emit('order_updated', order);  dbSync();
  // WhatsApp notifications on key status transitions
  if (status === 'preparing') waPreparingStarted(order);
  if (status === 'done')      waOrderReady(order);
  res.json(order);
});

app.patch('/api/orders/:id', requireAuth, (req, res) => {
  const { table_number, waiter_name, order_type, customer_name } = req.body;
  const fields = [], vals = [];
  if (table_number  !== undefined) { fields.push('table_number = ?');  vals.push(Number(table_number)); }
  if (waiter_name   !== undefined) { fields.push('waiter_name = ?');   vals.push(waiter_name); }
  if (order_type    !== undefined) { fields.push('order_type = ?');    vals.push(order_type); }
  if (customer_name !== undefined) { fields.push('customer_name = ?'); vals.push(customer_name); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  io.emit('order_updated', order);  dbSync();
  res.json(order);
});

app.patch('/api/orders/:id/discount', requireAuth, (req, res) => {
  const { discount, type } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const subtotal = db.prepare('SELECT SUM(item_price * quantity) as s FROM order_items WHERE order_id = ?').get(req.params.id).s || 0;
  const discountAmt = type === 'percent' ? (subtotal * discount / 100) : Number(discount);
  const tax = (subtotal - discountAmt) * 0.05;
  const newTotal = subtotal - discountAmt + tax;
  db.prepare('UPDATE orders SET discount = ?, total = ? WHERE id = ?').run(discountAmt, newTotal, req.params.id);
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  updated.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id);
  io.emit('order_updated', updated);  dbSync();
  res.json(updated);
});

app.patch('/api/orders/:id/tip', requireAuth, (req, res) => {
  const { tip } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  // Remove old tip, add new
  const subtotal = db.prepare('SELECT SUM(item_price * quantity) as s FROM order_items WHERE order_id = ?').get(req.params.id).s || 0;
  const discount = order.discount || 0;
  const tax = (subtotal - discount) * 0.05;
  const newTotal = subtotal - discount + tax + Number(tip);
  db.prepare('UPDATE orders SET tip = ?, total = ? WHERE id = ?').run(Number(tip), newTotal, req.params.id);
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  updated.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id);
  io.emit('order_updated', updated);  dbSync();
  res.json(updated);
});

// ── TABLES API ───────────────────────────────────────────────────────────────
app.get('/api/tables', (req, res) => {
  const { area } = req.query;
  const rows = area
    ? db.prepare('SELECT * FROM tables WHERE area = ? ORDER BY number ASC').all(area.toLowerCase())
    : db.prepare('SELECT * FROM tables ORDER BY area, number ASC').all();
  res.json(rows);
});

app.post('/api/tables', requireAuth, (req, res) => {
  const { area = 'indoor' } = req.body;
  const a = area.toLowerCase();
  // Global sequence — T numbers are unique across ALL areas, never reset
  const fromRows    = db.prepare('SELECT MAX(number) as mx FROM tables').get().mx || 0;
  const counterKey  = 'table_seq_global';
  const fromCounter = Number(db.prepare("SELECT value FROM settings WHERE key = ?").get(counterKey)?.value || 0);
  const number = Math.max(fromRows, fromCounter) + 1;
  // Persist the new high-water mark
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(counterKey, String(number));
  const label = `T${number}`;
  db.prepare('INSERT INTO tables (area, number, label) VALUES (?, ?, ?)').run(a, number, label);
  const row = db.prepare('SELECT * FROM tables WHERE area = ? AND number = ?').get(a, number);
  io.emit('tables_updated', { area: a });
  res.json(row);
});

app.delete('/api/tables/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM tables WHERE id = ?').run(req.params.id);
  io.emit('tables_updated', { area: row.area });
  res.json({ success: true });
});

// ── SETTINGS API ─────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(rows); // return as array [{key,value}] for admin dashboard
});

app.patch('/api/settings', (req, res) => {
  const allowed = ['ordering_enabled', 'restaurant_name', 'tax_rate'];
  const updates = Object.entries(req.body || {}).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'No valid keys' });
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  updates.forEach(([k, v]) => stmt.run(k, String(v)));
  // Broadcast setting change to all connected clients
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  rows.forEach(r => { out[r.key] = r.value === '1' || r.value === 'true' ? true : r.value === '0' || r.value === 'false' ? false : r.value; });
  io.emit('settings_updated', out);
  res.json(out);
});

// ── ADMIN AUTH ───────────────────────────────────────────────────────────────
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
if (!ADMIN_PASS || !ADMIN_EMAIL) {
  console.error('[FATAL] ADMIN_PASSWORD and ADMIN_EMAIL env vars must be set');
  process.exit(1);
}
const TOKEN_TTL   = 24 * 60 * 60 * 1000; // 24 hours

// Session store: token -> { expiry, role }
const sessions = new Map();

// Prune expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.expiry < now) sessions.delete(token);
}, 60 * 60 * 1000);

// Rate limiter: max 10 attempts per IP per 15 min
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const win = 15 * 60 * 1000;
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + win };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + win; }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count <= 10;
}

function getSession(req) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const s = sessions.get(token);
  return (s && s.expiry > Date.now()) ? s : null;
}

// requireAdmin — only admin-role tokens
function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s || s.role !== 'admin') return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// requireAuth — any valid token (admin or pos)
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── POS LOGIN ──────────────────────────────────────────────────────────────
const POS_PIN = process.env.POS_PIN;
if (!POS_PIN) { console.error('[FATAL] POS_PIN env var must be set'); process.exit(1); }

app.post('/api/pos/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  if (req.body.pin === POS_PIN) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expiry: Date.now() + TOKEN_TTL, role: 'pos' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Wrong PIN' });
});

app.post('/api/pos/logout', requireAuth, (req, res) => {
  const token = req.headers['authorization'].slice(7);
  sessions.delete(token);
  res.json({ success: true });
});

// ── ADMIN LOGIN ────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const { email, password } = req.body;
  const emailOk = email?.toLowerCase().trim() === ADMIN_EMAIL.toLowerCase();
  const passOk  = password === ADMIN_PASS;
  if (emailOk && passOk) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expiry: Date.now() + TOKEN_TTL, role: 'admin' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid email or password' });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.headers['authorization'].slice(7);
  sessions.delete(token);
  res.json({ success: true });
});

// ── ADMIN API ────────────────────────────────────────────────────────────────
app.get('/api/admin/menu', requireAdmin, (req, res) => {
  const cats  = db.prepare('SELECT * FROM categories ORDER BY sort_order').all();
  const items = db.prepare('SELECT * FROM menu_items ORDER BY category_id, name').all();
  res.json(cats.map(c => ({ ...c, items: items.filter(i => i.category_id === c.id) })));
});

app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const { name } = req.body;
  const { max } = db.prepare('SELECT MAX(sort_order) as max FROM categories').get();
  const { lastInsertRowid: id } = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)').run(name, (max || 0) + 1);
  res.json({ id, name, sort_order: (max || 0) + 1 });
});

app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM menu_items WHERE category_id = ?').run(req.params.id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/items', requireAdmin, (req, res) => {
  const { category_id, name, description, price } = req.body;
  const { lastInsertRowid: id } = db.prepare(
    'INSERT INTO menu_items (category_id, name, description, price) VALUES (?, ?, ?, ?)'
  ).run(category_id, name, description || '', price);
  res.json({ id, category_id, name, description, price, available: 1 });
});

app.put('/api/admin/items/:id', requireAdmin, (req, res) => {
  const { name, description, price, available } = req.body;
  db.prepare(
    'UPDATE menu_items SET name = ?, description = ?, price = ?, available = ? WHERE id = ?'
  ).run(name, description, price, available ? 1 : 0, req.params.id);
  io.emit('item_availability', { id: Number(req.params.id), available: available ? true : false });
  res.json({ success: true });
});

app.delete('/api/admin/items/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.patch('/api/admin/items/:id/toggle', requireAdmin, (req, res) => {
  const item = db.prepare('SELECT available FROM menu_items WHERE id = ?').get(req.params.id);
  const next = item.available ? 0 : 1;
  db.prepare('UPDATE menu_items SET available = ? WHERE id = ?').run(next, req.params.id);
  io.emit('item_availability', { id: Number(req.params.id), available: next === 1 });
  res.json({ available: next });
});

app.patch('/api/admin/items/:id/toggle-special', requireAdmin, (req, res) => {
  const item = db.prepare('SELECT is_house_special FROM menu_items WHERE id = ?').get(req.params.id);
  const next = item.is_house_special ? 0 : 1;
  db.prepare('UPDATE menu_items SET is_house_special = ? WHERE id = ?').run(next, req.params.id);
  res.json({ is_house_special: next });
});

// ── COUPON ADMIN CRUD ─────────────────────────────────────────────────────────
app.get('/api/admin/coupons', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all();
  res.json(rows);
});

app.post('/api/admin/coupons', requireAdmin, (req, res) => {
  const { code, discount_type, discount_value, min_order, max_uses, description, expires_at } = req.body;
  if (!code || !discount_type || discount_value == null)
    return res.status(400).json({ error: 'code, discount_type and discount_value required' });
  try {
    const r = db.prepare(
      `INSERT INTO coupons (code, discount_type, discount_value, min_order, max_uses, description, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(code.trim().toUpperCase(), discount_type, +discount_value,
          +(min_order||0), +(max_uses||0), description||'', expires_at||null);
    res.json({ id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: 'Coupon code already exists' }); }
});

app.patch('/api/admin/coupons/:id', requireAdmin, (req, res) => {
  const { active, description, max_uses, expires_at } = req.body;
  const fields = [];
  const vals   = [];
  if (active    !== undefined) { fields.push('active = ?');      vals.push(active ? 1 : 0); }
  if (description !== undefined){ fields.push('description = ?'); vals.push(description); }
  if (max_uses  !== undefined) { fields.push('max_uses = ?');    vals.push(+max_uses); }
  if (expires_at !== undefined){ fields.push('expires_at = ?'); vals.push(expires_at||null); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE coupons SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

app.delete('/api/admin/coupons/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM coupons WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[socket] connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[socket] disconnected: ${socket.id}`));
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Cafe POS server → http://localhost:${PORT}`));

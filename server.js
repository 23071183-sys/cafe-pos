const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');

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
const dbPath = process.env.DB_PATH || path.join(__dirname, 'orders.db');
const db = new Database(dbPath);

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

  const hotCoffee    = addCat.run('Hot Coffee', 1).lastInsertRowid;
  const hotSpecials  = addCat.run('Hot Specials', 2).lastInsertRowid;
  const icedCoffee   = addCat.run('Iced Coffee', 3).lastInsertRowid;
  const icedSpecials = addCat.run('Iced Specials', 4).lastInsertRowid;
  const coldBrew     = addCat.run('Cold Brew', 5).lastInsertRowid;
  const frappe       = addCat.run('Frappe', 6).lastInsertRowid;
  const mojito       = addCat.run('Mojito', 7).lastInsertRowid;
  const milkshakes   = addCat.run('Milkshakes', 8).lastInsertRowid;
  const icedTea      = addCat.run('Iced Tea', 9).lastInsertRowid;
  const matcha          = addCat.run('Matcha', 10).lastInsertRowid;
  const packaged        = addCat.run('Packaged Drinks', 11).lastInsertRowid;
  const globalFusions   = addCat.run('Global Fusions', 12).lastInsertRowid;
  const toasties        = addCat.run('Toasties', 13).lastInsertRowid;
  const pasta           = addCat.run('Pasta', 14).lastInsertRowid;
  const sandwiches      = addCat.run('Sandwiches', 15).lastInsertRowid;
  const mains           = addCat.run('Mains', 16).lastInsertRowid;
  const riceBowls       = addCat.run('Special Rice Bowls', 17).lastInsertRowid;
  const sides           = addCat.run('Sides', 18).lastInsertRowid;
  const sweets          = addCat.run('Sweet', 19).lastInsertRowid;
  const desserts        = addCat.run('Desserts', 20).lastInsertRowid;

  // Hot Coffee
  addItem.run(hotCoffee, 'Espresso',       'Single shot, freshly pulled',         120);
  addItem.run(hotCoffee, 'Doppio',         'Double espresso shot',                140);
  addItem.run(hotCoffee, 'Americano',      'Espresso with hot water',             150);
  addItem.run(hotCoffee, 'Cortado',        'Espresso with equal parts warm milk', 160);
  addItem.run(hotCoffee, 'Cappuccino',     'Espresso with steamed milk foam',     170);
  addItem.run(hotCoffee, 'Cafe Latte',     'Espresso with steamed milk',          170);
  addItem.run(hotCoffee, 'Flat White',     'Velvety microfoam espresso',          170);
  addItem.run(hotCoffee, 'Mocha',          'Espresso with chocolate & milk',      180);

  // Hot Specials
  addItem.run(hotSpecials, 'Vietnames Latte',       'Condensed milk & robusta espresso',    200);
  addItem.run(hotSpecials, 'Spanish Latte',          'Espresso with condensed & fresh milk', 200);
  addItem.run(hotSpecials, 'French Vanilla Latte',   'Smooth vanilla-infused latte',         200);
  addItem.run(hotSpecials, 'White Chocolate',        'Espresso with white chocolate sauce',  200);
  addItem.run(hotSpecials, 'Roasted Hazelnut Latte', 'Latte with roasted hazelnut syrup',    200);

  // Iced Coffee — basic + specialty lattes
  addItem.run(icedCoffee, 'Iced Latte',           'Espresso over ice with milk · add-ons: Caramel/Vanilla', 170);
  addItem.run(icedCoffee, 'Iced Americano',       'Espresso over ice with water',             160);
  addItem.run(icedCoffee, 'Iced Mocha',           'Espresso, chocolate & ice',                190);
  addItem.run(icedCoffee, 'Salted Caramel Latte', 'Iced espresso with salted caramel',        220);
  addItem.run(icedCoffee, 'French Toast Latte',   'Cinnamon & maple iced latte',              220);
  addItem.run(icedCoffee, 'Tiramisu Latte',       'Mascarpone & espresso iced latte',         250);
  addItem.run(icedCoffee, 'Bonafee Latte',        'Caramel banana iced latte',                240);
  addItem.run(icedCoffee, 'Coconut Cloud',        'Iced espresso with coconut milk foam',     240);

  // Iced Specials
  addItem.run(icedSpecials, 'Vietnames Latte',       'Condensed milk iced espresso',           200);
  addItem.run(icedSpecials, 'Spanish Latte',          'Condensed & fresh milk iced espresso',   200);
  addItem.run(icedSpecials, 'French Vanilla Latte',   'Smooth vanilla iced latte',              200);
  addItem.run(icedSpecials, 'Roasted Hazelnut Latte', 'Hazelnut syrup iced latte',              200);
  addItem.run(icedSpecials, 'Cranberry Espresso',     'Espresso with cranberry over ice',       200);
  addItem.run(icedSpecials, 'Orange Sunrise',         'Espresso with fresh orange over ice',    220);

  // Cold Brew
  addItem.run(coldBrew, 'Straight Up',                'Classic slow-steeped cold brew',        150);
  addItem.run(coldBrew, 'House Basil',               'Cold brew with fresh basil',            200);
  addItem.run(coldBrew, 'Coldbrew Gingerale / Tonic', 'Cold brew with ginger ale or tonic',    180);
  addItem.run(coldBrew, 'Yuzu',                       'Cold brew with yuzu citrus',            220);
  addItem.run(coldBrew, 'Berry Coldbrew',             'Cold brew with mixed berry syrup',      200);
  addItem.run(coldBrew, 'Lavender Coldbrew',          'Cold brew with lavender infusion',      200);
  addItem.run(coldBrew, 'Fridge Cigarette Coffee',    'Smoked cold brew, house specialty',     240);

  // Frappe
  addItem.run(frappe, 'Classic Frappe',   'Blended coffee frappe · add-ons: Caramel/Hazelnut/Vanilla', 190);
  addItem.run(frappe, 'Mocha Frappe',     'Chocolate & coffee blended frappe',  220);
  addItem.run(frappe, 'Ferreo Frappe',    'Ferrero-inspired hazelnut frappe',   220);
  addItem.run(frappe, 'Salted Caramel',   'Caramel & salt blended frappe',      220);
  addItem.run(frappe, 'Tiramisu Frappe',  'Mascarpone & espresso frappe',       240);
  addItem.run(frappe, 'Brownie Frappe',   'Rich chocolate brownie frappe',      240);

  // Mojito
  addItem.run(mojito, 'Virgin Mojito', 'Lime, mint, soda, sugar',            180);
  addItem.run(mojito, 'Watermelon',    'Watermelon mojito with mint & lime', 180);
  addItem.run(mojito, 'Jamun Spritz',  'Jamun & lime sparkling mojito',      180);
  addItem.run(mojito, 'Blueberry',     'Blueberry mint mojito',              180);
  addItem.run(mojito, 'Mango Berry',   'Mango & berry mojito',               180);
  addItem.run(mojito, 'Rasberry',      'Fresh raspberry mojito',             180);

  // Milkshakes
  addItem.run(milkshakes, 'Cookie Crumble', 'Blended cookie milkshake',    220);
  addItem.run(milkshakes, 'Strawberry',     'Fresh strawberry milkshake',  220);
  addItem.run(milkshakes, 'Mango',          'Fresh mango milkshake',       220);
  addItem.run(milkshakes, 'Blueberry',      'Fresh blueberry milkshake',   220);

  // Iced Tea
  addItem.run(icedTea, 'Lemon',    'Classic lemon iced tea',   180);
  addItem.run(icedTea, 'Peach',    'Sweet peach iced tea',     180);
  addItem.run(icedTea, 'Hibiscus', 'Floral hibiscus iced tea', 180);

  // Matcha
  addItem.run(matcha, 'Mango Matcha Latte',      'Ceremonial matcha with fresh Alphonso mango',      250);
  addItem.run(matcha, 'Matcha Latte',            'Classic iced matcha with creamy milk',             230);
  addItem.run(matcha, 'Matcha Cloud',            'Iced matcha topped with salted cream cloud foam',  250);
  addItem.run(matcha, 'Strawberry Matcha Latte', 'Matcha layered with fresh strawberry purée',       250);

  // Packaged Drinks
  addItem.run(packaged, 'Water Bottle', 'Still water 500ml',  40);
  addItem.run(packaged, 'Redbull',      'Energy drink 250ml', 180);
  addItem.run(packaged, 'Diet Coke',    'Diet Coke 300ml',    70);

  // Global Fusions
  addItem.run(globalFusions, 'Andhra Chicken Pita',   'Spicy Andhra-style chicken in pita bread',  380);
  addItem.run(globalFusions, 'Paneer Fingers',        'Crispy golden paneer fingers',               380);
  addItem.run(globalFusions, 'Thecha Spaghetti',      'Spaghetti with fiery green chilli thecha',   360);
  addItem.run(globalFusions, 'Thecha Chicken Wings',  'Crispy wings with green chilli thecha',      360);
  addItem.run(globalFusions, 'Kung Pao Chicken',      'Stir-fried chicken with peanuts & chilli',   360);
  addItem.run(globalFusions, 'Mexican Samosa Chaat',  'Crispy samosa with Mexican toppings',        300);

  // Toasties
  addItem.run(toasties, 'Avocado Toasties',         'Smashed avocado on toasted sourdough',      300);
  addItem.run(toasties, 'Chilli Cheese Toasties',   'Melted cheese with green chilli toast',     300);
  addItem.run(toasties, 'Creamy Veggie Toasties',   'Creamy vegetable filling on toast',         300);
  addItem.run(toasties, 'Creamy Mushroom Toasties', 'Creamy mushroom filling on toast',          300);
  addItem.run(toasties, 'Creamy Chicken Toasties',  'Creamy chicken filling on toast',           300);

  // Pasta
  addItem.run(pasta, 'Aglio Olio',       'Garlic & olive oil spaghetti · add chicken +₹50',  330);
  addItem.run(pasta, 'Pesto Pasta',      'Fresh basil pesto pasta · add chicken +₹50',        330);
  addItem.run(pasta, 'Pink Sauce Pasta', 'Creamy tomato pink sauce · add chicken +₹50',       320);
  addItem.run(pasta, 'Alfredo Pasta',    'Creamy Alfredo sauce · add chicken +₹50',           300);
  addItem.run(pasta, 'Arrabbiata Pasta', 'Spicy tomato sauce pasta · add chicken +₹50',       300);

  // Sandwiches
  addItem.run(sandwiches, 'Chicken Keema',     'Spiced chicken mince in a toasted bun',           330);
  addItem.run(sandwiches, 'Truffle Mushroom',  'Truffle oil & mushroom in toasted sourdough',     330);
  addItem.run(sandwiches, 'Veg Keema Sandos',  'Spiced soy keema in a Japanese-style bun',        300);
  addItem.run(sandwiches, 'Spicy Bombay',      'Masala veggies, chutney & cheese',                280);

  // Mains
  addItem.run(mains, 'Paneer Steak Bowl',     'Grilled paneer steak with sides',              360);
  addItem.run(mains, 'Chicken Steak Bowl',    'Grilled chicken steak with sides',             390);
  addItem.run(mains, 'Pizza Chicken Loaded',  'Loaded pizza with chicken toppings',           450);
  addItem.run(mains, 'Pizza Veggie Loaded',   'Loaded pizza with fresh veggie toppings',      400);

  // Special Rice Bowls
  addItem.run(riceBowls, 'Saoji Rice Bowl',           'Fiery house-style Saoji chicken curry with rice', 360);
  addItem.run(riceBowls, 'Makhani Chicken Rice Bowl', 'Butter chicken gravy over steamed rice',           360);
  addItem.run(riceBowls, 'Makhani Paneer Rice Bowl',  'Butter paneer gravy over steamed rice',            340);
  addItem.run(riceBowls, 'Mexican Rice Bowl',         'Spiced Mexican-style rice with salsa & beans',     340);
  addItem.run(riceBowls, 'Oriental Rice Bowl',        'Stir-fried Oriental veggies with rice',            340);

  // Sides
  addItem.run(sides, 'Chicken Tender', 'Juicy breaded chicken tenders', 280);
  addItem.run(sides, 'House Fries',   'Seasoned house-style fries',    240);

  // Sweet
  addItem.run(sweets, 'Mango Smoothie Bowl',     'Fresh mango, granola & toppings',                260);
  addItem.run(sweets, 'Blueberry Smoothie Bowl', 'Fresh blueberry, granola & toppings',            260);
  addItem.run(sweets, 'French Toast',            'Golden French toast · add-ons: Nutella/Alphonso mango/Espresso cream/Blueberry', 300);
  addItem.run(sweets, 'Pancakes',                'Fluffy pancakes · add-ons: Nutella/Alphonso mango/Espresso cream/Blueberry',     300);

  // Desserts
  addItem.run(desserts, 'Mango Tres Leches',      'Light sponge cake soaked in flavored milk, topped with fresh Alphonso Mangoes',      390);
  addItem.run(desserts, 'Mango Misu',             'Fruity tiramisu with layers of soft biscuits, creamy filling and sweet mango puree', 360);
  addItem.run(desserts, 'Tiramisu',               'Ladyfinger biscuits soaked in espresso, layered with mascarpone and Belgian cocoa',  330);
  addItem.run(desserts, 'Chocolate Croissant',    'Golden layered croissant filled with luscious chocolate, crisp outside & soft inside',290);
  addItem.run(desserts, 'Belgian Chocolate Cake', 'Decadent Belgian chocolate cake with intense cocoa taste',                           290);
}

// ── MIGRATION: add is_house_special column if missing ───────────────────────
const hsColExists = db.prepare("PRAGMA table_info(menu_items)").all().some(c => c.name === 'is_house_special');
if (!hsColExists) {
  db.prepare("ALTER TABLE menu_items ADD COLUMN is_house_special INTEGER DEFAULT 0").run();
  // Auto-mark known house items by description keyword
  db.prepare("UPDATE menu_items SET is_house_special = 1 WHERE description LIKE '%house%' OR name LIKE 'House%'").run();
  console.log('[Migration] is_house_special column added');
}

// ── MIGRATION: add Matcha category if missing ────────────────────────────────
const matchaExists = db.prepare("SELECT id FROM categories WHERE name = 'Matcha'").get();
if (!matchaExists) {
  const addItem = db.prepare('INSERT INTO menu_items (category_id, name, description, price) VALUES (?, ?, ?, ?)');
  const matchaId = db.prepare("INSERT INTO categories (name, sort_order) VALUES ('Matcha', 10)").run().lastInsertRowid;
  // shift Packaged Drinks and food cats down by 1
  db.prepare("UPDATE categories SET sort_order = sort_order + 1 WHERE sort_order >= 10 AND name != 'Matcha'").run();
  addItem.run(matchaId, 'Mango Matcha Latte',      'Ceremonial matcha with fresh Alphonso mango',      250);
  addItem.run(matchaId, 'Matcha Latte',            'Classic iced matcha with creamy milk',             230);
  addItem.run(matchaId, 'Matcha Cloud',            'Iced matcha topped with salted cream cloud foam',  250);
  addItem.run(matchaId, 'Strawberry Matcha Latte', 'Matcha layered with fresh strawberry purée',       250);
  console.log('[Migration] Matcha category added');
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

  // Bulk coupon batch — INSERT OR IGNORE so re-deploys don't duplicate
  const bulkIns = db.prepare(`INSERT OR IGNORE INTO coupons (code, discount_type, discount_value, min_order, max_uses, description) VALUES (?, 'percent', ?, 0, 1, ?)`);
  const bulkTx  = db.transaction((coupons) => { for (const c of coupons) bulkIns.run(c.code, c.pct, `${c.pct}% off`); });
  bulkTx([
    // ── 50% off (20 codes) ──
    {code:'LS50-FJALWP',pct:50},{code:'LS50-3KGZDB',pct:50},{code:'LS50-4H96G9',pct:50},
    {code:'LS50-DWQ3B5',pct:50},{code:'LS50-QYZFND',pct:50},{code:'LS50-2RFCMJ',pct:50},
    {code:'LS50-LEPTNB',pct:50},{code:'LS50-LZJ4LQ',pct:50},{code:'LS50-DHQ97G',pct:50},
    {code:'LS50-3EAX62',pct:50},{code:'LS50-NP2RUS',pct:50},{code:'LS50-253YGM',pct:50},
    {code:'LS50-JXEMQJ',pct:50},{code:'LS50-L6TLBF',pct:50},{code:'LS50-M7A4EN',pct:50},
    {code:'LS50-8HER74',pct:50},{code:'LS50-YKDJRA',pct:50},{code:'LS50-PT9KK2',pct:50},
    {code:'LS50-KWX2RC',pct:50},{code:'LS50-EM38C7',pct:50},
    // ── 30% off (30 codes) ──
    {code:'LS30-S7BULD',pct:30},{code:'LS30-CXYV92',pct:30},{code:'LS30-395EMR',pct:30},
    {code:'LS30-M37NCR',pct:30},{code:'LS30-4CXYLM',pct:30},{code:'LS30-RD9QXQ',pct:30},
    {code:'LS30-FE4D2X',pct:30},{code:'LS30-SBBFUT',pct:30},{code:'LS30-87P4SB',pct:30},
    {code:'LS30-PA6C3V',pct:30},{code:'LS30-EFHDND',pct:30},{code:'LS30-JWNJ9C',pct:30},
    {code:'LS30-4QCGLZ',pct:30},{code:'LS30-XVPTMD',pct:30},{code:'LS30-EUQXKG',pct:30},
    {code:'LS30-NXF7J9',pct:30},{code:'LS30-MN5LYB',pct:30},{code:'LS30-KEXX6T',pct:30},
    {code:'LS30-TAXQ4T',pct:30},{code:'LS30-5DDYYM',pct:30},{code:'LS30-KJL7S7',pct:30},
    {code:'LS30-THMKZ7',pct:30},{code:'LS30-9H4VYW',pct:30},{code:'LS30-6PHTR6',pct:30},
    {code:'LS30-FW2LWP',pct:30},{code:'LS30-67673X',pct:30},{code:'LS30-3Q4B2Z',pct:30},
    {code:'LS30-5252C2',pct:30},{code:'LS30-6XPKZZ',pct:30},{code:'LS30-A85PMY',pct:30},
    // ── 10% off (30 codes) ──
    {code:'LS10-5R83MM',pct:10},{code:'LS10-8F396J',pct:10},{code:'LS10-TEJAUN',pct:10},
    {code:'LS10-UN8YW5',pct:10},{code:'LS10-5763Q8',pct:10},{code:'LS10-GUUXJF',pct:10},
    {code:'LS10-6CM7LB',pct:10},{code:'LS10-38G79R',pct:10},{code:'LS10-8KQY8P',pct:10},
    {code:'LS10-4CTVTZ',pct:10},{code:'LS10-7ZV68H',pct:10},{code:'LS10-8887YX',pct:10},
    {code:'LS10-LZ44LN',pct:10},{code:'LS10-329TEN',pct:10},{code:'LS10-GXLVMY',pct:10},
    {code:'LS10-CXLN2C',pct:10},{code:'LS10-M27PHB',pct:10},{code:'LS10-6DMSNB',pct:10},
    {code:'LS10-BNJX3U',pct:10},{code:'LS10-5SYNJS',pct:10},{code:'LS10-Z37WRD',pct:10},
    {code:'LS10-3NPGPH',pct:10},{code:'LS10-JYZT4F',pct:10},{code:'LS10-YX8CBD',pct:10},
    {code:'LS10-EMHCAC',pct:10},{code:'LS10-F3VXQ5',pct:10},{code:'LS10-PYTBH8',pct:10},
    {code:'LS10-THWGUU',pct:10},{code:'LS10-FZ9ZDF',pct:10},{code:'LS10-PRWSUW',pct:10},
    // ── 15% off (30 codes) ──
    {code:'LS15-BL7KFD',pct:15},{code:'LS15-YA9DT7',pct:15},{code:'LS15-LQL2WF',pct:15},
    {code:'LS15-ZKH2MT',pct:15},{code:'LS15-72TN44',pct:15},{code:'LS15-ELSYEM',pct:15},
    {code:'LS15-GXEUJV',pct:15},{code:'LS15-BVGKYW',pct:15},{code:'LS15-FTCMH7',pct:15},
    {code:'LS15-MP6XW9',pct:15},{code:'LS15-A6TVX8',pct:15},{code:'LS15-ZCFCMN',pct:15},
    {code:'LS15-5BBPC3',pct:15},{code:'LS15-HKFRJU',pct:15},{code:'LS15-PGY9U9',pct:15},
    {code:'LS15-AXTC27',pct:15},{code:'LS15-UYQ858',pct:15},{code:'LS15-E448LC',pct:15},
    {code:'LS15-ZHE3SE',pct:15},{code:'LS15-UDFN6Q',pct:15},{code:'LS15-WZB6GQ',pct:15},
    {code:'LS15-CMURAT',pct:15},{code:'LS15-56F66R',pct:15},{code:'LS15-JKM7NQ',pct:15},
    {code:'LS15-C8VZ6J',pct:15},{code:'LS15-4CTYHJ',pct:15},{code:'LS15-7TEM6F',pct:15},
    {code:'LS15-ZF4RGB',pct:15},{code:'LS15-D4AHF4',pct:15},{code:'LS15-VJ6NXL',pct:15},
  ]);

  // Ensure all LS-prefixed batch coupons are strictly single-use across all tiers
  db.prepare("UPDATE coupons SET max_uses = 1 WHERE code LIKE 'LS50-%' OR code LIKE 'LS30-%' OR code LIKE 'LS15-%' OR code LIKE 'LS10-%'").run();
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

  io.emit('new_order', order);
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
  io.emit('order_updated', order);
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
  io.emit('order_updated', order);
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
  io.emit('order_updated', updated);
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
  io.emit('order_updated', updated);
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

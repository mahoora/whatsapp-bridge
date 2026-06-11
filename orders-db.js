const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'orders.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    items TEXT NOT NULL,
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    total_price REAL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now', '+3 hours'))
  )
`);

const insertOrder = db.prepare(`
  INSERT INTO orders (customer_name, customer_phone, items, notes, total_price)
  VALUES (?, ?, ?, ?, ?)
`);

const getAllOrders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC');
const getOrderById = db.prepare('SELECT * FROM orders WHERE id = ?');
const updateOrderStatus = db.prepare('UPDATE orders SET status = ? WHERE id = ?');

function createOrder({ customerName, customerPhone, items, notes, totalPrice }) {
  const result = insertOrder.run(
    customerName,
    customerPhone,
    JSON.stringify(items),
    notes || '',
    totalPrice || 0
  );
  const order = getOrderById.get(result.lastInsertRowid);
  return order;
}

function listOrders(status) {
  if (status) {
    return db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  return getAllOrders.all();
}

function getOrder(id) {
  return getOrderById.get(id);
}

function setOrderStatus(id, status) {
  updateOrderStatus.run(status, id);
  return getOrderById.get(id);
}

module.exports = { createOrder, listOrders, getOrder, setOrderStatus };

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const session = require('express-session');
const QRCode = require('qrcode');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: 'dadveggie123', resave: false, saveUninitialized: true, cookie: { secure: false } }));

// Open database (creates file if not exists)
const db = new Database('./vegetable_shop.db');

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        image_url TEXT,
        category TEXT
    );
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_address TEXT NOT NULL,
        total_amount REAL NOT NULL,
        payment_status TEXT DEFAULT 'pending',
        order_status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        product_id INTEGER,
        quantity INTEGER,
        price REAL,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    );
`);

// Insert sample vegetables if none exist
const row = db.prepare('SELECT COUNT(*) as count FROM products').get();
if (row.count === 0) {
    const veggies = [
        ['Tomato', 'Fresh red tomatoes', 40, 50, 'https://cdn.pixabay.com/photo/2020/06/01/13/55/tomatoes-5247827_640.jpg', 'Vegetable'],
        ['Potato', 'Farm potatoes', 30, 100, 'https://cdn.pixabay.com/photo/2016/08/11/08/04/potatoes-1585075_640.jpg', 'Root'],
        ['Onion', 'Red onion', 35, 80, 'https://cdn.pixabay.com/photo/2020/07/15/20/38/onion-5409359_640.jpg', 'Vegetable'],
        ['Carrot', 'Organic carrots', 45, 60, 'https://cdn.pixabay.com/photo/2017/06/23/06/04/carrots-2433439_640.jpg', 'Root'],
        ['Spinach', 'Fresh spinach bunch', 25, 30, 'https://cdn.pixabay.com/photo/2016/03/26/16/44/spinach-1280831_640.jpg', 'Leafy'],
        ['Cucumber', 'Crisp cucumber', 35, 45, 'https://cdn.pixabay.com/photo/2016/07/24/17/33/cucumber-1538652_640.jpg', 'Vegetable']
    ];
    const insert = db.prepare(`INSERT INTO products (name, description, price, stock, image_url, category) VALUES (?,?,?,?,?,?)`);
    for (const v of veggies) insert.run(v);
}

function isAdmin(req, res, next) {
    if (req.session && req.session.admin) return next();
    else return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/products', (req, res) => {
    const rows = db.prepare(`SELECT id, name, price, stock, image_url FROM products`).all();
    res.json({ products: rows });
});

app.post('/api/orders', async (req, res) => {
    const { customerName, customerPhone, customerAddress, items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items' });
    
    // Check stock
    for (let item of items) {
        const prod = db.prepare(`SELECT stock FROM products WHERE id = ?`).get(item.productId);
        if (!prod || prod.stock < item.quantity) {
            return res.status(400).json({ error: `Insufficient stock for product ID ${item.productId}` });
        }
    }
    
    const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
    const insertOrder = db.prepare(`INSERT INTO orders (customer_name, customer_phone, customer_address, total_amount) VALUES (?,?,?,?)`);
    const result = insertOrder.run(customerName, customerPhone, customerAddress, total);
    const orderId = result.lastInsertRowid;
    
    const insertItem = db.prepare(`INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?,?,?,?)`);
    for (let it of items) {
        insertItem.run(orderId, it.productId, it.quantity, it.price);
    }
    
    const UPI_ID = "9029186608@okbizaxis"; // CHANGE TO YOUR DAD'S UPI ID
    const upiUrl = `upi://pay?pa=${UPI_ID}&pn=Dad%20Veg%20Shop&am=${total}&cu=INR&tn=Order%20${orderId}`;
    QRCode.toDataURL(upiUrl, (err, qrDataUrl) => {
        if (err) return res.json({ orderId, totalAmount: total, qrCodeDataURL: null });
        res.json({ orderId, totalAmount: total, qrCodeDataURL: qrDataUrl });
    });
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === 'Pass@6073') { // CHANGE THIS PASSWORD
        req.session.admin = true;
        return res.json({ success: true });
    }
    res.status(401).json({ error: 'Wrong password' });
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/admin/products', isAdmin, (req, res) => {
    const rows = db.prepare(`SELECT * FROM products`).all();
    res.json(rows);
});

app.post('/api/admin/products', isAdmin, (req, res) => {
    const { name, description, price, stock, image_url, category } = req.body;
    const insert = db.prepare(`INSERT INTO products (name, description, price, stock, image_url, category) VALUES (?,?,?,?,?,?)`);
    const result = insert.run(name, description, price, stock, image_url || '', category);
    res.json({ id: result.lastInsertRowid });
});

app.put('/api/admin/products/:id', isAdmin, (req, res) => {
    const { name, description, price, stock, image_url, category } = req.body;
    const update = db.prepare(`UPDATE products SET name=?, description=?, price=?, stock=?, image_url=?, category=? WHERE id=?`);
    update.run(name, description, price, stock, image_url, category, req.params.id);
    res.json({ updated: true });
});

app.delete('/api/admin/products/:id', isAdmin, (req, res) => {
    const del = db.prepare(`DELETE FROM products WHERE id=?`);
    del.run(req.params.id);
    res.json({ deleted: true });
});

app.get('/api/admin/orders', isAdmin, (req, res) => {
    const orders = db.prepare(`SELECT * FROM orders ORDER BY id DESC`).all();
    for (let order of orders) {
        const items = db.prepare(`SELECT product_id, quantity, price FROM order_items WHERE order_id = ?`).all(order.id);
        order.items = items;
    }
    res.json(orders);
});

app.put('/api/admin/orders/:id/pay', isAdmin, (req, res) => {
    const orderId = req.params.id;
    const order = db.prepare(`SELECT payment_status FROM orders WHERE id = ?`).get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.json({ message: 'Already paid' });
    
    const items = db.prepare(`SELECT product_id, quantity FROM order_items WHERE order_id = ?`).all(orderId);
    // Reduce stock
    for (let it of items) {
        const prod = db.prepare(`SELECT stock FROM products WHERE id = ?`).get(it.product_id);
        if (prod.stock < it.quantity) {
            return res.status(400).json({ error: 'Stock insufficient' });
        }
        db.prepare(`UPDATE products SET stock = stock - ? WHERE id = ?`).run(it.quantity, it.product_id);
    }
    db.prepare(`UPDATE orders SET payment_status = 'paid', order_status = 'confirmed' WHERE id = ?`).run(orderId);
    res.json({ success: true });
});

app.put('/api/admin/orders/:id/deliver', isAdmin, (req, res) => {
    db.prepare(`UPDATE orders SET order_status = 'delivered' WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
});

// Health check for Render
app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

app.get('/admin-page', (req, res) => {
    if (req.session && req.session.admin) {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } else {
        res.send(`<html><body><h2>Admin Login</h2><form id="login"><input type="password" id="pwd" placeholder="Password"><button type="submit">Login</button></form><p>Default password: admin123</p><script>document.getElementById('login').onsubmit=async(e)=>{e.preventDefault();let r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pwd').value})});if(r.ok)location.reload();else alert('Wrong password');};<\/script></body></html>`);
    }
});

app.listen(PORT, HOST, () => {
    console.log(`✅ Veggie Shop running on http://${HOST}:${PORT}`);
    console.log(`👉 Admin panel: http://${HOST}:${PORT}/admin-page (password: admin123)`);
});

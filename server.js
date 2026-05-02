const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const session = require('express-session');
const QRCode = require('qrcode');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: 'dadveggie123', resave: false, saveUninitialized: true, cookie: { secure: false } }));

const db = new sqlite3.Database('./vegetable_shop.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        image_url TEXT,
        category TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_address TEXT NOT NULL,
        total_amount REAL NOT NULL,
        payment_status TEXT DEFAULT 'pending',
        order_status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        product_id INTEGER,
        quantity INTEGER,
        price REAL,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )`);

    // Insert sample vegetables if none exist
    db.get(`SELECT COUNT(*) as count FROM products`, (err, row) => {
        if (row.count === 0) {
            const veggies = [
                ['Tomato', 'Fresh red tomatoes', 40, 50, 'https://cdn.pixabay.com/photo/2020/06/01/13/55/tomatoes-5247827_640.jpg', 'Vegetable'],
                ['Potato', 'Farm potatoes', 30, 100, 'https://cdn.pixabay.com/photo/2016/08/11/08/04/potatoes-1585075_640.jpg', 'Root'],
                ['Onion', 'Red onion', 35, 80, 'https://cdn.pixabay.com/photo/2020/07/15/20/38/onion-5409359_640.jpg', 'Vegetable'],
                ['Carrot', 'Organic carrots', 45, 60, 'https://cdn.pixabay.com/photo/2017/06/23/06/04/carrots-2433439_640.jpg', 'Root'],
                ['Spinach', 'Fresh spinach bunch', 25, 30, 'https://cdn.pixabay.com/photo/2016/03/26/16/44/spinach-1280831_640.jpg', 'Leafy'],
                ['Cucumber', 'Crisp cucumber', 35, 45, 'https://cdn.pixabay.com/photo/2016/07/24/17/33/cucumber-1538652_640.jpg', 'Vegetable']
            ];
            const stmt = db.prepare(`INSERT INTO products (name, description, price, stock, image_url, category) VALUES (?,?,?,?,?,?)`);
            veggies.forEach(v => stmt.run(v));
            stmt.finalize();
        }
    });
});

function isAdmin(req, res, next) {
    if (req.session && req.session.admin) return next();
    else return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/products', (req, res) => {
    db.all(`SELECT id, name, price, stock, image_url FROM products`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ products: rows });
    });
});

app.post('/api/orders', async (req, res) => {
    const { customerName, customerPhone, customerAddress, items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items' });
    for (let item of items) {
        const prod = await new Promise(resolve => db.get(`SELECT stock FROM products WHERE id = ?`, [item.productId], (err, row) => resolve(row)));
        if (!prod || prod.stock < item.quantity) return res.status(400).json({ error: `Insufficient stock for product ID ${item.productId}` });
    }
    let total = items.reduce((s, i) => s + i.price * i.quantity, 0);
    db.run(`INSERT INTO orders (customer_name, customer_phone, customer_address, total_amount) VALUES (?,?,?,?)`,
        [customerName, customerPhone, customerAddress, total], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const orderId = this.lastID;
            const stmt = db.prepare(`INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?,?,?,?)`);
            items.forEach(it => stmt.run(orderId, it.productId, it.quantity, it.price));
            stmt.finalize();
            const UPI_ID = "dadveggieshop@okhdfcbank"; // CHANGE THIS TO YOUR DAD'S UPI ID
            const upiUrl = `upi://pay?pa=${UPI_ID}&pn=Dad%20Veg%20Shop&am=${total}&cu=INR&tn=Order%20${orderId}`;
            QRCode.toDataURL(upiUrl, (err, qrDataUrl) => {
                if (err) return res.json({ orderId, totalAmount: total, qrCodeDataURL: null });
                res.json({ orderId, totalAmount: total, qrCodeDataURL: qrDataUrl });
            });
        });
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === 'admin123') { // CHANGE THIS PASSWORD
        req.session.admin = true;
        return res.json({ success: true });
    }
    res.status(401).json({ error: 'Wrong password' });
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/admin/products', isAdmin, (req, res) => {
    db.all(`SELECT * FROM products`, (err, rows) => { if (err) return res.status(500).json({ error: err.message }); res.json(rows); });
});

app.post('/api/admin/products', isAdmin, (req, res) => {
    const { name, description, price, stock, image_url, category } = req.body;
    db.run(`INSERT INTO products (name, description, price, stock, image_url, category) VALUES (?,?,?,?,?,?)`,
        [name, description, price, stock, image_url || '', category], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        });
});

app.put('/api/admin/products/:id', isAdmin, (req, res) => {
    const { name, description, price, stock, image_url, category } = req.body;
    db.run(`UPDATE products SET name=?, description=?, price=?, stock=?, image_url=?, category=? WHERE id=?`,
        [name, description, price, stock, image_url, category, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ updated: true });
        });
});

app.delete('/api/admin/products/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM products WHERE id=?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: true });
    });
});

app.get('/api/admin/orders', isAdmin, (req, res) => {
    db.all(`SELECT o.*, (SELECT json_group_array(json_object('product_id', oi.product_id, 'quantity', oi.quantity, 'price', oi.price)) FROM order_items oi WHERE oi.order_id = o.id) as items FROM orders o ORDER BY o.id DESC`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.put('/api/admin/orders/:id/pay', isAdmin, (req, res) => {
    const orderId = req.params.id;
    db.get(`SELECT payment_status FROM orders WHERE id = ?`, [orderId], (err, order) => {
        if (err || !order) return res.status(404).json({ error: 'Order not found' });
        if (order.payment_status === 'paid') return res.json({ message: 'Already paid' });
        db.all(`SELECT product_id, quantity FROM order_items WHERE order_id = ?`, [orderId], (err, items) => {
            if (err) return res.status(500).json({ error: err.message });
            let insufficient = false;
            const updates = items.map(it => new Promise((resolve) => {
                db.run(`UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`, [it.quantity, it.product_id, it.quantity], function(err) {
                    if (err || this.changes === 0) insufficient = true;
                    resolve();
                });
            }));
            Promise.all(updates).then(() => {
                if (insufficient) return res.status(400).json({ error: 'Stock insufficient' });
                db.run(`UPDATE orders SET payment_status = 'paid', order_status = 'confirmed' WHERE id = ?`, [orderId], (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true });
                });
            });
        });
    });
});

app.put('/api/admin/orders/:id/deliver', isAdmin, (req, res) => {
    db.run(`UPDATE orders SET order_status = 'delivered' WHERE id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/admin-page', (req, res) => {
    if (req.session && req.session.admin) {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } else {
        res.send(`<html><body><h2>Admin Login</h2><form id="login"><input type="password" id="pwd" placeholder="Password"><button type="submit">Login</button></form><p>Default password: admin123</p><script>document.getElementById('login').onsubmit=async(e)=>{e.preventDefault();let r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pwd').value})});if(r.ok)location.reload();else alert('Wrong password');};<\/script></body></html>`);
    }
});

const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`✅ Veggie Shop running on http://${HOST}:${PORT}`);
    console.log(`👉 Admin panel: http://${HOST}:${PORT}/admin-page (password: admin123)`);
});

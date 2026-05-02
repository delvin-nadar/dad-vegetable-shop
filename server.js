const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const session = require('express-session');
const QRCode = require('qrcode');
const bodyParser = require('body-parser');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: 'dadveggie123', resave: false, saveUninitialized: true, cookie: { secure: false } }));

// ==================== NOTIFICATION FUNCTIONS ====================

// WhatsApp notification function (using callmebot - free service)
async function sendWhatsAppNotification(phone, message) {
    // Callmebot setup:
    // 1. Save +34 644 78 97 39 in your phone as "Callmebot"
    // 2. Send "I allow callmebot to send me messages" to that number
    // 3. Get your API key from callmebot.com
    const apiKey = 'YOUR_CALLMEBOT_API_KEY'; // Replace with your actual API key
    const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
    try {
        await axios.get(url);
        console.log(`✅ WhatsApp notification sent to ${phone}`);
    } catch(e) { 
        console.log('WhatsApp notify failed:', e.message);
    }
}

// Telegram notification function (completely free & reliable)
async function sendTelegramNotification(chatId, message) {
    // Setup: Create a bot via @BotFather on Telegram
    // Get your bot token and chat ID
    const botToken = 'YOUR_BOT_TOKEN'; // Replace with your bot token
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    try {
        await axios.post(url, { chat_id: chatId, text: message });
        console.log(`✅ Telegram notification sent to ${chatId}`);
    } catch(e) { 
        console.log('Telegram notify failed:', e.message);
    }
}

// Unified function for customer notifications
async function notifyCustomer(phone, message) {
    // Choose one method or both:
    await sendWhatsAppNotification(phone, message);
    // await sendTelegramNotification(phone, message);
}

// ==================== IMAGE UPLOAD ====================

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No image file' });
        const formData = new FormData();
        formData.append('image', req.file.buffer.toString('base64'));
        
        const response = await axios.post('https://api.imgur.com/3/image', formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': 'Client-ID YOUR_IMGUR_CLIENT_ID'
            }
        });
        
        res.json({ success: true, url: response.data.data.link });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Upload failed' });
    }
});

// ==================== DATABASE SETUP ====================

// Open database (creates file if not exists)
const db = new Database('./vegetable_shop.db');

// Create tables and add columns if missing
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

// Add missing columns safely
try { db.exec(`ALTER TABLE products ADD COLUMN unit TEXT DEFAULT 'kg';`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN delivery_slot TEXT;`); } catch (e) {}

// Insert sample vegetables if none exist
const row = db.prepare('SELECT COUNT(*) as count FROM products').get();
if (row.count === 0) {
    const veggies = [
        ['Tomato', 'Fresh red tomatoes', 40, 50, 'https://cdn.pixabay.com/photo/2020/06/01/13/55/tomatoes-5247827_640.jpg', 'Vegetables', 'kg'],
        ['Potato', 'Farm potatoes', 30, 100, 'https://cdn.pixabay.com/photo/2016/08/11/08/04/potatoes-1585075_640.jpg', 'Vegetables', 'kg'],
        ['Onion', 'Red onion', 35, 80, 'https://cdn.pixabay.com/photo/2020/07/15/20/38/onion-5409359_640.jpg', 'Vegetables', 'kg'],
        ['Carrot', 'Organic carrots', 45, 60, 'https://cdn.pixabay.com/photo/2017/06/23/06/04/carrots-2433439_640.jpg', 'Vegetables', 'kg'],
        ['Spinach', 'Fresh spinach bunch', 25, 30, 'https://cdn.pixabay.com/photo/2016/03/26/16/44/spinach-1280831_640.jpg', 'Vegetables', 'bunch'],
        ['Cucumber', 'Crisp cucumber', 35, 45, 'https://cdn.pixabay.com/photo/2016/07/24/17/33/cucumber-1538652_640.jpg', 'Vegetables', 'piece']
    ];
    const insert = db.prepare(`INSERT INTO products (name, description, price, stock, image_url, category, unit) VALUES (?,?,?,?,?,?,?)`);
    for (const v of veggies) insert.run(v);
}

// ==================== MIDDLEWARE ====================

function isAdmin(req, res, next) {
    if (req.session && req.session.admin) return next();
    else return res.status(401).json({ error: 'Unauthorized' });
}

// ==================== CUSTOMER API ENDPOINTS ====================

app.get('/api/products', (req, res) => {
    const rows = db.prepare(`SELECT id, name, price, stock, image_url, category, unit FROM products`).all();
    res.json({ products: rows });
});

app.post('/api/orders', async (req, res) => {
    const { customerName, customerPhone, customerAddress, items, deliverySlot, totalAmount } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items' });
    
    // Check stock
    for (let item of items) {
        const prod = db.prepare(`SELECT stock FROM products WHERE id = ?`).get(item.productId);
        if (!prod || prod.stock < item.quantity) {
            return res.status(400).json({ error: `Insufficient stock for product ID ${item.productId}` });
        }
    }
    
    const total = totalAmount || items.reduce((s, i) => s + i.price * i.quantity, 0);
    const insertOrder = db.prepare(`INSERT INTO orders (customer_name, customer_phone, customer_address, total_amount, delivery_slot) VALUES (?,?,?,?,?)`);
    const result = insertOrder.run(customerName, customerPhone, customerAddress, total, deliverySlot || null);
    const orderId = result.lastInsertRowid;
    
    const insertItem = db.prepare(`INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?,?,?,?)`);
    for (let it of items) {
        insertItem.run(orderId, it.productId, it.quantity, it.price);
    }
    
    // ✅ Send WhatsApp notification to admin about new order
    const adminPhone = "9029186608"; // Your dad's phone number
    const orderMessage = `🆕 New Order #${orderId}\nCustomer: ${customerName}\nPhone: ${customerPhone}\nTotal: ₹${total}\nSlot: ${deliverySlot || 'Not selected'}`;
    await sendWhatsAppNotification(adminPhone, orderMessage);
    
    const UPI_ID = "9029186608@okbizaxis"; // CHANGE TO YOUR DAD'S UPI ID
    const upiUrl = `upi://pay?pa=${UPI_ID}&pn=Dad%20Veg%20Shop&am=${total}&cu=INR&tn=Order%20${orderId}`;
    QRCode.toDataURL(upiUrl, (err, qrDataUrl) => {
        if (err) return res.json({ orderId, totalAmount: total, qrCodeDataURL: null, upiIntentUrl: upiUrl });
        res.json({ orderId, totalAmount: total, qrCodeDataURL: qrDataUrl, upiIntentUrl: upiUrl });
    });
});

// Order tracking endpoint
app.get('/api/order/:id/:phone', (req, res) => {
    const order = db.prepare(`SELECT id, order_status, payment_status, total_amount, delivery_slot FROM orders WHERE id = ? AND customer_phone = ?`).get(req.params.id, req.params.phone);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
});

// ==================== ADMIN API ENDPOINTS ====================

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === 'Pass@6073') {
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
    const { name, description, price, stock, image_url, category, unit } = req.body;
    const insert = db.prepare(`INSERT INTO products (name, description, price, stock, image_url, category, unit) VALUES (?,?,?,?,?,?,?)`);
    const result = insert.run(name, description, price, stock, image_url || '', category, unit || 'kg');
    res.json({ id: result.lastInsertRowid });
});

app.put('/api/admin/products/:id', isAdmin, (req, res) => {
    const { name, description, price, stock, image_url, category, unit } = req.body;
    const update = db.prepare(`UPDATE products SET name=?, description=?, price=?, stock=?, image_url=?, category=?, unit=? WHERE id=?`);
    update.run(name, description, price, stock, image_url, category, unit || 'kg', req.params.id);
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

// ✅ Updated payment confirmation with customer notification
app.put('/api/admin/orders/:id/pay', isAdmin, async (req, res) => {
    const orderId = req.params.id;
    const order = db.prepare(`SELECT payment_status, customer_name, customer_phone FROM orders WHERE id = ?`).get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.json({ message: 'Already paid' });
    
    const items = db.prepare(`SELECT product_id, quantity FROM order_items WHERE order_id = ?`).all(orderId);
    for (let it of items) {
        const prod = db.prepare(`SELECT stock FROM products WHERE id = ?`).get(it.product_id);
        if (prod.stock < it.quantity) {
            return res.status(400).json({ error: 'Stock insufficient' });
        }
        db.prepare(`UPDATE products SET stock = stock - ? WHERE id = ?`).run(it.quantity, it.product_id);
    }
    db.prepare(`UPDATE orders SET payment_status = 'paid', order_status = 'confirmed' WHERE id = ?`).run(orderId);
    
    // ✅ Notify customer - Payment confirmed
    await notifyCustomer(order.customer_phone, `✅ Payment received for Order #${orderId}. Your order is confirmed and will be prepared soon. - Dad's Veggie Shop`);
    
    res.json({ success: true });
});

// ✅ Updated delivery status with customer notification
app.put('/api/admin/orders/:id/deliver', isAdmin, async (req, res) => {
    const order = db.prepare(`SELECT customer_name, customer_phone FROM orders WHERE id = ?`).get(req.params.id);
    db.prepare(`UPDATE orders SET order_status = 'delivered' WHERE id = ?`).run(req.params.id);
    
    // ✅ Notify customer - Order delivered
    await notifyCustomer(order.customer_phone, `🚚 Order #${req.params.id} has been delivered! Thank you for shopping with Dad's Veggie Shop. Enjoy your fresh vegetables! 🥬`);
    
    res.json({ success: true });
});

// ==================== HEALTH & PAGE ROUTES ====================

app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

app.get('/admin-page', (req, res) => {
    if (req.session && req.session.admin) {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } else {
        res.send(`<html><body><h2>Admin Login</h2><form id="login"><input type="password" id="pwd" placeholder="Password"><button type="submit">Login</button></form><script>document.getElementById('login').onsubmit=async(e)=>{e.preventDefault();let r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pwd').value})});if(r.ok)location.reload();else alert('Wrong password');};<\/script></body></html>`);
    }
});

app.listen(PORT, HOST, () => {
    console.log(`✅ Veggie Shop running on http://${HOST}:${PORT}`);
    console.log(`👉 Admin panel: http://${HOST}:${PORT}/admin-page (password: Pass@6073)`);
});
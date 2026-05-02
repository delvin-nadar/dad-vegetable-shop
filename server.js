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

// ==================== GOOGLE SHEETS INTEGRATION ====================
const GOOGLE_SHEETS_WEBHOOK = 'https://script.google.com/macros/s/AKfycbzeQ_XWvNtpcbcjIS3nMIQf6UJ9_uLSdzgF9U5y_wWnaIe3E9FCjEghUyPVWQP3IUDU/exec';

async function addToGoogleSheets(customerData) {
    try {
        await axios.post(GOOGLE_SHEETS_WEBHOOK, customerData, {
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('✅ Customer data saved to Google Sheets');
    } catch (e) {
        console.log('Google Sheets save failed:', e.message);
    }
}

// ==================== WHATSAPP NOTIFICATION FUNCTIONS ====================

async function sendWhatsAppMessage(phone, message) {
    // Callmebot setup (free)
    // 1. Save +34 644 78 97 39 in your phone as "Callmebot"
    // 2. Send "I allow callmebot to send me messages" to that number
    // 3. Get your API key from callmebot.com
    const apiKey = 'YOUR_CALLMEBOT_API_KEY'; // Replace with your API key
    const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
    try {
        await axios.get(url);
        console.log(`✅ WhatsApp sent to ${phone}`);
        return true;
    } catch(e) { 
        console.log('WhatsApp failed:', e.message);
        return false;
    }
}

// ==================== TELEGRAM NOTIFICATION ====================
// Bot: @VegFresh_bot | Token obtained from @BotFather
const TELEGRAM_BOT_TOKEN = '8790686895:AAHc_g8wqH6nHajgt2RSuTaDXcPRRdjoX84';
const TELEGRAM_CHAT_ID = '853947915'; // Your Telegram chat ID from @userinfobot

async function sendTelegramAlert(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('✅ Telegram alert sent');
    } catch (e) {
        console.log('Telegram alert failed:', e.message);
    }
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

const db = new Database('./vegetable_shop.db');

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
        weight TEXT,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    );
`);

// Add missing columns safely
try { db.exec(`ALTER TABLE products ADD COLUMN unit TEXT DEFAULT 'kg';`); } catch (e) {}
try { db.exec(`ALTER TABLE products ADD COLUMN weight_options TEXT DEFAULT '1kg';`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN delivery_slot TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE order_items ADD COLUMN weight TEXT;`); } catch (e) {}

// Insert sample vegetables if none exist
const row = db.prepare('SELECT COUNT(*) as count FROM products').get();
if (row.count === 0) {
    const veggies = [
        ['Tomato', 'Fresh red tomatoes', 40, 100, 'https://cdn.pixabay.com/photo/2020/06/01/13/55/tomatoes-5247827_640.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
        ['Potato', 'Farm potatoes', 30, 100, 'https://cdn.pixabay.com/photo/2016/08/11/08/04/potatoes-1585075_640.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
        ['Onion', 'Red onion', 35, 100, 'https://cdn.pixabay.com/photo/2020/07/15/20/38/onion-5409359_640.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
        ['Carrot', 'Organic carrots', 45, 100, 'https://cdn.pixabay.com/photo/2017/06/23/06/04/carrots-2433439_640.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
        ['Spinach', 'Fresh spinach bunch', 25, 100, 'https://cdn.pixabay.com/photo/2016/03/26/16/44/spinach-1280831_640.jpg', 'Vegetables', 'bunch', '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15'],
        ['Cucumber', 'Crisp cucumber', 35, 100, 'https://cdn.pixabay.com/photo/2016/07/24/17/33/cucumber-1538652_640.jpg', 'Vegetables', 'piece', '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15']
    ];
    const insert = db.prepare(`INSERT INTO products (name, description, price, stock, image_url, category, unit, weight_options) VALUES (?,?,?,?,?,?,?,?)`);
    for (const v of veggies) insert.run(v);
}

function isAdmin(req, res, next) {
    if (req.session && req.session.admin) return next();
    else return res.status(401).json({ error: 'Unauthorized' });
}

// ==================== CUSTOMER API ENDPOINTS ====================

app.get('/api/products', (req, res) => {
    const rows = db.prepare(`SELECT id, name, price, image_url, category, unit, weight_options FROM products`).all();
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
    
    const insertItem = db.prepare(`INSERT INTO order_items (order_id, product_id, quantity, price, weight) VALUES (?,?,?,?,?)`);
    for (let it of items) {
        insertItem.run(orderId, it.productId, it.quantity, it.price, it.weight || null);
    }
    
    // Save customer to Google Sheets
    await addToGoogleSheets({
        orderId,
        name: customerName,
        phone: customerPhone,
        address: customerAddress,
        total,
        slot: deliverySlot,
        date: new Date().toISOString()
    });
    
    // Send WhatsApp to admin
    const adminPhone = "919029186608";
    const orderMessage = `🆕 New Order #${orderId}\nCustomer: ${customerName}\nPhone: ${customerPhone}\nTotal: ₹${total}\nSlot: ${deliverySlot || 'Not selected'}`;
    await sendWhatsAppMessage(adminPhone, orderMessage);
    
    // Send Telegram alert for new order
    const telegramMessage = `🆕 <b>NEW ORDER #${orderId}</b>\n\nCustomer: ${customerName}\nPhone: ${customerPhone}\nTotal: ₹${total}\nSlot: ${deliverySlot || 'Not selected'}\n\n🔗 Admin Panel: ${req.protocol}://${req.get('host')}/admin-page`;
    await sendTelegramAlert(telegramMessage);
    
    const UPI_ID = "9029186608@okbizaxis";
    const upiUrl = `upi://pay?pa=${UPI_ID}&pn=Dad%20Veg%20Shop&am=${total}&cu=INR&tn=Order%20${orderId}`;
    QRCode.toDataURL(upiUrl, (err, qrDataUrl) => {
        if (err) return res.json({ orderId, totalAmount: total, qrCodeDataURL: null, upiIntentUrl: upiUrl });
        res.json({ orderId, totalAmount: total, qrCodeDataURL: qrDataUrl, upiIntentUrl: upiUrl });
    });
});

// Track orders by phone only (returns all orders for that phone)
app.get('/api/orders/:phone', (req, res) => {
    const orders = db.prepare(`SELECT id, order_status, payment_status, total_amount, delivery_slot, created_at FROM orders WHERE customer_phone = ? ORDER BY id DESC`).all(req.params.phone);
    if (!orders || orders.length === 0) return res.status(404).json({ error: 'No orders found for this number' });
    res.json(orders);
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
    const { name, description, price, stock, image_url, category, unit, weight_options } = req.body;
    const insert = db.prepare(`INSERT INTO products (name, description, price, stock, image_url, category, unit, weight_options) VALUES (?,?,?,?,?,?,?,?)`);
    const result = insert.run(name, description, price, stock, image_url || '', category, unit || 'kg', weight_options || '1kg');
    res.json({ id: result.lastInsertRowid });
});

app.put('/api/admin/products/:id', isAdmin, (req, res) => {
    const { name, description, price, stock, image_url, category, unit, weight_options } = req.body;
    const update = db.prepare(`UPDATE products SET name=?, description=?, price=?, stock=?, image_url=?, category=?, unit=?, weight_options=? WHERE id=?`);
    update.run(name, description, price, stock, image_url, category, unit || 'kg', weight_options || '1kg', req.params.id);
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
        const items = db.prepare(`SELECT product_id, quantity, price, weight FROM order_items WHERE order_id = ?`).all(order.id);
        order.items = items;
    }
    res.json(orders);
});

// Confirm payment and send WhatsApp - Order Confirmed
app.put('/api/admin/orders/:id/pay', isAdmin, async (req, res) => {
    const orderId = req.params.id;
    const order = db.prepare(`SELECT payment_status, customer_name, customer_phone, total_amount FROM orders WHERE id = ?`).get(orderId);
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
    
    // Send WhatsApp - Order Confirmed to customer
    await sendWhatsAppMessage(order.customer_phone, `✅ Order #${orderId} CONFIRMED!\nAmount: ₹${order.total_amount}\nYour order will be prepared and dispatched soon. - Dad's Veggie Shop`);
    
    // Send Telegram alert for payment confirmation
    await sendTelegramAlert(`✅ <b>PAYMENT CONFIRMED</b>\nOrder #${orderId}\nCustomer: ${order.customer_name}\nAmount: ₹${order.total_amount}`);
    
    res.json({ success: true });
});

// Mark as dispatched and send WhatsApp
app.put('/api/admin/orders/:id/dispatch', isAdmin, async (req, res) => {
    const order = db.prepare(`SELECT customer_name, customer_phone, total_amount FROM orders WHERE id = ?`).get(req.params.id);
    db.prepare(`UPDATE orders SET order_status = 'dispatched' WHERE id = ?`).run(req.params.id);
    
    await sendWhatsAppMessage(order.customer_phone, `🚚 Order #${req.params.id} DISPATCHED!\nTotal: ₹${order.total_amount}\nYour order is on the way! - Dad's Veggie Shop`);
    
    // Send Telegram alert for dispatch
    await sendTelegramAlert(`🚚 <b>ORDER DISPATCHED</b>\nOrder #${req.params.id}\nCustomer: ${order.customer_name}\nAmount: ₹${order.total_amount}`);
    
    res.json({ success: true });
});

// Mark as delivered and send WhatsApp
app.put('/api/admin/orders/:id/deliver', isAdmin, async (req, res) => {
    const order = db.prepare(`SELECT customer_name, customer_phone, total_amount FROM orders WHERE id = ?`).get(req.params.id);
    db.prepare(`UPDATE orders SET order_status = 'delivered' WHERE id = ?`).run(req.params.id);
    
    await sendWhatsAppMessage(order.customer_phone, `🎉 Order #${req.params.id} DELIVERED!\nTotal: ₹${order.total_amount}\nThank you for shopping with Dad's Veggie Shop! 🥬`);
    
    // Send Telegram alert for delivery
    await sendTelegramAlert(`🎉 <b>ORDER DELIVERED</b>\nOrder #${req.params.id}\nCustomer: ${order.customer_name}\nAmount: ₹${order.total_amount}`);
    
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
    console.log(`🤖 Telegram bot @VegFresh_bot is ready for notifications`);
});
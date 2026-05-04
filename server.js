const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const session = require('express-session');
const QRCode = require('qrcode');
const bodyParser = require('body-parser');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const axios = require('axios');
const FormData = require('form-data');
const csv = require('csv-parser');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ==================== SECURE ADMIN PASSWORD ====================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
    console.error('❌ FATAL ERROR: ADMIN_PASSWORD environment variable is not set!');
    console.error('👉 Please set ADMIN_PASSWORD in Render dashboard -> Environment Variables');
    process.exit(1);
}

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/product_images', express.static(path.join(__dirname, 'public', 'product_images')));
app.use(session({ secret: 'dadveggie123', resave: false, saveUninitialized: true, cookie: { secure: false } }));

// Create uploads directory
const uploadsDir = path.join(__dirname, 'public', 'product_images');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// ==================== DATABASE SETUP ====================
const db = new sqlite3.Database('./vegetable_shop.db');

// Helper: Promisify db functions
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID });
        });
    });
}

// Initialize database
db.serialize(() => {
    // Create products table
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        image_url TEXT,
        category TEXT,
        unit TEXT DEFAULT 'kg',
        weight_options TEXT DEFAULT '1kg'
    )`);

    // Create orders table
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_address TEXT NOT NULL,
        total_amount REAL NOT NULL,
        payment_status TEXT DEFAULT 'pending',
        order_status TEXT DEFAULT 'pending',
        delivery_slot TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create order_items table
    db.run(`CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        product_id INTEGER,
        quantity INTEGER,
        price REAL,
        weight TEXT,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )`);

    // Insert sample products if none exist
    db.get(`SELECT COUNT(*) as count FROM products`, (err, row) => {
        if (err) {
            console.error('Error checking products:', err.message);
            return;
        }
        
        if (row.count === 0) {
            console.log('📦 Inserting sample products...');
            const veggies = [
                ['Tomato', 'Fresh red tomatoes', 40, 100, 'https://cdn.pixabay.com/photo/2020/06/01/13/55/tomatoes-5247827_640.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
                ['Potato', 'Farm potatoes', 30, 100, 'https://cdn.pixabay.com/photo/2016/08/11/08/04/potatoes-1585075_640.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
                ['Onion', 'Red onion', 35, 100, 'https://cdn.pixabay.com/photo/2020/07/15/20/38/onion-5409359_640.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
                ['Carrot', 'Organic carrots', 45, 100, 'https://cdn.pixabay.com/photo/2017/06/23/06/04/carrots-2433439_640.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
                ['Spinach', 'Fresh spinach bunch', 25, 100, 'https://cdn.pixabay.com/photo/2016/03/26/16/44/spinach-1280831_640.jpg', 'Vegetables', 'bunch', '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15'],
                ['Cucumber', 'Crisp cucumber', 35, 100, 'https://cdn.pixabay.com/photo/2016/07/24/17/33/cucumber-1538652_640.jpg', 'Vegetables', 'piece', '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15']
            ];
            
            const stmt = db.prepare(`INSERT INTO products (name, description, price, stock, image_url, category, unit, weight_options) VALUES (?,?,?,?,?,?,?,?)`);
            for (const v of veggies) {
                stmt.run(v, (err) => {
                    if (err) console.error('Error inserting:', err.message);
                });
            }
            stmt.finalize();
            console.log('✅ Sample products inserted.');
        } else {
            console.log(`📊 Existing database found: ${row.count} products.`);
        }
    });
});

function isAdmin(req, res, next) {
    if (req.session && req.session.admin) return next();
    else return res.status(401).json({ error: 'Unauthorized' });
}

// ==================== CUSTOMER API ENDPOINTS ====================
app.get('/api/products', async (req, res) => {
    try {
        const rows = await dbAll(`SELECT id, name, price, stock, image_url, category, unit, weight_options FROM products`);
        res.json({ products: rows });
    } catch (err) {
        console.error('Error fetching products:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/orders', async (req, res) => {
    const { customerName, customerPhone, customerAddress, items, deliverySlot, totalAmount } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items' });
    
    try {
        // Check stock
        for (let item of items) {
            const prod = await dbGet(`SELECT stock FROM products WHERE id = ?`, [item.productId]);
            if (!prod || prod.stock < item.quantity) {
                return res.status(400).json({ error: `Insufficient stock for product ID ${item.productId}` });
            }
        }
        
        const total = totalAmount || items.reduce((s, i) => s + i.price * i.quantity, 0);
        const orderResult = await dbRun(
            `INSERT INTO orders (customer_name, customer_phone, customer_address, total_amount, delivery_slot) VALUES (?,?,?,?,?)`,
            [customerName, customerPhone, customerAddress, total, deliverySlot || null]
        );
        const orderId = orderResult.lastID;
        
        const insertItem = db.prepare(`INSERT INTO order_items (order_id, product_id, quantity, price, weight) VALUES (?,?,?,?,?)`);
        for (let it of items) {
            insertItem.run(orderId, it.productId, it.quantity, it.price, it.weight || null);
        }
        insertItem.finalize();
        
        const UPI_ID = "9029186608@okbizaxis";
        const upiUrl = `upi://pay?pa=${UPI_ID}&pn=Dad%20Veg%20Shop&am=${total}&cu=INR&tn=Order%20${orderId}`;
        QRCode.toDataURL(upiUrl, (err, qrDataUrl) => {
            if (err) return res.json({ orderId, totalAmount: total, qrCodeDataURL: null, upiIntentUrl: upiUrl });
            res.json({ orderId, totalAmount: total, qrCodeDataURL: qrDataUrl, upiIntentUrl: upiUrl });
        });
    } catch (err) {
        console.error('Order error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/orders/:phone', async (req, res) => {
    try {
        const orders = await dbAll(
            `SELECT id, order_status, payment_status, total_amount, delivery_slot, created_at FROM orders WHERE customer_phone = ? ORDER BY id DESC`,
            [req.params.phone]
        );
        if (!orders || orders.length === 0) return res.status(404).json({ error: 'No orders found for this number' });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== ADMIN API ENDPOINTS ====================
app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        req.session.admin = true;
        return res.json({ success: true });
    }
    res.status(401).json({ error: 'Wrong password' });
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/admin/products', isAdmin, async (req, res) => {
    try {
        const rows = await dbAll(`SELECT * FROM products`);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/products', isAdmin, async (req, res) => {
    const { name, description, price, stock, image_url, category, unit, weight_options } = req.body;
    try {
        const result = await dbRun(
            `INSERT INTO products (name, description, price, stock, image_url, category, unit, weight_options) VALUES (?,?,?,?,?,?,?,?)`,
            [name, description || '', price, stock, image_url || '', category || 'Vegetables', unit || 'kg', weight_options || '250g,500g,1kg']
        );
        res.json({ id: result.lastID });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/products/:id', isAdmin, async (req, res) => {
    const { name, description, price, stock, image_url, category, unit, weight_options } = req.body;
    try {
        await dbRun(
            `UPDATE products SET name=?, description=?, price=?, stock=?, image_url=?, category=?, unit=?, weight_options=? WHERE id=?`,
            [name, description || '', price, stock, image_url || '', category || 'Vegetables', unit || 'kg', weight_options || '250g,500g,1kg', req.params.id]
        );
        res.json({ updated: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/products/:id', isAdmin, async (req, res) => {
    try {
        await dbRun(`DELETE FROM products WHERE id=?`, [req.params.id]);
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/orders', isAdmin, async (req, res) => {
    try {
        const orders = await dbAll(`SELECT * FROM orders ORDER BY id DESC`);
        for (let order of orders) {
            const items = await dbAll(`SELECT product_id, quantity, price, weight FROM order_items WHERE order_id = ?`, [order.id]);
            order.items = items;
        }
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/orders/:id/pay', isAdmin, async (req, res) => {
    const orderId = req.params.id;
    try {
        const order = await dbGet(`SELECT payment_status, customer_phone, total_amount FROM orders WHERE id = ?`, [orderId]);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.payment_status === 'paid') return res.json({ message: 'Already paid' });
        
        const items = await dbAll(`SELECT product_id, quantity FROM order_items WHERE order_id = ?`, [orderId]);
        for (let it of items) {
            const prod = await dbGet(`SELECT stock FROM products WHERE id = ?`, [it.product_id]);
            if (prod.stock < it.quantity) return res.status(400).json({ error: 'Stock insufficient' });
            await dbRun(`UPDATE products SET stock = stock - ? WHERE id = ?`, [it.quantity, it.product_id]);
        }
        await dbRun(`UPDATE orders SET payment_status = 'paid', order_status = 'confirmed' WHERE id = ?`, [orderId]);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/orders/:id/dispatch', isAdmin, async (req, res) => {
    try {
        await dbRun(`UPDATE orders SET order_status = 'dispatched' WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/orders/:id/deliver', isAdmin, async (req, res) => {
    try {
        await dbRun(`UPDATE orders SET order_status = 'delivered' WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== BULK PRODUCT UPLOAD ====================
app.get('/api/admin/products/template', isAdmin, (req, res) => {
    const templateHeaders = ['name', 'price', 'stock', 'unit', 'weight_options', 'category', 'image_url', 'description'];
    let csvContent = templateHeaders.join(',') + '\n';
    csvContent += 'Tomato,40,100,kg,"250g,500g,1kg",Vegetables,,Fresh red tomatoes\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="product_template.csv"');
    res.send(csvContent);
});

const csvUpload = multer({ dest: 'uploads/' });
app.post('/api/admin/products/bulk', isAdmin, csvUpload.single('csvFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });
        
        const results = [];
        await new Promise((resolve, reject) => {
            fs.createReadStream(req.file.path)
                .pipe(csv())
                .on('data', (data) => results.push(data))
                .on('end', resolve)
                .on('error', reject);
        });
        
        const insertedProducts = [];
        for (const row of results) {
            if (!row.name || !row.price || !row.stock) continue;
            
            const result = await dbRun(
                `INSERT INTO products (name, description, price, stock, image_url, category, unit, weight_options) VALUES (?,?,?,?,?,?,?,?)`,
                [row.name.trim(), row.description || '', parseFloat(row.price), parseInt(row.stock), row.image_url || '', row.category || 'Vegetables', row.unit || 'kg', row.weight_options || '250g,500g,1kg']
            );
            insertedProducts.push({ id: result.lastID, name: row.name });
        }
        
        fs.unlinkSync(req.file.path);
        res.json({ success: true, message: `${insertedProducts.length} products added`, inserted: insertedProducts });
    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Bulk upload failed: ' + error.message });
    }
});

// ==================== IMAGE UPLOAD ====================
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No image file' });
        const extension = req.file.originalname.split('.').pop();
        const filename = `${Date.now()}_upload.${extension}`;
        const localPath = `/product_images/${filename}`;
        const filePath = path.join(__dirname, 'public', localPath);
        fs.writeFileSync(filePath, req.file.buffer);
        res.json({ success: true, url: localPath });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Upload failed' });
    }
});

// ==================== SET ONLINE IMAGES ====================
app.get('/api/set-online-images', isAdmin, async (req, res) => {
    const images = {
        1: 'https://cdn.pixabay.com/photo/2020/06/01/13/55/tomatoes-5247827_640.jpg',
        2: 'https://cdn.pixabay.com/photo/2016/08/11/08/04/potatoes-1585075_640.jpg',
        3: 'https://cdn.pixabay.com/photo/2020/07/15/20/38/onion-5409359_640.jpg',
        4: 'https://cdn.pixabay.com/photo/2017/06/23/06/04/carrots-2433439_640.jpg',
        5: 'https://cdn.pixabay.com/photo/2016/03/26/16/44/spinach-1280831_640.jpg',
        6: 'https://cdn.pixabay.com/photo/2016/07/24/17/33/cucumber-1538652_640.jpg'
    };
    
    for (const [id, url] of Object.entries(images)) {
        await dbRun(`UPDATE products SET image_url = ? WHERE id = ?`, [url, id]);
        console.log(`✅ Updated product ${id} with online image`);
    }
    
    res.json({ success: true, message: 'Online images set for all products!' });
});

// ==================== HEALTH & PAGE ROUTES ====================
app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

app.get('/admin-page', (req, res) => {
    if (req.session && req.session.admin) {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } else {
        res.send(`<html><body style="font-family:sans-serif;text-align:center;margin-top:100px"><h2>Admin Login</h2><form id="loginForm"><input type="password" id="pwd" placeholder="Enter password" /><button type="submit">Login</button></form><script>document.getElementById('loginForm').onsubmit=async(e)=>{e.preventDefault();const pwd=document.getElementById('pwd').value;const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});if(r.ok) location.reload();else alert('Wrong password');};<\/script></body></html>`);
    }
});

app.listen(PORT, HOST, () => {
    console.log(`✅ Veggie Shop running on http://${HOST}:${PORT}`);
    console.log(`👉 Admin panel: http://${HOST}:${PORT}/admin-page`);
});

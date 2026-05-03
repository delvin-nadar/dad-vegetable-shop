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
app.use(session({ secret: 'dadveggie123', resave: false, saveUninitialized: true, cookie: { secure: false } }));

// ==================== GOOGLE SHEETS INTEGRATION ====================
const GOOGLE_SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK || 'https://script.google.com/macros/s/AKfycbzeQ_XWvNtpcbcjIS3nMIQf6UJ9_uLSdzgF9U5y_wWnaIe3E9FCjEghUyPVWQP3IUDU/exec';

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
    const apiKey = process.env.CALLMEBOT_API_KEY || '';
    if (!apiKey) {
        console.log('⚠️ CallMeBot API key not configured');
        return false;
    }
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
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '853947915';

async function sendTelegramAlert(message) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.log('⚠️ Telegram bot token not configured.');
        return;
    }
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

// ==================== IMAGE HANDLING ====================
const uploadsDir = path.join(__dirname, 'public', 'product_images');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

async function saveImageLocally(imageUrl, productName) {
    try {
        const response = await axios({
            method: 'GET',
            url: imageUrl,
            responseType: 'stream',
            timeout: 10000
        });
        
        const extension = imageUrl.split('.').pop().split('?')[0];
        const safeName = productName.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const filename = `${Date.now()}_${safeName}.${extension === 'jpg' || extension === 'jpeg' || extension === 'png' ? extension : 'jpg'}`;
        const localPath = `/product_images/${filename}`;
        const filePath = path.join(__dirname, 'public', localPath);
        
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(localPath));
            writer.on('error', reject);
        });
    } catch (error) {
        console.log('Failed to save image locally:', error.message);
        return imageUrl;
    }
}

// ==================== SIMPLE PLACEHOLDER GENERATOR (NO CANVAS NEEDED) ====================
async function generatePlaceholderImage(productName) {
    const safeName = productName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const filename = `${Date.now()}_${safeName}.jpg`;
    const localPath = `/product_images/${filename}`;
    
    // Use placehold.co (free, no API key, no rate limits)
    const placeholderUrl = `https://placehold.co/400x300/2e7d32/white?text=${encodeURIComponent(productName)}`;
    
    try {
        const response = await axios({
            method: 'GET',
            url: placeholderUrl,
            responseType: 'stream',
            timeout: 10000
        });
        
        const filePath = path.join(__dirname, 'public', localPath);
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        return localPath;
    } catch (error) {
        console.log('Placeholder download failed, using URL:', error.message);
        return placeholderUrl;
    }
}

// ==================== AUTOMATIC IMAGE SEARCH ====================
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || '55691830-fab6eda5df88dbd0ea5299345';

app.get('/api/search-image/:query', async (req, res) => {
    const query = req.params.query;
    try {
        if (PIXABAY_API_KEY) {
            const response = await axios.get('https://pixabay.com/api/', {
                params: {
                    key: PIXABAY_API_KEY,
                    q: query,
                    image_type: 'photo',
                    per_page: 3,
                    safesearch: true
                }
            });
            
            if (response.data && response.data.hits && response.data.hits.length > 0) {
                let imageUrl = response.data.hits[0].webformatURL;
                const localImagePath = await saveImageLocally(imageUrl, query);
                
                res.json({
                    success: true,
                    imageUrl: localImagePath,
                    photographer: response.data.hits[0].user,
                    source: 'Pixabay (saved locally)'
                });
                return;
            }
        }
        res.json({ success: false, message: 'No image found' });
    } catch (error) {
        console.error('Image search error:', error.message);
        res.json({ success: false, message: 'API error: ' + error.message });
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

try { db.exec(`ALTER TABLE products ADD COLUMN unit TEXT DEFAULT 'kg';`); } catch (e) {}
try { db.exec(`ALTER TABLE products ADD COLUMN weight_options TEXT DEFAULT '1kg';`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN delivery_slot TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE order_items ADD COLUMN weight TEXT;`); } catch (e) {}

const productCount = db.prepare('SELECT COUNT(*) as count FROM products').get();
const orderCount = db.prepare('SELECT COUNT(*) as count FROM orders').get();

if (productCount.count === 0 && orderCount.count === 0) {
    console.log('📦 Fresh database detected. Inserting sample products...');
    const veggies = [
        ['Tomato', 'Fresh red tomatoes', 40, 100, '/product_images/tomato_sample.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
        ['Potato', 'Farm potatoes', 30, 100, '/product_images/potato_sample.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
        ['Onion', 'Red onion', 35, 100, '/product_images/onion_sample.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
        ['Carrot', 'Organic carrots', 45, 100, '/product_images/carrot_sample.jpg', 'Vegetables', 'kg', '250g,500g,1kg'],
        ['Spinach', 'Fresh spinach bunch', 25, 100, '/product_images/spinach_sample.jpg', 'Vegetables', 'bunch', '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15'],
        ['Cucumber', 'Crisp cucumber', 35, 100, '/product_images/cucumber_sample.jpg', 'Vegetables', 'piece', '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15']
    ];
    const insert = db.prepare(`INSERT INTO products (name, description, price, stock, image_url, category, unit, weight_options) VALUES (?,?,?,?,?,?,?,?)`);
    for (const v of veggies) insert.run(v);
    console.log('✅ Sample products inserted.');
} else {
    console.log(`📊 Existing database found: ${productCount.count} products, ${orderCount.count} orders.`);
}

function isAdmin(req, res, next) {
    if (req.session && req.session.admin) return next();
    else return res.status(401).json({ error: 'Unauthorized' });
}

// ==================== CUSTOMER API ENDPOINTS ====================
app.get('/api/products', (req, res) => {
    const rows = db.prepare(`SELECT id, name, price, stock, image_url, category, unit, weight_options FROM products`).all();
    res.json({ products: rows });
});

app.post('/api/orders', async (req, res) => {
    const { customerName, customerPhone, customerAddress, items, deliverySlot, totalAmount } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items' });
    
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
    
    await addToGoogleSheets({
        orderId, name: customerName, phone: customerPhone, address: customerAddress,
        total, slot: deliverySlot, date: new Date().toISOString()
    });
    
    const adminPhone = "919029186608";
    await sendWhatsAppMessage(adminPhone, `🆕 New Order #${orderId}\nCustomer: ${customerName}\nPhone: ${customerPhone}\nTotal: ₹${total}\nSlot: ${deliverySlot || 'Not selected'}`);
    await sendTelegramAlert(`🆕 <b>NEW ORDER #${orderId}</b>\n\nCustomer: ${customerName}\nPhone: ${customerPhone}\nTotal: ₹${total}\nSlot: ${deliverySlot || 'Not selected'}`);
    
    const UPI_ID = "9029186608@okbizaxis";
    const upiUrl = `upi://pay?pa=${UPI_ID}&pn=Dad%20Veg%20Shop&am=${total}&cu=INR&tn=Order%20${orderId}`;
    QRCode.toDataURL(upiUrl, (err, qrDataUrl) => {
        if (err) return res.json({ orderId, totalAmount: total, qrCodeDataURL: null, upiIntentUrl: upiUrl, customerPhone });
        res.json({ orderId, totalAmount: total, qrCodeDataURL: qrDataUrl, upiIntentUrl: upiUrl, customerPhone });
    });
});

app.get('/api/orders/:phone', (req, res) => {
    const orders = db.prepare(`SELECT id, order_status, payment_status, total_amount, delivery_slot, created_at FROM orders WHERE customer_phone = ? ORDER BY id DESC`).all(req.params.phone);
    if (!orders || orders.length === 0) return res.status(404).json({ error: 'No orders found for this number' });
    res.json(orders);
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

app.get('/api/admin/products', isAdmin, (req, res) => {
    const rows = db.prepare(`SELECT * FROM products`).all();
    res.json(rows);
});

app.post('/api/admin/products', isAdmin, async (req, res) => {
    const { name, description, price, stock, image_url, category, unit, weight_options } = req.body;
    
    let finalImageUrl = image_url || '';
    if (finalImageUrl && (finalImageUrl.includes('pixabay') || finalImageUrl.includes('unsplash') || finalImageUrl.includes('imgur'))) {
        finalImageUrl = await saveImageLocally(finalImageUrl, name);
    }
    
    const insert = db.prepare(`INSERT INTO products (name, description, price, stock, image_url, category, unit, weight_options) VALUES (?,?,?,?,?,?,?,?)`);
    const result = insert.run(name, description, price, stock, finalImageUrl, category, unit || 'kg', weight_options || '250g,500g,1kg');
    res.json({ id: result.lastInsertRowid });
});

app.put('/api/admin/products/:id', isAdmin, async (req, res) => {
    const { name, description, price, stock, image_url, category, unit, weight_options } = req.body;
    
    let finalImageUrl = image_url || '';
    if (finalImageUrl && (finalImageUrl.includes('pixabay') || finalImageUrl.includes('unsplash') || finalImageUrl.includes('imgur'))) {
        finalImageUrl = await saveImageLocally(finalImageUrl, name);
    }
    
    const update = db.prepare(`UPDATE products SET name=?, description=?, price=?, stock=?, image_url=?, category=?, unit=?, weight_options=? WHERE id=?`);
    update.run(name, description, price, stock, finalImageUrl, category, unit || 'kg', weight_options || '250g,500g,1kg', req.params.id);
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

app.put('/api/admin/orders/:id/pay', isAdmin, async (req, res) => {
    const orderId = req.params.id;
    const order = db.prepare(`SELECT payment_status, customer_name, customer_phone, total_amount FROM orders WHERE id = ?`).get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.json({ message: 'Already paid' });
    
    const items = db.prepare(`SELECT product_id, quantity FROM order_items WHERE order_id = ?`).all(orderId);
    for (let it of items) {
        const prod = db.prepare(`SELECT stock FROM products WHERE id = ?`).get(it.product_id);
        if (prod.stock < it.quantity) return res.status(400).json({ error: 'Stock insufficient' });
        db.prepare(`UPDATE products SET stock = stock - ? WHERE id = ?`).run(it.quantity, it.product_id);
    }
    db.prepare(`UPDATE orders SET payment_status = 'paid', order_status = 'confirmed' WHERE id = ?`).run(orderId);
    
    await sendWhatsAppMessage(order.customer_phone, `✅ Order #${orderId} CONFIRMED!\nAmount: ₹${order.total_amount}\nYour order will be prepared and dispatched soon. - Dad's Veggie Shop`);
    await sendTelegramAlert(`✅ <b>PAYMENT CONFIRMED</b>\nOrder #${orderId}\nCustomer: ${order.customer_name}\nAmount: ₹${order.total_amount}`);
    
    res.json({ success: true });
});

app.put('/api/admin/orders/:id/dispatch', isAdmin, async (req, res) => {
    const order = db.prepare(`SELECT customer_name, customer_phone, total_amount FROM orders WHERE id = ?`).get(req.params.id);
    db.prepare(`UPDATE orders SET order_status = 'dispatched' WHERE id = ?`).run(req.params.id);
    
    await sendWhatsAppMessage(order.customer_phone, `🚚 Order #${req.params.id} DISPATCHED!\nYour order is on the way! - Dad's Veggie Shop`);
    await sendTelegramAlert(`🚚 <b>ORDER DISPATCHED</b>\nOrder #${req.params.id}\nCustomer: ${order.customer_name}\nAmount: ₹${order.total_amount}`);
    
    res.json({ success: true });
});

app.put('/api/admin/orders/:id/deliver', isAdmin, async (req, res) => {
    const order = db.prepare(`SELECT customer_name, customer_phone, total_amount FROM orders WHERE id = ?`).get(req.params.id);
    db.prepare(`UPDATE orders SET order_status = 'delivered' WHERE id = ?`).run(req.params.id);
    
    await sendWhatsAppMessage(order.customer_phone, `🎉 Order #${req.params.id} DELIVERED!\nThank you for shopping with Dad's Veggie Shop! 🥬`);
    await sendTelegramAlert(`🎉 <b>ORDER DELIVERED</b>\nOrder #${req.params.id}\nCustomer: ${order.customer_name}\nAmount: ₹${order.total_amount}`);
    
    res.json({ success: true });
});

// ==================== IMAGE FETCH ENDPOINTS WITH PLACEHOLDER FALLBACK ====================
app.post('/api/admin/fetch-single-image/:id', isAdmin, async (req, res) => {
    try {
        const productId = req.params.id;
        const product = db.prepare(`SELECT id, name FROM products WHERE id = ?`).get(productId);
        
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }
        
        let success = false;
        let message = '';
        let imageUrl = '';
        
        // Try Pixabay first
        try {
            const response = await axios.get('https://pixabay.com/api/', {
                params: {
                    key: PIXABAY_API_KEY,
                    q: product.name,
                    image_type: 'photo',
                    per_page: 1,
                    safesearch: true
                },
                timeout: 10000
            });
            
            if (response.data && response.data.hits && response.data.hits.length > 0) {
                imageUrl = response.data.hits[0].webformatURL;
                const localPath = await saveImageLocally(imageUrl, product.name);
                db.prepare(`UPDATE products SET image_url = ? WHERE id = ?`).run(localPath, productId);
                success = true;
                message = `Image fetched from Pixabay for ${product.name}`;
                console.log(`✅ ${message}`);
            }
        } catch (pixabayError) {
            console.log(`Pixabay failed for ${product.name}: ${pixabayError.message}`);
        }
        
        // If Pixabay failed, use placeholder
        if (!success) {
            try {
                const localPath = await generatePlaceholderImage(product.name);
                db.prepare(`UPDATE products SET image_url = ? WHERE id = ?`).run(localPath, productId);
                success = true;
                message = `Placeholder generated for ${product.name}`;
                console.log(`✅ ${message}`);
                imageUrl = localPath;
            } catch (placeholderError) {
                message = `Failed to generate placeholder for ${product.name}`;
                console.log(`❌ ${message}`);
            }
        }
        
        if (success) {
            res.json({ success: true, message: message, imageUrl: imageUrl });
        } else {
            res.json({ success: false, message: message });
        }
    } catch (error) {
        console.error('Single fetch error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/bulk-fetch-images', isAdmin, async (req, res) => {
    try {
        const products = db.prepare(`
            SELECT id, name, image_url 
            FROM products 
            WHERE image_url IS NULL 
               OR image_url = '' 
               OR image_url LIKE '%placeholder%'
               OR image_url NOT LIKE '/product_images/%'
        `).all();
        
        console.log(`Found ${products.length} products needing images`);
        
        if (products.length === 0) {
            return res.json({
                success: true,
                message: 'No products need images!',
                total: 0,
                updated: 0,
                failed: 0,
                results: []
            });
        }
        
        let updated = 0;
        let failed = 0;
        const results = [];
        
        for (const product of products) {
            let productSuccess = false;
            
            // Try Pixabay first
            try {
                const response = await axios.get('https://pixabay.com/api/', {
                    params: {
                        key: PIXABAY_API_KEY,
                        q: product.name,
                        image_type: 'photo',
                        per_page: 1,
                        safesearch: true
                    },
                    timeout: 10000
                });
                
                if (response.data && response.data.hits && response.data.hits.length > 0) {
                    const imageUrl = response.data.hits[0].webformatURL;
                    const localPath = await saveImageLocally(imageUrl, product.name);
                    db.prepare(`UPDATE products SET image_url = ? WHERE id = ?`).run(localPath, product.id);
                    updated++;
                    results.push({
                        id: product.id,
                        name: product.name,
                        status: 'success',
                        source: 'Pixabay'
                    });
                    console.log(`✅ Fetched Pixabay image for ${product.name}`);
                    productSuccess = true;
                }
            } catch (pixabayError) {
                console.log(`Pixabay failed for ${product.name}: ${pixabayError.message}`);
            }
            
            // If Pixabay failed, use placeholder
            if (!productSuccess) {
                try {
                    const localPath = await generatePlaceholderImage(product.name);
                    db.prepare(`UPDATE products SET image_url = ? WHERE id = ?`).run(localPath, product.id);
                    updated++;
                    results.push({
                        id: product.id,
                        name: product.name,
                        status: 'success',
                        source: 'Placeholder'
                    });
                    console.log(`✅ Generated placeholder for ${product.name}`);
                    productSuccess = true;
                } catch (placeholderError) {
                    failed++;
                    results.push({
                        id: product.id,
                        name: product.name,
                        status: 'failed',
                        reason: placeholderError.message
                    });
                    console.log(`❌ Failed for ${product.name}: ${placeholderError.message}`);
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        res.json({
            success: true,
            message: `Completed: ${updated} images/placeholders generated, ${failed} failed`,
            total: products.length,
            updated: updated,
            failed: failed,
            results: results
        });
    } catch (error) {
        console.error('Bulk fetch error:', error);
        res.status(500).json({ success: false, error: error.message });
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
            
            const insert = db.prepare(`INSERT INTO products (name, description, price, stock, image_url, category, unit, weight_options) VALUES (?,?,?,?,?,?,?,?)`);
            const result = insert.run(
                row.name.trim(),
                row.description || '',
                parseFloat(row.price),
                parseInt(row.stock),
                row.image_url || '',
                row.category || 'Vegetables',
                row.unit || 'kg',
                row.weight_options || '250g,500g,1kg'
            );
            insertedProducts.push({ id: result.lastInsertRowid, name: row.name });
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

// ==================== HEALTH & PAGE ROUTES ====================
app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });

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
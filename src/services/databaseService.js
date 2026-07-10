const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');
const { execSync } = require('child_process');

const DB_PATH = path.join(__dirname, '../../data/database.json');
const KEY_LIST_PATH = path.join(__dirname, '../../data/keyList.json');
const VPS_PATH = path.join(__dirname, '../../data/vps.json');


const BACKUP_DIR = path.join(__dirname, '../../backups');

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function createBackup(filePath, prefix) {
  try {
    if (!fs.existsSync(filePath)) return null;

    const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `${prefix}-${timestamp}.json`);

    fs.copyFileSync(filePath, backupFile);
    return backupFile;
  } catch (error) {
    logger.error(`Error creating backup ${prefix}: ${error.message}`);
    return null;
  }
}

function createDatabaseZipBackup() {
  try {
    const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
    const zipPath = path.join(BACKUP_DIR, `database-backup-${timestamp}.zip`);

    execSync(`zip -j "${zipPath}" "${DB_PATH}" "${KEY_LIST_PATH}" "${VPS_PATH}"`, { stdio: 'ignore' });

    return zipPath;
  } catch (error) {
    logger.error(`Error creating zip backup: ${error.message}`);
    return null;
  }
}

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function loadDatabase() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify([]));
      logger.info("Database baru dibuat.");
    }
    return JSON.parse(fs.readFileSync(DB_PATH));
  } catch (err) {
    logger.error(`Error loading database: ${err.message}`);
    return [];
  }
}

function saveDatabase(data) {
  try {
    createBackup(DB_PATH, 'database');
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    createDatabaseZipBackup();
    return true;
  } catch (err) {
    logger.error(`Error saving database: ${err.message}`);
    return false;
  }
}

function loadKeyList() {
  try {
    if (!fs.existsSync(KEY_LIST_PATH)) {
      fs.writeFileSync(KEY_LIST_PATH, JSON.stringify([]));
      logger.info("Key list baru dibuat.");
    }
    return JSON.parse(fs.readFileSync(KEY_LIST_PATH));
  } catch (err) {
    logger.error(`Error loading key list: ${err.message}`);
    return [];
  }
}

function saveKeyList(data) {
  try {
    createBackup(KEY_LIST_PATH, 'keylist');
    fs.writeFileSync(KEY_LIST_PATH, JSON.stringify(data, null, 2));
    createDatabaseZipBackup();
    return true;
  } catch (err) {
    logger.error(`Error saving key list: ${err.message}`);
    return false;
  }
}

function loadVpsList() {
  try {
    if (!fs.existsSync(VPS_PATH)) {
      fs.writeFileSync(VPS_PATH, JSON.stringify([]));
      logger.info("VPS list baru dibuat.");
    }
    return JSON.parse(fs.readFileSync(VPS_PATH));
  } catch (err) {
    logger.error(`Error loading VPS list: ${err.message}`);
    return [];
  }
}

function saveVpsList(data) {
  try {
    createBackup(VPS_PATH, 'vps');
    fs.writeFileSync(VPS_PATH, JSON.stringify(data, null, 2));
    createDatabaseZipBackup();
    return true;
  } catch (err) {
    logger.error(`Error saving VPS list: ${err.message}`);
    return false;
  }
}

module.exports = {
  loadDatabase,
  saveDatabase,
  loadKeyList,
  saveKeyList,
  loadVpsList,
  saveVpsList,
  createDatabaseZipBackup
};
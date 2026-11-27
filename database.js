// database.js - JSON + AES-256-GCM + Write Queue + Schema Versioning
import fs from 'fs/promises';
import fsSync from 'fs'; // Tambahan untuk sinkronisasi saat exit
import path from 'path';
import crypto from 'crypto';
import config from './config.js';
import { logger } from './zeone.js';

const DB_PATH = path.join(process.cwd(), 'database.json');
const TMP_PATH = path.join(process.cwd(), 'database.tmp');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;
const SCHEMA_VERSION = 2;

const ENC_KEY = config.dbEncryptionKey;
if (!ENC_KEY) {
    logger.error('DB_ENCRYPTION_KEY tidak ditemukan. Set di file .env');
    process.exit(1);
}

function deriveKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveKey(ENC_KEY, salt);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    return Buffer.concat([salt, iv, authTag, Buffer.from(encrypted, 'base64')]).toString('base64');
}

function decrypt(encryptedData) {
    const buffer = Buffer.from(encryptedData, 'base64');
    const salt = buffer.subarray(0, SALT_LENGTH);
    const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const cipherBuf = buffer.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const key = deriveKey(ENC_KEY, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(cipherBuf.toString('base64'), 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function migrateSchema(data) {
    const from = data._schemaVersion || 1;
    if (from === SCHEMA_VERSION) return data;
    logger.info(`🔄 Migrasi database dari v${from} ke v${SCHEMA_VERSION}...`);
    if (from < 2) {
        data.global = { autoRejectCall: { enabled: false, message: 'Maaf, bot tidak menerima panggilan.' }, ...(data.global || {}) };
    }
    data._schemaVersion = SCHEMA_VERSION;
    return data;
}

function makeDefaultCache() {
    return {
        _schemaVersion: SCHEMA_VERSION,
        groups: {},
        global: { autoRejectCall: { enabled: false, message: 'Maaf, bot tidak menerima panggilan.' } },
        users: {}
    };
}

let CACHE = makeDefaultCache();
let writeQueue = Promise.resolve();

// ─── FIX: Mencegah Data Loss saat penulisan beruntun ───
let isWriting = false;
let isDirty = false;

function enqueueWrite(fn) { writeQueue = writeQueue.then(fn, fn); }

async function performWrite() {
    if (isWriting) {
        isDirty = true;
        return;
    }
    isWriting = true;
    isDirty = false;
    try {
        const jsonData = JSON.stringify(CACHE, null, 2);
        const encrypted = encrypt(jsonData);
        await fs.writeFile(TMP_PATH, encrypted, 'utf8');
        await fs.rename(TMP_PATH, DB_PATH);
    } catch (err) {
        logger.error(`❌ Gagal menyimpan database: ${err.message}`);
        try { await fs.unlink(TMP_PATH); } catch {}
    } finally {
        isWriting = false;
        if (isDirty) {
            enqueueWrite(performWrite);
        }
    }
}

function scheduleWrite() {
    enqueueWrite(performWrite);
}

async function loadFromFile(filePath) {
    const encrypted = await fs.readFile(filePath, 'utf-8');
    const jsonData = decrypt(encrypted);
    return JSON.parse(jsonData);
}

async function loadCache() {
    const tryLoad = async (filePath, label) => {
        try {
            const parsed = await loadFromFile(filePath);
            return migrateSchema({ ...makeDefaultCache(), ...parsed });
        } catch (err) {
            logger.warn(`⚠️ Gagal memuat database ${label}: ${err.message}`);
            return null;
        }
    };
    let data = await tryLoad(DB_PATH, 'utama');
    if (!data) {
        data = await tryLoad(TMP_PATH, 'backup');
        if (data) {
            try { await fs.copyFile(TMP_PATH, DB_PATH); logger.info('✅ Database dipulihkan dari backup.'); } catch {}
        }
    }
    if (data) {
        CACHE = data;
        logger.info('✅ Database loaded successfully.');
    } else {
        logger.warn('⚠️ Tidak ada database valid, menggunakan default.');
        CACHE = makeDefaultCache();
        scheduleWrite();
    }
}

await loadCache();

const DEFAULT_GROUP = () => ({ welcome: { enabled: false, message: '' }, antilink: { enabled: false, action: 'warn' } });
export async function getGroupSettings(groupId) {
    if (!groupId || typeof groupId !== 'string') return DEFAULT_GROUP();
    const cleanId = groupId.split('@')[0];
    if (!CACHE.groups[cleanId]) { CACHE.groups[cleanId] = DEFAULT_GROUP(); scheduleWrite(); }
    return CACHE.groups[cleanId];
}
export async function updateGroupSettings(groupId, settings) {
    if (!groupId || typeof groupId !== 'string') return;
    const cleanId = groupId.split('@')[0];
    CACHE.groups[cleanId] = { ...(CACHE.groups[cleanId] || DEFAULT_GROUP()), ...settings };
    scheduleWrite();
}
export async function getGlobalSettings() { return CACHE.global; }
export async function updateGlobalSettings(settings) { CACHE.global = { ...CACHE.global, ...settings }; scheduleWrite(); }
const DEFAULT_USER = () => ({ name: '', registered: Date.now() });
export async function getUser(userId) {
    if (!userId || typeof userId !== 'string') return DEFAULT_USER();
    const cleanId = userId.split('@')[0];
    if (!CACHE.users[cleanId]) { CACHE.users[cleanId] = DEFAULT_USER(); scheduleWrite(); }
    return CACHE.users[cleanId];
}
export async function updateUser(userId, data) {
    if (!userId || typeof userId !== 'string') return;
    const cleanId = userId.split('@')[0];
    CACHE.users[cleanId] = { ...(CACHE.users[cleanId] || DEFAULT_USER()), ...data };
    scheduleWrite();
}
export const db = {
    async getUsers() { return CACHE.users; },
    async getGroups() { return CACHE.groups; },
    async getGlobal() { return CACHE.global; },
    getSchemaVersion() { return CACHE._schemaVersion; }
};

// ─── FIX: Sinkronisasi penulisan saat proses dimatikan ───
const syncSaveOnExit = () => {
    try {
        const jsonData = JSON.stringify(CACHE, null, 2);
        const encrypted = encrypt(jsonData);
        fsSync.writeFileSync(DB_PATH, encrypted, 'utf8');
    } catch (e) {
        logger.error(`❌ Gagal menyimpan database saat exit: ${e.message}`);
    }
};
process.on('SIGINT', () => { syncSaveOnExit(); process.exit(0); });
process.on('SIGTERM', () => { syncSaveOnExit(); process.exit(0); });
process.on('beforeExit', () => { syncSaveOnExit(); });

// export untuk unit test
export { encrypt, decrypt };
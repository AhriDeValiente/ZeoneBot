// message.js – Message Handler + Report Manager + Error Collector (hasil merge)
import {
    executeCommand,
    logger,
    formatChatType,
    getMessageType,
    extractMessageText,
    isSelfChat,
    formatFileSize,
    formatDuration,
    cleanJid,
    sanitizeText
} from "./zeone.js";
import { botState } from "./start.js";
import chalk from "chalk";
import { getGroupSettings } from "./database.js";
import config from "./config.js";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1: REPORT MANAGER
// ═════════════════════════════════════════════════════════════════════════════

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_FILE = path.join(__dirname, 'reports', 'reports.json');
const REPORT_TMP = path.join(__dirname, 'reports', 'reports.tmp');
const ENCRYPTION_KEY = process.env.REPORT_ENCRYPTION_KEY || config.reportEncryptionKey || 'GlobalReportSecretKey_ChangeMe!';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const AUTH_TAG_LENGTH = 16;

let reports = { errors: [], commands: [], metrics: [], system: [] };

function deriveReportKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
}

function encryptReport(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveReportKey(ENCRYPTION_KEY, salt);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    return Buffer.concat([salt, iv, authTag, Buffer.from(encrypted, 'base64')]).toString('base64');
}

function decryptReport(encryptedData) {
    const buffer = Buffer.from(encryptedData, 'base64');
    const salt = buffer.subarray(0, SALT_LENGTH);
    const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertextBase64 = buffer.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH).toString('base64');
    const rawCiphertext = Buffer.from(ciphertextBase64, 'base64').toString('binary');
    const key = deriveReportKey(ENCRYPTION_KEY, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(rawCiphertext, 'binary', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

async function saveReports() {
    try {
        const json = JSON.stringify(reports, null, 2);
        const encrypted = encryptReport(json);
        await fs.mkdir(path.dirname(REPORT_FILE), { recursive: true }).catch(() => {});
        await fs.writeFile(REPORT_TMP, encrypted, 'utf8');
        await fs.rename(REPORT_TMP, REPORT_FILE);
    } catch (err) {
        console.error('[ReportManager] Gagal menyimpan laporan:', err.message);
    }
}

// ─── FIX: Debounce save untuk mencegah I/O bottleneck ───
let saveTimeout = null;
function scheduleSave() {
    if (saveTimeout) return;
    saveTimeout = setTimeout(async () => {
        saveTimeout = null;
        await saveReports();
    }, 3000); 
}

async function loadReports() {
    try {
        const encrypted = await fs.readFile(REPORT_FILE, 'utf-8');
        const json = decryptReport(encrypted);
        const parsed = JSON.parse(json);
        reports = { ...reports, ...parsed };
    } catch (err) {
        scheduleSave();
    }
}

await loadReports();

export async function reportError(errorReport) {
    reports.errors.push({ timestamp: new Date().toISOString(), ...errorReport });
    if (reports.errors.length > 1000) reports.errors = reports.errors.slice(-1000);
    scheduleSave();
}

export async function reportCommand(commandReport) {
    reports.commands.push({ timestamp: new Date().toISOString(), ...commandReport });
    if (reports.commands.length > 5000) reports.commands = reports.commands.slice(-5000);
    scheduleSave();
}

export async function reportMetrics(metric) {
    reports.metrics.push({ timestamp: new Date().toISOString(), ...metric });
    if (reports.metrics.length > 1000) reports.metrics = reports.metrics.slice(-1000);
    scheduleSave();
}

export async function reportSystem(event, detail = '') {
    reports.system.push({ timestamp: new Date().toISOString(), event, detail });
    if (reports.system.length > 500) reports.system = reports.system.slice(-500);
    scheduleSave();
}

export function getReport(type = 'all', limit = 100) {
    if (type === 'all') {
        return {
            errors: reports.errors.slice(-limit),
            commands: reports.commands.slice(-limit),
            metrics: reports.metrics.slice(-limit),
            system: reports.system.slice(-limit),
            summary: getSummary()
        };
    }
    return reports[type] ? reports[type].slice(-limit) : [];
}

export function getSummary() {
    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;
    const recentCommands = reports.commands.filter(c => new Date(c.timestamp).getTime() > last24h);
    const recentErrors = reports.errors.filter(e => new Date(e.timestamp).getTime() > last24h);
    const commandFreq = {};
    recentCommands.forEach(c => { commandFreq[c.command] = (commandFreq[c.command] || 0) + 1; });
    const totalCommands = recentCommands.length || 1;
    const errorRate = ((recentErrors.length / totalCommands) * 100).toFixed(2);
    return {
        totalErrors: reports.errors.length,
        totalCommands: reports.commands.length,
        last24hCommands: recentCommands.length,
        last24hErrors: recentErrors.length,
        errorRate: `${errorRate}%`,
        topCommands: Object.entries(commandFreq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([cmd, count]) => ({ command: cmd, count }))
    };
}

export async function clearReports() {
    reports = { errors: [], commands: [], metrics: [], system: [] };
    await scheduleSave();
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2: ERROR COLLECTOR
// ═════════════════════════════════════════════════════════════════════════════

var errorHandlersInstalled = false;

export function installGlobalErrorHandlers() {
    if (errorHandlersInstalled) return;
    errorHandlersInstalled = true;

    process.on('uncaughtException', async (err) => {
        console.error('[FATAL] Uncaught Exception:', err);
        await reportError({ type: 'uncaughtException', message: err.message, stack: err.stack, timestamp: new Date().toISOString() });
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
        console.error('[UNHANDLED REJECTION]', reason);
        await reportError({ type: 'unhandledRejection', message: reason?.message || String(reason), stack: reason?.stack || '', timestamp: new Date().toISOString() });
    });

    process.on('warning', async (warning) => {
        if (warning.name === 'DeprecationWarning' && warning.message.includes('Baileys')) {
            await reportError({ type: 'warning', message: warning.message, stack: warning.stack, timestamp: new Date().toISOString() });
        }
    });

    process.on('multipleResolves', async (type, promise, reason) => {
        await reportError({ type: 'multipleResolves', message: `Type: ${type}, Reason: ${reason}`, stack: '', timestamp: new Date().toISOString() });
    });

    process.on('exit', async (code) => {
        await reportSystem('exit', `Bot exit with code ${code}`);
    });

    console.log('[ErrorCollector] ✅ Global error handlers terpasang.');
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3: MESSAGE HANDLER
// ═════════════════════════════════════════════════════════════════════════════

const SHOW_MESSAGE_LOG = config.showMessageLog !== false;
const LOG_OUTGOING_MESSAGES = config.logOutgoing !== false;
const MESSAGE_CACHE_TTL = 30_000;
const CACHE_TTL = 5 * 60 * 1000;

export const pendingCommands = new Set();

const processedMessages = new Map();
function isMessageProcessed(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    for (const [id, ts] of processedMessages) { if (now - ts > MESSAGE_CACHE_TTL) processedMessages.delete(id); }
    if (processedMessages.has(messageId)) return true;
    processedMessages.set(messageId, now);
    return false;
}

function markMessageProcessed(messageId) {
    if (messageId) processedMessages.set(messageId, Date.now());
}

const MESSAGE_STORE_TTL = 2 * 60 * 60 * 1000;
const MESSAGE_STORE_MAX = 500;
const messageStore = new Map();
const messageStoreById = new Map();

function deleteStoreEntry(storeKey, messageId) {
    messageStore.delete(storeKey);
    messageStoreById.delete(messageId);
}

export function storeMessage(msg) {
    const key = msg?.key;
    if (!key?.id || !key.remoteJid || !msg.message) return;
    if (key.remoteJid === "status@broadcast") return;
    const entry = { message: msg, ts: Date.now() };
    messageStore.set(`${key.remoteJid}|${key.id}`, entry);
    messageStoreById.set(key.id, entry);
    if (messageStore.size > MESSAGE_STORE_MAX) {
        const oldestKey = messageStore.keys().next().value;
        deleteStoreEntry(oldestKey, messageStore.get(oldestKey).message.key.id);
    }
}

export function loadStoredMessage(remoteJid, messageId) {
    const entry = messageStore.get(`${remoteJid}|${messageId}`) || messageStoreById.get(messageId);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > MESSAGE_STORE_TTL) {
        deleteStoreEntry(`${entry.message.key.remoteJid}|${messageId}`, messageId);
        return undefined;
    }
    return entry.message;
}

const SESSION_ERROR_RE = /bad mac|no session|sessionerror|session error|prekey|failed to decrypt|closing open session|identity key|invalid key/i;

async function sendWithSessionRecovery(sock, targetJid, content, options) {
    try {
        return await sock.sendMessage(targetJid, content, options);
    } catch (err) {
        if (targetJid.endsWith("@g.us") || !SESSION_ERROR_RE.test(String(err?.message || ""))) throw err;
        logger.warn(`[SESSION] Kirim ke ${targetJid} gagal (${err.message}) → hapus sesi korup & kirim ulang`);
        try { await sock.signalRepository?.deleteSession?.([targetJid]); }
        catch (e) { logger.warn(`[SESSION] Gagal hapus sesi ${targetJid}: ${e.message}`); }
        return await sock.sendMessage(targetJid, content, options);
    }
}

const groupSettingsCache = new Map();
const groupMetadataCache = new Map();

// FIX: Tambahkan .unref() agar bot bisa exit natural
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of groupSettingsCache) { if (now > entry.expires) groupSettingsCache.delete(key); }
    for (const [key, entry] of groupMetadataCache) { if (now > entry.expires) groupMetadataCache.delete(key); }
    for (const [key, entry] of messageStore) {
        if (now - entry.ts > MESSAGE_STORE_TTL) {
            messageStore.delete(key);
            messageStoreById.delete(entry.message.key.id);
        }
    }
}, 10 * 60 * 1000);
cleanupInterval.unref();

async function getGroupSettingsCached(groupId) {
    const cached = groupSettingsCache.get(groupId);
    if (cached && Date.now() < cached.expires) return cached.settings;
    const settings = await getGroupSettings(groupId);
    groupSettingsCache.set(groupId, { settings, expires: Date.now() + CACHE_TTL });
    return settings;
}

async function getGroupMetadataCached(sock, groupId) {
    const cached = groupMetadataCache.get(groupId);
    if (cached && Date.now() < cached.expires) return cached.metadata;
    const metadata = await sock.groupMetadata(groupId).catch(() => null);
    groupMetadataCache.set(groupId, { metadata, expires: Date.now() + CACHE_TTL });
    return metadata;
}

const senderNameCache = new Map();

function _isValidName(name) {
    return name && typeof name === 'string' && !/^\d+$/.test(name) && name !== '-' && name !== 'Unknown' && !name.includes(':');
}

function _baseNum(jid) {
    return (jid?.split('@')[0] || '').split(':')[0];
}

function resolvePhoneJid(sock, jid) {
    if (!jid) return jid;
    if (jid.endsWith('@s.whatsapp.net')) return `${_baseNum(jid)}@s.whatsapp.net`;
    if (jid.endsWith('@g.us')) return jid;
    if (jid.endsWith('@lid') && sock?.contacts) {
        const lidBase = _baseNum(jid);
        for (const [contactJid, contact] of Object.entries(sock.contacts)) {
            if (!contactJid.endsWith('@s.whatsapp.net') || !contact?.lid) continue;
            if (_baseNum(contact.lid) === lidBase) return `${_baseNum(contactJid)}@s.whatsapp.net`;
        }
    }
    return jid;
}

export async function resolveContactName(sock, jid) {
    const cleaned = cleanJid(jid);
    const base    = _baseNum(jid);
    const cacheKey = base || cleaned;
    const cached = senderNameCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) return cached.name;

    if (sock.user) {
        const selfBase = _baseNum(sock.user.id);
        const lidBase  = _baseNum(sock.user.lid || '');
        if (base === selfBase || (lidBase && base === lidBase)) {
            const name = sock.user.name || sock.user.verifiedName;
            if (_isValidName(name)) {
                senderNameCache.set(cacheKey, { name, expires: Date.now() + CACHE_TTL });
                return name;
            }
        }
    }

    const jidVariants = [jid, `${base}@s.whatsapp.net`, `${cleaned}@s.whatsapp.net`, `${base}@lid`, `${cleaned}@lid`];

    // FIX: Hapus while loop setTimeout 15 detik yang memblokir
    if (sock.contacts && Object.keys(sock.contacts).length > 0) {
        for (const variant of jidVariants) {
            const c = sock.contacts[variant];
            if (!c) continue;
            const name = c.notify || c.name || c.vname;
            if (_isValidName(name)) {
                senderNameCache.set(cacheKey, { name, expires: Date.now() + CACHE_TTL });
                return name;
            }
        }
    }

    try {
        const name = await Promise.race([
            sock.getName(jid),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
        ]);
        if (_isValidName(name)) {
            senderNameCache.set(cacheKey, { name, expires: Date.now() + CACHE_TTL });
            return name;
        }
    } catch (e) {}

    const fallback = base || cleaned || 'Unknown';
    senderNameCache.set(cacheKey, { name: fallback, expires: Date.now() + 60_000 });
    return fallback;
}

function formatExtraDetails(m) {
    const msg = m.message;
    if (!msg) return "";
    const details = [];
    if (msg.imageMessage) {
        details.push(`🖼️ Image${msg.imageMessage.caption ? " (caption)" : ""} | mimetype: ${msg.imageMessage.mimetype}`);
        if (msg.imageMessage.fileLength) details.push(`   Size: ${formatFileSize(msg.imageMessage.fileLength)}`);
    }
    if (msg.videoMessage) {
        details.push(`🎥 Video${msg.videoMessage.caption ? " (caption)" : ""} | mimetype: ${msg.videoMessage.mimetype}`);
        if (msg.videoMessage.seconds) details.push(`   Duration: ${formatDuration(msg.videoMessage.seconds)}`);
        if (msg.videoMessage.fileLength) details.push(`   Size: ${formatFileSize(msg.videoMessage.fileLength)}`);
    }
    if (msg.audioMessage) {
        details.push(`🎵 Audio (${msg.audioMessage.ptt ? "voice note" : "audio"}) | mimetype: ${msg.audioMessage.mimetype}`);
        if (msg.audioMessage.seconds) details.push(`   Duration: ${formatDuration(msg.audioMessage.seconds)}`);
    }
    if (msg.documentMessage) {
        details.push(`📄 Document | mimetype: ${msg.documentMessage.mimetype}`);
        if (msg.documentMessage.fileName) details.push(`   Name: ${msg.documentMessage.fileName}`);
        if (msg.documentMessage.fileLength) details.push(`   Size: ${formatFileSize(msg.documentMessage.fileLength)}`);
    }
    if (msg.stickerMessage) details.push(`🖼️ Sticker | mimetype: ${msg.stickerMessage.mimetype}`);
    if (msg.locationMessage) details.push(`📍 Location`);
    if (msg.contactMessage) details.push(`👤 Contact`);
    const ctxInfo = msg.extendedTextMessage?.contextInfo;
    if (ctxInfo?.quotedMessage) {
        const quotedType = Object.keys(ctxInfo.quotedMessage)[0];
        details.push(`↩️ Quoted: ${quotedType}`);
    }
    return details.join("\n");
}

const lastMessageTimestamps = new Map();
function shouldSkipOldMessage(m) {
    if (!botState.skipOldMessages) return false;
    const jid = m.key.remoteJid;
    const timestamp = (m.messageTimestamp || 0) * 1000;
    const now = Date.now();
    if (now - timestamp > 10000) return true;
    const last = lastMessageTimestamps.get(jid);
    if (last && timestamp <= last) return true;
    lastMessageTimestamps.set(jid, now);
    return false;
}

const SKIP_TYPES = new Set([
    "pollCreationMessage", "buttonsMessage", "listMessage", "templateMessage",
    "orderMessage", "productMessage", "contactsArrayMessage", "groupInviteMessage",
    "liveLocationMessage", "reactionMessage", "protocolMessage",
    "senderKeyDistributionMessage", "messageContextInfo"
]);

function shouldSkipMessage(m) {
    if (!m?.key) return true;
    const remoteJid = m.key.remoteJid || "";
    if (remoteJid === "status@broadcast") return true;
    if (formatChatType(remoteJid) === "BROADCAST") return true;
    return SKIP_TYPES.has(getMessageType(m));
}

function logMessage({ jid, pushName, chatType, chatJid = null, msgType, text, extra = "", ts, isOutgoing = false }) {
    const prefix = isOutgoing ? "📤 OUTGOING" : "📥 INCOMING";
    const action = isOutgoing ? "SENT" : "RECEIVED";
    console.log("==========================================");
    console.log(`📨 ${prefix} MESSAGE ${action} [${ts}]`);
    console.log(`▪ To/From    : ${pushName} (${jid})`);
    console.log(`▪ Chat Type  : ${chatType}${chatJid ? ` (${chatJid})` : ''}`);
    console.log(`▪ Msg Type   : ${msgType}`);
    console.log(`▪ Text       : ${text || "(no text)"}`);
    if (extra?.trim()) {
        console.log("▪ Detail     :");
        extra.split("\n").forEach(line => line.trim() && console.log(`   ${line}`));
    }
    console.log("==========================================");
}

export function logOutgoingMessage(jid, content, displayName = null) {
    if (!LOG_OUTGOING_MESSAGES) return;
    const ts = new Date().toLocaleTimeString();
    const contentType = typeof content === "object" ? Object.keys(content)[0] : "text";
    const text = typeof content.text === "string" ? content.text : `[${contentType}]`;
    const nameLabel = displayName && !/^\d+$/.test(displayName) && displayName !== 'Unknown' ? displayName : cleanJid(jid);
    logMessage({
        jid, pushName: `[BOT→] ${nameLabel}`, chatType: formatChatType(jid),
        msgType: contentType, text, extra: "", ts, isOutgoing: true
    });
}

const LINK_REGEX = /((https?:\/\/|www\.)[^\s<>"]+)|(chat\.whatsapp\.com\/[^\s]+)|(wa\.me\/[^\s]+)|(t\.me\/[^\s]+)|([a-zA-Z0-9-]+\.(com|net|org|id|co|io|xyz|my|info|biz|site)(\b|\/))/i;

async function handleAntilink(sock, m, remoteJid, commandText, ctx) {
    if (!LINK_REGEX.test(commandText)) return;
    try {
        const settings = await getGroupSettingsCached(remoteJid);
        if (!settings?.antilink?.enabled) return;
        const sender = m.key.participant || m.key.remoteJid;
        const metadata = await getGroupMetadataCached(sock, remoteJid);
        const isSenderAdmin = metadata?.participants?.some(p => p.id === sender && (p.admin === "admin" || p.admin === "superadmin"));
        if (isSenderAdmin) return;
        const action = settings.antilink.action || "delete";
        if (action === "delete") {
            await sock.sendMessage(remoteJid, { delete: m.key });
        } else if (action === "warn" || action === "kick") {
            await ctx.reply(`⚠️ @${cleanJid(sender)} mengirim link, ini peringatan!`, { mentions: [sender] });
        }
    } catch (err) {
        logger.error(`Antilink error: ${err.message}`);
    }
}

const OWNER_JID = config.ownerNumber ? (config.ownerNumber.includes('@') ? config.ownerNumber : `${config.ownerNumber}@s.whatsapp.net`) : '';

function isOwnerJid(jid) {
    if (!OWNER_JID || !jid) return false;
    return _baseNum(jid) === _baseNum(OWNER_JID);
}

export async function handleIncomingMessages(sock, msg, state) {
    const messages = msg.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    for (const m of messages) {
        if (!m?.key?.remoteJid || !m.message) continue;
        const messageId = m.key.id;
        if (isMessageProcessed(messageId)) continue;

        const remoteJid = m.key.remoteJid;
        const fromMe = m.key.fromMe || false;
        const chatType = formatChatType(remoteJid);
        const selfChat = isSelfChat(remoteJid, fromMe, state.botNumber, state.botLid);
        const commandText = extractMessageText(m);
        const prefix = config.prefix;
        const isCommand = prefix.length > 0 && commandText.startsWith(prefix);

        if (!state.isReady && !selfChat) continue;

        const botIsOwnerAccount = isOwnerJid(state.botNumber) || isOwnerJid(state.botLid);
        const rawSenderJid = m.key.participant || remoteJid;
        const isOwner = selfChat || (fromMe && botIsOwnerAccount) || isOwnerJid(rawSenderJid) || isOwnerJid(resolvePhoneJid(sock, rawSenderJid));
        const senderJid = (selfChat || (fromMe && botIsOwnerAccount)) && OWNER_JID ? OWNER_JID : rawSenderJid;

        const resolvedName = await resolveContactName(sock, senderJid);
        const validResolved = _isValidName(resolvedName) ? resolvedName : null;
        const validPushName = _isValidName(m.pushName) ? m.pushName : null;
        const finalDisplayName = validResolved || validPushName || resolvedName || cleanJid(remoteJid);

        const targetJid = remoteJid;
        const participant = m.key.participant || remoteJid;
        const groupMetadata = chatType === "GROUP" ? await getGroupMetadataCached(sock, remoteJid) : null;
        const isAdmin = chatType === "GROUP"
            ? (groupMetadata?.participants?.some(p => p.id === participant && (p.admin === "admin" || p.admin === "superadmin")) ?? false)
            : false;

        const ctx = {
            sock, id: targetJid, sender: senderJid, chatType: selfChat ? "SELF" : chatType,
            isGroup: chatType === "GROUP", isPrivate: chatType === "PRIVATE" && !selfChat,
            isSelf: selfChat, isOwner, isAdmin, fromMe, pushName: finalDisplayName,
            quoted: m.message?.extendedTextMessage?.contextInfo?.quotedMessage ? m : null,
            mentionedJid: m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [],
            groupMetadata, botLid: state.botLid, msg: m,
            reply: async (replyText, options = {}) => {
                if (!state.isConnected) { logger.warn(`[REPLY SKIP] Bot tidak connected → ${targetJid}`); return null; }
                if (!sock.user) { logger.warn(`[REPLY SKIP] sock.user null → ${targetJid}`); return null; }
                try {
                    const result = await sendWithSessionRecovery(sock, targetJid, { text: String(replyText) }, { quoted: fromMe ? undefined : m, ...options });
                    markMessageProcessed(result?.key?.id);
                    storeMessage(result);
                    logOutgoingMessage(targetJid, { text: String(replyText) }, resolvedName || m.pushName);
                    return result;
                } catch (err) {
                    logger.error(`[SEND ERROR] reply → ${targetJid}: ${err.message}`);
                    return null;
                }
            },
            sendText: async textContent => {
                if (!state.isConnected) { logger.warn(`[SENDTEXT SKIP] Bot tidak connected → ${targetJid}`); return null; }
                if (!sock.user) { logger.warn(`[SENDTEXT SKIP] sock.user null → ${targetJid}`); return null; }
                try {
                    const result = await sendWithSessionRecovery(sock, targetJid, { text: String(sanitizeText(textContent)) });
                    markMessageProcessed(result?.key?.id);
                    storeMessage(result);
                    logOutgoingMessage(targetJid, { text: String(textContent) }, resolvedName || m.pushName);
                    return result;
                } catch (err) {
                    logger.error(`[SEND ERROR] sendText → ${targetJid}: ${err.message}`);
                    return null;
                }
            },
            sendMessage: async (content, options = {}) => {
                if (!state.isConnected) { logger.warn(`[SENDMSG SKIP] Bot tidak connected → ${targetJid}`); return null; }
                if (!sock.user) { logger.warn(`[SENDMSG SKIP] sock.user null → ${targetJid}`); return null; }
                try {
                    const result = await sendWithSessionRecovery(sock, targetJid, content, { quoted: m, ...options });
                    markMessageProcessed(result?.key?.id);
                    storeMessage(result);
                    // FIX: Gunakan typeof string agar pesan kosong tetap ter-log
                    if (typeof content.text === 'string') logOutgoingMessage(targetJid, { text: content.text }, resolvedName || m.pushName);
                    else if (content.image) logOutgoingMessage(targetJid, { image: true, caption: content.caption, mimetype: content.mimetype, fileLength: content.fileLength }, resolvedName || m.pushName);
                    else if (content.video) logOutgoingMessage(targetJid, { video: true, caption: content.caption, mimetype: content.mimetype, fileLength: content.fileLength }, resolvedName || m.pushName);
                    else if (content.document) logOutgoingMessage(targetJid, { document: true, fileName: content.fileName, mimetype: content.mimetype, fileLength: content.fileLength }, resolvedName || m.pushName);
                    else if (content.audio) logOutgoingMessage(targetJid, { audio: true, ptt: content.ptt, mimetype: content.mimetype, seconds: content.seconds }, resolvedName || m.pushName);
                    else if (content.sticker) logOutgoingMessage(targetJid, { sticker: true }, resolvedName || m.pushName);
                    else logOutgoingMessage(targetJid, { text: "[media]" }, resolvedName || m.pushName);
                    return result;
                } catch (err) {
                    logger.error(`[SEND ERROR] sendMessage → ${targetJid}: ${err.message}`);
                    return null;
                }
            },
            notifyOwner: async message => {
                if (!state.isConnected) return;
                const owner = config.ownerNumber;
                if (!owner) return;
                const ownerJid = owner.includes("@") ? owner : `${owner}@s.whatsapp.net`;
                try {
                    const result = await sendWithSessionRecovery(sock, ownerJid, { text: String(message) });
                    storeMessage(result);
                } catch (err) { logger.warn(`notifyOwner gagal: ${err.message}`); }
            }
        };

        if (isCommand) {
            executeCommand(sock, m, ctx).catch(err => {
                if (!/bad mac|prekey/i.test(err?.message || "")) logger.error(chalk.red("[Command Error]"), err?.message || err);
            });

            if (SHOW_MESSAGE_LOG) {
                const ts = new Date().toLocaleTimeString();
                const senderPhoneJid = `${_baseNum(senderJid)}@s.whatsapp.net`;
                const displayChatType = fromMe ? (selfChat ? "SELF" : "PRIVATE") : chatType;
                logMessage({
                    jid: senderPhoneJid, pushName: finalDisplayName || config.botName,
                    chatType: displayChatType, chatJid: displayChatType === "GROUP" ? remoteJid : null,
                    msgType: getMessageType(m), text: commandText, extra: "", ts, isOutgoing: fromMe
                });
            }
            continue;
        }

        if (shouldSkipMessage(m) || shouldSkipOldMessage(m)) continue;

        if (SHOW_MESSAGE_LOG) {
            const ts = new Date().toLocaleTimeString();
            const senderPhoneJid = `${_baseNum(senderJid)}@s.whatsapp.net`;
            const displayChatType = fromMe ? (selfChat ? "SELF" : "PRIVATE") : chatType;
            logMessage({
                jid: senderPhoneJid, pushName: finalDisplayName || config.botName,
                chatType: displayChatType, chatJid: displayChatType === "GROUP" ? remoteJid : null,
                msgType: getMessageType(m), text: extractMessageText(m), extra: formatExtraDetails(m), ts, isOutgoing: fromMe
            });
        }

        if (chatType === "GROUP" && !fromMe) {
            await handleAntilink(sock, m, remoteJid, commandText, ctx);
        }
    }
}

export function invalidateGroupSettingsCache(groupId) { groupSettingsCache.delete(groupId); }
export function invalidateGroupMetadataCache(groupId) { groupMetadataCache.delete(groupId); }

export { handleAntilink, resolvePhoneJid };
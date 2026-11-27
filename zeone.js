// zeone.js – Command Handler + Core Shared (hasil merge)
// Gabungan dari 3 file lama:
//   SECTION 1: Utilities       — dari utils.js  (fungsi bantu)
//   SECTION 2: Logger          — dari logger.js (pino + noise filter stdout/stderr)
//   SECTION 3: Command Handler — dari zeone.js lama (loader, executor, priority queue, rate limit)
//
// Catatan merge: utils & logger ditaruh di file ini karena zeone.js tidak
// mengimport file bot lain, sehingga start.js / message.js / database.js bisa
// mengimport dari sini tanpa circular dependency.
// reportCommand / reportError diimport dinamis dari ./message.js (hasil
// penggabungan reportManager.js + errorCollector.js ke message.js).

import fs from "fs";
import path from "path";
import chalk from "chalk";
import chokidar from "chokidar";
import pino from "pino";
import config from "./config.js";
import { pathToFileURL, fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMMANDS_DIR = path.join(__dirname, "commands");

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1: UTILITIES — fungsi bantu (dari utils.js)
// ═════════════════════════════════════════════════════════════════════════════

export function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function formatDuration(seconds) {
    if (!seconds || seconds < 0) return "00:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatChatType(jid) {
    if (!jid) return "UNKNOWN";
    if (jid.endsWith('@g.us')) return "GROUP";
    if (jid.endsWith('@broadcast')) return "BROADCAST";
    if (jid.endsWith('@newsletter')) return "CHANNEL";
    if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return "PRIVATE";
    return "OTHER";
}

export function extractMessageText(m) {
    if (!m?.message) return "";
    const msg = m.message;

    let inner =
        msg.ephemeralMessage?.message ||
        msg.documentWithCaptionMessage?.message ||
        msg.viewOnceMessageV2?.message ||
        msg.viewOnceMessageV2Extension?.message ||
        msg.viewOnceMessage?.message ||
        msg;

    let text =
        inner.conversation ||
        inner.extendedTextMessage?.text ||
        inner.imageMessage?.caption ||
        inner.videoMessage?.caption ||
        inner.documentMessage?.caption;

    if (text) return text;

    if (inner.imageMessage) return "🖼️ IMAGE";
    if (inner.videoMessage) return "🎥 VIDEO";
    if (inner.documentMessage) return "📄 DOCUMENT";
    if (inner.audioMessage) return inner.audioMessage.ptt ? "🎤 VOICE NOTE" : "🎵 AUDIO";
    if (inner.stickerMessage) return "🖼️ STICKER";
    if (inner.locationMessage) return "📍 LOCATION";
    if (inner.contactMessage) return "👤 CONTACT";
    if (inner.reactionMessage) return "👍 REACTION";
    return "";
}

export function getMessageType(m) {
    if (!m?.message) return "unknown";
    return Object.keys(m.message)[0] || "unknown";
}

export function isSelfChat(remoteJid, fromMe, botNumber, botLid) {
    if (!fromMe) return false;
    // Bandingkan nomor TANPA suffix device di KEDUA sisi: botNumber bisa saja
    // masih memakai bentuk sock.user.id ("62xxx:10") sementara remoteJid chat
    // tidak pernah ber-suffix — tanpa strip, self chat bentuk nomor tidak
    // pernah match dan command self-only gagal "hanya untuk self chat".
    const remoteNumber = remoteJid.split('@')[0].split(':')[0];
    if (remoteNumber === (botNumber?.split(':')[0] || '')) return true;
    if (remoteJid.endsWith('@lid') && botLid) {
        const remoteLidNum = remoteJid.split('@')[0].split(':')[0];
        const botLidNum = botLid.split(':')[0];
        return remoteLidNum === botLidNum;
    }
    return false;
}

export function cleanJid(jid) {
    return jid?.split('@')[0] || '';
}

export function debounce(func, wait) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

export function sanitizeText(text, maxLength = 4096) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().substring(0, maxLength);
}

export function redactPhone(text) {
    if (!text) return '';
    return String(text).replace(/(\d{4})\d{4,}(\d{4})/g, '$1****$2');
}

export async function retryAsync(fn, maxAttempts = 3, baseDelayMs = 500) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt < maxAttempts) {
                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

export function isValidWhatsAppNumber(number) {
    if (!number) return false;
    const clean = number.replace(/\D/g, '');
    return clean.length >= 10 && clean.length <= 15;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2: LOGGER — pino + noise filter, tanpa blokir {} (dari logger.js)
// ═════════════════════════════════════════════════════════════════════════════

const NOISE_PATTERNS = [
    /prekey bundle/i, /closing open session/i, /bad mac/i, /failed to decrypt/i,
    /cannot decrypt/i, /decrypt error/i, /<buffer/i, /hmac/i, /ephemeralkeypair/i,
    /lastremoteephemeralkey/i, /socket received/i, /opening connection/i, /connected to/i,
    /handshake complete/i, /authenticated successfully/i, /closing session/i, /registrationid/i,
    /currentratchet/i, /indexinfo/i, /basekey/i, /chainkey/i, /messagekeys/i, /_chains/i,
    /privkey/i, /pubkey/i, /remoteidentitykey/i, /rootkey/i, /ratchet/i, /libsignal/i,
    /SessionCipher/i, /at Object\.verifyMAC/i, /at SessionCipher\./i, /at _asyncQueueExecutor/i,
    /Failed to decrypt message/i, /Session error:/i, /Closing open session/i, /^[0-9a-f ]{10,}$/i,
    /SessionEntry/, /_chains/, /registrationId/, /currentRatchet/, /ephemeralKeyPair/,
    /lastRemoteEphemeralKey/, /previousCounter/, /rootKey/, /indexInfo/, /baseKeyType/,
    /closed: -1/, /used: \d+/, /created: \d+/, /remoteIdentityKey/,
    /Closing session:/,
    /pubKey: <Buffer /, /privKey: <Buffer /,
    /WebSocket closed/, /reconnecting in/, /Connection lost/, /socket error/,
    /Baileys version/, /starting web/, /using websocket/,
];

const shouldSuppress = (chunk) => {
    if (!chunk) return false;
    const text = typeof chunk === 'string' ? chunk : chunk.toString?.() || '';
    if (!text) return false;
    if (text.includes('[COMMAND]') || text.includes('✅') || text.includes('❌')) return false;
    return NOISE_PATTERNS.some(p => p.test(text));
};

const originalStdout = process.stdout.write;
process.stdout.write = function(chunk, encoding, callback) {
    if (shouldSuppress(chunk)) {
        if (typeof callback === 'function') callback();
        return true;
    }
    return originalStdout.call(this, chunk, encoding, callback);
};

const originalStderr = process.stderr.write;
process.stderr.write = function(chunk, encoding, callback) {
    if (shouldSuppress(chunk)) {
        if (typeof callback === 'function') callback();
        return true;
    }
    return originalStderr.call(this, chunk, encoding, callback);
};

const isNoise = (msg = '') => NOISE_PATTERNS.some(p => p.test(String(msg)));

export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    hooks: {
        logMethod(inputArgs, method) {
            const msg = String(inputArgs[0] || '');
            if (isNoise(msg)) return;
            method.apply(this, inputArgs);
        }
    },
    redact: {
        paths: ['phoneNumber', 'ownerNumber', 'botNumber', 'jid', 'userId'],
        censor: (value) => {
            if (typeof value === 'string') return redactPhone(value);
            return '[REDACTED]';
        }
    },
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: false,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
            ignore: 'pid,hostname',
        },
    },
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3: COMMAND HANDLER — Loader + Executor + Priority Queue + Rate Limit
// (dari zeone.js lama)
// ═════════════════════════════════════════════════════════════════════════════

export let cmdList = new Map();
export function setCmdList(newMap) { cmdList = newMap; }

// Rate limiting
const userRequestTimestamps = new Map();
function checkSlidingWindow(userId, maxRequests = 5, windowMs = 10000) {
    const now = Date.now();
    let timestamps = userRequestTimestamps.get(userId) || [];
    timestamps = timestamps.filter(t => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
        return { allowed: false, retryAfter: timestamps[0] + windowMs - now };
    }
    timestamps.push(now);
    userRequestTimestamps.set(userId, timestamps);
    return { allowed: true };
}

// Priority Queue
const PRIORITY = { HIGH: 0, MEDIUM: 1, LOW: 2 };
let commandQueue = [];
let concurrentCommands = 0;
const MAX_CONCURRENT = config.maxConcurrentCommands || 25;
const COMMAND_TIMEOUT = config.commandTimeout || 100000;
const pendingCommands = new Map();

export function cancelUserCommands(userId) {
    const before = commandQueue.length;
    commandQueue = commandQueue.filter(cmd => cmd.userId !== userId);
    const cancelled = before - commandQueue.length;
    if (cancelled > 0) logger.info(`🛑 Dibatalkan ${cancelled} perintah dari ${cleanJid(userId)}`);
    return cancelled;
}

// Timeout terpusat – menangani error synchronous
function runCommandWithTimeout(fn, ctx, args, commandName, userId) {
    const timeoutKey = `${userId}:${commandName}:${Date.now()}:${Math.random().toString(36).substring(2)}`;
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            pendingCommands.delete(timeoutKey);
            reject(new Error(`Command "${commandName}" timeout setelah ${COMMAND_TIMEOUT / 1000}s`));
        }, COMMAND_TIMEOUT);
        pendingCommands.set(timeoutKey, timeoutId);

        Promise.resolve()
            .then(() => fn(ctx, args))
            .then(() => {
                clearTimeout(timeoutId);
                pendingCommands.delete(timeoutKey);
                resolve();
            })
            .catch(err => {
                clearTimeout(timeoutId);
                pendingCommands.delete(timeoutKey);
                reject(err);
            });
    });
}

function enqueueCommand(resolve, reject, userId, commandName, fn, ctx, args, priority = PRIORITY.MEDIUM) {
    commandQueue.push({ resolve, reject, userId, commandName, fn, ctx, args, priority, timestamp: Date.now() });
    commandQueue.sort((a, b) => a.priority - b.priority || a.timestamp - b.timestamp);
    processCommandQueue();
}

async function processCommandQueue() {
    if (concurrentCommands >= MAX_CONCURRENT || commandQueue.length === 0) return;
    const item = commandQueue.shift();
    if (!item) return;
    const { resolve, reject, userId, commandName, fn, ctx, args } = item;
    concurrentCommands++;
    try {
        await runCommandWithTimeout(fn, ctx, args, commandName, userId);
        resolve();
    } catch (err) {
        reject(err);
    } finally {
        concurrentCommands--;
        setImmediate(processCommandQueue);
    }
}

// Metrik
const metrics = { commandsExecuted: 0, commandsFailed: 0, totalLatency: 0, startTime: Date.now() };
export function getMetrics() {
    const uptime = Math.round((Date.now() - metrics.startTime) / 1000);
    const avgLatency = metrics.commandsExecuted ? (metrics.totalLatency / metrics.commandsExecuted).toFixed(0) : 0;
    return { ...metrics, avgLatency: Number(avgLatency), uptime, queueLength: commandQueue.length, concurrentCommands, maxConcurrent: MAX_CONCURRENT };
}

// Load commands
export async function loadCommands(options = {}) {
    const { silent = false } = options;
    const commands = new Map();
    const logs = [];
    const loadedFiles = new Set();
    const failedFiles = new Set();
    const log = (level, msg) => {
        if (silent) logs.push(msg);
        else if (level === "warn") logger.warn(msg);
        else if (level === "error") logger.error(msg);
        else logger.info(msg);
    };
    try {
        await fs.promises.mkdir(COMMANDS_DIR, { recursive: true });
        const files = await fs.promises.readdir(COMMANDS_DIR);
        const jsFiles = files.filter(f => f.endsWith(".js"));
        for (const file of jsFiles) {
            try {
                const fullPath = path.join(COMMANDS_DIR, file);
                const moduleUrl = pathToFileURL(fullPath).href;
                const cacheBust = `${moduleUrl}?t=${Date.now()}`;
                const cmdModule = await import(cacheBust);
                let command = cmdModule.default;

                if (typeof command === "function") {
                    const baseName = path.basename(file, ".js");
                    command = { name: baseName, alias: [], description: "", run: command };
                }
                if (!command || typeof command !== "object") {
                    log("warn", `⚠️ ${file} export default bukan objek atau fungsi, skipping`);
                    failedFiles.add(file);
                    continue;
                }
                if (typeof command.run !== "function") {
                    log("warn", `⚠️ ${file} tidak memiliki properti "run" yang berupa fungsi, skipping`);
                    failedFiles.add(file);
                    continue;
                }
                const cmdName = (command.name && typeof command.name === 'string') ? command.name : path.basename(file, ".js");
                if (!cmdName) {
                    log("warn", `⚠️ ${file} tidak memiliki nama, skipping`);
                    failedFiles.add(file);
                    continue;
                }
                if (commands.has(cmdName)) {
                    log("warn", `⚠️ Nama command "${cmdName}" duplikat dari file ${file}, menimpa...`);
                }
                commands.set(cmdName, command);
                if (Array.isArray(command.alias)) {
                    for (const alias of command.alias) {
                        if (alias === cmdName) continue;
                        if (commands.has(alias)) {
                            log("warn", `⚠️ Alias "${alias}" sudah digunakan, lewati`);
                            continue;
                        }
                        commands.set(alias, command);
                    }
                }
                log("info", chalk.green(`✓ Loaded: ${cmdName}`));
                loadedFiles.add(file);
            } catch (err) {
                log("error", chalk.red(`❌ Error loading ${file}: ${err?.message || err}`));
                failedFiles.add(file);
            }
        }
        const uniqueCount = getUniqueCommandCount(commands);
        log("info", chalk.green(`✅ Commands dimuat: ${uniqueCount} file`));
    } catch (err) {
        log("error", chalk.red("❌ Gagal membaca direktori commands: ") + err);
    }
    return { commands, logs, loadedFiles, failedFiles };
}

// Hot reload (debounce sekarang pakai fungsi dari SECTION 1, duplikat lokal dihapus)
export function watchCommands(onReload) {
    const watcher = chokidar.watch(COMMANDS_DIR, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } });
    const reload = debounce(async (filePath) => {
        logger.info(chalk.blue(`🔍 Detected change: ${path.basename(filePath)}, reloading...`));
        try {
            const { commands } = await loadCommands({ silent: true });
            setCmdList(commands);
            onReload(commands);
        } catch (err) { logger.error(chalk.red("❌ Hot-reload gagal:"), err?.message || err); }
    }, 500);
    watcher.on("add", reload); watcher.on("change", reload); watcher.on("unlink", reload);
    watcher.on("error", err => logger.error(chalk.red("❌ File watcher error:"), err?.message || err));
}

// Error reporting
export async function sendErrorToOwner(sock, ownerJid, report) {
    if (!sock || !ownerJid || !report) return;
    try {
        const text = `🚨 *ERROR REPORT*\n\n📅 *Waktu:* ${report.timestamp}\n👤 *User:* ${report.userId}\n💬 *Chat Type:* ${report.chatType}${report.fromChat ? `\n📍 *Dari Chat:* ${report.fromChat}` : ''}\n📝 *Command:* ${report.command}\n🔧 *Error Type:* ${report.errorType}\n📄 *Message:* ${report.message}\n\n📚 *Stack:*\n\`\`\`\n${report.stack?.substring(0, 1500) || "No stack"}\n\`\`\``;
        await sock.sendMessage(ownerJid, { text });
        logger.info(chalk.blue("📤 Error report sent to owner"));
    } catch (err) { logger.error(chalk.red("❌ Gagal mengirim error ke owner:"), err.message); }
}

// Execute command
export async function executeCommand(sock, m, ctx) {
    const text = extractMessageText(m);
    const prefix = config.prefix;
    if (!text.startsWith(prefix)) return;

    const rawArgs = text.slice(prefix.length).trim().split(/\s+/);
    const cmdName = rawArgs.shift()?.toLowerCase();
    if (!cmdName || !cmdList.has(cmdName)) {
        logger.info(chalk.yellow(`⚠️ Command "${cmdName}" tidak ditemukan di cmdList`));
        return;
    }
    const args = rawArgs.map(a => sanitizeText(a, 512));
    const userId = ctx.isGroup ? ctx.sender : ctx.id;
    logger.info(chalk.cyan(`[COMMAND] ${prefix}${cmdName} | ${ctx.chatType} | ${cleanJid(userId)}`));

    const rateLimit = checkSlidingWindow(userId);
    if (!rateLimit.allowed) {
        logger.warn(chalk.yellow(`⚠️ Rate limit: ${cmdName} for ${cleanJid(userId)}`));
        try { await ctx.reply(`⏳ Terlalu cepat. Coba lagi dalam ${Math.ceil(rateLimit.retryAfter / 1000)} detik.`); } catch {}
        return;
    }
    const command = cmdList.get(cmdName);
    if (!command) {
        logger.error(chalk.red(`❌ Command "${cmdName}" ada di Map tapi nilainya undefined/null`));
        return;
    }
    const start = Date.now();

    if (concurrentCommands >= MAX_CONCURRENT) {
        return new Promise((resolve, reject) => {
            let priority = PRIORITY.LOW;
            if (ctx.isSelf || ctx.isOwner || cleanJid(userId) === cleanJid(config.ownerNumber || '')) priority = PRIORITY.HIGH;
            else if (ctx.isGroup && ctx.isAdmin) priority = PRIORITY.MEDIUM;
            enqueueCommand(resolve, reject, userId, cmdName, command.run, ctx, args, priority);
        }).then(() => {
            metrics.commandsExecuted++;
            metrics.totalLatency += Date.now() - start;
        }).catch(err => handleCommandError(sock, ctx, cmdName, args, err, userId));
    }

    concurrentCommands++;
    try {
        await runCommandWithTimeout(command.run, ctx, args, cmdName, userId);
        metrics.commandsExecuted++;
        metrics.totalLatency += Date.now() - start;
        import("./message.js").then(({ reportCommand }) => reportCommand({ command: cmdName, userId: cleanJid(userId), chatType: ctx.chatType, latency: Date.now() - start }).catch(() => {})).catch(() => {});
    } catch (err) {
        await handleCommandError(sock, ctx, cmdName, args, err, userId);
    } finally {
        concurrentCommands--;
        if (commandQueue.length > 0) setImmediate(processCommandQueue);
    }
}

async function handleCommandError(sock, ctx, cmdName, args, err, userId) {
    metrics.commandsFailed++;
    const msgErr = String(err?.message || "");
    if (/bad mac|prekey/i.test(msgErr)) return;
    const isTimeout = msgErr.includes("timeout");
    const report = {
        timestamp: new Date().toISOString(),
        userId: cleanJid(userId),
        chatType: ctx.chatType,
        fromChat: ctx.id,
        command: cmdName,
        args: args.join(" ").substring(0, 200),
        errorType: err.name || "Error",
        message: isTimeout ? `${err.message} (timeout ${COMMAND_TIMEOUT / 1000} detik)` : err.message,
        stack: err.stack
    };
    logger.error(chalk.red(`⚠️ Command Error [${cmdName}]: ${err.stack || err.message}`));
    import("./message.js").then(({ reportError }) => reportError(report).catch(() => {})).catch(() => {});

    // Semua error HANYA dikirim ke nomor owner (terdaftar di .env) — tidak
    // ditampilkan di chat private dengan orang lain maupun di chat grup.
    if (!config.ownerNumber) return;
    const ownerJid = config.ownerNumber.includes("@") ? config.ownerNumber : `${config.ownerNumber}@s.whatsapp.net`;
    await sendErrorToOwner(sock, ownerJid, report);
}

// Status command
export const statusbot = {
    name: "statusbot", alias: ["botstatus"], description: "Tampilkan metrik internal bot",
    run: async ctx => {
        const m = getMetrics();
        await ctx.reply(`📊 *Bot Metrics*\n\n✅ Perintah sukses : ${m.commandsExecuted}\n❌ Gagal           : ${m.commandsFailed}\n⏱️ Latensi rata2  : ${m.avgLatency}ms\n📦 Antrian         : ${m.queueLength}\n🔄 Berjalan        : ${m.concurrentCommands}/${m.maxConcurrent}\n🕒 Uptime          : ${Math.floor(m.uptime / 3600)}h ${Math.floor((m.uptime % 3600) / 60)}m`);
    }
};

export function getUniqueCommandCount(map) {
    const unique = new Set();
    for (const cmd of map.values()) unique.add(cmd);
    return unique.size;
}

// export untuk unit test
export { checkSlidingWindow, runCommandWithTimeout };

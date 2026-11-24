// start.js – Connection Handler / Entry Point ZeoneBot
// Koneksi, reconnect + backoff, circuit breaker, pairing, banner, call handler.
// Hasil merge: logger & utils dari zeone.js; reportManager & errorCollector
// yang tadinya file terpisah (folder reports/) sekarang digabung di message.js.

import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import {
    loadCommands,
    watchCommands,
    setCmdList,
    cmdList,
    getUniqueCommandCount,
    logger,
    cleanJid,
    formatFileSize
} from "./zeone.js";
import { handleIncomingMessages, installGlobalErrorHandlers, reportSystem } from "./message.js";
import pino from "pino";
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import figlet from "figlet";
import config from './config.js';
import { getGlobalSettings } from './database.js';

installGlobalErrorHandlers();

export const botState = {
    sock: null,
    saveCreds: null,
    get cmdList() { return cmdList; },
    set cmdList(val) { setCmdList(val); },
    skipOldMessages: false,
    safeSyncReady: false,
    botNumber: config.botNumber || '',
    botLid: '',
    isConnected: false,
    isReady: false,
    startTime: Date.now(),
};

const SESSION_PATH = "session";
const PAIRING_RETRY_DELAY = 3000;
const BROWSER_META = ["Ubuntu", "Chrome", "110.0.5585.95"];
const RECONNECT_BASE = 2000, RECONNECT_MAX = 60000;
const baileysLogger = pino({ level: 'silent' });

process.on('unhandledRejection', async (reason) => {
    const msg = String(reason?.message || reason || '');
    if (/Connection Closed|timed out|Socket closed|rate-overlimit/i.test(msg)) return;
    logger.error(`[UNHANDLED REJECTION] ${msg}`);
    if (botState.sock && config.ownerNumber) {
        const ownerJid = config.ownerNumber.includes('@') ? config.ownerNumber : `${config.ownerNumber}@s.whatsapp.net`;
        await botState.sock.sendMessage(ownerJid, { text: `🚨 *UNHANDLED REJECTION*\n\n${String(reason?.stack || reason).substring(0, 2000)}` }).catch(() => {});
    }
});
process.on('uncaughtException', async (err) => {
    const msg = String(err?.message || '');
    if (/Connection Closed|Socket closed/i.test(msg)) return;
    logger.error(`[UNCAUGHT EXCEPTION] ${err.stack || err}`);
    if (botState.sock && config.ownerNumber) {
        const ownerJid = config.ownerNumber.includes('@') ? config.ownerNumber : `${config.ownerNumber}@s.whatsapp.net`;
        await botState.sock.sendMessage(ownerJid, { text: `💥 *UNCAUGHT EXCEPTION*\n\n${err.stack?.substring(0, 2000)}` }).catch(() => {});
    }
    if (botState.saveCreds) await botState.saveCreds().catch(() => {});
    process.exit(1);
});

const connectionState = {
    restarting: false,
    reconnectAttempts: 0,
    circuitBreaker: "CLOSED",
    circuitFailureCount: 0,
    MAX_CIRCUIT_FAILURES: config.maxCircuitFailures || 5,
    CIRCUIT_RESET_MS: config.circuitResetMs || 20000,
    lastConnectedTime: 0,
    isFirstConnection: true,
    currentVersion: null,
    reconnectTimer: null,
};

function updateCircuitBreaker(success) {
    if (success) { connectionState.circuitBreaker = "CLOSED"; connectionState.circuitFailureCount = 0; logger.info("✅ Circuit Breaker: CLOSED"); return; }
    connectionState.circuitFailureCount++;
    if (connectionState.circuitFailureCount >= connectionState.MAX_CIRCUIT_FAILURES) {
        connectionState.circuitBreaker = "OPEN";
        logger.warn(`⚠️ Circuit Breaker: OPEN (${connectionState.circuitFailureCount} failures)`);
        setTimeout(() => {
            connectionState.circuitBreaker = "CLOSED";
            connectionState.circuitFailureCount = 0;
            logger.info("🔁 Circuit Breaker: RESET ke CLOSED");
            if (!botState.isConnected) {
                logger.info("🔌 Mencoba reconnect setelah circuit breaker reset...");
                attemptReconnect();
            }
        }, connectionState.CIRCUIT_RESET_MS);
    }
}

function nextBackoff(attempts) {
    const base = Math.min(RECONNECT_BASE * Math.pow(2, attempts), RECONNECT_MAX);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    return Math.floor(base + jitter);
}

async function attemptReconnect() {
    if (connectionState.restarting || botState.isConnected) return;

    if (connectionState.reconnectTimer) {
        clearTimeout(connectionState.reconnectTimer);
        connectionState.reconnectTimer = null;
    }

    connectionState.restarting = true;
    connectionState.reconnectAttempts++;
    const wait = nextBackoff(connectionState.reconnectAttempts);
    logger.info(`🔁 Reconnect dalam ${Math.round(wait / 1000)}s...`);

    connectionState.reconnectTimer = setTimeout(async () => {
        connectionState.reconnectTimer = null;
        try {
            const { version } = await fetchLatestBaileysVersion();
            const { state, saveCreds: newSave } = await useMultiFileAuthState(SESSION_PATH);
            const z = await makeWASocket({ version, logger: baileysLogger, auth: state, browser: BROWSER_META, syncFullHistory: false });
            botState.saveCreds = newSave;
            botState.sock = z;
            await attachEventHandlers(z, newSave);
            z.ev.on("creds.update", newSave);
            connectionState.restarting = false;
            updateCircuitBreaker(true);
        } catch (e) {
            logger.error(`Auto-reconnect gagal: ${e.message}`);
            connectionState.restarting = false;
            updateCircuitBreaker(false);
            if (connectionState.reconnectAttempts >= config.maxReconnectAttempts) {
                logger.warn("Gagal reconnect maksimal. Hapus session dan keluar.");
                try { await fs.promises.rm(SESSION_PATH, { recursive: true, force: true }); } catch {}
                process.exit(0);
            }
        }
    }, wait);
}

function centerText(text, width) {
    const padding = Math.max(0, Math.floor((width - text.length) / 2));
    return ' '.repeat(padding) + text;
}

function printBanner() {
    try {
        const banner = figlet.textSync("ZEONE BOT", { horizontalLayout: "default" });
        const lines = banner.split('\n');
        const maxWidth = lines.reduce((max, l) => Math.max(max, l.length), 0);
        console.log(banner);
        console.log(centerText("Developer by: Ahri De Valiente", maxWidth));
    } catch {
        console.log("=== ZEONE BOT ===");
        console.log("Developer by: Ahri De Valiente");
    }
}

function printSystemPanel(userNumber = "-") {
    const mem = process.memoryUsage();
    const uptime = os.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const totalCmd = getUniqueCommandCount(botState.cmdList);
    console.log("=============={SYSTEM INFO}=============");
    console.log(`| USER             : ${userNumber}`);
    console.log(`| NODE.JS          : ${process.version}`);
    console.log(`| OS PLATFORM      : ${os.platform()}`);
    console.log(`| STATUS           : CONNECTED`);
    console.log(`| UPTIME           : ${hours}h ${mins}m`);
    console.log(`| RAM USED         : ${formatFileSize(mem.rss)} / ${formatFileSize(os.totalmem())}`);
    console.log(`| COMMAND LOADED   : ${totalCmd} file`);
    try { console.log(`| CPU LOAD         : ${os.loadavg()[0].toFixed(2)}`); } catch { console.log(`| CPU LOAD         : -`); }
    console.log("=========================================");
}

async function pairingFlow(sock) {
    await new Promise(r => setTimeout(r, PAIRING_RETRY_DELAY));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const askNumber = () => new Promise(resolve => rl.question("📱 Masukkan nomor WhatsApp (format: 628xxx): ", resolve));
    let number = '';
    while (true) {
        number = (await askNumber()).replace(/\D/g, '');
        if (number.length >= 10) { console.log(`✓ Nomor valid: ${number}`); break; }
        console.log("❌ Format nomor tidak valid, coba lagi.");
    }
    rl.close();
    try {
        const code = await sock.requestPairingCode(number);
        console.log(`\n📟 PAIRING CODE: ${code}\n`);
    } catch (err) { logger.error(`❌ Gagal request pairing code: ${err.message}`); }
}

async function cleanupOldSessions() {
    try {
        const files = await fs.promises.readdir(SESSION_PATH).catch(() => []);
        for (const file of files) {
            if (file.endsWith('.tmp')) await fs.promises.unlink(path.join(SESSION_PATH, file)).catch(() => {});
        }
    } catch {}
}

async function attachEventHandlers(sock, saveCreds) {
    sock.ev.on("messages.upsert", async msg => {
        const firstMsg = msg.messages?.[0];
        if (!firstMsg?.message) return;
        const msgType = Object.keys(firstMsg.message)[0];
        if (msgType === "messageContextInfo") return;
        try {
            await handleIncomingMessages(sock, msg, botState);
        } catch (err) {
            const em = String(err?.message || "").toLowerCase();
            if (!/bad mac|prekey bundle|failed to decrypt|sessionerror|closing open session/i.test(em))
                logger.error(`⚠️ Error menangani pesan: ${err.message}`);
        }
    });

    let keepAliveInterval = null;
    sock.ev.on("connection.update", async update => {
        const { connection, lastDisconnect } = update;
        if (connection === "open") {
            if (connectionState.reconnectTimer) {
                clearTimeout(connectionState.reconnectTimer);
                connectionState.reconnectTimer = null;
            }

            process.stdout.write('\x1bc');
            await new Promise(r => setTimeout(r, 50));
            botState.isReady = false;
            const user = cleanJid(sock.user?.id) || "-";
            const now = Date.now();
            const offlineDuration = now - connectionState.lastConnectedTime;
            connectionState.lastConnectedTime = now;
            if (offlineDuration > 5 * 60 * 1000 && !connectionState.isFirstConnection) {
                logger.warn(`Bot offline ${Math.round(offlineDuration / 60000)} menit, skip pesan lama.`);
                botState.skipOldMessages = true;
                setTimeout(() => { botState.skipOldMessages = false; }, 10000);
            }
            connectionState.isFirstConnection = false;
            botState.botNumber = cleanJid(sock.user?.id);
            botState.botLid = cleanJid(sock.user?.lid || sock.authState?.creds?.me?.lid);
            botState.sock = sock;
            botState.saveCreds = saveCreds;
            printBanner();
            console.log("\n🔄 Memuat commands...\n");
            const { commands, logs } = await loadCommands({ silent: true });
            setCmdList(commands);
            botState.cmdList = commands;
            printSystemPanel(user);
            for (const line of logs) console.log(line);
            watchCommands(newList => {
                setCmdList(newList);
                botState.cmdList = newList;
                logger.info(`♻️ Commands di-reload (${getUniqueCommandCount(newList)} file)`);
            });
            logger.info(`✅ Terhubung sebagai: ${user}`);
            reportSystem('start', 'Bot started successfully').catch(() => {});
            botState.isConnected = true;
            botState.isReady = true;
            connectionState.restarting = false;
            connectionState.reconnectAttempts = 0;
            connectionState.circuitBreaker = "CLOSED";
            if (keepAliveInterval) clearInterval(keepAliveInterval);
            keepAliveInterval = setInterval(async () => {
                try { if (sock.user && botState.isConnected) await sock.sendPresenceUpdate('available'); } catch {}
            }, config.keepAliveIntervalMs);
            return;
        }
        if (connection === "close") {
            botState.isConnected = false;
            if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
            const statusCode = lastDisconnect?.error?.output?.payload?.statusCode;
            const reason = statusCode || lastDisconnect?.error?.code || lastDisconnect?.error?.message || "unknown";
            logger.warn(`⚠️ Koneksi terputus [${reason}]`);
            if (String(reason) === "401" || String(reason) === "403") {
                logger.error("Kredensial invalid. Hapus session dan scan ulang.");
                process.exit(1);
            }
            if (!connectionState.restarting && connectionState.circuitBreaker !== "OPEN") {
                attemptReconnect();
            }
        }
    });

    sock.ev.on('call', async (calls) => {
        if (!sock.user || !botState.isConnected) return;
        const callArray = Array.isArray(calls) ? calls : [calls];
        for (const call of callArray) {
            try {
                const global = await getGlobalSettings();
                if (global.autoRejectCall?.enabled) {
                    const callerJid = call.from;
                    const rejectMsg = global.autoRejectCall?.message || "Maaf, bot tidak menerima panggilan.";
                    await sock.rejectCall(call.id, call.from).catch(() => {});
                    await sock.sendMessage(callerJid, { text: rejectMsg }).catch(() => {});
                    logger.info(`📞 Panggilan dari ${cleanJid(callerJid)} ditolak otomatis`);
                }
            } catch {}
        }
    });

    sock.ev.on("creds.update", saveCreds);
}

function setupSafeExit(saveCreds) {
    const handler = async (signal) => {
        logger.info(`\n📥 Menyimpan kredensial (${signal})...`);
        try { await saveCreds(); logger.info("✅ Kredensial tersimpan."); } catch (e) { logger.error("Gagal simpan kredensial:", e.message); }
        process.exit(0);
    };
    process.on("SIGINT", () => handler("SIGINT"));
    process.on("SIGTERM", () => handler("SIGTERM"));
}

export async function start() {
    botState.isConnected = false;
    botState.isReady = false;
    try {
        await cleanupOldSessions();
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
        const { version } = await fetchLatestBaileysVersion();
        connectionState.currentVersion = version;
        setupSafeExit(saveCreds);
        const sock = await makeWASocket({
            version,
            logger: baileysLogger,
            auth: state,
            browser: BROWSER_META,
            printQRInTerminal: false,
            mobile: false,
            markOnlineOnConnect: true,
            syncFullHistory: false,
            // false: pesan keluar bot TIDAK di-emit ulang ke messages.upsert.
            // Jika true, setiap pesan yang dikirim bot ter-echo balik ke handler
            // dan ter-log OUTGOING dua kali (log langsung + log echo).
            emitOwnEvents: false
        });
        botState.sock = sock;
        botState.saveCreds = saveCreds;
        await attachEventHandlers(sock, saveCreds);
        if (!sock.authState?.creds?.me) await pairingFlow(sock);
        sock.ev.on("creds.update", saveCreds);
    } catch (err) {
        logger.error(`❌ Fatal error saat start(): ${err?.message || err}`);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) start();

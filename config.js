// config.js
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const required = ['DB_ENCRYPTION_KEY', 'REPORT_ENCRYPTION_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    console.error(`   Buat file .env dengan isi minimal:\n   ${missing.map(k => `${k}=your_value`).join('\n   ')}`);
    process.exit(1);
}

export default {
    debugMode: process.env.DEBUG_MODE === 'true' || false,
    botNumber: (process.env.BOT_NUMBER || '').trim(),
    botName: (process.env.BOT_NAME || 'ZeoneBot').trim(),
    botImageUrl: (process.env.BOT_IMAGE_URL || '').trim(),
    ownerNumber: (process.env.OWNER_NUMBER || '').trim(),
    publicMode: process.env.PUBLIC_MODE !== 'false',
    prefix: (process.env.CMD_PREFIX || '!').trim(),
    multiprefix: process.env.MULTIPREFIX === 'true' || false,
    maxCircuitFailures: parseInt(process.env.MAX_CIRCUIT_FAILURES) || 5,
    circuitResetMs: parseInt(process.env.CIRCUIT_RESET_MS) || 20000,
    rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW) || 1000,
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 5,
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 10000,
    commandTimeout: parseInt(process.env.COMMAND_TIMEOUT) || 100000,
    maxConcurrentCommands: parseInt(process.env.MAX_CONCURRENT_COMMANDS) || 25,
    keepAliveIntervalMs: parseInt(process.env.KEEP_ALIVE_INTERVAL_MS) || 15 * 60 * 1000,
    maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 5,
    showMessageLog: process.env.SHOW_MESSAGE_LOG !== 'false',
    logOutgoing: process.env.LOG_OUTGOING !== 'false',
    dbEncryptionKey: (process.env.DB_ENCRYPTION_KEY || '').trim(),
    reportEncryptionKey: (process.env.REPORT_ENCRYPTION_KEY || '').trim(),
    githubToken: process.env.GITHUB_TOKEN?.trim() || null,
};
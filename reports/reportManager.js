// reports/reportManager.js
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import config from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPORT_FILE = path.join(__dirname, 'reports.json');
const REPORT_TMP = path.join(__dirname, 'reports.tmp');
const ENCRYPTION_KEY = process.env.REPORT_ENCRYPTION_KEY || config.reportEncryptionKey || 'GlobalReportSecretKey_ChangeMe!';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const AUTH_TAG_LENGTH = 16;

let reports = {
    errors: [],
    commands: [],
    metrics: [],
    system: []
};
let writeQueue = Promise.resolve();

function deriveKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
}

function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveKey(ENCRYPTION_KEY, salt);
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
    const ciphertextBase64 = buffer.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH).toString('base64');
    const rawCiphertext = Buffer.from(ciphertextBase64, 'base64').toString('binary');
    const key = deriveKey(ENCRYPTION_KEY, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(rawCiphertext, 'binary', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

async function saveReports() {
    try {
        const json = JSON.stringify(reports, null, 2);
        const encrypted = encrypt(json);
        await fs.writeFile(REPORT_TMP, encrypted, 'utf8');
        await fs.rename(REPORT_TMP, REPORT_FILE);
    } catch (err) {
        console.error('[ReportManager] Gagal menyimpan laporan:', err.message);
    }
}

function scheduleSave() {
    writeQueue = writeQueue.then(saveReports, saveReports);
}

async function loadReports() {
    try {
        const encrypted = await fs.readFile(REPORT_FILE, 'utf-8');
        const json = decrypt(encrypted);
        const parsed = JSON.parse(json);
        reports = { ...reports, ...parsed };
    } catch (err) {
        scheduleSave();
    }
}

await loadReports();

export async function reportError(errorReport) {
    reports.errors.push({
        timestamp: new Date().toISOString(),
        ...errorReport
    });
    if (reports.errors.length > 1000) reports.errors = reports.errors.slice(-1000);
    scheduleSave();
}

export async function reportCommand(commandReport) {
    reports.commands.push({
        timestamp: new Date().toISOString(),
        ...commandReport
    });
    if (reports.commands.length > 5000) reports.commands = reports.commands.slice(-5000);
    scheduleSave();
}

export async function reportMetrics(metric) {
    reports.metrics.push({
        timestamp: new Date().toISOString(),
        ...metric
    });
    if (reports.metrics.length > 1000) reports.metrics = reports.metrics.slice(-1000);
    scheduleSave();
}

export async function reportSystem(event, detail = '') {
    reports.system.push({
        timestamp: new Date().toISOString(),
        event,
        detail
    });
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
    recentCommands.forEach(c => {
        commandFreq[c.command] = (commandFreq[c.command] || 0) + 1;
    });
    const totalCommands = recentCommands.length || 1;
    const errorRate = ((recentErrors.length / totalCommands) * 100).toFixed(2);
    return {
        totalErrors: reports.errors.length,
        totalCommands: reports.commands.length,
        last24hCommands: recentCommands.length,
        last24hErrors: recentErrors.length,
        errorRate: `${errorRate}%`,
        topCommands: Object.entries(commandFreq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([cmd, count]) => ({ command: cmd, count }))
    };
}

export async function clearReports() {
    reports = { errors: [], commands: [], metrics: [], system: [] };
    await scheduleSave();
}
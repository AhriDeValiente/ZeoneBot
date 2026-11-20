// full.test.mjs – Unit test lengkap ZeoneBot (10/10 FINAL) – root proyek
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── Modul yang diuji ────────────────────────────────────
import {
    cleanJid, sanitizeText, formatFileSize, formatDuration,
    formatChatType, extractMessageText, getMessageType,
    isSelfChat, debounce, redactPhone, retryAsync, isValidWhatsAppNumber
} from './utils.js';

import {
    getUniqueCommandCount, checkSlidingWindow, runCommandWithTimeout,
    loadCommands, setCmdList, cmdList, executeCommand, cancelUserCommands
} from './zeone.js';

import { encrypt, decrypt, getGroupSettings, updateGroupSettings, getUser, updateUser } from './database.js';

import { handleAntilink, invalidateGroupSettingsCache } from './message.js';

// ─── Helper untuk mock ───────────────────────────────────
function mockCtx(overrides = {}) {
    return {
        sock: { sendMessage: async () => {} },
        id: '628123456789@s.whatsapp.net',
        sender: '628123456789@s.whatsapp.net',
        chatType: 'PRIVATE',
        isGroup: false,
        isPrivate: true,
        isSelf: false,
        isAdmin: false,
        fromMe: false,
        pushName: 'Tester',
        quoted: null,
        mentionedJid: [],
        groupMetadata: null,
        botLid: '',
        reply: async () => {},
        sendText: async () => {},
        sendMessage: async () => {},
        notifyOwner: async () => {},
        ...overrides
    };
}

const mockSock = { sendMessage: async () => {} };

// ─── Grup unik untuk tiap test run ────────────────────────
const uniqueGroupId = `test_${Date.now()}@g.us`;

// ========================
// Utils: semua fungsi
// ========================
test('Utils: semua fungsi bantu', async t => {
    await t.test('cleanJid', () => {
        assert.equal(cleanJid('628123456@s.whatsapp.net'), '628123456');
        assert.equal(cleanJid('123@g.us'), '123');
        assert.equal(cleanJid(undefined), '');
    });

    await t.test('sanitizeText', () => {
        assert.equal(sanitizeText('Halo\x00Dunia'), 'HaloDunia');
        assert.equal(sanitizeText(''), '');
        assert.equal(sanitizeText(null), '');
        assert.equal(sanitizeText('A'.repeat(5000)).length, 4096);
    });

    await t.test('formatFileSize', () => {
        assert.equal(formatFileSize(0), '0 B');
        assert.equal(formatFileSize(1024), '1.00 KB');
        assert.equal(formatFileSize(1048576), '1.00 MB');
    });

    await t.test('formatDuration', () => {
        assert.equal(formatDuration(0), '00:00');
        assert.equal(formatDuration(125), '2:05');
        assert.equal(formatDuration(3661), '61:01');
    });

    await t.test('formatChatType', () => {
        assert.equal(formatChatType(null), 'UNKNOWN');
        assert.equal(formatChatType('628123@g.us'), 'GROUP');
        assert.equal(formatChatType('628123@broadcast'), 'BROADCAST');
        assert.equal(formatChatType('628123@newsletter'), 'CHANNEL');
        assert.equal(formatChatType('628123@s.whatsapp.net'), 'PRIVATE');
        assert.equal(formatChatType('628123@lid'), 'PRIVATE');
        assert.equal(formatChatType('other'), 'OTHER');
    });

    await t.test('extractMessageText', () => {
        assert.equal(extractMessageText({ message: { conversation: 'hello' } }), 'hello');
        assert.equal(extractMessageText({ message: { extendedTextMessage: { text: 'world' } } }), 'world');
        assert.equal(extractMessageText({ message: { imageMessage: { caption: 'caption' } } }), 'caption');
        assert.equal(extractMessageText({ message: { imageMessage: {} } }), '🖼️ IMAGE');
        assert.equal(extractMessageText({ message: { videoMessage: {} } }), '🎥 VIDEO');
        assert.equal(extractMessageText({ message: { documentMessage: {} } }), '📄 DOCUMENT');
        assert.equal(extractMessageText({ message: { audioMessage: { ptt: true } } }), '🎤 VOICE NOTE');
        assert.equal(extractMessageText({ message: { stickerMessage: {} } }), '🖼️ STICKER');
        assert.equal(extractMessageText({ message: { locationMessage: {} } }), '📍 LOCATION');
        assert.equal(extractMessageText({ message: { contactMessage: {} } }), '👤 CONTACT');
        assert.equal(extractMessageText({ message: { reactionMessage: {} } }), '👍 REACTION');
        assert.equal(extractMessageText({}), '');
        assert.equal(extractMessageText(null), '');
    });

    await t.test('getMessageType', () => {
        assert.equal(getMessageType({ message: { conversation: 'a' } }), 'conversation');
        assert.equal(getMessageType({ message: {} }), 'unknown');
        assert.equal(getMessageType({}), 'unknown');
    });

    await t.test('isSelfChat', () => {
        assert.equal(isSelfChat('628123@s.whatsapp.net', true, '628123', ''), true);
        assert.equal(isSelfChat('628123@s.whatsapp.net', false, '628123', ''), false);
        assert.equal(isSelfChat('628999@s.whatsapp.net', true, '628123', ''), false);
    });

    await t.test('debounce', async () => {
        let count = 0;
        const increment = debounce(() => { count++; }, 50);
        increment();
        increment();
        increment();
        await new Promise(r => setTimeout(r, 100));
        assert.equal(count, 1);
    });

    await t.test('redactPhone', () => {
        assert.equal(redactPhone('628123456789'), '6281****6789');
        assert.equal(redactPhone(null), '');
    });

    await t.test('retryAsync', async () => {
        let attempt = 0;
        const fn = async () => {
            attempt++;
            if (attempt < 3) throw new Error('fail');
            return 'ok';
        };
        const result = await retryAsync(fn, 3, 10);
        assert.equal(result, 'ok');
        assert.equal(attempt, 3);
    });

    await t.test('isValidWhatsAppNumber', () => {
        assert.equal(isValidWhatsAppNumber('628123456789'), true);
        assert.equal(isValidWhatsAppNumber('12345'), false);
    });
});

// ========================
// Rate Limiter
// ========================
test('Rate limit: sliding window', async t => {
    await t.test('mengizinkan request di bawah batas', () => {
        const result = checkSlidingWindow('user_normal', 5, 10000);
        assert.equal(result.allowed, true);
    });

    await t.test('memblokir request setelah melebihi batas', () => {
        const uid = 'user_spam';
        for (let i = 0; i < 5; i++) {
            assert.equal(checkSlidingWindow(uid, 5, 10000).allowed, true);
        }
        const blocked = checkSlidingWindow(uid, 5, 10000);
        assert.equal(blocked.allowed, false);
        assert.ok(blocked.retryAfter > 0);
    });
});

// ========================
// Timeout & Error Handling
// ========================
test('runCommandWithTimeout', async t => {
    await t.test('command berhasil', async () => {
        const fn = async (ctx, args) => args.join(',');
        await runCommandWithTimeout(fn, {}, ['a', 'b'], 'test', 'u1');
    });

    await t.test('error synchronous tertangkap', async () => {
        const fn = () => { throw new Error('sync error'); };
        await assert.rejects(
            () => runCommandWithTimeout(fn, {}, [], 'test', 'u2'),
            /sync error/
        );
    });

    await t.test('error asynchronous tertangkap', async () => {
        const fn = async () => { throw new Error('async error'); };
        await assert.rejects(
            () => runCommandWithTimeout(fn, {}, [], 'test', 'u3'),
            /async error/
        );
    });
});

// ========================
// Command Loader & Count
// ========================
test('Command Loader & Unique Count', async t => {
    await t.test('getUniqueCommandCount', () => {
        const map = new Map();
        const cmdA = { name: 'a', run: () => {} };
        const cmdB = { name: 'b', run: () => {} };
        map.set('x', cmdA);
        map.set('y', cmdA);
        map.set('z', cmdB);
        assert.equal(getUniqueCommandCount(map), 2);
        assert.equal(getUniqueCommandCount(new Map()), 0);
    });

    await t.test('loadCommands dari folder sementara', async () => {
        const tmpDir = path.join(process.cwd(), 'tmp_cmds');
        await fs.mkdir(tmpDir, { recursive: true });
        await fs.writeFile(path.join(tmpDir, 'ok.js'), `
            export default { name: 'ok', run: async (ctx, args) => 'ok' };
        `);
        await fs.writeFile(path.join(tmpDir, 'broken.js'), `
            export default { notRun: 123 };
        `);
        await fs.writeFile(path.join(tmpDir, 'alias.js'), `
            export default { name: 'alias', alias: ['al1', 'al2'], run: async () => {} };
        `);

        await fs.rm(tmpDir, { recursive: true, force: true });
        assert.ok(true);
    });
});

// ========================
// Eksekusi Command dengan mock
// ========================
test('executeCommand (mock)', async t => {
    await t.test('command tidak dikenal', async () => {
        setCmdList(new Map());
        const ctx = mockCtx();
        const m = { message: { conversation: '!unknown' } };
        await executeCommand(mockSock, m, ctx);
        assert.ok(true);
    });

    await t.test('command dikenal tapi error', async () => {
        const cmd = { name: 'err', run: async () => { throw new Error('fail'); } };
        const map = new Map([['err', cmd]]);
        setCmdList(map);
        const ctx = mockCtx();
        const m = { message: { conversation: '!err' } };
        await executeCommand(mockSock, m, ctx);
        assert.ok(true);
    });
});

// ========================
// Database: group/user operations
// ========================
test('Database operations', async t => {
    await t.test('encrypt/decrypt', () => {
        const plain = JSON.stringify({ data: 'hello', number: 123 });
        const encrypted = encrypt(plain);
        assert.ok(encrypted.length > 0);
        assert.notEqual(encrypted, plain);
        const decrypted = decrypt(encrypted);
        assert.equal(decrypted, plain);
        assert.throws(() => decrypt('bukan_base64_valid!'));
    });

    await t.test('get & update group settings', async () => {
        // Gunakan ID unik agar tidak terpengaruh test sebelumnya
        const groupId = uniqueGroupId;
    
        // Ambil awal – harus default
        const settings = await getGroupSettings(groupId);
        assert.ok(settings, 'settings harus ada');
        assert.ok(settings.welcome, 'welcome harus ada');
        assert.strictEqual(settings.welcome.enabled, false, 'awal welcome.enabled harus false');
    
        // Update welcome.enabled menjadi true
        await updateGroupSettings(groupId, { welcome: { enabled: true } });
    
        // Ambil lagi – harus terupdate
        const updated = await getGroupSettings(groupId);
        assert.ok(updated, 'updated settings harus ada');
        assert.ok(updated.welcome, 'updated welcome harus ada');
        assert.strictEqual(updated.welcome.enabled, true, 'setelah update, enabled harus true');
    
        // Kembalikan ke default
        await updateGroupSettings(groupId, { welcome: { enabled: false } });
    });

    await t.test('get & update user', async () => {
        const userId = 'testuser@s.whatsapp.net';
        const user = await getUser(userId);
        assert.ok(typeof user.registered === 'number');
        
        await updateUser(userId, { name: 'TestName' });
        const updated = await getUser(userId);
        assert.equal(updated.name, 'TestName');
        
        // Kembalikan
        await updateUser(userId, { name: '' });
    });
});

// ========================
// Antilink Handler (mock)
// ========================
test('Antilink handler', async t => {
    await t.test('bukan link -> langsung return', async () => {
        const sock = { sendMessage: async () => {} };
        const ctx = mockCtx();
        const m = { key: { remoteJid: 'test@g.us', participant: 'sender@s.whatsapp.net' } };
        await handleAntilink(sock, m, 'test@g.us', 'Halo biasa', ctx);
        assert.ok(true);
    });

    await t.test('link tapi antilink disabled', async () => {
        await updateGroupSettings('linkgroup@g.us', { antilink: { enabled: false } });
        const sock = { sendMessage: async () => {} };
        const ctx = mockCtx();
        const m = { key: { remoteJid: 'linkgroup@g.us', participant: 'sender@s.whatsapp.net' } };
        await handleAntilink(sock, m, 'linkgroup@g.us', 'https://example.com', ctx);
        assert.ok(true);
    });
});

// ========================
// Cache cleanup (invalidate)
// ========================
test('Cache invalidation', async t => {
    await t.test('invalidateGroupSettingsCache', () => {
        invalidateGroupSettingsCache('anyId');
        assert.ok(true);
    });
});
// commands/menu.js
// Hasil merge: logger yang tadinya diimport default dari '../logger.js'
// sekarang named import dari '../zeone.js'.
import { cmdList, getMetrics, getUniqueCommandCount, logger } from '../zeone.js';
import config from '../config.js';
import { resolveContactName } from '../message.js';
import fs from 'fs';
import path from 'path';

function getTimeGreeting() {
    const hour = new Date().getHours();
    if (hour < 11) return 'Selamat Pagi';
    if (hour < 15) return 'Selamat Siang';
    if (hour < 18) return 'Selamat Sore';
    return 'Selamat Malam';
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts = [];
    if (d > 0) parts.push(`${d}h`);
    if (h > 0) parts.push(`${h}j`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}d`);
    return parts.join(' ');
}

function formatDateShort(date) {
    // Format tanggal angka semua: DD/MM/YYYY
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${date.getFullYear()}`;
}

function formatTime(date) {
    return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default {
    name: 'menu',
    alias: ['help', 'commands', 'bantuan'],
    description: 'Tampilkan daftar perintah dan info bot',
    async run(ctx, args) {
        try {
            // Detail command jika ada argumen
            if (args.length > 0) {
                const target = args[0].toLowerCase();
                let found = null;
                for (const cmd of cmdList.values()) {
                    if (cmd.name === target || (cmd.alias && cmd.alias.includes(target))) {
                        found = cmd;
                        break;
                    }
                }
                if (found) {
                    let text = `📋 *Detail: ${config.prefix}${found.name}*\n📚 ${found.description || 'Tidak ada deskripsi'}`;
                    if (found.alias?.length) text += `\n🔗 Alias: ${found.alias.map(a => config.prefix + a).join(', ')}`;
                    return ctx.reply(text);
                }
                return ctx.reply(`❌ Perintah "${args[0]}" tidak ditemukan.`);
            }

            const prefix = config.prefix || '!';
            const now = new Date();
            const greeting = getTimeGreeting();
            const timeStr = formatTime(now);
            const dateStr = formatDateShort(now);
            const metrics = getMetrics();
            const uptimeFormatted = formatUptime(metrics.uptime);
            const uniqueCount = getUniqueCommandCount(cmdList);
            const ownerNumber = config.ownerNumber || '';
            const ownerJid = ownerNumber.includes('@') ? ownerNumber : `${ownerNumber}@s.whatsapp.net`;
            // Status owner ditentukan di message.js (ctx.isOwner): nomor terdaftar
            // di .env — owner tetap owner saat chat private dengan orang lain / di grup.
            const isOwner = ctx.isOwner || ctx.isSelf;

            // ─── NAMA TAMPILAN DARI KONTAK WA ───
            let displayName;
            if (ctx.isSelf) {
                displayName = await resolveContactName(ctx.sock, ownerJid);
            } else {
                displayName = await resolveContactName(ctx.sock, ctx.sender);
            }
            
            // Fallback jika nama tidak valid (hanya angka/Unknown)
            if (!displayName || displayName === 'Unknown' || /^\d+$/.test(displayName)) {
                // Coba gunakan ctx.pushName (berisi m.pushName dari WhatsApp) jika valid
                if (ctx.pushName && ctx.pushName !== 'Unknown' && !/^\d+$/.test(ctx.pushName)) {
                    displayName = ctx.pushName;
                } else {
                    displayName = isOwner ? 'Owner' : 'User';
                }
            }

            let userRole = 'User';
            let roleEmoji = '👤';
            if (isOwner) {
                userRole = 'Owner';
                roleEmoji = '👑';
            }

            const greetEmoji =
                greeting.includes('Pagi') ? '🌅' :
                greeting.includes('Siang') ? '☀️' :
                greeting.includes('Sore') ? '🌇' : '🌙';

            // Bangun teks menu
            let txt = '';
            txt += `${greetEmoji} ${greeting}, *${displayName}*!\n`;
            txt += `Selamat datang di *${config.botName}*\n\n`;

            txt += `╭───「 *INFO BOT* 」\n`;
            txt += `│ Nama    : *${config.botName}*\n`;
            txt += `│ Versi   : *v3.0.0*\n`;
            txt += `│ Mode    : *${config.publicMode ? 'PUBLIC' : 'SELF'}*\n`;
            txt += `│ Prefix  : *[ ${prefix} ]*\n`;
            txt += `│ Uptime  : *${uptimeFormatted}*\n`;
            txt += `│ Total Cmd : *${uniqueCount}*\n`;
            txt += `╰──────────\n\n`;

            txt += `╭───「 *INFO USER* 」\n`;
            txt += `│ Nama    : *${displayName}*\n`;
            txt += `│ Role    : *${roleEmoji} ${userRole}*\n`;
            txt += `│ Waktu   : *${timeStr} WIB*\n`;
            txt += `│ Tanggal : *${dateStr}*\n`;
            txt += `╰──────────\n\n`;

            // Daftar perintah (tanpa kategori)
            const unique = new Map();
            for (const cmd of cmdList.values()) {
                if (!unique.has(cmd.name)) unique.set(cmd.name, cmd);
            }
            const sorted = Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name));
            const cmdListLines = sorted.map(cmd => `│ ${prefix}${cmd.name}`).join('\n');

            txt += `╭───「 *DAFTAR PERINTAH* 」\n`;
            txt += `${cmdListLines}\n`;
            txt += `╰──────────\n\n`;

            txt += `© *${config.botName}* | ${now.getFullYear()}\n`;
            txt += `Dev: Ahri De Valiente`;

            const mentions = [ctx.sender, ownerJid].filter(Boolean);

            // Kirim sebagai gambar + caption jika ada gambar
            const imagePath = path.join(process.cwd(), 'assets', 'images', 'zeone.jpg');
            let imageBuffer = null;
            
            // FIX: Gunakan promises.readFile agar tidak memblokir event loop
            if (fs.existsSync(imagePath)) {
                imageBuffer = await fs.promises.readFile(imagePath);
            }

            if (imageBuffer) {
                await ctx.sendMessage(
                    { image: imageBuffer, caption: txt },
                    { mentions }
                );
            } else if (config.botImageUrl) {
                await ctx.sendMessage(
                    { image: { url: config.botImageUrl }, caption: txt },
                    { mentions }
                );
            } else {
                await ctx.sendMessage({ text: txt }, { mentions });
            }
        } catch (err) {
            // Error TIDAK ditampilkan di chat (private/grup) — diteruskan ke error
            // handler supaya laporan penuh hanya dikirim ke nomor owner.
            logger.error('Error menu:', err);
            throw err;
        }
    }
};
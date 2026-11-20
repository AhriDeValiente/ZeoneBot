// commands/vn.js
// Konversi audio WhatsApp (termasuk MP4 dengan video) ke voice note
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execPromise = promisify(exec);
const TEMP_DIR = path.join(os.tmpdir(), 'zeonebot_vn');
await fs.mkdir(TEMP_DIR, { recursive: true }).catch(() => {});

function checkFfmpeg() {
    try { execSync('command -v ffmpeg', { stdio: 'ignore' }); return true; } catch { return false; }
}

async function cleanupFiles(...files) {
    for (const f of files) if (f) try { await fs.unlink(f); } catch {}
}

function getExtension(mime) {
    const m = {
        'audio/mpeg':'.mp3','audio/mp3':'.mp3','audio/mp4':'.m4a','audio/m4a':'.m4a',
        'audio/aac':'.aac','audio/ogg':'.ogg','audio/opus':'.opus','audio/wav':'.wav',
        'audio/webm':'.webm','audio/amr':'.amr','audio/3gpp':'.3gp',
        'video/mp4':'.mp4'
    };
    return m[mime] || '.audio';
}

async function convertToOpus(input, output) {
    // Tambahkan -vn untuk menonaktifkan pemrosesan video, hanya audio
    const cmd = `ffmpeg -i "${input}" -vn -c:a libopus -b:a 24k -vbr on -ac 1 -ar 16000 -f ogg "${output}" -y`;
    console.log('[VN] FFmpeg cmd:', cmd);
    await execPromise(cmd, { timeout: 90000 });
}

export default {
    name: "vn",
    alias: ["voicenote", "ptt"],
    run: async (ctx) => {
        if (!checkFfmpeg()) {
            return ctx.reply('❌ ffmpeg belum terinstall.\n`pkg install ffmpeg -y`');
        }

        const msg = ctx.msg;
        const contextInfo = msg?.message?.extendedTextMessage?.contextInfo;
        let targetMsg = null;
        let audioData = null;

        // Deteksi dari quotedMessage (balasan)
        if (contextInfo?.quotedMessage) {
            const stanzaId = contextInfo.stanzaId;
            const participant = contextInfo.participant || msg.key.participant;
            const remoteJid = msg.key.remoteJid;
            const quotedMessage = contextInfo.quotedMessage;

            audioData = quotedMessage.audioMessage || quotedMessage.videoMessage || quotedMessage.documentMessage;
            if (audioData) {
                targetMsg = {
                    key: { remoteJid, id: stanzaId, participant, fromMe: false },
                    message: quotedMessage
                };
            }
        }

        // Jika tidak ada, cek pesan langsung
        if (!audioData) {
            let content = msg.message;
            if (content?.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
            if (content?.viewOnceMessageV2Extension?.message) content = content.viewOnceMessageV2Extension.message;
            if (content?.ephemeralMessage?.message) content = content.ephemeralMessage.message;
            audioData = content?.audioMessage || content?.videoMessage || content?.documentMessage;
            if (audioData) targetMsg = msg;
        }

        if (!audioData) {
            return ctx.reply('⚠️ Balas audio/video dengan `!vn` atau kirim file audio dengan caption `!vn`.');
        }

        const processingMsg = await ctx.reply('🎵 Memproses audio...');
        let inputPath, outputPath;

        try {
            const mime = audioData.mimetype || 'audio/ogg';
            const ext = getExtension(mime);
            const ts = Date.now();
            inputPath = path.join(TEMP_DIR, `in_${ts}${ext}`);
            outputPath = path.join(TEMP_DIR, `out_${ts}.ogg`);

            // Download media
            let buffer;
            try {
                const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
                buffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: undefined });
            } catch (e) {
                console.log('[VN] downloadMediaMessage gagal, coba fetch URL');
                if (audioData.url) {
                    const res = await fetch(audioData.url);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    buffer = Buffer.from(await res.arrayBuffer());
                } else throw e;
            }

            if (!buffer || buffer.length === 0) throw new Error('File kosong');
            await fs.writeFile(inputPath, buffer);
            await convertToOpus(inputPath, outputPath);

            const outBuf = await fs.readFile(outputPath);
            if (outBuf.length > 16 * 1024 * 1024) throw new Error('Ukuran > 16MB');

            await ctx.sock.sendMessage(ctx.id, {
                audio: outBuf,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            });

            try { await ctx.sock.sendMessage(ctx.id, { delete: processingMsg.key }); } catch {}
        } catch (err) {
            console.error('[VN] Error:', err);
            try { await ctx.sock.sendMessage(ctx.id, { delete: processingMsg.key }); } catch {}
            await ctx.reply(`❌ Gagal: ${err.message}`);
        } finally {
            await cleanupFiles(inputPath, outputPath);
        }
    }
};
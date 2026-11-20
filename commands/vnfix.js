// commands/vnfix.js
// Mode voice: optimasi vokal realistis – tidak menghilangkan gitar, hanya mengurangi & memperjelas
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

const execPromise = promisify(exec);
const TEMP_DIR = path.join(os.tmpdir(), 'zeonebot_enhance');
await fs.mkdir(TEMP_DIR, { recursive: true }).catch(() => {});

function checkFfmpeg() {
    try { execSync('command -v ffmpeg', { stdio: 'ignore' }); return true; } catch { return false; }
}

const HAS = {};
try {
    const out = execSync('ffmpeg -filters 2>/dev/null', { encoding: 'utf8' });
    HAS.afftdn = out.includes('afftdn');
    HAS.agate = out.includes('agate');
    HAS.equalizer = out.includes('equalizer');
    HAS.dynaudnorm = out.includes('dynaudnorm');
    HAS.anlmdn = out.includes('anlmdn');
    HAS.firequalizer = out.includes('firequalizer');
} catch {}

async function cleanupFiles(...files) {
    for (const f of files) if (f) try { await fs.unlink(f); } catch {}
}

function getExtension(mime) {
    return {
        'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/mpeg': '.mp3',
        'audio/mp4': '.m4a', 'audio/m4a': '.m4a', 'audio/aac': '.aac',
        'audio/wav': '.wav', 'audio/webm': '.webm', 'audio/amr': '.amr',
        'audio/3gpp': '.3gp'
    }[mime] || '.ogg';
}

async function enhanceAudio(input, output, mode = 'voice') {
    const filters = [];

    if (mode === 'voice') {
        // Resample ke 16kHz
        filters.push('aresample=16000');

        // Highpass 150 Hz – kurangi dentuman rendah gitar tapi tetap pertahankan vokal rendah
        filters.push('highpass=f=150');

        // EQ halus: kurangi 200-400 Hz (-3 dB) untuk gitar, boost 2.5 kHz (+5 dB) untuk kejelasan vokal
        if (HAS.equalizer) {
            filters.push('equalizer=f=300:t=q:w=2:g=-3');
            filters.push('equalizer=f=2500:t=q:w=2:g=5');
        } else if (HAS.firequalizer) {
            filters.push('firequalizer=gain_entry="entry(0,0);entry(300,-3);entry(2500,5);entry(8000,0)"');
        } else {
            filters.push('bass=g=-3, treble=g=5');
        }

        // Noise reduction ringan
        if (HAS.afftdn) {
            filters.push('afftdn=nr=20:nf=-30:tn=1');
        } else if (HAS.anlmdn) {
            filters.push('anlmdn=s=0.015:p=0.002');
        }

        // Gate lembut: hanya hilangkan desah sangat pelan (< -40 dB), jangan potong reverb alami
        if (HAS.agate) {
            filters.push('agate=threshold=-40dB:ratio=1.5:attack=2:release=50:makeup=1');
        }

        // Kompresi dinamis + normalisasi
        if (HAS.dynaudnorm) {
            filters.push('dynaudnorm=p=0.9:s=8:m=25');
        }
        filters.push('loudnorm=I=-18:TP=-1.5:LRA=8');

        // Tidak ada echo cancellation – itu penyebab suara "runyek"

    } else if (mode === 'music') {
        filters.push('aresample=44100');
        filters.push('highpass=f=30, lowpass=f=18000');
        if (HAS.afftdn) filters.push('afftdn=nr=15:nf=-30');
        filters.push('compand=attacks=0.01:decays=0.5:points=-90/-90|-20/-15|0/-3:gain=3');
        filters.push('loudnorm=I=-18:TP=-1.0:LRA=12');
    } else { // general
        filters.push('aresample=22050');
        filters.push('highpass=f=100, lowpass=f=8000');
        if (HAS.afftdn) filters.push('afftdn=nr=20:nf=-30');
        filters.push('compand=attacks=0.005:decays=0.3:points=-90/-90|-30/-20|-15/-10|0/-5:gain=5');
        filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    }

    const filterStr = filters.join(',');

    const codecParams = [];
    if (mode === 'voice') {
        codecParams.push('-ac', '1', '-ar', '16000', '-b:a', '32k', '-c:a', 'libopus', '-vbr', 'on', '-f', 'ogg');
    } else if (mode === 'music') {
        codecParams.push('-ac', '2', '-ar', '44100', '-b:a', '128k', '-c:a', 'libopus', '-f', 'ogg');
    } else {
        codecParams.push('-ac', '1', '-ar', '22050', '-b:a', '48k', '-c:a', 'libopus', '-vbr', 'on', '-f', 'ogg');
    }

    const cmd = `ffmpeg -i "${input}" -af "${filterStr}" ${codecParams.join(' ')} "${output}" -y`;
    console.log('[VN-FIX] CMD:', cmd);
    await execPromise(cmd, { timeout: 120000 });
}

export default {
    name: 'perjelas',
    alias: ['enhance', 'bersihkan', 'jernihkan', 'asr'],
    description: 'Optimasi suara VN (voice/music/general). Voice: memperjelas vokal tanpa merusak.',
    run: async (ctx, args) => {
        if (!checkFfmpeg()) return ctx.reply('❌ ffmpeg belum terinstall.\n`pkg install ffmpeg -y`');

        const modeArg = args[0]?.toLowerCase();
        let mode = 'voice';
        if (modeArg === 'music' || modeArg === 'general') {
            mode = modeArg;
        } else if (modeArg && modeArg !== 'voice') {
            return ctx.reply('❌ Mode tidak dikenal. Gunakan `voice`, `music`, atau `general`.');
        }

        const msg = ctx.msg;
        const contextInfo = msg?.message?.extendedTextMessage?.contextInfo;
        let targetMsg = null, audioData = null;

        if (contextInfo?.quotedMessage) {
            const { stanzaId, participant, quotedMessage } = contextInfo;
            const remoteJid = msg.key.remoteJid;
            audioData = quotedMessage.audioMessage || quotedMessage.videoMessage || quotedMessage.documentMessage;
            if (audioData) {
                targetMsg = {
                    key: { remoteJid, id: stanzaId, participant: participant || msg.key.participant, fromMe: false },
                    message: quotedMessage
                };
            }
        }

        if (!audioData) {
            let content = msg.message;
            if (content?.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
            if (content?.viewOnceMessageV2Extension?.message) content = content.viewOnceMessageV2Extension.message;
            if (content?.ephemeralMessage?.message) content = content.ephemeralMessage.message;
            audioData = content?.audioMessage || content?.videoMessage || content?.documentMessage;
            if (audioData) targetMsg = msg;
        }

        if (!audioData) return ctx.reply('⚠️ Balas voice note dengan `!perjelas [mode]`.\nMode: `voice` (default), `music`, `general`.');

        const processingMsg = await ctx.reply(`🎛️ Memperjelas suara (mode: ${mode})...`);
        let inputPath, outputPath;

        try {
            const mime = audioData.mimetype || 'audio/ogg';
            const ext = getExtension(mime);
            const ts = Date.now();
            inputPath = path.join(TEMP_DIR, `in_${ts}${ext}`);
            outputPath = path.join(TEMP_DIR, `out_${ts}.ogg`);

            let buffer;
            try {
                buffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: undefined });
            } catch (e) {
                if (audioData.url) {
                    const res = await fetch(audioData.url);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    buffer = Buffer.from(await res.arrayBuffer());
                } else throw e;
            }

            if (!buffer || buffer.length === 0) throw new Error('File kosong');
            await fs.writeFile(inputPath, buffer);
            await enhanceAudio(inputPath, outputPath, mode);

            const outBuf = await fs.readFile(outputPath);
            if (outBuf.length > 16 * 1024 * 1024) throw new Error('Ukuran > 16MB');

            await ctx.sock.sendMessage(ctx.id, { audio: outBuf, mimetype: 'audio/ogg; codecs=opus', ptt: true });
            try { await ctx.sock.sendMessage(ctx.id, { delete: processingMsg.key }); } catch {}
        } catch (err) {
            console.error('[VN-FIX] Error:', err);
            try { await ctx.sock.sendMessage(ctx.id, { delete: processingMsg.key }); } catch {}
            await ctx.reply(`❌ Gagal: ${err.message}`);
        } finally {
            await cleanupFiles(inputPath, outputPath);
        }
    }
};
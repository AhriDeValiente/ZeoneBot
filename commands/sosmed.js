// commands/sosmed.js
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);
const TMP_DIR = path.join(process.cwd(), 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function detectPlatform(url) {
    if (/tiktok\.com|vt\.tiktok\.com/.test(url)) return 'TikTok';
    if (/instagram\.com\/(reel|p)\//.test(url)) return 'Instagram';
    if (/youtube\.com|youtu\.be/.test(url)) return 'YouTube';
    if (/facebook\.com|fb\.watch/.test(url)) return 'Facebook';
    return null;
}

export default {
    name: "sosmed",
    alias: ["download", "dl"],
    description: "Download video sosmed via yt‑dlp + ffmpeg.",
    run: async (ctx, args) => {
        const url = args[0];
        if (!url) {
            return ctx.reply(
                "📥 *SOSMED DOWNLOADER*\n\n" +
                "`!sosmed <url>`\n\n" +
                "📱 Platform: TikTok • Instagram • YouTube • Facebook\n\n" +
                "_Gratis, tanpa batasan._"
            );
        }

        const platform = detectPlatform(url);
        if (!platform) return ctx.reply("❌ Link tidak dikenali.");

        await ctx.reply(`⏳ Download dari *${platform}*...`);

        const rawFileName = `raw_${Date.now()}.mp4`;
        const rawPath = path.join(TMP_DIR, rawFileName);
        const finalPath = path.join(TMP_DIR, `sosmed_${Date.now()}.mp4`);

        try {
            // Format fleksibel: biarkan yt-dlp memilih format terbaik yang tersedia
            const ytdlpCmd = `yt-dlp --format-sort "ext:mp4:m4a,res,codec:h264" -o "${rawPath}" "${url}"`;
            await execAsync(ytdlpCmd, { timeout: 120000 });

            let needReencode = true;
            try {
                const { stdout: vCodec } = await execAsync(
                    `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${rawPath}"`
                );
                const { stdout: aCodec } = await execAsync(
                    `ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${rawPath}"`
                );
                if (vCodec.trim() === 'h264' && aCodec.trim() === 'aac') {
                    needReencode = false;
                    console.log('[SosmedDL] Skip re-encode (sudah H.264+AAC)');
                    await ctx.reply(`⏩ Video kompatibel, langsung kirim...`);
                    fs.renameSync(rawPath, finalPath);
                }
            } catch (probeErr) {
                console.warn('[SosmedDL] Gagal deteksi codec, lanjut re-encode');
            }

            if (needReencode) {
                await ctx.reply(`🔄 Konversi video (resize 720p)...`);
                const ffmpegCmd =
                    `ffmpeg -i "${rawPath}" ` +
                    `-vf "scale='min(720,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease" ` +
                    `-c:v libx264 -profile:v main -level 4.0 -preset fast -crf 23 ` +
                    `-pix_fmt yuv420p -c:a aac -b:a 128k ` +
                    `-movflags +faststart -y "${finalPath}"`;
                await execAsync(ffmpegCmd, { timeout: 120000 });
                try { fs.unlinkSync(rawPath); } catch {}
            }

            const stat = fs.statSync(finalPath);
            if (stat.size > 95 * 1024 * 1024) {
                fs.unlinkSync(finalPath);
                return ctx.reply("❌ Video >95MB. Coba link lain.");
            }

            await ctx.sock.sendMessage(ctx.sender, {
                video: fs.readFileSync(finalPath),
                caption: `✅ *${platform} Video*\n_Downloaded_`,
                mimetype: 'video/mp4'
            });

            fs.unlinkSync(finalPath);
        } catch (err) {
            console.error('[SosmedDL]', err.message);
            try { fs.unlinkSync(rawPath); } catch {}
            try { fs.unlinkSync(finalPath); } catch {}
            await ctx.reply("❌ Gagal download. Pastikan link publik & valid.");
        }
    }
};
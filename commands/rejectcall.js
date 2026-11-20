import { getGlobalSettings, updateGlobalSettings } from '../database.js';

export default {
    name: 'rejectcall',
    alias: ['rc'],
    description: 'Auto reject call + pesan. Gunakan: !rejectcall on/off/setmsg/showmsg/resetmsg',
    async run(ctx, args) {
        if (!ctx.isSelf) return ctx.reply('❌ Perintah ini hanya untuk self chat.');

        const sub = args[0]?.toLowerCase();
        const global = await getGlobalSettings();
        let auto = global.autoRejectCall;

        if (!sub) {
            const status = auto?.enabled ? '✅ Aktif' : '❌ Nonaktif';
            const msg = auto?.message || "Maaf, bot sedang tidak bisa menerima panggilan. Silakan kirim pesan.";
            return ctx.reply(`📞 *Auto Reject Call*\nStatus: ${status}\nPesan: ${msg}\n\nGunakan:\n!rejectcall on/off\n!rejectcall setmsg <pesan>\n!rejectcall showmsg\n!rejectcall resetmsg`);
        }

        if (sub === 'on') {
            if (!auto) auto = { enabled: true, message: "Maaf, bot sedang tidak bisa menerima panggilan. Silakan kirim pesan." };
            else auto.enabled = true;
            await updateGlobalSettings({ autoRejectCall: auto });
            ctx.reply('✅ Auto reject call diaktifkan. Panggilan akan ditolak + pesan terkirim.');
        } 
        else if (sub === 'off') {
            if (!auto) auto = { enabled: false, message: "Maaf, bot sedang tidak bisa menerima panggilan. Silakan kirim pesan." };
            else auto.enabled = false;
            await updateGlobalSettings({ autoRejectCall: auto });
            ctx.reply('✅ Auto reject call dinonaktifkan.');
        }
        else if (sub === 'setmsg') {
            const newMsg = args.slice(1).join(' ');
            if (!newMsg) return ctx.reply('❌ Masukkan pesan baru. Contoh: !rejectcall setmsg Saya sedang sibuk.');
            if (!auto) auto = { enabled: false, message: newMsg };
            else auto.message = newMsg;
            await updateGlobalSettings({ autoRejectCall: auto });
            ctx.reply(`✅ Pesan balasan diubah menjadi:\n"${newMsg}"`);
        }
        else if (sub === 'showmsg') {
            const currentMsg = auto?.message || "Maaf, bot sedang tidak bisa menerima panggilan. Silakan kirim pesan.";
            ctx.reply(`📨 Pesan saat ini:\n"${currentMsg}"`);
        }
        else if (sub === 'resetmsg') {
            const defaultMsg = "Maaf, bot sedang tidak bisa menerima panggilan. Silakan kirim pesan.";
            if (!auto) auto = { enabled: false, message: defaultMsg };
            else auto.message = defaultMsg;
            await updateGlobalSettings({ autoRejectCall: auto });
            ctx.reply(`✅ Pesan dikembalikan ke default:\n"${defaultMsg}"`);
        }
        else {
            ctx.reply('❌ Subperintah tidak dikenal. Gunakan on/off/setmsg/showmsg/resetmsg.');
        }
    }
};
import { getGroupSettings, updateGroupSettings } from '../database.js';

export default {
    name: 'welcome',
    alias: ['selamatdatang'],
    description: 'Atur pesan selamat datang. Gunakan: !welcome on <pesan> | !welcome off',
    async run(ctx, args) {
        if (!ctx.isGroup) return ctx.reply('❌ Hanya untuk grup.');
        
        const groupId = ctx.id;
        const settings = await getGroupSettings(groupId);

        if (args.length === 0) {
            let status = settings.welcome.enabled ? '✅ Aktif' : '❌ Nonaktif';
            let msg = settings.welcome.message || '(kosong)';
            return ctx.reply(`📋 *Pengaturan Welcome*\nStatus: ${status}\nPesan: ${msg}\n\nGunakan:\n!welcome on <pesan> - aktifkan dengan pesan (gunakan @user untuk menyebut)\n!welcome off - nonaktifkan`);
        }

        const sub = args[0].toLowerCase();
        if (sub === 'on') {
            const message = args.slice(1).join(' ');
            if (!message) return ctx.reply('❌ Masukkan pesan selamat datang.');
            settings.welcome.enabled = true;
            settings.welcome.message = message;
            await updateGroupSettings(groupId, { welcome: settings.welcome });
            ctx.reply('✅ Welcome diaktifkan dengan pesan:\n' + message);
        } else if (sub === 'off') {
            settings.welcome.enabled = false;
            await updateGroupSettings(groupId, { welcome: settings.welcome });
            ctx.reply('✅ Welcome dinonaktifkan.');
        } else {
            ctx.reply('❌ Subperintah tidak dikenal. Gunakan on/off.');
        }
    }
};
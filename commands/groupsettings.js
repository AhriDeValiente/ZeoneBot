import { getGroupSettings } from '../database.js';

export default {
    name: 'groupsettings',
    alias: ['gset', 'grup'],
    description: 'Lihat pengaturan grup',
    async run(ctx, args) {
        if (!ctx.isGroup) return ctx.reply('❌ Hanya untuk grup.');
        
        const settings = await getGroupSettings(ctx.id);
        let msg = `📋 *Pengaturan Grup*\n\n`;
        msg += `Welcome: ${settings.welcome.enabled ? '✅' : '❌'}\n`;
        msg += `Pesan Welcome: ${settings.welcome.message || '-'}\n`;
        msg += `Anti Link: ${settings.antilink.enabled ? '✅' : '❌'}\n`;
        ctx.reply(msg);
    }
};
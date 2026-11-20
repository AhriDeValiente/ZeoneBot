import { getGroupSettings, updateGroupSettings } from '../database.js';
import { invalidateGroupSettingsCache } from '../message.js';

export default {
    name: 'antilink',
    alias: [],
    description: 'Atur anti link. Gunakan: !antilink on/off',
    async run(ctx, args) {
        if (!ctx.isGroup) return ctx.reply('❌ Hanya untuk grup.');
        if (!ctx.isAdmin) return ctx.reply('❌ Hanya admin grup yang bisa mengatur anti link.');

        const groupId = ctx.id;
        const settings = await getGroupSettings(groupId);
        const sub = args[0]?.toLowerCase();

        if (!sub || (sub !== 'on' && sub !== 'off')) {
            const status = settings.antilink.enabled ? '✅ Aktif' : '❌ Nonaktif';
            return ctx.reply(
                `📋 *Pengaturan Anti Link*\nStatus: ${status}\n\n` +
                `Gunakan:\n!antilink on - aktifkan\n!antilink off - nonaktifkan`
            );
        }

        if (sub === 'on') {
            settings.antilink.enabled = true;
            await updateGroupSettings(groupId, { antilink: settings.antilink });
            invalidateGroupSettingsCache(groupId);
            ctx.reply('✅ Anti link diaktifkan. Pesan yang mengandung link akan dihapus.');
        } else if (sub === 'off') {
            settings.antilink.enabled = false;
            await updateGroupSettings(groupId, { antilink: settings.antilink });
            invalidateGroupSettingsCache(groupId);
            ctx.reply('✅ Anti link dinonaktifkan.');
        }
    }
};
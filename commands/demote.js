export default {
    name: 'demote',
    alias: [],
    description: 'Turunkan admin menjadi anggota biasa',
    async run(ctx, args) {
        if (!ctx.isGroup) return ctx.reply('❌ Perintah ini hanya untuk grup.');

        const groupMetadata = ctx.groupMetadata || await ctx.sock.groupMetadata(ctx.id);
        if (!groupMetadata || !groupMetadata.participants) {
            return ctx.reply('❌ Gagal mendapatkan metadata grup.');
        }

        const botLid = ctx.botLid.split(':')[0];
        const senderLid = ctx.sender.split('@')[0];

        const botParticipant = groupMetadata.participants.find(p => p.id.split('@')[0] === botLid);
        if (!botParticipant) {
            return ctx.reply('❌ Bot tidak ditemukan dalam daftar peserta grup.');
        }
        if (!['admin', 'superadmin'].includes(botParticipant.admin)) {
            return ctx.reply('❌ Bot harus menjadi admin.');
        }

        const senderParticipant = groupMetadata.participants.find(p => p.id.split('@')[0] === senderLid);
        if (!senderParticipant) {
            return ctx.reply('❌ Pengirim tidak ditemukan dalam daftar peserta grup.');
        }
        if (!['admin', 'superadmin'].includes(senderParticipant.admin)) {
            return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');
        }

        let targetJid;
        if (ctx.quoted?.key?.participant) {
            targetJid = ctx.quoted.key.participant;
        } else if (ctx.mentionedJid?.[0]) {
            targetJid = ctx.mentionedJid[0];
        } else {
            return ctx.reply('❌ Reply pesan anggota atau sebut @user.');
        }

        if (!targetJid) return ctx.reply('❌ Target tidak valid.');

        const targetLid = targetJid.split('@')[0];
        if (targetLid === botLid) return ctx.reply('❌ Tidak bisa demote diri sendiri.');

        if (!groupMetadata.participants.some(p => p.id.split('@')[0] === targetLid)) {
            return ctx.reply('❌ Target tidak ditemukan di grup ini.');
        }

        try {
            await ctx.sock.groupParticipantsUpdate(ctx.id, [targetJid], 'demote');
            ctx.reply(`✅ Berhasil demote @${targetLid}`, { mentions: [targetJid] });
        } catch (err) {
            ctx.reply(`❌ Gagal: ${err.message}`);
        }
    }
};
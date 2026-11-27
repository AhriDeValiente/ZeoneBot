# 🤖 ZeoneBot v3.0.0

**ZeoneBot** adalah WhatsApp Bot tingkat lanjut (Frontier Engineering) yang dibangun menggunakan **Node.js (ES Modules)** dan **Baileys** (`@whiskeysockets/baileys`). Bot ini dirancang dengan arsitektur *First-Principles*, memprioritaskan stabilitas koneksi, keamanan data, dan performa eksekusi tingkat tinggi.

Dikembangkan oleh **Ahri De Valiente**.

---

## ✨ Fitur Utama

### 1. Stabilitas & Koneksi

- **Circuit Breaker & Auto-Reconnect**: Mencegah *spam* koneksi ke server WhatsApp menggunakan *exponential backoff* + *jitter*. Jika gagal terus, bot akan masuk mode `OPEN` dan mencoba memulihkan diri secara berkala.
- **Session Recovery**: Jika pengiriman pesan gagal karena masalah enkripsi (`bad mac` / `prekey`), bot otomatis menghapus sesi korup dan mengirim ulang pesan.
- **Call Deduplication**: Mencegah *spam* balasan saat menerima panggilan (WhatsApp sering mengirim *multiple events* untuk satu panggilan fisik).
- **Safe Pairing (Non-TTY)**: Aman dijalankan di PM2/Docker. Jika belum ada sesi dan berjalan di *background*, bot akan berhenti dengan pesan instruksi alih-alih *crash*.

### 2. Keamanan Data (AES-256-GCM)

- **Enkripsi Database**: `database.json` (data grup, user, global settings) dienkripsi menggunakan `AES-256-GCM` dengan derivasi kunci `PBKDF2` (100.000 iterasi).
- **Enkripsi Laporan**: File `reports/reports.json` (log error, metrik, command) juga dienkripsi.
- **Anti-Data Loss**: Saat bot dimatikan (`SIGINT` / `SIGTERM`), data disimpan secara sinkron (*synchronous write*) untuk menjamin integritas.

### 3. Core Engine & Command Handler

- **Priority Queue**: Perintah dari Owner (`HIGH`), Admin Grup (`MEDIUM`), dan User (`LOW`) diantrekan secara adil.
- **Rate Limiter**: Menggunakan *sliding window* untuk mencegah *spam command* dari satu pengguna.
- **Timeout Controller**: Mencegah *command* berjalan selamanya jika terjadi *infinite loop* atau *network hang*.
- **Hot Reload**: Menambah atau mengubah *command* tidak perlu me-restart bot (menggunakan `chokidar`).

### 4. AI & Integrasi Eksternal

- Terintegrasi dengan `@google/genai` (Google Gemini API) dan `@heyputer/puter.js` untuk fitur berbasis AI.
- Menggunakan `express` untuk kebutuhan *web server* / *webhook*.
- Menggunakan `yskj-sqlite-android` dan `exifreader` untuk kebutuhan spesifik *database* dan *metadata*.

---

## 📋 Prasyarat

- **Node.js**: v18.x / v20.x (ES Modules)
- **NPM**: v9+
- **Terminal/TTY**: Untuk proses *pairing* pertama kali.

---

## 🚀 Instalasi & Menjalankan

### 1. Clone & Install

```bash
git clone https://github.com/username/zeonebot.git
cd zeonebot
npm install
```

### 2. Konfigurasi .env

Buat file `.env` di root direktori. Sesuai `config.js`, variabel yang wajib diisi adalah:

```env
# ── WAJIB (Sistem akan exit jika kosong) ──
DB_ENCRYPTION_KEY=buat_kunci_rahasia_panjang_disini
REPORT_ENCRYPTION_KEY=buat_kunci_rahasia_lain_disini

# ── KONFIGURASI BOT ──
BOT_NAME=ZeoneBot
BOT_NUMBER=628xxx
BOT_IMAGE_URL=https://link-gambar-bot.com/image.jpg
OWNER_NUMBER=628xxx
CMD_PREFIX=!
MULTIPREFIX=false

# ── KONFIGURASI PERILAKU ──
PUBLIC_MODE=true
DEBUG_MODE=false
SHOW_MESSAGE_LOG=true
LOG_OUTGOING=true

# ── KONFIGURASI STABILITAS & PERFORMA ──
MAX_CIRCUIT_FAILURES=5
CIRCUIT_RESET_MS=20000
MAX_RECONNECT_ATTEMPTS=5
KEEP_ALIVE_INTERVAL_MS=900000

# ── KONFIGURASI RATE LIMIT & QUEUE ──
RATE_LIMIT_WINDOW=1000
RATE_LIMIT_MAX_REQUESTS=5
RATE_LIMIT_WINDOW_MS=10000
COMMAND_TIMEOUT=100000
MAX_CONCURRENT_COMMANDS=25

# ── OPSIONAL (AI & GITHUB) ──
GITHUB_TOKEN=
```

### 3. Jalankan Bot

```bash
npm start
```

Saat pertama kali jalan, bot akan meminta nomor (format: 628xxx) lalu menampilkan kode pairing. Masukkan kode tersebut di menu WhatsApp > Perangkat Tertaut > Tautkan dengan Nomor Telepon.

---

## 🛠️ Panduan Membuat Command Baru

Semua command diletakkan di dalam folder `commands/`. Bot mendukung dua gaya export:

### Gaya 1: Export Objek (Direkomendasikan)

```javascript
// commands/ping.js
export default {
    name: 'ping',
    alias: ['p', 'pong'],
    description: 'Mengecek respons bot',
    async run(ctx, args) {
        const start = Date.now();
        await ctx.reply(`🏓 Pong! ${Date.now() - start}ms`);
    }
};
```

### Gaya 2: Export Fungsi (Nama file otomatis menjadi nama command)

```javascript
// commands/hello.js
export default async function(ctx, args) {
    await ctx.reply(`Halo, ${ctx.pushName}!`);
}
```

---

## 📦 Dokumentasi Objek `ctx` (Context API)

Objek `ctx` sangat kaya dan disuntikkan langsung dari `message.js`. Berikut adalah properti dan method yang bisa Anda gunakan:

| Properti / Method | Tipe | Deskripsi |
| --- | --- | --- |
| `ctx.sock` | Object | Objek koneksi Baileys mentah. |
| `ctx.id` | String | JID chat saat ini (grup atau private). |
| `ctx.sender` | String | JID pengirim pesan (sudah dinormalisasi). |
| `ctx.chatType` | String | `SELF`, `PRIVATE`, `GROUP`, `BROADCAST`. |
| `ctx.isGroup` | Boolean | True jika pesan dari grup. |
| `ctx.isPrivate` | Boolean | True jika pesan dari private chat (bukan self). |
| `ctx.isSelf` | Boolean | True jika bot mengirim pesan ke dirinya sendiri. |
| `ctx.isOwner` | Boolean | True jika pengirim adalah `OWNER_NUMBER` di `.env`. |
| `ctx.isAdmin` | Boolean | True jika pengirim adalah admin grup. |
| `ctx.fromMe` | Boolean | True jika pesan dikirim oleh bot sendiri. |
| `ctx.pushName` | String | Nama profil WhatsApp pengirim (sudah ada fallback cerdas). |
| `ctx.quoted` | Object | Objek pesan yang dikutip (jika ada). |
| `ctx.mentionedJid` | Array | Array JID orang-orang yang di-mention. |
| `ctx.groupMetadata` | Object | Metadata grup (jika `ctx.isGroup` true). |
| `ctx.botLid` | String | LID (Linked ID) dari bot. |
| `ctx.msg` | Object | Objek pesan mentah dari Baileys. |
| `ctx.reply(text, opts)` | Function | Membalas pesan (dengan quote pesan asli). |
| `ctx.sendText(text)` | Function | Mengirim teks tanpa quote. |
| `ctx.sendMessage(content, opts)` | Function | Mengirim media (gambar, video, audio, dokumen). |
| `ctx.notifyOwner(text)` | Function | Mengirim pesan langsung ke nomor Owner. |

---

## 📂 Struktur Proyek

```text
📦 zeonebot
 ┣ 📂 commands/          # Folder tempat semua file command (menu.js, ping.js, dll)
 ┣ 📂 reports/           # (Auto-generated) File laporan terenkripsi (reports.json)
 ┣ 📂 session/           # (Auto-generated) Sesi autentikasi Baileys
 ┣ 📂 assets/            # Folder aset statis (images/zeone.jpg)
 ┣ 📜 start.js           # Entry point (Connection Handler, Circuit Breaker, Pairing)
 ┣ 📜 zeone.js           # Core Utilities, Logger, Command Loader, Priority Queue
 ┣ 📜 message.js         # Message Handler, Antilink, Deduplication, Report Manager
 ┣ 📜 database.js        # Sistem Database (AES-256-GCM + Write Queue)
 ┣ 📜 config.js          # Loader Environment Variables dari .env
 ┣ 📜 package.json       # Dependensi dan script npm
 ┗ 📜 .env               # (Dibuat manual) Variabel rahasia & konfigurasi
```

---

## ⚙️ Cara Kerja Internal (Untuk Developer)

- **Priority Queue (`zeone.js`)**: Antrean eksekusi command dibatasi maksimal 25 concurrent (bisa diubah via `MAX_CONCURRENT_COMMANDS`). Jika penuh, command akan masuk antrean dengan prioritas (Owner > Admin > User).
- **Message Store (`message.js`)**: Menyimpan cache pesan masuk selama 2 jam. Ini krusial untuk fitur `getMessage` milik Baileys, memastikan perangkat penerima bisa melakukan *retry decryption* dan tidak terjebak di status "Menunggu pesan ini".
- **Hot-Reload (`zeone.js`)**: Menggunakan `chokidar` dengan debounce 500ms. Catatan: Node.js ESM tidak bisa menghapus module cache dari memori. Hindari melakukan hot-reload terlalu sering di mode production untuk mencegah *memory leak*.

---

## 🐛 Troubleshooting

### 1. Bot gagal start: Missing required environment variables

Pastikan `DB_ENCRYPTION_KEY` dan `REPORT_ENCRYPTION_KEY` di file `.env` tidak kosong.

### 2. Bot crash saat pairing di PM2/Docker

Proses pairing butuh input terminal. Jalankan `node start.js` secara manual di VPS/terminal untuk pairing awal. Setelah folder `session/` terbentuk, baru pindahkan ke PM2.

### 3. Error "Menunggu pesan ini. Ini mungkin membutuhkan waktu beberapa saat." di HP penerima.

Ini terjadi jika sesi enkripsi korup atau device penerima gagal decrypt. Bot sudah dibekali `sendWithSessionRecovery` yang akan otomatis menghapus sesi korup dan mengirim ulang.

### 4. Memori (RAM) terus naik seiring waktu

Disebabkan oleh module cache dari fitur Hot-Reload ESM. Lakukan restart bot secara berkala (misal via `pm2 restart` atau cronjob mingguan).

---

## 📄 Lisensi & Kredit

- **Author:** Ahri De Valiente
- **Lisensi:** MIT
- **Core Engine:** @whiskeysockets/baileys v7.0.0-rc14

Dibangun dengan pendekatan First-Principles Engineering untuk performa dan stabilitas maksimal.
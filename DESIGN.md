# DESIGN.md — ars-reseller-bot (Telegram reseller bot, Workers webhook)

Status: LIVE sejak 2026-10-29 (jualan nyata pertama 01:49). Rel BAYAR
tetap ArxPays (QRIS + modal nol + markup 30%); sejak 2026-10-29
pengiriman pakai alur hybrid (§9): pembeli terima key `ca-...` dari
ArsRouter Proxy (cloud-arsgamingstore), bukan key ArxPays mentah.
Jangan dicampur dengan key gateway River (provider global gateway).

## 1. Yang dibangun (v1)

Bot Telegram reseller ArxPays via API (docs: arxpay.my.id/docs/reseller):

- `/start` + menu: Beli Paket, Pesanan Saya, Bantuan, Hubungi Admin.
- `/start` ala Jstore: kirim "🔄 Processing..." + bar 10 blok, diedit berulang sampai penuh (±2 detik), lalu jadi "✅ Data berhasil dimuat!" (dibiarkan, tidak dihapus), terus welcome personal + menu pakai efek api (fail-soft tanpa efek kalau ditolak). Loading ini kosmetik, TANPA fetch API (langkah API dicoret user 2026-10-29); edit best-effort (kena flood-control pun flow tetap jalan).
- Beli Paket → katalog (hanya produk yang harga jualnya dikonfigurasi)
  → pilih paket → bot minta email → konfirmasi (paket + harga jual)
  → create-invoice → tampilkan QR image + pay_url + order_ref +
  tombol "Cek Status".
- Cek Status (tombol, on-demand) → GET order status → kalau PAID dan
  belum pernah dikirim: buat key `ca-...` via gateway (§9), kirim key
  itu ke pembeli, tandai delivered. Kalau gateway gagal: order tetap
  "lunas, key disiapkan" (delivered false) — retry via sweep / Cek
  Status berikutnya; key ArxPays mentah TIDAK PERNAH dikirim.
  Kalau sudah delivered: jangan kirim ulang (key ada di riwayat chat
  pembeli; kalau hilang, arahkan ke Hubungi Admin).
- Pesanan Saya → daftar order chat itu (produk, harga jual, status)
  + tombol Cek Status untuk yang masih pending.
- Cron tiap menit → sapu order pending → kalau PAID, kirim key
  otomatis (cadangan kalau pembeli lupa tekan Cek Status).
- Pesan kirim kunci (alur hybrid §9) mencantumkan key `ca-...` +
  Base URL gateway + 2 model (deepseek-v4.1-flash-uncensored,
  glm-5.3-flash-uncensored) supaya pembeli langsung tahu pakainya di
  mana. Key ArxPays mentah TIDAK PERNAH muncul di chat.

## 2. Adaptasi jujur: polling 3 detik docs TIDAK BISA di Workers

Docs ArxPays menyarankan polling status tiap 3 detik — itu butuh
server loop. Workers tidak punya background loop. Adaptasi v1:

- Tombol "Cek Status" (cek on-demand, instan) = jalur utama.
- Cron Trigger tiap menit = sapu cadangan (maksimal telat 1 menit).
- Konsekuensi: key TIDAK selalu instan dalam 3 detik; worst case
  sampai 1 menit via cron, atau instan kalau pembeli tekan Cek Status.

## 3. Katalog (HPP dari docs ArxPays, 2026-10-28)

| product_id | Paket | HPP |
| --- | --- | --- |
| 28 | Paket 1M Token | Rp 5.500 |
| 31 | Paket 2M Token | Rp 10.000 |
| 32 | Paket 5M Token | Rp 24.000 |
| 33 | Paket 10M Token | Rp 45.000 |
| 34 | Paket 20M Token | Rp 85.000 |
| 35 | Paket 50M Token | Rp 210.000 |

Harga jual = dari env `SELL_PRICES` (JSON, mis.
`{"28":8000,"31":15000}`). FAIL-CLOSED: produk yang harga jualnya
tidak dikonfigurasi ATAU <= HPP TIDAK tampil di katalog (mencegah jual
rugi / harga belum diputus). Harga dasar (HPP) dan profit TIDAK PERNAH
ditampilkan ke pembeli — pembeli hanya melihat harga jual.

Harga awal / LAUNCH (keputusan user 2026-10-29, KUNCI): markup 30%
(menggantikan keputusan 10% tanggal 2026-10-28; user sempat
menimbang 20% → 15% → 25% lalu mengunci 30%):
`{"28":7150,"31":13000,"32":31200,"33":58500,"34":110500,"35":273000}`
(untung per paket: 1.650 / 3.000 / 7.200 / 13.500 / 25.500 / 63.000).
Konsekuensi: WD min Rp 50.000 kekumpul dalam ~31x laku paket 1M.
Menaikkan/menurunkan markup belakangan = ubah `SELL_PRICES` di
wrangler.toml `[vars]` + deploy, tanpa ubah kode.

## 4. Env (Worker Secrets vs Variables)

Secrets (dashboard Worker → Settings → Variables → Secrets):
- `BOT_TOKEN` — token bot Telegram (BotFather).
- `RESELLER_TOKEN` — X-Reseller-Token ArxPays (daftar reseller dulu).
- `WEBHOOK_SECRET` — secret_token Telegram (verifikasi webhook, wajib
  diset saat setWebhook; request tanpa secret yang cocok → 403).
- `BOT_SERVICE_KEY` — kredensial bot ke gateway (POST /api/bot/keys
  saja, bukan ADMIN_KEY). WAJIB SAMA nilainya dengan BOT_SERVICE_KEY
  di Pages project gateway (secret di kedua tempat). Dibuat sendiri
  oleh user (string acak 32+ karakter), TIDAK PERNAH lewat chat.

Variables (biasa, bukan secret — nilainya tidak sensitif; PERHATIAN: variable dashboard KEHAPUS tiap git deploy — variable yang harus menetap wajib di wrangler.toml `[vars]`):
- `SELL_PRICES` — JSON map product_id → harga jual (lihat §3), ditulis di wrangler.toml `[vars]` (BUKAN dashboard — variable dashboard kehapus tiap git deploy).
- `GATEWAY_URL` — origin ArsRouter Proxy untuk alur hybrid (buyer
  base URL = GATEWAY_URL + `/v1`), ditulis di wrangler.toml `[vars]`
  (fallback kode = `https://cloud-arsgamingstore.pages.dev`).
- `API_BASE_URL` — TIDAK LAGI DIPAKAI sejak alur hybrid (dulu base URL
  whitelabel di pesan kirim kunci). Boleh dihapus dari dashboard;
  dibiarkan pun tidak berpengaruh.
- `ADMIN_CONTACT` — username Telegram admin (tanpa @) untuk tombol
  Hubungi Admin; kosong = tombol tidak tampil sebagai link.

Binding (ditulis di wrangler.toml — binding dashboard KEHAPUS tiap git deploy, terbukti 2026-10-29; pelajaran GatewayARS soal placeholder id tidak berlaku di sini karena id-nya id namespace asli):
- `BOT_KV` — KV namespace bot (order + state chat).

## 5. State di KV (tidak ada data sensitif pembeli yang disimpan)

- `order:<ref>` — { chatId, productId, sellPrice, status, delivered,
  createdAt }. API KEY PEMBELI TIDAK PERNAH DISIMPAN di KV — key hanya
  dikirim sekali via pesan Telegram (riwayat chat pembeli = arsipnya).
- `chat:<id>:state` — { step, productId, email } selama flow beli
  (dihapus saat order dibuat / dibatalkan).
- Pesanan Saya = list `order:*` yang chatId-nya sama (filter di kode).

## 6. Keamanan

- Webhook diverifikasi via secret_token (403 kalau tidak cocok).
- `RESELLER_TOKEN` tidak pernah dikirim ke pembeli / ditulis ke log.
- HPP + profit tidak pernah tampil ke pembeli.
- Bot ini TIDAK memakai `ADMIN_KEY` gateway (kredensial terpisah).
- Pesan bot pakai plain text (tanpa parse_mode) supaya input user
  (email) tidak bisa merusak format pesan.

## 7. Yang SENGAJA tidak ada di v1

- Withdraw API (tarik komisi) — reseller (user) tarik via @ArxPay_bot
  /reseller atau API withdraw ArxPays langsung; bukan fitur bot pembeli.
- Penjualan key gateway River user — rel terpisah, bukan bot ini.
- Admin panel di bot — kelola reseller lewat ArxPays, bukan bot ini.
- Pembayaran selain QRIS ArxPays (Pakasir tidak bisa di bot — aturan
  pembayaran lewat bot; konfirmasi manual tidak dipakai karena
  ArxPays sudah otomatis).

## 8. Open items (harus ada sebelum deploy live)

1. `BOT_TOKEN` (BotFather) — user.
2. `RESELLER_TOKEN` (daftar reseller ArxPays) — user.
3. `SELL_PRICES` — user putuskan markup per paket.
4. KV namespace + bind `BOT_KV` — sudah di wrangler.toml (namespace BOT_KV sudah ada; jangan pindah ke dashboard, nanti kehapus tiap deploy).
5. Webhook: `setWebhook` ke `https://<worker>/telegram/webhook` dengan
   `secret_token` = `WEBHOOK_SECRET`; cron trigger tiap menit aktif.
6. Verifikasi saat test live: apakah `buyer_email` wajib diisi API
   (v1 selalu meminta email; kalau API ternyata menerima tanpa email,
   langkah email bisa dibuat opsional belakangan).
7. Repo GitHub + deploy: user buat repo kosong + pasang deploy key
   (pola sama seperti cloud-arsgamingstore) ATAU deploy dari PC user
   dengan kredensial sendiri. Kode v1 ini belum di-push ke mana-mana.

## 9. Alur hybrid (DIBANGUN 2026-10-29, LIVE — gateway 7e4423f, bot 89fd7fa): key ArxPays ditempel ke ArsRouter Proxy → key ca-

Ide user (2026-10-29): pembeli TETAP bayar lewat rel ArxPays (QRIS
+ modal nol + markup 30% tidak berubah), tapi key yang diterima pembeli
BUKAN key ArxPays mentah — melainkan key `ca-...` buatan ArsRouter
Proxy yang "ditempel" ke key ArxPays itu. Pembeli tidak pernah melihat
`arx-live-`, tidak pernah menyentuh `arxpay.my.id`, tidak pernah
mendapat nama produk "ArxPays LLM". Ini menyelesaikan keluhan "dapur
ke spil" dengan cara memiliki produk (gateway + key + toko sendiri),
bukan dengan menyembunyikan upstream. Rel ArxPays tetap hidup; ini
BUKAN penggantian rel bayar (sketsa "key sendiri lepas dari ArxPays"
yang lama sudah tidak berlaku — sketsa itu butuh rel bayar baru).

### Implementasi (2026-10-29)

- Gateway (`cloud-arsgamingstore`): record key `ca-...` punya field
  `upstream` (baseUrl allowlist: `https://arxpay.my.id` /
  `https://rest-api.arsgaming.ai.id`, apiKey, models) + `quota_type`
  (`package` = tidak reset bulanan; `monthly` = reset seperti dulu).
  Chat dengan key hybrid HANYA ke upstream-nya (model River → 404
  untuk key itu). `/v1/models` dengan key hybrid menampilkan model
  upstream dengan `owned_by: "ArsRouter Proxy"`. Endpoint
  `POST /api/bot/keys` (auth `BOT_SERVICE_KEY`) membuat key paket;
  admin path mengabaikan field upstream (tidak bisa diselundupkan).
- Bot: `src/lib/gateway.js` (client gateway) + `deliverHybridKey`
  di `bot.js` (satu-satunya jalur kirim key). Retry = ambil ulang
  arx key dari status ArxPays tiap percobaan (bot TIDAK menyimpan arx
  key); sweep TIDAK lagi melewati order `status: "paid"` yang belum
  delivered.
- Tes: gateway 13/13, bot 13/13 (termasuk: hybrid routing, kuota
  paket tidak reset, masking owned_by, gating kredensial bot,
  allowlist upstream, tidak ada bocor key di response/list, retry
  gagal → sukses).
- Keterbatasan yang diketahui: Cek Status dan sweep yang berjalan
  BERSAMAAN persis di order yang baru PAID bisa membuat 2 key `ca-...`
  untuk satu order (baca-ubah-tulis KV tidak atomik; re-read
  sebelum create mempersempit jendela tapi tidak menutupnya total).
  Dampak dibatasi: kedua key berbagi SATU saldo ArxPays (saldo itu
  yang membatasi pemakaian riil). Perbaikan atomik butuh Durable
  Object — v2, bukan sekarang.

### Yang dilihat pembeli

1. Order seperti biasa: pilih paket → email → konfirmasi → QRIS.
2. Setelah bayar, yang diterima: key `ca-...` + Base URL gateway
   (milik user) + daftar model. TIDAK ADA key `arx-live-` di pesan
   mana pun.

### Alur sistem (per pembelian)

1. Bot: order → invoice ArxPays → QRIS → status PAID → ArxPays
   mengembalikan key `arx-live-` (seperti sekarang).
2. Bot: panggil API ArsRouter Proxy untuk membuat key `ca-...` yang
   tertaut ke key ArxPays itu (kuota = token paket yang dibeli).
3. Bot: kirim key `ca-...` + Base URL gateway + model ke pembeli.
   Key ArxPays TIDAK PERNAH dikirim ke pembeli, TIDAK PERNAH disimpan
   di KV bot, TIDAK PERNAH di-log. Bot hanya menumpang lewat saat
   langkah 2.
4. Pembeli pakai key `ca-...` ke gateway user → gateway meneruskan
   request ke ArxPays memakai key ArxPays yang tertaut itu.
5. Satu pembelian = satu pasangan key baru (key ArxPays baru +
   key `ca-...` baru). Top-up key yang sama = fitur belakangan (v2),
   bukan scope desain ini.

### Perubahan ArsRouter Proxy (gateway)

- KV: record key `ca-...` mendapat field upstream (base URL ArxPays +
  key ArxPays tertaut). Routing memakai upstream milik key itu,
  BUKAN provider global River. (Provider River tetap untuk key-key
  gateway yang lama.)
- Kuota: key hasil bot bertipe "paket" — kuota = token paket dan
  TIDAK RESET bulanan (beda dari kuota bulanan key gateway sekarang;
  reset bulanan akan salah menghidupkan paket yang sudah habis).
- `/v1/models` gateway: `owned_by` harus ditutup merek sendiri —
  kalau list model menayangkan `owned_by: "arxpays"`, dapur masih
  ke-spil dari situ. Nama model tetap (itu nama fitur, bukan nama
  supplier).
- Kredensial bot: endpoint khusus pembuatan key untuk bot, dengan
  kredensial TERPISAH yang hanya boleh membuat key. JANGAN PERNAH
  berikan `ADMIN_KEY` gateway ke bot (aturan v2 yang sudah ada).

### Perubahan bot

- Setelah PAID: tambah langkah "buat key `ca-...` via gateway"
  sebelum kirim pesan sukses. Pesan sukses memuat key `ca-...`,
  Base URL gateway, dan model — bukan lagi Base URL whitelabel
  ArxPays.
- Gagal buat key gateway (gateway down / auth gagal): JANGAN kirim
  key ArxPays mentah sebagai fallback otomatis. Tandai order
  "menunggu key", ulangi lewat cron sweep, dan tombol Cek Status
  memberi tahu pembeli key sedang disiapkan. Fallback kirim key
  mentah hanya boleh atas keputusan manual admin.
- Harga/paket/katalog TIDAK BERUBAH (tetap order ArxPays + markup
  30% yang terkunci).

### Keamanan — dibaca sebelum build

- Key ArxPays pembeli tersimpan MENTAH di KV gateway (wajib, karena
  gateway harus menunjukkan key itu ke ArxPays saat meneruskan).
  Perlakukan KV gateway sebagai tempat secret: tidak di-log, tidak
  diumbar, akses admin saja. Kalau KV bocor, key ArxPays pembeli
  ikut bocor.
- Bot tidak menyimpan key ArxPays di KV-nya sendiri, di log, atau di
  riwayat yang bisa dibaca ulang selain chat pembeli — dan chat
  pembeli TIDAK PERNAH berisi key ArxPays di alur ini.

### Tradeoff yang disetujui user saat build

- Pembeli menjadi tergantung gateway user hidup: kalau gateway down,
  key `ca-...` tidak bisa dipakai (beda dari sekarang, pembeli
  memegang key ArxPays langsung yang jalan walau sistem user mati).
  Gateway di Pages (always-on) membuat risiko ini kecil, tapi tetap
  dependensi baru.

### Rencana tes (sebelum dianggap jadi)

- Tes unit SELESAI (2026-10-29): gateway 13/13, bot 13/13 (lihat
  "Implementasi" di atas).
- Tes LIVE (menunggu user, butuh 1 order tes Rp 7.150):
  1. Order tes → key `ca-...` terbit → chat via gateway pakai key
     `ca-...` dijawab (model ArxPays lewat gateway).
  2. Saldo ArxPays berkurang sesuai pemakaian lewat gateway.
  3. Gateway dimatikan sesaat → order masuk status "menunggu key",
     tidak ada key mentah yang terkirim; setelah gateway hidup, sweep
     menyelesaikan pengiriman.
  4. `/v1/models` gateway dengan key hybrid tidak menampakkan
     `arxpays` di mana pun.

### Keputusan yang masih terbuka

- Base URL gateway untuk pembeli: DIPUTUS v1 = URL Pages
  (`cloud-arsgamingstore.pages.dev/v1`, via `GATEWAY_URL`); custom
  domain belakangan (tinggal ubah `GATEWAY_URL`).
- Website toko (scope a/b/c dari 2026-10-29) = masih terbuka, tidak
  menghambat alur hybrid bot.
- Top-up key yang sama (pakai `topup_key` ArxPays + tambah kuota
  key `ca-...`) = v2, bukan sekarang.

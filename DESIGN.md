# DESIGN.md — ars-reseller-bot (Telegram reseller bot, Workers webhook)

Status: v1 DALAM PEMBANGUNAN (2026-10-28). Bukan bagian dari gateway
Pages (cloud-arsgamingstore) — ini REL TERPISAH: bot ini menjual key
ArxPays (gateway mereka), bukan key gateway River user. Jangan dicampur.

## 1. Yang dibangun (v1)

Bot Telegram reseller ArxPays via API (docs: arxpay.my.id/docs/reseller):

- `/start` + menu: Beli Paket, Pesanan Saya, Bantuan, Hubungi Admin.
- Beli Paket → katalog (hanya produk yang harga jualnya dikonfigurasi)
  → pilih paket → bot minta email → konfirmasi (paket + harga jual)
  → create-invoice → tampilkan QR image + pay_url + order_ref +
  tombol "Cek Status".
- Cek Status (tombol, on-demand) → GET order status → kalau PAID dan
  belum pernah dikirim: kirim api_key ke pembeli, tandai delivered.
  Kalau sudah delivered: jangan kirim ulang (key ada di riwayat chat
  pembeli; kalau hilang, arahkan ke Hubungi Admin).
- Pesanan Saya → daftar order chat itu (produk, harga jual, status)
  + tombol Cek Status untuk yang masih pending.
- Cron tiap menit → sapu order pending → kalau PAID, kirim key
  otomatis (cadangan kalau pembeli lupa tekan Cek Status).

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

Harga awal / LAUNCH (keputusan user 2026-10-28): markup 10% saja dulu
(strategi buka murah buat narik pembeli, naik belakangan):
`{"28":6050,"31":11000,"32":26400,"33":49500,"34":93500,"35":231000}`
(untung per paket: 550 / 1.000 / 2.400 / 4.500 / 8.500 / 21.000).
Konsekuensi: WD min Rp 50.000 kekumpulnya lebih lama (mis. ~91x laku
paket 1M baru bisa WD). Menaikkan markup belakangan = ubah env
`SELL_PRICES` saja, tanpa ubah kode.

## 4. Env (Worker Secrets vs Variables)

Secrets (dashboard Worker → Settings → Variables → Secrets):
- `BOT_TOKEN` — token bot Telegram (BotFather).
- `RESELLER_TOKEN` — X-Reseller-Token ArxPays (daftar reseller dulu).
- `WEBHOOK_SECRET` — secret_token Telegram (verifikasi webhook, wajib
  diset saat setWebhook; request tanpa secret yang cocok → 403).

Variables (biasa, bukan secret — nilainya tidak sensitif):
- `SELL_PRICES` — JSON map product_id → harga jual (lihat §3).
- `ADMIN_CONTACT` — username Telegram admin (tanpa @) untuk tombol
  Hubungi Admin; kosong = tombol tidak tampil sebagai link.

Binding (dashboard, BUKAN wrangler.toml — placeholder id gagal deploy):
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
4. KV namespace + bind `BOT_KV` — user di dashboard Worker.
5. Webhook: `setWebhook` ke `https://<worker>/telegram/webhook` dengan
   `secret_token` = `WEBHOOK_SECRET`; cron trigger tiap menit aktif.
6. Verifikasi saat test live: apakah `buyer_email` wajib diisi API
   (v1 selalu meminta email; kalau API ternyata menerima tanpa email,
   langkah email bisa dibuat opsional belakangan).
7. Repo GitHub + deploy: user buat repo kosong + pasang deploy key
   (pola sama seperti cloud-arsgamingstore) ATAU deploy dari PC user
   dengan kredensial sendiri. Kode v1 ini belum di-push ke mana-mana.

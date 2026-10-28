# ars-reseller-bot — Bot Telegram reseller ArxPays (Workers webhook)

Bot ini menjual paket API ArxPays via API reseller (QRIS + kirim key
otomatis + komisi markup). Rel TERPISAH dari gateway ArsRouter Proxy
(Pages): bot ini menjual key ArxPays, bukan key gateway River.
Desain lengkap: `DESIGN.md`.

## Fitur v1

- `/start` + menu: Beli Paket, Pesanan Saya, Bantuan, Hubungi Admin.
- Beli: pilih paket → email → konfirmasi → invoice QRIS → tombol
  Cek Status → key dikirim saat LUNAS.
- Cron tiap menit menyapu order pending (cadangan kalau pembeli lupa
  tekan Cek Status). Polling 3 detik docs tidak bisa di Workers —
  adaptasi ini didokumentasikan di `DESIGN.md` §2.
- Fail-closed: produk tanpa harga jual (atau harga <= HPP) tidak tampil.
- API key pembeli TIDAK PERNAH disimpan di KV (hanya dikirim via chat).

## Tes

```sh
node --test test/bot.test.mjs
```

Semua tes pakai stub (FakeKV + stub fetch) — tanpa token asli.

## Deploy (oleh user, dengan kredensial sendiri)

1. Buat Worker (wrangler deploy dari PC user, atau dashboard).
2. Buat KV namespace → bind sebagai `BOT_KV` (dashboard Worker →
   Settings → Variables → KV Namespace Bindings).
3. Set Secrets: `BOT_TOKEN` (BotFather), `RESELLER_TOKEN` (daftar
   reseller ArxPays), `WEBHOOK_SECRET` (bebas, string acak panjang).
4. Set Variables: `SELL_PRICES` (JSON, mis.
   `{"28":8000,"31":15000}` — hanya produk yang ada di sini yang
   dijual, dan harus di atas HPP), `ADMIN_CONTACT` (username Telegram
   admin tanpa @, opsional).
5. Set webhook Telegram (ganti `<TOKEN>` dan `<WORKER_URL>`):
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/telegram/webhook&secret_token=<WEBHOOK_SECRET>`
6. Pastikan cron trigger tiap menit aktif (dari `wrangler.toml`).

## Yang belum (butuh user)

- `BOT_TOKEN`, `RESELLER_TOKEN`, `SELL_PRICES` (markup per paket).
- Repo GitHub + deploy key (pola sama seperti cloud-arsgamingstore)
  kalau mau auto-deploy dari repo; kalau tidak, deploy dari PC user.
- Verifikasi live: apakah `buyer_email` wajib diisi API (v1 selalu
  meminta email; kalau ternyata opsional, langkah email bisa dibuat
  opsional belakangan).

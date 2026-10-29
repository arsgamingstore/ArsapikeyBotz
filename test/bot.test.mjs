// Tes bot reseller — node --test test/bot.test.mjs (tanpa key asli,
// semua fetch di-stub). Meniru pola tes gateway (FakeKV + stub fetch).
import test from "node:test";
import assert from "node:assert/strict";
import { catalogForSale, parseSellPrices } from "../src/lib/catalog.js";
import { handleUpdate, sweepPendingOrders } from "../src/lib/bot.js";
import { checkWebhookSecret } from "../src/index.js";

class FakeKV {
  constructor() {
    this.map = new Map();
  }
  async get(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  async put(k, v) {
    this.map.set(k, v);
  }
  async delete(k) {
    this.map.delete(k);
  }
  async list({ prefix }) {
    return { keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  }
}

function fakeTg() {
  const sent = [];
  const deleted = [];
  let nextId = 100;
  return {
    sent,
    deleted,
    async sendMessage(chatId, text, markup, effectId) {
      const id = nextId++;
      sent.push({ kind: "message", chatId, text, markup, effectId, id });
      return id;
    },
    async deleteMessage(chatId, messageId) {
      deleted.push({ chatId, messageId });
      return true;
    },
    async sendPhoto(chatId, photo, caption) {
      sent.push({ kind: "photo", chatId, photo, caption });
      return true;
    },
    async answerCallbackQuery() {
      return true;
    },
  };
}

// Stub ArxPays + gateway: create-invoice selalu sukses; status order bisa
// diatur per ref lewat `statusByRef`; `gateway.failTimes` = berapa kali
// pertama create ca- key gagal (lalu sukses).
function stubArxpay(statusByRef = {}, gateway = {}) {
  const calls = [];
  let gwFailsLeft = gateway.failTimes || 0;
  const fetcher = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("/api/bot/keys")) {
      if (gwFailsLeft > 0) {
        gwFailsLeft--;
        return { ok: false, status: 500, json: async () => ({ error: { message: "gateway boom" } }) };
      }
      return {
        ok: true,
        json: async () => ({ id: "abc123", name: "Paket 1M Token", key: "ca-testkey123", quota_tokens: 1000000, quota_type: "package" }),
      };
    }
    if (url.includes("create-invoice")) {
      return {
        ok: true,
        json: async () => ({
          status: "success",
          order_ref: "RSLTEST123",
          product_name: "Paket 1 Juta Token",
          base_price: 5500,
          sell_price: 8000,
          reseller_profit: 2500,
          qr_string: "000201010212...",
          qr_image_url: "https://example.test/qr.png",
          pay_url: "https://example.test/pay/1",
          check_status_url: "https://example.test/status?ref=RSLTEST123",
        }),
      };
    }
    if (url.includes("order/status")) {
      const ref = new URL(url).searchParams.get("ref");
      const st = statusByRef[ref] || { status: "PENDING" };
      return { ok: true, json: async () => st };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetcher, calls };
}

const ENV = { RESELLER_TOKEN: "test-token", BOT_SERVICE_KEY: "bot-test-secret", SELL_PRICES: JSON.stringify({ 28: 8000 }), ADMIN_CONTACT: "testadmin" };
const CHAT = 12345;
const msg = (text) => ({ message: { chat: { id: CHAT }, text } });
const cq = (data) => ({ callback_query: { id: "cq1", message: { chat: { id: CHAT } }, data } });

test("katalog fail-closed: tanpa harga / harga <= HPP disembunyikan", () => {
  assert.deepEqual(catalogForSale({}), []);
  assert.deepEqual(catalogForSale({ 28: 5500 }), []);
  assert.deepEqual(catalogForSale({ 28: 5000 }), []);
  const items = catalogForSale({ 28: 8000, 31: 15000 });
  assert.equal(items.length, 2);
  assert.equal(items[0].sellPrice, 8000);
  assert.deepEqual(parseSellPrices("bukan json"), {});
  assert.deepEqual(parseSellPrices(JSON.stringify({ 28: "mahal" })), {});
});

test("/start mengirim welcome personal + menu", async () => {
  const start = (from) => ({ message: { chat: { id: CHAT }, text: "/start", from } });
  const kv = new FakeKV();
  const tg = fakeTg();
  await handleUpdate(ENV, kv, tg, start({ first_name: "Budi", last_name: "Santoso", username: "budi123" }), stubArxpay().fetcher);
  assert.equal(tg.sent.length, 2);
  // Pesan pertama = loading, dihapus, lalu welcome pakai efek api.
  assert.match(tg.sent[0].text, /Memuat/);
  assert.equal(tg.sent[0].effectId, undefined);
  assert.deepEqual(tg.deleted, [{ chatId: CHAT, messageId: tg.sent[0].id }]);
  assert.equal(tg.sent[1].effectId, "5104841245755180586");
  assert.match(tg.sent[1].text, /SELAMAT DATANG, Budi Santoso/);
  assert.match(tg.sent[1].text, /Bot Kebutuhan AI/);
  assert.ok(tg.sent[1].markup.inline_keyboard.length >= 3);
  // Tanpa nama depan → pakai @username.
  const tg2 = fakeTg();
  await handleUpdate(ENV, new FakeKV(), tg2, start({ username: "budi123" }), stubArxpay().fetcher);
  assert.match(tg2.sent[1].text, /SELAMAT DATANG, @budi123/);
  // Tanpa info pengirim sama sekali → fallback Kak.
  const tg3 = fakeTg();
  await handleUpdate(ENV, new FakeKV(), tg3, msg("/start"), stubArxpay().fetcher);
  assert.match(tg3.sent[1].text, /SELAMAT DATANG, Kak/);
});

test("/start tetap kirim welcome tanpa efek kalau Telegram menolak effect id", async () => {
  const sent = [];
  const tg = {
    sent,
    async sendMessage(chatId, text, markup, effectId) {
      sent.push({ chatId, text, markup, effectId });
      return effectId === undefined;
    },
    async sendPhoto() {
      return true;
    },
    async answerCallbackQuery() {
      return true;
    },
  };
  await handleUpdate(ENV, new FakeKV(), tg, { message: { chat: { id: CHAT }, text: "/start", from: { first_name: "Budi" } } }, stubArxpay().fetcher);
  // Stub ini tanpa deleteMessage (objek tg minimal) — penghapusan loading
  // di-skip, tapi urutan pesan tetap: loading, welcome+efek (gagal), welcome.
  assert.equal(sent.length, 3);
  assert.match(sent[0].text, /Memuat/);
  assert.equal(sent[1].effectId, "5104841245755180586");
  assert.equal(sent[2].effectId, undefined);
  assert.match(sent[2].text, /SELAMAT DATANG, Budi/);
});

test("/start tetap kirim welcome walau hapus loading gagal", async () => {
  const sent = [];
  const tg = {
    sent,
    async sendMessage(chatId, text, markup, effectId) {
      sent.push({ chatId, text, markup, effectId });
      return 42;
    },
    async deleteMessage() {
      throw new Error("delete boom");
    },
    async sendPhoto() {
      return true;
    },
    async answerCallbackQuery() {
      return true;
    },
  };
  await handleUpdate(ENV, new FakeKV(), tg, { message: { chat: { id: CHAT }, text: "/start", from: { first_name: "Budi" } } }, stubArxpay().fetcher);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /SELAMAT DATANG, Budi/);
  assert.equal(sent[1].effectId, "5104841245755180586");
});

test("/caraorder mengirim teks bantuan", async () => {
  const tg = fakeTg();
  await handleUpdate(ENV, new FakeKV(), tg, msg("/caraorder"), stubArxpay().fetcher);
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].text, /Bantuan/);
  assert.match(tg.sent[0].text, /Pilih Beli Paket/);
  assert.ok(tg.sent[0].markup.inline_keyboard.length >= 3);
});

test("alur beli penuh: katalog → email → konfirmasi → invoice → QR", async () => {
  const kv = new FakeKV();
  const tg = fakeTg();
  const { fetcher, calls } = stubArxpay();
  await handleUpdate(ENV, kv, tg, cq("menu:buy"), fetcher);
  assert.match(tg.sent.at(-1).text, /Paket 1M Token/);
  await handleUpdate(ENV, kv, tg, cq("buy:28"), fetcher);
  assert.match(tg.sent.at(-1).text, /email/);
  await handleUpdate(ENV, kv, tg, msg("bukan-email"), fetcher);
  assert.match(tg.sent.at(-1).text, /belum valid/);
  assert.equal(calls.filter((c) => c.url.includes("create-invoice")).length, 0);
  await handleUpdate(ENV, kv, tg, msg("user@mail.com"), fetcher);
  assert.match(tg.sent.at(-1).text, /Konfirmasi pesanan/);
  assert.match(tg.sent.at(-1).text, /Rp 8\.000/);
  await handleUpdate(ENV, kv, tg, cq("confirm"), fetcher);
  const inv = calls.find((c) => c.url.includes("create-invoice"));
  assert.ok(inv);
  const body = JSON.parse(inv.opts.body);
  assert.equal(body.product_id, 28);
  assert.equal(body.sell_price, 8000);
  assert.equal(body.buyer_email, "user@mail.com");
  assert.equal(inv.opts.headers["X-Reseller-Token"], "test-token");
  const saved = JSON.parse(await kv.get("order:RSLTEST123"));
  assert.equal(saved.status, "pending");
  assert.equal(saved.delivered, false);
  assert.ok(tg.sent.some((s) => s.kind === "photo" && s.photo === "https://example.test/qr.png"));
  // Tombol "Cek Status" ada di keyboard (callback_data), bukan di teks pesan.
  assert.ok(
    tg.sent.some((s) => s.kind === "message" && s.markup && JSON.stringify(s.markup).includes("check:RSLTEST123")),
  );
});

test("beli produk tanpa harga ditolak", async () => {
  const kv = new FakeKV();
  const tg = fakeTg();
  await handleUpdate(ENV, kv, tg, cq("buy:31"), stubArxpay().fetcher);
  assert.match(tg.sent.at(-1).text, /tidak tersedia/);
  assert.equal(await kv.get(`chat:${CHAT}:state`), null);
});

test("cek status PAID kirim ca- key sekali saja, arx key tidak pernah muncul", async () => {
  const kv = new FakeKV();
  const tg = fakeTg();
  const { fetcher, calls } = stubArxpay({ RSLTEST123: { status: "PAID", api_key: "arx-live-TESTKEY", product_name: "ArxPays LLM [1M Token]" } });
  await kv.put(
    "order:RSLTEST123",
    JSON.stringify({ ref: "RSLTEST123", chatId: CHAT, productId: 28, sellPrice: 8000, status: "pending", delivered: false, createdAt: 1 }),
  );
  await handleUpdate(ENV, kv, tg, cq("check:RSLTEST123"), fetcher);
  const gw = calls.find((c) => c.url.includes("/api/bot/keys"));
  assert.ok(gw);
  assert.equal(gw.opts.headers.Authorization, "Bearer bot-test-secret");
  const body = JSON.parse(gw.opts.body);
  assert.equal(body.quota_tokens, 1000000);
  assert.equal(body.upstream_api_key, "arx-live-TESTKEY");
  assert.deepEqual(body.models, ["deepseek-v4.1-flash-uncensored", "glm-5.3-flash-uncensored"]);
  const delivered = tg.sent.find((s) => s.text && s.text.includes("ca-testkey123"));
  assert.ok(delivered);
  assert.ok(!delivered.text.includes("arx-live-TESTKEY"));
  assert.ok(!delivered.text.includes("ArxPays"));
  assert.ok(delivered.text.includes("Paket 1M Token"));
  assert.ok(delivered.text.includes("https://cloud-arsgamingstore.pages.dev/v1\n"));
  assert.ok(!JSON.stringify(tg.sent).includes("arx-live-TESTKEY"));
  const saved = JSON.parse(await kv.get("order:RSLTEST123"));
  assert.equal(saved.delivered, true);
  assert.equal(saved.status, "paid");
  // Cek kedua: tidak kirim ulang, tidak bikin key kedua.
  tg.sent.length = 0;
  await handleUpdate(ENV, kv, tg, cq("check:RSLTEST123"), fetcher);
  assert.equal(calls.filter((c) => c.url.includes("/api/bot/keys")).length, 1);
  assert.match(tg.sent.at(-1).text, /sudah pernah dikirim/);
});

test("cek status belum lunas tidak kirim key", async () => {
  const kv = new FakeKV();
  const tg = fakeTg();
  const { fetcher } = stubArxpay({ RSLTEST123: { status: "PENDING" } });
  await kv.put(
    "order:RSLTEST123",
    JSON.stringify({ ref: "RSLTEST123", chatId: CHAT, productId: 28, sellPrice: 8000, status: "pending", delivered: false, createdAt: 1 }),
  );
  await handleUpdate(ENV, kv, tg, cq("check:RSLTEST123"), fetcher);
  assert.match(tg.sent.at(-1).text, /Belum lunas/);
  const saved = JSON.parse(await kv.get("order:RSLTEST123"));
  assert.equal(saved.delivered, false);
});

test("pesanan saya menampilkan order chat itu saja", async () => {
  const kv = new FakeKV();
  const tg = fakeTg();
  await kv.put("order:A", JSON.stringify({ ref: "A", chatId: CHAT, productId: 28, sellPrice: 8000, status: "pending", delivered: false, createdAt: 2 }));
  await kv.put("order:B", JSON.stringify({ ref: "B", chatId: 999, productId: 28, sellPrice: 8000, status: "pending", delivered: false, createdAt: 1 }));
  await handleUpdate(ENV, kv, tg, cq("menu:orders"), stubArxpay().fetcher);
  assert.match(tg.sent.at(-1).text, /ref: A/);
  assert.doesNotMatch(tg.sent.at(-1).text, /ref: B/);
});

test("sweep cron mengirim ca- key order PAID dan melewati yang belum lunas", async () => {
  const kv = new FakeKV();
  const tg = fakeTg();
  const { fetcher } = stubArxpay({ PAID1: { status: "PAID", api_key: "arx-live-SWEEP", product_name: "ArxPays LLM" }, PEND1: { status: "PENDING" } });
  await kv.put("order:PAID1", JSON.stringify({ ref: "PAID1", chatId: CHAT, productId: 28, sellPrice: 8000, status: "pending", delivered: false, createdAt: 1 }));
  await kv.put("order:PEND1", JSON.stringify({ ref: "PEND1", chatId: CHAT, productId: 28, sellPrice: 8000, status: "pending", delivered: false, createdAt: 2 }));
  await sweepPendingOrders(ENV, kv, tg, fetcher);
  assert.ok(tg.sent.some((s) => s.text && s.text.includes("ca-testkey123")));
  assert.ok(!JSON.stringify(tg.sent).includes("arx-live-SWEEP"));
  assert.equal(JSON.parse(await kv.get("order:PAID1")).delivered, true);
  assert.equal(JSON.parse(await kv.get("order:PEND1")).delivered, false);
});

test("cek status PAID tapi gateway gagal → tidak delivered, retry berhasil", async () => {
  const kv = new FakeKV();
  const tg = fakeTg();
  const { fetcher, calls } = stubArxpay({ RSLFAIL1: { status: "PAID", api_key: "arx-live-FAIL1", product_name: "ArxPays LLM" } }, { failTimes: 1 });
  await kv.put("order:RSLFAIL1", JSON.stringify({ ref: "RSLFAIL1", chatId: CHAT, productId: 28, sellPrice: 8000, status: "pending", delivered: false, createdAt: 1 }));
  await handleUpdate(ENV, kv, tg, cq("check:RSLFAIL1"), fetcher);
  assert.match(tg.sent.at(-1).text, /sedang disiapkan/);
  assert.ok(!JSON.stringify(tg.sent).includes("arx-live-FAIL1"));
  const saved = JSON.parse(await kv.get("order:RSLFAIL1"));
  assert.equal(saved.status, "paid");
  assert.equal(saved.delivered, false);
  // Retry (sweep): arx key diambil ulang dari status, gateway sukses.
  tg.sent.length = 0;
  await sweepPendingOrders(ENV, kv, tg, fetcher);
  assert.ok(tg.sent.some((s) => s.text && s.text.includes("ca-testkey123")));
  assert.equal(JSON.parse(await kv.get("order:RSLFAIL1")).delivered, true);
  assert.equal(calls.filter((c) => c.url.includes("/api/bot/keys")).length, 2);
});

test("pesan kirim kunci memakai base URL gateway, bukan whitelabel", async () => {
  const { fetcher } = stubArxpay({ RSLURL1: { status: "PAID", api_key: "arx-live-URL1", product_name: "ArxPays LLM" } });
  const mkOrder = () =>
    JSON.stringify({ ref: "RSLURL1", chatId: CHAT, productId: 28, sellPrice: 7150, status: "pending", delivered: false, createdAt: 1 });
  // Tanpa GATEWAY_URL → fallback Pages.
  const kv = new FakeKV();
  const tg = fakeTg();
  await kv.put("order:RSLURL1", mkOrder());
  await handleUpdate(ENV, kv, tg, cq("check:RSLURL1"), fetcher);
  const msg = tg.sent.find((s) => s.text && s.text.includes("ca-testkey123")).text;
  assert.ok(msg.includes("https://cloud-arsgamingstore.pages.dev/v1\n"));
  assert.ok(!msg.includes("rest-api.arsgaming.ai.id"));
  assert.ok(!msg.includes("arx-live-URL1"));
  assert.ok(msg.includes("deepseek-v4.1-flash-uncensored"));
  assert.ok(msg.includes("glm-5.3-flash-uncensored"));
  // Dengan GATEWAY_URL → pakai env (slash akhir dipangkas) + /v1.
  const kv2 = new FakeKV();
  const tg2 = fakeTg();
  await kv2.put("order:RSLURL1", mkOrder());
  await handleUpdate({ ...ENV, GATEWAY_URL: "https://api.contoh.id/" }, kv2, tg2, cq("check:RSLURL1"), fetcher);
  const msg2 = tg2.sent.find((s) => s.text && s.text.includes("ca-testkey123")).text;
  assert.ok(msg2.includes("https://api.contoh.id/v1\n"));
});

test("verifikasi webhook secret", () => {
  const req = (token) => ({ headers: { get: (n) => (n === "X-Telegram-Bot-Api-Secret-Token" ? token : null) } });
  assert.equal(checkWebhookSecret(req("x"), {}), true);
  assert.equal(checkWebhookSecret(req("s3cr3t"), { WEBHOOK_SECRET: "s3cr3t" }), true);
  assert.equal(checkWebhookSecret(req("salah"), { WEBHOOK_SECRET: "s3cr3t" }), false);
});

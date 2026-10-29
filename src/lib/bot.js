// Logika bot reseller (pure kecuali kv + tg yang di-inject).
// Dipakai Worker (src/index.js) dan tes (test/bot.test.mjs).
import { PRODUCTS, catalogForSale, formatIDR, parseSellPrices } from "./catalog.js";
import { createInvoice, getOrderStatus } from "./arxpay.js";
import { createGatewayKey, gatewayOrigin } from "./gateway.js";
import { mainMenuKeyboard, catalogKeyboard, confirmKeyboard, orderKeyboard } from "./telegram.js";

// Sapaan /start + Menu Utama: personal, pakai nama depan (atau
// @username kalau nama tidak ada).
function welcomeMessage(from) {
  const name =
    [from?.first_name, from?.last_name].filter(Boolean).join(" ") ||
    (from?.username ? `@${from.username}` : "Kak");
  return `👋 SELAMAT DATANG, ${name}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤖 Bot Kebutuhan AI\n\nKami Menyediakan Models Uncensored\n🤖 Token AI\n   └ 🧠 deepseek-v4.1-flash-uncensored · 🔑 glm-5.3-flash-uncensored\n\n🆘 Support: @arsgamingstore`;
}

const HELP =
  "❓ Bantuan\n\n1. Pilih Beli Paket → pilih paket → masukkan email → konfirmasi.\n2. Scan QRIS yang muncul (atau buka link pembayaran).\n3. Setelah bayar, tekan Cek Status — API key langsung dikirim ke chat ini.\n4. Pesanan Saya menampilkan semua order kamu.\n\nPembayaran diproses otomatis. Kalau ada kendala, hubungi admin.";

// ID efek api Telegram (message_effect_id, khusus private chat).
// Dikonfirmasi dari 2 sumber independen: daftar efek Botmother dan
// contoh Laravel Telegram — keduanya: 🔥 = 5104841245755180586.
// Efek itu kosmetik: kalau Telegram menolak ID ini, /start tetap kirim
// welcome tanpa efek (fail-soft di handler /start).
const FIRE_EFFECT_ID = "5104841245755180586";

function stateKey(chatId) {
  return `chat:${chatId}:state`;
}
function orderKey(ref) {
  return `order:${ref}`;
}

async function getJson(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function putJson(kv, key, obj) {
  await kv.put(key, JSON.stringify(obj));
}

function validEmail(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length < 3 || t.length > 254 || /\s/.test(t)) return false;
  const at = t.indexOf("@");
  if (at < 1) return false;
  return t.indexOf(".", at) > at + 1;
}

function statusLabel(order) {
  return order.status === "paid" ? "Lunas ✅" : "Menunggu pembayaran ⏳";
}

async function listOrdersForChat(kv, chatId) {
  const listed = await kv.list({ prefix: "order:" });
  const out = [];
  for (const k of listed.keys || []) {
    const o = await getJson(kv, k.name);
    if (o && o.chatId === chatId) out.push(o);
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

function productById(id) {
  return PRODUCTS.find((p) => p.id === id) || null;
}

// Model yang dijual bot (ArxPays flagship). Daftar ini dipakai di DUA
// tempat sekaligus — request bikin key ke gateway DAN pesan kirim kunci —
// supaya keduanya tidak pernah beda.
const HYBRID_MODELS = ["deepseek-v4.1-flash-uncensored", "glm-5.3-flash-uncensored"];

// Kuota gateway = token paket (katalog "1M" -> 1000000). Gagal parse =
// jangan bikin key dengan kuota salah.
function packageTokens(product) {
  const n = parseInt(product && product.tokens, 10);
  return Number.isInteger(n) && n > 0 ? n * 1000000 : null;
}

// Pesan kirim kunci HYBRID: hanya ca- key + base URL gateway + model.
// Nama produk dari katalog bot (bukan nama produk ArxPays), dan key arx
// TIDAK PERNAH muncul di chat.
function keyDeliveryMessage(caKey, productName, env) {
  const baseUrl = `${gatewayOrigin(env)}/v1`;
  return `✅ Pembayaran berhasil!\n\nProduk: ${productName}\n\nAPI key kamu:\n${caKey}\n\nBase URL:\n${baseUrl}\n\nModel:\n${HYBRID_MODELS.map((m) => `• ${m}`).join("\n")}\n\nSimpan key ini baik-baik. Key tidak disimpan di bot — kalau hilang, hubungi admin.`;
}

// Satu-satunya jalur pengiriman key: arx key ditempel ke gateway, buyer
// cuma terima ca- key. Kalau gateway gagal, order TIDAK ditandai
// delivered — sweep / Cek Status akan retry dengan mengambil ulang arx
// key dari status ArxPays (bot TIDAK PERNAH menyimpan arx key).
// TIDAK ADA fallback kirim key arx mentah, dalam kondisi apa pun.
async function deliverHybridKey(env, kv, tg, fetcher, order, arxKey) {
  const p = productById(order.productId);
  const quota = packageTokens(p);
  if (!quota) return { ok: false, error: "unknown package tokens" };
  // Baca ulang: kalau jalur lain sudah mengirim di sela waktu, jangan
  // bikin ca- key kedua.
  const fresh = await getJson(kv, orderKey(order.ref));
  if (fresh && fresh.delivered) return { ok: true, already: true };
  const gw = await createGatewayKey(fetcher, env, {
    name: p ? p.name : order.productId,
    quota_tokens: quota,
    upstream_api_key: arxKey,
    models: HYBRID_MODELS,
  });
  if (!gw.ok) {
    order.status = "paid"; // lunas, tapi key belum terbit
    order.delivered = false;
    await putJson(kv, orderKey(order.ref), order);
    return { ok: false, error: gw.error };
  }
  order.status = "paid";
  order.delivered = true;
  await putJson(kv, orderKey(order.ref), order);
  await tg.sendMessage(
    order.chatId,
    keyDeliveryMessage(gw.key, p ? p.name : order.productId, env),
    mainMenuKeyboard(),
  );
  return { ok: true };
}

export async function handleUpdate(env, kv, tg, update, fetcher) {
  const sellPrices = parseSellPrices(env.SELL_PRICES);

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat && msg.chat.id;
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    if (!chatId) return;
    if (text === "/start") {
      await kv.delete(stateKey(chatId));
      const welcome = welcomeMessage(msg.from);
      // Loading ala Jstore: pesan loading dulu, jeda kosmetik sebentar
      // (BUKAN fetch data — langkah API dicoret user 2026-10-29),
      // lalu hapus dan kirim welcome pakai efek api.
      const loadingId = await tg.sendMessage(chatId, "⏳ Memuat data...");
      await new Promise((r) => setTimeout(r, 900));
      if (typeof loadingId === "number" && typeof tg.deleteMessage === "function") {
        try {
          await tg.deleteMessage(chatId, loadingId);
        } catch {
          // Best-effort: kalau gagal dihapus, welcome tetap dikirim.
        }
      }
      const sent = await tg.sendMessage(chatId, welcome, mainMenuKeyboard(), FIRE_EFFECT_ID);
      if (!sent) await tg.sendMessage(chatId, welcome, mainMenuKeyboard());
      return;
    }
    if (text === "/help") {
      await tg.sendMessage(chatId, HELP, mainMenuKeyboard());
      return;
    }
    if (text === "/caraorder") {
      await tg.sendMessage(chatId, HELP, mainMenuKeyboard());
      return;
    }
    const state = await getJson(kv, stateKey(chatId));
    if (state && state.step === "await_email") {
      if (!validEmail(text)) {
        await tg.sendMessage(chatId, "Email itu belum valid. Kirim email yang benar (contoh: nama@email.com).");
        return;
      }
      await putJson(kv, stateKey(chatId), { step: "await_confirm", productId: state.productId, email: text });
      const p = productById(state.productId);
      const price = sellPrices[state.productId];
      await tg.sendMessage(
        chatId,
        `Konfirmasi pesanan:\n\nPaket: ${p ? p.name : state.productId}\nHarga: ${formatIDR(price)}\nEmail: ${text}\n\nLanjut buat invoice QRIS?`,
        confirmKeyboard(),
      );
      return;
    }
    if (state && state.step === "await_confirm") {
      await tg.sendMessage(chatId, "Pakai tombol di bawah ya: Konfirmasi untuk lanjut, Batal untuk berhenti.", confirmKeyboard());
      return;
    }
    await tg.sendMessage(chatId, "Pilih menu di bawah:", mainMenuKeyboard());
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const data = cq.data || "";
    await tg.answerCallbackQuery(cq.id);
    if (!chatId) return;

    if (data === "menu:main") {
      await kv.delete(stateKey(chatId));
      await tg.sendMessage(chatId, welcomeMessage(cq.from), mainMenuKeyboard());
      return;
    }
    if (data === "menu:buy") {
      const items = catalogForSale(sellPrices);
      if (items.length === 0) {
        await tg.sendMessage(chatId, "Katalog belum tersedia saat ini. Silakan hubungi admin.", mainMenuKeyboard());
        return;
      }
      const lines = items.map((p) => `• ${p.name} — ${formatIDR(p.sellPrice)}`).join("\n");
      await tg.sendMessage(chatId, `🛒 Pilih paket:\n\n${lines}`, catalogKeyboard(items));
      return;
    }
    if (data === "menu:orders") {
      const orders = await listOrdersForChat(kv, chatId);
      if (orders.length === 0) {
        await tg.sendMessage(chatId, "Belum ada pesanan.", mainMenuKeyboard());
        return;
      }
      const lines = orders
        .map((o) => {
          const p = productById(o.productId);
          return `• ${p ? p.name : o.productId} — ${formatIDR(o.sellPrice)} — ${statusLabel(o)} (ref: ${o.ref})`;
        })
        .join("\n");
      const pending = orders.filter((o) => o.status !== "paid" || !o.delivered);
      const rows = pending.map((o) => [{ text: `🔄 Cek ${o.ref}`, callback_data: `check:${o.ref}` }]);
      rows.push([{ text: "⬅️ Menu Utama", callback_data: "menu:main" }]);
      await tg.sendMessage(chatId, `📦 Pesanan kamu:\n\n${lines}`, { inline_keyboard: rows });
      return;
    }
    if (data === "menu:help") {
      const kb = env.ADMIN_CONTACT
        ? { inline_keyboard: [[{ text: "💬 Hubungi Admin", url: `https://t.me/${env.ADMIN_CONTACT}` }], [{ text: "⬅️ Menu Utama", callback_data: "menu:main" }]] }
        : mainMenuKeyboard();
      await tg.sendMessage(chatId, HELP, kb);
      return;
    }
    if (data.startsWith("buy:")) {
      const id = Number(data.slice(4));
      const p = productById(id);
      const price = sellPrices[id];
      if (!p || price === undefined || price <= p.basePrice) {
        await tg.sendMessage(chatId, "Paket tidak tersedia saat ini.", mainMenuKeyboard());
        return;
      }
      await putJson(kv, stateKey(chatId), { step: "await_email", productId: id });
      await tg.sendMessage(chatId, `Kamu memilih ${p.name} — ${formatIDR(price)}.\n\nKirim email kamu (untuk invoice):`);
      return;
    }
    if (data === "cancel") {
      await kv.delete(stateKey(chatId));
      await tg.sendMessage(chatId, "Dibatalkan.", mainMenuKeyboard());
      return;
    }
    if (data === "confirm") {
      const state = await getJson(kv, stateKey(chatId));
      if (!state || state.step !== "await_confirm") {
        await tg.sendMessage(chatId, "Sesi berakhir. Mulai lagi dari Beli Paket.", mainMenuKeyboard());
        return;
      }
      const p = productById(state.productId);
      const price = sellPrices[state.productId];
      if (!p || price === undefined || price <= p.basePrice) {
        await kv.delete(stateKey(chatId));
        await tg.sendMessage(chatId, "Harga paket berubah / tidak tersedia. Mulai lagi dari Beli Paket.", mainMenuKeyboard());
        return;
      }
      const res = await createInvoice(fetcher, env.RESELLER_TOKEN, {
        product_id: state.productId,
        sell_price: price,
        buyer_email: state.email,
      });
      if (!res.ok) {
        await kv.delete(stateKey(chatId));
        await tg.sendMessage(chatId, `Gagal membuat invoice: ${res.error}. Coba lagi atau hubungi admin.`, mainMenuKeyboard());
        return;
      }
      const order = res.order;
      await putJson(kv, orderKey(order.order_ref), {
        ref: order.order_ref,
        chatId,
        productId: state.productId,
        sellPrice: price,
        status: "pending",
        delivered: false,
        createdAt: Date.now(),
      });
      await kv.delete(stateKey(chatId));
      const caption =
        `🧾 Invoice dibuat!\n\nPaket: ${p.name}\nHarga: ${formatIDR(price)}\nOrder ref: ${order.order_ref}\n` +
        (order.pay_url ? `Link bayar: ${order.pay_url}\n` : "") +
        `\nScan QRIS di atas (atau buka link bayar), lalu tekan Cek Status setelah membayar.`;
      if (order.qr_image_url && typeof tg.sendPhoto === "function") {
        await tg.sendPhoto(chatId, order.qr_image_url, caption);
        await tg.sendMessage(chatId, "Setelah membayar, tekan tombol di bawah:", orderKeyboard(order.order_ref));
      } else {
        await tg.sendMessage(chatId, caption, orderKeyboard(order.order_ref));
      }
      return;
    }
    if (data.startsWith("check:")) {
      const ref = data.slice(6);
      const order = await getJson(kv, orderKey(ref));
      if (!order || order.chatId !== chatId) {
        await tg.sendMessage(chatId, "Pesanan tidak ditemukan.", mainMenuKeyboard());
        return;
      }
      if (order.delivered) {
        await tg.sendMessage(
          chatId,
          "API key pesanan ini sudah pernah dikirim ke chat ini. Cek riwayat chat di atas, atau hubungi admin kalau hilang.",
          mainMenuKeyboard(),
        );
        return;
      }
      const st = await getOrderStatus(fetcher, ref);
      if (!st.ok) {
        await tg.sendMessage(chatId, `Gagal cek status: ${st.error}. Coba lagi.`, orderKeyboard(ref));
        return;
      }
      if (st.status === "PAID") {
        if (!st.apiKey) {
          await tg.sendMessage(chatId, "Pembayaran lunas tapi key belum tersedia. Tekan Cek Status lagi sesaat.", orderKeyboard(ref));
          return;
        }
        const r = await deliverHybridKey(env, kv, tg, fetcher, order, st.apiKey);
        if (!r.ok) {
          await tg.sendMessage(chatId, "Pembayaran lunas, tapi key gateway sedang disiapkan. Tekan Cek Status lagi sesaat.", orderKeyboard(ref));
          return;
        }
        if (r.already) {
          await tg.sendMessage(
            chatId,
            "API key pesanan ini sudah pernah dikirim ke chat ini. Cek riwayat chat di atas, atau hubungi admin kalau hilang.",
            mainMenuKeyboard(),
          );
        }
        return;
      }
      await tg.sendMessage(chatId, "Belum lunas. Setelah scan QRIS, tekan Cek Status lagi.", orderKeyboard(ref));
      return;
    }
    await tg.sendMessage(chatId, "Pilih menu di bawah:", mainMenuKeyboard());
  }
}

// Cron: sapu order yang belum delivered → kalau PAID, tempel ke gateway
// dan kirim ca- key. Order lunas-tapi-key-gagal TIDAK dilewati (status
// "paid" + delivered false tetap disapu menit berikutnya, sampai key
// terbit — arx key diambil ulang dari status ArxPays tiap sapuan).
export async function sweepPendingOrders(env, kv, tg, fetcher) {
  const listed = await kv.list({ prefix: "order:" });
  for (const k of listed.keys || []) {
    const order = await getJson(kv, k.name);
    if (!order || order.delivered) continue;
    try {
      const st = await getOrderStatus(fetcher, order.ref);
      if (!st.ok || st.status !== "PAID" || !st.apiKey) continue;
      await deliverHybridKey(env, kv, tg, fetcher, order, st.apiKey);
    } catch {
      // Lewati order ini di sapuan berikutnya; jangan gagalkan seluruh sweep.
    }
  }
}

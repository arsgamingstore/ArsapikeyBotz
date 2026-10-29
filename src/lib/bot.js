// Logika bot reseller (pure kecuali kv + tg yang di-inject).
// Dipakai Worker (src/index.js) dan tes (test/bot.test.mjs).
import { PRODUCTS, catalogForSale, formatIDR, parseSellPrices } from "./catalog.js";
import { createInvoice, getOrderStatus } from "./arxpay.js";
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

// Pesan kirim kunci: selalu cantumkan base URL + model supaya pembeli
// langsung tahu pakainya di mana. Base URL dari env API_BASE_URL,
// fallback ke domain whitelabel.
function keyDeliveryMessage(st, fallbackName, env) {
  const baseUrl = String(env.API_BASE_URL || "https://rest-api.arsgaming.ai.id/v1").replace(/\/$/, "");
  return `✅ Pembayaran berhasil!\n\nProduk: ${st.productName || fallbackName}\n\nAPI key kamu:\n${st.apiKey}\n\nBase URL:\n${baseUrl}\n\nModel:\n• deepseek-v4.1-flash-uncensored\n• glm-5.3-flash-uncensored\n\nSimpan key ini baik-baik. Key tidak disimpan di bot — kalau hilang, hubungi admin.`;
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
      await tg.sendMessage(chatId, welcomeMessage(msg.from), mainMenuKeyboard());
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
        order.status = "paid";
        order.delivered = true;
        await putJson(kv, orderKey(ref), order);
        const p = productById(order.productId);
        await tg.sendMessage(
          chatId,
          keyDeliveryMessage(st, p ? p.name : order.productId, env),
          mainMenuKeyboard(),
        );
        return;
      }
      await tg.sendMessage(chatId, "Belum lunas. Setelah scan QRIS, tekan Cek Status lagi.", orderKeyboard(ref));
      return;
    }
    await tg.sendMessage(chatId, "Pilih menu di bawah:", mainMenuKeyboard());
  }
}

// Cron: sapu order pending → kalau PAID, kirim key (idempotent via delivered).
export async function sweepPendingOrders(env, kv, tg, fetcher) {
  const listed = await kv.list({ prefix: "order:" });
  for (const k of listed.keys || []) {
    const order = await getJson(kv, k.name);
    if (!order || order.status === "paid" || order.delivered) continue;
    try {
      const st = await getOrderStatus(fetcher, order.ref);
      if (!st.ok || st.status !== "PAID" || !st.apiKey) continue;
      order.status = "paid";
      order.delivered = true;
      await putJson(kv, k.name, order);
      const p = productById(order.productId);
      await tg.sendMessage(
        order.chatId,
        keyDeliveryMessage(st, p ? p.name : order.productId, env),
        mainMenuKeyboard(),
      );
    } catch {
      // Lewati order ini di sapuan berikutnya; jangan gagalkan seluruh sweep.
    }
  }
}

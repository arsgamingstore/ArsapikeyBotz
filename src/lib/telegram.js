// Pembungkus tipis Telegram Bot API. `doFetch` di-inject untuk tes;
// produksi memakai fetch global. Pesan plain text (tanpa parse_mode)
// supaya input user tidak bisa merusak format.
export function tgApi(token, doFetch = fetch) {
  const base = `https://api.telegram.org/bot${token}`;
  async function post(method, body) {
    const res = await doFetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  }
  // Seperti post, tapi mengembalikan message_id (atau null kalau gagal).
  // Dipakai /start: pesan loading harus bisa dihapus lagi.
  async function postMessageId(method, body) {
    const res = await doFetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const id = data && data.result && data.result.message_id;
    return typeof id === "number" ? id : null;
  }
  return {
    sendMessage(chatId, text, replyMarkup, messageEffectId) {
      const body = { chat_id: chatId, text };
      if (replyMarkup) body.reply_markup = replyMarkup;
      if (messageEffectId) body.message_effect_id = messageEffectId;
      return postMessageId("sendMessage", body);
    },
    editMessageText(chatId, messageId, text) {
      return post("editMessageText", { chat_id: chatId, message_id: messageId, text });
    },
    sendPhoto(chatId, photo, caption) {
      return post("sendPhoto", { chat_id: chatId, photo, caption: caption || undefined });
    },
    answerCallbackQuery(id, text) {
      return post("answerCallbackQuery", { callback_query_id: id, text: text || undefined });
    },
  };
}

export function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛒 Beli Paket", callback_data: "menu:buy" }],
      [{ text: "📦 Pesanan Saya", callback_data: "menu:orders" }],
      [{ text: "❓ Bantuan", callback_data: "menu:help" }],
    ],
  };
}

export function catalogKeyboard(items) {
  const rows = items.map((p) => [{ text: `${p.name} — ${formatIDRShort(p.sellPrice)}`, callback_data: `buy:${p.id}` }]);
  rows.push([{ text: "⬅️ Menu Utama", callback_data: "menu:main" }]);
  return { inline_keyboard: rows };
}

export function confirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Konfirmasi & Buat Invoice", callback_data: "confirm" },
        { text: "❌ Batal", callback_data: "cancel" },
      ],
    ],
  };
}

export function orderKeyboard(ref) {
  return { inline_keyboard: [[{ text: "🔄 Cek Status", callback_data: `check:${ref}` }], [{ text: "⬅️ Menu Utama", callback_data: "menu:main" }]] };
}

function formatIDRShort(n) {
  return "Rp " + n.toLocaleString("id-ID");
}

// Entry Worker: webhook Telegram + cron sapu order.
// Binding KV `BOT_KV` dipasang di dashboard (BUKAN wrangler.toml —
// placeholder id gagal deploy, pelajaran dari GatewayARS).
import { handleUpdate, sweepPendingOrders } from "./lib/bot.js";
import { tgApi } from "./lib/telegram.js";

export function checkWebhookSecret(request, env) {
  if (!env.WEBHOOK_SECRET) return true;
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === env.WEBHOOK_SECRET;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/telegram/webhook" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    if (!checkWebhookSecret(request, env)) {
      return new Response("Forbidden", { status: 403 });
    }
    const update = await request.json().catch(() => null);
    if (!update) return new Response("Bad request", { status: 400 });
    ctx.waitUntil(handleUpdate(env, env.BOT_KV, tgApi(env.BOT_TOKEN), update, fetch));
    return new Response("ok");
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweepPendingOrders(env, env.BOT_KV, tgApi(env.BOT_TOKEN), fetch));
  },
};

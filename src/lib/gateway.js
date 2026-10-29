// Client ke ArsRouter Proxy: bikin ca- key hybrid dari arx key.
// `fetcher` di-inject supaya bisa dites dengan stub (lihat test/).
export function gatewayOrigin(env) {
  return String(env.GATEWAY_URL || "https://cloud-arsgamingstore.pages.dev").replace(/\/+$/, "");
}

export async function createGatewayKey(fetcher, env, { name, quota_tokens, upstream_api_key, models }) {
  let res;
  try {
    res = await fetcher(`${gatewayOrigin(env)}/api/bot/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.BOT_SERVICE_KEY}` },
      body: JSON.stringify({ name, quota_tokens, upstream_api_key, models }),
    });
  } catch (e) {
    return { ok: false, error: "network: " + String((e && e.message) || e) };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.key) {
    return { ok: false, error: (data && data.error && data.error.message) || `HTTP ${res.status}` };
  }
  return { ok: true, key: data.key };
}

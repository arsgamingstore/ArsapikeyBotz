// Client API reseller ArxPays (docs: arxpay.my.id/docs/reseller).
// `fetcher` di-inject supaya bisa dites dengan stub (lihat test/).
const BASE = "https://arxpay.my.id";

export async function createInvoice(fetcher, resellerToken, { product_id, sell_price, buyer_email }) {
  let res;
  try {
    res = await fetcher(`${BASE}/api/reseller/create-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Reseller-Token": resellerToken },
      body: JSON.stringify({ product_id, sell_price, buyer_email }),
    });
  } catch (e) {
    return { ok: false, error: "network: " + String((e && e.message) || e) };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.status !== "success") {
    return { ok: false, error: (data && (data.message || data.error)) || `HTTP ${res.status}` };
  }
  return { ok: true, order: data };
}

// GET status tidak pakai auth header di docs (cek via order_ref publik).
export async function getOrderStatus(fetcher, ref) {
  let res;
  try {
    res = await fetcher(`${BASE}/api/order/status?ref=${encodeURIComponent(ref)}`);
  } catch (e) {
    return { ok: false, error: "network: " + String((e && e.message) || e) };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) return { ok: false, error: `HTTP ${res.status}` };
  return { ok: true, status: data.status, apiKey: data.api_key || null, productName: data.product_name || null };
}

// Katalog paket ArxPays (HPP dari docs resmi, 2026-10-28).
// Harga jual BUKAN dari sini — dari env SELL_PRICES (lihat DESIGN.md §3).
export const PRODUCTS = [
  { id: 28, name: "Paket 1M Token", tokens: "1M", basePrice: 5500 },
  { id: 31, name: "Paket 2M Token", tokens: "2M", basePrice: 10000 },
  { id: 32, name: "Paket 5M Token", tokens: "5M", basePrice: 24000 },
  { id: 33, name: "Paket 10M Token", tokens: "10M", basePrice: 45000 },
  { id: 34, name: "Paket 20M Token", tokens: "20M", basePrice: 85000 },
  { id: 35, name: "Paket 50M Token", tokens: "50M", basePrice: 210000 },
];

export function parseSellPrices(raw) {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const id = Number(k);
      if (Number.isInteger(id) && typeof v === "number" && Number.isInteger(v) && v > 0) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// Fail-closed: hanya produk yang harga jualnya dikonfigurasi DAN di atas
// HPP yang tampil. Harga jual <= HPP = salah konfigurasi, disembunyikan
// supaya tidak pernah jual rugi.
export function catalogForSale(sellPrices) {
  return PRODUCTS.filter((p) => sellPrices[p.id] !== undefined && sellPrices[p.id] > p.basePrice).map((p) => ({
    ...p,
    sellPrice: sellPrices[p.id],
  }));
}

export function formatIDR(n) {
  return "Rp " + n.toLocaleString("id-ID");
}

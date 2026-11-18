// Password gate helpers. Works in both the Edge middleware and Node routes (Web Crypto).
// The cookie holds an HMAC of the password, never the password itself, so changing
// SITE_PASSWORD in Vercel logs everyone out.

export const COOKIE = "litpeer_auth";
export const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function sitePassword() {
  return process.env.SITE_PASSWORD || "";
}

export async function tokenFor(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("litpeer-site-gate-v1"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

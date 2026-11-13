// Single-admin login: the cookie holds an HMAC of the password, checked in middleware.
// Uses Web Crypto so it runs in the Edge middleware and in Node route handlers.

export const SESSION_COOKIE = "sr_session";

async function hmac(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sessionToken(): Promise<string> {
  const password = process.env.ADMIN_PASSWORD || "";
  const secret = process.env.SESSION_SECRET || "change-me";
  return hmac(`admin:${password}`, secret);
}

export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

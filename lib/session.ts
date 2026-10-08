// Satu kata sandi bersama (APP_PASSWORD). Semua orang yang tahu kata sandi punya akses penuh yang sama.
// Cookie sesi berisi hash kata sandi + AUTH_SECRET, sehingga mengganti kata sandi otomatis mengeluarkan semua sesi.
// Memakai Web Crypto agar bisa dipakai di proxy maupun route.

export const SESSION_COOKIE = "sa_session";

export const passwordRequired = () => !!process.env.APP_PASSWORD;

export async function sessionToken(): Promise<string> {
  const data = new TextEncoder().encode(`${process.env.APP_PASSWORD ?? ""}:${process.env.AUTH_SECRET ?? "strategi-agen"}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isValidSession(cookieValue: string | undefined) {
  if (!passwordRequired()) return true;
  return !!cookieValue && cookieValue === (await sessionToken());
}

/** Bandingkan kata sandi dengan waktu konstan (hindari kebocoran lewat timing). */
export function passwordMatches(input: string) {
  const a = new TextEncoder().encode(input);
  const b = new TextEncoder().encode(process.env.APP_PASSWORD ?? "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

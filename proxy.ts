import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isValidSession, passwordRequired } from "@/lib/session";

// Satu kata sandi bersama: tanpa cookie sesi yang valid, halaman diarahkan ke /login dan API menjawab 401.
// /api/jobs/step dikecualikan karena dipanggil QStash (diverifikasi lewat tanda tangan).
export async function proxy(req: NextRequest) {
  if (!passwordRequired()) return NextResponse.next();
  if (await isValidSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Silakan masuk dengan kata sandi terlebih dahulu" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/login|api/jobs/step|_next/static|_next/image|favicon.ico).*)"],
};

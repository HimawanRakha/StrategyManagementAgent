import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, isValidSession, passwordMatches, passwordRequired, sessionToken } from "@/lib/session";

export default async function LoginPage(props: PageProps<"/login">) {
  const jar = await cookies();
  if (!passwordRequired() || (await isValidSession(jar.get(SESSION_COOKIE)?.value))) redirect("/projects");
  const { error } = (await props.searchParams) as { error?: string };

  async function login(fd: FormData) {
    "use server";
    if (!passwordMatches(String(fd.get("password") ?? ""))) redirect("/login?error=1");
    (await cookies()).set(SESSION_COOKIE, await sessionToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    redirect("/projects");
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form action={login} className="w-full max-w-sm rounded-xl border border-border bg-surface p-6">
        <div className="mb-5 flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-primary text-sm font-bold text-white">SA</span>
          <div>
            <h1 className="font-semibold">Strategi Agen</h1>
            <p className="text-xs text-muted">Penyusun rencana strategis dengan alur berpikir</p>
          </div>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted">Kata sandi tim</span>
          <input
            name="password"
            type="password"
            required
            autoFocus
            className="h-10 rounded-md border border-border px-3 text-sm outline-none focus:border-primary"
          />
        </label>
        {error && <p className="mt-2 text-sm text-danger">Kata sandi salah.</p>}
        <button className="mt-4 h-10 w-full rounded-md bg-primary text-sm font-medium text-white hover:bg-primary-hover">Masuk</button>
      </form>
    </main>
  );
}

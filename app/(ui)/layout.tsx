import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/access";
import { SESSION_COOKIE, passwordRequired } from "@/lib/session";
import { llmProvider } from "@/lib/llm/provider";
import { NavLinks } from "@/components/nav-links";

export default async function UiLayout({ children }: LayoutProps<"/">) {
  if (!(await currentUser())) redirect("/login");
  const provider = llmProvider();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="flex h-12 items-center gap-4 px-4">
          <Link href="/projects" className="flex items-center gap-2 font-semibold tracking-tight">
            {/* <span className="grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-white">SA</span> */}
            <span className="hidden sm:inline">Manajemen Strategi Agen AI </span>
          </Link>
          <NavLinks />
          <div className="ml-auto flex items-center gap-2">
            {provider === "mock" && (
              <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn" title="LLM tiruan: tanpa API key, hasil dari heuristik kata kunci — hanya untuk mencoba alur">
                Mode uji (tanpa AI)
              </span>
            )}
            {passwordRequired() && (
              <form
                action={async () => {
                  "use server";
                  (await cookies()).delete(SESSION_COOKIE);
                  redirect("/login");
                }}
              >
                <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-2">Keluar</button>
              </form>
            )}
          </div>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}

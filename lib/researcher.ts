import "server-only";
import { requireUser } from "@/lib/access";

/** Modul eksperimen lintas proyek. Dengan satu akun bersama, cukup sesi yang valid. */
export async function requireResearcher() {
  const user = await requireUser();
  return { user, projectIds: "all" as const };
}

// npm run db:seed — membuat kasus sintetis contoh beserta dua alur bawaan.
import { config } from "dotenv";
config({ path: ".env.local" });
config();

async function main() {
  const { createSyntheticCase } = await import("../lib/seed/create");
  const p = await createSyntheticCase();
  console.log(`Kasus sintetis dibuat: ${p.name} (${p.id})`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

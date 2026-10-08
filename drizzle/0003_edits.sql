-- Output mentah (usulan AI sebelum kalkulator) disimpan terpisah agar pengguna bisa mengubah angka/teks lalu
-- kalkulator dihitung ulang. `edits` = riwayat perubahan manusia [{path, from, to, at}], `edited_at` = perubahan terakhir.
ALTER TABLE node_runs ADD COLUMN IF NOT EXISTS raw jsonb;
ALTER TABLE node_runs ADD COLUMN IF NOT EXISTS edits jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE node_runs ADD COLUMN IF NOT EXISTS edited_at timestamptz;
-- Run lama yang diarsipkan lewat "Ulang dari awal" tetap tersimpan sebagai data eksperimen.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS archived_at timestamptz;

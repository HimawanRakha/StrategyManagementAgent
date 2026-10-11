-- Keterangan terkini saat analisis berjalan (mis. "AI padat (429) — percobaan ulang ke-3 dalam 15 dtk"),
-- agar pengguna tahu apa yang sedang terjadi ketika sebuah analisis terasa lama.
ALTER TABLE node_runs ADD COLUMN IF NOT EXISTS notice text;
ALTER TABLE node_runs ADD COLUMN IF NOT EXISTS notice_at timestamptz;

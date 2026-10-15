-- Tinjauan dokumen: dokumen baru baru dibaca analisis setelah disetujui pengguna.
-- quality = hasil pemeriksaan otomatis saat unggah (peringatan + statistik potongan).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS quality jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Dokumen yang sudah ada sebelum fitur ini dianggap sudah ditinjau (analisis yang ada tidak berubah).
UPDATE documents SET reviewed_at = created_at WHERE reviewed_at IS NULL;

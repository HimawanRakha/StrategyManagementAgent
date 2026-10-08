-- Penyederhanaan: satu kata sandi bersama (tanpa akun & peran), dokumen terikat ke node input di canvas.

DROP TABLE IF EXISTS project_members;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS "verificationToken";
DROP TABLE IF EXISTS "user";

-- ID node input di canvas tempat dokumen diunggah
ALTER TABLE documents ADD COLUMN IF NOT EXISTS input_node text;

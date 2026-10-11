-- Cache embedding: teks yang sama (kueri pencarian bukti yang berulang di setiap run eksperimen) tidak dikirim ulang
-- ke API embedding, sehingga batas per menit (429) tidak cepat tercapai. Kunci = sha256(model|dimensi|jenis|teks).
CREATE TABLE IF NOT EXISTS embedding_cache (
  key        text PRIMARY KEY,
  embedding  vector(768) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

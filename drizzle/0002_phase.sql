-- Tahap yang sedang dikerjakan node (untuk animasi progres di canvas):
-- retrieve | generate | validate | repair | review | null
ALTER TABLE node_runs ADD COLUMN IF NOT EXISTS phase text;

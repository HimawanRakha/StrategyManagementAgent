-- Ekspor grand design juga dalam bentuk XLSX.
ALTER TABLE grand_design_exports DROP CONSTRAINT IF EXISTS grand_design_exports_format_check;
ALTER TABLE grand_design_exports ADD CONSTRAINT grand_design_exports_format_check CHECK (format IN ('docx','pdf','xlsx'));

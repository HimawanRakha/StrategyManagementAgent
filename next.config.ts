import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Paket server berat/berbasis WASM dijalankan apa adanya di Node, tidak dibundel.
  serverExternalPackages: [
    "pdf-parse",
    "@react-pdf/renderer",
    "@electric-sql/pglite",
    "@electric-sql/pglite-pgvector",
    "pg",
  ],
};

export default nextConfig;

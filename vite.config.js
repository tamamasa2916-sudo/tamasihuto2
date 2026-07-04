import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages（プロジェクトページ）でもそのまま動くよう、
// アセットの参照パスを相対パス（./）にしています。
export default defineConfig({
  plugins: [react()],
  base: "./",
});

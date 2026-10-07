import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  root: "src",
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      // overlay.html adalah entry kedua: src-tauri/src/lib.rs membukanya lewat
      // WebviewUrl::App("overlay.html") untuk jendela notifikasi always-on-top.
      // Tanpa ini file tidak ikut ter-build dan notifikasi diam di rilis.
      input: {
        main: "index.html",
        overlay: "overlay.html",
      },
    },
  },
});

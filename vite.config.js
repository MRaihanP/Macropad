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
    // "esnext" (bukan default "modules") karena main.js memakai top-level await:
    // initI18n() harus selesai sebelum init* yang merender teks dijalankan, kalau
    // tidak user melihat teks dalam bahasa dasar sesaat lalu berubah sendiri.
    // WebView2 berbasis Chromium jadi lingkungan ini selalu mendukungnya.
    target: "esnext",
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

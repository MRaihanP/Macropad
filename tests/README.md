# tests/ — jaringan pengujian

Seluruh skrip uji proyek ini berada di folder ini, **di dalam git**.

## Kenapa dipindahkan ke sini

Sebelumnya semua skrip hanya ada di `%TEMP%\opencode\`. Dua akibat:

1. Tidak ada jejaknya di git — kalau folder temp dibersihkan, seluruh jaringan
   pengujian hilang.
2. Setiap skrip meng-hardcode path absolut repo
   (`file:///E:/05_Finish_projects/macropad-configurator/src`) dan path absolut
   folder temp, jadi hanya jalan di satu mesin di satu lokasi.

Sekarang path dihitung dari posisi file itu sendiri lewat `runner/paths.mjs`,
sehingga folder ini bisa di-clone di mana saja.

## Menjalankan

```bash
npm test                # 28 suite utama
npm run test:rust       # 9 test Rust (cargo test --lib)

npx vite build          # menangkap error yang lolos node --check
```

Exit code `0` = semua hijau, `1` = ada yang gagal.

## Struktur

```
runner/
  paths.mjs               Helper path. Semua path dihitung dari lokasi file ini.
  run-all.mjs             Runner suite utama.
  tauri-stubs.mjs         Stub @tauri-apps/* supaya modul src/ bisa diimpor di Node.
  tauri-serial-stub.mjs   Stub tauri-plugin-serialplugin.

suites/                   Suite utama -_safe_ dijalankan setiap commit
  *.test.mjs              Modul ESM (import)
  *.test.cjs              Modul CommonJS (require) - .cjs WAJIB, karena
                          package.json punya "type": "module"
  *.test.js               ESM tanpa require
  rgb-translate.mjs       Helper: menerjemahkan rgb_effects.h (C) -> JS
  import-cycle-check.mjs  Pemeriksa graf import src/ bebas siklus
                          (namanya tidak berakhir "test" tapi tetap dijalankan
                          oleh negative/negative-cycle.mjs)

negative/                 Uji negatif - JANGAN dijalankan bersamaan
  negative-*.mjs          Sengaja MENGACAK repo lalu memastikan test-nya
                          benar-benar menangkap regresinya. Test yang selalu
                          hijau tidak membuktikan apa pun.

retired/                  Test lama, tidak lagi relevan
  spike-test.js           Menguji firmware/spike_ble_hid/ - file itu sudah tidak
                          ada di repo (sengaja dibuang, throwaway).
  spike2-test.cjs         Menguji firmware/spike_ble_hid2/ - juga sudah dibuang.

RETIRED_ATAS.txt          Alasan file di retired/ tidak lagi dijalankan.
```

## Aturan

1. **`npm test` aman dijalankan kapan saja.** Tidak ada yang menulis ke repo.

2. **`tests/negative/` TIDAK boleh dijalankan bersamaan** dengan edit atau commit
   apa pun. Skrip ini sengaja merusak file repo sementara untuk membuktikan test
  -nya benar-benar menangkap masalah. Kalau prosesnya mati di tengah, repo bisa
   tertinggal dalam kondisi rusak — `git checkout -- .` untuk memulihkan.

3. **Suite baru wajib punya negative test.** Test tanpa negative test belum
   membuktikan apa pun.

4. **Jangan hardcode path absolut.** Pakai `runner/paths.mjs` atau path relatif
   dari `__dirname`/`import.meta.url`.

5. **File CommonJS harus berakhiran `.cjs`**, bukan `.js` — kalau tidak, Node
   menolaknya dengan "require is not defined in ES module scope".

## Menambah suite baru

```bash
# suite ESM
tests/suites/nama-fitur-test.mjs

# suite CommonJS (kalau butuh require())
tests/suites/nama-fitur-test.cjs
```

Sekalian tambahkan negative test-nya di `tests/negative/negative-nama-fitur.mjs`.

## Status saat ini (2026-10-11)

| Item | Hasil |
|---|---|
| `npm test` | **28/28 hijau** |
| `cargo test --lib` | **9 passed** |
| `npx vite build` | sukses |

Ditambah dua perbaikan nyata yang ditemukan saat pemindahan ini:

- `src-tauri/Cargo.toml` versi 0.2.0 → 0.5.0 (menyamakan dengan `package.json`
  dan `tauri.conf.json`)
- `firmware/common/rgb_effects.h` dipulihkan — commit `e9387b1` menimpanya dengan
  212 baris teks `diANDLE` dan revert-nya tidak memulihkannya. Sumber sehat:
  commit `9d2c4bf`.

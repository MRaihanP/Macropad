# Changelog

Semua perubahan penting pada proyek ini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/),
dan proyek ini memakai [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Firmware RGB: label key di halaman RGB app diganti dari `R<row> C<col>` menjadi
  `RGB 1`..`RGB 9` mengikuti **urutan rantai LED fisik** (cermin `RGB_INDEX` di
  firmware). Balasan serial firmware ikut menyesuaikan: `[OK] RGB 6 (R1 C0) diset`.
- Preview animasi RGB page digerakkan Web Animations API (JS), bukan CSS
  `animation`, agar tidak bisa dimatikan oleh rule stylesheet maupun
  `prefers-reduced-motion`.
- Kontrol warna mode RGB tidak lagi memanggil `renderRgbAll()` di tiap event
  `oninput`, sehingga `RGB:MODE:` tidak dikirim per-pixel dan fase animasi tidak reset.

### Fixed
- Halaman RGB: preview animasi per mode lighting sebelumnya tidak terlihat karena
  ikut dilumpuhkan oleh `animation: none !important`.

## Catatan status

Repo ini baru memakai git mulai Phase 0 roadmap. Rincian temuan, rencana, dan
urutan pengerjaan ada di `C:\Users\Raihan\.opencode\plan\macropad-roadmap.md`.
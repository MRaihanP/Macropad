// Tabel terjemahan Bahasa Indonesia.
//
// Struktur: 'kunci': 'teks'. Placeholder {nama} diganti oleh t() saat pemanggilan,
// bukan di sini - supaya satu string bisa dipakai ulang untuk beberapa nilai.
//
// Kunci harus PERSIS sama dengan padanannya di en.js;
// i18n-test.js membandingkan keduanya.
export const id = {

'nav.home': 'Home',
'nav.adaptive': 'Adaptive Key Bind',
'nav.rgb': 'RGB Setting',
'nav.settings': 'Setting',
'sidebar.toggle': 'Buka/tutup panel',

// ---- Header / status koneksi ----
'header.subtitle': 'ESP32-S3 · matriks 3×3 + encoder · Native App',
'header.autostart': 'Jalankan saat Windows start',
'header.refreshPorts': 'Pindai ulang port serial',
'header.notConnected': 'Tidak terhubung',
'header.battery': 'Baterai',
'header.connect': 'Hubungkan',

// ---- Halaman Home ----
'home.editingPreset': 'Mengedit preset:',
'home.editDone': '✓ Selesai & Simpan',
'home.cancel': 'Batal',
'home.meta.device': 'Device',
'home.meta.matrix': 'Matriks',
'home.meta.knob': 'Knob',
'home.meta.activePreset': 'Preset Aktif',
'home.layoutTitle': 'Layout Tombol',
'home.layer': 'Layer',
'home.addLayer': '+ Layer',
'home.deleteLayer': '− Hapus',
'home.renameLayer': '✎ Ubah Nama',
'home.load': 'Muat',
'home.reset': 'Atur Ulang',
'home.save': 'Simpan',
'home.log': 'Log',
'home.logLabel': 'Log aktivitas',

// ---- Panel editor binding ----
'editor.title': 'Edit Binding',
'editor.type.0': 'NONE — kosong',
'editor.type.1': 'KEY — satu karakter',
'editor.type.2': 'COMBO — kombinasi tombol',
'editor.type.3': 'TEXT — teks panjang',
'editor.type.4': 'CONSUMER — media/volume',
'editor.type.5': 'APP — buka aplikasi (via companion)',
'editor.valuePlaceholder': 'mis. a / CTRL+C / hello world',
'editor.consumer.VOLUP': 'Vol +',
'editor.consumer.VOLDOWN': 'Vol −',
'editor.consumer.MUTE': 'Bisukan',
'editor.consumer.PLAYPAUSE': 'Putar/Jeda',
'editor.consumer.NEXT': 'Berikutnya',
'editor.consumer.PREV': 'Sebelumnya',
'editor.apply': 'Terapkan ke device',
'editor.recordHint': 'Merekam otomatis: tekan tombol fisik langsung, tiap tombol digabung dengan "+". Backspace = hapus token terakhir, Delete = hapus semua. Tombol media (volume/play) langsung terdeteksi.',

// ---- Pemilih aplikasi ----
'appPicker.searchPlaceholder': 'Cari aplikasi...',
'appPicker.addExe': '+ Tambah .exe',
'appPicker.rescan': '↻ Scan ulang',
'appPicker.rescanEvery': 'Pindai ulang tiap',
'appPicker.days': '{n} hari',
'appPicker.hint': 'Aksi APP dibuka oleh companion app di PC (jalan di tray). Kalau app ini tidak berjalan, device otomatis mengetik nama aplikasi lewat Windows Search.',

// ---- Halaman Adaptive Key Bind ----
'adaptive.subtitle': 'Pindah preset otomatis saat aplikasi tertentu jadi window aktif.',
'adaptive.enableFeature': 'Aktifkan fitur',
'adaptive.addPreset': '+ Tambah preset',

// ---- Halaman Setting ----
'settings.subtitle': 'Pengaturan aplikasi companion.',
'settings.globalFeatures': 'Fitur Global',
'settings.adaptiveName': 'Adaptive Key Bind',
'settings.adaptiveHint': 'Pindah preset otomatis mengikuti aplikasi aktif.',
'settings.rgbName': 'RGB',
'settings.rgbHint': 'Hubungkan device dengan RGB untuk mengubah ini.',
'settings.notifications': 'Notifikasi',
'settings.notifyBasicName': 'Notifikasi dasar',
'settings.notifyBasicHint': 'Koneksi, perpindahan layer, dan perpindahan preset.',
'settings.notifyKeysName': 'Notifikasi per key',
'settings.notifyKeysHint': 'Tombol dan knob yang ditekan. Tampil selama 1 detik.',
'settings.notifyBatteryName': 'Notifikasi baterai',
'settings.notifyBatteryHint': 'Mulai mengecas, cas selesai, baterai lemah, dan baterai kritis.',
'settings.notifyTestName': 'Tes notifikasi',
'settings.notifyTestHint': 'Tampilkan contoh notifikasi di layar.',
'settings.notifyTestButton': 'Tes',
'settings.power': 'Daya (wireless)',
'settings.sleepName': 'Tidur otomatis',
'settings.sleepHint': 'Hanya tersedia saat device FINAL terhubung.',
'settings.sleep.off': 'Nonaktif',
'settings.sleep.minutes': '{n} menit',
// Bahasa / i18n
'settings.language': 'Bahasa',
'settings.languageHint': 'Antarmuka dan notifikasi. Awalnya mengikuti bahasa Windows.',

// ---- Halaman RGB ----
'rgb.subtitle': 'Pencahayaan per-key. Pengaturan ini dikendalikan lewat companion app.',
'rgb.enable': 'Aktifkan RGB',
'rgb.mapTitle': 'Peta RGB — klik key untuk mengatur warnanya',
'rgb.knobHint': 'Knob tidak terlihat di sini, fokus ke grid tombol.',
'rgb.lighting': 'Pencahayaan',
'rgb.brightness': 'Kecerahan',
'rgb.brightnessHint': '100% di app = batas maksimal aman firmware (±60% PWM LED).',
'rgb.speed': 'Kecepatan',
'rgb.keyColor': 'Warna key',
'rgb.keyColorHint': 'Mengubah warna key otomatis masuk mode Custom per Key.',
'rgb.lightingMode': 'Mode Lighting',
'rgb.lightingModeHint': 'Warna pilihan untuk mode lighting yang mendukung warna.',
'rgb.save': 'Simpan ke device',
'rgb.reset': 'Reset ke default',
};

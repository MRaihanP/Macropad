// ==================== FACADE TRANSPORT ====================
//
// SATU-SATUNYA jalan aplikasi untuk menghubungi device. Semua modul yang bicara
// dengan MacroPad mengimpor dari sini, BUKAN langsung dari serial-transport.js.
//
// Kenapa file ini ada:
//  - Awalnya lima modul (protocol-parser, adaptive, home-page, tray, main)
//    mengimpor langsung dari serial-transport.js. Ketika transport BLE
//    ditambahkan, mengarahkan main.js saja tidak cukup - keempat modul lain
//    tetap menulis ke port serial walaupun user sudah pilih BLE, dan karena itu
//    preset/info dari device tidak pernah sampai.
//  - Commit "BLE transport switching" sebelumnya mencoba menyelesaikan ini dengan
//    getTransport() di main.js, tapi hanya main.js yang diarahkan; modul lain
//    tidak disentuh. Akibatnya muncul identifier fiktif (tIsConnected,
//    tDeviceWasLost, ...) yang tidak pernah dideklarasikan, dan connect() yang
//    asli hilang - companion app tidak pernah menerima apa pun.
//
// Kontrak yang harus dipenuhi sebuah backend (serial atau BLE):
//  initTransport(hooks) - pasang hook onLine/onConnected/onDisconnected/dst
//  sendLine(str)        - kirim satu baris (newline ditambahkan backend)
//  sendBatch(lines)     - kirim banyak baris dalam sedikit write
//  isConnected()        - tersambung?
//  isAutoBusy()         - sedang probe/connect otomatis?
//  enableAutoReconnect() - user minta auto-reconnect nyala lagi
//  connect(arg?) / disconnect(manual?)
//  autoDetect() / poll()          - pemicu manual / pemantau berkala
//  updateConnectButton(state)     - label tombol sambung/putus
//  handleDeviceLost()             - device hilang di luar request
//
// State framing (dumpInProgress, namesInProgress, ...) diekspor sebagai getter,
// bukan nilai. Mentahnya milik backend aktif dan berubah setiap waktu runtime;
// protocol-parser membacanya lewat getter supaya tidak terikat ke satu backend.
//
// Mengalihkan transport: setTransportBackend('ble'|'usb')
// Dipanggil dari UI pemilih transport DAN oleh connection-manager.js saat
// device ditemukan di transport lain. Probe sendiri tidak mengganti backend.

import * as serialBackend from './serial-transport.js';

const LAST_TRANSPORT_KEY = 'macropad.lastTransport';       // key lama, dibaca untuk migrasi
const LAST_GOOD_TRANSPORT_KEY = 'macropad.lastGoodTransport';

let backend = serialBackend;
let backendId = 'usb';
// Modul BLE dimuat sekali dan dipakai ulang. Probe BLE TIDAK boleh memakai
// import() baru di jalur lain: kalau Vite/HMR memuat dua instance, scan yang
// mengisi dropdown bisa menulis ke instance yang bukan backend aktif.
// `bleLoading` menahan import yang sedang berjalan: auto-connect USB+BLE bisa
// memanggil loadBleModule dari dua jalur bersamaan.
let bleModule = null;
let bleLoading = null;
// Saat true, connection-manager.js memiliki siklus retry. Flag ini diteruskan
// ke backend yang aktif maupun yang dimuat belakangan.
let managerMode = false;

async function loadBleModule() {
  if (bleModule) return bleModule;
  if (!bleLoading) {
    bleLoading = import('./ble-transport.js')
      .then(m => {
        bleModule = m;
        // Manager bisa aktif SEBELUM modul BLE dimuat (auto-connect USB menang
        // lebih dulu). Teruskan flag-nya saat modul baru masuk.
        if (typeof m.setManagerMode === 'function') m.setManagerMode(managerMode);
        return m;
      })
      .finally(() => { bleLoading = null; });
  }
  return bleLoading;
}

// Dipasang sekali oleh main.js. Hook diteruskan ke backend aktif - backend
// sendiri yang memanggil hook-nya, supaya framing tetap milik backend dan tidak
// ada lapisan kedua.
let pendingHooks = null;

// Aktifkan transport TANPA memutus backend lama. Dipakai coordinator
// auto-connect saat berpindah medium; pemanggil yang memutuskan koneksi.
async function switchTo(id) {
  if (id === backendId) return;
  if (id === 'ble') await loadBleModule();
  backend = id === 'usb' ? serialBackend : bleModule;
  backendId = id;
  backend.initTransport(pendingHooks);
}

export function setPendingTransportHooks(h) { pendingHooks = h; }

// ---- Fungsi yang meneruskan ke backend aktif ----
export function initTransport(h) { backend.initTransport(h); }
export function sendLine(str) { return backend.sendLine(str); }
export function sendBatch(lines) { return backend.sendBatch(lines); }
export function sendRaw(data) { return backend.sendRaw(data); }
export function sendRawNoAck(data) { return backend.sendRawNoAck(data); }
export function connect(arg) { return backend.connect(arg); }
export function disconnect(manual) { return backend.disconnect(manual); }
// Auto-connect saat launch: scan USB dan BLE, USB prioritas.
//
//   1. Coba USB (enumerate + probe WHOAMI + connect)
//   2. Kalau USB tidak ada, coba BLE (scan + connect)
//
// Kalau keduanya terdeteksi, USB menang karena dicoba lebih dulu. Urutan ini
// juga yang dipakai saat device berpindah medium (failover): transport lama
// dipindah, baru transport lain dicoba.
export async function autoDetect() {
  if (isConnected()) return true;
  await switchTo('usb');
  if (await backend.tryAutoConnect(true)) return true;
  await switchTo('ble');
  return await backend.tryAutoConnect(true);
}
// Poll transport aktif, lalu kalau tidak konek coba deteksi transport lain
// (failover). Backend aktif membaca data; backend lain memindai device baru.
//
// Setelah transport lain berhasil connect, `backend`/`backendId` ikut dipindah
// supaya facade (sendLine, isConnected, dst) menunjuk transport yang benar.
export async function poll() {
  if (backendId === 'usb') {
    await serialBackend.poll();
  } else if (bleModule) {
    await bleModule.poll();
  }
  if (!isConnected()) {
    if (backendId === 'usb') {
      const ble = await loadBleModule();
      await ble.poll();                       // BLE poll memindai device baru saat idle
      if (ble.isConnected()) await switchTo('ble');
    } else {
      await serialBackend.poll();             // USB poll memindai port baru
      if (serialBackend.isConnected()) await switchTo('usb');
    }
  }
}
export function enableAutoReconnect() { return backend.enableAutoReconnect(); }
export function updateConnectButton(state) { return backend.updateConnectButton(state); }
export function handleDeviceLost() { return backend.handleDeviceLost(); }
export function resetParserState() { return backend.resetParserState(); }

// ---- State: getter, bukan snapshot ----
// Nilai live diekspor lewat getter supaya perubahan di backend langsung terlihat.
// Mengekspor `let` langsung dari facade akan membekukan nilainya pada saat
// import, dan protocol-parser akan membaca dumpInProgress yang selalu false -
// dump DEVICE yang.protracted akan tersangkut selamanya.
export function isConnected() { return backend.isConnected(); }
export function isAutoBusy() { return backend.isAutoBusy(); }
export function deviceWasLost() { return backend.deviceWasLost; }
export function portPath() { return backend.portPath; }

export function dumpInProgress() { return backend.dumpInProgress; }
export function dumpEncInProgress() { return backend.dumpEncInProgress; }
export function namesInProgress() { return backend.namesInProgress; }
export function eventsSuppressed() { return backend.eventsSuppressed(); }

export function setDumpInProgress(v) { return backend.setDumpInProgress(v); }
export function setDumpEncInProgress(v) { return backend.setDumpEncInProgress(v); }
export function setNamesInProgress(v) { return backend.setNamesInProgress(v); }

// Benarkah ada handshake setelah connect yang belum selesai?
//
// Serial tidak punya handshake - device USB sudah tentu siap setelah port
// terbuka - jadi selalu false. BLE punya afterConnectHandshake() yang
// mengirim 7 perintah; selama itu berjalan, auto-switch preset harus
// menunggu, kalau tidak upload preset menumpuk di atas handshake.
export function handshakePending() {
  return typeof backend.handshakePending === 'function'
    ? backend.handshakePending()
    : false;
}

export function transportId() { return backendId; }

// Transport terakhir yang dipakai user (disimpan ke localStorage).
//
// Yang dipakai untuk prioritas startup adalah transport yang benar-benar
// BERHASIL connect (key baru). Key lama tetap dibaca sekali supaya instalasi
// sebelumnya tidak kehilangan preferensi.
export function lastTransport() {
  try {
    return localStorage.getItem(LAST_GOOD_TRANSPORT_KEY)
      || localStorage.getItem(LAST_TRANSPORT_KEY);
  } catch (e) { return null; }
}

export function rememberTransport(id) {
  if (id !== 'usb' && id !== 'ble') return;
  try { localStorage.setItem(LAST_GOOD_TRANSPORT_KEY, id); } catch (e) { }
}

// lastGoodDeviceId hanya tersedia di backend BLE. USB mengembalikan null.
export function lastGoodDeviceId() {
  return typeof backend.lastGoodDeviceId !== 'undefined'
    ? backend.lastGoodDeviceId
    : null;
}

// Inisialisasi backend aktif dengan hook yang sudah didaftarkan main.js.
export function initActiveBackend() { backend.initTransport(pendingHooks); }

// Ganti backend runtime. Dipanggil dari UI pemilih transport DAN oleh
// connection-manager.js saat device ditemukan di transport lain. Setelah hook
// diinstal ulang, modul lain yang mengimpor dari facade ini otomatis ikut
// memakai backend baru tanpa perlu diimpor ulang.
//
// Catatan soal "negosiasi": backend fisik (usb/ble) dipilih user lewat
// pemilih, atau oleh auto-connect saat device ditemukan. Auto-connect hanya
// memprobe; backend tidak diganti sampai ada device yang benar-benar akan
// dipakai. Format frame tetap dinegosiasi lewat percobaan nyata, bukan lewat
// nomor versi firmware.
//
// setTransportBackend dengan id yang tidak dikenal tidak mengubah apa pun dan
// mengembalikan backendId yang sekarang, supaya keadaan internal dan yang
// tampil di UI tidak berbeda.
export async function setTransportBackend(id) {
  if (id === backendId) return backendId;
  if (id !== 'usb' && id !== 'ble') return backendId;
  // Timer retry backend lama harus dibatalkan EKSPLISIT. disconnect(true)
  // memang mematikan autoReconnect, tapi timer yang sudah terlanjur arm tetap
  // bisa bangun dan mencoba connect ke transport yang sudah tidak aktif.
  if (typeof backend.stopAutoRetry === 'function') backend.stopAutoRetry();
  // Putuskan backend lama DULUAN supaya hook onDisconnected sempat jalan: badge
  // profil dan meter baterai harus ikut kosong, kalau tidak user mengira device
  // lama masih hidup setelah beralih ke backend lain.
  await backend.disconnect(true);
  backend = id === 'usb' ? serialBackend : await loadBleModule();
  backendId = id;
  // Backend yang baru dipasang juga dibersihkan dari retry lama.
  if (typeof backend.stopAutoRetry === 'function') backend.stopAutoRetry();
  backend.initTransport(pendingHooks);
  return backendId;
}

// Backend BLE yang sudah terpasang, atau null kalau transport-nya USB.
//
// Dipertahankan untuk kompatibilitas kontrak facade dan test. Jalur scan
// auto-connect TIDAK memakai ini (lihat probeBleDevice di bawah): probe harus
// bisa berjalan tanpa mengaktifkan backend BLE.
export function bleBackend() {
  return backendId === 'ble' ? backend : null;
}

// ---- Probe untuk auto-connect ----
//
// Probe sengaja TIDAK mengganti backend. Manager hanya perlu tahu apakah ada
// device; backend baru diaktifkan kalau device itu benar-benar akan dipakai.
// Dengan begitu app tidak bolak-balik switch (dan memicu notifikasi putus)
// hanya untuk memindai transport lain.
export function probeUsbDevice(only) {
  return serialBackend.findAvailableDevice(only);
}

export async function probeBleDevice(only) {
  const mod = await loadBleModule();
  return mod.findAvailableDevice(only);
}

// Dipakai tombol ↻ di panel manual: enumerasi murah, tanpa connect. Sekaligus
// reset penanda probe supaya manager memprobe ulang semua port dari awal -
// perilaku yang sama dengan tombol Refresh lama (autoDetect).
export function refreshUsbPorts() {
  serialBackend.resetProbeState();
  return serialBackend.refreshPorts(null, true);
}

export function markUsbPortFailed(path) {
  serialBackend.markPortFailed(path);
}

// Saat manager aktif, backend tidak lagi menjalankan auto-connect sendiri.
// Manual/fallback tetap bisa memanggil autoDetect() langsung.
export function setManagerMode(v) {
  managerMode = !!v;
  serialBackend.setManagerMode(managerMode);
  if (bleModule && typeof bleModule.setManagerMode === 'function') bleModule.setManagerMode(managerMode);
}

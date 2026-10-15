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
// Dipanggil dari UI pemilih transport; setelah hook diinstal ulang, semua modul
// lain yang mengimpor dari facade ini otomatis ikut backend baru.

import * as serialBackend from './serial-transport.js';

let backend = serialBackend;
let backendId = 'usb';

// Dipasang sekali oleh main.js. Hook diteruskan ke backend aktif - backend
// sendiri yang memanggil hook-nya, supaya framing tetap milik backend dan tidak
// ada lapisan kedua.
let pendingHooks = null;

export function setPendingTransportHooks(h) { pendingHooks = h; }

// ---- Fungsi yang meneruskan ke backend aktif ----
export function initTransport(h) { backend.initTransport(h); }
export function sendLine(str) { return backend.sendLine(str); }
export function sendBatch(lines) { return backend.sendBatch(lines); }
export function connect(arg) { return backend.connect(arg); }
export function disconnect(manual) { return backend.disconnect(manual); }
export function autoDetect() { return backend.autoDetect(); }
export function poll() { return backend.poll(); }
export function enableAutoReconnect() { return backend.enableAutoReconnect(); }
export function updateConnectButton(state) { return backend.updateConnectButton(state); }
export function handleDeviceLost() { return backend.handleDeviceLost(); }
export function resetParserState() { return backend.resetParserState(); }

// ==================== POLLING KEDUA BACKEND (PARALEL) ====================
//
// Dipanggil dari main.js setiap 2 detik. TUJUANNYA: USB dan BLE mencari
// device BERSAMAAN, bukan berurutan.
//
// KENAPA BERSAMAAN, BUKAN "COBA USB DULU"
//
// Device FINAL hanya bisa menerima SATU transport pada satu waktu. Tapi itu
// pilihan FIRMWARE DI DEVICE - bukan pilihan app. Colok USB, device mematikan
// BLE-nya sendiri. Cabut USB, device menghidupkan BLE-nya sendiri.
//
// App tidak boleh menebak mode device. Kalau app mematikan backend USB begitu
// BLE connect, lalu device dicabut USB, app tidak akan pernah mencari lagi -
// karena ia mengira USB masih "yang menang". Itu persis kelas bug yang bikin
// user harus Refresh -> Connect.
//
// Yang terjadi kalau keduanya connect bersamaan: device hanya menerima satu,
// percobaan kedua gagal. Itu NORMAL - bukan error yang perlu ditangani.
//
// MENGAPA AMAN memanggil poll() pada backend yang SEDANG TIDAK AKTIF
//
// poll() backend yang tidak aktif akan melihat `connected === false`, lalu
// scan. Dan scan() BLE hanya memanggil `invoke('ble_scan')` - yang TIDAK
// butuh backend aktif. Yang butuh backend aktif hanya ble_write/ble_read,
// dan itu hanya terjadi kalau poll() menemukan connected === true di backend
// itu sendiri. Kalau USB sedang connect, poll() BLE tidak akan menemukan apa
// apa di sisi BLE (device-nya memang tidak Advertising), jadi tidak ada
// Commands yang tries terkirim.
//
// Yang TIDAK berubah: setTransportBackend() tetap berfungsi seperti
// sekarang. Dropdown transport hanya mengubah "backend aktif" (yang boleh
// mengirim perintah), bukan membatasi apa yang boleh MENCARI.
export async function pollAll() {
  // Backend aktif dipoll duluan supaya jalurnya jelas di log.
  await backend.poll();
  const other = backendId === 'ble' ? serialBackend : bleBackend();
  if (!other || other === backend) return;
  // Backend kedua bisa gagal (mis. modul BLE belum ter-load, atau GATT-nya
  // sedang jatuh). poll() di dalamnya sudahHandles error-nya sendiri dan
  // men-log lewat backend - di sini cukup ditelan supaya satu backend yang
  // bermasalah tidak menghentikan siklus polling untuk yang lain.
  try { await other.poll(); } catch (e) { /* sudah di-log oleh backend */ }
}

// Lepas status "user sengaja memutus" di KEDUA backend.
//
// Dipakai saat app dibuka lagi dari tray: menutup jendela lalu membukanya dari
// tray berarti "coba lagi", bukan "menolak". Kalau tidak, user harus menekan
// Connect manual setiap kali app masuk ke tray.
//
// Backend BLE di-load dinamis dan mungkin belum pernah dipakai - yang belum
// ada dilewati diam-diam.
export function clearUserStoppedBoth() {
  if (typeof serialBackend.clearUserStopped === 'function') serialBackend.clearUserStopped();
  const ble = bleBackend();
  if (ble && typeof ble.clearUserStopped === 'function') ble.clearUserStopped();
}

// User sedang sengaja memutus? Backend aktif tahu sendiri; backend yang
// belum aktif dicek juga supaya pollAll() tidak membuang energi scan.
export function isUserStopped() {
  return typeof backend.isUserStopped === 'function' ? backend.isUserStopped() : false;
}

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

// Inisialisasi backend aktif dengan hook yang sudah didaftarkan main.js.
export function initActiveBackend() { backend.initTransport(pendingHooks); }

// Ganti backend runtime. Dipanggil dari UI pemilih transport; setelah hook
// diinstal ulang, modul lain yang mengimpor dari facade ini otomatis ikut
// memakai backend baru tanpa perlu diimpor ulang.
export async function setTransportBackend(id) {
  if (id === backendId) return backendId;
  // Putuskan backend lama DULUAN supaya hook onDisconnected sempat jalan: badge
  // profil dan meter baterai harus ikut kosong, kalau tidak user mengira device
  // lama masih hidup setelah beralih ke backend lain.
  await backend.disconnect(true);
  if (id === 'usb') {
    backend = serialBackend;
  } else if (id === 'ble') {
    backend = await import('./ble-transport.js');
  } else {
    return backendId;
  }
  backendId = id;
  backend.initTransport(pendingHooks);
  return backendId;
}

// Backend BLE yang sudah terpasang, atau null kalau transport-nya USB.
//
// scan() hanya hidup di backend BLE, jadi main.js perlu mengambil backend
// lewat sini - bukan meng-import './ble-transport.js' langsung. Import
// langsung mengembalikan SALINAN MODUL YANG BERBEDA kalau ever terjadi
// (Vite/HMR bisa memuat dua kali), dan scan yang mengisi dropdown akan
// menulis ke instance yang bukan yang sedang dipakai.
export function bleBackend() {
  return backendId === 'ble' ? backend : null;
}

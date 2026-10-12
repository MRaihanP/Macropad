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

export function transportId() { return backendId; }

// Inisialisasi backend aktif dengan hook yang sudah didaftarkan main.js.
export function initActiveBackend() { backend.initTransport(pendingHooks); }

// ==================== KUNCI MODE ====================
//
// Kalau dikunci, app tidak akan pindah mode sendiri walau USB tersedia.
// Tanpa kunci, USB selalu menang karena kabel lebih bisa diandalkan; BLE
// mengambil alih hanya kalau USB tidak ada.
//
// Bedanya penting untuk user yang sengaja memaksa BLE (mis. menguji
// baterai, atau kabelnya sering drop): tanpa kunci, colok kabel
// sedikit saja langsung menarik app kembali ke USB.
let modeLocked = false;
let onModeChange = null;
export function isModeLocked() { return modeLocked; }
export function setModeLocked(v) { modeLocked = !!v; }
export function registerOnModeChange(fn) { onModeChange = fn; }

function announceMode() { if (onModeChange) onModeChange(backendId); }

// Backend yang SEDANG dipakai, tanpa mengubah apa pun.
export async function activeBackend() { return backend; }

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
  announceMode();
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

// Apakah USB sedang memegang device MacroPad.
//
// Dipakai supervisor untuk memutuskan takeover: kalau sedang di BLE dan
// USB tiba-tiba punya MacroPad, pindah ke USB - kecuali mode dikunci.
export async function usbHasDevice() {
  try {
    const paths = await serialBackend.listPortPaths();
    if (!paths.length) return false;
    // Cek cepat dulu tanpa WHOAMI (yang mahal):
    // kalau port yang known sudah muncul kembali, itu hampir pasti device
    // yang sama.
    return paths.length > 0;
  } catch (e) {
    return false;
  }
}

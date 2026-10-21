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

const LAST_TRANSPORT_KEY = 'macropad.lastTransport';

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
export function sendRaw(data) { return backend.sendRaw(data); }
export function sendRawNoAck(data) { return backend.sendRawNoAck(data); }
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
export function lastTransport() {
  try { return localStorage.getItem(LAST_TRANSPORT_KEY); } catch (e) { return null; }
}

// lastGoodDeviceId hanya tersedia di backend BLE. USB mengembalikan null.
export function lastGoodDeviceId() {
  return typeof backend.lastGoodDeviceId !== 'undefined'
    ? backend.lastGoodDeviceId
    : null;
}

// Inisialisasi backend aktif dengan hook yang sudah didaftarkan main.js.
export function initActiveBackend() { backend.initTransport(pendingHooks); }

// Ganti backend runtime. Dipanggil dari UI pemilih transport; setelah hook
// diinstal ulang, modul lain yang mengimpor dari facade ini otomatis ikut
// memakai backend baru tanpa perlu diimpor ulang.
//
// Catatan soal "negosiasi": yang dinegosiasi di sini HANYA backend fisik
// (usb atau ble), dan itu tetap pilihan user lewat pemilih - bukan tebakan.
// App tidak pernah menebak medianya.
//
// Yang dinegosiasi OTOMATIS ada di lapis lain: format frame. Apakah device
// mendukung frame biner ditentukan lewat percobaan nyata, bukan lewat membaca
// nomor versi firmware. Alasannya, cara lain rapuh - perangkat yang sama bisa
// punya build berbeda, dan nomor versi tidak menjamin apa pun tentang kemampuan
// yang diaktifkan.
//
// setTransportBackend dengan id yang tidak dikenal tidak mengubah apa pun dan
// mengembalikan backendId yang sekarang, supaya keadaan internal dan yang
// tampil di UI tidak berbeda.
export async function setTransportBackend(id) {
  if (id === backendId) return backendId;
  if (id !== 'usb' && id !== 'ble') return backendId;
  // Putuskan backend lama DULUAN supaya hook onDisconnected sempat jalan: badge
  // profil dan meter baterai harus ikut kosong, kalau tidak user mengira device
  // lama masih hidup setelah beralih ke backend lain.
  await backend.disconnect(true);
  backend = id === 'usb' ? serialBackend : await import('./ble-transport.js');
  backendId = id;
  backend.initTransport(pendingHooks);
  try { localStorage.setItem(LAST_TRANSPORT_KEY, id); } catch (e) { }
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

// Referensi ke modul BLE (dimuat lazy, di-cache supaya selalu instance yang sama).
let bleTransportModule = null;
async function getBleTransportModule() {
  if (!bleTransportModule) bleTransportModule = await import('./ble-transport.js');
  return bleTransportModule;
}

// Kembalikan modul BLE backend terlepas dari backend yang sedang aktif.
// Dipakai oleh dual-transport autoconnect untuk mencoba BLE walaupun USB
// adalah backend aktif saat ini.
export async function bleTransport() {
  return getBleTransportModule();
}

// ---- Dual-transport auto-connect coordinator ----
//
// State autoconnect utama. Aktif secara default saat app dibuka.
// Dipadamkan saat user membuka panel Koneksi Manual, dan tidak nyala kembali
// saat panel ditutup (user harus klik Connect secara manual).
let dualAutoActive = true;
let dualRetryTimer = null;

export function isDualAutoActive() { return dualAutoActive; }

export function stopDualAuto() {
  dualAutoActive = false;
  clearTimeout(dualRetryTimer);
  dualRetryTimer = null;
  // Matikan auto-reconnect di kedua backend supaya tidak mencoba di latar belakang.
  serialBackend.disableAutoReconnect();
  const ble = getBleTransportModule();
  ble.then((b) => { if (b.disableAutoReconnect) b.disableAutoReconnect(); });
}

// Alias untuk kompatibilitas nama dengan main.js.
export const disableDualAutoReconnect = stopDualAuto;

export function startDualAuto() {
  dualAutoActive = true;
}

// Coba USB terlebih dahulu, lalu BLE. Jika keduanya gagal, jeda 5 detik lalu
// coba lagi secara bergiliran (USB → BLE → USB → BLE ...).
export async function dualAutoDetect() {
  if (!dualAutoActive || backend.isConnected()) return false;

  // 1. Coba USB dulu (scan port serial murah, cepat).
  log(t('transport.dualAutoUsb'));
  if (serialBackend.autoDetect) {
    const ok = await serialBackend.autoDetect();
    if (ok) return true; // USB berhasil; backend aktif masih serial.
  }

  // 2. Coba BLE jika USB gagal atau tidak ada.
  log(t('transport.dualAutoBle'));
  const ble = await getBleTransportModule();
  if (ble.autoDetect) {
    const ok = await ble.autoDetect();
    if (ok) {
      // BLE berhasil: pindahkan facade ke backend BLE.
      await setTransportBackend('ble');
      return true;
    }
  }

  // Keduanya gagal: jeda lalu coba lagi secara bergiliran.
  if (dualAutoActive) {
    dualRetryTimer = setTimeout(() => dualAutoDetect(), 5000);
  }
  return false;
}

// Poll dengan failover: polling backend aktif, dan jika terputus,
// coba backend lain sebagai cadangan (hanya jika dualAutoActive masih nyala).
export async function dualPoll() {
  if (!dualAutoActive) return;

  const wasConnected = backend.isConnected();
  await backend.poll();
  const stillConnected = backend.isConnected();

  if (wasConnected && !stillConnected && !backend.isAutoBusy()) {
    const other = backendId === 'usb'
      ? await getBleTransportModule()
      : serialBackend;

    if (other.isConnected && other.isConnected()) {
      await setTransportBackend(backendId === 'usb' ? 'ble' : 'usb');
      return;
    }

    if (other.autoDetect) {
      const ok = await other.autoDetect();
      if (ok && backendId === 'usb') {
        await setTransportBackend('ble');
      }
    }
  }
}

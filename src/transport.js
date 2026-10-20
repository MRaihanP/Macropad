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

// Backend BLE dimuat malas (lazy) supaya modul BLE hanya masuk ke bundle saat
// transport BLE benar-benar dipakai. `bleLoading` menahan import yang sedang
// berjalan supaya dua pemanggil tidak memuat dua kali.
let bleMod = null;
let bleLoading = null;
async function getBle() {
  if (bleMod) return bleMod;
  if (!bleLoading) {
    bleLoading = import('./ble-transport.js').then(m => { bleMod = m; return m; });
  }
  return bleLoading;
}

// Aktifkan transport TANPA memutus backend lama. Dipakai coordinator
// auto-connect saat berpindah medium; pemanggil yang memutuskan koneksi.
async function switchTo(id) {
  if (id === backendId) return;
  if (id === 'ble') await getBle();
  backend = id === 'usb' ? serialBackend : bleMod;
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
  } else if (bleMod) {
    await bleMod.poll();
  }
  if (!isConnected()) {
    if (backendId === 'usb') {
      const ble = await getBle();
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
  if (id === 'ble') await getBle();
  backend = id === 'usb' ? serialBackend : bleMod;
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

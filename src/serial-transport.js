// ==================== TRANSPORT SERIAL ====================
//
// Seluruh urusan port serial dipindah ke sini: membuka/menutup port, enumerasi,
// auto-connect/reconnect, buffer baris, framing parser, dan pengiriman perintah.
//
// Transport TIDAK tahu apa pun soal arti perintah. Baris yang masuk diteruskan ke
// hook onLine(), yang dipasang main.js. Sebaliknya, modul ini tidak boleh memanggil
// fungsi main.js secara langsung - semua yang dibutuhkan lewat initTransport() di
// bawah, supaya tidak ada siklus import dan ketergantungan tetap terlihat.
//
// Yang TIDAK boleh dilupakan di sini:
//  - handle unlisten dari port.listen() harus disimpan dan dipanggil. Plugin serial
//    tidak memanggilnya sendiri saat stopListening(), sehingga tiap reconnect/probe
//    menambah satu listener dan satu chunk device diproses N kali (desync protokol).
//  - Buffer baris harus berbatas. Tanpa itu, device yang tidak pernah mengirim newline
//    akan menumpuk data tanpa henti selama sesi.

import { SerialPort } from "tauri-plugin-serialplugin";
import { el, log } from './dom.js';
import { t } from './i18n.js';

const LAST_PORT_KEY = 'macropad.lastPort';
const LINE_BUFFER_MAX = 64 * 1024;
const BAUD = 115200;
const READ_SIZE = 1024;

// ---- State koneksi ----
let port = null;
export let portPath = null;
let portUnlisten = null;
export let deviceWasLost = false;

let lastGoodPort = null;
try { lastGoodPort = localStorage.getItem(LAST_PORT_KEY); } catch (e) { }
let autoReconnect = true;      // false setelah user menekan Disconnect sendiri
let autoBusy = false;          // sedang probe/connect otomatis
let pollBusy = false;
let knownPorts = new Set();
// Port yang sudah di-probe tapi GAGAL pada percobaan terakhir. Disimpan supaya
// pollPorts() bisa mencoba lagi nanti - bukan hanya saat port "baru" muncul.
let failedProbes = new Set();
let pingTimer = null;
let retryTimer = null;

// ---- State framing (milik transport: concerns pengubahan → baris) ----
let lineBuffer = '';
export let dumpInProgress = false, dumpEncInProgress = false, namesInProgress = false;
// Event dari device (mis. EVT:APP:) diabaikan sebentar setelah connect supaya device
// tidak langsung membuka aplikasi dari state sisa sebelum reconnect.
let suppressEventsUntil = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Hook ke main.js ----
let hooks = {
  onLine: () => { },
  onConnected: () => { },
  onDisconnected: () => { },
  onDeviceLost: () => { },   // bersihkan state tingkat aplikasi
  onAutoConnectOk: () => { },
  onAutoConnectFail: () => { },
  notify: () => { },
  clearDirty: () => { },
};

export function initTransport(h) { hooks = Object.assign({}, hooks, h); }

// ---- Buffer baris ----
export function resetParserState() {
  lineBuffer = '';
  dumpInProgress = false;
  dumpEncInProgress = false;
  namesInProgress = false;
}
export function setDumpInProgress(v) { dumpInProgress = v; }
export function setDumpEncInProgress(v) { dumpEncInProgress = v; }
export function setNamesInProgress(v) { namesInProgress = v; }
export function eventsSuppressed() { return Date.now() < suppressEventsUntil; }
export const isConnected = () => !!port;
// Dipakai tombol Connect di main.js: mencegah dua koneksiParalel saat auto-connect
// sedang berjalan, dan menghidupkan kembali auto-reconnect setelah user menekan
// Disconnect secara manual.
export const isAutoBusy = () => autoBusy;
export function enableAutoReconnect() { autoReconnect = true; }

function releasePortListener() {
  const u = portUnlisten;
  portUnlisten = null;
  if (u) { try { u(); } catch (e) { log(t('transport.unlistenError', { err: e }), 'err'); } }
}

// ---- Pengiriman ----
async function writeRaw(str) {
  try { await port.write(str); }
  catch (e) { log(t('transport.sendError', { err: e }), 'err'); await handleDeviceLost(); }
}

export async function sendLine(str) {
  if (!port) return;
  try { await port.write(str + "\n"); }
  catch (e) {
    log(t('transport.sendError', { err: e }), 'err');
    // Tulis gagal = koneksi sudah putus di level OS, jangan tunggu polling.
    await handleDeviceLost();
  }
}

// Kirim banyak baris dalam sedikit write (bukan 1 write per baris).
//
// Batas 4000 byte, bukan 900. Alasannya transport-spesifik: USB CDC punya
// flow control dan await port.write() menunggu sampai selesai, jadi	write
// sebesar ini aman dan tidak perlu dipecah. Batas 900 yang lama
// adalah warisan era BLE, di mana MTU-limited jadi memecah wajib.
//
// Preset besar (8 layer × 9 tombol + knob) bisa ~1,7 KB: sebelumnya 2
// write, sekarang 1.
const USB_WRITE_CHUNK_MAX = 4000;
export async function sendBatch(lines) {
  if (!port) return;
  let chunk = '';
  for (const ln of lines) {
    if (chunk.length + ln.length + 1 > USB_WRITE_CHUNK_MAX) { await writeRaw(chunk); chunk = ''; }
    chunk += ln + '\n';
  }
  if (chunk) await writeRaw(chunk);
}

// ---- Penerimaan ----
export function handleIncomingChunk(data) {
  lineBuffer += data;
  // Kalau tidak ada newline sama sekali, buffer tumbuh tanpa batas dan handleLine
  // tidak pernah dipanggil sehingga tidak ada yang bisa pulih. Buang sisa dan reset
  // parser, lalu lanjut dari newline terakhir agar koneksi berikutnya tetap sinkron.
  if (lineBuffer.length > LINE_BUFFER_MAX) {
    log(t('transport.lineTooLong', { max: LINE_BUFFER_MAX }), 'err');
    // Simpan dulu sisa setelah newline TERAKHIR, baru reset. Urutannya penting:
    // resetParserState() mengosongkan lineBuffer, jadi kalau dipanggil lebih
    // dulu, lastIndexOf selalu -1 dan baris utuh terakhir ikut terbuang.
    const nl = lineBuffer.lastIndexOf('\n');
    const tail = nl >= 0 ? lineBuffer.slice(nl + 1) : '';
    resetParserState();
    lineBuffer = tail;
  }
  let idx;
  while ((idx = lineBuffer.indexOf('\n')) >= 0) {
    hooks.onLine(lineBuffer.slice(0, idx));
    lineBuffer = lineBuffer.slice(idx + 1);
  }
}

// ---- Daftar port ----
export async function listPortPaths() {
  const ports = await SerialPort.available_ports();
  const list = Array.isArray(ports) ? ports : Object.keys(ports);
  return list.map(p => typeof p === 'string' ? p : (p.path || p.name || JSON.stringify(p)));
}

// Isi dropdown. `paths` opsional (kalau sudah punya daftar), `quiet` = jangan log kalau kosong.
export async function refreshPorts(paths, quiet) {
  try {
    const list = paths || await listPortPaths();
    knownPorts = new Set(list);
    const sel = el('portSelect');
    const keep = sel.value;
    sel.innerHTML = '';
    list.forEach(value => {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = value;
      sel.appendChild(opt);
    });
    if (keep && list.includes(keep)) sel.value = keep;
    if (list.length === 0 && !quiet) log(t('transport.noPorts'), 'err');
    return list;
  } catch (e) { log(t('transport.portListError', { err: e }), 'err'); return []; }
}

// Probe singkat di port sementara: apakah ini MacroPad?
export async function probeWhoAmI(path) {
  let temp, tempUnlisten = null, probeTimer = null;
  try {
    temp = new SerialPort({ path, baudRate: BAUD, size: READ_SIZE });
    await temp.open();
    await temp.setDataTerminalReady(true);
    await temp.setRequestToSend(true);
    await temp.startListening();

    const result = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      // listen() mengembalikan UnlistenFn; WAJIB disimpan dan dipanggil, kalau tidak
      // setiap probe menambah listener permanen pada event read port tersebut.
      tempUnlisten = null;
      temp.listen((data) => { if (data.includes('WHOAMI:MacroPad')) finish(true); })
        .then((u) => { tempUnlisten = u; })
        .catch(() => finish(false));
      temp.write('WHOAMI\n').catch(() => finish(false));
      probeTimer = setTimeout(() => finish(false), 700);
    });
    return result;
  } catch (e) {
    return false;
  } finally {
    if (probeTimer) clearTimeout(probeTimer);
    if (tempUnlisten) { try { tempUnlisten(); } catch (e) { } }
    try { if (temp) { await temp.stopListening(); await temp.close(); } } catch (e) { }
  }
}

// ---- Connect / disconnect ----
export async function connect(pathArg) {
  const path = pathArg || el('portSelect').value;
  if (!path) { log(t('transport.pickPort'), 'err'); return false; }
  try {
    port = new SerialPort({ path, baudRate: BAUD, size: READ_SIZE });
    await port.open();
    await port.setDataTerminalReady(true);
    await port.setRequestToSend(true);
    await port.startListening();
    portUnlisten = await port.listen((data) => handleIncomingChunk(data));
  } catch (e) {
    log(t('transport.openError', { err: e }), 'err');
    port = null; return false;
  }
  portPath = path;
  lastGoodPort = path;
  failedProbes.delete(path);
  clearTimeout(retryTimer);   // berhasil: batalkan retry yang masih terjadwal
  try { localStorage.setItem(LAST_PORT_KEY, path); } catch (e) { }
  setConnected(true);
  hooks.onConnected();
  deviceWasLost = false;
  startPing();
  suppressEventsUntil = Date.now() + 800;
  await sendLine('PING');
  // HWINFO wajib dikirim paling awal: memberi tahu profile, jumlah knob, dan apakah
  // angka baterai/RGB yang menyusul adalah simulasi (prototipe) atau hardware asli.
  setTimeout(async () => {
    await sendLine('WHOAMI');
    await sendLine('HWINFO');
    // Selalu mulai dari layer 0 setiap (re)connect, SEBELUM INFO.
    //
    // Firmware menyimpan currentLayer di struct cfg yang sama dengan isi flash,
    // jadi SAVE di layer 4 membuat device boot kembali di layer 4. Kalau INFO
    // dikirim lebih dulu, app akan memuat layer 4 ke grid lalu berganti ke
    // layer 0 - grid berkedip menampilkan isi yang salah sebelum benar.
    //
    // LAYER:0 dikirim lebih awal supaya device sudah berada di layer 0 saat INFO
    // diproses; INFO lalu melaporkan currentLayer=0 dan hanya ada satu layer yang
    // dimuat.
    await sendLine('LAYER:0');
    await sendLine('INFO');
    await sendLine('DUMPENC');
    await sendLine('BATT');
    await sendLine('RGB:DUMP');
  }, 400);
  return true;
}

export async function disconnect(manual) {
  if (manual) {
    autoReconnect = false;   // user sengaja memutus: jangan disambung otomatis lagi
    deviceWasLost = false;
    hooks.notify(t('transport.notifDisconnected'), 'disconnect');
    log(t('transport.autoPausedLog'));
  }
  stopPing();
  // Parser state harus ikut dibersihkan di jalur manual, sama seperti di
  // handleDeviceLost(). Sebelumnya Disconnect manual meninggalkan baris parsial di
  // lineBuffer dan dumpInProgress = true, sehingga byte pertama device berikutnya
  // menempel pada baris rusak itu.
  resetParserState();
  releasePortListener();
  try { if (port) { await port.stopListening(); await port.close(); } } catch (e) { }
  port = null; portPath = null;
  // Sengaja TIDAK clearDirty di sini. Pada disconnect manual device tidak dicabut,
  // jadi RAM device masih memegang perubahan yang belum disimpan ke flash. kalau flag
  // 'belum disimpan' dihapus, menyambung ulang ke device yang sama akan membuat app
  // sudah tidak ada yang perlu disimpan. clearDirty hanya tepat di handleDeviceLost(),
  // di sana device benar-benar hilang sehingga isinya ikut hilang.
  hooks.onDeviceLost();
  setConnected(false);
}

// Device tercabut / hilang: bersihkan state supaya reconnect bisa jalan.
// Dipanggil dari pollPorts (path hilang dari daftar) maupun dari sendLine (gagal tulis) -
// yang kedua perlu untuk cabut-colok cepat ke nomor COM yang sama, dimana daftar port
// tidak sempat kelihatan berubah di antara dua polling 2 detik.
export async function handleDeviceLost() {
  if (!port) return;
  log(t('transport.deviceLostLog'), 'err');
  deviceWasLost = true;
  hooks.notify(t('transport.notifDeviceLost'), 'disconnect');
  const p = port, lostPath = portPath;
  port = null; portPath = null;
  hooks.clearDirty();   // RAM device hilang bersama daftar port; tidak ada yang tertunda
  resetParserState();
  hooks.onDeviceLost();
  stopPing();
  setConnected(false);
  releasePortListener();
  try { await Promise.race([(async () => { await p.stopListening(); await p.close(); })(), sleep(1000)]); } catch (e) { }
  // Path ini mungkin tidak pernah "hilang" dari enumerasi OS (nomor COM sama, cabut-colok
  // cepat), jadi selain menunggu pollPorts mendeteksi lewat added/removed, langsung coba
  // lagi path ini juga.
  if (lostPath) failedProbes.delete(lostPath);
  if (lostPath && autoReconnect) { knownPorts.delete(lostPath); scheduleRetry([lostPath]); }
}

// Label tombol sambung/putus.
//
// Dipisah dari setConnected() karena label ini berubah dua kali: oleh
// perubahan status koneksi, DAN oleh applyI18n() setiap kali user ganti bahasa.
// Kalau hanya dipasang lewat setConnected(), applyI18n akan menimpanya dengan
// teks statis dan tombol kembali selalu membaca "Sambung" padahal device
// sedang tersambung. Fungsi murni ini jadi satu-satunya sumber label.
export function updateConnectButton(state) {
  el('btnConnect').textContent = state ? t('transport.disconnect') : t('header.connect');
}

export function setConnected(state) {
  el('dot').classList.toggle('on', state);
  el('statusText').textContent = state ? t('transport.connected') : t('transport.notConnected');
  // Tombol ini sudah pindah ke panel "Koneksi manual" (tersembunyi di balik
  // <details>). Labelnya tetap perlu ikut berubah karena tombol itu berfungsi
  // ganda: menyambung saat putus, memutus saat tersambung.
  updateConnectButton(state);
  el('app').style.display = state ? 'block' : 'none';
  if (!state) hooks.onDisconnected();
}

// ---- Auto-connect ----
// Cari MacroPad lalu connect. `only` = daftar port yang boleh di-probe (dipakai saat ada
// port BARU muncul, supaya port lama yang bukan MacroPad tidak ikut di-probe ulang).
// Tanpa `only` = semua port. Port terakhir yang berhasil selalu dicoba duluan.
export async function tryAutoConnect(verbose, only) {
  if (autoBusy || port) return false;
  autoBusy = true;
  try {
    const all = await refreshPorts(null, !verbose);
    if (all.length === 0) { if (verbose) log(t('transport.autoNoPorts'), 'err'); return false; }
    const paths = only ? all.filter(p => only.includes(p)) : all;
    if (paths.length === 0) return false;
    const ordered = [...paths].sort((a, b) => (b === lastGoodPort) - (a === lastGoodPort));

    log(t('transport.autoSearching'), null);
    for (const path of ordered) {
      const ok = await probeWhoAmI(path);
      if (!ok) continue;
      el('portSelect').value = path;
      await sleep(400); // beri jeda, Windows perlu lepas handle port dulu
      if (await connect(path)) { log(t('transport.autoConnectOk', { path }), 'ok'); hooks.onAutoConnectOk(path); return true; }
      log(t('transport.autoReconnectFail', { path }), 'err');
      await sleep(400);
      if (await connect(path)) { log(t('transport.autoConnectOk2', { path }), 'ok'); hooks.onAutoConnectOk(path); return true; }
    }
    if (verbose) { log(t('transport.autoNotFound'), 'err'); hooks.onAutoConnectFail(); }
    return false;
  } finally { autoBusy = false; }
}

// Konstanta jeda retry. Nilai dulu: maksimal 2x percobaan, jeda 3 dtk lalu 6 dtk.
const RETRY_MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 2500;
const RETRY_MAX_MS = 20000;

// Jeda antar percobaan: 2,5 dtk - 5 dtk - 7,5 dtk - 10 dtk - 12,5 dtk - 15 dtk
// (dibatasi RETRY_MAX_MS). Backoff naik supaya port yang memang bukan MacroPad
// tidak di-probe terlalu sering, tapi cukup cepat untuk device yang sedang boot.
function retryDelay(attempt) {
  return Math.min(RETRY_BASE_MS * attempt, RETRY_MAX_MS);
}

// Retry untuk device yang sudah terlihat di daftar port tapi belum siap
// menjawab (mis. ESP32 masih booting saat Windows baru start).
//
// Dulu: maksimal 2x percobaan lalu menyerah PERMANEN. Digabung dengan
// pollPorts() yang hanya probe saat ada port BARU muncul, hasilnya device
// yang port-nya muncul sebelum firmware siap TIDAK PERNAH tersambung -
// karena setelah 2x gagal, tidak ada percobaan ketiga, dan port-nya sudah
// ada di knownPorts sehingga tidak lagi dianggap "baru". App butuh restart
// atau dicabut-colok untuk tersambung lagi.
//
// Sekarang: 6x percobaan dengan backoff. Setelah habis, pollPorts() yang
// menjadi jaring pengaman - isinya masih me-probe ulang port yang gagal di-
// probe, sehingga menunggu tanpa batas, bukan menyerah.
export function scheduleRetry(only, attempt = 1) {
  clearTimeout(retryTimer);
  if (attempt > RETRY_MAX_ATTEMPTS) return;
  retryTimer = setTimeout(async () => {
    if (port || !autoReconnect) return;
    const ok = await tryAutoConnect(false, only);
    if (!ok) scheduleRetry(only, attempt + 1);
  }, retryDelay(attempt));
}

// Tombol ↻ dan start awal
export async function autoDetect() {
  autoReconnect = true;
  clearTimeout(retryTimer);
  failedProbes = new Set();   // probe ulang dari nol saat user menekan tombol ↻
  if (port) { await refreshPorts(); return; }
  const ok = await tryAutoConnect(true);
  if (!ok && knownPorts.size) scheduleRetry([...knownPorts]);
}

// Pantau daftar port tiap 2 dtk (enumerasi murah). Probe jalan kalau ada port
// BARU muncul, ATAU ada port yang sebelumnya gagal di-probe (device masih
// booting). Port yang gagal lalu berhasil connect dihapus dari daftar itu,
// sehingga tidak ada probing berulang atas port yang sudah pasti benar.
export async function pollPorts() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const paths = await listPortPaths();
    if (port && portPath && !paths.includes(portPath)) await handleDeviceLost();
    if (autoBusy) return; // biarkan selesai; perubahan dihitung di putaran berikutnya
    const added = paths.filter(p => !knownPorts.has(p));
    const removed = [...knownPorts].some(p => !paths.includes(p));
    // Port yang sudah di-probe tapi GAGAL (mis. device masih booting, atau
    // enumerate muncul sebelum firmware siap). Perlakukan seperti "baru":
    // tanpa ini, device seperti itu tidak akan pernah dicoba lagi selama
    // port-nya tidak berubah - lihat catatan panjang di scheduleRetry().
    const retryable = paths.filter(p => failedProbes.has(p));
    if (!added.length && !removed && !retryable.length) return;
    await refreshPorts(paths, true);
    if (!port && autoReconnect && (added.length || retryable.length)) {
      const targets = added.length ? added : retryable;
      const ok = await tryAutoConnect(false, targets);
      if (ok) {
        for (const t of targets) failedProbes.delete(t);
      } else {
        for (const t of targets) failedProbes.add(t);
        scheduleRetry(targets);
      }
    }
  } catch (e) {
  } finally { pollBusy = false; }
}

export function startPing() {
  stopPing();
  pingTimer = setInterval(() => { if (port) sendLine('PING'); }, 1500);
}
export function stopPing() { clearInterval(pingTimer); pingTimer = null; }

export { sleep };
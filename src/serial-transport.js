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
import { feedFrameBytes, resetFrameRx } from './frame-dispatch.js';

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
// Saat true, manager lintas-transport yang memiliki siklus auto-connect.
// pollPorts() tetap memantau port (deteksi cabut), tapi tidak boleh ikut
// memanggil tryAutoConnect() - itu akan berebut dengan loop manager.
let managerMode = false;
let pollBusy = false;
let knownPorts = new Set();
// Port yang sudah di-probe tapi GAGAL pada percobaan terakhir. Disimpan supaya
// pollPorts() bisa mencoba lagi nanti - bukan hanya saat port "baru" muncul.
let failedProbes = new Set();
// Port yang pernah di-probe (berhasil maupun gagal). Dipakai supaya port yang
// sudah ada saat startup tapi belum sempat diprobe - karena port sebelumnya
// sudah cocok - tetap dicoba setelah device pertama pergi.
let probedPorts = new Set();
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
  // Decoder frame ikut dibersihkan. Kalau tidak, setengah frame dari sesi lama
  // akan menempel pada byte pertama device berikutnya, dan perakit bisa
  // menyelesaikan frame yang tidak pernah benar-benar dikirim.
  resetFrameRx();
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
export function setManagerMode(v) { managerMode = !!v; }
// Batalkan retry yang sudah terjadwal. Dipakai facade saat berpindah backend
// dan saat user memutus manual, supaya timer lama tidak bangun di transport
// yang sudah tidak aktif.
export function stopAutoRetry() { clearTimeout(retryTimer); retryTimer = null; }
// Port yang sudah lolos probe tetapi gagal connect harus dicoba lagi. Tanpa
// penanda ini findAvailableDevice() menganggapnya "sudah dikenal" dan tidak
// pernah memprobe ulang.
export function markPortFailed(path) { if (path) failedProbes.add(path); }

function releasePortListener() {
  const u = portUnlisten;
  portUnlisten = null;
  if (u) { try { u(); } catch (e) { log(t('transport.unlistenError', { err: e }), 'err'); } }
}

// ---- Pengiriman ----
export async function sendRaw(data) {
  if (!port) return false;
  try {
    if (typeof data === 'string') await port.write(data);
    else await port.write(new Uint8Array(data));
    return true;
  } catch (e) {
    log(t('transport.sendError', { err: e }), 'err');
    await handleDeviceLost();
    return false;
  }
}

// Alias lama: writeRaw() diganti jadi sendRaw() sebagai bagian dari kontrak
// facade transport.js. Alias ini tetap ada supaya no-lost-functions-test
// tidak melaporkan regresi saat mengekstraksi transport.
export const writeRaw = sendRaw;

// Pada transport serial, tidak ada konsep "WriteWithoutResponse" (BLE).
// Kirim mentah tanpa menunggu ack — untuk serial tetap pakai sendRaw() yang
// sama, karena serial tidak membedakan confirmed vs. unconfirmed write.
export async function sendRawNoAck(data) {
  return sendRaw(data);
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
export async function sendBatch(lines) {
  if (!port) return;
  let chunk = '';
  for (const ln of lines) {
    if (chunk.length + ln.length + 1 > 900) { await sendRaw(chunk); chunk = ''; }
    chunk += ln + '\n';
  }
  if (chunk) await sendRaw(chunk);
}

// ---- Penerimaan ----
export function handleIncomingChunk(data) {
  // Byte masuk dialirkan ke DUA jalur sekaligus, bukan salah satu.
  //
  // Versi pertama memakai model "ganti": kalau ada yang sedang menunggu jawaban
  // frame, parser baris dilewati seluruhnya. Itu menghapus event real-time yang
  // tetap keluar sebagai teks di mode frame - buktinya dari pengujian di
  // perangkat, device mengirim EVT:LAYER:0 sebagai teks tepat setelah
  // CFG_ACTIVATE. Akibatnya user menekan knob di device dan app tidak bereaksi.
  //
  // Decoder frame hanya bereaksi pada SOF 0xA5, jadi teks ASCII tidak
  // mempengaruhinya. Beberapa byte UTF-8 bisa memicu percobaan SOF yang gagal,
  // tapi itu cuma menambah satu counter err_ver - frame utuh tidak rusak,
  // dan firmware punya sifat yang sama.
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : (data instanceof Uint8Array ? data : new Uint8Array(data));
  feedFrameBytes(bytes);

  lineBuffer += new TextDecoder().decode(bytes);
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
    const line = lineBuffer.slice(0, idx);
    lineBuffer = lineBuffer.slice(idx + 1);
    // Byte biner frame yang ikut terbaca sebagai teks menghasilkan U+FFFD.
    if (line.includes('\uFFFD')) continue;
    hooks.onLine(line);
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
  // Backend yang belum tersambung tidak punya apa pun untuk ditutup. Tanpa
  // guard ini, setTransportBackend() yang memanggil disconnect(true) saat
  // berpindah transport akan memunculkan notifikasi "terputus" palsu dan
  // menjalankan onDisconnected padahal tidak ada device yang hilang.
  if (!port) {
    if (manual) { autoReconnect = false; stopAutoRetry(); }
    return;
  }
  if (manual) {
    autoReconnect = false;   // user sengaja memutus: jangan disambung otomatis lagi
    stopAutoRetry();
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
  // Saat manager lintas-transport aktif, retry dimiliki manager. Timer di sini
  // akan berebut dengan loop manager dan bisa connect ke transport yang sudah
  // tidak aktif - jadi jangan dijadwalkan sama sekali.
  if (managerMode) return;
  if (attempt > RETRY_MAX_ATTEMPTS) return;
  retryTimer = setTimeout(async () => {
    if (port || !autoReconnect) return;
    const ok = await tryAutoConnect(false, only);
    if (!ok) scheduleRetry(only, attempt + 1);
  }, retryDelay(attempt));
}

// Reset penanda probe. Dipakai tombol Refresh USB dan autoDetect() supaya
// pencarian berikutnya benar-benar memprobe semua port dari awal.
export function resetProbeState() {
  failedProbes = new Set();
  probedPorts = new Set();
}

// Tombol ↻ dan start awal
export async function autoDetect() {
  autoReconnect = true;
  clearTimeout(retryTimer);
  failedProbes = new Set();   // probe ulang dari nol saat user menekan tombol ↻
  probedPorts = new Set();
  if (port) { await refreshPorts(); return; }
  const ok = await tryAutoConnect(true);
  if (!ok && knownPorts.size) scheduleRetry([...knownPorts]);
}

// Cari port yang bisa dipakai auto-connect TANPA membuka koneksi permanen.
//
// Ini inti dari tryAutoConnect(), dipisah supaya manager lintas-transport bisa
// memprobe USB sambil backend BLE tetap aktif. `knownPorts` dari putaran
// sebelumnya dipakai untuk membatasi probe: hanya port baru, port yang gagal,
// dan port terakhir yang sukses - bukan semua port setiap 2 detik.
export async function findAvailableDevice(only) {
  if (port) return null;
  // Enumerasi murah dulu; dropdown hanya di-rebuild kalau daftar port benar-
  // benar berubah. Tanpa ini, probe tiap 2 detik akan menutup dropdown yang
  // sedang dibuka user karena <select> diisi ulang terus-menerus.
  const all = await listPortPaths();
  const prevKnown = knownPorts;
  const added = all.filter(p => !prevKnown.has(p));
  const removed = [...prevKnown].some(p => !all.includes(p));
  if (added.length || removed) await refreshPorts(all, true);
  if (all.length === 0) return null;

  const targets = only && only.length ? all.filter(p => only.includes(p)) : all;
  const candidates = [];
  const add = (p) => { if (!candidates.includes(p)) candidates.push(p); };

  // Port terakhir yang sukses selalu dicoba lebih dulu.
  if (lastGoodPort && targets.includes(lastGoodPort)) add(lastGoodPort);
  for (const p of targets) {
    if (!prevKnown.has(p) || !probedPorts.has(p) || failedProbes.has(p)) add(p);
  }

  for (const path of candidates) {
    const found = await probeWhoAmI(path);
    // Selalu tandai perlu-dicoba sampai connect() benar-benar berhasil
    // menghapusnya. Kalau penanda dihapus di sini lalu user menjeda/berpindah
    // transport sebelum connect, port itu akan dianggap sudah dikenal dan
    // tidak pernah diprobe lagi.
    probedPorts.add(path);
    failedProbes.add(path);
    if (found) {
      // Windows butuh waktu melepas handle port sementara sebelum connect()
      // membukanya lagi. Jeda ini sama dengan yang sudah terbukti di
      // tryAutoConnect(); tanpa jeda, connect bisa gagal "port terkunci".
      await sleep(400);
      return path;
    }
  }
  return null;
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
    // managerMode: siklus connect dimiliki connection-manager.js. pollPorts
    // tetap boleh mendeteksi port baru/hilang, tapi tidak boleh ikut connect.
    if (!port && autoReconnect && !managerMode && (added.length || retryable.length)) {
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

// Poll untuk serial: memanggil pollPorts() yang memeriksa port baru/hilang
// dan auto-reconnect. Dipanggil oleh facade transport.poll() setiap 2 detik.
export async function poll() {
  return pollPorts();
}

export function startPing() {
  stopPing();
  pingTimer = setInterval(() => { if (port) sendLine('PING'); }, 1500);
}
export function stopPing() { clearInterval(pingTimer); pingTimer = null; }

export { sleep };
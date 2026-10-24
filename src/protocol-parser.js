// ==================== PARSER PROTOKOL ====================
//
// handleLine(): satu baris dari device -> aksi. Dipindah ke sini dari main.js
// supaya kontrak protokol app<->firmware ada di satu tempat yang bisa diuji
// tanpa browser.
//
// Aturan yang harus dijaga modul ini:
//  1. Setiap indeks dari device DIVALIDASI sebelum dipakai. Nilai dari device
//     tidak boleh dipercaya buta: parseInt("abc") = NaN, dan indeks NaN membuat
//     assignment melempar TypeError DI DALAM callback serial, yang ditangkap plugin
//     lalu ditelan. Akibatnya parser mati di tengah stream dan semua baris
//     berikutnya dimakan sebagai payload DUMP - desync permanen sampai reconnect.
//     Validasi lengkap ada di device-state.js.
//  2. Nilai boleh mengandung koma (macro TEXT, nama layer), jadi field terakhir
//     selalu "sisa baris", bukan hasil split()[3].
//  3. Urutan percabangan penting. Baris yang sedang "di dalam" sebuah blok
//     (DUMP_BEGIN..DUMP_END) harus dicek sebelum penanda umum lain, kalau tidak
//     payload DUMP akan ikut dibaca sebagai perintah.

// Impor semua yang.handleLine() pernah pakai, dari modul yang memegangnya.
// Sengaja import langsung (bukan lewat main.js) supaya tidak ada siklus: modul ini
// hanya butuh fungsi pasif dari device-state, framing dari transport, dan baris
// dari adaptive/battery/rgb.
import { invoke } from '@tauri-apps/api/core';
import {
  ROWS, COLS, NUM_ENCODERS, currentLayer, layerNames, encConfig, encParseIdx,
  encConfigCached,
  setNumEncoders, applyInfo, applyDumpRow, applyEncRow, applyName,
  applyLayerEvent, applyEncCount, applyEncIdx, setEncConfigCached,
} from './device-state.js';
import { el, log } from './dom.js';
import { t } from './i18n.js';
// Lewat facade transport.js, bukan serial-transport.js langsung: dump bisa
// datang lewat USB atau BLE, dan state framing (dumpInProgress dll) milik
// backend yang sedang aktif. Dipakai sebagai fungsi, bukan nilai - facade
// mengekspornya sebagai getter supaya tidak beku di nilai import.
import {
  sendLine, dumpInProgress, dumpEncInProgress, namesInProgress,
  setDumpInProgress, setDumpEncInProgress, setNamesInProgress, eventsSuppressed,
} from './transport.js';
import { handleRgbLine } from './rgb-page.js';
import { reportPong } from './pong-probe.js';
import { playSound } from './soundboard.js';
import { battUI, setBatteryFromKv, setChargeState, markBatterySimulated } from './battery-ui.js';
import {
  suppressDeviceEcho, activePresetName, activePresetLayers,
  resolveDumpWaiters, handleEscapeGesture, noteDeviceLayerEvent,
} from './adaptive.js';

// ---- State yang hanya dimiliki parser ----
// Layer yang sedang di-dump, dibaca dari DUMP_BEGIN:<n>. Dipakai supaya isi dump
// masuk ke layer asalnya, bukan ke currentLayer yang mungkin sudah berubah karena
// device Sudah pindah layer di tengah dump.
let dumpParseLayer = NaN;

// Event layer yang datang saat ada dump SEDANG BERJALAN sengaja ditunda,
// bukan langsung diterapkan.
//
// Alasannya: dump memakai DUMP_BEGIN:<n> untuk menandai layer tujuan, dan
// DUMP_END penutupnya me-resolve waiter berdasarkan layer itu. Kalau device
// pindah layer di tengah dump, stream baris bercampur dan isi preset bisa
// tersimpan setengah jadi.
//
// Menunda event-nya membuat dump selesai dulu, baru layer yang diabaikan itu
// diterapkan - aman karena dua hal tidak saling menginterupsi.
let pendingLayerAfterDump = null;
// Sudah dicatat error untuk frame yang sedang berjalan? Satu error per frame,
// bukan per baris - kalau per baris, panel log jadi hanya berisi error yang
// sama berulang dan masalah yang sebenarnya jadi tidak terlihat.
let dumpErrorLogged = false;
let namesErrorLogged = false;

// Baris non-frame yang datang SELAMA frame NAMES sedang berjalan.
//
// Device mengirim jawaban secara berurutan, tapi baris status (INFO, HWINFO,
// WHOAMI, [OK]) bisa tiba tepat di tengah frame DUMPNAMES kalau dua perintah
// dikirim berdekatan. Baris-baris itu tidak boleh dibuang - INFO khususnya
// memicu loadLayer(), jadi membuangnya berarti grid tidak pernah dimuat ulang.
//
// Batasi jumlahnya: kalau device_selection_node salah benar-benar hanya mengirim
// baris non-frame tanpa pernah NAMES_END, queue ini akan tumbuh tanpa batas.
const deferredLines = [];
const DEFERRED_MAX = 64;

function isNamesRow(line) {
  // Isi frame NAMES adalah "<idx>,<nama>". Nama layer boleh mengandung koma,
  // jadi yang diperiksa hanya bagian pertama sebelum koma pertama: harus angka.
  const idx = line.indexOf(',');
  if (idx < 0) return false;
  const head = line.substring(0, idx).trim();
  return /^\d+$/.test(head);
}

function processDeferredLines() {
  while (deferredLines.length) {
    const l = deferredLines.shift();
    handleFrameLine(l);
  }
}
export function takePendingLayerAfterDump() {
  const n = pendingLayerAfterDump;
  pendingLayerAfterDump = null;
  return n;
}
export const hasPendingLayerAfterDump = () => pendingLayerAfterDump !== null;

// Profil & kemampuan hardware, dibaca dari HWINFO. Penting karena firmware
// PROTOTIPE mengirim angka SIMULASI untuk baterai/RGB; app harus menandai agar
// data palsu tidak dibaca sebagai data hardware sungguhan.
export let deviceProfile = { connected: false };

// Kemampuan yang HARUS bertahan melewati disconnect.
//
// `frame=0xA5` adalah tanda device punya lapisan frame biner - nilai konstan,
// bukan state. Kalau ikut terhapus bersama sesi, maka tepat di koneksi
// berikutnya app tidak tahu device ini mendukung frame, dan fast path mati
// hanya karena terjadi disconnect.
//
// Yang justru BOLEH ikut terhapus adalah `proto`: itu mode yang sedang
// aktif, dan device bisa saja sedang dalam mode frame (jadi tidak bisa
// menjawab WHOAMI) ketika link-nya putus.
let lastFrameSof = null;

// Bukti dukungan frame yang bertahan melewati disconnect, untuk
// deviceSupportsFrame() di frame-transport.js.
export function frameCapability() { return lastFrameSof; }

// Dipanggil hook onDisconnected di main.js: jangan biarkan HWINFO lama membuat
// app terlihat masih terhubung ke board yang sudah dicabut.
export function resetDeviceProfile() {
  // Kemampuan frame sengaja dipertahankan (lihat lastFrameSof). Sesi
  // berikutnya akan mengirim WHOAMI lagi dan menimpanya kalau device ternyata
  // berbeda.
  deviceProfile = { connected: false };
  dumpParseLayer = NaN;
  pendingLayerAfterDump = null;   // device sudah tidak ada; jangan tunda apa pun
}

// ---- Hook ke main.js ----
// Hanya fungsi yang menyentuh UI/layar. Segala sesuatu yang lain di atas diimpor
// langsung, jadi daftar ini pendek dan jelas.
let hooks = {
  notify: () => { },
  notifyBoundAction: () => { },
  renderDeviceProfileBadge: () => { },
  renderTabs: () => { },
  renderGrid: () => { },
  renderEncoderList: () => { },
  loadLayer: () => { },
};
export function initProtocolParser(h) { hooks = Object.assign({}, hooks, h); }

export function handleLine(line) {
  line = line.trim();
  if (!line) return;

  // ---- Event real-time SELALU menang atas frame dump ----
  //
  // Baris EVT:* (baterai, charger, app yang dibuka) dan [KEY] (penekanan
  // tombol) adalah event yang terjadi KAPAN SAJA - termasuk di tengah dump
  // yang sedang berjalan. Device tidak tahu sedang di-dump, dan tidak
  // menunggu.
  //
  // Semula baris-baris ini dicek setelah branch dumpInProgress. Akibatnya
  // setiap EVT:BATT dan [KEY] yang datang saat dump berjalan dianggap "isi
  // dump" lalu ditolak - jadi notifikasi overlay hilang tepat saat user
  // menekan tombol, dan meter baterai berhenti bergerak.
  //
  // Dua alasan ini harus diperiksa di depan semua branch frame:
  //   1. Kehilangan event - notifikasi tombol tidak pernah muncul.
  //   2. Menajamkan noise - device mengirim EVT:BATT tiap ~1 detik, jadi satu
  //      dump yang panjang bisa menghasilkan ratusan "Invalid DUMP line" yang
  //      menutupi masalah yang sebenarnya.
  //
  // Aman terhadap kebingungan: DUMP_BEGIN/END, ENC_BEGIN/END, NAMES_BEGIN/END
  // dan baris isinya tidak pernah diawali "EVT:" atau "[", jadi tidak ada
  // risiko baris frame salah dikira event.
  if (line.startsWith('EVT:') || line.startsWith('[')) {
    return handleRealtimeLine(line);
  }

  return handleFrameLine(line);
}

// Notifikasi overlay dari event hardware. Dipisah supaya bisa dipanggil dari
// jalur "selalu menang" di atas, tanpa ikut masuk ke logika frame.
function handleRealtimeLine(line) {
  let mm;
  if ((mm = line.match(/^\[LAYER\] Pindah ke layer (\d+)/))) {
    const n = parseInt(mm[1]);
    // Saat preset aktif, nama layer diambil dari preset itu - device hanya tahu
    // layer sebagai nomor, dan nomor itu milik preset aktif, bukan preset default.
    const ap = activePresetName();
    const apLayers = activePresetLayers();
    const pname = ap || 'Default';
    const lname = (apLayers ? apLayers[n]?.name : layerNames[n]) || ('Layer ' + n);
    hooks.notify(t('parser.layerNotif', { from: pname, to: lname }), 'layer');
  } else if ((mm = line.match(/^\[KEY\] (\d+),(\d+),(\d+),(\d+),(.*)$/))) {
    // Format ringkas dari firmware: layer,row,col,type,value. Notifikasi hanya
    // memakai type + value; posisi tombol tetap tampil di panel log.
    hooks.notifyBoundAction(parseInt(mm[4]), mm[5]);
  } else if ((mm = line.match(/^EVT:ENC:(\d+):(CW|CCW)$/))) {
    const a = encConfig[+mm[1]]?.[mm[2]];
    if (a) hooks.notifyBoundAction(a.type, a.value);
  } else if ((mm = line.match(/^\[ENC_BTN\] Knob (\d+):/)) || line.startsWith('[ENC_BTN] Aksi terkonfigurasi')) {
    const a = encConfig[mm ? +mm[1] : 0]?.BTN;             // knob utama (index 0) mencetak tanpa nomor
    if (a) hooks.notifyBoundAction(a.type, a.value);
  }
  // Selama upload batch preset, device membalas banyak baris [OK] yang tidak perlu
  // masuk panel log. Jendelanya dimiliki adaptive.js karena dia yang memulai batch.
  if (suppressDeviceEcho() && (line.startsWith('[OK]') || line.startsWith('[LAYER]'))) return;

  if (line.startsWith('EVT:APP:')) {
    if (eventsSuppressed()) { log(t('parser.staleEvent')); return; }
    const name = line.substring(8);
    // Prefix "SOUND:" pada value APP berarti trigger soundboard, bukan launch_app.
    if (name.startsWith('SOUND:')) {
      const soundId = name.substring(6);
      playSound(soundId)
        .then(() => log(t('parser.soundTrigger', { id: soundId }), 'ok'))
        .catch(e => log(t('parser.soundError', { err: e }), 'err'));
      return;
    }
    invoke('launch_app', { name })
      .then(n => log(t('parser.appOpening', { name: n }), 'ok'))
      .catch(e => log(t('parser.appError', { err: e }), 'err'));
    return;
  }

  if (line === 'EVT:ESCAPE') {
    // Logika escape (bekukan auto-switch / tolak saat mode edit) milik adaptive.js
    // karena ia yang memegang state preset aktif dan mode edit.
    handleEscapeGesture();
    return;
  }

  if (line.startsWith('EVT:LAYER:')) {
    const n = parseInt(line.substring(10));
    // Beri tahu adaptive.js supaya auto-switch menunda diri - pilihan layer user
    // tidak boleh langsung ditimpa preset aktif. Arah panggilan ini
    // parser -> adaptive, yang memang sudah jadi arah import yang ada; kalau
    // dibalik, muncul siklus import.
    noteDeviceLayerEvent();
    // Berlaku juga di jalur ini (bukan hanya saat dump): device bisa memindah
    // layer sendiri kapan saja. Kalau dump sedang berjalan, tunda lalu terapkan
    // setelah selesai - kalau tidak, currentLayer berubah di tengah dump dan waiter
    // DUMP_END me-resolve layer yang salah.
    if (dumpInProgress()) {
      pendingLayerAfterDump = n;
      log(t('parser.layerDuringDump', { n }));
      return;
    }
    if (n !== currentLayer && applyLayerEvent(n)) {
      // Device sudah pindah layer dengan sendirinya (long-press knob), jadi jangan
      // kirim LAYER: balik - cukup baca isinya.
      hooks.renderTabs();
      hooks.loadLayer(n);
    }
    return;
  }

  if (line.startsWith('EVT:BATT:')) {
    const kv = {}; line.substring(9).split(',').forEach(p => { const eq = p.indexOf('='); if (eq > 0) kv[p.substring(0, eq)] = p.substring(eq + 1); });
    if (kv.profile !== undefined) deviceProfile.profile = kv.profile;
    setBatteryFromKv(kv);
    return;
  }
  if (line.startsWith('EVT:CHG:')) {
    const m = line.match(/state=(\d+)/);
    if (m) {
      const st = parseInt(m[1]);
      setChargeState(st);
      // Penting: kind harus salah satu dari yang dipakai filter notifikasi baterai.
      // Sebelumnya dipakai 'batt' yang TIDAK ada di daftar filter, sehingga notifikasi
      // baterai ikut dikendalikan toggle "Notifikasi dasar", bukan "Notifikasi baterai".
      if (st === 1) hooks.notify(t('batt.chargeStarted'), 'charge', { hold: 5000 });
      else if (st === 2) hooks.notify(t('batt.chargeDone'), 'charge-done', { hold: 5000 });
      // state 0 (charger dicabut) sengaja tidak dinotifikasi supaya tidak membising.
    }
    return;
  }
}

// ---- Frame (DUMP / DUMPENC / DUMPNAMES) dan status ----
// Semua baris yang TIDAK diawali "EVT:" atau "[" sampai di sini. Event
// real-time sudah ditangani lebih dulu oleh handleLine() supaya tidak pernah
// tertelan oleh dump yang sedang berjalan.
function handleFrameLine(line) {
  if (line.startsWith('DUMP_BEGIN:')) { setDumpInProgress(true); dumpErrorLogged = false; dumpParseLayer = parseInt(line.substring(11)); return; }
  if (line === 'DUMP_END') {
    setDumpInProgress(false); dumpErrorLogged = false; hooks.renderGrid();
    // Resolve waiter milik layer yang benar-benar didump. Waiter-nya dimiliki
    // adaptive.js (dia yang menunggunya), tapi pemicunya baris di sini.
    const done = (Number.isNaN(dumpParseLayer) ? currentLayer : dumpParseLayer);
    dumpParseLayer = NaN;
    resolveDumpWaiters(done);

    // Dump benar-benar selesai - baru terapkan layer yang tadi datang di
    // tengah dump. URUTAN PENTING: resolveDumpWaiters() di atas memakai
    // currentLayer sebagai fallback kalau device tidak menyebut nomor layer
    // (DUMP_BEGIN: hilang/rusak). Kalau currentLayer sudah diubah dulu di sini,
    // fallback itu menunjuk layer yang salah dan waiter yang salah me-resolve.
    if (hasPendingLayerAfterDump()) {
      const pending = takePendingLayerAfterDump();
      if (pending !== currentLayer && applyLayerEvent(pending)) {
        hooks.renderTabs();
        hooks.loadLayer(pending);
      }
    }
    return;
  }
  if (dumpInProgress()) {
    const p = line.split(',');
    // Lihat aturan 1 di header modul ini. Validasi ada di applyDumpRow().
    if (p.length >= 4) {
      const layer = (Number.isNaN(dumpParseLayer) ? currentLayer : dumpParseLayer);
      const applied = applyDumpRow(layer, parseInt(p[0]), parseInt(p[1]), parseInt(p[2]), p.slice(3).join(','), log);
      // Satu baris per frame, bukan satu per baris rusak. Dump yang benar
      // saliendo boleh gagal di beberapa baris; kalau log setiap kegagalan,
      // panel_log jadi hanya berisi error dan masalah yang SEBENARNYA (mis.
      // penutup frame yang hilang) jadi tidak kelihatan di antara ratusan
      // baris yang sama.
      if (!applied && !dumpErrorLogged) {
        dumpErrorLogged = true;
        log(t('parser.dumpInvalid', { line }), 'err');
      }
    }
    return;
  }
  if (line.startsWith('ENC_BEGIN')) {
    setDumpEncInProgress(true);
    const m = line.match(/count=(\d+)/);
    if (m && applyEncCount(parseInt(m[1]), log)) el('deviceEncLabel').textContent = String(NUM_ENCODERS);
    return;
  }
  if (line === 'ENC_END') {
    setDumpEncInProgress(false);
    setEncConfigCached(true);  // encoder config sudah dicache
    hooks.renderEncoderList();
    return;
  }
  if (dumpEncInProgress()) {
    if (line.startsWith('IDX:')) { applyEncIdx(parseInt(line.substring(4))); return; }
    const p = line.split(',');
    // Allowlist kunci ada di applyEncRow - tanpa itu device bisa mengirim
    // "__proto__" yang menjadi prototype assignment pada objek knob.
    if (p.length >= 3) applyEncRow(encParseIdx, p[0], parseInt(p[1]), p.slice(2).join(','), log);
    return;
  }
  if (line.startsWith('HWINFO:')) {
    deviceProfile = { connected: true };
    line.substring(7).split(',').forEach(p => {
      const eq = p.indexOf('='); if (eq < 0) return;
      const k = p.substring(0, eq), v = p.substring(eq + 1);
      deviceProfile[k] = /^-?\d+$/.test(v) ? parseInt(v) : v;
    });
    if (deviceProfile.encoders) setNumEncoders(deviceProfile.encoders);
    markBatterySimulated(deviceProfile.simulated === 1);
    log(`[HW] Profil ${deviceProfile.profile} - rgb=${deviceProfile.rgb} vdiv=${deviceProfile.vdiv} chg=${deviceProfile.chg}` + (battUI.simulated ? ' (data simulasi)' : ''));
    hooks.renderDeviceProfileBadge();
    return;
  }
  // Baris RGB ditangani oleh modul halaman RGB (state-nya dibaca dari device).
  if (handleRgbLine(line, log)) return;
  if (line === 'NAMES_BEGIN') { setNamesInProgress(true); namesErrorLogged = false; return; }
  if (line === 'NAMES_END') { setNamesInProgress(false); namesErrorLogged = false; processDeferredLines(); hooks.renderTabs(); return; }
  if (namesInProgress()) {
    // Baris status yang BUKAN isi frame harus DITUNDA, bukan dibuang.
    //
    // INFO juga mengandung koma (INFO:layerCount=1,rows=3,...), jadi tanpa
    // cek ini ia ikut diperlakukan sebagai "<idx>,<nama>" dan applyName()
    // menolaknya. Akibatnya INFO hilang - dan INFO-lah yang memicu
    // loadLayer(). Kalau INFO hilang, grid app tidak pernah dimuat ulang
    // setelah preset berganti: user melihat keymap preset SEBELUMNYA.
    if (!isNamesRow(line)) {
      // Batasi: kalau NAMES_END tidak pernah datang, queue ini akan menumpuk
      // tanpa akhir. Baris paling lama dibuang - sama seperti batas buffer di
      // transport.
      if (deferredLines.length >= DEFERRED_MAX) deferredLines.shift();
      deferredLines.push(line);
      return;
    }
    const idx = line.indexOf(',');
    if (idx > -1) {
      // Sama seperti DUMP: satu error per frame (lihat catatan di branch dump).
      if (!applyName(parseInt(line.substring(0, idx)), line.substring(idx + 1), log) && !namesErrorLogged) {
        namesErrorLogged = true;
        log(t('parser.namesInvalid', { line }), 'err');
      }
    }
    return;
  }
  if (line.startsWith('INFO:')) {
    // Nilai dari device tidak boleh dipercaya buta: parseInt("abc") = NaN, dan
    // ROWS = NaN membuat Array.from({length: NaN}) -> [] sehingga renderGrid melempar.
    // Validasi + penulisan ada di applyInfo() (device-state.js).
    const kv = {};
    line.substring(5).split(',').forEach(p => {
      const eq = p.indexOf('='); if (eq < 0) return;
      kv[p.substring(0, eq)] = p.substring(eq + 1);
    });
    applyInfo(kv, { log });
    el('deviceEncLabel').textContent = String(NUM_ENCODERS);
    el('deviceMatrixLabel').textContent = ROWS + ' × ' + COLS;
    hooks.renderTabs(); hooks.loadLayer(currentLayer);
    // DUMPNAMES hanya kalau tidak ada dump yang sedang dibaca.
    //
    // INFO sering datang BERUNTUN di sesi yang sama: handshake mengirimnya,
    // lalu setiap activatePresetRuntime() mengirim INFO lagi. Tiap INFO memicu
    // DUMPNAMES tambahan - dan kalau satu sedang berjalan, DeviceDump yang
    // baru menumpuk di ylab yang sama. Parser proses satu-satu, jadi NAMES_END
    // dari dump pertama akan menutupi dump kedua (atau sebaliknya), menyisakan
    // namesInProgress = true selamanya. Gejalanya: setelahnya SETIAP baris
    // (INFO, [KEY], EVT:*) ditolak sebagai "Invalid NAMES line".
    //
    // Menunggu dump yang sedang berjalan lebih aman daripada menumpuk: dump
    // yang jalan pasti selesai sendiri, dan loadLayer() di atas sudah meminta
    // isi layer terbaru.
    if (!namesInProgress() && !dumpInProgress()) sendLine('DUMPNAMES');
    return;
  }
  if (line.startsWith('WHOAMI:')) {
    const parts = line.split(':');
    el('deviceNameLabel').textContent = parts[1] || 'MacroPad';
    // WHOAMI:MacroPad:v1:fw=X,rows=Y,cols=Z,encoders=N,proto=line|frame,frame=0xA5
    // Bagian ketiga dan seterusnya berisi KV pair yang dipisah koma.
    // Simpan proto dan frame ke deviceProfile supaya frame-transport.js
    // tahu apakah boleh pakai protoframe biner v2.
    const kvStr = parts.slice(3).join(':');
    kvStr.split(',').forEach(p => {
      const eq = p.indexOf('=');
      if (eq < 0) return;
      const k = p.substring(0, eq), v = p.substring(eq + 1);
      if (k === 'proto' || k === 'frame') deviceProfile[k] = v;
      // Simpan SOF sebagai capability yang bertahan melewati disconnect.
      // `proto` hanya mode saat ini dan bisa hilang total kalau link putus
      // saat device sedang di mode frame (device jadi tidak bisa jawab WHOAMI).
      if (k === 'frame' && /^0x[0-9a-f]{2}$/i.test(v.trim())) lastFrameSof = v.trim().toLowerCase();
    });
    return;
  }
  if (line === 'PONG') {
    // PONG adalah bukti device masih hidup dan masih menjawab SEBAGAI TEKS.
    // ensureLineMode() memakainya untuk membuktikan device sudah keluar dari mode
    // frame. Kalau tidak ada probe yang menunggu, reportPong() mengembalikan
    // false dan baris ini tetap disembunyikan seperti sebelumnya.
    reportPong();
    return;
  }

  if (line.startsWith('[ERROR]')) log(line, 'err');
  else if (line.startsWith('[OK]')) log(line, 'ok');
  else log(line);
}

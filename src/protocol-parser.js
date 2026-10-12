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
  setNumEncoders, applyInfo, applyDumpRow, applyEncRow, applyName,
  applyLayerEvent, applyEncCount, applyEncIdx,
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

// Dipanggil hook onDisconnected di main.js: jangan biarkan HWINFO lama membuat
// app terlihat masih terhubung ke board yang sudah dicabut.
export function resetDeviceProfile() {
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

  // ---- Notifikasi overlay dari event hardware ----
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
    // Dump yang sedang berjalan sengaja diabaikan, lalu diterapkan setelah selesai.
    // Lihat catatan panjang di deklarasi pendingLayerAfterDump.
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

  if (line.startsWith('DUMP_BEGIN:')) { setDumpInProgress(true); dumpParseLayer = parseInt(line.substring(11)); return; }
  if (line === 'DUMP_END') {
    setDumpInProgress(false); hooks.renderGrid();
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
      if (!applied) log(t('parser.dumpInvalid', { line }), 'err');
    }
    return;
  }
  if (line.startsWith('ENC_BEGIN')) {
    setDumpEncInProgress(true);
    const m = line.match(/count=(\d+)/);
    if (m && applyEncCount(parseInt(m[1]), log)) el('deviceEncLabel').textContent = String(NUM_ENCODERS);
    return;
  }
  if (line === 'ENC_END') { setDumpEncInProgress(false); hooks.renderEncoderList(); return; }
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
  // Baris RGB ditangani oleh modul halaman RGB (state-nya dibaca dari device).
  if (handleRgbLine(line, log)) return;
  if (line === 'NAMES_BEGIN') { setNamesInProgress(true); return; }
  if (line === 'NAMES_END') { setNamesInProgress(false); hooks.renderTabs(); return; }
  if (namesInProgress()) {
    // Nama layer boleh mengandung koma, jadi field terakhir adalah sisa baris.
    const idx = line.indexOf(',');
    if (idx > -1) {
      if (!applyName(parseInt(line.substring(0, idx)), line.substring(idx + 1), log))
        log(t('parser.namesInvalid', { line }), 'err');
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
    hooks.renderTabs(); hooks.loadLayer(currentLayer); sendLine('DUMPNAMES');
    return;
  }
  if (line.startsWith('WHOAMI:')) {
    const parts = line.split(':');
    el('deviceNameLabel').textContent = parts[1] || 'MacroPad';
    return;
  }
  if (line === 'PONG') return;   // sembunyikan PONG dari log

  if (line.startsWith('[ERROR]')) log(line, 'err');
  else if (line.startsWith('[OK]')) log(line, 'ok');
  else log(line);
}
// ==================== TRANSPORT BLE ====================
//
// Backend kedua untuk facade transport.js. Memenuhi kontrak yang sama dengan
// serial-transport.js, jadi protocol-parser / adaptive / home-page / tray tidak
// perlu tahu device sedang/templates=BLE atau USB.
//
// Bedanya hanya di lapisan fisik:
//
//  serial            -> plugin SerialPort (port COM)
//  BLE               -> perintah Tauri ble_* (GATT, NUS di ESP32)
//
// Sisanya - framing baris, retry, ping, state framing dump - sengaja
// DITIRU DARI PUNYAI sendirinya, bukan diekspor ulang dari serial-transport.js.
// Kalau satu diimpor dari yang lain, backend BLE tidak akan punya framing saat
// module itu di-tree-shake atau saat serial gagal import, dan duaSalinan logika
// framing bisa mulai berbeda satu sama lain - persis yang terjadi pada versi
// pertama file ini.
//
// Batasan yang harus dijaga (sama seperti serial-transport.js):
//  - Buffer baris berbatas. Device yang tidak pernah mengirim newline akan
//    menumpuk data tanpa henti selama sesi.
//  - Jangan menebak nama field dari invoke(). Perintah ble_scan mengembalikan
//    JSON dengan key snake_case (is_paired, bukan isPaired) - versi pertama
//    file ini memetakan is_paired ke isPaired sehingga pasangan selalu
//    undefined tanpa error apa pun yang terlihat.

import { invoke } from "@tauri-apps/api/core";
import { el, log } from './dom.js';
import { t } from './i18n.js';
import { batchUploadInFlight, resetBatchUploadState, registerOnBatchStart } from './upload-state.js';
import { parseKV, renderDiag, rttSummary, diagHasFailure } from './diag-report.js';
import { feedFrameBytes, resetFrameRx, frameRxStats } from './frame-dispatch.js';

const LAST_DEVICE_KEY = 'macropad.lastBleDevice';
const LINE_BUFFER_MAX = 64 * 1024;
// Jeda PING, dalam dua tingkat.
//
// Nilai lama 1500 ms dipilih tanpa angka yang jelas, dan_short_ebook itu mahal
// dari yang terlihat: tiap PING adalah satu write + satu PONG (write + notify),
// jadi 1500 ms berarti ~80 pasang PING/PONG per 2 menit - traffic tetap yang
//CCEKER memakai link yang sama dengan upload preset. Di link lambat itu bukan
// noise, itu kapasitas yang tersedot.
//
// Yang sebenarnya dijaga PING adalah "link masih hidup", dan dafür supervision
// timeout 10 detik adalah batasnya - bukan 1,5 detik. Jadi:
//
//   PING_MS_IDLE - saat tidak ada yang harus diukur. Masih jauh di bawah
//                  supervision timeout, jadi keepalive tetap terpenuhi.
//   PING_MS_BUSY - sesaat setelah ada aktivitas (setelah device mengirim apa
//                  pun, atau setelah app menulis). Di sini latensi terdekat yang
//                  berguna untuk DIAG, jadi frekuensi dinaikkan.
const PING_MS_IDLE = 5000;
const PING_MS_BUSY = 1500;
// Batas per write. Characteristic NUS hanya 512 byte; menulis lebih dari itu
// di-potong diam-diam oleh stack dan menyisakan separuh baris di device.
const WRITE_CHUNK_MAX = 400;
// Tarikan per panggilan ble_read. Rust clamps ke 1..4096, jadi nilai di sini
// cukup besar untuk membaca buffer 256 KiB dalam beberapa iterasi poll.
const READ_CHUNK_MAX = 4096;

// Seberapa sering buffer BLE ditarik.
//
// PENTING: ini harus jauh lebih cepat dari poll koneksi serial (2 detik).
// Serial menerima byte lewat port.read() yang dipanggil tiap loop - data
// sampai dalam hitungan milidetik. lewat BLE, data mendarat di buffer Rust
// lalu HARUS ditarik; tidak ada yang memanggilnya otomatis. Kalau jeda 2
// detik, satu dump 9 tombol yang dikirim dalam ~100 ms baru selesai dibaca
// 2 detik kemudian, dan jawaban INFO pun telat 2 detik - aplikasi terasa
// macet padahal device sebenarnya sehat.
//
// 40 ms memberi latensi di bawah yang bisa dirasakan manusia (~25 Hz) dengan
// overhead invoke() yang masih ringan (satu round-trip IPC ke thread BLE).
const READ_POLL_MS = 40;

// Batas tunggu sebelum dianggap dump menggantung.
//
// NILAI INI HARUS DIHITUNG DARI LINK, BUKAN DITEBAK.
//
// Nilai lama 2000 ms ditulis dengan asumsi "DUMP untuk 3x3 hanya ~10 baris dan
// dikirim dalam hitungan milidetik". Asumsi itu SALAH pada link lambat: dengan
// rtt p50=377ms, satu DUMP 3x3 beserta DUMPENC adalah puluhan baris, dan tiap
// baris butuh RTT-nya sendiri. Dump yang SEHAT bisa dengan wajar makan 5-8
// detik.
//
// Akibatnya watchdog_ADALAH penyebab error, bukan penolongnya: timerolen
// di tengah dump yang masih berjalan, offended sebagai "DUMP never closed",
// lalu resetParserState() membuang sisa dump yang sedang in-flight. Grid jadi
// stale dan switch berikutnya tertunda - persis gejala yang dilaporkan.
//
// Jadi batasnya harus jauh di atas waktu dump yang SEHAT. 20 detik masih jauh
// lebih cepat dari "user menunggu selamanya", dan cukup menutup link 10x lebih
// lambat dari yang Anda punya.
// Nilai ini `let`, bukan `const`, dan sengaja bisa diubah di bawah.
//
// Test suite perlu menjalankan siklus "dump sehat" vs "dump menggantung" dalam
// waktu yang masuk akal. Dengan batas 20 detik, satu test harus menunggu 20
// detik nyata untuk membuktikan watchdog TIDAK tembak - membuat suite berjalan
// belasan menit. Exports `__setDumpStuckMsForTest` di bawah dipakai hanya oleh
// test; produksi tidak pernah memanggilnya, dan test mengembalikannya ke 20000
// segera setelah dipakai.
let DUMP_STUCK_MS = 20000;
export function __setDumpStuckMsForTest(ms) { DUMP_STUCK_MS = ms; }

// ---- DIAG: laporan lapis (Fase 0) ----
//
// Tujuan: laporan "app connect tapi diam" SELALU bisa menyebut lapis penyebabnya,
// bukan lagi harus menebak (ganti kabel, dekatkan device, ulangi).
//
// Empat lapis, masing-masing punya sumber angka sendiri:
//   L0 RADIO  - latensi PING/PONG, dari app
//   L1 LINK   - counter WinRT (notify/write/overflow), dari Rust lewat ble_stats
//   L3 PROTO  - counter parser baris, dari firmware lewat DIAG
//   L4 DEVICE - counter media NUS (notify gagal, ring buffer), dari firmware
//
// Interval 30 detik. Tidak perlu lebih cepat: yang dicari adalah pola yang
// menetap (ringHigh selalu penuh, drop selalu naik), bukan kejadian sesaat. Dan
// terlalu sering menambah beban pada link yang justru sedang diperiksa.
const DIAG_INTERVAL_MS = 30000;
// Berapa banyak sampel RTT yang disimpan. Cukup untuk membedakan "putus-putus
// sebentar" dari "selalu lambat" tanpa menyimpan riwayat tanpa batas.
const RTT_SAMPLES_MAX = 20;

// Jawaban DIAG terakhir dari firmware. null = belum pernah dapat, dan itu
// sendiri sudah informasi: berarti perintah DIAG tidak sampai atau device
// tidak menjawabnya - bukan berarti DEVICE rusak.
let diagProto = null;
let diagMedia = null;
let diagAt = 0;
// Counter sisi host. null = ble_stats belum pernah dipanggil / tidak
// tersedia (mis. build Rust lama).
let linkStats = null;
let rttSamples = [];
let pingSentAt = 0;
let diagTimer = null;
let diagBusy = false;

// ---- State koneksi ----
let deviceId = null;
let lastGoodDeviceId = null;
try { lastGoodDeviceId = localStorage.getItem(LAST_DEVICE_KEY); } catch (e) { }
let connected = false;
let notifySubscribed = false;  // true setelah read loop pertama sukses
let deviceWasLost = false;
let autoReconnect = true;   // false setelah user menekan Disconnect sendiri
let autoBusy = false;
// Single-flight connect. True selama connect() berjalan. Tanpa ini beberapa
// jalur (klik Connect, scheduleRetry, tryAutoConnect) bisa membuka link BLE
// bersamaan dan saling menabrak. Lihat catatan lengkap di connect().
let connectBusy = false;
let pingTimer = null;
let retryTimer = null;

// ---- State framing (milik backend ini) ----
let lineBuffer = '';
// Penanda terakhir ada byte yang masuk dari device. Dipakai afterConnectHandshake
// untuk membedakan "write gagal" dari "write sukses tapi device diam".
let seenResponseAt = 0;
// Watchdog dump:-armed saat isi dump terlihat, dibatalkan saat DUMP_END/NAMES_END
// datang. Kalau tembak, berarti penutup dump hilang di tengah jalan - dan itu
// kondisi paling damaging karena diam-diam berlaku ke semua baris berikutnya.
let dumpWatchdogTimer = null;

function cancelDumpWatchdog() {
  if (dumpWatchdogTimer) clearTimeout(dumpWatchdogTimer);
  dumpWatchdogTimer = null;
}

function armDumpWatchdog() {
  // Timer di-RESET setiap kali byte dump baru masuk.
  //
  // Versi lama memakai guard `if (dumpWatchdogTimer) return` - satu kali arm,
  // lalu tidak pernah disentuh lagi. Itu membuat watchdog mengukur "waktu
  // sejak dump DIMULAI", bukan "waktu sejak progres TERAKHIR". Pada link lambat
  // dump yang masih SEHAT dan masih mengalir dianggap macet.
  //
  // Yang harus diukur adalah "tidak ada byte baru selama DUMP_STUCK_MS". Kalau
  // byte masih datang, dump itu hidup - jangan dilaporkan rusak. Inilah yang
  // membedakannya dari kondisi yang benar-benar rusak (penutup hilang): di sana
  // byte benar-benar berhenti.
  if (dumpWatchdogTimer) clearTimeout(dumpWatchdogTimer);
  dumpWatchdogTimer = setTimeout(() => {
    dumpWatchdogTimer = null;
    // Pengecualian HARUS diulang di sini, bukan hanya saat arming.
    //
    // Watchdog bisa ter-arm sebelum batch upload dimulai (mis. dump dari
    // handshake masih berjalan). Batch yang menyusul lalu menahan frame, jadi
    // saat timer ini matured device sedang sibuk dan DUMP_END memang belum
    // keluar. Melempar error di titik itu akan melapor frame yang sehat
    // sebagai hilang - persis gejala yang muncul saat user alt+tab cepat
    // antar aplikasi.
    //
    // Perpanjang timer selama batch masih jalan - dump yang dump yang
    // ditunda hanya butuh lebih waktu, bukan perlu diperbaiki.
    if (batchUploadInFlight()) {
      armDumpWatchdog();
      return;
    }
    // Kondisi ini SANGAT sulit ditandai dari log biasa: app connect, GATT
    // sehat, notify jalan - tapi tidak satu baris pun ter-render karena
    // parser menganggap semua respons sebagai isi dump.
    log(t('ble.dumpStuck', { kind: namesInProgress ? 'DUMPNAMES' : 'DUMP' }), 'err');
    // Buka diri supaya baris berikutnya bisa diparse lagi. Tanpa ini parser
    // akan menolak HWINFO/BATT/EVT selamanya sampai app ditutup.
    resetParserState();
    lineBuffer = '';
    hooks.onDumpStuck();
  }, DUMP_STUCK_MS);
}
export let dumpInProgress = false, dumpEncInProgress = false, namesInProgress = false;
// Device yang baru connect boleh mengirim event sisa (EVT:APP:) sebelum user
// sempat conscious. Waited mirror of serial-transport.js.
let suppressEventsUntil = 0;

// Handshake setelah connect belum selesai.
//
// Kenapa perlu: `connected` menjadi true SEBELUM handshake berjalan. Di
// celah itu, poll auto-switch preset di adaptive.js tidak tahu bahwa device
// sedang menerima 7 perintah handshake, dan langsung mengirim upload preset
// lengkap (ratusan perintah SET). Dua hal rusak:
//
//   1. Device menerima dua aliran perintah tumpang tindih. Handshake bisa
//      gagal, dan jawaban DUMP yang menyertainya terpotong.
//   2. Kalau link sedang tidak sehat, write tambahan itu memperparah kondisi
//      - device makin lama tidak menjawab, dan app makin sering reconnect.
//
// Gejala yang dilaporkan: user memindahkan window ke aplikasi lain tepat
// setelah connect, preset switch terpicu, lalu link putus dengan
// "0x800704C7" / "GattCommunicationStatus(1)" berulang.
//
// Berbeda dengan `eventsSuppressed()`: yang ini tidak berbasis waktu, tapi
// berbasis apa yang benar-benar terjadi (jawaban pertama masuk, atau waktu
// habis). Poll auto-switch yang mencoba lagi tiap 1,2 detik akan langsung
// mencoba lagi begitu flag ini turun - tanpa intervensi user.
let handshakeInProgress = false;

export function handshakePending() { return handshakeInProgress; }
export function isNotifySubscribed() { return notifySubscribed; }
export function __setNotifySubscribedForTest(val) { notifySubscribed = val; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Hook ke main.js (dipasang lewat facade transport.js) ----
let hooks = {
  onLine: () => { },
  onConnected: () => { },
  onDisconnected: () => { },
  onDeviceLost: () => { },
  onAutoConnectOk: () => { },
  onAutoConnectFail: () => { },
  onDumpStuck: () => { },
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
  cancelDumpWatchdog();
  // SENGAJA TIDAK mereset flag batch di sini. resetParserState() juga dipanggil
  // dari dalam callback watchdog saat ia memutuskan dump perlu dibuka paksa -
  // dan pada saat itu device mungkin sedang dikejar antrean upload. Mereset
  // flag di sana akan menghapus bukti bahwa device sedang sibuk, sehingga
  // watchdog terus MENYALAKAN dirinya sendiri. Flag batch hanya direset di
  // disconnect(), di mana memang tidak ada lagi yang sedang diunggah.
  //
  // State frame RX TIDAK dikecualikan. Berbeda dengan flag batch di atas, state
  // frame tidak pernah jadi bukti apa pun - kalau perakit masih memegang
  // setengah frame dari sesi lama, frame itu tidak akan pernah selesai dengan
  // benar, dan satu frame utuh bisa hilang karena perakit menghitung byte yang
  // bukan bagiannya.
  resetFrameRx();
}
export function setDumpInProgress(v) { dumpInProgress = v; }
export function setDumpEncInProgress(v) { dumpEncInProgress = v; }
export function setNamesInProgress(v) { namesInProgress = v; }
export function eventsSuppressed() { return Date.now() < suppressEventsUntil; }

// ---- Status ----
export const isConnected = () => connected;
export const isAutoBusy = () => autoBusy;
export const portPath = null;   // tidak ada path; device diidentifikasi lewat id
export function enableAutoReconnect() { autoReconnect = true; }

// Logika laporan dan vonis sengaja TIDAK di file ini.
//
// Seluruhnya ada di src/diag-report.js, yang tidak meng-import apa pun. Satu
// alasan: vonis adalah bagian paling berharga dari fase ini, dan bagian itu
// harus bisa diuji dengan menyuntikkan angka kegagalan lalu memeriksa apakah
// lapis yang disebut benar. Kalau ia tetap di backend, satu-satunya cara
// mengujinya adalah membaca teks secara visual - yaitu persis cara kita
// mendiagnosis masalah selama ini, dengan menebak.
//
// Backend ini hanya satu tugas: mengumpulkan angka, memanggil report, dan mencetak.

// Satu siklus DIAG: minta angka dari firmware dan dari Rust, lalu cetak blok.
//
// `diagBusy` mencegah tumpang tindih. Tanpa itu, interval 30 detik bisa menimpa
// request yang masih berjalan kalau invoke('ble_read') sedang lambat - dan dua
// blok laporan yang saling menimpa membuat angka terlihat tidak konsisten.
async function diagOnce() {
  if (diagBusy || !connected) return;
  diagBusy = true;
  try {
    // Minta angka firmware dulu. Jawaban datang lewat notify, jadi baris
    // DIAG/DIAGMEDIA akan dibaca handleIncomingChunk di bawah.
    await sendLine('DIAG');
    // Counter sisi host - tidak bergantung pada device menjawab. Ini penting:
    // kalau device diam total, angka L1 satu-satunya yang tetap bisa didapat.
    try {
      const s = await invoke('ble_stats');
      if (s) linkStats = s;
    } catch (e) { /* command belum ada di build lama - biarkan null */ }
    // Beri waktu device menjawab dua baris itu sebelum blok dicetak.
    await sleep(400);
    diagAt = Date.now();
    const blok = `=== DIAG ${new Date().toLocaleTimeString()} ===\n` +
      renderDiag(diagProto, diagMedia, linkStats, rttSummary(rttSamples));
    // Dicetak sebagai 'err' kalau ada angka yang jelas menunjukkan kegagalan.
    // Alasannya: panel log dipakai user, dan blok ini harus bisa dicari
    // kemudian dengan mata - bukan jadi satu baris netral di antara ratusan
    // baris lain.
    log(blok, diagHasFailure(diagProto, diagMedia, linkStats) ? 'err' : '');
  } catch (e) {
    log(t('ble.diagError', { err: e }), 'err');
  } finally {
    diagBusy = false;
  }
}

function startDiag() {
  stopDiag();
  // Jeda pertama dibuat lebih lama supaya blok pertama tidak menabrak
  // handshake yang sedang berjalan - handshake itu kondisi paling noisik.
  diagTimer = setInterval(() => { diagOnce(); }, DIAG_INTERVAL_MS);
  setTimeout(() => { diagOnce(); }, DIAG_INTERVAL_MS / 2);
}

function stopDiag() {
  if (diagTimer) clearInterval(diagTimer);
  diagTimer = null;
  diagBusy = false;
  // Angka TIDAK direset di sini. Laporan paling dibutuhkan justru setelah link
  // putus, jadi Reset hanya lewat DIAG:ZERO yang eksplisit.
}

export function handleIncomingChunk(data) {
  lineBuffer += data;
  // Urutan penting: resetParserState() mengosongkan lineBuffer, jadi harus
  // dipanggil SETELAH lastIndexOf - kalau dibalik, nl selalu -1 dan baris utuh
  // terakhir ikut terbuang.
  if (lineBuffer.length > LINE_BUFFER_MAX) {
    log(t('transport.lineTooLong', { max: LINE_BUFFER_MAX }), 'err');
    const nl = lineBuffer.lastIndexOf('\n');
    const tail = nl >= 0 ? lineBuffer.slice(nl + 1) : '';
    resetParserState();
    lineBuffer = tail;
  }
  let idx;
  // Penutup dicek PER BARIS, bukan sekali per chunk lewat indexOf di atas loop.
  //
  // Kalau penutup dicek sebelum loop, urutan jadi salah begitu satu chunk
  // memuat frame utuh: NAMES_BEGIN menyalakan flag, NAMES_END (di chunk yang
  // SAMA) belum terlihat oleh cek, lalu setelah baris-baris diproses flag
  // menyala dan watchdog ter-arm - padahal frame-nya sudah selesai rapi.
  // Hasinya NAMES_END yang sehat dilaporkan sebagai "never closed".
  //
  // Perbaruan dicek setelah hooks.onLine() karena flag baru berubah di sana.
  while ((idx = lineBuffer.indexOf('\n')) >= 0) {
    const line = lineBuffer.slice(0, idx);
    lineBuffer = lineBuffer.slice(idx + 1);

    // ---- Sadarai baris DIAG sebelum masuk parser ----
    //
    // Parser protokol tidak mengenal DIAG:/DIAGMEDIA:. Kalau diteruskan, ia
    // akan memperlakukannya sebagai baris tak dikenal yang berstatus noise
    // di tengah frame dump - justru menciptakan masalah baru pada apa yang
    // seharusnya alat bantu diagnosis.
    if (line.startsWith('DIAGMEDIA:')) {
      diagMedia = parseKV(line.slice('DIAGMEDIA:'.length));
      continue;
    }
    if (line.startsWith('DIAG:')) {
      diagProto = parseKV(line.slice('DIAG:'.length));
      continue;
    }
    // PONG diteruskan ke parser (supaya perilaku keepalive tidak berubah),
    // tapi dicatat lebih dulu untuk menghitung latensi.
    if (line === 'PONG' && pingSentAt) {
      rttSamples.push(Date.now() - pingSentAt);
      if (rttSamples.length > RTT_SAMPLES_MAX) rttSamples.shift();
      pingSentAt = 0;
    }

    hooks.onLine(line);
    if (line === 'DUMP_END' || line === 'ENC_END' || line === 'NAMES_END') {
      cancelDumpWatchdog();
      continue;
    }
    // Buka watchdog kalau isi frame terlihat. Dicek per baris supaya tidak
    // bergantung pada pemenggalan chunk: baris isi bisa terbagi dua chunk,
    // dan pola \d,\d,\d bisa terpotong di tengah.
    //
    // TAPI jangan saat ada batch upload yang sedang jalan. Mengunggah preset
    // = ratusan perintah SET yang device harus proses satu per satu; jawaban
    // DUMP:0 yang menyusul benar-benar tertahan di antrean dan baru keluar
    // belasan detik kemudian pada preset besar. Tanpa pengecualian ini,
    // watchdog menyimpulkan dump hilang padahal device masih sibuk - persis
    // gejala yang muncul saat user alt+tab cepat antar aplikasi.
    if (batchUploadInFlight()) continue;
    if ((dumpInProgress && /\d,\d,\d/.test(line)) ||
        (namesInProgress && line.indexOf(',') > 0)) {
      armDumpWatchdog();
    }
  }
}

// ---- Pengiriman ----
export async function sendRaw(data) {
  if (!connected) return false;
  noteBusy();
  try {
    // Dukung baik string maupun binary (Uint8Array/array of bytes).
    // Frame biner v2 mengirim Uint8Array; perintah teks lama mengirim string.
    if (typeof data === 'string') {
      await invoke('ble_write', { data: Array.from(new TextEncoder().encode(data)) });
    } else {
      await invoke('ble_write', { data: Array.from(data) });
    }
    return true;
  } catch (e) {
    log(t('ble.writeError', { err: e }), 'err');
    await handleDeviceLost();
    return false;
  }
}

// WriteWithoutResponse — untuk CFG_WRITE bulk (Fase 5). Device tidak
// memberi ack per-frame; back-pressure ditangani oleh credit flow control.
// Tanpa path ini, uploadPresetBinary() akan crash dengan TypeError karena
// transport.js facade memanggil backend.sendRawNoAck yang undefined.
//
// PENTING: WriteWithoutResponse di Windows ( WinRT GattWriteOption::
// WriteWithoutResponse) tidak pernah mengembalikan error — ia langsung
// return S_OK ke app meskipun buffer internal Windows penuh. Error
// 0x80650011 (Insufficient Resources) hanya muncul DI SINI, di boundary
// antara WinRT dan driver, ketika GATT send queue overflow. Ini tanda app
// mengirim lebih cepat dari yang device/Windows bisa proses.
//
// Pacing delay antar WriteWithoutResponse. Windows GATT send queue
// bisa menampung ~20 packet sebelum mengembalikan 0x80650011.
//
// Dulu pakai timer statis 10ms. Sekarang pacing dihitung dari RTT yang terukur:
//   pacing = max(5, min(20, RTT / 3))
// Ini memberi 3x safety margin pada setiap side of round-trip. Link cepat
// (rtt~76ms) → pacing~25ms, link lambat (rtt~300ms) → pacing~20ms.
// Nilai 5-20ms clamp mencegah pacing tidak wajar pada link ekstrem.
import { getLastRtt, resetRtt } from './pong-probe.js';

/**
 * Hitung pacing delay adaptif dari RTT terukur.
 * @returns {number} delay dalam ms ( clamped 5-20ms )
 */
function adaptivePacingMs() {
  const rtt = getLastRtt();
  const pacing = Math.max(5, Math.min(20, Math.floor(rtt / 3)));
  return pacing;
}

// NOTE: sendRawNoAck does NOT call noteBusy() intentionally.
// Binary upload traffic is already tracked by beginCfgTransfer/noteCfgCommands.
// Adding noteBusy() here would interfere with adaptive.js's own beginCfgTransfer
// tracking for the text path. The frame transport manages its own pacing.
export async function sendRawNoAck(data) {
  if (!connected) return false;
  // Exponential backoff untuk 0x80650011 (GATT send queue overflow).
  // Delay: 50ms → 100ms → 200ms. Retry sampai 3x, lalu baru tear down.
  const writeRetries = [50, 100, 200];
  try {
    await invoke('ble_write_no_ack', { data: Array.from(data) });
    // Pacing delay adaptif — memberi Windows/GATT stack untuk mengirim
    // sebelum app membanjiri dengan frame berikutnya. Pacing dihitung
    // dari RTT terukur (default 100ms) agar optimal pada semua link.
    if (data.length > 0) await sleep(adaptivePacingMs());
    return true;
  } catch (e) {
    // 0x80650011 (Insufficient Resources) adalah tanda GATT send queue
    // penuh sementara. Coba dengan exponential backoff — ini sering
    // berhasil karena device baru saja memproses packet sebelumnya.
    // Jika semua retry gagal, baru anggap device lost.
    const msg = String(e);
    if (msg.includes('0x80650011') || msg.includes('Insufficient Resources')) {
      for (const delay of writeRetries) {
        await sleep(delay);
        try {
          await invoke('ble_write_no_ack', { data: Array.from(data) });
          if (data.length > 0) await sleep(adaptivePacingMs());
          return true;
        } catch (e2) {
          // Cek lagi — mungkin error yang sama, lanjut retry
          if (!String(e2).includes('0x80650011') && !String(e2).includes('Insufficient Resources')) {
            // Error berbeda — mungkin disconnect, jangan retry lagi
            log(t('ble.writeErrorNoAck', { err: e2 }), 'err');
            await handleDeviceLost();
            return false;
          }
        }
      }
      // Semua retry gagal — anggap GATT queue benar-benar macet
    }
    // Track write errors untuk burst backoff detection.
    readErrorCount++;
    if (readErrorCount > 5) {
      burstBackoffActive = true;
    }
    log(t('ble.writeErrorNoAck', { err: e }), 'err');
    await handleDeviceLost();
    return false;
  }
}

export async function sendLine(str) {
  if (!connected) return;
  // Option A: Subscription guard — jangan kirim command sampai BLE notify
  // benar-benar ter-subscribe. Jika kirim sebelum subscribe, device akan
  // ngirim respon tapi tidak ada subscriber — byte hilang tanpa jejak
  // (noSub counter di DIAG naik). Tunggu maks 1s untuk subscribe aktif.
  if (!notifySubscribed) {
    const t0 = Date.now();
    while (!notifySubscribed && Date.now() - t0 < 1000 && connected) {
      await sleep(5);
    }
    if (!notifySubscribed) {
      log(t('transport.deviceLostLog'), 'warn');
      return;
    }
  }
  try {
    await invoke('ble_write', { data: Array.from(new TextEncoder().encode(str + '\n')) });
  } catch (e) {
    log(t('ble.writeError', { err: e }), 'err');
    // Tulis gagal = koneksi sudah putus; jangan tunggu polling 2 detik.
    await handleDeviceLost();
  }
}

// Kirim banyak baris dalam sedikit write, dipecah agar tidak melewati batas
// characteristic NUS. Versi pertama file ini memanggil writeRaw() dengan
// payload yang sudah dipotong ke 900 byte - angka itu untuk port serial dan
// melewati batas NUS.
export async function sendBatch(lines) {
  if (!connected) return;
  let chunk = '';
  const flush = async () => { if (chunk) { await sendRaw(chunk); chunk = ''; } };
  for (const ln of lines) {
    if (chunk.length + ln.length + 1 > WRITE_CHUNK_MAX) await flush();
    chunk += ln + '\n';
  }
  await flush();
}

// ---- Scan ----
export async function scan() {
  try {
    const devices = await invoke('ble_scan');
    if (!Array.isArray(devices)) return [];
    return devices.map(d => ({
      // snake_case dari Rust - jangan diubah jadi camelCase, ini yang bikin
      // pasangan selalu undefined di versi pertama.
      id: d.id,
      name: d.name || 'MacroPad',
      isPaired: !!d.is_paired,
    }));
  } catch (e) {
    log(t('ble.scanError', { err: e }), 'err');
    return [];
  }
}

export async function scanAndUpdateSelect() {
  const devices = await scan();
  // Log panel app, bukan hanya stderr Rust. User tidak pernah melihat stderr;
  // tanpa baris ini, "scan tidak menemukan apa pun" di panel log sama sekali
  // tidak bisa dibedakan dari "app belum pernah memanggil scan".
  log(devices.length === 0
    ? t('ble.traceNone')
    : t('ble.traceFound', { count: devices.length, names: devices.map(d => d.name).join(', ') }));
  const sel = el('bleDeviceSelect');
  if (!sel) return devices;
  const keep = sel.value;
  sel.innerHTML = '';
  devices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name + (d.isPaired ? ' (paired)' : '');
    sel.appendChild(opt);
  });
  if (keep && devices.some(d => d.id === keep)) sel.value = keep;
  return devices;
}

// ---- Connect / disconnect ----
// Urutan init setelah connect sengaja MENYAMAI serial-transport.js persis:
// WHOAMI/HWINFO dulu (profile + knob + penanda simulasi), LAYER:0 sebelum INFO
// (firmware menyimpan currentLayer di flash, jadi device bisa boot di layer 4 -
// INFO dulu akan sempat memuat layer yang salah), lalu dump encoder, baterai, RGB.
async function afterConnectHandshake() {
  // Tandai handshake berjalan SEBELUM penundaan 400 ms, bukan sesudahnya.
  // Kalau baru ditandai di dalam setTimeout, ada jendela 400 ms di mana
  // connected sudah true tapi handshakeInProgress masih false - dan tepat di
  // jendela itu poll auto-switch preset bisa memicu upload lengkap ke device
  // yang handshake-nya belum selesai.
  handshakeInProgress = true;
  setTimeout(async () => {
    log(t('ble.traceHandshake'));
    await sendLine('WHOAMI');
    await sendLine('HWINFO');
    await sendLine('LAYER:0');
    await sendLine('INFO');
    await sendLine('DUMPENC');
    await sendLine('BATT');
    await sendLine('RGB:DUMP');
    // Batas waktu. Kalau device tidak menjawab dalam 6 detik, tunjukkan di log
    // bahwa write BERHASIL tapi jawabannya tidak pernah datang - itu bukti
    // masalah ada di sisi device/subscribe, bukan di pengiriman perintah.
    const deadline = Date.now() + 6000;
    const before = seenResponseAt;
    const watch = setInterval(() => {
      if (seenResponseAt !== before) { clearInterval(watch); handshakeInProgress = false; return; }
      if (Date.now() < deadline) return;
      clearInterval(watch);
      log(t('ble.traceSilent'), 'err');
      // Device diam. Handshake dianggap gagal supaya auto-switch tidak
      // menumpuk perintah di atas device yang tidak menjawab - itu justru
      // memperpanjang kondisi "tidak menjawab".
      handshakeInProgress = false;
    }, 250);
  }, 400);
}

export async function connect(deviceIdArg) {
  const sel = el('bleDeviceSelect');
  const id = deviceIdArg || (sel ? sel.value : null);
  if (!id) { log(t('ble.pickDevice'), 'err'); return false; }

  // ---- SINGLE-FLIGHT: hanya boleh SATU connect jalan pada satu waktu ----
  //
  // Tanpa guard ini, beberapa jalur bisa memanggil connect() hampir bersamaan:
  // klik tombol Connect, scheduleRetry() dari handleDeviceLost(), dan
  // tryAutoConnect(). Semuanya mengandalkan flag `connected`, tapi flag itu
  // baru berubah di BAWAH await invoke('ble_connect') - jadi selama Windows
  // masihenger handshake, dua atau tiga connect bisa berjalan bareng.
  //
  // Akibatnya yang terlihat di log:
  //   [BLE] Connected to ... waiting for device data
  //   BLE connect failed: ... TX belum terdaftar
  //   [BLE] Connected to ... waiting for device data     <- NYATA lagi
  //   [AUTO] Device disconnected.
  //
  // Tiga link hidup bersamaan. Masing-masing memasang callback notifikasi
  // yang menulis ke buffer bersama, jadi notify bercampur dan device
  // kewalahan menerima. Link yang pertama hilang menghasilkan supervision
  // timeout (0x208) yang atas nama device juga hilang dari daftar Bluetooth
  // Windows.
  //
  // Guard ini menutup sumbernya di sisi app. Timeout radio (0x208) sendiri
  // tetap mungkin terjadi kalau firmware memang menahan loop - itu urusan
  // terpisah dan belum ikut disentuh di commit ini.
  if (connectBusy) {
    // Percobaan yang menabrak guard ini di-drop, bukan di-antre. Menunggu
    // connect yang sedang jalan justru menumpuk antrean saat link sedang
    // bermasalah - justru saat paling perlu tidak menambah beban.
    return false;
  }
  connectBusy = true;

  let ok = false;
  try {
    // Timeout 10 detik. Windows kadang FromIdAsync tidak pernah resolve
    // kalau link sedang di tengah-negosiasi, dan tanpa batas ini guard
    // connectBusy tertahan selamanya sehingga tidak ada yang bisa mencoba
    // lagi sama sekali.
    //
    // invoke() dibungkus jadi Promise dulu. Test suite (dan beberapa jalur
    // kode) membuat invoke() mengembalikan nilai biasa, bukan Promise - kalau
    // langsung .then() di sini, hasilnya TypeError yang tidak menjelaskan
    // apa pun.
    const connectOp = Promise.resolve(invoke('ble_connect', { id }));
    ok = await Promise.race([
      connectOp.then(
        () => true,
        (e) => {
          log(t('ble.connectError', { err: e }), 'err');
          return false;
        },
      ),
      new Promise((r) => setTimeout(() => r(false), 10000)),
    ]);
  } catch (e) {
    // Menangkap apa pun yang lolos dari handler di atas (mis. invoke()
    // melempar sinkron sebelum sempat jadi Promise).
    log(t('ble.connectError', { err: e }), 'err');
    ok = false;
  }

  if (!ok) {
    // Timeout atau error. WAJIB lepaskan link yang mungkin sudah setengah
    // naik di sisi Rust.
    //
    // Kalau connect gagal setelah BluetoothLEDevice berhasil dibuat tapi
    // sebelum characteristic ditemukan, handle-nya tertinggal. Windows
    // kemudian membatalkan operasi pada link yang tertinggal itu
    // (0x800704C7 "canceled by the user") dan mengembalikan cache GATT yang
    // belum lengkap - yang membuat percobaan BERIKUTNYA gagal dengan
    // "TX characteristic not registered" (0x8000000B), dan seterusnya.
    // Satu connect gagal jadi racun semua percobaan setelahnya.
    //
    // Best-effort: error asli sudah dilog, jadi kegagalan di sini tidak
    // boleh menutupi pesan yang lebih berguna.
    try { await invoke('ble_disconnect'); } catch (e2) { /* sudah gagal */ }
    connectBusy = false;
    return false;
  }
  connectBusy = false;
  log(t('ble.traceConnected', { id }));
  connected = true;
  deviceId = id;
  lastGoodDeviceId = id;
  clearTimeout(retryTimer);
  readErrorCount = 0;
  burstBackoffActive = false;
  try { localStorage.setItem(LAST_DEVICE_KEY, id); } catch (e) { }
  hooks.onConnected();
  deviceWasLost = false;
  startPing();
  // DIAG dinyalakan setelah handshake, bukan sebelum: angka pada 400 ms pertama
  // hampir selalu 0 dan hanya menambah satu blok noise di log.
  startDiag();
  // Loop pembacaan harus hidup SEBELUM handshake, bukan sesudahnya. Handshake
  // mengirim WHOAMI dalam 400 ms, dan jawabannya perlu langsung ditarik -
  // kalau loop belum jalan, jawaban itu menunggu sampai poll 2 detik berikutnya.
  startReadLoop();
  // Tampilkan UI utama. Tanpa ini, #app (dan panel log di dalamnya) tetap
  // tersembunyi di mode BLE walau GATT sudah tersambung - user melihat
  // aplikasi yang masih kosong padahal sebenarnya sudah connect.
  setConnected(true);
  suppressEventsUntil = Date.now() + 800;
  await sendLine('PING');
  await afterConnectHandshake();
  return true;
}

export async function disconnect(manual) {
  // Tanpa guard ini, disconnect() yang dipanggil saat device BELUM pernah
  // tersambung tetap menjalankan seluruh ekor: mematikan autoReconnect,
  // mengirim notifikasi "terputus" yang tidak benar, dan memunculkan error
  // "BLE tidak terhubung" yang menyesatkan.
  //
  // Yang memancingnya adalah setTransportBackend() di facade, yang memutus
  // backend LAMA setiap kali selector transport berubah - termasuk saat
  // berubah dari USB ke BLE, di mana BLE memang belum pernah tersambung.
  if (!connected) {
    if (manual) autoReconnect = false;
    return;
  }
  if (manual) {
    autoReconnect = false;
    deviceWasLost = false;
    hooks.notify(t('ble.notifDisconnected'), 'disconnect');
    log(t('ble.autoPausedLog'));
  }
  stopPing();
  // Loop pembacaan WAJIB ikut dimatikan di setiap jalur keluar. Kalau tidak,
  // interval tetap berjalan dan menarik buffer dari koneksi yang sudah tutup -
  // memunculkan "GATT tidak terhubung" berulang padahal user sudah disconnect.
  stopReadLoop();
  stopDiag();
  resetRtt();  // kirim sample RTT ke sesi berikutnya
  // Parser ikut dibersihkan di jalur manual juga: tanpa ini baris parsial dari
  // sesi lama menempel pada byte pertama device berikutnya.
  resetParserState();
  // Disconnect = tidak ada lagi yang sedang diunggah ke device ini.
  resetBatchUploadState();
  // Handshake yang menggantung harus ikut dibuang. Kalau tidak, flag ini tetap
  // true dan auto-switch preset tidak akan pernah jalan lagi di sesi berikutnya
  // - karena tidak ada handshake baru yang akan mengeset's flag ini ke false
  // kalau device tidak pernah connect.
  handshakeInProgress = false;
  try { await invoke('ble_disconnect'); } catch (e) { log(t('ble.disconnectError', { err: e }), 'err'); }
  connected = false;
  notifySubscribed = false;  // reset flag subscribe
  deviceId = null;
  hooks.onDeviceLost();
  setConnected(false);
}

// Device hilang tanpa userDisconnect: bersihkan total lalu coba lagi kalau
// auto-reconnect masih nyala.
export async function handleDeviceLost() {
  if (!connected) return;
  log(t('transport.deviceLostLog'), 'err');
  deviceWasLost = true;
  const wasId = deviceId || lastGoodDeviceId;
  connected = false;
  deviceId = null;
  hooks.notify(t('transport.notifDeviceLost'), 'disconnect');
  hooks.clearDirty();   // RAM device hilang; tidak ada yang tertunda untuk di/save
  resetParserState();
  hooks.onDeviceLost();
  stopPing();
  stopReadLoop();
  stopDiag();
  resetRtt();  // kirim sample RTT ke sesi berikutnya
  notifySubscribed = false;  // reset flag subscribe
  handshakeInProgress = false;
  setConnected(false);

  // Jika ini disebabkan oleh burst error baca (readError > 5 dalam sesi
  // sebelumnya), aktifkan burst backoff dan hard reset adapter pada retry
  // pertama. Ini penting karena Windows BLE stack perlu waktu untuk memulihkan
  // GATT cache yang corrupt setelah burst seperti yang terlihat di log DIAG:
  // "notify gagal 52x setelah semua retry" — ini tanda adapter Windows,
  // bukan masalah parser atau firmware.
  if (readErrorCount > 5) {
    burstBackoffActive = true;
  }
  readErrorCount = 0;

  if (autoReconnect && wasId) scheduleRetry([wasId]);
}

// ---- Auto-connect / retry ----
const RETRY_MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 2500;
const RETRY_MAX_MS = 20000;
const retryDelay = (n) => Math.min(RETRY_BASE_MS * n, RETRY_MAX_MS);

// Hitungan read error berturuh. Setelah burst error baca, adapter
// Windows perlu waktu ekstra untuk pulih — reconnect langsung setelah burst
// sering dapat 0x800704C7 (operation canceled) atau GATT cache corrupt.
// Backoff eksponensial ekstra (max 2x) diterapkan pada attempt pertama setelah
// burst error baca. Ini tidak memengaruhi reconnect normal — hanya saat
// readIncoming() atau poll() gagal berulang kali berturut-turut.
let readErrorCount = 0;
let burstBackoffActive = false;

export function scheduleRetry(only, attempt = 1) {
  clearTimeout(retryTimer);
  if (attempt > RETRY_MAX_ATTEMPTS) {
    burstBackoffActive = false;
    readErrorCount = 0;
    return;
  }
  // Hitung delay. Jika burst backoff aktif (notifyFail > 30 dalam sesi
  // sebelumnya), delay pertama dinaikkan 2x + hard reset adapter.
  const baseDelay = retryDelay(attempt);
  const delay = burstBackoffActive && attempt === 1
    ? Math.min(baseDelay * 2 + 2000, RETRY_MAX_MS)
    : baseDelay;
  retryTimer = setTimeout(async () => {
    if (connected || !autoReconnect) return;
    // Hard reset adapter Windows sebelum reconnect pertama setelah burst.
    // Ini membersihkan GATT cache yang corrupt dan memaksa Windows melepas
    // link yang terjebak di state CLOSING. Tanpa ini, reconnect pertama
    // sering dapat 0x800704C7 atau "service not found" karena cache lama.
    if (burstBackoffActive && attempt === 1) {
      log(t('ble.adapterResetForReconnect'), 'info');
      try { await invoke('ble_reset_adapter'); } catch (e2) { /* best-effort */ }
      // Windows butuh waktu untuk melepas GATT cache setelah reset.
      // 2 detik tidak cukup di semua mesin — beri 3 detik yang aman.
      await sleep(3000);
    }
    const targets = only && only.length ? only : (lastGoodDeviceId ? [lastGoodDeviceId] : null);
    const ok = await tryAutoConnect(false, targets);
    if (!ok) {
      // Jika ini adalah attempt pertama dan masih gagal, perpanjang backoff.
      if (burstBackoffActive && attempt === 1) {
        burstBackoffActive = true; // tetap aktif untuk attempt berikutnya
      }
      scheduleRetry(only, attempt + 1);
    } else {
      burstBackoffActive = false;
      readErrorCount = 0;
    }
  }, delay);
}

export async function tryAutoConnect(verbose, only) {
  if (autoBusy || connected) return false;
  autoBusy = true;
  try {
    const devices = await scan();
    if (devices.length === 0) { if (verbose) log(t('ble.noDevices'), 'err'); return false; }
    let targets = devices;
    if (only && only.length) targets = devices.filter(d => only.includes(d.id));
    if (targets.length === 0) return false;
    // Device terakhir yang berhasil selalu dicoba lebih dulu.
    targets = [...targets].sort((a, b) => (b.id === lastGoodDeviceId) - (a.id === lastGoodDeviceId));

    for (const d of targets) {
      if (await connect(d.id)) {
        log(t('ble.autoConnectOk', { name: d.name }), 'ok');
        hooks.onAutoConnectOk(d.id);
        return true;
      }
      // Jeda sebelum mencoba ulang.
      //
      // 400 ms (nilai lama) tidak cukup untuk Windows melepas link GATT.
      // Percobaan kedua berjalan saat link pertama belum bersih, dan
      // Windows membatalkan operasi dengan 0x800704C7 - yang membuat
      // percobaan berikutnya sees cache GATT tidak lengkap dan gagal dengan
      // "TX characteristic not registered".
      await sleep(1500);
      if (await connect(d.id)) {
        log(t('transport.autoConnectOk2', { path: d.name }), 'ok');
        hooks.onAutoConnectOk(d.id);
        return true;
      }
    }
    if (verbose) { log(t('ble.autoNotFound'), 'err'); hooks.onAutoConnectFail(); }
    return false;
  } finally { autoBusy = false; }
}

export async function autoDetect() {
  autoReconnect = true;
  clearTimeout(retryTimer);
  if (connected) return;
  const ok = await tryAutoConnect(true);
  if (!ok && lastGoodDeviceId) scheduleRetry([lastGoodDeviceId]);
}

// Tarik data dari device. INI WAJIB ADA, bukan opsional.
//
// Data masuk lewat GATT notify: firmware memanggil bleNusRx->notify() ->
// handler di ble.rs menaruhnya di rx_buffer -> frontend WAJIB mengambilnya
// lewat ble_read. Kalau poll() hanya mengecek `ble_is_connected` tanpa menarik
// buffer, notify tetap masuk ke Rust tapi TIDAK PERNAH sampai ke handleLine(),
// dan companion app diam saja: tidak ada INFO, tidak ada preset, tidak ada
// apa pun. Gejalanya persis seperti "tidak menerima apa-apa dari device".
export async function readIncoming() {
  if (!connected) return 0;
  let got = 0;
  try {
    // Baca ulang sampai buffer kosong. Satu panggilan saja akan tertinggal
    // data kalai device mengirim lebih cepat dari satu iterasi poll.
    //
    // Nilai 8 (bukan 4) karena satu DUMP 3x3+encoder pada link lambat bisa
    // muncul sebagai 3-4 notifikasi berturut-turut, dan setiap notifikasi
    // berupa satu invoke() round-trip. Dengan hanya 4 iterasi, satu tick poll
    // (40 ms) tidak cukup untuk menguras semua notifikasi — sisanya
    // ditangkap oleh drainFast(), tapi itu menambah latency satu tick lagi.
    //
    // 8 iterasi = max 32 KB per tick (8 * 4096), masih jauh di bawah batas
    // 256 KB buffer Rust — cukup untuk burst paling ekstrem tanpa menambah
    // jeda berarti. drainFast() tetap menjadi safety net untuk yang masih
    // tersisa.
    for (let i = 0; i < 8; i++) {
      const chunk = await invoke('ble_read', { maxLen: READ_CHUNK_MAX });
      if (!chunk || chunk.length === 0) break;
      // Tandai bahwa device MEMANG menjawab. afterConnectHandshake memakai
      // penanda ini untuk membedakan "write gagal" dari "write sukses tapi
      // device diam" - dua masalah yang sama sekali punya tindakan berbeda.
      seenResponseAt = Date.now();
      noteBusy();
      // Byte mentah dipakai untuk frame RX, dan byte yang sama didekode ulang
      // untuk parser baris.
      //
      // PENTING: keduanya harus dapat byte yang sama. Versi pertama memberi
      // raw bytes ke frame handler lalu langsung melompat ke frameHandler(bytes)
      // dengan DALAM if - parser baris dilewati, dan event real-time yang tetap
      // keluar sebagai teks di mode frame ikut hilang. Device terbukti mengirim
      // EVT:LAYER:0 sebagai teks tepat setelah CFG_ACTIVATE, jadi itu bukan
      // kasus yang boleh diabaikan.
      const bytes = Uint8Array.from(chunk);
      feedFrameBytes(bytes);
      handleIncomingChunk(new TextDecoder().decode(bytes));
      got += chunk.length;
    }
  } catch (e) {
    // invoke gagal = GATT sudah turun. Perlakukan sebagai putus supaya
    // poll berikutnya tidak mencoba menarik data dari koneksi mati.
    readErrorCount++;
    // Burst error baca (>5 dalam sesi sebelumnya) -> butuh backoff ekstra
    // saat reconnect karena Windows BLE stack perlu waktu untuk pulih.
    if (readErrorCount > 5) {
      burstBackoffActive = true;
    }
    log(t('ble.readError', { err: e }), 'err');
    await handleDeviceLost();
  }
  return got;
}

// Pantau status koneksi dari sisi Rust. Device bisa hilang tanpa memberi tahu
// (jarak, device mati), jadi harus dicek berkala seperti port serial.
export async function poll() {
  if (!connected) return;
  try {
    const stillUp = await invoke('ble_is_connected');
    if (!stillUp) { await handleDeviceLost(); return; }
    await readIncoming();
  } catch (e) {
    log(t('ble.pollError', { err: e }), 'err');
    await handleDeviceLost();
  }
}

// ---- Ping ----
// Saat link terakhir terlihat sibuk, PING lebih sering selama 6 detik.
let pingBusyUntil = 0;
const PING_BUSY_LINGER_MS = 6000;

/** Tandai link sedang sibuk supaya PING berikutnya datang lebih cepat. */
export function noteBusy() { pingBusyUntil = Date.now() + PING_BUSY_LINGER_MS; }

export function startPing() {
  stopPing();
  const tick = () => {
    if (!connected) return;
    // Jeda PING lebih lama saat batch upload berlangsung.
    //
    // CFG_WRITE memakai WriteWithoutResponse — setiap PING write kompetisi
    // dengan frame CFG_WRITE untuk bandwidth GATT yang sama. Pada link lambat
    // (rtt p50=237ms) ini bisa menambah 1-2 round-trip per burst notify,
    // yang cukup untuk memicu supervision timeout (0x208) pada preset
    // besar yang sudah memakan puluhan frame.
    //
    // Saat batch aktif, PING diperlangka agar device fokus pada pemrosesan
    // perintah. Batch saja yang menentukan — jika tidak aktif, PING idle
    // kembali berjalan normal. Jeda ini tidak memengaruhi kegagalan link:
    // supervision timeout device adalah 10 detik (di-etch), jauh di atas
    // PING_MS_IDLE (5 detet), jadi satu-satu lagi 5 detik tidak masalah.
    const batchActive = batchUploadInFlight();
    const interval = batchActive
      ? PING_MS_IDLE   // 5s: cukup untuk keepalive, tidak kompetisi dengan upload
      : (Date.now() < pingBusyUntil ? PING_MS_BUSY : PING_MS_IDLE);
    pingSentAt = Date.now();
    sendLine('PING');
    pingTimer = setTimeout(tick, interval);
  };
  pingTimer = setTimeout(tick, PING_MS_IDLE);
}

// ---- Loop pembacaan ----
// Terpisah dari poll() yang hanya dicek tiap 2 detik: poll itu untuk
// MEMANTAUK koneksi, sedangkan ini untuk MENARIK DATA. Menitipkan pembacaan
// ke poll() membuat seluruh UI berjalan dalam kelipatan 2 detik.
let readTimer = null;
let readBusy = false;

function startReadLoop() {
  stopReadLoop();
  readTimer = setInterval(async () => {
    // readBusy mencegah tumpang tindih: poll 40 ms lebih cepat daripada
    // respons invoke, jadi tanpa ini beberapa read bisa jalan bersamaan dan
    // merebut buffer satu sama lain (data hilang tanpa jejak).
    if (readBusy || !connected) return;
    readBusy = true;
    try {
      const got = await readIncoming();
      // Set flag subscribe setelah read loop pertama sukses. Ini membuktikan
      // BLE notify sudah ter-subscribe dan perintah berikutnya aman dikirim.
      if (!notifySubscribed) notifySubscribed = true;
      // LANJUTKAN LANGSUNG kalau masih ada data.
      //
      // Ini yang menutup 668 notifikasi hilang yang terlihat di DIAG
      // (L4 notifyOk=774 tapi L1 notify=106). Device mengirim DUMP 3x3 +
      // DUMPENC sebagai puluhan notifikasi dalam hitungan milidetik, dan
      // buffer host tidak sempat dikuras dalam satu tick 40 ms - karena
      // readIncoming() sendiri butuh 4 invoke() berurutan.
      //
      // Selama readIncoming() masih mengembalikan byte, interval 40 ms adalah
      // jeda PURE yang tidak menambah apa pun: device sudah selesai, tapi kita
      // menunggu giliran tick berikutnya untuk membaca sisa buffer. Pada link
      // lambat itu cukup untuk buffer NimBLE di sisi device meluap, dan notifi-
      // kasi berikutnya hilang tanpa jejak - termasuk DUMP_END.
      //
      // Drain berulang hanya terjadi selama data masih ada, jadi tidak ada
      // busy-loop kalau device diam: begitu dapat 0 byte, kita kembali ke
      // ritme 40 ms seperti biasa.
      if (got > 0) drainFast();
    }
    finally { readBusy = false; }
  }, READ_POLL_MS);
}

// Drain cepat: baca terus sampai buffer kosong, tanpa menunggu tick interval.
let drainScheduled = false;
function drainFast() {
  if (drainScheduled || !connected) return;
  drainScheduled = true;
  queueMicrotask(async () => {
    // Reset drainScheduled hanya setelah yakin tidak ada drain paralel lain.
    // Jika interval tick sedang berjalan (readBusy = true), biarkan flag tetap
    // true supaya interval tidak merancak drainFast() lagi. Flag akan direset
    // di finally{} di akhir masing-masing drain, memastikan selalu ada drain
    // yang benar-benar berjalan ketika flag false.
    if (readBusy || !connected) return;
    drainScheduled = false;
    readBusy = true;
    try {
      let guard = 0;
      let got = await readIncoming();
      // Batas atas supaya tidak pernah jadi loop tak terbatas kalau device
      // mengirim tanpa henti. Setelah 32 iterasi (~128 KB) selesai, sisanya
      // diserahkan ke ritme interval.
      while (got > 0 && connected && guard++ < 32) {
        got = await readIncoming();
      }
    }
    catch (e) { /* readIncoming sudah menangani */ }
    finally { readBusy = false; drainScheduled = false; }
  });
}

function stopReadLoop() {
  if (readTimer) clearInterval(readTimer);
  readTimer = null;
}

// Batch upload baru dimulai: watchdog yang sudah ter-arm tidak relevan lagi.
// Device akan sibuk memproses antrean, jadi "DUMP_END belum keluar" itu
// wajar, bukan tanda frame hilang.
registerOnBatchStart(() => { cancelDumpWatchdog(); });

// Ekspor untuk test; dipakai juga oleh disconnect().
export function stopAllBleTimers() { stopPing(); stopReadLoop(); stopDiag(); }
// clearTimeout dipakai karena pingTimer dischedule dengan setTimeout (interval
// ping berubah-ubah antara idle dan busy). clearInterval bekerja pada timeout juga
// di browser, tapi menyebut yang benar membuat niatnya jelas.
export function stopPing() { if (pingTimer) clearTimeout(pingTimer); pingTimer = null; }

// Ekspor untuk test dan untuk alat diagnosa on-device (tools/ble-diag.js):
// membaca laporan terakhir tanpa perlu menunggu interval 30 detik.
export function diagSnapshot() {
  return { proto: diagProto, media: diagMedia, link: linkStats, rtt: rttSummary(), at: diagAt };
}
export function diagReport() {
  return renderDiag(diagProto, diagMedia, linkStats, rttSummary(rttSamples));
}

// ---- UI ----
export function updateConnectButton(state) {
  const btn = el('btnConnect');
  if (btn) btn.textContent = state ? t('transport.disconnect') : t('header.connect');
}

// Perbarui indikator di header DAN tampilkan UI utama.
//
// WAJIB ada di backend BLE, bukan hanya di serial-transport.js. #app (seluruh
// halaman aplikasi DAN panel log) disembunyikan lewat style.display, dan
// selama ini HANYA setConnected() di serial yang pernah mengubahnya. Backend
// BLE tidak pernah memanggilnya, jadi di mode BLE UI utama - termasuk panel
// log - tidak pernah muncul sama sekali. Akibatnya user tidak bisa melihat
// apa pun yang terjadi dan harus pindah ke USB untuk membaca log, padahal
// masalahnya justru sedang terjadi di BLE.
export function setConnected(state) {
  const dot = el('dot');
  if (dot) dot.classList.toggle('on', state);
  const st = el('statusText');
  if (st) st.textContent = state ? t('transport.connected') : t('transport.notConnected');
  updateConnectButton(state);
  const app = el('app');
  if (app) app.style.display = state ? 'block' : 'none';
  if (!state) hooks.onDisconnected();
}

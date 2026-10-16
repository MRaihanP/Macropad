// Test Fase 0: laporan berlapis harus BENAR-BENAR menyebut lapis yang salah.
//
// Ini BUKAN test yang membaca sumber untuk mencari string. Ini test yang
// Ini test yang menyuntikkan angka kegagalan ke modul laporan lalu memeriksa
// vonisnya. Satu-satunya alasan tes ini ada: supaya "tidak ada alarm" menjadi
// bukti, bukan ketiadaan data.
//
// Yang diuji di sini:
//   1. src/diag-report.js  - logika vonis (murni, tanpa Tauri/DOM)
//   2. firmware + Rust     - kontraknya: counter yang dihitung benar-benar ada
//                            dan tidak ada lagi pembuangan data diam-diam
//
// Jalankan: node tests/suites/diag-report-test.mjs
import fs from 'node:fs';
import { diagVerdict, renderDiag, parseKV, num, rttSummary, diagHasFailure } from '../../src/diag-report.js';

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };

// Angka firmware dalam bentuk mentah, persis yang dicetak diag.h / transport_ble.h.
const PROTO_BAJAH = 'lines=42,cmds=42,tooLong=0,unknown=0,diagServed=1,lastCmd=PING,transport=nus,heap=112480';
const MEDIA_BAJAH = 'notifyOk=812,notifyFail=0,notifyChunks=900,notifyRetries=0,ringDropped=0,' +
  'ringHigh=180,ringSize=2048,mtu=247,sub=1,noConn=0,noSub=0';
// Sisi host (ble_stats): semuanya 0 = belum ada masalah.
const LINK_BAJAH = {
  notify_events: 812, notify_bytes: 20480, rx_dropped_bytes: 0, rx_overflow_events: 0,
  read_calls: 500, read_bytes: 20480, write_calls: 900, write_bytes: 36000,
  write_errors: 0, connect_count: 1, disconnect_count: 0, notify_while_buffered: 0,
  overflow_logged: false,
};
const proto = (s = PROTO_BAJAH) => parseKV(s);
const media = (s = MEDIA_BAJAH) => parseKV(s);
const link = (o = {}) => ({ ...LINK_BAJAH, ...o });

console.log('--- 1. Kondisi SEHAT harus dilaporkan sebagai OK ---');
{
  const v = diagVerdict(proto(), media(), link());
  ok(v.startsWith('OK'), `vonis sehat = OK (dapat: "${v}")`);
  ok(!diagHasFailure(proto(), media(), link()), 'tidak ditandai sebagai kegagalan');
}

console.log('\n--- 2. Setiap kegagalan nyata HARUS menyebut lapis yang benar ---');
// Tiap kasus = satu kegagalan nyata yang dulu hanya muncul sebagai "diam".
// expectations ditulis lebih dulu; vonis diuji lalu dicocokkan. Kalau ada
// kondisi baru yang tidak ada di sini, test ini tidak akan mengetahuinya -
// makanya daftar kasusnya harus tumbuh setiap kali kasus baru ditambahkan.
const KASUS = [
  {
    nama: 'app belum subscribe notify',
    proto: proto('lines=0,cmds=0,tooLong=0,unknown=0,transport=nus,lastCmd=,heap=110000'),
    media: media('notifyOk=0,notifyFail=0,ringDropped=0,ringHigh=0,ringSize=2048,mtu=247,sub=0,noConn=0,noSub=14'),
    link: link({ write_calls: 14 }),
    harus: 'subscribe notify',
    lapis: 'L1/L4',
  },
  {
    nama: 'app berhenti menarik buffer (data hilang di host)',
    proto: proto(),
    media: media(),
    link: link({ rx_dropped_bytes: 20480, rx_overflow_events: 2 }),
    harus: 'byte hilang karena app tidak menarik', // angka yang hilang + penyebabnya
    lapis: 'L1',
  },
  {
    nama: 'antrean menumpuk di dalam device',
    proto: proto('lines=12,cmds=400,tooLong=0,unknown=0,transport=nus,lastCmd=SET,heap=90000'),
    media: media('notifyOk=300,notifyFail=0,notifyChunks=310,notifyRetries=0,ringDropped=2048,' +
      'ringHigh=2047,ringSize=2048,mtu=247,sub=1,noConn=0,noSub=0'),
    link: link(),
    harus: 'antrean menumpuk di device',
    lapis: 'L4',
  },
  {
    nama: 'ring buffer hampir penuh tanpa drop (ambang 90%)',
    proto: proto(),
    media: media('notifyOk=10,notifyFail=0,ringDropped=0,ringHigh=1900,ringSize=2048,mtu=247,sub=1,noConn=0,noSub=0'),
    link: link(),
    harus: 'antrean menumpuk di device',
    lapis: 'L4',
  },
  {
    nama: 'notify ditolak (masalah radio/host)',
    proto: proto(),
    media: media('notifyOk=700,notifyFail=3,notifyChunks=703,notifyRetries=12,ringDropped=0,' +
      'ringHigh=90,ringSize=2048,mtu=247,sub=1,noConn=0,noSub=0'),
    link: link(),
    harus: 'notify gagal',
    lapis: 'L0',
  },
  {
    nama: 'write ditolak GATT',
    proto: proto('lines=0,cmds=0,tooLong=0,unknown=0,transport=nus,lastCmd=,heap=110000'),
    media: media(),
    link: link({ write_errors: 7 }),
    harus: 'ditolak GATT',
    lapis: 'L1',
  },
  {
    nama: 'baris melebihi batas firmware',
    proto: proto('lines=20,cmds=20,tooLong=3,unknown=0,transport=nus,lastCmd=SET,heap=100000'),
    media: media(),
    link: link(),
    harus: 'melebihi batas firmware',
    lapis: 'L3',
  },
  {
    nama: 'perintah tidak dikenali firmware',
    proto: proto('lines=20,cmds=20,tooLong=0,unknown=5,transport=nus,lastCmd=SET2,heap=100000'),
    media: media(),
    link: link(),
    harus: 'tidak dikenali firmware',
    lapis: 'L3',
  },
  {
    nama: 'tidak ada perintah yang sama sekali dikirim',
    proto: proto('lines=0,cmds=0,tooLong=0,unknown=0,transport=nus,lastCmd=,heap=110000'),
    media: media(),
    link: link({ write_calls: 0 }),
    harus: 'Tidak ada perintah',
    lapis: null,
  },
  {
    nama: 'data berhenti di tengah link (tulis tapi tak sampai)',
    proto: proto('lines=0,cmds=0,tooLong=0,unknown=0,transport=nus,lastCmd=,heap=110000'),
    media: media(),
    link: link({ write_calls: 300 }),
    harus: 'firmware mencatat 0 perintah',
    lapis: 'L1',
  },
];
for (const k of KASUS) {
  const v = diagVerdict(k.proto, k.media, k.link);
  ok(v.includes(k.harus), `"${k.nama}" -> menyebut penyebab yang benar`);
  if (k.lapis) ok(v.startsWith(k.lapis), `"${k.nama}" -> menyebut lapis ${k.lapis}`);
  ok(diagHasFailure(k.proto, k.media, k.link), `"${k.nama}" -> ditandai sebagai kegagalan`);
}

console.log('\n--- 3. Prioritas vonis: yang paling bisa ditindak Institutional mendahului ---');
{
  // noSub DAN ringDropped sama-sama menyala. noSub lebih spesifik dan lebih
  // murah diperbaiki, jadi harus menang.
  const v = diagVerdict(
    proto('lines=0,cmds=0,tooLong=0,unknown=0,transport=nus,lastCmd=,heap=100000'),
    media('notifyOk=0,notifyFail=0,ringDropped=2048,ringHigh=2048,ringSize=2048,mtu=247,sub=0,noConn=0,noSub=9'),
    link({ rx_dropped_bytes: 512, write_errors: 2 }),
  );
  ok(v.includes('subscribe notify'), 'noSub menang atas overflow/notify/write (paling bisa ditindak)');
}

console.log('\n--- 4. Data kosong harus berbeda dari data sehat ---');
{
  ok(diagVerdict(null, null, null).includes('BELUM ADA DATA'), 'tidak ada data ->egtuman "belum ada data"');
  ok(!diagHasFailure(null, null, null), 'tidak ada data bukan berarti kegagalan');
}

console.log('\n--- 5. Parser KEY=VALUE tahan pada kasus tepi nyata ---');
{
  ok(parseKV('lastCmd=,transport=nus').lastCmd === '', 'nilai kosong dipertahankan sebagai string kosong');
  ok(Object.keys(parseKV('')).length === 0, 'baris kosong -> objek kosong, tidak error');
  ok(parseKV('a=1,,b=2').a === '1' && parseKV('a=1,,b=2').b === '2', 'segmen kosong dilewati');
  ok(num({}, 'tidakAda') === 0, 'key hilang -> 0, bukan NaN');
  ok(num({ x: 'bukan-angka' }, 'x') === 0, 'nilai bukan angka -> 0');
  ok(num({ x: '42' }, 'x') === 42, 'angka dibaca sebagai integer');
  const p = parseKV(PROTO_BAJAH);
  ok(p.lastCmd === 'PING' && p.transport === 'nus', 'baris DIAG asli firmware terurai benar');
  const m = parseKV(MEDIA_BAJAH);
  ok(m.ringHigh === '180' && m.ringSize === '2048', 'baris DIAGMEDIA asli firmware terurai benar');
}

console.log('\n--- 6. Ringkasan latensi: bukan mean, tapi p50/p95 ---');
{
  ok(rttSummary([]) === null, 'tanpa sampel -> null (bukan angka palsu)');
  const r = rttSummary([10, 10, 10, 10, 5000]);
  ok(r.p50 === 10, `p50 tahan terhadap satu timeout besar (dapat ${r.p50})`);
  ok(r.max === 5000, 'max tetap melaporkan timeout itu ada');
  ok(r.n === 5, 'jumlah sampel tercatat');
}

console.log('\n--- 7. Blok laporan memuat keempat lapis, bahkan saat sebagian kosong ---');
{
  const teks = renderDiag(proto(), media(), link(), rttSummary([12, 14, 11]));
  for (const lapis of ['L0 RADIO', 'L1 LINK', 'L3 PROTO', 'L4 DEVICE', 'VERDICT:']) {
    ok(teks.includes(lapis), `blok memuat baris "${lapis}"`);
  }
  const kosong = renderDiag(null, null, null, null);
  ok(kosong.includes('VERDICT:'), 'blok tetap punya vonis walau semua sumber kosong');
  ok(kosong.includes('tidak tersedia') || kosong.includes('tidak ada jawaban'),
    'lapis yang tidak melapor dinyatakan eksplisit, bukan disembunyikan');
}

// ---------------------------------------------------------------------------
// Kontrak dengan firmware dan Rust. Bagian ini memeriksa sumber, bukan
// perilaku, karena satu-satunya cara memastikan counter benar-benar DIHITUNG
// (bukan hanya ada) adalah dengan membaca tempat hitungannya.
// ---------------------------------------------------------------------------
const src = (p) => fs.readFileSync(p, 'utf8');

// Buang komentar sebelum memeriksa bentuk kode. Tanpa ini, test yang
// mencari "delay(" di transport_usb.h akan tetap hijau karena delay itu hanya
// disebut di komentar penjelasan - persis kelas bug yang test ini mau cegah.
const kode = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const shared = src('firmware/common/ble_shared.h');
const tble = src('firmware/common/transport_ble.h');
const usb = src('firmware/common/transport_usb.h');
const core = src('firmware/common/macropad_core.h');
const diagh = src('firmware/common/diag.h');
const rustBle = src('src-tauri/src/ble.rs');
const rustLib = src('src-tauri/src/lib.rs');
const js = src('src/ble-transport.js');

console.log('\n--- 8. Firmware: tidak boleh ada data yang hilang tanpa jejak ---');
{
  // Ini regresi dari perilaku lama: `if (next == bleNusTail) break;`
  //
  // Dicek pada BUKAN kode, bukan komentar: komentar lama menyebut bentuk itu
  // secara verbatim, dan tes yang hanya mencari "break;" akan gagal selamanya
  // walaupun kodenya sudah benar.
  ok(/if \(next == bleNusTail\) \{ dropped\+\+; continue; \}/.test(shared),
    'push menghitung byte yang dibuang alih-alih break diam-diam');
  ok(/bleNusPushDropped/.test(shared), 'ada counter byte yang dibuang');
  ok(/dropped\+\+/.test(shared), 'byte yang dibuang benar-benar dihitung');
  ok(/bleNusRingHigh/.test(shared), 'ada tinggi air ring buffer');
  ok(/bleNusWriteNoSub/.test(shared), 'ada counter write tanpa subscriber notify');
  ok(/bleNusWriteNoConn/.test(shared), 'ada counter write tanpa koneksi');
  ok(/bleNusMtu\(\)/.test(shared) && /inline uint16_t bleNusMtu\(\)/.test(src('firmware/common/ble_hid.h')),
    'MTU yang dilapor ke DIAG dibaca yang terbaru, bukan nilai lama');

  // Counter notify ditulis lewat naikkan() sejak warning -Wvolatile membuat
  // `x++` pada tipe volatile jadi error kompilasi. Regex ini tidak boleh
  // menyusut jadi "belum naikkan" saja - yang diuji adalah bahwa counter
  // COUNTER itu masih benar-benar dihitung; helper-nya hanya mengganti CARA
  // menulis increment, bukan menghilangkannya.
  ok(/bleNusNotifyFail/.test(tble) && /naikkan\(bleNusNotifyFail\)/.test(tble),
    'notify gagal setelah semua retry dihitung');
  ok(/bleNusNotifyOk/.test(tble) && /naikkan\(bleNusNotifyOk\)/.test(tble),
    'notify berhasil dihitung');
  ok(/bleNusNotifyChunk/.test(tble) && /naikkan\(bleNusNotifyChunk\)/.test(tble),
    'total chunk notify dicoba dihitung');
  ok(/bleNusNotifyRetry/.test(tble) && /naikkan\(bleNusNotifyRetry\)/.test(tble),
    'percobaan ulang dihitung');
  ok(/bleNusPushDropped/.test(shared) && /naikkan\(bleNusPushDropped/.test(shared),
    'byte yang tidak masuk ring dihitung');
  ok(/PROTO_DIAG_MEDIA\(\)\s+protoDiagMedia\(\)/.test(tble), 'media NUS hooked ke laporan DIAG');
}

console.log('\n--- 9. Firmware: perintah DIAG menjawab lewat transport aktif ---');
{
  ok(/cmd == "DIAG"/.test(diagh), 'ada perintah DIAG');
  ok(/SERIAL->printf\("DIAG:/.test(diagh), 'DIAG membalas lewat SERIAL (= g_transport), bukan LOGS');
  ok(/DIAGMEDIA:/.test(tble), 'baris media memakai awalan DIAGMEDIA (terpisah dari DIAG)');
  ok(/cmd == "DIAG:ZERO"/.test(diagh), 'ada DIAG:ZERO untuk mengulang pengukuran bersih');
  ok(/protoDiagCommand\(cmd\)/.test(core), 'core meneruskan perintah ke penangan DIAG');
  // DIAG harus dicek SEBELUM PROFILE_TRY_COMMAND: kalau tidak, profil tanpa
  // BLE (mis. FINAL) tidak punya DIAG sama sekali - persis device yang paling
  // perlu diperiksa.
  const posDiag = core.indexOf('protoDiagCommand(cmd)');
  const posProfil = core.indexOf('PROFILE_TRY_COMMAND(cmd)');
  ok(posDiag > 0 && posDiag < posProfil, 'DIAG dicek sebelum titik ekstensi profil');
  ok(/protoLinesParsed\+\+/.test(core), 'baris yang diparse dihitung');
  ok(/protoLineTooLong\+\+/.test(core), 'baris terlalu panjang dihitung');
  ok(/protoUnknownCmd\+\+/.test(core), 'perintah tak dikenal dihitung');
  ok(/protoCmdsTotal\+\+/.test(core), 'perintah masuk dihitung');
  ok(/protoLastCmd/.test(core), 'perintah terakhir yang sampai dicatat');
}

console.log('\n--- 10. Rust: overflow dilaporkan, bukan dibuang diam-diam ---');
{
  ok(/pub rx_dropped_bytes: u64/.test(rustBle), 'ada counter byte yang hilang');
  ok(/st\.rx_dropped_bytes \+= dropped/.test(rustBle), 'Rust: byte yang dibuang benar-benar dihitung');
  ok(/RX_BUFFER_MAX \/ 2/.test(rustBle), 'notify saat antrean panjang ditandai terpisah');
  ok(/pub fn stats\(&self\)/.test(rustBle), 'snapshot statistik bisa diambil kapan saja');
  ok(/async fn ble_stats\(\) -> BleStats/.test(rustLib), 'command ble_stats ada');
  ok(/^\s*ble_stats,$/m.test(rustLib), 'ble_stats terdaftar di invoke_handler');
  ok(/BleRequest::Stats/.test(rustLib), 'ble_stats lewat thread worker yang sama');
}

console.log('\n--- 11. Frontend: DIAG benar-benar dipanggil dan dibaca ---');
{
  ok(/invoke\('ble_stats'\)/.test(js), 'backend memanggil ble_stats');
  ok(/sendLine\('DIAG'\)/.test(js), 'backend mengirim perintah DIAG ke firmware');
  ok(/startsWith\('DIAGMEDIA:'\)/.test(js), 'baris DIAGMEDIA dibaca sebelum masuk parser');
  ok(/startsWith\('DIAG:'\)/.test(js), 'baris DIAG dibaca sebelum masuk parser');
  ok(/startDiag\(\)/.test(js), 'loop DIAG dinyalakan');
  ok(/stopDiag\(\)/.test(js), 'loop DIAG dimatikan');
  // Kalau DIAG tidak dimatikan di jalur keluar, blok laporan tetap menagih
  // invoke pada koneksi yang sudah tutup - persis gejala "GATT tidak
  // terhubung" berulang yang dulu membingungkan.
  const disconnectBody = js.slice(js.indexOf('export async function disconnect('));
  ok(disconnectBody.slice(0, 3000).includes('stopDiag()'),
    'loop DIAG ikut mati di jalur disconnect');
  ok(/pingSentAt = Date.now\(\)/.test(js), 'waktu kirim PING dicatat untuk latensi');
  ok(/rttSamples\.push/.test(js), 'PONG dipakai untuk menghitung latensi');
  // Baris DIAG tidak boleh diteruskan ke parser protokol: parser tidak
  // mengenalnya dan akan memperlakukannya sebagai noise di tengah frame dump.
  const chunk = js.slice(js.indexOf('export function handleIncomingChunk'));
  const posDiag = chunk.indexOf("startsWith('DIAG:')");
  const posHook = chunk.indexOf('hooks.onLine(line)');
  ok(posDiag > 0 && posHook > posDiag, 'baris DIAG disaring sebelum hooks.onLine()');
}

console.log('\n--- 12. Modul laporan benar-benar murni (bisa diuji tanpa Tauri) ---');
{
  const rep = src('src/diag-report.js');
  ok(!/^import /m.test(rep), 'diag-report.js tidak meng-import apa pun');
  ok(!/tauri|invoke|document/.test(rep), 'diag-report.js tidak menyentuh Tauri atau DOM');
  ok(/export function diagVerdict/.test(rep), 'diagVerdict diekspor untuk test');
}

console.log('\n--- 13. Banner boot tidak boleh hilang saat Serial Monitor dibuka terlambat ---');
{
  // Gejala yang dilaporkan: baris setup terpotong, lalu output baru muncul
  // beberapa saat setelah boot. Penyebabnya urutan waktu USB CDC, bukan bug
  // protokol - tapi perbaikannya mudah dipatahkan lagi tanpa test.
  ok(/printBootBanner\(\)/.test(core), 'ada fungsi pencetak banner');
  ok(/serviceBootBanner\(\)/.test(core), 'banner diulang saat host terhubung');

  // Jeda CDC harus SESUDAH USB.begin(). Kalau dikembalikan ke dalam
  // UsbTransport::begin(), jeda itu berjalan sebelum USB stack siap sehingga
  // tidak menunggu apa pun - persis bug yang baru diperbaiki.
  ok(!/delay\(/.test(kode(usb)),
    'UsbTransport::begin() tidak lagi menunggu (jeda dipindah ke setup)');
  const coreKode = kode(core);
  const usbBeginPos = coreKode.indexOf('USB.begin()');
  const delayPos = coreKode.indexOf('delay(300)');
  ok(usbBeginPos > 0 && delayPos > usbBeginPos,
    'jeda CDC ada SESUDAH USB.begin(), bukan sebelumnya');

  // Banner harus dicetak ulang tepat saat host terdeteksi tersambung.
  const svc = coreKode.slice(coreKode.indexOf('void serviceBootBanner()'));
  ok(/if \(bootBannerArmed \|\| !LOGS->isConnected\(\)\) return;/.test(svc),
    'ulangannya hanya jalan saat host benar-benar terhubung');
  ok(/bootBannerArmed = true;/.test(svc), 'flag ditandai supaya tidak mengulang endlessly');

  // serviceBootBanner() harus yang pertama di loop(), sebelum langkah lain -
  // kalau tidak, boot yang lambat tetap bisa menunda banner sampai selesai.
  const loopBody = coreKode.slice(coreKode.indexOf('void loop()'));
  ok(loopBody.indexOf('serviceBootBanner();') < loopBody.indexOf('scanMatrix();'),
    'serviceBootBanner() dijalankan paling awal di loop()');
}

console.log(`\n${fail === 0 ? 'SEMUA OK' : fail + ' ASSERTION GAGAL'}: laporan berlapis menguji dirinya sendiri`);
process.exit(fail ? 1 : 0);

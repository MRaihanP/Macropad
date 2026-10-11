// Menguji strengthening retry/reconnect (Phase 10 B).
//
// Bug yang ditutup: scheduleRetry() maksimal 2x percobaan lalu menyerah
// PERMANEN, dan pollPorts() hanya probe saat ada port BARU muncul. Device yang
// port-nya muncul sebelum firmware siap menjawab TIDAK PERNAH tersambung -
// app harus di-restart atau device dicabut-colok.
import fs from 'fs';
import path from 'path';

const serial = fs.readFileSync(path.join(process.cwd(), 'src/serial-transport.js'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- A. Retry punya lebih banyak percobaan ---');
ok(/const RETRY_MAX_ATTEMPTS = 6;/.test(serial), 'batas retry dinaikkan (6x, sebelumnya 2x)');
ok(!/if \(attempt > 2\) return;/.test(serial), 'tidak ada lagi hardcoded "attempt > 2"');
ok(/if \(attempt > RETRY_MAX_ATTEMPTS\) return;/.test(serial), 'batas memakai konstanta');

console.log('\n--- B. Backoff, bukan jeda tetap ---');
ok(/function retryDelay\(attempt\)/.test(serial), 'ada fungsi retryDelay()');
ok(/Math\.min\(RETRY_BASE_MS \* attempt, RETRY_MAX_MS\)/.test(serial),
  'jeda naik bertahap dan dibatasi maksimum (backoff)');
ok(/const RETRY_BASE_MS = 2500;/.test(serial) && /const RETRY_MAX_MS = 20000;/.test(serial),
  'batas jeda minimum & maksimum terdefinisi');
ok(/retryTimer = setTimeout\(async \(\) => \{[\s\S]*?\}, retryDelay\(attempt\)\);/.test(serial),
  'setTimeout memakai retryDelay(), bukan attempt * 3000 yang lama');

console.log('\n--- C. KRITIS: port yang gagal di-probe dicoba lagi ---');
// Inilah bagian yang membuat device "tidak pernah tersambung" sebelumnya.
ok(/let failedProbes = new Set\(\);/.test(serial), 'ada state failedProbes');
ok(/const retryable = paths\.filter\(p => failedProbes\.has\(p\)\);/.test(serial),
  'pollPorts() mencari port yang sudah GAGAL di-probe');
ok(/if \(!added\.length && !removed && !retryable\.length\) return;/.test(serial),
  'early-return hanya kalau tidak ada perubahan DAN tidak ada yang perlu dicoba lagi');
ok(/added\.length \? added : retryable/.test(serial),
  'port gagal di-probe diperlakukan sama seperti port baru');
ok(/for \(const t of targets\) failedProbes\.add\(t\);/.test(serial),
  'port yang gagal ditandai agar dicoba lagi nanti');
ok(/for \(const t of targets\) failedProbes\.delete\(t\);/.test(serial),
  'port yang BERHASIL dihapus dari daftar gagal');

console.log('\n--- D. failedProbes tidak pernah basi ---');
const connFn = serial.match(/export async function connect\(pathArg\) \{([\s\S]*?)\n\}/);
ok(/failedProbes\.delete\(path\);/.test(connFn[1]),
  'connect() yang berhasil menghapus penanda gagal port itu');
ok(/clearTimeout\(retryTimer\);/.test(connFn[1]),
  'connect() yang berhasil membatalkan retry terjadwal (tak ada probe sia-sia setelah tersambung)');
const lostFn = serial.match(/export async function handleDeviceLost\(\) \{([\s\S]*?)\n\}/);
ok(/failedProbes\.delete\(lostPath\)/.test(lostFn[1]),
  'device yang dicabut dibersihkan dari daftar gagal (tak ada probe ke port hantu)');
const autoFn = serial.match(/export async function autoDetect\(\) \{([\s\S]*?)\n\}/);
ok(/failedProbes = new Set\(\);/.test(autoFn[1]),
  'tombol ↻ me-reset daftar gagal, jadi probe benar-benar dari awal');

// Kalau port hantu tertinggal di failedProbes, pollPorts akan probe-nya
// selamanya - setiap 2 detik, selamanya.
ok(!/failedProbes\.add\(t\);/.test(lostFn[1]),
  'handleDeviceLost tidak menambahkan port ke daftar gagal');

console.log('\n--- E. Perilaku yang harus TIDAK berubah ---');
ok(/if \(port \|\| !autoReconnect\) return;/.test(serial),
  'retry tetap berhenti kalau user menekan Disconnect (autoReconnect=false)');
ok(/if \(autoBusy \|\| port\) return false;/.test(serial),
  'tryAutoConnect tetap guarding terhadap koneksi paralel');
ok(/const retryable = paths\.filter\(p => failedProbes\.has\(p\)\)/.test(serial),
  'daftar port probed tetap dipanggil 2 detik (pollPorts tidak diubah intervalnya)');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);

// Menguji firmware DENGAN COMPILER SUNGGUHNYA - bukan regex.
//
// Latar belakang: sepanjang proyek ini semua verifikasi firmware hanya
// regex (firmware-compile-guard-test.js). Regex tidak menangkap error
// kompilasi sungguhan. Bukti nyata: `const size_t len` yang di-assign ulang
// di dalam fungsi pernah LOLOS 35/35 suite hijau, lalu user yang menemukan
// error-nya - artinya artefak itu tidak akan pernah sampai ke silicon.
//
// Suite ini menutup celah itu. Kalau arduino-cli + core esp32 tidak ada,
// suite DILEWATI dengan pesan jelas (bukan diam-diam hijau). Kalau ada, kedua
// sketsh wajib benar-benar dikompilasi.
//
// PENTING: suite ini tidak melakukan flash. Dia hanya compile. Tidak ada
// yang menyentuh device.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../runner/paths.mjs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const skip = (m) => console.log(`  SKIP ${m}`);

// Kedua sketsh wajib compile. PROTOTYPE yang benar-benar di-flash user;
// FINAL ikut dikompilasi karena keduanya berbagi setiap header di
// common/ - kerusakan di macropad_core.h kalau tidak akan baru ketahuan
// setelah flash sungguhan.
const SKETCHES = [
  'firmware/HID_Keypad_Prototype',
  'firmware/HID_Keypad_Final',
];
const FQBN = 'esp32:esp32:esp32s3';

function has(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

console.log('--- A. Toolchain tersedia ---');
if (!has('arduino-cli', ['version'])) {
  console.log('  SKIP arduino-cli tidak ada di PATH - compile check dilewati.');
  console.log('       Pasang dengan: scoop install arduino-cli');
  console.log('       Lalu: arduino-cli core install esp32:esp32');
  console.log('            arduino-cli lib install NimBLE-Arduino');
  process.exit(0);
}
ok(true, 'arduino-cli tersedia');

const cores = execFileSync('arduino-cli', ['core', 'list'], { encoding: 'utf8' });
ok(/esp32:esp32/.test(cores), 'core esp32:esp32 terpasang');

console.log('\n--- B. Firmware dikompilasi sungguhan ---');
for (const sk of SKETCHES) {
  const p = path.join(REPO, sk);
  if (!fs.existsSync(p)) { skip(`${sk} tidak ada`); continue; }
  let out = '', code = 0;
  try {
    out = execFileSync('arduino-cli', ['compile', '--fqbn', FQBN, '--no-color', sk],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20 * 60 * 1000 });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = 1;
  }
  if (code === 0) {
    ok(true, `${sk} compile`);
    const m = out.match(/Sketch uses (\d+) bytes \((\d+)%\)[\s\S]*?Global variables use (\d+) bytes \((\d+)%\)/);
    if (m) console.log(`       flash ${m[1]} B (${m[2]}%) | RAM ${m[3]} B (${m[4]}%)`);
  } else {
    ok(false, `${sk} compile`);
    out.split('\n')
      .filter(l => /error|fatal|Error/.test(l))
      .slice(0, 8)
      .forEach(l => console.log(`         ${l.trim()}`));
  }
}

console.log(fail === 0 ? '\nOK: firmware benar-benar bisa dikompilasi.' : `\n${fail} pemeriksaan gagal.`);
process.exit(fail === 0 ? 0 : 1);

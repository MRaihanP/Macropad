// Mengunci konsistensi versi di tiga berkas yang terpisah.
//
// package.json dulu 0.1.0 sementara Cargo.toml dan tauri.conf.json sudah
// 0.2.0. Tidak ada yang gagal build - Tauri tidak memverifikasi angka ini -
// jadi versi bisa menyimpang diam-diam dan nomor rilis jadi tidak jelas.
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- A. Tiga berkas punya versi yang sama ---');
const pkg = readJson('package.json');
const cargoText = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
const tauri = readJson('src-tauri/tauri.conf.json');

ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `package.json version valid: ${pkg.version}`);

// Cargo.toml: ambil blok [package] saja, bukan [dependencies] (yang juga punya version).
const cargoPkgBlock = cargoText.match(/^\[package\]([\s\S]*?)(?=^\[)/m);
ok(!!cargoPkgBlock, 'blok [package] ditemukan di Cargo.toml');
const cargoVer = cargoPkgBlock && cargoPkgBlock[1].match(/^version\s*=\s*"([^"]+)"/m);
ok(!!cargoVer, `Cargo.toml punya version: ${cargoVer ? cargoVer[1] : '(tidak ada)'}`);

ok(typeof tauri.version === 'string', `tauri.conf.json punya version: ${tauri.version}`);

console.log('\n--- B. Ketiganya sama ---');
const versions = {
  'package.json': pkg.version,
  'Cargo.toml': cargoVer && cargoVer[1],
  'tauri.conf.json': tauri.version,
};
const uniq = [...new Set(Object.values(versions))];
ok(uniq.length === 1, `ketiga versi sama (${JSON.stringify(versions)})`);

console.log('\n--- C. Nilai lama tidak tersisa ---');
// 0.1.0 adalah nilai lama yang dulu tidak sinkron. Kalau muncul lagi di
// manifest mana pun, berarti ada yang diedit tanpa menyelaraskan yang lain.
for (const [f, v] of Object.entries(versions)) {
  ok(v !== '0.1.0', `${f} bukan 0.1.0 lagi`);
}

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);

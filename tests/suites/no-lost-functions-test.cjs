// Audit "bystander": membandingkan daftar SELURUH fungsi & konstanta top-level
// yang ada di main.js SEBELUM Phase 8 dengan yang ada di seluruh src/*.js sekarang.
//
// Latar belakang: saat ekstraksi transport (Phase 8 tahap 3), fungsi
// resetEditorState ikut terhapus karena berdiri di tengah region yang dihapus -
// dan karena dipanggil dari initAdaptive({...}) saat modul dimuat, seluruh app
// gagal start sehingga tidak ada port COM yang terlihat. Test suite biasa tidak
// menangkapnya karena tidak ada yang benar-benar memanggil app di browser.
//
// Test ini mencari kasus serupa: fungsi yang hilang tanpa jejak.
//
// Jalankan: node no-lost-functions-test.js
const fs = require('fs');
const { execSync } = require('child_process');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

// Path dihitung dari lokasi file ini (__dirname), bukan dari cwd. Runner
// kebetulan menjalankan dengan cwd = root repo, tapi mengandalkannya membuat
// test ini gagal diam-diam kalau dipanggil dari folder lain.
const SRC = require('path').join(__dirname, '..', '..', 'src');
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
const readAll = () => files.map((f) => fs.readFileSync(`${SRC}/${f}`, 'utf8')).join('\n');

// Commit tepat sebelum Phase 8 dimulai (device-state diekstrak). Memakai yang
// lebih lama akan memberi laporan palsu: beberapa nama memang sudah dihapus
// di Phase 5/6/7 dan itu tidak terkait ekstraksi.
const BASE = 'a80b954';
const old = execSync(`git show ${BASE}:src/main.js`, { maxBuffer: 1 << 28 }).toString();

// Modul hasil ekstraksi memakai "export function" / "export const", jadi prefiks
// export WAJIB ikut pola - tanpanya semua modul terlihat "kosong".
const defRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
const constRe = /^(?:export\s+)?(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=/gm;

const collect = (src, re) => {
  const s = new Set();
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(src))) s.add(m[1]);
  return s;
};

const oldFns = collect(old, defRe);
const oldConsts = collect(old, constRe);
const now = readAll();
const nowFns = collect(now, defRe);
const nowConsts = collect(now, constRe);

// Beberapa nama berubah bentuk saat ekstraksi (function -> const arrow), jadi
// nama yang "hilang" dicari di kedua daftar sekaligus.
const stillSomewhere = (n) => nowFns.has(n) || nowConsts.has(n);

console.log(`--- 1. Fungsi top-level: ${oldFns.size} dulu, ${nowFns.size} sekarang ---`);
const lostFns = [...oldFns].filter((f) => !stillSomewhere(f)).sort();
ok(lostFns.length === 0,
  lostFns.length ? `FUNGSI HILANG: ${lostFns.join(', ')}` : 'tidak ada fungsi yang hilang tanpa jejak');

console.log('\n--- 2. Konstanta top-level ---');
// Nama yang hilang dengan alasan yang sudah diverifikasi manual. Kalau nama baru
// muncul di sini tanpa penjelasan, itu bug - bukan kusalah audit.
const renamedOrDropped = {
  // Dipindah ke serial-transport.js dan diganti nama karena sekarang "event" bukan
  // hanya EVT:APP: tapi semua balasan device. Dibaca lewat eventsSuppressed().
  ignoreEvtUntil: 'serial-transport.js: suppressEventsUntil + eventsSuppressed()',
  // Dipindah ke src/tray.js (Phase 8 tahap 8): sekarang dibuat di dalam
  // initTrayHandlers() karena hanya dipakai untuk memasang onCloseRequested.
  appWindow: 'tray.js: const appWindow di dalam initTrayHandlers()',
};
const lostConsts = [...oldConsts].filter((c) => !stillSomewhere(c)).sort();
const unexplained = lostConsts.filter((c) => !(c in renamedOrDropped));
ok(unexplained.length === 0,
  unexplained.length
    ? `KONSTANTA HILANG tanpa penjelasan: ${unexplained.join(', ')}`
    : `tidak ada konstanta yang hilang tanpa jejak (${lostConsts.length} diganti: ${lostConsts.join(', ') || '-'})`);
for (const c of lostConsts) console.log(`  info ${c} -> ${renamedOrDropped[c]}`);

console.log('\n--- 3. Semua nama yang di-import memang di-export oleh berkasnya ---');
// Ini menangkap salah ketik di daftar import - penyebab umum ReferenceError
// yang lolos dari `vite build` tapi langsung mematikan app saat start.
let importCount = 0;
for (const file of files) {
  const src = fs.readFileSync(`${SRC}/${file}`, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/([\w.-]+)["']/g)) {
    const target = `${SRC}/${m[2]}`;
    if (!fs.existsSync(target)) continue;
    const targetSrc = fs.readFileSync(target, 'utf8');
    const exported = new Set();
    for (const e of targetSrc.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) exported.add(e[1]);
    // Declarator bisa berbaris: "export let ROWS = 3, COLS = 3;" - semua nama di
    // dalamnya ikut terekspor, jadi harus dibaca per-koma sampai baris berakhir.
    for (const e of targetSrc.matchAll(/^export\s+(?:let|const|var|class)\s+([^;]+);/gm)) {
      for (const part of e[1].split(',')) {
        const name = part.trim().split(/[\s=]/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) exported.add(name);
      }
    }
    for (const e of targetSrc.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of e[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) exported.add(name);
      }
    }
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      importCount++;
      ok(exported.has(name), `${file} meng-import "${name}" dari ${m[2]} - ada di daftar export`);
    }
  }
}
console.log(`  (${importCount} nama import diperiksa)`);

console.log('\n--- 4. Smoke test startup: benar-benar memuat main.js ---');
try {
  const smoke = require('path').join(__dirname, 'startup-smoke-test.mjs');
const out = execSync(`node "${smoke}"`, { encoding: 'utf8' });
  ok(out.includes('HASIL: startup app tidak melempar error dan port terbaca'),
    'main.js dimuat tanpa exception dan dropdown COM terisi');
  ok(out.includes('available_ports() dipanggil'), 'autoDetect() memanggil enumerasi port saat start');
} catch (e) {
  const msg = String(e.stdout || '') + String(e.message);
  ok(false, 'startup-smoke-test gagal:\n' + msg.split('\n').slice(0, 8).join('\n'));
}

console.log(`\n${fail === 0 ? 'HASIL: tidak ada fungsi/konstanta yang hilang diam-diam' : 'HASIL: ' + fail + ' gagal'}`);
process.exit(fail === 0 ? 0 : 1);
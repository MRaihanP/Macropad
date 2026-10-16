// Test Fase 1: codec frame harus PERSIS SAMA di tiga bahasa.
//
// Golden vectors di tests/vectors/frames.vec dibaca oleh tiga runner terpisah:
//   1. file ini                        (JavaScript) -> src/frame-codec.js
//   2. src-tauri/src/frame.rs          (Rust)       -> src-tauri/src/frame.rs
//   3. tests/suites/frame-asm-native-test.js (C, gcc) -> firmware/common/frame_asm.h
//
// Kalau hanya satu yang jalan, "implementasinya sama" cuma klaim. Kalau ketiganya
// hijau terhadap berkas yang sama, mereka benar-benar setara byte per byte.
//
// Jalankan: node tests/suites/frame-codec-test.mjs
import fs from 'node:fs';
import { FrameDecoder, encode, crc16, SOF, VER, MAX_PAYLOAD, OVERHEAD } from '../../src/frame-codec.js';

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };

const VEC = 'tests/vectors/frames.vec';

/**
 * Parser vektor.
 *
 * Sengaja hanya split whitespace. Ketiga bahasa harus bisa membacanya tanpa
 * pustaka JSON, jadi formatnya tidak boleh punya struktur bersarang.
 */
function parseVec() {
  const text = fs.readFileSync(VEC, 'utf8');
  const cases = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const t = line.split(/\s+/);
    if (t[0] !== 'SEQ') throw new Error(`baris tak dikenal: ${line}`);
    cases.push({
      name: t[1],
      expect: t[t.length - 1],
      bytes: t.slice(2, t.length - 1).map((h) => parseInt(h, 16)),
    });
  }
  return cases;
}

const wantToTokens = (expect) =>
  expect === 'NONE' ? [] : expect.split(',').map((s) => s.trim()).filter(Boolean);

const eventToToken = (e) => {
  if (!e.ok) return `E:${e.error}`;
  const t = `0x${e.type.toString(16).padStart(2, '0')}`;
  return `F:${t}`;
};

console.log('--- 1. Berkas vektor terbaca dan cukup banyak ---');
const cases = parseVec();
ok(cases.length >= 25, `vektor terbaca: ${cases.length}`);
ok(fs.readFileSync(VEC, 'utf8').includes('DIHASILKAN OLEH tools/gen-vectors.mjs'),
  'vektor ditandai hasil generate, bukan ditulis tangan');

console.log('\n--- 2. Check value CRC16/CCITT-FALSE ---');
{
  const angka = crc16(Array.from('123456789', (c) => c.charCodeAt(0)));
  ok(angka === 0x29b1, `crc16("123456789") = 0x${angka.toString(16).toUpperCase()} (harus 0x29B1)`);
}

console.log('\n--- 3. Semua golden vectors sesuai di JS ---');
{
  const gagal = [];
  for (const c of cases) {
    const d = new FrameDecoder();
    const ev = d.push(c.bytes);
    const didapat = ev.map(eventToToken);
    const harap = wantToTokens(c.expect);
    if (JSON.stringify(didapat) !== JSON.stringify(harap)) {
      gagal.push(`${c.name}: harap [${harap}] dapat [${didapat}]`);
      continue;
    }
    // Vektor yang persis satu frame harus pulih persis lewat encode().
    if (ev.length === 1 && ev[0].ok && c.bytes.length === OVERHEAD + ev[0].payload.length) {
      const ulang = encode(ev[0].type, Array.from(ev[0].payload));
      if (JSON.stringify(ulang) !== JSON.stringify(c.bytes)) {
        gagal.push(`${c.name}: encode() byte-nya beda dari vektor`);
      }
    }
  }
  ok(gagal.length === 0,
    gagal.length === 0
      ? `semua ${cases.length} vektor cocok`
      : `${gagal.length} vektor gagal: ${gagal.join(' | ')}`);
}

console.log('\n--- 4. Payload melebihi batas wajib ditolak ---');
{
  const terlaluBesar = new Array(MAX_PAYLOAD + 1).fill(0);
  let ditolak = false;
  try {
    const d = new FrameDecoder();
    const ev = d.push(encode(0x13, terlaluBesar));
    ditolak = ev.length === 1 && ev[0].ok === false && ev[0].error === 'LEN_OVERFLOW';
  } catch (e) {
    ditolak = true;   // melempar juga merupakan penolakan yang sah
  }
  ok(ditolak, `payload ${MAX_PAYLOAD + 1} byte ditolak, tidak dipotong diam-diam`);
}

console.log('\n--- 5. Batas chunk tidak boleh mengubah hasil ---');
{
  // Cara paling umum salah pada codec streaming: satu frame terpotong di tengah
  // oleh batas notify. Satu stream identik dipecah di SEMUA batas yang mungkin;
  // hasilnya wajib sama persis.
  const stream = [
    ...encode(0x13, []),
    ...encode(0x20, [1, 2, 3, 4, 5]),
    ...encode(0x14, [7]),
  ];
  const ref = new FrameDecoder().push(stream);
  let beda = null;
  for (let cut = 1; cut < stream.length; cut++) {
    const d = new FrameDecoder();
    const got = [...d.push(stream.slice(0, cut)), ...d.push(stream.slice(cut))];
    if (JSON.stringify(got) !== JSON.stringify(ref)) { beda = cut; break; }
  }
  ok(beda === null,
    beda === null
      ? `identik di semua ${stream.length - 1} batas chunk`
      : `BERBEDA saat dipotong pada byte ${beda}`);
}

console.log('\n--- 6. Feed satu-satu sama dengan feed sekaligus ---');
{
  const bytes = encode(0x11, [0x00, 0x01, 0x02, 0x03, 0x04]);
  const a = new FrameDecoder();
  const kumpulan = [];
  for (const b of bytes) kumpulan.push(...a.push([b]));
  const batch = new FrameDecoder().push(bytes);
  ok(JSON.stringify(kumpulan) === JSON.stringify(batch),
    'hasil identik saat dipecah per byte dan sekaligus');
}

console.log('\n--- 7. Fuzz acak: tidak boleh exception, false accept harus sangat jarang ---');
{
  // Fuzz di sini bukan untuk mencari bug logika (golden vectors sudah itu),
  // tapi untuk memastikan decoder tidak pernah:
  //   - melempar exception,
  //   - MENERIMA frame dari data acak (false accept).
  //
  // False accept yang paling berbahaya: byte acak yang lolos akan
  // diperlakukan app sebagai perintah dan bisa mengubah config device.
  let seed = 0x12345678;
  const rand = () => {
    // LCG sederhana. Seed tetap supaya kegagalan bisa direproduksi persis.
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed >>> 16) & 0xff;
  };
  const N = 20000;
  let diterima = 0;
  let meledak = null;
  for (let i = 0; i < N; i++) {
    const n = 1 + (rand() % 40);
    const buf = Array.from({ length: n }, () => rand());
    try {
      const ev = new FrameDecoder().push(buf);
      diterima += ev.filter((e) => e.ok).length;
    } catch (err) {
      meledak = `iterasi ${i}: ${err.message}\n         buffer: ${buf.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`;
      break;
    }
  }
  ok(meledak === null, meledak === null
    ? `${N} buffer acak tanpa exception`
    : `decoder melempar exception - ${meledak}`);

  // False accept dari acak harus sangat jarang: sekitar 1 per 2^16 percobaan
  // CRC untuk payload pendek. Kalau jauh lebih sering, ada bug di CRC atau LEN.
  const wajar = N / 65536;
  ok(diterima <= Math.max(2, wajar),
    `false accept dari data acak: ${diterima} dari ${N} buffer (batas wajar ${wajar.toFixed(2)})`);
}

console.log('\n--- 8. Bit-flip pada frame sah harus selalu ditolak ---');
{
  // Kalau ada bit-flip yang tetap diterima dengan isi BERBEDA, CRC-nya tidak
  // benar-benar mengikat data - dan itu kelas bug yang paling quiet.
  let lolos = 0;
  const isi = [1, 2, 3, 4, 5, 6, 7, 8];
  const asli = encode(0x20, isi);
  let total = 0;
  for (let i = 0; i < asli.length; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const rusak = [...asli];
      rusak[i] ^= 1 << bit;
      total++;
      const okFrame = new FrameDecoder().push(rusak).find((e) => e.ok);
      if (okFrame) {
        const payload = Array.from(okFrame.payload);
        const sama = payload.length === isi.length && payload.every((b, k) => b === isi[k]);
        if (!sama) {
          lolos++;
          console.log(`         byte ${i} bit ${bit} diterima dengan payload berubah`);
        }
      }
    }
  }
  ok(lolos === 0, `${total} bit-flip diuji, ${lolos} diterima dengan isi berubah`);
}

console.log('\n--- 9. Truncasi di semua posisi tidak boleh menghasilkan frame utuh ---');
{
  const asli = encode(0x11, Array.from({ length: 30 }, (_, i) => i));
  const salah = [];
  for (let cut = 1; cut < asli.length; cut++) {
    if (new FrameDecoder().push(asli.slice(0, cut)).some((e) => e.ok)) salah.push(cut);
  }
  ok(salah.length === 0,
    salah.length === 0
      ? `${asli.length - 1} posisi truncasi diuji, semua ditolak`
      : `${asli.length - 1} posisi diuji, ada frame lengkap pada: ${ salah.join(',')}`);
}

console.log('\n--- 10. Kontrak dengan header firmware ---');
{
  const header = fs.readFileSync('firmware/common/frame.h', 'utf8');
  const asm = fs.readFileSync('firmware/common/frame_asm.h', 'utf8');
  // Buang komentar dulu: kalau konstanta disebut di penjelasan saja, test ini
  // akan hijau tanpa ada kode yang benar-benar memakai nilai itu.
  const kode = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // Kalau konstanta di frame.h berubah, ketiga implementasi harus ikut berubah
  // bersamanya. Test ini menangkap ketidaksesuaian yang muncul belakangan.
  // padStart(2,'0') meniru format penulisan di frame.h: 0x02u, bukan 0x2u.
  // Flag `i` dipakai karena frame.h menulis heksadesimal huruf besar (0xA5u)
  // sementara nilai di sini dihasilkan oleh toString(16) yang huruf kecil.
  // bedanya huruf besar-kecil bukan ketidaksesuaian yang berarti.
  const hex2 = (v) => v.toString(16).padStart(2, '0');
  ok(new RegExp(`#define FA_SOF\\s+0x${hex2(SOF)}u`, 'i').test(kode(header)),
    `frame.h: FA_SOF = 0x${hex2(SOF)}`);
  ok(new RegExp(`#define FA_VER\\s+0x${hex2(VER)}u`, 'i').test(kode(header)),
    `frame.h: FA_VER = 0x${hex2(VER)}`);
  ok(new RegExp(`#define FA_MAX_PAYLOAD\\s+${MAX_PAYLOAD}u`).test(kode(header)),
    `frame.h: FA_MAX_PAYLOAD = ${MAX_PAYLOAD}`);

  // Regresi bug nyata: `got` tidak direset saat masuk state CRC, sehingga indeks
  // panjang payload ikut dipakai untuk menghitung byte CRC. Di Rust ini
  // menjadi panic "shift left with overflow"; di C jadi perilaku tak terdefinisi.
  const asmKode = kode(asm);
  ok(/s->st = FA_ST_CRC;[\s\S]{0,240}?s->got = 0;[\s\S]{0,80}?s->got_crc = 0;/.test(asmKode),
    'frame_asm.h: got dan got_crc direset saat masuk state CRC (regresi shift overflow)');

  // Perakit TIDAK BOLEH mencari SOF baru di tengah frame. Itu yang membuat
  // payload berisi 0xA5 aman tanpa escaping sama sekali.
  const isiCRC = asmKode.slice(asmKode.indexOf('case FA_ST_CRC'), asmKode.indexOf('case FA_ST_SKIP'));
  ok(isiCRC.length > 0 && !/FA_SOF/.test(isiCRC),
    'perakit tidak mencari SOF baru di tengah frame');

  // State SKIP wajib ada: tanpa itu, LEN monster membuat perakit ikut terdesync
  // ke tengah payload dan bisa membingkai frame palsu dari byte 0xA5.
  ok(/case FA_ST_SKIP:/.test(asmKode), 'ada state SKIP untuk LEN kelewat besar');
}

console.log(`\n${fail === 0 ? 'SEMUA OK' : fail + ' ASSERTION GAGAL'}: codec JS cocok dengan golden vectors`);
process.exit(fail ? 1 : 0);

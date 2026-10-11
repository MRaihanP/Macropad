import fs from 'fs';

// Test berjalan di isi HEADER yang sebenarnya (diterjemahkan C->JS), bukan
// salinan manual. Versi pertama menyalin algoritmanya secara manual dan HANYA
// membaca header sebagai teks - uji negatif membuktikan 7/7 regresi yang
// disisipkan ke header asli TIDAK terdeteksi. Test yang tidak menjalankan kode
// yang diuji tidak membuktikan apa pun.
//
// Terjemahannya mechanical per BARIS, bukan regex global. Beberapa versi
// sebelumnya gagal karena regex global ikut mencocokkan:
//
//  - pemanggilan fungsi di dalam badan (mis. "rgbHsv(" sebelum ")")
//    -> "function rgbHsv(" di tengah ekspresi
//  - parameter fungsi ("float h") -> "let h" sehingga jadi
//    "function rgbHsv(let h, ...)"
//  - cast tipe ("(uint8_t)") -> "()" sehingga jadi "R = ()(...)"
//
// Karena itu casting & deklarasi diproses lebih dulu, baru baris deklarasi
// fungsi diganti - dan hanya kalau baris itu memang Deklarasi (y diawali nama
// fungsi lalu tanda kurung, lalu "{", dan berada di luar badan fungsi lain).
export function translate(hdr, limits) {
  const ROWS = parseInt(limits.match(/#define ROWS\s+(\d+)/)[1], 10);
  const COLS = parseInt(limits.match(/#define COLS\s+(\d+)/)[1], 10);
  const RGB_COUNT = parseInt(limits.match(/#define RGB_COUNT\s+(\d+)/)[1], 10);

  // RGB_INDEX ditulis {a,b,c}, {d,e,f}, {g,h,i} - satu blok kurawal per baris.
  const idxRaw = limits.match(/RGB_INDEX\[ROWS\]\[COLS\] = \{([\s\S]*?)\};/)[1];
  const idxRows = [...idxRaw.matchAll(/\{([^}]*)\}/g)].map(m =>
    m[1].replace(/\/\/[^\n]*/g, '').split(',').map(t => parseInt(t.trim(), 10)));
  const idxBlock = '[' + idxRows.map(r => '[' + r.join(',') + ']').join(',') + ']';

  // --- 1) Buang preprocessor & komentar blok.
  let s = hdr.replace(/^\s*#.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // --- 2) Cast DULU, sebelum tipe dihapus.
  s = s.replace(/\((?:u?int(?:8|16|32)_t|bool|float)\)\s*/g, '');

  // --- 3) Suffix angka.
  s = s.replace(/(\d+\.\d+)f\b/g, '$1').replace(/(\d)u\b/g, '$1');

  // --- 4) Operator: fmodf -> helper. HARUS SEBELUM cast, karena pola cast
  //     "(int) X" dengan X = "fmodf(ph, RGB_COUNT)" akan memakan "(" dari
  //     fmodf dan menghasilkan "Math.floor(fmodf)(ph, ...)" - ReferenceError.
  s = s.replace(/\bfmodf\(/g, '__fmod(');

  // (int)X -> Math.floor(X); (float)X -> Number(X).
  //
  // PENTING: X boleh berupa PEMANGGILAN FUNGSI ("__fmod(ph, RGB_COUNT)"),
  // bukan hanya identifier. Versi sebelumnya hanya menangani identifier dan
  // kurung, sehingga "(int)__fmod(ph, N)" menjadi "Math.floor(__fmod)(ph, N)"
  // -> TypeError. Karena itu (__fmod(...)) dibungkus kurung lebih dulu,
  // lalu cast diterapkan di luar kurung itu.
  s = s.replace(/\bfmodf\s*\(([^()]*)\)/g, '__fmod($1)');
  s = s.replace(/\(int\)\s*(__fmod\([^()]*\))/g, 'Math.floor($1)');
  s = s.replace(/\(float\)\s*(__fmod\([^()]*\))/g, 'Number($1)');
  s = s.replace(/\(int\)\s*\(([^()]*)\)/g, 'Math.floor($1)');
  s = s.replace(/\(int\)\s*([A-Za-z_]\w*)/g, 'Math.floor($1)');
  s = s.replace(/\(float\)\s*\(([^()]*)\)/g, 'Number($1)');
  s = s.replace(/\(float\)\s*([A-Za-z_]\w*)/g, 'Number($1)');

  // --- 4b) Pointer "U32 *out" hanya di tanda tangan parameter, JANGAN di
  //     seluruh teks. Versi sebelumnya menghapus semua "*", sehingga
  //     "v * s / 255.0" menjadi "v s / 255.0" dan gagal parse. Pointer
  //     dibersihkan nanti, per baris tanda tangan.

  // --- 5) Proses per baris.
  const out = [];
  let depth = 0;               // kedalaman kurawal
  const lines = s.split('\n');

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];

    // Tanda tangan rgbFrame spanning beberapa baris: kumpulkan sampai tanda
    // kurung penutup + "{" ditemukan. Tanpa ini, rgbFrame tidak pernah
    // terdeteksi sebagai deklarasi dan gagal parse.
    if (depth === 0) {
      const head = /^\s*(?:static\s+inline\s+)?(?:u?int(?:8|16|32)_t|bool|float|void)\s+(rgbHsv|rgbRand|rgbFrame)\s*\(/.exec(line)
              || /^\s*(rgbHsv|rgbRand|rgbFrame)\s*\(/.exec(line);
      if (head) {
        const name = head[1];
        // Kumpulkan baris berikutnya sampai kurawal penutup + "{".
        let sig = line.slice(line.indexOf('(') + 1);
        let joined = sig;
        let j = li;
        while (!/\)\s*\{\s*$/.test(joined) && j + 1 < lines.length) {
          j++;
          joined += ' ' + lines[j].trim();
        }
        // Ambil isi tanda kurung.
        const body = joined.slice(0, joined.lastIndexOf(')'));
        const args = body.split(',').map(a => a
          .replace(/\b(?:u?int(?:8|16|32)_t|bool|float|int|const)\b/g, '')
          .replace(/\[[^\]]*\]/g, '')   // color[3] -> color
          .replace(/\*\s*/g, '')        // U32 *out -> out
          .trim()).filter(Boolean).join(', ');
        out.push(`function ${name}(${args}) {`);
        depth = 1;
        li = j;   // lanjut setelah baris tanda tangan
        continue;
      }
    }

    // Di luar badan fungsi: ini kandidat deklarasi fungsi.
    if (depth === 0) {
      const m = /^\s*(?:static\s+inline\s+)?(?:u?int(?:8|16|32)_t|bool|float|void)\s+(rgbHsv|rgbRand|rgbFrame)\s*\(([\s\S]*)\)\s*\{\s*$/.exec(line)
             || /^\s*(rgbHsv|rgbRand|rgbFrame)\s*\(([\s\S]*)\)\s*\{\s*$/.exec(line);
      if (m) {
        const name = m[m.length - 2];
        let args = m[m.length - 1];
        // Bersihkan sisa tipe & const dari tiap argumen.
        args = args.split(',').map(a => a
          .replace(/\b(?:u?int(?:8|16|32)_t|bool|float|const)\b/g, '')
          .replace(/\[[^\]]*\]/g, '')
          .trim()).filter(Boolean).join(', ');
        out.push(`function ${name}(${args}) {`);
        depth = 1;
        continue;
      }
    }

    // Deklarasi variabel bertipe di dalam badan: "uint8_t R = ..." -> "let R = ..."
    // "int" polos ikut masuk - versi sebelumnya melewatkannya sehingga
    // "int idx = ..." tetap jadi "int idx = ..." dan gagal parse.
    line = line.replace(/\b(?:u?int(?:8|16|32)_t|bool|float|int)\s+(\w+)\s*=/g, 'let $1 =');

    // Sisa tipe yang menggantung dibuang.
    line = line.replace(/\b(?:u?int(?:8|16|32)_t|bool|float|void|int)\b/g, '');

    // Hitung kurawal untuk tahu kapan keluar dari badan fungsi.
    for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }

    out.push(line);
  }

  const prelude = `
const RGB32 = (r, g, b) => (((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0;
const ROWS = ${ROWS}, COLS = ${COLS}, RGB_COUNT = ${RGB_COUNT};
const RGB_INDEX = ${idxBlock};
const __fmod = (a, b) => a % b;
`;
  return prelude + '\n' + out.join('\n');
}

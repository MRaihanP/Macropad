// Helper DOM bersama - dipakai seluruh modul halaman.
//
// Sebelumnya el/log/escapeHtml hanya ada di main.js, sehingga modul baru harus
// menduplikasi atau meneruskannya. Dipisah di sini supaya hanya ada satu salinan.

export const el = (id) => document.getElementById(id);

// Dicari saat dipakai, bukan di level modul: logBox di-resolve sekali lalu disimpan,
// sehingga modul ini bisa diimpor di luar browser (test Node) tanpa perlu stub DOM.
let logBoxEl = null;
function logBox() {
  if (logBoxEl === null) logBoxEl = el('log');
  return logBoxEl;
}

// Catatan event di panel log. Memakai textContent (bukan innerHTML) sehingga teks dari
// device atau macro tidak pernah diperlakukan sebagai HTML.
export function log(msg, cls) {
  const box = logBox();
  if (!box) return;
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// Escape 5 karakter HTML termasuk tanda kutip tunggal. Semua pemanggilan saat ini
// memakai konteks atribut berkutip ganda, tapi escapes ' menjaga aman bila nanti
// ada yang memakainya di atribut berkutip tunggal.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]); }
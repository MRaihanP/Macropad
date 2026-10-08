// ==================== MODAL ====================
//
// Pengganti prompt()/confirm() bawaan browser.
//
// Kenapa tidak pakai bawaan? WebView2 tidak punya dialog modal yang bisa Promise,
// dan `confirm()` memblokir thread WebView - notifikasi overlay yang sudah tampil
// akan membeku sampai user menjawab. Modal sendiri juga bisa mengikuti tema app.
//
// showModalBase() mengembalikan nilai tombol yang diklik, atau null kalau ditutup
// dengan Escape / klik Cancel. Semua teks dari device atau macro SELALU di-escape
// sebelum masuk ke innerHTML - notifyBoundAction() menambah nilai macro ke teks
// notifikasi, dan nilai itu berasal dari flash device yang bisa berisi apa saja.

import { el, escapeHtml } from './dom.js';

export function showModalBase(titleText, bodyHtml, buttons) {
  return new Promise(resolve => {
    const overlay = el('modalOverlay');
    el('modalTitle').textContent = titleText;
    el('modalBody').innerHTML = bodyHtml;
    const actions = el('modalActions');
    actions.innerHTML = '';
    function close(value) { overlay.classList.remove('show'); document.removeEventListener('keydown', onKey); resolve(value); }
    function onKey(e) {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter') {
        const okBtn = buttons.find(b => b.primary);
        if (okBtn) close(okBtn.value);
      }
    }
    buttons.forEach(btn => {
      const b = document.createElement('button');
      b.textContent = btn.label;
      if (btn.primary) b.className = 'primary';
      b.onclick = () => close(btn.value);
      actions.appendChild(b);
    });
    document.addEventListener('keydown', onKey);
    overlay.classList.add('show');
    const input = el('modalInput');
    if (input) { input.focus(); input.select(); }
  });
}

export async function showPromptModal(title, label, defaultValue) {
  const bodyHtml = `<div>${escapeHtml(label)}</div><input type="text" id="modalInput" value="${escapeHtml(defaultValue)}">`;
  const result = await showModalBase(title, bodyHtml, [
    { label: 'Cancel', value: null },
    { label: 'OK', value: 'ok', primary: true }
  ]);
  if (result !== 'ok') return null;
  return el('modalInput').value;
}

export function showConfirmModal(title, message, confirmLabel) {
  return showModalBase(title, escapeHtml(message), [
    { label: 'Cancel', value: false },
    { label: confirmLabel || 'OK', value: true, primary: true }
  ]);
}

// Firmware menyimpan maksimal 47 byte (MACRO_MAX_LEN 48 termasuk terminator).
// Dipotong per karakter utuh supaya string multi-byte tidak jadi rusak di tengah.
// Dipakai bersama daftar aplikasi (untuk nama .exe yang dikirim ke device).
export function clipUtf8(s, maxBytes = 47) {
  const enc = new TextEncoder();
  let out = '', used = 0;
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (used + n > maxBytes) break;
    out += ch; used += n;
  }
  return out;
}
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
import { t } from './i18n.js';

// Elemen yang bisa menerima fokus di dalam dialog, sesuai urutan bacaan.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function showModalBase(titleText, bodyHtml, buttons) {
  return new Promise(resolve => {
    const overlay = el('modalOverlay');
    el('modalTitle').textContent = titleText;
    el('modalBody').innerHTML = bodyHtml;
    const actions = el('modalActions');
    actions.innerHTML = '';
    function close(value) {
      overlay.classList.remove('show');
      document.removeEventListener('keydown', onKey, true);
      // Kembalikan fokus ke elemen yang membuka dialog. Tanpa ini, fokus jatuh
      // ke <body> dan pengguna keyboard kehilangan tempatnya - harus Tab dari
      // awal lagi setiap kali dialog ditutup.
      if (previouslyFocused && previouslyFocused.isConnected) {
        try { previouslyFocused.focus(); } catch (e) { }
      }
      resolve(value);
    }
    function onKey(e) {
      // preventDefault di sini bukan sekadar agar Enter tidak mengirim form di
      // belakang overlay. Ini juga jadi sinyal "sudah ada yang menangani
      // event ini" bagi listener lain - home-page.js memeriksa
      // e.defaultPrevented supaya satu tekan Escape saat modal terbuka tidak
      // sekaligus membatalkan editor yang sedang direkam.
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      if (e.key === 'Enter') {
        const okBtn = buttons.find(b => b.primary);
        if (okBtn) { e.preventDefault(); close(okBtn.value); }
        return;
      }
      // Focus trap: tanpa ini, Tab dari tombol terakhir akan keluar ke elemen
      // di belakang overlay yang tertutup - pengguna keyboard bisa fokus ke
      // kontrol yang tidak terlihat dan tidak tahu sedang di mana.
      if (e.key === 'Tab') {
        const items = [...overlay.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement);
        if (items.length === 0) { e.preventDefault(); return; }
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!overlay.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      }
    }
    const previouslyFocused = document.activeElement;
    buttons.forEach(btn => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = btn.label;
      if (btn.primary) b.className = 'primary';
      b.onclick = () => close(btn.value);
      actions.appendChild(b);
    });
    document.addEventListener('keydown', onKey, true);
    overlay.classList.add('show');
    const input = el('modalInput');
    // Fokus pertama: input kalau ada, kalau tidak tombol utama, kalau tidak
    // tombol pertama. Tanpa ini fokus tetap di belakang dan user tidak tahu
    // dialog sudah terbuka.
    if (input) { input.focus(); input.select(); }
    else {
      const items = [...overlay.querySelectorAll(FOCUSABLE)];
      (items.find(n => n.classList.contains('primary')) || items[0] || el('modalTitle')).focus?.();
    }
  });
}

export async function showPromptModal(title, label, defaultValue) {
  const bodyHtml = `<div>${escapeHtml(label)}</div><input type="text" id="modalInput" value="${escapeHtml(defaultValue)}">`;
  const result = await showModalBase(title, bodyHtml, [
    { label: t('modal.cancel'), value: null },
    { label: t('modal.ok'), value: 'ok', primary: true }
  ]);
  if (result !== 'ok') return null;
  return el('modalInput').value;
}

export function showConfirmModal(title, message, confirmLabel) {
  return showModalBase(title, escapeHtml(message), [
    { label: t('modal.cancel'), value: false },
    { label: confirmLabel || t('modal.ok'), value: true, primary: true }
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
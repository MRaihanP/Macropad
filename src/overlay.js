// Logika jendela notifikasi overlay (always-on-top).
//
// Notifikasi dikirim Rust lewat channel event resmi Tauri, bukan w.eval(). Dulu teks
// notifikasi disuntikkan sebagai JavaScript; teks itu berasal dari nilai macro yang
// tersimpan di flash device, jadi harus diperlakukan sebagai data, bukan kode.
//
// Dipisah dari overlay.html supaya Vite mengolahnya sebagai module - dynamic import
// di dalam <script> biasa akan dianggap path relatif oleh plugin HTML.

import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

const T = document.getElementById('toast');
const I = document.getElementById('inner');
const D = document.getElementById('dot');
const X = document.getElementById('text');
const BASE = 16, H = 44;
let pendingHold = 3000;
const COLORS = { connect: '#4ecdc4', disconnect: '#e8604c', layer: '#c792ea', preset: '#f2a154', key: '#7c9cf2', info: '#8b93a1' };
const EASE = 'cubic-bezier(.22,1,.36,1)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let state = 'idle', token = 0, deadline = 0, W = 100;

function go(style, ms, ease = EASE) {
  T.style.transition = `all ${ms}ms ${ease}`;
  Object.assign(T.style, style);
  return sleep(ms);
}
function measure() { return Math.min(440, I.offsetWidth + 4); }

async function holdThenHide(my) {
  while (token === my && Date.now() < deadline) await sleep(Math.max(30, deadline - Date.now()));
  if (token !== my) return;
  state = 'hiding';
  I.style.opacity = '0';
  await sleep(120); if (token !== my) return;
  await go({ width: BASE + 'px', height: BASE + 'px', borderRadius: BASE / 2 + 'px' }, 320); if (token !== my) return;
  await go({ transform: 'translateY(-26px) scale(.1)', opacity: '0' }, 300); if (token !== my) return;
  state = 'idle';
}

async function show(my) {
  state = 'showing';
  T.style.transition = 'none';                       // keadaan awal: lingkaran kecil di atas layar
  Object.assign(T.style, { width: BASE + 'px', height: BASE + 'px', borderRadius: BASE / 2 + 'px',
    opacity: '0', transform: 'translateY(-30px) scale(.6)' });
  I.style.opacity = '0'; void T.offsetWidth;
  await go({ opacity: '1', transform: 'translateY(0) scale(1)' }, 320); if (token !== my) return;   // turun
  setTimeout(() => { if (token === my) I.style.opacity = '1'; }, 160);
  await go({ width: W + 'px', height: H + 'px', borderRadius: '16px' }, 380); if (token !== my) return; // expand
  state = 'shown';
  deadline = Math.max(deadline, Date.now() + pendingHold);
  await holdThenHide(my);
}

function toast({ text, kind, hold }) {
  X.textContent = text;
  D.style.background = COLORS[kind] || COLORS.info;
  W = measure();
  const h = hold || 3000, until = Date.now() + h;
  if (state === 'showing') { pendingHold = Math.max(pendingHold, h); return; }   // dipakai show() yang sedang jalan
  if (state === 'shown') { deadline = Math.max(deadline, until); go({ width: W + 'px' }, 200); return; }
  const my = ++token;
  pendingHold = h; deadline = until;
  if (state === 'hiding') {                          // sedang menyusut: kembalikan ke bentuk penuh
    state = 'shown'; I.style.opacity = '1';
    go({ width: W + 'px', height: H + 'px', borderRadius: '16px', opacity: '1', transform: 'translateY(0) scale(1)' }, 180);
    holdThenHide(my);
    return;
  }
  show(my);
}

(async () => {
  try {
    await listen('overlay-notify', (e) => toast(e.payload));
    // Beri tahu Rust listener sudah siap supaya notifikasi yang menumpuk selama
    // halaman belum selesai dimuat bisa dikirim.
    await invoke('overlay_ready');
  } catch (e) {
    // Kalau IPC tidak tersedia (mis. dibuka langsung di browser saat dev), diamkan saja.
    console.warn('overlay: tidak bisa listen ke notifikasi', e);
  }
})();
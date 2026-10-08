import { invoke } from "@tauri-apps/api/core";
// State device (dimensi matriks, layer, keymap, binding knob) tinggal di satu modul
// dengan mutator tervalidasi. Nilai di-import sebagai live binding, jadi kode yang
// hanya membaca tidak berubah; kode yang menulis wajib memakai setter dari sana.
// Diparser protokol, semua mutator dipakai dari sana - jadi yang diimpor di sini
// hanya yang masih dipakai oleh render/editor.
import {
  CAP_LAYERS, ROWS, COLS, NUM_ENCODERS, currentLayer, layerCount, maxLayers,
  mapping, layerNames, encConfig,
  setCurrentLayer, setMapping, setLayerNames, resetEncParse,
  ensureEncConfigSize, emptyLayer, reorderLayer, TYPE_NAMES,
} from "./device-state.js";
// Helper DOM dan seluruh logika halaman RGB dipisah ke modul sendiri. Halaman RGB
// membaca state dari device (RGB_DUMP/RGB_KEY), bukan dari default app.
import { el, log, escapeHtml } from "./dom.js";
import {
  rgb, renderRgbAll, initRgbPage, setRgbTransport, hexToRgb,
} from "./rgb-page.js";
// Seluruh urusan port serial (connect/reconnect, buffer baris, framing parser,
// pengiriman perintah) dipisah ke modul sendiri. Yang diimpor di sini hanya yang
// benar-benar dipakai main.js - sisanya dipanggil transport lewat hook initTransport()
// sehingga isi config/layer/preset tidak bocor ke dalam modul transport.
import {
  initTransport, sendLine, sendBatch, connect, disconnect,
  autoDetect, pollPorts, isConnected, isAutoBusy, enableAutoReconnect, deviceWasLost,
} from "./serial-transport.js";
// Adaptive Key Bind: manajemen preset + runtime auto-switch.
import {
  initAdaptive, initAdaptivePage, presetsData, editingPresetId, loadPresets,
  resetAdaptiveRuntimeState, confirmLeavePresetEditor,
} from "./adaptive.js";
// Indikator baterai & charger. Angkanya selalu dari firmware lewat EVT:BATT/EVT:CHG.
import { initBatteryUi, battUI, clearBattery } from "./battery-ui.js";
// Parser protokol: satu baris dari device -> aksi. Kontrak app<->firmware ada di
// sini; main.js hanya menyuntikkan fungsi yang menyentuh layar.
import { initProtocolParser, handleLine, deviceProfile, resetDeviceProfile } from "./protocol-parser.js";
// Notifikasi overlay, modal, dan router halaman. Masing-masing mandiri; modal
// dipakai juga oleh adaptive.js lewat hook initAdaptive().
import { settings, saveSettings, notify, notifyBoundAction } from "./ui-notify.js";
import { showModalBase, showPromptModal, showConfirmModal, clipUtf8 } from "./ui-modal.js";
import { switchPage, initSidebar, initRouter } from "./ui-router.js";
// Picker aplikasi (dipakai juga oleh home-page untuk binding bertipe APP).
import { initAppPicker } from "./app-picker.js";
// Halaman Home: tab layer, grid tombol, daftar knob, panel editor, rekam keyboard.
// Ketiganya satu modul karena saling memanggil (klik sel -> openEditor -> rekam;
// tab -> switchLayer -> loadLayer -> renderGrid); dipisah akan muncul siklus import.
import {
  initHomePage, initEditorPanel,
  renderTabs, renderGrid, renderEncoderList, loadLayer,
  resetEditorState, clearSelection, selected, stopRecordingContinuous,
} from "./home-page.js";
import { initTray, initAutostart, initAutostartToggle, initTrayHandlers } from "./tray.js";
// i18n. await di level modul supaya bahasa selesai ditentukan SEBELUM init*
// mana pun yang merender teks dijalankan - kalau tidak, user akan melihat
// teks dalam bahasa dasar sesaat lalu otomatis berubah.
import { initI18n, initLanguageSelect, registerRerender, t } from "./i18n.js";

await initI18n();
initLanguageSelect(el('languageSelect'));

// Config di device berubah tapi belum disimpan ke flash. Dipakai dialog "Simpan
// dulu?" saat keluar, dan disuntikkan ke home-page lewat initHomePage({ markDirty }).
let dirty = false;

// Profil & kemampuan hardware (HWINFO) sekarang milik protocol-parser.js, karena
// baris HWINFO: yang mengisinya diparse di sana. Badge di bawah membacanya sebagai
// live binding.
function renderDeviceProfileBadge() {
  const b = el('hwProfileBadge'); if (!b) return;
  const sim = deviceProfile.simulated === 1 || battUI.simulated;
  if (!deviceProfile.profile) { b.style.display = 'none'; return; }
  b.style.display = 'inline-flex';
  b.textContent = sim ? `${deviceProfile.profile} - DATA SIMULASI` : deviceProfile.profile;
  b.classList.toggle('sim', !!sim);
  b.title = sim
    ? 'Firmware prototipe mengirim angka simulasi untuk baterai/RGB. Format pesan sama dengan board final, jadi app tidak perlu diubah.'
    : 'Data dibaca langsung dari hardware';
}

function syncGlobalToggles() {
  el('masterEnabledToggle').checked = presetsData.masterEnabled;
  if (el('globalAdaptiveToggle')) el('globalAdaptiveToggle').checked = presetsData.masterEnabled;
  if (el('globalRgbToggle')) el('globalRgbToggle').checked = rgb.enabled;
  // Firmware belum punya perintah sleep sama sekali, jadi kontrol ini dikunci
  // dengan penjelasan. Sebelumnya di-enable tapi tanpa handler, jadi user
  // bisa memilih nilai lalu replikasi terjadi diam-diam tanpa efek apa pun.
  const sleepSel = el('sleepTimeoutSelect');
  if (sleepSel) {
    sleepSel.disabled = true;
    sleepSel.title = 'Belum didukung firmware (perintah sleep belum ada)';
  }
}

// ==================== SAMBUNGKAN MODUL LAIN ====================

// adaptive.js tidak memanggil fungsi main.js secara langsung - navigasi halaman,
// modal, notifikasi, dan flag "belum disimpan" semuanya disuntikkan di sini.
initAdaptive({
  switchPage,
  showConfirmModal,
  showPromptModal,
  showModalBase,
  notify,
  resetEditorState,
  isDirty: () => dirty,
  setDirty: (v) => { dirty = !!v; },
});
// Indikator baterai butuh notify() untuk peringatan ambang (batt-low / batt-crit).
initBatteryUi(notify);

// Router butuh dua hal dari adaptive: saat mode edit preset, pindah halaman berarti
// meninggalkan draft. Hook-nya dipasang lebih dulu, karena initSidebar() yang
// memasang pen-klik sidebar memakainya.
initRouter({
  confirmLeavePresetEditor: () => confirmLeavePresetEditor(),
  editingPreset: () => !!editingPresetId,
});
initSidebar();

// Halaman Home dan picker aplikasi. initHomePage() hanya butuh penanda "belum
// tersimpan" - isi editor dan grid semuanya milik modul itu sendiri.
initHomePage({ markDirty: () => { dirty = true; } });
initEditorPanel();
initAppPicker();

// Tray & autostart. initTray() menyuntikkan flag "belum tersimpan" supaya modul tray
// tidak perlu menyimpan salinannya.
initTray({ isDirty: () => dirty, setDirty: (v) => { dirty = !!v; } });
initAutostartToggle();
initAutostart();
initTrayHandlers();

// Parser protokol hanya boleh menyentuh layar lewat fungsi yang disuntikkan di
// sini. Segala sesuatu yang lain (device-state, transport, adaptive, rgb, battery)
// ia impor langsung, jadi daftar ini hanya berisi fungsi render/notify.
initProtocolParser({
  notify,
  notifyBoundAction,
  renderDeviceProfileBadge,
  renderTabs,
  renderGrid,
  renderEncoderList,
  loadLayer,
});

// ==================== SAMBUNGKAN TRANSPORT ====================
// serial-transport.js tidak tahu apa pun soal isi config, layer, atau preset, dan
// juga tidak memanggil fungsi main.js secara langsung. Semua sisi aplikasi
// disuntikkan di sini - titik pertemuan tunggal antara transport dan app.
initTransport({
  // Setiap baris dari device berakhir di protocol-parser.js. Transport hanya
  // hanya pemisah baris; ia tidak tahu apa arti baris-baris itu.
  onLine: (line) => handleLine(line),
  onConnected: () => {
    // deviceWasLost sudah di-reset oleh transport (atau oleh disconnect manual)
    // sebelum hook ini dipanggil - jadi yang perlu dibaca di sini hanya nilainya.
    notify(deviceWasLost ? 'Terhubung kembali' : 'Terhubung ke companion', 'connect');
    switchPage('home');   // Home selalu tampil saat pertama kali connect
  },
  onDisconnected: () => {
    // Jangan biarkan angka device sebelumnya tertinggal di UI setelah putus: profile
    // (dan badge SIMULASI) serta meter baterai harus ikut kosong, kalau tidak user
    // mengira device masih hidup dan tegangan terkahoir.
    resetDeviceProfile();
    clearBattery();
    renderDeviceProfileBadge();
  },
  // Saat koneksi putus, state yang BARU BOLEH ada di device hilang sekalian -
  // tidak ada yang perlu "menunggu upload", karena isi RAM device ikut hilang.
  // Yang tersisa hanya state lokal app (preset, editor, daftar aplikasi).
  onDeviceLost: () => {
    resetAdaptiveRuntimeState();
    resetEditorState();
  },
  clearDirty: () => { dirty = false; },
  notify: (text, kind) => notify(text, kind),
  onAutoConnectOk: () => { },
  onAutoConnectFail: () => { },
});
el('btnRefreshPorts').onclick = autoDetect;
el('btnConnect').onclick = () => {
  if (isConnected()) { disconnect(true); return; }
  if (isAutoBusy()) { log('[AUTO] Sedang mencari device, tunggu sebentar...'); return; }
  enableAutoReconnect();
  connect();
};
el('btnRefresh').onclick = () => loadLayer(currentLayer);
el('btnSave').onclick = () => { dirty = false; sendLine('SAVE'); };
el('btnReset').onclick = async () => {
  if (await showConfirmModal('Reset config', 'Reset semua config ke default? (Belum permanen sampai klik Save)', 'Reset')) {
    dirty = true;
    sendLine('RESET').then(() => sendLine('INFO'));
  }
};
el('btnAddLayer').onclick = async () => { dirty = true; await sendLine('ADDLAYER'); setTimeout(() => sendLine('INFO'), 200); };
el('btnDelLayer').onclick = async () => {
  const name = layerNames[currentLayer] || ('Layer ' + currentLayer);
  if (!(await showConfirmModal('Delete layer', `Hapus "${name}"? Semua mapping di layer ini akan hilang.`, 'Delete'))) return;
  dirty = true;
  await sendLine('DELLAYER'); setTimeout(() => sendLine('INFO'), 200);
};
el('btnRenameLayer').onclick = async () => {
  const current = layerNames[currentLayer] || ('Layer ' + currentLayer);
  const name = await showPromptModal('Rename Layer', 'Nama baru untuk layer ini:', current);
  if (name !== null && name.trim() !== '') {
    dirty = true;
    sendLine(`RENAMELAYER:${currentLayer}:${name.trim()}`).then(() => setTimeout(() => sendLine('DUMPNAMES'), 200));
  }
};
el('btnCancel').onclick = () => { stopRecordingContinuous(); el('editPanel').style.display = 'none'; clearSelection(); };
el('btnApply').onclick = async () => {
  if (!selected) return;
  stopRecordingContinuous();
  dirty = true;
  const type = TYPE_NAMES[parseInt(el('editType').value)];
  const value = el('editValue').value;
  if (selected.kind === 'key') {
    await sendLine(`SET:${currentLayer}:${selected.r}:${selected.c}:${type}:${value}`);
    setTimeout(() => loadLayer(currentLayer), 300);
  } else {
    await sendLine(`SETENC:${selected.idx}:${selected.which}:${type}:${value}`);
    setTimeout(() => sendLine('DUMPENC'), 300);
  }
  el('editPanel').style.display = 'none';
};

renderTabs(); renderGrid(); renderEncoderList();
autoDetect();
// initAdaptivePage() memasang kontrol preset (tambah/rename/hapus, tombol Done/Cancel
// editor) DAN memulai polling window foreground. Kalau ini terlewat, daftar preset
// tetap tampil tapi tidak pernah auto-switch.
initAdaptivePage();
loadPresets();

// ==================== PAGE SETTING ====================
el('notifyBasicToggle').checked = settings.notifyBasic;
el('notifyKeysToggle').checked = settings.notifyKeys;
el('notifyBasicToggle').onchange = e => { settings.notifyBasic = e.target.checked; saveSettings(); };
el('notifyKeysToggle').onchange = e => { settings.notifyKeys = e.target.checked; saveSettings(); };
el('notifyBatteryToggle').checked = settings.notifyBattery;
el('notifyBatteryToggle').onchange = e => { settings.notifyBattery = e.target.checked; saveSettings(); };
el('globalAdaptiveToggle').checked = presetsData.masterEnabled;
el('globalAdaptiveToggle').onchange = (e) => {
  presetsData.masterEnabled = e.target.checked;
  // Jangan ditelan diam-diam: kalau gagal, user mengira toggle tersimpan padahal
  // akan kembali ke nilai lama setelah app ditutup.
  invoke('presets_save', { data: presetsData })
    .catch(err => log('[ERROR] Gagal menyimpan setting adaptive: ' + err, 'err'));
  syncGlobalToggles();
};
el('btnTestNotif').onclick = () => notify('Tes notifikasi', 'connect', { force: true });
setInterval(pollPorts, 2000);

// Halaman RGB di-wire di dalam modusnya sendiri; transport serial disuntikkan supaya
// tidak ada import bolak-balik antara main.js dan rgb-page.js.
setRgbTransport(sendLine);
initRgbPage();
renderRgbAll(); syncGlobalToggles();


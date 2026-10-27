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
// Transport device lewat facade, bukan langsung ke serial-transport.js.
// Facade meneruskan ke backend yang sedang aktif (USB atau BLE), jadi perintah
// di bawah ikut ke device yang benar tanpa perlu tahu mana yang sedang hidup.
import {
  initTransport, sendLine, sendBatch, connect, disconnect,
  poll, isConnected, isAutoBusy, enableAutoReconnect, deviceWasLost,
  updateConnectButton, setPendingTransportHooks, initActiveBackend,
  setTransportBackend, transportId, lastTransport, rememberTransport,
  refreshUsbPorts,
} from "./transport.js";
import {
  startAutoConnect, pauseAutoConnect, resumeAutoConnect,
  setPreferredTransport, isAutoConnectPaused, isAutoConnectBusy,
} from "./connection-manager.js";
// Adaptive Key Bind: manajemen preset + runtime auto-switch.
import {
  initAdaptive, initAdaptivePage, presetsData, editingPresetId, loadPresets,
  resetAdaptiveRuntimeState, resetAdaptiveOnConnect, confirmLeavePresetEditor,
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
// Soundboard: manajemen suara + playback lewat audio engine Rust.
import { initSoundPicker } from "./soundboard.js";
// Panel audio Settings: routing CABLE/monitor, mic, meter, diagnostik.
import { initAudioPanel } from "./audio-panel.js";
// Halaman Home: tab layer, grid tombol, daftar knob, panel editor, rekam keyboard.
// Ketiganya satu modul karena saling memanggil (klik sel -> openEditor -> rekam;
// tab -> switchLayer -> loadLayer -> renderGrid); dipisah akan muncul siklus import.
import {
  initHomePage, initEditorPanel,
  renderTabs, renderGrid, renderEncoderList, loadLayer,
  resetEditorState, selected, stopRecordingContinuous, cancelEditor,
} from "./home-page.js";
import { initTray, initAutostart, initAutostartToggle, initTrayHandlers } from "./tray.js";
// i18n. await di level modul supaya bahasa selesai ditentukan SEBELUM init*
// mana pun yang merender teks dijalankan - kalau tidak, user akan melihat
// teks dalam bahasa dasar sesaat lalu otomatis berubah.
import { initI18n, initLanguageSelect, registerRerender, t } from "./i18n.js";
// Watchdog paint. Diimpor terakhir supaya side effect-nya (laporan ke Rust)
// secepat mungkin terjadi. Lihat paint-watch.js untuk penjelasan kenapa
// jendela utama bisa putih padahal JS di dalamnya berjalan.
import "./paint-watch.js";

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
  b.textContent = sim ? t('main.profileSim', { profile: deviceProfile.profile }) : deviceProfile.profile;
  b.classList.toggle('sim', !!sim);
  b.title = sim
    ? t('main.simDataWarn')
    : t('main.simDataTitle');
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
    sleepSel.title = t('main.sleepUnavailable');
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
  // Dipakai setelah preset aktif: muat ulang isi layer supaya grid ikut
  // berubah. Tanpa ini grid tetap menampilkan keymap preset sebelumnya -
  // preset sudah aktif di device, tapi layarnya belum.
  loadLayer,
  getDeviceProfile: () => deviceProfile,
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
initSoundPicker();

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
// Backend transport (USB atau BLE) tidak tahu apa pun soal isi config, layer,
// atau preset, dan juga tidak memanggil fungsi main.js secara langsung. Semua
// sisi aplikasi disuntikkan di sini - titik pertemuan tunggal antara transport
// dan app. Hook disimpan dulu di facade supaya backend yang diganti
// (mis. user pilih BLE) juga menerimanya, bukan cuma backend awal.
//
// Selector transport diambil di sini (bukan di blok UI bawah) supaya hook
// onConnected bisa menyamakannya dengan backend yang baru aktif.
const transportSel = el('transportSelect');
// True selama handler UI sedang mengganti backend. Tombol Connect dan handler
// lain menolak berjalan di tengah switch supaya tidak connect ke backend lama.
let transportSwitching = false;
setPendingTransportHooks({
  // Setiap baris dari device berakhir di protocol-parser.js. Transport hanya
  // hanya pemisah baris; ia tidak tahu apa arti baris-baris itu.
  onLine: (line) => handleLine(line),
  onConnected: () => {
    // deviceWasLost sudah di-reset oleh transport (atau oleh disconnect manual)
    // sebelum hook ini dipanggil - jadi yang perlu dibaca di sini hanya nilainya.
    //
    // Reset state adaptif selektif: hanya app-side cache (slotTable,
    // currentActivePresetId, focusedExeLast) yang mencerminkan RAM device yang
    // memang hilang tiap (re)connect. frameUsable dan layer terakhir dibiarkan
    // agar tidak memaksa ulang queryFrameSlots() (yang akan crash pada prototipe
    // USB karena Tauri serial plugin tidak menerima Uint8Array di sendRaw).
    resetAdaptiveOnConnect();
    notify(deviceWasLost() ? t('main.reconnectedNotif') : t('main.connectedNotif'), 'connect');
    switchPage('home');   // Home selalu tampil saat pertama kali connect
    // Ingat transport yang BENAR-BENAR berhasil, bukan sekadar pilihan
    // dropdown. Nilai ini yang dipakai startup berikutnya sebagai prioritas.
    rememberTransport(transportId());
    setPreferredTransport(transportId());
    syncTransportUi();
  },
  onDisconnected: () => {
    // Jangan biarkan angka device sebelumnya tertinggal di UI setelah putus: profile
    // (dan badge SIMULASI) serta meter baterai harus ikut kosong, kalau tidak user
    // mengira device masih hidup dan tegangan terkahoir.
    resetDeviceProfile();
    clearBattery();
    renderDeviceProfileBadge();
    // Selama loop auto-connect masih aktif, status jangan berhenti di "Tidak
    // tersambung": device mungkin hanya belum dicolok. Kecuali user sengaja
    // memutus (autoHold), di mana "tidak tersambung" memang jawaban akhir.
    if (!isAutoConnectPaused()) setSearchingStatus(true);
  },
  // Saat koneksi putus, state yang BARU BOLEH ada di device hilang sekalian -
  // tidak ada yang perlu "menunggu upload", karena isi RAM device ikut hilang.
  // Yang tersisa hanya state lokal app (preset, editor, daftar aplikasi).
  onDeviceLost: () => {
    resetAdaptiveRuntimeState();
    resetEditorState();
  },
  // Dump menggantung: parser sempat menganggap semua respons sebagai isi dump.
  // Minta render ulang supaya grid dan badge kembali sinkron dengan device.
  onDumpStuck: () => {
    renderGrid();
    renderTabs();
    renderEncoderList();
    renderDeviceProfileBadge();
  },
  clearDirty: () => { dirty = false; },
  notify: (text, kind) => notify(text, kind),
  onAutoConnectOk: () => { },
  onAutoConnectFail: () => { },
});
// Pasang hook ke backend yang aktif sekarang (default USB). Kalau user nanti
// ganti ke BLE, facade memasang ulang hook yang sama di backend BLE.
initActiveBackend();

// ---- Status & selector transport ----
// Satu sumber untuk menyamakan dropdown dengan backend yang benar-benar aktif.
// Dipanggil saat startup, setiap kali manager berpindah backend, dan saat
// onConnected. Tanpa ini, panel manual bisa menampilkan BLE padahal backend
// yang aktif masih USB (atau sebaliknya).
function syncTransportUi() {
  if (!transportSel) return;
  transportSel.value = transportId();
  const isBle = transportSel.value === 'ble';
  const bleRow = el('bleRow');
  if (bleRow) bleRow.style.display = isBle ? '' : 'none';
  const usbRow = el('usbRow');
  if (usbRow) usbRow.style.display = isBle ? 'none' : '';
  const usbLabel = el('usbPortLabel');
  if (usbLabel) usbLabel.style.display = isBle ? 'none' : '';
}

// Status selama loop masih mencari device. Jangan menimpa status "Tersambung".
function setSearchingStatus(on) {
  if (isConnected()) return;
  const status = el('statusText');
  if (status) status.textContent = on ? t('auto.searchingStatus') : t('transport.notConnected');
}

el('btnRefreshPorts').onclick = async () => {
  if (transportSwitching || isAutoConnectBusy() || isAutoBusy()) {
    log(t('transport.autoBusy'));
    return;
  }
  transportSwitching = true;
  try {
    // Refresh USB = user minta transport USB. Jadikan prioritas dan biarkan
    // manager yang memprobe; enumerasi murah dilakukan lebih dulu supaya
    // dropdown langsung terisi.
    pauseAutoConnect();
    setPreferredTransport('usb');
    if (transportId() !== 'usb') {
      await setTransportBackend('usb');
      syncTransportUi();
      updateConnectButton(isConnected());
    }
    await refreshUsbPorts();
  } catch (e) {
    log(t('transport.portListError', { err: e }), 'err');
  } finally {
    // Kalau enumerasi/ganti backend gagal, loop tetap harus hidup lagi.
    transportSwitching = false;
    resumeAutoConnect();
  }
};

// Label tombol sambung/putus berasal dari JS (berubah sesuai status koneksi),
// jadi applyI18n() akan menimpanya dengan teks statis setiap kali user ganti
// bahasa. Daftarkan render ulang agar label ikut diterjemahkan DAN tetap
// mencerminkan status koneksi yang sedang berjalan.
registerRerender(() => updateConnectButton(isConnected()));
el('btnConnect').onclick = async () => {
  if (transportSwitching) {
    log(t('transport.autoBusy'));
    return;
  }
  if (isConnected()) {
    // Disconnect manual = user sengaja memutus. Jeda loop supaya device tidak
    // langsung tersambung lagi sebelum user memintanya.
    pauseAutoConnect();
    await disconnect(true);
    return;
  }
  if (isAutoBusy() || isAutoConnectBusy()) {
    log(t('transport.autoBusy'));
    return;
  }
  const id = transportId();
  setPreferredTransport(id);
  pauseAutoConnect();          // cegah loop menyalip percobaan manual ini
  enableAutoReconnect();
  try {
    await connect();
  } catch (e) {
    log(t('main.connectError', { err: e }), 'err');
  } finally {
    // Berhasil -> loop hanya memantau; gagal -> loop lanjut ke prioritas
    // berikutnya tanpa menunggu user menekan tombol lagi.
    resumeAutoConnect();
  }
};

// ---- Pemilih transport (USB / BLE) ----
// Backend BLE dimuat lewat import() dinamis di facade dan di-cache. Modul baru
// diunduh saat user memilih BLE atau saat manager memprobe BLE sebagai fallback;
// probe tidak mengaktifkan backend-nya.
if (transportSel) {
  transportSel.innerHTML = '';
  for (const opt of [
    { id: 'usb', label: t('header.transportUsb') },
    { id: 'ble', label: t('header.transportBle') },
  ]) {
    const o = document.createElement('option');
    o.value = opt.id; o.textContent = opt.label;
    transportSel.appendChild(o);
  }
  // Nilai awal harus dipasang SEBELUM onchange dipasang. Kalau dibalik,
  // menugaskan .value memicu event 'change' dan menjalankan onchange - sehingga
  // pencarian berjalan dua kali: sekali dari inisialisasi, sekali dari klik user.
  transportSel.value = transportId();

  transportSel.onchange = async () => {
    const id = transportSel.value;
    // Jangan ganti backend di tengah probe/connect: backend lama bisa
    // diputus saat connect sedang berjalan. Kembalikan dropdown ke backend
    // yang benar-benar aktif.
    if (transportSwitching || isAutoConnectBusy() || isAutoBusy()) {
      log(t('transport.autoBusy'));
      transportSel.value = transportId();
      return;
    }
    transportSwitching = true;
    try {
      // Pilihan user adalah override: hentikan loop sebentar supaya tidak
      // berebut, lalu mulai lagi dengan transport ini sebagai prioritas.
      // Scan/probe tetap dilakukan manager - bukan langsung di handler ini -
      // supaya hanya ada satu pemilik siklus connect.
      pauseAutoConnect();
      setPreferredTransport(id);
      await setTransportBackend(id);
      syncTransportUi();
      updateConnectButton(isConnected());
    } catch (e) {
      log(t('main.transportSwitchError', { err: e }), 'err');
      transportSel.value = transportId();   // kembalikan ke yang benar-benar aktif
    } finally {
      transportSwitching = false;
      resumeAutoConnect();
    }
  };
  syncTransportUi();

  // Pulihkan transport terakhir yang SUKSES sebagai titik awal. Backend
  // benar-benar dipindah sekarang supaya dropdown dan backend tidak berbeda;
  // manager yang akan mencoba connect (dan fallback) setelah ini.
  const savedTransport = lastTransport();
  if ((savedTransport === 'usb' || savedTransport === 'ble') && savedTransport !== transportId()) {
    try {
      await setTransportBackend(savedTransport);
      syncTransportUi();
      updateConnectButton(isConnected());
    } catch (e) {
      log(t('main.transportSwitchError', { err: e }), 'err');
    }
  }
}
const btnRefreshBle = el('btnRefreshBle');
if (btnRefreshBle) {
  btnRefreshBle.onclick = async () => {
    if (transportSwitching || isAutoConnectBusy() || isAutoBusy()) {
      log(t('transport.autoBusy'));
      return;
    }
    transportSwitching = true;
    try {
      // Refresh BLE = user minta transport BLE. Jadikan prioritas dan biarkan
      // manager yang memindai + menyambung (jalur yang sama dengan startup).
      pauseAutoConnect();
      setPreferredTransport('ble');
      if (transportId() !== 'ble') {
        await setTransportBackend('ble');
        syncTransportUi();
        updateConnectButton(isConnected());
      }
    } catch (e) {
      log(t('ble.scanError', { err: e }), 'err');
    } finally {
      // Ganti backend bisa gagal (mis. modul BLE tidak termuat); loop tetap
      // harus hidup lagi supaya fallback USB tidak ikut mati.
      transportSwitching = false;
      resumeAutoConnect();
    }
  };
}
el('btnRefresh').onclick = () => loadLayer(currentLayer);
el('btnSave').onclick = () => { dirty = false; sendLine('SAVE'); };
el('btnReset').onclick = async () => {
  if (await showConfirmModal(t('main.resetTitle'), t('main.resetMsg'), t('main.resetConfirm'))) {
    dirty = true;
    sendLine('RESET').then(() => sendLine('INFO'));
  }
};
el('btnAddLayer').onclick = async () => { dirty = true; await sendLine('ADDLAYER'); setTimeout(() => sendLine('INFO'), 200); };
el('btnDelLayer').onclick = async () => {
  const name = layerNames[currentLayer] || ('Layer ' + currentLayer);
  if (!(await showConfirmModal(t('main.deleteLayerTitle'), t('main.deleteLayerMsg', { name }), t('main.deleteConfirm')))) return;
  dirty = true;
  await sendLine('DELLAYER'); setTimeout(() => sendLine('INFO'), 200);
};
el('btnRenameLayer').onclick = async () => {
  const current = layerNames[currentLayer] || ('Layer ' + currentLayer);
  const name = await showPromptModal(t('main.renameTitle'), t('main.renameLabel'), current);
  if (name !== null && name.trim() !== '') {
    dirty = true;
    sendLine(`RENAMELAYER:${currentLayer}:${name.trim()}`).then(() => setTimeout(() => sendLine('DUMPNAMES'), 200));
  }
};
el('btnCancel').onclick = cancelEditor;
el('btnApply').onclick = async () => {
  if (!selected) return;
  stopRecordingContinuous();
  dirty = true;
  let type = TYPE_NAMES[parseInt(el('editType').value)];
  let value = el('editValue').value;
  // Type SOUND (6) dikonversi ke APP (5) + prefix "SOUND:" di value.
  // Firmware tidak perlu tahu; device kirim EVT:APP:SOUND:<id> yang ditangkap.
  if (parseInt(el('editType').value) === 6) {
    type = 'APP';
    if (!value.startsWith('SOUND:')) value = 'SOUND:' + value;
  }
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
// Auto-connect lintas transport: prioritas transport terakhir yang sukses,
// lalu fallback ke transport lain. Manager yang memegang retry, jadi tidak ada
// dua jalur yang menyambung bersamaan. Loop tetap berjalan selama belum ada
// device - app boleh aktif lebih dulu, device dicolok belakangan.
startAutoConnect({
  onTransportChange: syncTransportUi,
  onSearching: setSearchingStatus,
});
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
    .catch(err => log(t('main.adaptiveSaveError', { err }), 'err'));
  syncGlobalToggles();
};
// Audio panel (test tone, CABLE status, mic passthrough) in Settings.
initAudioPanel().catch(e => console.error('[main] initAudioPanel failed:', e));
el('btnTestNotif').onclick = () => notify(t('main.testNotif'), 'connect', { force: true });
// Poll lewat facade, bukan pollPorts: backend aktif yang memutuskan apa yang
// dipantau (port COM untuk USB, status GATT untuk BLE).
setInterval(() => { poll(); }, 2000);

// Halaman RGB di-wire di dalam modusnya sendiri; transport serial disuntikkan supaya
// tidak ada import bolak-balik antara main.js dan rgb-page.js.
setRgbTransport(sendLine);
initRgbPage();
renderRgbAll(); syncGlobalToggles();


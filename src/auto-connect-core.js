// ==================== AUTO-CONNECT CORE ====================
//
// Logika murni untuk memilih dan mencoba transport. File ini sengaja TIDAK
// meng-import transport, Tauri, atau DOM apa pun. Seluruh efek samping (probe,
// connect, ganti backend, log) disuntikkan lewat `deps`, sehingga urutan
// prioritas, backoff, dan aturan "manual hold" bisa diuji tanpa membuka port
// atau menjalankan Tauri.
//
// Satu instance = satu pemilik siklus auto-connect. Semua jalur (startup,
// reconnect setelah putus, fallback antar transport) lewat sini supaya tidak
// ada dua percobaan connect yang saling menabrak.
//
// Kontrak deps:
//   probeUsb()                  -> path port atau null
//   probeBle()                  -> { id, name } atau null
//   connect(target)             -> boolean
//   isConnected()               -> boolean
//   isAutoBusy()                -> boolean (opsional)
//   setTransportBackend(id)     -> Promise
//   transportId()               -> 'usb' | 'ble'
//   enableAutoReconnect()       -> void
//   lastTransport()             -> 'usb' | 'ble' | null
//   rememberTransport(id)       -> void
//   markPortFailed(path)        -> void (opsional)
//   log(text, kind?)            -> void
//   t(key, vars?)               -> string
//   now()                       -> ms (opsional, untuk test)
//   setTimeout/clearTimeout     -> timer (opsional, untuk test)
//   immediateStart              -> boolean (opsional, false untuk test)

export const DEFAULT_AUTO_CONNECT_TIMINGS = {
  usbIntervalMs: 2000,
  usbRetryMs: 400,
  bleBaseMs: 5000,
  bleMaxMs: 20000,
  bleRetryMs: 1500,
  idleMs: 400,
  connectedCheckMs: 2000,
  failLogMs: 60000,
};

const noop = () => { };
const fallbackT = (key) => key;

export function createAutoConnectManager(deps, timings = {}) {
  const cfg = { ...DEFAULT_AUTO_CONNECT_TIMINGS, ...timings };
  const d = {
    probeUsb: deps.probeUsb,
    probeBle: deps.probeBle,
    connect: deps.connect,
    isConnected: deps.isConnected,
    isAutoBusy: deps.isAutoBusy || (() => false),
    setTransportBackend: deps.setTransportBackend || (async () => { }),
    transportId: deps.transportId || (() => 'usb'),
    enableAutoReconnect: deps.enableAutoReconnect || noop,
    lastTransport: deps.lastTransport || (() => null),
    rememberTransport: deps.rememberTransport || noop,
    markPortFailed: deps.markPortFailed || noop,
    log: deps.log || noop,
    t: deps.t || fallbackT,
    now: deps.now || (() => Date.now()),
    setTimeout: deps.setTimeout || ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: deps.clearTimeout || ((h) => clearTimeout(h)),
    delay: deps.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    immediateStart: deps.immediateStart !== false,
  };

  let running = false;
  let hold = false;
  let ticking = false;
  let connecting = false;
  let probing = false;
  let generation = 0;
  let timer = null;
  let preferred = null;
  let nextUsb = 0;
  let nextBle = 0;
  let bleDelay = cfg.bleBaseMs;
  let lastFailLogAt = 0;
  let searchLogged = false;
  let searching = false;
  let onTransportChange = noop;
  let onSearching = noop;

  const transportLabel = (id) => (id === 'usb' ? 'USB' : 'BLE');

  function getPreferred() {
    return preferred || d.lastTransport() || 'usb';
  }

  function setPreferred(id) {
    if (id === 'usb' || id === 'ble') preferred = id;
  }

  function isPaused() { return hold; }
  function isBusy() { return connecting || probing; }

  function setSearching(value) {
    if (searching === value) return;
    searching = value;
    try { onSearching(value); } catch (e) { /* UI tidak boleh menghentikan loop */ }
  }

  function clearTimer() {
    if (timer == null) return;
    try { d.clearTimeout(timer); } catch (e) { /* best-effort */ }
    timer = null;
  }

  function schedule(ms) {
    clearTimer();
    timer = d.setTimeout(() => { timer = null; void tick(); }, Math.max(0, ms));
  }

  function resetSchedule() {
    nextUsb = 0;
    nextBle = 0;
    bleDelay = cfg.bleBaseMs;
    searchLogged = false;
    lastFailLogAt = 0;
  }

  // Coba aktifkan satu transport. Dipanggil hanya setelah probe menemukan
  // device. Generation + hold dicek lagi SETELAH setTransportBackend(), karena
  // user bisa menekan Disconnect/Connect manual saat await itu berjalan.
  async function activate(id, target, gen) {
    if (!running || hold || gen !== generation || d.isConnected()) return false;
    connecting = true;
    try {
      d.log(d.t('auto.connecting', { transport: transportLabel(id) }), null);
      if (d.transportId() !== id) {
        try {
          await d.setTransportBackend(id);
        } finally {
          // Kalau backend sempat berpindah lalu initTransport() melempar,
          // dropdown tetap harus menampilkan backend yang benar-benar aktif.
          if (d.transportId() === id) {
            try { onTransportChange(id); } catch (e) { /* UI opsional */ }
          }
        }
      }

      if (!running || hold || gen !== generation || d.isConnected()) return false;
      d.enableAutoReconnect();

      let ok;
      if (id === 'usb') {
        ok = await d.connect(target);
        if (!ok) {
          // Paritas dengan jalur USB yang sudah terbukti: satu percobaan
          // kedua setelah jeda singkat (Windows kadang belum melepas handle
          // port tepat setelah probe).
          await d.delay(cfg.usbRetryMs);
          if (!running || hold || gen !== generation || d.isConnected()) return false;
          ok = await d.connect(target);
        }
      } else {
        const deviceId = target && target.id ? target.id : target;
        ok = await d.connect(deviceId);
        if (!ok) {
          // Windows butuh waktu melepas link GATT setelah percobaan pertama;
          // 400 ms tidak cukup (lihat catatan di tryAutoConnect BLE). Jeda
          // 1,5 dtk lalu coba sekali lagi, sama seperti jalur manual.
          await d.delay(cfg.bleRetryMs);
          if (!running || hold || gen !== generation || d.isConnected()) return false;
          ok = await d.connect(deviceId);
        }
      }

      if (ok || d.isConnected()) {
        preferred = id;
        d.rememberTransport(id);
        bleDelay = cfg.bleBaseMs;
        searchLogged = false;
        setSearching(false);
        d.log(d.t('auto.connected', { transport: transportLabel(id) }), 'ok');
        return true;
      }

      // Port USB yang sudah di-probe tapi gagal connect harus dicoba lagi di
      // putaran berikutnya; tanpa ini port itu dianggap "sudah dikenal" dan
      // tidak pernah diprobe ulang.
      if (id === 'usb') d.markPortFailed(target);
      d.log(d.t('auto.connectFail', { transport: transportLabel(id) }), 'err');
      return false;
    } finally {
      connecting = false;
    }
  }

  function runStopResult() {
    if (!running || hold) return { next: 0, paused: true };
    if (d.isConnected()) return { next: cfg.connectedCheckMs, connected: true };
    return { next: cfg.idleMs, superseded: true };
  }

  async function runOnce() {
    if (!running || hold) return { next: 0, paused: true };

    if (d.isConnected()) {
      setSearching(false);
      searchLogged = false;
      return { next: cfg.connectedCheckMs, connected: true };
    }

    if (d.isAutoBusy() || isBusy()) return { next: cfg.idleMs, busy: true };

    setSearching(true);
    if (!searchLogged) {
      d.log(d.t('auto.searchStart'));
      searchLogged = true;
      lastFailLogAt = d.now();
    }

    const gen = generation;
    const order = getPreferred() === 'ble' ? ['ble', 'usb'] : ['usb', 'ble'];
    let probed = false;

    for (const id of order) {
      if (!running || hold || gen !== generation || d.isConnected()) {
        return runStopResult();
      }

      const due = id === 'usb' ? d.now() >= nextUsb : d.now() >= nextBle;
      if (!due) continue;

      probed = true;
      if (id === 'usb') {
        nextUsb = d.now() + cfg.usbIntervalMs;
      } else {
        nextBle = d.now() + bleDelay;
        bleDelay = Math.min(bleDelay * 2, cfg.bleMaxMs);
      }

      let target = null;
      probing = true;
      try {
        target = id === 'usb' ? await d.probeUsb() : await d.probeBle();
      } catch (e) {
        d.log(d.t('auto.probeError', { err: e }), 'err');
      } finally {
        probing = false;
      }

      if (!running || hold || gen !== generation || d.isConnected()) {
        return runStopResult();
      }
      if (!target) continue;

      if (await activate(id, target, gen)) {
        return { next: cfg.connectedCheckMs, connected: true };
      }
    }

    if (d.now() - lastFailLogAt > cfg.failLogMs) {
      lastFailLogAt = d.now();
      d.log(d.t('auto.waiting'));
    }

    // Kalau baru saja memprobe, jadwalkan putaran cepat; kalau semua belum
    // jatuh tempo, tidur sampai jadwal probe terdekat. Keduanya dibatasi
    // idleMs supaya perubahan state manual tetap cepat terlihat.
    let next = cfg.idleMs;
    if (!probed) {
      const now = d.now();
      const dueUsb = nextUsb > now ? nextUsb - now : 0;
      const dueBle = nextBle > now ? nextBle - now : 0;
      const earliest = Math.min(dueUsb, dueBle);
      next = Math.max(cfg.idleMs, earliest || cfg.idleMs);
    }
    return { next };
  }

  async function tick() {
    if (ticking) { schedule(cfg.idleMs); return; }
    ticking = true;
    let result = { next: cfg.idleMs };
    try {
      result = await runOnce();
    } catch (e) {
      d.log(String(e), 'err');
    } finally {
      ticking = false;
      if (running && !hold) schedule(result.next || cfg.idleMs);
    }
  }

  function start(opts = {}) {
    if (opts.onTransportChange) onTransportChange = opts.onTransportChange;
    if (opts.onSearching) onSearching = opts.onSearching;
    running = true;
    hold = false;
    generation++;
    clearTimer();
    resetSchedule();
    setSearching(false);
    if (d.immediateStart) void tick();
    else schedule(0);
    return api;
  }

  // User sengaja memutus / memilih sesuatu: hentikan loop sampai resume().
  // generation++ membatalkan percobaan yang sedang menunggu await.
  function pause() {
    hold = true;
    generation++;
    clearTimer();
    setSearching(false);
  }

  function resume() {
    if (!running) return start();
    hold = false;
    generation++;
    clearTimer();
    resetSchedule();
    if (d.immediateStart) void tick();
    else schedule(0);
    return api;
  }

  function stop() {
    running = false;
    hold = true;
    generation++;
    clearTimer();
    setSearching(false);
  }

  const api = {
    start,
    pause,
    resume,
    stop,
    setPreferred,
    getPreferred,
    isPaused,
    isBusy,
    // Test memakai ini untuk menjalankan satu putaran tanpa timer nyata.
    runOnceForTest: runOnce,
  };
  return api;
}

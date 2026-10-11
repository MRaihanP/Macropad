// Stub untuk @tauri-apps/api/* dan tauri-plugin-serialplugin.
// Dipakai startup-smoke-test.mjs untuk memuat src/main.js tanpa runtime Tauri.

const S = globalThis.__TauriStub;
S.serialConstructed = 0;
S.invoked = {};

const track = (name) => { S.invoked[name] = (S.invoked[name] || 0) + 1; };

export const invoke = async (cmd) => {
  S.invokeCalls.push(cmd);
  track(cmd);
  // Kalau test-provided override ada, pakai itu. Dipakai i18n-test.mjs untuk
  // mengatur nilai balik `system_locale` (locale Windows) per skenario.
  if (typeof S.invokeImpl === 'function') {
    const custom = await S.invokeImpl(cmd);
    if (custom !== undefined) return custom;
  }
  switch (cmd) {
    case 'presets_get': return { masterEnabled: true, presets: [] };
    case 'scan_bindable_apps': return [];
    case 'apps_get': return [];
    case 'get_foreground_exe': return 'code.exe';
    case 'launch_app': return 'ok';
    // Tanpa bahasa Windows di lingkungan test, null membuat jalur fallback diuji.
    case 'system_locale': return S.systemLocale ?? null;
    default: return null;
  }
};

export const listen = async () => () => { };
export const emit = async () => { };
export const getCurrentWindow = () => ({ onCloseRequested() { }, close() { }, show() { }, hide() { } });
export const openUrl = async () => { };

export const SerialPort = class {
  constructor(opts) {
    S.serialConstructed++;
    this.opts = opts;
    this._regs = [];
    this.isOpen = false;
    this.closed = false;
  }
  async open() { this.isOpen = true; }
  async close() { this.closed = true; this.isOpen = false; }
  async setDataTerminalReady() { }
  async setRequestToSend() { }
  async startListening() { }
  async stopListening() { }
  async write(s) { S.lastWrite = s; }
  async listen(cb) {
    const reg = { cb, off: null };
    reg.off = () => { this._regs = this._regs.filter(r => r !== reg); };
    this._regs.push(reg);
    return reg.off;
  }
  feed(s) { for (const r of [...this._regs]) r.cb(s); }
  get listenerCount() { return this._regs.length; }
  static async available_ports() {
    track('available_ports');
    const list = S.availablePorts;
    return list.map((p, i) => ({ path: p, name: `Port ${i + 1}`, manufacturer: 'stub' }));
  }
};
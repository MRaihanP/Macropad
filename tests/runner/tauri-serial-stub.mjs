// Stub untuk 'tauri-plugin-serialplugin' saat modul src/serial-transport.js
// diimpor di Node (tidak ada Tauri runtime di sini).
//
// Penting: listen() harus mengembalikan handle yang, kalau dipanggil, mencabut
// registrasi listener itu sendiri. Stub versi awal hanya menyimpan callback-nya
// sehingga unlisten tidak pernah berhasil - itu bug di stub, bukan di app.

const S = globalThis.__SerialStub;

export const SerialPort = class {
  constructor(opts) {
    this.opts = opts;
    this.written = [];
    this._regs = [];              // [{ cb, off }] - off mencabut entri ini
    this.isOpen = false;
    this.closed = false;
    S.instances.push(this);
  }
  async open() { if (S.openShouldFail) throw new Error('port terkunci'); this.isOpen = true; }
  async close() { this.closed = true; this.isOpen = false; }
  async setDataTerminalReady() { }
  async setRequestToSend() { }
  async startListening() { }
  async stopListening() { }
  async write(s) { if (!this.isOpen) throw new Error('port tertutup'); this.written.push(s); }
  async listen(cb) {
    const reg = { cb, off: null };
    reg.off = () => { this._regs = this._regs.filter(r => r !== reg); };
    this._regs.push(reg);
    return reg.off;
  }
  // Suntikkan data dari device ke semua listener yang masih terdaftar.
  feed(s) { for (const r of [...this._regs]) r.cb(s); }
  get listenerCount() { return this._regs.length; }
  static async available_ports() { return S.availablePorts; }
};
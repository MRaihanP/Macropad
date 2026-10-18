// =================== CODEC FRAME v2 (JS) ===================
//
// Decoder frame untuk protocol v2. Cermin persis firmware/common/frame.h.
//
// Modul ini SENGAJA tanpa import apa pun supaya bisa diuji di node tanpa Tauri,
// persis seperti src/diag-report.js. Kalau ia ikut terikat ke backend, satu-
//-satunya cara mengujinya adalah dengan perangkat nyata - dan setiap perbedaan
// satu byte baru ketahuan setelah_protocol sudah dipakai.
//
// TUJUAN UTAMA FASE INI: ketiga implementasi (C, JS, Rust) harus menghasilkan
// verdict yang PERSIS SAMA untuk input yang sama. Kalau tidak, "codec-nya sama
// spesifikasi" hanya klaim.
//
// Format frame: lihat komentar blok di firmware/common/frame.h - file itu yang
// jadi spesifikasi, file ini hanya mengikutinya.

export const SOF = 0xa5;
export const VER = 0x02;
export const HEADER_LEN = 5;
export const OVERHEAD = 7;
export const MAX_PAYLOAD = 512;

export const T_HELLO = 0x01;
export const T_LINE = 0x02;
export const T_CFG_BEGIN = 0x10;
export const T_CFG_WRITE = 0x11;
export const T_CFG_COMMIT = 0x12;
export const T_CFG_QUERY = 0x13;
export const T_CFG_ACTIVATE = 0x14;
export const T_CFG_READY = 0x15;
export const T_CREDIT = 0x16;
export const T_EVT = 0x20;
export const T_LAYER_DUMP = 0x21;  // request: dump layer N sebagai binary
export const T_ERR = 0x7f;

export const RESP_BIT = 0x80;

export const T_HELLO_RSP = T_HELLO | RESP_BIT;
export const T_CFG_RESULT = T_CFG_COMMIT | RESP_BIT;
export const T_CFG_META = T_CFG_QUERY | RESP_BIT;
export const T_CFG_ACT_RSP = T_CFG_ACTIVATE | RESP_BIT;
export const T_LAYER_DUMP_RSP = T_LAYER_DUMP | RESP_BIT;  // 0xA1

// Kode kesalahan. Hanya tiga yang dikeluarkan perakit; sisanya dicadangkan.
export const ERR_NONE = 0x00;
export const ERR_BAD_VER = 0x01;
export const ERR_BAD_CRC = 0x02;
export const ERR_LEN_OVERFLOW = 0x03;
export const ERR_SEQ_GAP = 0x10;
export const ERR_SEQ_DUP = 0x11;
export const ERR_NO_SESSION = 0x12;
export const ERR_CREDIT_EXHAUSTED = 0x13;
export const ERR_STAGING_FULL = 0x14;
export const ERR_CRC32_MISMATCH = 0x15;
export const ERR_UNSUPPORTED = 0x16;

/** CRC16/CCITT-FALSE. Parameter wajib identik dengan frame.h. */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= (b << 8) & 0xffff;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Header + payload + CRC, cermin dari faEncode(). */
export function encode(type, payload = []) {
  const body = [type, payload.length & 0xff, (payload.length >> 8) & 0xff, ...payload];
  const crc = crc16(body);
  return [SOF, VER, ...body, crc & 0xff, (crc >> 8) & 0xff];
}

const ST_SOF = 0;
const ST_VER = 1;
const ST_TYPE = 2;
const ST_LEN = 3;
const ST_PAYLOAD = 4;
const ST_CRC = 5;
const ST_SKIP = 6;

/**
 * Decoder streaming.
 *
 * Mengembalikan array event dari push(). Bentuk event:
 *   { ok: true,  type, payload }
 *   { ok: false, error: 'BAD_CRC' | 'BAD_VER' | 'LEN_OVERFLOW' }
 *
 * PENTING: decoder hanya memvalidasi STRUKTUR. "Apakah TYPE ini dikenali"
 * bukan urusannya - itu lapisan di atasnya. Decoder yang ikut menolak TYPE
 * tak dikenal akan membuat protokol tidak bisa dikembangkan tanpa merusak
 * kedua sisi sekaligus.
 */
export class FrameDecoder {
  constructor() {
    this.st = ST_SOF;
    this.type = 0;
    this.want = 0;
    this.got = 0;
    this.payload = new Uint8Array(MAX_PAYLOAD);
    this.crc = 0xffff;
    this.gotCrc = 0;
    this.stats = { frames_ok: 0, err_ver: 0, err_crc: 0, err_len: 0, resyncs: 0 };
  }

  resync() {
    this.st = ST_SOF;
    this.got = 0;
    this.gotCrc = 0;
    this.crc = 0xffff;
    this.stats.resyncs++;
  }

  /** Masukkan byte, kembalikan daftar event yang terbentuk. */
  push(bytes) {
    const events = [];
    for (const b of bytes) this.feed(b, events);
    return events;
  }

  feed(b, events) {
    switch (this.st) {
      case ST_SOF:
        if (b === SOF) this.st = ST_VER;
        return;

      case ST_VER:
        if (b !== VER) {
          this.stats.err_ver++;
          this.resync();
          events.push({ ok: false, error: 'BAD_VER' });
          return;
        }
        this.crc = 0xffff;
        this.got = 0;
        this.st = ST_TYPE;
        return;

      case ST_TYPE:
        this.type = b;
        this.crc = crc16Update(this.crc, b);
        this.want = 0;
        this.got = 0;
        this.st = ST_LEN;
        return;

      case ST_LEN:
        this.crc = crc16Update(this.crc, b);
        this.want |= b << (8 * this.got);
        this.got++;
        if (this.got < 2) return;
        if (this.want > MAX_PAYLOAD) {
          this.stats.err_len++;
          this.st = ST_SKIP;
          this.got = 0;
          return;
        }
        this.got = 0;
        this.gotCrc = 0;
        this.st = this.want === 0 ? ST_CRC : ST_PAYLOAD;
        return;

      case ST_PAYLOAD:
        if (this.got < MAX_PAYLOAD) this.payload[this.got] = b;
        this.crc = crc16Update(this.crc, b);
        this.got++;
        if (this.got >= this.want) {
          this.st = ST_CRC;
          // got WAJIB direset: state CRC memakainya sebagai indeks byte CRC
          // (0 lalu 1). Kalau dibiarkan berisi panjang payload, 8 * got
          // melampaui 32 bit dan JS menggeser modulo - hasilnya CRC salah
          // tanpa error apa pun.
          this.got = 0;
          this.gotCrc = 0;
        }
        return;

      case ST_CRC: {
        this.gotCrc |= b << (8 * this.got);
        this.got++;
        if (this.got < 2) return;
        if (this.gotCrc !== this.crc) {
          this.stats.err_crc++;
          this.resync();
          events.push({ ok: false, error: 'BAD_CRC' });
          return;
        }
        this.stats.frames_ok++;
        events.push({
          ok: true,
          type: this.type,
          payload: this.payload.slice(0, this.want),
        });
        this.resync();
        return;
      }

      case ST_SKIP:
        this.got++;
        if (this.got >= this.want) {
          this.resync();
          events.push({ ok: false, error: 'LEN_OVERFLOW' });
        }
        return;
    }
  }
}

function crc16Update(crc, b) {
  crc ^= (b << 8) & 0xffff;
  for (let i = 0; i < 8; i++) {
    crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

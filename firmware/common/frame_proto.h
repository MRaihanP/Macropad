// =================== PROTOKOL FRAME v2 - LAPIS PERINTAH ===================
//
// Berada DI ATAS frame_asm.c: bagian yang perakit sudah memberikan "ini frame
// dengan 8 byte payload", lapisan ini yang tahu artinya "CFG_ACTIVATE slot 3".
//
// DIIMPLEMENTASIKAN SEBAGAI HEADER, disisipkan dari macropad_core.h SETELAH
// handleSerialCommand() didefinisikan. Alasannya lapisan ini memanggil fungsi
// tersebut (untuk frame LINE) dan MacroConfig/activeCfg/slotCfg - semuanya baru
// ada setelah titik itu. Seluruhnya satu translation unit (sketsh .ino), jadi
// pola ini sama seperti yang dipakai transport.h dan diag.h.
//
// BELUM DISAMBUNGKAN KE APP. Yang aktif di device sekarang adalah jalur baris
// teks seperti biasa; mode frame hanya menyala kalau ada yang mengirim frame,
// dan itu saat ini baru bisa dilakukan lewat perintah FRAMEIN:<hex>.
//
//
// =================== DUAL MODE ===================
//
// Aturan auto-detect, sengaja sesederhana mungkin:
//
//   - Mode baris, byte PERTAMA suatu baris adalah 0xA5  -> pindah ke mode frame
//   - Mode frame, byte 0x0A datang saat perakit IDLE     -> kembali ke mode baris
//
// Kenapa 0xA5 dan bukan lebih eksplisit: perintah protokol lama semuanya ASCII
// dan tidak pernah diawali byte 0xA5. Jadi tidak ada perintah sah yang bisa
// salah dikira frame.
//
// Kenapa 0x0A sebagai jalan keluar dari mode frame: Serial Monitor tidak bisa
// mengirim byte biner, jadi tanpa jalan keluar ini, device yang terjebak di
// mode frame tidak akan bisa dikendalikan lagi tanpa reset. 0x0A hanya dikenali
// saat perakit IDLE (tidak di tengah frame), jadi byte 0x0A di dalam payload
// tidak pernah ikut memadamakannya.
//
// Sisi firmware lain TIDAK PERNAH berubah: mode frame hanya aktif setelah byte
// 0xA5 itu benar-benar tiba, dan perintahnya sendiri masih jalan persis sama.

#include "frame.h"
#include "frame_asm.h"
#include "crc32.h"
#include "cfg_sig.h"
#include "transport.h"  // DBG macro untuk debug logs

// MTU untuk menghitung payload maksimum di HELLO.
//
// Hook, bukan panggilan langsung ke bleNusMtu(), karena profil FINAL tidak
// punya BLE sama sekali. Default 0 berarti "tidak tahu / tidak relevan", dan
// HELLO akan melaporkan payload maksimum 0 - yang jujur untuk USB CDC, di mana
// tidak ada batasan notify sama sekali. transport_ble.h yang mengoverride
// nilai ini kalau NUS dikompilasi.
#ifndef PROTO_FRAME_MTU
#define PROTO_FRAME_MTU() 0u
#endif

// Nama tipe frame untuk pesan log. Sengaja tabel kecil, bukan sprintf format,
// supaya tidak menambah format-specifier yang harus dipercaya.
static const char* frameTypeName(uint8_t type) {
  switch (type) {
    case FA_T_HELLO:        return "HELLO";
    case FA_T_LINE:         return "LINE";
    case FA_T_CFG_BEGIN:    return "CFG_BEGIN";
    case FA_T_CFG_WRITE:    return "CFG_WRITE";
    case FA_T_CFG_COMMIT:   return "CFG_COMMIT";
    case FA_T_CFG_QUERY:    return "CFG_QUERY";
    case FA_T_CFG_ACTIVATE: return "CFG_ACTIVATE";
    case FA_T_CFG_READY:    return "CFG_READY";
    case FA_T_CREDIT:       return "CREDIT";
    case FA_T_EVT:          return "EVT";
    case FA_T_LAYER_DUMP:   return "LAYER_DUMP";
    case FA_T_ERR:          return "ERR";
    default:                return "?";
  }
}

// =================== STATE ===================

static fa_state_t   faSt;
static bool         faMode = false;      // false = mode baris (default)
static uint8_t      faSendBuf[FA_OVERHEAD + FA_MAX_PAYLOAD];
static fa_frame_t   faRxFrame;

static inline bool faModeFrame() { return faMode; }

// Perakit sedang di tengah frame? Kalau tidak, byte di luar frame tidak punya
// arti dan aman diabaikan.
static inline bool faBusy() { return faSt.st != FA_ST_SOF; }

static void faSetMode(bool modeFrame) {
  if (faMode == modeFrame) return;
  faMode = modeFrame;
  faInit(&faSt);
  DBG("[FRAME] mode frame\n");
}

// =================== PENGHITUNG ===================
//
// Dilaporkan lewat perintah FRAME supaya "tidak ada frame sama sekali" bisa
// dibedakan dari "frame datang tapi rusak" - dua kegagalan yang gejalanya sama
// dari sisi app: tidak terjadi apa-apa.
//
// Dideklarasikan di sini, sebelum faSend(), karena faSend() incrementedkan
// penghitung kirim. Di C++ memakai variabel sebelum deklarasinya adalah error
// kompilasi, dan penempatannya di bawah akan membuat urutan include/definisi
// jadi bagian dari kontrak tanpa perlu begitu.
static uint32_t faRxFrames    = 0;
static uint32_t faRxErrCrc    = 0;
static uint32_t faRxErrVer    = 0;
static uint32_t faRxErrLen    = 0;
static uint32_t faTxFrames    = 0;
static uint32_t faTxErrEncode = 0;
static uint32_t faTxDropped   = 0;
static uint32_t faCxUnsup     = 0;

// =================== CFG STAGING (Fase 4-5: bulk upload biner + credit) ===================
//
// Buffer sementara untuk menerima preset biner via CFG_WRITE.
// Layout binary (LE, tidak pakai padding):
//   u8  version       - harus == CONFIG_VERSION (5)
//   u8  layerCount    - 1..MAX_LAYERS
//   per layer (layerCount x):
//     char  name[16]                (NAME_LEN)
//     key  : u8 type, char value[48] x (ROWS*COLS)      = 9 x 49 = 441
//     enc  : u8 type, char value[48] x (NUM_ENCODERS*3) = 3 x 49 = 147
//     subtotal = 16 + 441 + 147 = 604 byte
//   u32 crc32      - CRC32/ISO-HDLC atas seluruh byte di atas
//
// Size maksimum: 2 + 604*8 + 4 = 4838 byte. Buffer 5120 (5KB) muat dengan
// sedikit ruang, jauh di bawah limit stack ESP32-S3 di IRAM.
#define CFG_STAGING_SIZE 5120u
//
// FASE 5: Credit flow control.
//
// CFG_BEGIN -> CFG_READY{credit u16} memberi tahu app berapa banyak ruang
// TERSISA di staging buffer. App mengirim CFG_WRITE memakai WriteWithoutResponse
// dan hanya boleh mengirim sebanyak credit yang ada.
//
// Credit di sini adalah "sisa ruang", BUKAN "jumlah yang dibebaskan". App
// melacak sendiri sisa itu, jadi tidak ada drift akumulasi.
//
// PENTING - credit tidak pernah ditambah. Itu disengaja: payload maksimum satu
// preset adalah 4838 byte (lihat perhitungan di atas) dan CFG_STAGING_SIZE
// 5120, jadi credit penuh selalu cukup untuk SELURUH preset dalam satu sesi.
// Alur flow control-nya sederhana: device memberi tahu sisa ruang, app
// menghormatinya. Tidak ada siklus refill karena tidak ada siklus flush - staging
// di-commit utuh di akhir, bukan ditulis berkala.
//
// Kalau suatu saat payload bisa melebihi staging, check `len > cfgStageCredit`
// di faCmdCfgWrite sudah menolaknya dengan FA_ERR_CREDIT_EXHAUSTED, dan app
// turun ke jalur teks - bukan hang.
static uint8_t  cfgStage[CFG_STAGING_SIZE];
static uint16_t cfgStageLen = 0;      // berapa byte yang sudah ditulis
static uint16_t cfgStageCredit = 0;   // sisa ruang yang boleh ditulis (Fase 5)
static uint8_t  cfgStageSlot = 0;     // slot tujuan (0..APP_SLOTS-1)
static bool     cfgStageActive = false;


// =================== RESET SESI PROTOKOL ===================
//
// Kembalikan SELURUH state protokol ke keadaan boot. Dipanggil dari
// checkSerialInput() saat link BLE naik atau turun (lihat PROTO_LINK_RESET).
//
// Kenapa ini wajib ada, dan kenapa tidak bisa diandalkan pada "app akan kirim
// byte 0x0A untuk memadamakannya":
//
//   - `faMode` hanya bisa dimatikan lewat byte 0x0A (faRoute) atau perintah
//     FRAME:LINE. Perintah FRAME:LINE sendiri tidak terjangkau saat mode frame,
//     karena setiap byte non-0xA5 dibuang sebelum sampai handleSerialCommand().
//     Jadi satu-satunya jalan keluar yang benar-benar ada adalah 0x0A - dan 0x0A
//     hanya dikenal saat perakit IDLE (frame_asm.h). Perakit yang terjebak di
//     tengah frame yang TERPOTONG tidak akan mengenalinya selamanya.
//
//   - `serialLineLen` tidak pernah di-reset oleh disconnect. Kalau link putus
//     di tengah baris, `lineEmpty` jadi false selamanya, dan faRoute() berhenti
//     mengenali byte 0xA5 - device tidak bisa MASUK mode frame lagi.
//
//   - Staging CFG yang masih aktif dari sesi yang terputus akan ditimpa diam-diam
//     oleh CFG_BEGIN berikutnya. Lebih aman dinolkan di batas sesi.
//
// Efeknya kalau ini tidak ada persis gejala yang dilaporkan: label preset di app
// berubah ke "Default", tapi device tetap menjalankan preset app karena semua
// perintah teks yang dikirim app dibuang sebagai byte bukan-frame.
static void faResetSession() {
  // PENTING: bypass faSetMode. Fungsi itu sengaja return awal kalau modenya
  // sudah sama, dan tidak menyentuh faSt kalau begitu - padahal di sinilah
  // justru faSt yang harus dibersihkan. Perakit bisa tertinggal di tengah frame
  // terpotong walaupun mode-nya sudah "baris".
  faMode = false;
  faInit(&faSt);
  serialLineReset();

  // Sisa byte inbound dari link lama ikut dibuang, supaya perintah yang sudah
  // terpotong tidak dieksekusi sebagai perintah utuh di sesi berikutnya.
  PROTO_LINK_DRAIN_RX();

  // Staging bulk upload milik sesi yang sudah tidak ada.
  cfgStageActive = false;
  cfgStageLen = 0;
  cfgStageCredit = 0;

  DBG("[FRAME] reset sesi protokol (link berubah)");
}


// =================== MENGIRIM JAWABAN ===================
//
// Memakai SERIAL (= g_transport), bukan LOGS: jawaban frame adalah jawaban
// protokol dan harus keluar lewat jalur yang sama dengan permintaannya - lewat
// NUS kalau permintaan datang lewat NUS.
//
// Transport yang sudah ada yang melakukan pemecahan chunk: BleNusTransport
// memecah otomatis per MTU hasil negosiasi. Jadi di sini tidak ada logika
// chunking sama sekali - itu alasannya pemecahan chunk lived di transport dan
// bukan di lapisan protokol.
// Terjemahkan frame jawaban menjadi teks yang bisa dibaca manusia.
//
// HANYA dicetak lewat LOGS, dan HANYA saat g_transport == g_logTransport -
// yaitu saat jawabannya sudah keluar di Serial Monitor. Kalau lewat BLE, app
// yang mendekode; mencetak ulang di sini hanya akan menggandakan. Dan lewat BLE
// tidak ada orang yang membaca Serial Monitor.
//
// Kenapa perlu: jawaban frame itu biner. Di Serial Monitor ia muncul sebagai
// karakter aneh, dan "banyak karakter aneh" TIDAK bisa dibedakan dari jawaban
// yang korup - keduanya hanya berbeda dalam arti, bukan dalam tampilan. Tanpa
// terjemahan, satu-satunya pemeriksaan manual adalah menghitung panjang,
// yang tidak bisa membuktikan isinya benar.
static void faTerjemahkan(uint8_t type, const uint8_t* p, uint16_t len) {
  if (g_transport != g_logTransport) return;

  switch (type) {
    case FA_T_HELLO_RSP:
      if (len < 10) return;
      LOGS->printf("  -> fw=%u rows=%u cols=%u encoders=%u maksPayload=%u slot=%u layer=%u slotAktif=%u\n",
                   p[1], p[2], p[3], p[4],
                   (unsigned)(p[5] | (p[6] << 8)), p[7], p[8], p[9]);
      return;

    case FA_T_CFG_META: {
      if (len < 1) return;
      LOGS->printf("  -> slotAktif=%u (0xFF = Default Preset, bukan slot)\n", p[0]);
      const uint16_t n = (uint16_t)((len - 1) / 6);
      for (uint16_t i = 0; i < n; i++) {
        const uint8_t* o = &p[1 + i * 6];
        const uint32_t sig = (uint32_t)o[0] | ((uint32_t)o[1] << 8) |
                             ((uint32_t)o[2] << 16) | ((uint32_t)o[3] << 24);
        LOGS->printf("  -> slot %u sig=%08lX layers=%u sah=%u\n",
                     (unsigned)i, (unsigned long)sig, o[4], o[5]);
      }
      return;
    }

    case FA_T_CFG_READY:
      if (len >= 2) {
        const uint16_t credit = (uint16_t)(p[0] | (p[1] << 8));
        LOGS->printf("  -> CFG_READY credit=%u\n", credit);
      }
      return;

    case FA_T_CREDIT:
      if (len >= 2) {
        const uint16_t credit = (uint16_t)(p[0] | (p[1] << 8));
        LOGS->printf("  -> CREDIT credit=%u\n", credit);
      }
      return;

    case FA_T_CFG_ACT_RSP: {
      if (len < 1) return;
      const uint32_t sig = (len >= 5)
          ? ((uint32_t)p[1] | ((uint32_t)p[2] << 8) | ((uint32_t)p[3] << 16) | ((uint32_t)p[4] << 24))
          : 0;
      LOGS->printf("  -> kode=%u sig=%08lX slot=%u\n", p[0], (unsigned long)sig,
                   (len >= 6) ? p[5] : 0);
      return;
    }

    case FA_T_CFG_RESULT: {
      if (len < 1) return;
      const uint32_t sig = (len >= 5)
          ? ((uint32_t)p[1] | ((uint32_t)p[2] << 8) | ((uint32_t)p[3] << 16) | ((uint32_t)p[4] << 24))
          : 0;
      LOGS->printf("  -> CFG_COMMIT kode=%u sig=%08lX slot=%u\n", p[0],
                   (unsigned long)sig, (len >= 6) ? p[5] : 0);
      return;
    }

    case FA_T_ERR:
      LOGS->printf("  -> ERR permintaan 0x%02X kode=%u\n", p[0], (len >= 2) ? p[1] : 0);
      return;

    default:
      return;
  }
}

static void faSend(uint8_t type, const uint8_t* payload, uint16_t len) {
  size_t n = faEncode(type, payload, len, faSendBuf, sizeof(faSendBuf));
  if (n == 0) {
    DBG("[FRAME] gagal encode %s len=%u\n", frameTypeName(type), (unsigned)len);
    faTxErrEncode++;
    return;
  }

  // PENTING: tx dihitung dari APA YANG BENAR-BENAR terkirim, bukan dari frame
  // yang dikirim ke write().
  //
  // BleNusTransport::write() mengembalikan 0 kalau app belum subscribe notify -
  // dan itulah keadaan yang paling sering terjadi saat app baru konek. Versi
  // pertama menghitung tx++ sebelum memanggil write(), jadi tx naik meskipun
  // tidak satu byte pun keluar. Kolom Tx jadi selalu tampak sehat tepat saat
  // device diam, dan Tx != Rx tidak pernah terjadi - padahal itu justru
  //geometry tanda paling jelas bahwa jawabannya hilang di sisi media.
  const size_t terkirim = SERIAL->write(faSendBuf, n);
  // Terjemahkan setelah write: Serial Monitor sudah menampilkan byte biner
  // apa adanya, jadi penjelasannya menyusul sebagai baris teks terpisah.
  faTerjemahkan(type, payload, len);
  if (terkirim == n) {
    faTxFrames++;
  } else {
    // Dihitung terpisah dari noSub di DIAGMEDIA karena ini OPERASI frame.
    // Satu permintaan CFG_QUERY yang gagal = satu transaksi yang hilang,
    // sedangkan noSub menghitung setiap potongan write - jadi angkanya bisa
    // jauh lebih besar dan tidak bisa dipakai menghitung permintaan yang hilang.
    faTxDropped++;
    DBG("[FRAME] %s gagal terkirim (%u/%u byte) - app belum subscribe?\n",
                 frameTypeName(type), (unsigned)terkirim, (unsigned)n);
  }
}

// Penghitung frame yang masuk dan error-nya.Dilaporkan lewat DIAG supaya
// "tidak ada frame sama sekali" bisa dibedakan dari "frame datang tapi rusak".
// =================== CFG_SIG ===================
//
// Perhitungan sebenarnya ada di cfg_sig.h (bebas Arduino, bisa diuji di host).
// Yang ada di sini hanya penerjemahan MacroConfig ke bentuk yang bisa di-hash.
//
// Pointer digeser ke offset yang tepat karena type dan value berada di dalam
// satu struct KeyAction - keduanya stride-nya sama. Byte sisanya di luar
// `valueLen` sengaja TIDAK ikut: nilai action diisi strncpy dan sisa fieldnya
// bisa berisi byte sisa dari nilai yang lebih panjang.
static uint32_t cfgSig(const MacroConfig& c) {
  // Cast ke uint8_t* aman karena ActionType punya underlying type uint8_t
  // (lihat deklarasinya di macropad_core.h), jadi tata letak byte-nya sama
  // persis. cfg_sig.h sengaja tidak tahu tentang enum C++ supaya bisa diuji
  // di host dengan array uint8_t biasa.
  cfg_sig_src_t s;
  s.layerNames   = c.layerNames[0];
  s.keyTypes     = (const uint8_t*)&c.layerMap[0][0][0].type;
  s.keyValues    = &c.layerMap[0][0][0].value[0];
  s.encTypes     = (const uint8_t*)&c.encCW[0].type;
  s.encValues    = &c.encCW[0].value[0];
  // Keempat stride type dan value sengaja sama: keduanya berada di dalam satu
  // struct KeyAction, jadi jaraknya memang sama. Kalau struct-nya berubah,
  // keempat baris ini berubah bersama - dan itulah gunanya memisahkannya di
  // cfg_sig.h: pemanggil dengan layout datar tidak dipaksa berbohong.
  s.keyTypeStride   = sizeof(KeyAction);
  s.keyValueStride  = sizeof(KeyAction);
  s.encTypeStride   = sizeof(KeyAction);
  s.encValueStride  = sizeof(KeyAction);
  s.layerNameStride = NAME_LEN;   /* char[MAX_LAYERS][NAME_LEN] di struct cfg */
  s.nLayers      = (c.layerCount < MAX_LAYERS) ? c.layerCount : MAX_LAYERS;
  s.nKeys        = (uint8_t)(ROWS * COLS);
  s.nEncoders    = NUM_ENCODERS;
  s.encPerKnob   = 3;
  s.nameLen      = NAME_LEN;
  s.valueLen     = MACRO_MAX_LEN;
  return cfgSigCompute(c.version, c.layerCount, c.currentLayer, &s);
}

// Sidik jari slot yang sedang aktif. Slot kosong (belum pernah diisi) punya
// sig tertentu juga - yang penting app bisa membedakannya karena isinya
// "tidak ada apa-apa".
static uint32_t faActiveSig() { return cfgSig(*activeCfg); }

// Slot 0xff berarti "bukan slot" (Default Preset atau App Preset).
#define FA_SLOT_NONE 0xFFu

static uint8_t faActiveSlot() {
  for (uint8_t i = 0; i < APP_SLOTS; i++) if (activeCfg == &slotCfg[i]) return i;
  return FA_SLOT_NONE;
}

// Slot yangalid punya isi sig ini. Dicari ulang setiap CFG_QUERY, jadi app
// yang salah menulis slot akan langsung terlihat (slot yang berubah tanda
// tangannya).
static uint32_t faSigOfSlot(uint8_t slot) {
  if (slot >= APP_SLOTS) return 0;
  return cfgSig(slotCfg[slot]);
}

// =================== MENANGANI PERINTAH ===================

static void faReplyUnsupported(uint8_t reqType) {
  uint8_t p[2];
  p[0] = (uint8_t)reqType;
  p[1] = FA_ERR_UNSUPPORTED;
  faSend(FA_T_ERR, p, 2);
  faCxUnsup++;
}

// HELLO: app memberi tahu versi dan kemampuan frame yang bisa dibaca.
static void faCmdHello(const uint8_t* pl, uint16_t len) {
  // Payload HELLO OPSIONAL.
  //
  // Versi pertama menolak HELLO dengan payload kosong (len < 3) dan
  // menjawab ERR UNSUPPORTED. Itu salah: HELLO kosong adalah probe paling
  // alami - "kamu siapa?" - dan menolaknya membuat satu-satunya cara
  // memeriksa koneksi frame dari Serial Monitor jadi gagal. App yang baru
  // konek dan belum tahu apa-apa pun akan mengirim HELLO kosong lebih dulu.
  //
  // Payload kalau ada adalah versi/kemampuan yang ditawarkan app. Device
  // tidak memakainya untuk apa pun sekarang, tapi dicetak supaya perbedaan
  // antara "app bilang bisa X" dan "device menjawab Y" bisa dilihat langsung.
  if (len > 0) {
    DBG("[FRAME] HELLO payload %u byte:", (unsigned)len);
    for (uint16_t i = 0; i < len && i < 8; i++) LOGS->printf(" %02x", pl[i]);
    LOGS->println("");
  }

  uint8_t resp[10];
  resp[0] = FA_VER;          // versi yang kita pahami
  resp[1] = (uint8_t)FW_VERSION;
  resp[2] = (uint8_t)ROWS;
  resp[3] = (uint8_t)COLS;
  resp[4] = (uint8_t)NUM_ENCODERS;
  // Payload maksimum yang masih muat di satu notifikasi. Device tidak
  // membatasi app di sini; nilainya cuma informasi supaya app tahu batas
  // chunking yang perlu iapecah sendiri.
  const uint16_t mtu = (uint16_t)PROTO_FRAME_MTU();
  const uint16_t maxp = (mtu > 3) ? (uint16_t)(mtu - 3 - FA_OVERHEAD) : 0;
  resp[5] = (uint8_t)(maxp & 0xFF);
  resp[6] = (uint8_t)((maxp >> 8) & 0xFF);
  resp[7] = (uint8_t)APP_SLOTS;
  resp[8] = MAX_LAYERS;
  resp[9] = (uint8_t)(faActiveSlot());
  faSend(FA_T_HELLO_RSP, resp, sizeof(resp));
}

// CFG_QUERY: "preset mana saja yang sudah kamu punya?"
//
// Jawabannya memuat sidik jari semua slot, jadi app tidak perlu menebak
// apakah cache-nya masih benar - device yang jadi sumber kebenaran.
static void faCmdCfgQuery(const uint8_t* pl, uint16_t len) {
  (void)pl; (void)len;
  uint8_t resp[1 + APP_SLOTS * 6];
  resp[0] = (uint8_t)faActiveSlot();
  for (uint8_t i = 0; i < APP_SLOTS; i++) {
    const uint32_t sig = faSigOfSlot(i);
    uint8_t* o = &resp[1 + i * 6];
    o[0] = (uint8_t)(sig & 0xFF);
    o[1] = (uint8_t)((sig >> 8) & 0xFF);
    o[2] = (uint8_t)((sig >> 16) & 0xFF);
    o[3] = (uint8_t)((sig >> 24) & 0xFF);
    o[4] = slotCfg[i].layerCount;
    // Slot dianggap sah kalau punya minimal satu layer dengan isi. Slot yang
    // baru direset masih punya sig tertentu, jadi tanpa penanda ini app tidak
    // bisa membedakan "kosong" dari "preset yang kebetulan kosong".
    o[5] = (uint8_t)(slotCfg[i].version == CONFIG_VERSION && slotCfg[i].layerCount > 0 ? 1 : 0);
  }
  faSend(FA_T_CFG_META, resp, sizeof(resp));
}

// LAYER_DUMP: "berikan isi layer N dalam format binary"
// Payload: 1 byte layer index
// Response: FA_T_LAYER_DUMP_RSP dengan format:
//   byte 0: layer number
//   byte 1: key count = ROWS*COLS
//   setiap key: type (uint8) + value[MACRO_MAX_LEN=48] = 49B
//   Total payload: 2 + 9*49 = 443B → muat dalam 2 frame @ 237 byte MTU 247
// Ini menggantikan 11 notifikasi text (DUMP_BEGIN + 9 key + DUMP_END) → 2 frame biner
static void faCmdLayerDump(const uint8_t* pl, uint16_t len) {
  if (len < 1 || pl[0] >= activeCfg->layerCount) {
    uint8_t err[2] = { FA_T_LAYER_DUMP, FA_ERR_UNSUPPORTED };
    faSend(FA_T_ERR, err, 2);
    return;
  }
  const uint8_t layer = pl[0];
  const uint8_t keyCount = ROWS * COLS;
  const uint16_t totalLen = 2 + keyCount * (1 + MACRO_MAX_LEN);
  uint8_t resp[256];  // cukup untuk 9 keys (2 + 9*49 = 443 → butuh 2 frame)
  resp[0] = layer;
  resp[1] = keyCount;
  uint16_t off = 2;
  for (uint8_t k = 0; k < keyCount; k++) {
    uint8_t r = k / COLS;
    uint8_t c = k % COLS;
    KeyAction& a = activeCfg->layerMap[layer][r][c];
    resp[off++] = (uint8_t)a.type;
    memcpy(&resp[off], a.value, MACRO_MAX_LEN);
    off += MACRO_MAX_LEN;
    // Jika buffer penuh, kirim sekarang — faSend otomatis fragment
    if (off + 1 + MACRO_MAX_LEN > sizeof(resp)) {
      faSend(FA_T_LAYER_DUMP_RSP, resp, off);
      // frame berikutnya: lanjutkan dari byte ini
      off = 0;
      resp[off++] = layer >> 8;  // marker frame kedua (high byte = 0 untuk <32 layer)
      resp[off++] = 0;           // ini adalah frame chunk kedua, key count = 0 marker
    }
  }
  if (off > 2) faSend(FA_T_LAYER_DUMP_RSP, resp, off);
}

// CFG_ACTIVATE: pindah ke slot tertentu.
static void faCmdCfgActivate(const uint8_t* pl, uint16_t len) {
  uint8_t resp[6];
  resp[0] = 0;   // code: 0 = sukses
  if (len < 1) {
    resp[0] = FA_ERR_UNSUPPORTED;
    faSend(FA_T_CFG_ACT_RSP, resp, 1);
    return;
  }
  const uint8_t slot = pl[0];
  if (slot >= APP_SLOTS) {
    resp[0] = FA_ERR_UNSUPPORTED;
    resp[1] = resp[2] = resp[3] = resp[4] = 0;
    resp[5] = (uint8_t)faActiveSlot();
    faSend(FA_T_CFG_ACT_RSP, resp, sizeof(resp));
    return;
  }
  activeCfg = &slotCfg[slot];
  if (activeCfg->currentLayer >= activeCfg->layerCount) activeCfg->currentLayer = 0;
  const uint32_t sig = cfgSig(*activeCfg);
  resp[1] = (uint8_t)(sig & 0xFF);
  resp[2] = (uint8_t)((sig >> 8) & 0xFF);
  resp[3] = (uint8_t)((sig >> 16) & 0xFF);
  resp[4] = (uint8_t)((sig >> 24) & 0xFF);
  resp[5] = slot;
  faSend(FA_T_CFG_ACT_RSP, resp, sizeof(resp));
  DBG("[FRAME] CFG_ACTIVATE slot=%u sig=%08lX\n", (unsigned)slot, (unsigned long)sig);
  broadcastLayerChanged();
}

// LINE: escape hatch. Payload diperlakukan sebagai satu perintah protokol
// lama, dan jawabannya keluar sebagai teks.
//
// Ini yang membuat seluruh fase ini bisa diuji dari Serial Monitor tanpa app:
// bungkus perintah dalam frame LINE, kirim lewat FRAMEIN:<hex>, dan jawabannya
// muncul sebagai teks biasa yang bisa dibaca mata.
static void faCmdLine(const uint8_t* pl, uint16_t len) {
  // Penjaga rekursi.
  //
  // Jalur ini bisa memanggil dirinya sendiri: LINE("FRAMEIN:...") ->
  // protoFrameCommand() -> faProtoFrameIn() -> faProtoFeed() -> frame LINE
  // lagi. Satu frame LINE bisa memuat FRAMEIN yang memuat LINE yang memuat
  // FRAMEIN, dan seterusnya. Tanpa penjaga, stack ESP32-S3 habis sebelum
  // perangkat sempat menjawab apa pun - jadi perangkat hilang, bukan error.
  //
  // Batasnya longgar (16 tingkat) karena tujuannya hanya mencegah stack habis,
  // bukan membatasi kedalaman yang sah. Jalur yang sah tidak pernah bersarang sedalam itu.
  static int kedalaman = 0;
  if (kedalaman >= 16) {
    faReplyUnsupported(FA_T_LINE);
    return;
  }
  kedalaman++;

  char buf[MACRO_MAX_LEN * 2];
  if (len >= sizeof(buf)) len = sizeof(buf) - 1;
  memcpy(buf, pl, len);
  buf[len] = '\0';
  DBG("[FRAME] LINE \"%s\"\n", buf);
  faSetMode(false);
  handleSerialCommand(String(buf));
  faSetMode(true);

  kedalaman--;
}

// =================== CFG BULK UPLOAD (Fase 4-5) ===================
//
// Protokol empat langkah: app kirim CFG_BEGIN → CFG_READY → banyak
// CFG_WRITE → CFG_COMMIT.
// Device menampung semua payload CFG_WRITE di staging buffer, lalu di
// CFG_COMMIT parse + verify CRC32 + copy ke slotCfg.
//
// Fase 5 menambah credit flow control:
//   CFG_BEGIN    → FA_T_CFG_READY: u16 credit (ruang staging tersedia sekarang)
//   CFG_WRITE    → tidak ada jawaban (ack implisit = tidak error).
//                  Dikirim WriteWithoutResponse. Device mengirim FA_T_CREDIT
//                  untuk menambah ruang saat staging space tersedia.
//   CFG_COMMIT   → FA_T_CFG_RESULT (0x92):
//                  u8 code (0=sukses, >0=error), u32 sig, u8 slot
//                  (total 6 byte payload; sig=0 jika gagal)
static void faCmdCfgBegin(const uint8_t* pl, uint16_t len) {
  if (len < 1) {
    faReplyUnsupported(FA_T_CFG_BEGIN);
    return;
  }
  cfgStageSlot = pl[0];
  if (cfgStageSlot >= APP_SLOTS) {
    uint8_t resp[6] = { FA_ERR_UNSUPPORTED, 0, 0, 0, 0, cfgStageSlot };
    faSend(FA_T_CFG_RESULT, resp, sizeof(resp));
    return;
  }
  cfgStageLen = 0;
  cfgStageCredit = CFG_STAGING_SIZE;  // Fase 5: beri credit penuh
  cfgStageActive = true;
  DBG("[FRAME] CFG_BEGIN slot=%u credit=%u\n", cfgStageSlot, (unsigned)cfgStageCredit);

  // Fase 5: kirim CFG_READY{credit u16} agar app tahu berapa ruang staging
  // tersedia sebelum mulai mengirim CFG_WRITE.
  uint8_t ready[2];
  ready[0] = (uint8_t)(cfgStageCredit & 0xFF);
  ready[1] = (uint8_t)((cfgStageCredit >> 8) & 0xFF);
  faSend(FA_T_CFG_READY, ready, sizeof(ready));
}

static void faCmdCfgWrite(const uint8_t* pl, uint16_t len) {
  if (!cfgStageActive) {
    faReplyUnsupported(FA_T_CFG_WRITE);
    return;
  }
  // Fase 5: cek credit. App tidak boleh mengirim lebih dari credit yang ada.
  // Jika credit habis, tolak dengan FA_ERR_CREDIT_EXHAUSTED — ini memberi
  // sinyal ke app agar tidak menumpuk lebih banyak data.
  //
  // CFG_WRITE dikirim WriteWithoutResponse (tidak ada ack per chunk), jadi
  // cek ini di sisi device adalah satu-satunya lapisan flow control yang
  // benar: app menunggu CREDIT frame sebelum bisa melanjutkan.
  if (len > cfgStageCredit) {
    uint8_t resp[6] = { FA_ERR_CREDIT_EXHAUSTED, 0, 0, 0, 0, cfgStageSlot };
    faSend(FA_T_CFG_RESULT, resp, sizeof(resp));
    cfgStageActive = false;
    cfgStageCredit = 0;
    DBG("[FRAME] CFG_WRITE len=%u > credit=%u\n", len, (unsigned)cfgStageCredit);
    return;
  }
  cfgStageCredit -= len;
  memcpy(cfgStage + cfgStageLen, pl, len);
  cfgStageLen += len;

  // Setelah staging space terpakai, beri tahu app berapa ruang yang tersedia
  // sekarang. App akan mengirim CREDIT berikutnya setelah ruang dibuat
  // (mis. staging disinkronis ke slot). Ini memberi app sinyal bahwa
  // write ini diterima, sekaligus menyiapkan credit untuk lanjutan.
  //
  // Dikirim setiap kali credit turun di bawah setengah staging — cukup
  // sering untuk app tidak pernah benar-benar terjeblok, tapi tidak berlebihan.
  if (cfgStageCredit < CFG_STAGING_SIZE / 2) {
    uint8_t credit[2];
    // Device memberi tahu berapa banyak ruang STAGING tersedia SEKARANG.
    // Ini bukan "berapa yang baru saja dibebaskan" — app menghitung total
    // yang perlu dikirim dan mengurangi sendiri.
    credit[0] = (uint8_t)(cfgStageCredit & 0xFF);
    credit[1] = (uint8_t)((cfgStageCredit >> 8) & 0xFF);
    faSend(FA_T_CREDIT, credit, sizeof(credit));
  }
}

static void faCmdCfgCommit() {
  if (!cfgStageActive) {
    faReplyUnsupported(FA_T_CFG_COMMIT);
    return;
  }
  uint8_t resp[6] = { 0, 0, 0, 0, 0, cfgStageSlot };

  // Verifikasi panjang minimum (header 2 byte + trailer 4 byte)
  if (cfgStageLen < 2 + 4) {
    resp[0] = FA_ERR_BAD_VER;
    faSend(FA_T_CFG_RESULT, resp, sizeof(resp));
    cfgStageActive = false;
    cfgStageCredit = 0;
    return;
  }

  // Pisahkan CRC32 (4 byte terakhir, LE)
  const uint16_t dataLen = cfgStageLen - 4;
  const uint32_t expectedCrc = (uint32_t)cfgStage[dataLen]
                              | ((uint32_t)cfgStage[dataLen + 1] << 8)
                              | ((uint32_t)cfgStage[dataLen + 2] << 16)
                              | ((uint32_t)cfgStage[dataLen + 3] << 24);
  const uint32_t actualCrc = crc32_bytes(cfgStage, dataLen);

  if (expectedCrc != actualCrc) {
    resp[0] = FA_ERR_CRC32_MISMATCH;
    faSend(FA_T_CFG_RESULT, resp, sizeof(resp));
    DBG("[FRAME] CFG_COMMIT CRC mismatch: expected=%08lX actual=%08lX\n",
                 (unsigned long)expectedCrc, (unsigned long)actualCrc);
    cfgStageActive = false;
    cfgStageCredit = 0;
    return;
  }

  // Parse binary payload field-per-field ke dalam struct.
  // Layout binary (canonical, LE, no padding):
  //   u8 version, u8 layerCount
  //   per layer: char name[16], 9*(u8 type, char value[48]), 3*(u8 type, char value[48])
  // Panjang per layer = 16 + 9*49 + 3*49 = 604 byte
  const uint8_t version = cfgStage[0];
  const uint8_t layerCount = cfgStage[1];
  if (version != CONFIG_VERSION) {
    resp[0] = FA_ERR_BAD_VER;
    resp[1] = version;
    faSend(FA_T_CFG_RESULT, resp, sizeof(resp));
    cfgStageActive = false;
    cfgStageCredit = 0;
    return;
  }
  uint8_t nLayers = (layerCount < MAX_LAYERS) ? layerCount : MAX_LAYERS;

  // Hitung berapa byte yang sebenarnya ada untuk layer data (tanpa CRC)
  const uint16_t needLen = (uint16_t)(2 + 604u * nLayers);
  if (dataLen < needLen) {
    // data terlalu pendek untuk layerCount yang diklaim — ini CRC mismatch
    // konseptual (app menghitung salah) jadi laporkan sebagai CRC error.
    resp[0] = FA_ERR_CRC32_MISMATCH;
    faSend(FA_T_CFG_RESULT, resp, sizeof(resp));
    DBG("[FRAME] CFG_COMMIT payload too short: have %u need %u\n",
                 (unsigned)dataLen, (unsigned)needLen);
    cfgStageActive = false;
    cfgStageCredit = 0;
    return;
  }

  // Reset slot tujuan
  MacroConfig& dst = slotCfg[cfgStageSlot];
  resetCfgStruct(dst);

  dst.version = CONFIG_VERSION;
  dst.layerCount = nLayers;
  dst.currentLayer = 0;

  uint16_t off = 2;  // setelah header

  for (uint8_t l = 0; l < nLayers; l++) {
    // Nama layer [16]
    memcpy(dst.layerNames[l], cfgStage + off, NAME_LEN);
    off += NAME_LEN;

    // Keys [9], tiap (u8 type + char value[48])
    const uint8_t nKeys = (uint8_t)(ROWS * COLS);
    for (uint16_t k = 0; k < nKeys; k++) {
      uint8_t ki = (uint8_t)(k / COLS);
      uint8_t kj = (uint8_t)(k % COLS);
      dst.layerMap[l][ki][kj].type = (ActionType)cfgStage[off++];
      memcpy(dst.layerMap[l][ki][kj].value, cfgStage + off, MACRO_MAX_LEN);
      off += MACRO_MAX_LEN;
    }

    // Encoders: per knob, CW/CCW/BTN berurutan (sama dengan iterasi cfgSig()).
    // Urutan di staging: CW[0], CCW[0], BTN[0], CW[1], CCW[1], BTN[1], ...
    for (uint8_t e = 0; e < NUM_ENCODERS; e++) {
      dst.encCW[e].type = (ActionType)cfgStage[off++];
      memcpy(dst.encCW[e].value, cfgStage + off, MACRO_MAX_LEN);
      off += MACRO_MAX_LEN;
      dst.encCCW[e].type = (ActionType)cfgStage[off++];
      memcpy(dst.encCCW[e].value, cfgStage + off, MACRO_MAX_LEN);
      off += MACRO_MAX_LEN;
      dst.encBtn[e].type = (ActionType)cfgStage[off++];
      memcpy(dst.encBtn[e].value, cfgStage + off, MACRO_MAX_LEN);
      off += MACRO_MAX_LEN;
    }
  }

  const uint32_t sig = cfgSig(dst);
  resp[0] = FA_ERR_NONE;
  resp[1] = (uint8_t)(sig & 0xFF);
  resp[2] = (uint8_t)((sig >> 8) & 0xFF);
  resp[3] = (uint8_t)((sig >> 16) & 0xFF);
  resp[4] = (uint8_t)((sig >> 24) & 0xFF);
  resp[5] = cfgStageSlot;

  cfgStageActive = false;
  cfgStageLen = 0;
  cfgStageCredit = 0;

  DBG("[FRAME] CFG_COMMIT ok slot=%u sig=%08lX layers=%u\n",
               cfgStageSlot, (unsigned long)sig, nLayers);
}

static void faHandleFrame(const fa_frame_t& f) {
  faRxFrames++;
  // PENTING: frame biner juga harus memperbarui heartbeat host, sama seperti
  // handleSerialCommand(). Tanpa ini, selama sesi frame device tidak pernah
  // tahu bahwa host masih aktif - setelah 4 detik tanpa perintah teks,
  // companionConnected() salah false dan openApp() langsung eksekusi
  // executeOpenApp() (HID) alihal hal app seharusnya lewat EVT:APP via NUS.
  lastHostSeenMs = millis();
  switch (f.type) {
    case FA_T_HELLO:        faCmdHello(f.payload, f.len); break;
    case FA_T_CFG_QUERY:    faCmdCfgQuery(f.payload, f.len); break;
    case FA_T_CFG_ACTIVATE: faCmdCfgActivate(f.payload, f.len); break;
    case FA_T_CFG_BEGIN:    faCmdCfgBegin(f.payload, f.len); break;
    case FA_T_CFG_WRITE:    faCmdCfgWrite(f.payload, f.len); break;
    case FA_T_CFG_COMMIT:   (void)f; faCmdCfgCommit(); break;
    case FA_T_LAYER_DUMP:   faCmdLayerDump(f.payload, f.len); break;
    case FA_T_LINE:         faCmdLine(f.payload, f.len); break;
    default:
      // Belum diimplementasikan pada fase ini, dan itu dikatakan terus terang
      // lewat ERR - bukan diam-diam, karena diam-diam akan membuat app
      // menunggu jawaban yang tidak akan pernah datang.
      faReplyUnsupported(f.type);
      break;
  }
}

// Satu byte masuk ke perakit. Dipanggil dari checkSerialInput().
static void faProtoFeed(uint8_t b) {
  fa_feed_t r = faFeed(&faSt, b);
  if (r == FA_F_FRAME) {
    if (faNextFrame(&faSt, &faRxFrame)) {
      faHandleFrame(faRxFrame);
    }
    return;
  }
  if (r == FA_F_ERR_CRC) { faRxErrCrc++; return; }
  if (r == FA_F_ERR_VER) { faRxErrVer++; return; }
  if (r == FA_F_ERR_LEN) { faRxErrLen++; return; }
}

// Cermin satu baris teks ke LOGS, untuk perintah diagnostik saja.
//
// Kenapa perlu: perintah SIG / SIG:ALL / FRAME ada justru supaya manusia bisa
// membacanya, dan tempat manusia membacanya adalah Serial Monitor. Tanpa ini,
// jawaban mereka keluar lewat NUS ke companion app - dan di Serial Monitor
// hanya terlihat keheningan, yang tidak bisa dibedakan dari perintah yang tidak
// pernah sampai.
//
// Cakupannya SENGAJA hanya perintah diagnostik. Jawaban frame (HELLO_RSP,
// CFG_META, CFG_ACT_RSP) TIDAK dicerminkan: itu jawaban protokol, dan
// menggandakannya di LOGS akan membuat device yang membaca keduanya mengira
// ada dua jawaban untuk satu permintaan.
//
// Dilempar hanya kalau Serial dan LOGS bukan objek yang sama kalau Serial==LOGS: kalau
// keduanya objek yang sama, tanpa pengecekan ini setiap baris muncul DUA
// kali di Serial Monitor.
//
// Bibformat pakai forwarding, bukan sprintf ke buffer dulu, supaya tidak ada
// format-specifier yang harus dicocokkan dua kali - dan salah satu dari
// keduanya pasti akan menyimpang begitu ada field baru.
template <typename... Args>
static void faLogJuga(bool fmt, const char* format, Args... args) {
  if (g_transport == g_logTransport) return;
  if (fmt) LOGS->printf(format, args...);
  else      LOGS->println(format);
}

// ---- Perintah diagnostik: FRAMEIN ----
//
// Memasukkan byte frame dari Serial Monitor, dengan DUA bentuk:
//
//   FRAMEIN:CFG_QUERY      device yang menyusun frame-nya sendiri
//   FRAMEIN:A5 02 13 ...   byte mentah apa adanya
//
// Bentuk pertama adalah yang dipakai. Bentuk kedua ada untuk menguji byte
// yang salah pada sengaja - CRC rusak, versi rusak, LEN monster - yang justru
// tidak bisa dicapai lewat bentuk pertama.
//
// Kenapa bentuk pertama harus ada: menyalin byte hasil hitung CRC manusia ke
// Serial Monitor adalah sumber kesalahan yang tidak bisa dibedakan dari bug
// firmware. Percobaan pertama mengirim 21 byte dan hanya menghasilkan satu
// CRC error - penyebabnya byte yang salah ketik, dan gejalanya ("tidak ada
// frame masuk") sama persis dengan "perakit frame rusak". Dengan CRC dihitung
// di dalam device, bentuk pertama tidak mungkin salah, jadi kalau bentuk
// pertama gagal, penyebabnya pasti di device.
//
// Bentuk pertama juga membuat Serial Monitor berguna tanpa tooling apa pun di
// sisi host - tidak perlu Node, tidak perlu Python, tidak perlu tabel CRC.
static int faHexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static void faProtoFrameIn(const String& teks) {
  faSetMode(true);
  int fed = 0, ditolak = 0;
  const char* s = teks.c_str();
  while (*s) {
    while (*s == ' ') s++;
    if (!*s) break;

    const int hi = faHexDigit(s[0]);
    if (hi >= 0 && faHexDigit(s[1]) >= 0) {
      faProtoFeed((uint8_t)((hi << 4) | faHexDigit(s[1])));
      s += 2;
    } else {
      // Byte teks apa adanya, dipakai untuk isi frame LINE.
      faProtoFeed((uint8_t)*s);
      s += 1;
    }
    fed++;
  }
  (void)ditolak;
  DBG("[FRAME] FRAMEIN: %d byte, mode=%s, rx=%lu, crcErr=%lu\n",
               fed, faModeFrame() ? "frame" : "baris",
               (unsigned long)faRxFrames, (unsigned long)faRxErrCrc);
}

// Susun frame di device lalu langsung oper ke perakit.
//
// Dipakai oleh FRAMEIN:<NAMA>.
// Penyusunnya harus sama dengan yang dipakai untuk jawaban; kalau tidak,
// frame yang diuji bisa berbeda dari frame yang benar-benar dikirim ke app.
//
// Susun frame di device lalu oper ke perakit, satu byte demi satu byte.
//
// Sengaja memakai faEncode() yang sama dengan faSend(). Kalau jalur ini
// menyusun frame-nya sendiri, frame yang diuji bisa berbeda dari frame yang
// benar-benar dikirim ke app - dan test-nya tidak lagi menguji apa yang ada
// di dunia nyata.
static void faProtoFeedEncoded(uint8_t type, const uint8_t* payload, uint16_t len) {
  // BUFFER SENDUP ANDA, bukan faSendBuf.
  //
  // faSendBuf dipakai bersama oleh faSend(). faProtoFeed() memanggil
  // faHandleFrame() secara SINKRON, dan faHandleFrame() memanggil faSend() yang
  // menulis ke faSendBuf. Jadi kalau byte frame di-injeksi dibaca dari
  // faSendBuf, begitu frame pertama selesai diproses, byte yang dibaca berikutnya
  // adalah BYTE JAWABAN - bukan sisa frame yang disusun.
  //
  // Gejalanya persis seperti yang terjadi di perangkat: satu FRAMEIN:CFG_QUERY
  // menghasilkan rx=2 (jawaban ikut terhitung sebagai frame), lalu byte acak
  // pada payload jawaban berisi 0x0A yang mematikan mode frame, sehingga perintah
// FRAME berikutnya melaporkan mode=baris.
  //
  // Dua buffer terpisah menghapus kemungkinan aliasing sama sekali, dan
  // biayanya satu blok 519 byte yang dipakai sesaat.
  static uint8_t buf[FA_OVERHEAD + FA_MAX_PAYLOAD];

  const size_t n = faEncode(type, payload, len, buf, sizeof(buf));
  if (n == 0) {
    DBG("[FRAME] FRAMEIN: %s tidak bisa disusun (payload %u byte)\n",
                 frameTypeName(type), (unsigned)len);
    return;
  }
  // Cetak byte-nya. Tanpa ini, kalau frame yang disusun memang salah, tidak
  // ada yang bisa dibandingkan dengan byte yang dikirim app - dan "coba ulangi"
  // jadi satu-satunya pilihan.
  DBG("[FRAME] %s (%u byte):", frameTypeName(type), (unsigned)n);
  for (size_t i = 0; i < n; i++) LOGS->printf(" %02x", buf[i]);
  LOGS->println("");
  // Salin dulu: buf ada di static, tapi isinya tidak akan berubah oleh
  // faSend(). Yang berubah adalah faSendBuf.
  for (size_t i = 0; i < n; i++) faProtoFeed(buf[i]);
}

static void faProtoFrameByName(const String& nama) {
  faSetMode(true);
  uint8_t tipe = 0;
  bool ada = true;
  uint8_t arg = 0;
  bool adaArg = false;

  const String n = nama;   // Working copy: String::substring() di Arduino
                           // mengembalikan objek baru, jadi slicing di bawah
                           // aman dan tidak mengubah parameter.
  if (n.startsWith("HELLO"))        tipe = FA_T_HELLO;
  else if (n.startsWith("CFG_QUERY"))    tipe = FA_T_CFG_QUERY;
  else if (n.startsWith("CFG_ACTIVATE")) tipe = FA_T_CFG_ACTIVATE;
  else if (n.startsWith("CFG_BEGIN"))    tipe = FA_T_CFG_BEGIN;
  else if (n.startsWith("CFG_WRITE"))    tipe = FA_T_CFG_WRITE;
  else if (n.startsWith("CFG_COMMIT"))   tipe = FA_T_CFG_COMMIT;
  else if (n.startsWith("EVT"))          tipe = FA_T_EVT;
  else if (n.startsWith("LINE:")) {
    // LINE:<teks> menjadi payload frame LINE, jadi perintah teks bisa
    // dicoba lewat jalur frame - persis skenario yang dipakai app nanti.
    //
    // tipe HARUS diisi di sini juga. Versi pertama melewatkannya, jadi
    // FRAME dikirim dengan TYPE=0x00 dan device menjawab "tidak dikenal"
    // (unsup=1) - padahal nama frame-nya jelas-jelas dikenal.
    tipe = FA_T_LINE;
    const String isi = n.substring(5);
    uint8_t buf[MACRO_MAX_LEN * 2];
    const uint16_t len = (uint16_t)min((int)sizeof(buf), (int)isi.length());
    memcpy(buf, isi.c_str(), len);
    faProtoFeedEncoded(tipe, buf, len);
    return;
  } else {
    ada = false;
  }

  // CFG_ACTIVATE:<n> menyertakan nomor slot sebagai payload 1 byte.
  const int colon = n.indexOf(':');
  if (colon > 0) {
    const String sisa = n.substring(colon + 1);
    if (sisa.length() > 0) {
      arg = (uint8_t)atoi(sisa.c_str());
      adaArg = true;
    }
  }

  if (!ada) {
    DBG("[FRAME] FRAMEIN: nama frame tidak dikenal");
    DBG("[FRAME] yang bisa: HELLO, CFG_QUERY, CFG_ACTIVATE:<n>, CFG_BEGIN,");
    DBG("[FRAME]            CFG_WRITE, CFG_COMMIT, EVT, LINE:<teks>");
    faCxUnsup++;
    return;
  }

  uint8_t buf[1] = { arg };
  faProtoFeedEncoded(tipe, adaArg ? buf : NULL, adaArg ? 1 : 0);
}

static bool protoFrameCommand(const String& cmd) {
  if (cmd.startsWith("FRAMEIN:")) {
    const String isi = cmd.substring(8);
    // Huruf besar = nama frame, huruf kecil/spasi = byte mentah. Pemisahnya
    // sengaja tidak menebak-nebak isi: kalau hex salah ketik, bentuk kedua
    // akan melaporkan CRC error, yang sudah jelas salahnya di mana.
    bool semuaHexDanSpasi = true;
    for (unsigned i = 0; i < isi.length(); i++) {
      const char ch = isi[i];
      if (ch == ' ') continue;
      if (faHexDigit(ch) < 0) { semuaHexDanSpasi = false; break; }
    }
    if (!semuaHexDanSpasi && isi.length() > 0) faProtoFrameByName(isi);
    else                                          faProtoFrameIn(isi);
    return true;
  }

  if (cmd == "FRAME") {
    SERIAL->printf("FRAME:mode=%s,rx=%lu,tx=%lu,txDrop=%lu,txErr=%lu,crcErr=%lu,verErr=%lu,lenErr=%lu,unsup=%lu\n",
                   faModeFrame() ? "frame" : "baris",
                   (unsigned long)faRxFrames, (unsigned long)faTxFrames,
                   (unsigned long)faTxDropped, (unsigned long)faTxErrEncode,
                   (unsigned long)faRxErrCrc, (unsigned long)faRxErrVer,
                   (unsigned long)faRxErrLen, (unsigned long)faCxUnsup);
    faLogJuga(true, "FRAME:mode=%s,rx=%lu,tx=%lu,txDrop=%lu,txErr=%lu,crcErr=%lu,verErr=%lu,lenErr=%lu,unsup=%lu",
              faModeFrame() ? "frame" : "baris",
              (unsigned long)faRxFrames, (unsigned long)faTxFrames,
              (unsigned long)faTxDropped, (unsigned long)faTxErrEncode,
              (unsigned long)faRxErrCrc, (unsigned long)faRxErrVer,
              (unsigned long)faRxErrLen, (unsigned long)faCxUnsup);
    return true;
  }

  if (cmd == "FRAME:LINE") {
    faSetMode(false);
    serialLineReset();
    SERIAL->println("[OK] Frame mode dimatikan, kembali ke mode baris");
    faLogJuga(false, "[OK] Frame mode dimatikan, kembali ke mode baris");
    return true;
  }

  // Sidik jari config aktif, dicetak sebagai teks biasa supaya bisa dibaca dan
  // dibandingkan dengan sisi app tanpa tooling tambahan.
  if (cmd == "SIG") {
    SERIAL->printf("SIG:%08lX\n", (unsigned long)faActiveSig());
    faLogJuga(true, "SIG:%08lX", (unsigned long)faActiveSig());
    return true;
  }

  if (cmd == "SIG:ALL") {
    for (uint8_t i = 0; i < APP_SLOTS; i++) {
      SERIAL->printf("SIGSLOT:%u:%08lX,layers=%u,active=%u\n",
                     (unsigned)i, (unsigned long)faSigOfSlot(i),
                     (unsigned)slotCfg[i].layerCount,
                     (unsigned)((faActiveSlot() == i) ? 1 : 0));
      faLogJuga(true, "SIGSLOT:%u:%08lX,layers=%u,active=%u",
                (unsigned)i, (unsigned long)faSigOfSlot(i),
                (unsigned)slotCfg[i].layerCount,
                (unsigned)((faActiveSlot() == i) ? 1 : 0));
    }
    return true;
  }

  return false;
}


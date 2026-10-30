//! =================== CODEC FRAME v2 (Rust) ===================
//!
//! Decoder frame untuk protokol v2. Cermin persis `firmware/common/frame.h`.
//!
//! Kenapa perlu implementasi ketiga di Rust: byte BLE masuk lewat GATT notify,
//! jadi melintas proses Tauri sebelum sampai ke frontend. Kalau penyusunan
//! frame divalidasi di dua tempat sekaligus, keduanya bisa menyimpang dan
//! gejalanya "seadang frame lengkap kadang tidak" - sulit ditelusuri. Dengan
//! satu implementasi di Rust, byte yang dinilai sah di sisi host dan byte yang
//! dinilai sah di sisi device melewati definisi yang sama.
//!
//! YANG BELUM DIKERJAKAN di sini, disengaja untuk fase ini:
//! - Codec ini belum tersambung ke link BLE sama sekali. Fase 1 murni pengujian.
//! - Alokasi pada jalur notify diminimalkan: array payload berukuran tetap,
//!   disalin ke `Vec` hanya ketika frame benar-benar selesai.
//!
//! Spesifikasi format ada di `firmware/common/frame.h`. File ini mengikutinya,
//! bukan menyalin logikanya sendiri: `tools/gen-vectors.mjs` membangkitkan
//! golden vectors yang dipakai ketiga bahasa untuk membuktikan mereka setara.

pub const SOF: u8 = 0xa5;
pub const VER: u8 = 0x02;
pub const HEADER_LEN: usize = 5;
pub const OVERHEAD: usize = 7;
pub const MAX_PAYLOAD: usize = 512;

pub const T_HELLO: u8 = 0x01;
pub const T_LINE: u8 = 0x02;
pub const T_CFG_BEGIN: u8 = 0x10;
pub const T_CFG_WRITE: u8 = 0x11;
pub const T_CFG_COMMIT: u8 = 0x12;
pub const T_CFG_QUERY: u8 = 0x13;
pub const T_CFG_ACTIVATE: u8 = 0x14;
pub const T_EVT: u8 = 0x20;
pub const T_ERR: u8 = 0x7f;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    BadVer,
    BadCrc,
    LenOverflow,
}

impl FrameError {
    pub fn name(&self) -> &'static str {
        match self {
            FrameError::BadVer => "BAD_VER",
            FrameError::BadCrc => "BAD_CRC",
            FrameError::LenOverflow => "LEN_OVERFLOW",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Frame { typ: u8, payload: Vec<u8> },
    Error(FrameError),
}

#[derive(Debug, Default, Clone)]
pub struct DecoderStats {
    pub frames_ok: u64,
    pub err_ver: u64,
    pub err_crc: u64,
    pub err_len: u64,
    pub resyncs: u64,
}

fn crc16_update(mut crc: u16, b: u8) -> u16 {
    crc ^= (b as u16) << 8;
    for _ in 0..8 {
        crc = if crc & 0x8000 != 0 {
            (crc << 1) ^ 0x1021
        } else {
            crc << 1
        };
    }
    crc
}

/// CRC16/CCITT-FALSE. Parameter wajib identik dengan `frame.h`.
pub fn crc16(bytes: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in bytes {
        crc = crc16_update(crc, b);
    }
    crc
}

/// Header + payload + CRC, cermin dari `faEncode()`.
pub fn encode(typ: u8, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(3 + payload.len());
    body.push(typ);
    body.push((payload.len() & 0xFF) as u8);
    body.push(((payload.len() >> 8) & 0xFF) as u8);
    body.extend_from_slice(payload);

    let crc = crc16(&body);

    let mut out = Vec::with_capacity(OVERHEAD + payload.len());
    out.push(SOF);
    out.push(VER);
    out.extend_from_slice(&body);
    out.push((crc & 0xFF) as u8);
    out.push((crc >> 8) as u8);
    out
}

const ST_SOF: u8 = 0;
const ST_VER: u8 = 1;
const ST_TYPE: u8 = 2;
const ST_LEN: u8 = 3;
const ST_PAYLOAD: u8 = 4;
const ST_CRC: u8 = 5;
const ST_SKIP: u8 = 6;

pub struct FrameDecoder {
    st: u8,
    typ: u8,
    want: u16,
    got: u16,
    payload: [u8; MAX_PAYLOAD],
    crc: u16,
    got_crc: u16,
    pub stats: DecoderStats,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameDecoder {
    pub fn new() -> Self {
        FrameDecoder {
            st: ST_SOF,
            typ: 0,
            want: 0,
            got: 0,
            payload: [0u8; MAX_PAYLOAD],
            crc: 0xFFFF,
            got_crc: 0,
            stats: DecoderStats::default(),
        }
    }

    /// Titik masuk tunggal untuk semua jalur kesalahan, supaya tidak ada
    /// keadaan yang bisa "lupa" kembali ke awal setelah gagal.
    fn resync(&mut self) {
        self.st = ST_SOF;
        self.got = 0;
        self.got_crc = 0;
        self.crc = 0xFFFF;
        self.stats.resyncs += 1;
    }

    /// Masukkan byte dan kembalikan event yang terbentuk.
    ///
    /// `Vec` dipakai karena pemanggilnya handler notify yang tidak punya tempat
    /// menyimpan event antara dua pemanggilan.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Event> {
        let mut out = Vec::new();
        for &b in bytes {
            self.feed(b, &mut out);
        }
        out
    }

    fn feed(&mut self, b: u8, out: &mut Vec<Event>) {
        match self.st {
            ST_SOF => {
                if b == SOF {
                    self.st = ST_VER;
                }
            }
            ST_VER => {
                if b != VER {
                    self.stats.err_ver += 1;
                    self.resync();
                    out.push(Event::Error(FrameError::BadVer));
                    return;
                }
                self.crc = 0xFFFF;
                self.got = 0;
                self.st = ST_TYPE;
            }
            ST_TYPE => {
                self.typ = b;
                self.crc = crc16_update(self.crc, b);
                self.want = 0;
                self.got = 0;
                self.st = ST_LEN;
            }
            ST_LEN => {
                self.crc = crc16_update(self.crc, b);
                self.want |= (b as u16) << (8 * self.got);
                self.got += 1;
                if self.got < 2 {
                    return;
                }
                if self.want as usize > MAX_PAYLOAD {
                    self.stats.err_len += 1;
                    self.st = ST_SKIP;
                    self.got = 0;
                    return;
                }
                self.got = 0;
                self.got_crc = 0;
                self.st = if self.want == 0 { ST_CRC } else { ST_PAYLOAD };
            }
            ST_PAYLOAD => {
                if (self.got as usize) < MAX_PAYLOAD {
                    self.payload[self.got as usize] = b;
                }
                self.crc = crc16_update(self.crc, b);
                self.got += 1;
                if self.got >= self.want {
                    self.st = ST_CRC;
                    // `got` WAJIB direset di sini. State CRC memakainya sebagai
                    // indeks byte CRC (0 lalu 1). Kalau dibiarkan berisi
                    // panjang payload, 8 * got melampaui lebar u16 dan Rust
                    // langsung panic dengan "shift left with overflow".
                    self.got = 0;
                    self.got_crc = 0;
                }
            }
            ST_CRC => {
                self.got_crc |= (b as u16) << (8 * self.got);
                self.got += 1;
                if self.got < 2 {
                    return;
                }
                if self.got_crc != self.crc {
                    self.stats.err_crc += 1;
                    self.resync();
                    out.push(Event::Error(FrameError::BadCrc));
                    return;
                }
                self.stats.frames_ok += 1;
                let n = self.want as usize;
                out.push(Event::Frame {
                    typ: self.typ,
                    payload: self.payload[..n].to_vec(),
                });
                self.resync();
            }
            ST_SKIP => {
                self.got += 1;
                if self.got >= self.want {
                    self.resync();
                    out.push(Event::Error(FrameError::LenOverflow));
                }
            }
            _ => self.resync(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn vectors_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("vectors")
            .join("frames.vec")
    }

    fn parse_hex(s: &str) -> Vec<u8> {
        s.split_whitespace()
            .map(|t| u8::from_str_radix(t, 16).expect("hex tidak valid di frames.vec"))
            .collect()
    }

    /// Satu event yang diharapkan, sudah diterjemahan dari teks vektor.
    #[derive(Debug, PartialEq, Eq, Clone)]
    enum Want {
        Frame(u8),
        Error(&'static str),
        /// "Tidak boleh ada event sama sekali".
        Silent,
    }

    fn parse_want(s: &str) -> Vec<Want> {
        if s == "NONE" {
            return vec![Want::Silent];
        }
        s.split(',')
            .filter(|t| !t.trim().is_empty())
            .map(|t| {
                let t = t.trim();
                if let Some(hex) = t.strip_prefix("F:") {
                    Want::Frame(
                        u8::from_str_radix(hex.trim_start_matches("0x"), 16)
                            .expect("tipe frame bukan hex di frames.vec"),
                    )
                } else if let Some(kode) = t.strip_prefix("E:") {
                    Want::Error(match kode {
                        "BAD_VER" => "BAD_VER",
                        "BAD_CRC" => "BAD_CRC",
                        "LEN_OVERFLOW" => "LEN_OVERFLOW",
                        lain => panic!("kode error tak dikenal di frames.vec: {}", lain),
                    })
                } else {
                    panic!("token ekspektasi tak dikenal di frames.vec: {}", t)
                }
            })
            .collect()
    }

    struct Case {
        name: String,
        want: Vec<Want>,
        bytes: Vec<u8>,
    }

    fn load_vectors() -> Vec<Case> {
        let text = fs::read_to_string(vectors_path()).unwrap_or_else(|_| {
            panic!(
                "tests/vectors/frames.vec tidak ada - jalankan: node tools/gen-vectors.mjs (dari {:?})",
                vectors_path()
            )
        });
        let mut out = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut it = line.split_whitespace();
            assert_eq!(it.next(), Some("SEQ"), "baris tak dikenal: {}", line);
            let name = it.next().expect("SEQ tanpa nama").to_string();
            let sisa: Vec<&str> = it.collect();
            assert!(!sisa.is_empty(), "SEQ tanpa ekspektasi: {}", name);
            let expect = sisa[sisa.len() - 1];
            let bytes = parse_hex(&sisa[..sisa.len() - 1].join(" "));
            out.push(Case {
                name,
                want: parse_want(expect),
                bytes,
            });
        }
        out
    }

    fn want_to_vec(w: &[Want]) -> Vec<String> {
        match w {
            [Want::Silent] => Vec::new(),
            lain => lain
                .iter()
                .map(|x| match x {
                    Want::Frame(t) => format!("F:0x{:02x}", t),
                    Want::Error(k) => format!("E:{}", k),
                    Want::Silent => unreachable!(),
                })
                .collect(),
        }
    }

    fn event_to_vec(e: &[Event]) -> Vec<String> {
        e.iter()
            .map(|x| match x {
                Event::Frame { typ, .. } => format!("F:0x{:02x}", typ),
                Event::Error(err) => format!("E:{}", err.name()),
            })
            .collect()
    }

    #[test]
    fn crc16_check_value_baku() {
        // Nilai rukun CRC16/CCITT-FALSE. Kalau angka ini berubah, semua byte di
        // kabel berubah - itu bukan lagi "perubahan kecil".
        assert_eq!(crc16(b"123456789"), 0x29B1);
    }

    #[test]
    fn semua_golden_vectors_sesuai() {
        let cases = load_vectors();
        assert!(cases.len() >= 25, "golden vectors terlalu sedikit: {}", cases.len());

        let mut gagal = Vec::new();
        for c in &cases {
            let mut d = FrameDecoder::new();
            let ev = d.push(&c.bytes);
            let didapat = event_to_vec(&ev);
            let harap = want_to_vec(&c.want);
            if didapat != harap {
                gagal.push(format!(
                    "{}: harap [{}], dapat [{}]",
                    c.name,
                    harap.join(","),
                    didapat.join(",")
                ));
                continue;
            }
            // Untuk vektor yang persis satu frame, encode() wajib mengembalikan
            // byte yang sama persis. Ini menutup jebakan di mana encode dan
            // decode sama-sama salah dengan cara yang sama sehingga test hijau
            // padahal keduanya salah.
            //
            // Syarat "persis satu frame" diperiksa lewat panjang: vektor yang
            // diawali noise atau berisi beberapa frame jelas lebih panjang dari
            // 7 + len(payload), jadi tidak ikut dibandingkan.
            if c.want.len() == 1 && ev.len() == 1 {
                if let Event::Frame { typ, payload } = &ev[0] {
                    let ulang = encode(*typ, payload);
                    if c.bytes.len() == OVERHEAD + payload.len() && ulang != c.bytes {
                        gagal.push(format!("{}: encode() byte-nya beda dari vektor", c.name));
                    }
                }
            }
        }
        assert!(gagal.is_empty(), "golden vectors gagal:\n{}", gagal.join("\n"));
    }

    #[test]
    fn payload_dengan_byte_struktural_aman() {
        // 0xA5 (SOF) dan 0x02 (VER) di dalam payload. Perakit yang salah akan
        // salah memotong frame tepat di sini.
        let payload: Vec<u8> = vec![0xa5, 0x02, 0x00, 0xff, 0xa5, 0xa5, 0x0a, 0x02];
        let bytes = encode(T_CFG_WRITE, &payload);
        let mut d = FrameDecoder::new();
        let ev = d.push(&bytes);
        assert_eq!(ev.len(), 1, "harus tepat satu frame, dapat {:?}", ev);
        match &ev[0] {
            Event::Frame { typ, payload: got } => {
                assert_eq!(*typ, T_CFG_WRITE);
                assert_eq!(got, &payload);
            }
            e => panic!("unexpected {:?}", e),
        }
    }

    #[test]
    fn rusak_satu_tidak_mematikan_stream() {
        let a = encode(T_EVT, &[1, 2, 3]);
        let b = encode(T_CFG_QUERY, &[]);
        let mut stream = Vec::new();
        stream.extend_from_slice(&a);
        // Byte kacau total termasuk SOF palsu, supaya perakit yang reset
        // berlebihan ikut ketahuan.
        stream.extend_from_slice(&[0x00, 0xa5, 0x01, 0x02, 0x03, 0x04, 0x05]);
        stream.extend_from_slice(&b);

        let mut d = FrameDecoder::new();
        let ev = d.push(&stream);
        let frames: Vec<u8> = ev
            .iter()
            .filter_map(|e| match e {
                Event::Frame { typ, .. } => Some(*typ),
                _ => None,
            })
            .collect();
        assert_eq!(
            frames,
            vec![T_EVT, T_CFG_QUERY],
            "kedua frame sah harus selamat dari byte kacau"
        );
    }

    #[test]
    fn feed_satu_per_satu_sama_dengan_feed_batch() {
        // Alur nyata di device: byte datang satu per satu dari notify.
        // Kalau hasilnya beda dengan feed sekaligus, ada state yang tersembunyi.
        let bytes = encode(T_CFG_WRITE, &[0x00, 0x01, 0x02, 0x03, 0x04]);
        let mut satu = FrameDecoder::new();
        let mut kumpulan = Vec::new();
        for &b in &bytes {
            kumpulan.extend(satu.push(&[b]));
        }
        let mut langsung = FrameDecoder::new();
        assert_eq!(kumpulan, langsung.push(&bytes));
    }

    #[test]
    fn chunk_acak_tidak_mengubah_hasil() {
        // Cara paling umum salah pada codec streaming: batas chunk memotong frame
        // di tengah. Di sini satu stream identik dipecah pada semua kemungkinan
        // batas, dan hasilnya harus sama persis.
        let mut stream = Vec::new();
        stream.extend_from_slice(&encode(T_CFG_QUERY, &[]));
        stream.extend_from_slice(&encode(T_EVT, &[1, 2, 3, 4, 5]));
        stream.extend_from_slice(&encode(T_CFG_ACTIVATE, &[7]));

        let referensi = {
            let mut d = FrameDecoder::new();
            d.push(&stream)
        };
        for cut in 1..stream.len() {
            let mut d = FrameDecoder::new();
            let mut got = Vec::new();
            got.extend(d.push(&stream[..cut]));
            got.extend(d.push(&stream[cut..]));
            assert_eq!(got, referensi, "berbeda saat dipotong pada byte {}", cut);
        }
    }

    #[test]
    fn len_kelewat_besar_tidak_menggeser_ke_tengah() {
        // LEN = 513. Byte sisanya sengaja berisi 0xA5 supaya decoder yang salah
        // akan membingkai frame palsu dari sisa payload.
        let mut bytes = vec![SOF, VER, T_CFG_WRITE, 0x01, 0x02];
        bytes.extend(std::iter::repeat_n(0xa5, 513));
        bytes.extend_from_slice(&encode(T_CFG_QUERY, &[]));

        let mut d = FrameDecoder::new();
        let ev = d.push(&bytes);
        let errs: Vec<&str> = ev
            .iter()
            .filter_map(|e| match e {
                Event::Error(e) => Some(e.name()),
                _ => None,
            })
            .collect();
        assert_eq!(errs, vec!["LEN_OVERFLOW"]);
        let frames = ev.iter().filter(|e| matches!(e, Event::Frame { .. })).count();
        assert_eq!(frames, 1, "frame sah setelah overflow harus tetap terbaca");
    }
}

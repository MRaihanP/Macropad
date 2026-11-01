//! Lock-free single-producer single-consumer ring buffer untuk sample f32.
//!
//! Dipakai di jalur audio supaya callback cpal tidak pernah menyentuh Mutex
//! atau melakukan alokasi. Aturan pemakaian:
//!   - `push` hanya boleh dipanggil SATU thread (producer).
//!   - `pop` hanya boleh dipanggil SATU thread lain (consumer).
//!   - `clear` hanya saat consumer berhenti, atau dari consumer itu sendiri.
//!
//! Contoh: mixer thread push ke `cable_ring`, callback output CABLE pop.

use std::sync::atomic::{AtomicUsize, Ordering};

pub struct SpscRing {
    /// Hanya untuk memiliki alokasi; isinya diakses lewat `ptr`.
    _buf: Box<[f32]>,
    ptr: *mut f32,
    mask: usize,
    /// Posisi tulis (monotonic, bukan index).
    head: AtomicUsize,
    /// Posisi baca (monotonic, bukan index).
    tail: AtomicUsize,
}

impl SpscRing {
    /// `capacity` dibulatkan ke pangkat dua terdekat.
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(2).next_power_of_two();
        let mut buf = vec![0.0f32; cap].into_boxed_slice();
        let ptr = buf.as_mut_ptr();
        Self {
            _buf: buf,
            ptr,
            mask: cap - 1,
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        }
    }

    #[inline]
    pub fn capacity(&self) -> usize {
        self.mask + 1
    }

    #[inline]
    pub fn len(&self) -> usize {
        let head = self.head.load(Ordering::Acquire);
        let tail = self.tail.load(Ordering::Acquire);
        head.wrapping_sub(tail).min(self.capacity())
    }

    #[inline]
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Producer only. Mengembalikan jumlah sample yang benar-benar masuk.
    pub fn push(&self, data: &[f32]) -> usize {
        if data.is_empty() {
            return 0;
        }
        // SAFETY: hanya satu thread (producer) yang menulis ke `buf`, dan
        // region yang ditulis tidak pernah overlap dengan region yang dibaca
        // consumer karena `head`/`tail` menjaga jarak. Kita memakai raw pointer
        // (bukan &mut ke seluruh buffer) supaya tidak membuat referensi yang
        // aliasing dengan consumer.
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        let used = head.wrapping_sub(tail);
        if used >= self.capacity() {
            return 0;
        }
        let free = self.capacity() - used;
        let n = data.len().min(free);
        for (i, sample) in data.iter().take(n).enumerate() {
            unsafe {
                self.ptr.add((head + i) & self.mask).write(*sample);
            }
        }
        self.head.store(head.wrapping_add(n), Ordering::Release);
        n
    }

    /// Consumer only. Mengembalikan jumlah sample yang benar-benar dibaca.
    pub fn pop(&self, out: &mut [f32]) -> usize {
        if out.is_empty() {
            return 0;
        }
        // SAFETY: lihat komentar di `push`.
        let tail = self.tail.load(Ordering::Relaxed);
        let head = self.head.load(Ordering::Acquire);
        let used = head.wrapping_sub(tail);
        let n = out.len().min(used);
        for (i, slot) in out.iter_mut().take(n).enumerate() {
            *slot = unsafe { self.ptr.add((tail + i) & self.mask).read() };
        }
        self.tail.store(tail.wrapping_add(n), Ordering::Release);
        n
    }

    /// Consumer only. Buang semua data yang belum dibaca.
    pub fn clear(&self) {
        let head = self.head.load(Ordering::Acquire);
        self.tail.store(head, Ordering::Release);
    }

    /// Consumer only. Buang sample paling lama sampai tersisa `target` sample.
    ///
    /// Dipakai mic ring: kalau mixer sempat stall, audio lama tidak boleh
    /// diputar tertinggal; lebih baik dibuang supaya tetap near-real-time.
    pub fn trim_to(&self, target: usize) {
        let used = self.len();
        if used <= target {
            return;
        }
        let drop = used - target;
        let tail = self.tail.load(Ordering::Relaxed);
        self.tail.store(tail.wrapping_add(drop), Ordering::Release);
    }
}

// SAFETY: `SpscRing` hanya mengizinkan satu producer dan satu consumer, dan
// akses ke `buf` disinkronkan oleh `head`/`tail` (Acquire/Release). Kombinasi
// ini membuat shared reference aman dipakai lintas thread selama aturan SPSC
// dipatuhi (didokumentasikan di atas), sama seperti ringbuf::HeapRb.
unsafe impl Send for SpscRing {}
unsafe impl Sync for SpscRing {}

#[cfg(test)]
mod tests {
    use super::SpscRing;

    #[test]
    fn push_pop_wraparound_tetap_urut() {
        let ring = SpscRing::new(4);
        let mut out = [0.0f32; 4];

        assert_eq!(ring.push(&[1.0, 2.0, 3.0]), 3);
        assert_eq!(ring.pop(&mut out[..2]), 2);
        assert_eq!(&out[..2], &[1.0, 2.0]);

        // head sudah lewat ujung buffer: penulisan harus wrap ke awal.
        assert_eq!(ring.push(&[4.0, 5.0, 6.0]), 3);
        assert_eq!(ring.pop(&mut out), 4);
        assert_eq!(out, [3.0, 4.0, 5.0, 6.0]);
        assert_eq!(ring.len(), 0);
    }

    #[test]
    fn push_penuh_tidak_menimpa_data_lama() {
        let ring = SpscRing::new(4);
        assert_eq!(ring.push(&[1.0, 2.0, 3.0, 4.0, 5.0]), 4);

        let mut out = [0.0f32; 4];
        assert_eq!(ring.pop(&mut out), 4);
        assert_eq!(out, [1.0, 2.0, 3.0, 4.0]);
        assert_eq!(ring.push(&[5.0]), 1);
    }

    #[test]
    fn clear_membuang_data_belum_dibaca() {
        let ring = SpscRing::new(8);
        assert_eq!(ring.push(&[1.0, 2.0, 3.0]), 3);
        ring.clear();

        let mut out = [0.0f32; 3];
        assert_eq!(ring.pop(&mut out), 0);
        assert_eq!(ring.len(), 0);
    }

    #[test]
    fn trim_to_membuang_sample_paling_lama() {
        let ring = SpscRing::new(8);
        assert_eq!(ring.push(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]), 6);

        ring.trim_to(3);

        assert_eq!(ring.len(), 3);
        let mut out = [0.0f32; 3];
        assert_eq!(ring.pop(&mut out), 3);
        assert_eq!(out, [4.0, 5.0, 6.0], "sample terbaru harus dipertahankan");
    }

    #[test]
    fn trim_to_tidak_mengubah_ring_yang_sudah_kecil() {
        let ring = SpscRing::new(8);
        assert_eq!(ring.push(&[1.0, 2.0]), 2);

        ring.trim_to(4);

        assert_eq!(ring.len(), 2);
    }
}

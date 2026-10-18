// ==================== LAPISAN DIAGNOSA (L0-L4) ====================
//
// Modul MURNI: tidak meng-import apa pun. Semua masukan come sebagai objek
// biasa, semua keluaran adalah teks.
//
// Kenapa dipisah dari ble-transport.js:
//
// Vonis ("masalahnya ada di lapis mana") adalah bagian paling berharga dari
// fase ini, dan bagian itu HARUS bisa diuji tanpa Tauri, tanpa DOM, dan
// tanpa device. Kalau ia ikut tinggal di backend, satu-satunya cara mengujinya
// adalah membaca teksnya secara visual - persis cara kita selama ini
// mendiagnosis masalah: membaca log dan menebak.
//
// Dengan dipisah, setiap kegagalan yang nyata bisa disuntikkan sebagai angka
// dan diperiksa apakah vonisnya benar-benar menyebut lapis yang tepat.
// Lihat tests/suites/diag-report-test.mjs.

/**
 * "KEY=VALUE,KEY=VALUE" -> objek.
 *
 * Sengaja tanpa regex/JSON: format ini dijamin firmware (diag.h) dan parser
 * sesederhana mungkin = paling sedikit yang bisa salah di masa depan.
 *
 * Nilai kosong (mis. lastCmd= saat tidak ada perintah) disimpan sebagai string
 * kosong, bukan dihapus - beda "tidak ada nilainya" dengan "tidak ada
 * kuncinya" penting waktu menebak penyebab.
 */
export function parseKV(s) {
  const out = {};
  for (const pair of String(s || '').split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/** Angka dari objek KV. Key hilang / bukan angka -> 0, bukan NaN. */
export function num(obj, key) {
  const v = parseInt(obj?.[key], 10);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Ringkasan latensi: p50 dan p95.
 *
 * Mean sengaja tidak dipakai: satu timeout 5 detik akan menutupi semua sampel
 * lain yang sehat, dan kesimpulannya jadi "link lambat" padahal biasanya
 * justru "satu paket hilang".
 */
export function rttSummary(samples) {
  if (!samples || !samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1], n: s.length };
}

/**
 * Vonis: satu kalimat yang menyebut lapis dan penyebab.
 *
 * Urutan dari paling spesifik ke paling umum. Ini penting: beberapa kondisi
 * bisa benar bersamaan, dan usersiet yang paling bisa ditindaklanjuti harus
 * menang - bukan yang paling mudah dicek.
 *
 * proto = jawaban firmware DIAG:    lines, cmds, tooLong, unknown, transport, lastCmd, heap
 * media = jawaban firmware DIAGMEDIA: notifyOk/Fail/Retries, ringHigh/Size/Dropped, noConn, noSub, mtu, sub
 * link  = counter host (ble_stats):  notify_*, read_*, write_*, rx_dropped_bytes, connect/disconnect
 */
export function diagVerdict(proto, media, link) {
  // Belum ada data sama sekali. Bedakan dari "data ada tapi bersih" - keduanya
  // tampilannya mirip kalau tidak disebut eksplisit.
  if (!proto && !media && !link)
    return 'BELUM ADA DATA - device belum menjawab DIAG sama sekali (periksa L1/L4).';

  // 1. App belum subscribe notify.
  //    GATT nyambung, CCCD belum ditulis, jadi device membuang SEMUA write.
  //    Gejalanya persis "connect berhasil tapi device diam" - padahal
  //    penyebabnya di sisi app dan perbaikannya satu baris.
  if (media && num(media, 'noSub') > 0)
    return `L1/L4: app belum subscribe notify (noSub=${num(media, 'noSub')}). ` +
      'Perintah yang dikirim memang sampai ke device, tapi device membuangnya ' +
      'karena tidak ada yang mendengarkan.';

  // 2. Data hilang di sisi host.
  //    App berhenti menarik buffer (jendela ditutup, laptop tidur, modal blocking).
  if (link && num(link, 'rx_dropped_bytes') > 0)
    return `L1: ${num(link, 'rx_dropped_bytes')} byte hilang karena app tidak menarik ` +
      `buffer (overflow ${num(link, 'rx_overflow_events')}x). Bukan radio - host yang lambat.`;

  // 3. Antrean menumpuk DI DALAM device.
  //    Ring buffer NUS penuh: device tidak sempat memproses perintah yang
  //    dikirim lebih cepat dari kemampuannya memproses.
  if (media && (num(media, 'ringDropped') > 0 ||
    (num(media, 'ringSize') > 0 && num(media, 'ringHigh') >= num(media, 'ringSize') * 0.9)))
    return `L4: antrean menumpuk di device (ringHigh=${num(media, 'ringHigh')}/` +
      `${num(media, 'ringSize')}, dropped=${num(media, 'ringDropped')}). ` +
      'Device lambat membaca, atau app mengirim terlalu cepat.';

  // 4. Notify ditolak -> masalah radio/host, bukan parser dan bukan device.
  if (media && num(media, 'notifyFail') > 0)
    return `L0: notify gagal ${num(media, 'notifyFail')}x setelah semua retry. ` +
      'Ini masalah radio/host (jarak, adapter, Windows), bukan parser.';

  // 5. Write ditolak sisi host. Muncul sebelum "0 perintah sampai" karena lebih
  //    informatif: kita tahu app mencoba dan GATT menolaknya.
  if (link && num(link, 'write_errors') > 0)
    return `L1: ${num(link, 'write_errors')} write ditolak GATT. ` +
      'Perintah tidak pernah sampai ke device.';

  // 6. Baris gagal di layer protokol -> app dan firmware bicara format berbeda.
  if (proto && num(proto, 'tooLong') > 0)
    return `L3: ${num(proto, 'tooLong')} baris melebihi batas firmware (512 byte). ` +
      'Format perintah dari app terlalu panjang untuk protokol ini.';

  if (proto && num(proto, 'unknown') > 0)
    return `L3: ${num(proto, 'unknown')} perintah tidak dikenali firmware. ` +
      'Versi app dan firmware tidak cocok, atau ada perintah yang salah eja.';

  // 7. Tidak ada satu pun perintah yang sampai ke device.
  if (proto && num(proto, 'cmds') === 0) {
    const wrote = link ? num(link, 'write_calls') : 0;
    if (wrote === 0)
      return 'Tidak ada perintah yang dikirim. Periksa dulu lewat mana device disambung.';
    return 'L1: app sudah menulis, tapi firmware mencatat 0 perintah. ' +
      'Data berhenti di tengah link - cek ringDropped dan notifyFail di baris L4.';
  }

  return 'OK: tidak ada indikator kegagalan di L0/L1/L3/L4.';
}

/** Blok laporan lengkap, siap ditampilkan di panel log. */
export function renderDiag(proto, media, link, rtt) {
  const lines = [];
  lines.push('=== DIAG ===');
  lines.push('L0 RADIO  ' + (rtt
    ? `rtt p50=${rtt.p50}ms p95=${rtt.p95}ms max=${rtt.max}ms  mtu=${media ? num(media, 'mtu') : '?'}`
    : `rtt belum ada sampel  mtu=${media ? num(media, 'mtu') : '?'}`));
  lines.push('L1 LINK   ' + (link
    ? `notify=${num(link, 'notify_events')}/${num(link, 'notify_bytes')}B ` +
      `read=${num(link, 'read_calls')}/${num(link, 'read_bytes')}B ` +
      `write=${num(link, 'write_calls')}/${num(link, 'write_bytes')}B ` +
      `writeErr=${num(link, 'write_errors')} rxDropped=${num(link, 'rx_dropped_bytes')}B ` +
      `conn=${num(link, 'connect_count')}/${num(link, 'disconnect_count')}`
    : 'tidak tersedia (ble_stats tidak merespons)'));
  lines.push('L3 PROTO  ' + (proto
    ? `lines=${num(proto, 'lines')} cmds=${num(proto, 'cmds')} ` +
      `tooLong=${num(proto, 'tooLong')} unknown=${num(proto, 'unknown')} ` +
      `transport=${proto.transport || '?'} lastCmd=${proto.lastCmd || '(kosong)'} ` +
      `heap=${proto.heap || '?'}`
    : 'tidak ada jawaban DIAG dari firmware'));
  lines.push('L4 DEVICE ' + (media
    ? `notifyOk=${num(media, 'notifyOk')} notifyFail=${num(media, 'notifyFail')} ` +
      `retry=${num(media, 'notifyRetries')} ` +
      `ring=${num(media, 'ringHigh')}/${num(media, 'ringSize')} ` +
      `ringDropped=${num(media, 'ringDropped')} ` +
      `noConn=${num(media, 'noConn')} noSub=${num(media, 'noSub')}`
    : 'tidak ada jawaban DIAGMEDIA (NUS tidak dikompilasi atau perintah tidak dikenal)'));

  // Rasio delivery - satu-satunya angka lintas-lapis yang SAH untuk dibandingkan.
  //
  // PERINGATAN yang harus ditulis di sini, karena sudah menyesatkan sekali:
  // `notifyOk` (L4) menghitung CHUNK yang diterima stack BLE device, sedangkan
  // `notify_events` (L1) menghitung notifikasi yang benar-benar sampai di host.
  // KeduanyaJUMLAH kumulatif sejak boot, TAPI keduanya menghitung hal yang
  // BERBEDA: satu chunk adalah "percobaan kirim", satu event adalah "yang
  // sampai". Mengbagi keduanya dan menyimpulkan "92% hilang" adalah kesalahpahaman
  // yang sudah terjadi sekali di sesi ini.
  //
  // Yang Benar-benar bisa dipercaya: `rx_dropped_bytes` (L1) - byte yang host
  // sudah terima tapi dibuang karena buffer penuh. Kalau nol, link TIDAK dropping
  // di host, dan notifyFail yang tinggi berarti device yang gagal mengirim, bukan
  // data yang hilang di jalan.
  if (link && media) {
    const dropped = num(link, 'rx_dropped_bytes');
    lines.push('L5 LOSS   ' +
      `rxDropped=${dropped}B ` +
      `rxFull=${dropped > 0 ? 'YA - host membuang byte, link terlalu cepat dibaca' : 'tidak - tidak ada byte host yang hilang'}`);
  }
  lines.push('VERDICT: ' + diagVerdict(proto, media, link));
  return lines.join('\n');
}

/** Apakah laporan ini berisi indikator kegagalan (dipakai untuk warna log). */
export function diagHasFailure(proto, media, link) {
  // Ring buffer hampir penuh TANPA drop tetap kegagalan: itu tanda antrean
  // menumpuk di dalam device, hanya saja belum sampai membuang byte.
  const ringPenuh = num(media, 'ringSize') > 0
    && num(media, 'ringHigh') >= num(media, 'ringSize') * 0.9;
  // Nol perintah yang sampai ke device = kegagalan, walau tidak ada counter
  // lain yang naik. Tanpa ini, kondi paling membingungkan ("connect tapi
  // diam") akan tampil sebagai laporan bersih.
  const nolSampai = !!proto && num(proto, 'cmds') === 0;
  return num(link, 'rx_dropped_bytes') > 0
    || num(link, 'write_errors') > 0
    || num(media, 'notifyFail') > 0
    || num(media, 'ringDropped') > 0
    || num(media, 'noSub') > 0
    || num(proto, 'tooLong') > 0
    || num(proto, 'unknown') > 0
    || ringPenuh
    || nolSampai;
}

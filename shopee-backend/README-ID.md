# RIVODA EXHAUST — Shopee Product Sync

Backend ini membaca katalog toko Shopee melalui Shopee Open Platform API v2, menyimpan salinan katalog di backend, lalu menyediakannya untuk website statis GitHub Pages melalui `GET /api/products`. Sinkronisasi otomatis berjalan setiap 10 menit (dapat diubah).

## 1. Yang disinkronkan
- Nama, SKU, kategori (berdasarkan mapping), harga, stok, berat, deskripsi, foto, variasi bila endpoint model dilengkapi, dan URL produk Shopee.
- Data rating dan jumlah terjual sengaja tidak dibuat-buat; API produk dasar tidak selalu menyediakan keduanya.
- Katalog lokal lama tetap dipakai sebagai fallback bila backend belum dikonfigurasi.

## 2. Persiapan Shopee Developer
1. Pastikan aplikasi Open Platform telah disetujui untuk akses produksi (bukan hanya test app).
2. Aktifkan izin Product/Item yang diperlukan.
3. Siapkan Partner ID dan Partner Key dari Console. Jangan kirim Partner Key/token melalui chat atau commit ke GitHub.
4. Tambahkan URL callback persis: `https://DOMAIN-BACKEND/auth/shopee/callback` pada konfigurasi aplikasi Shopee.
5. Pilih Indonesia dan toko RIVODA EXHAUST saat halaman otorisasi Shopee terbuka.

## 3. Deploy backend
Disarankan Render Web Service atau VPS Node.js dengan persistent disk. GitHub Pages tidak dapat menyimpan Partner Key atau menjalankan OAuth rahasia.

- Root Directory: `shopee-backend`
- Build Command: `npm install`
- Start Command: `npm start`
- Persistent Disk Mount Path: `/var/data` (wajib agar token/katalog bertahan saat deploy/restart)

Environment variables:
- `PARTNER_ID` = Partner ID produksi
- `PARTNER_KEY` = Partner Key produksi (rahasia)
- `REDIRECT_URL` = URL callback backend yang sama persis dengan Console Shopee
- `PUBLIC_SITE_ORIGIN` = `https://rivodaexhaust.id,https://www.rivodaexhaust.id` (gunakan hanya origin domain yang benar-benar dipakai; tambahkan origin GitHub Pages bila memang dipakai)
- `SYNC_SECRET` = token acak panjang untuk endpoint admin
- `DATA_DIR` = `/var/data`
- `SYNC_INTERVAL_MINUTES` = `10`

Setelah backend online, buka `https://DOMAIN-BACKEND/auth/shopee` lalu setujui akses toko. Jangan pernah memasukkan password Shopee ke aplikasi ini; login dan persetujuan dilakukan di domain resmi Shopee.

## 4. Hubungkan website
Edit `sync-config.js` pada root website dan ganti `https://GANTI-DENGAN-DOMAIN-BACKEND` dengan URL backend, tanpa slash di akhir. Upload ulang folder website ke GitHub Pages.

## 5. Pengujian
- `GET /health` menunjukkan status backend.
- `GET /api/products` harus mengembalikan `products` dan `lastSync`.
- `POST /admin/sync` dengan header `x-sync-secret: SYNC_SECRET` menjalankan sinkronisasi manual.
- `GET /admin/status` dengan header yang sama menampilkan status koneksi.

## Penting / batasan versi ini
- API Shopee hanya dapat dipakai setelah aplikasi dan izin produksi disetujui serta toko memberikan otorisasi.
- Nama field dan izin API dapat berbeda sesuai versi/region/aplikasi; uji dengan test shop dahulu dan cocokkan respons aktual Indonesia sebelum produksi.
- Kategori otomatis menggunakan SKU/kategori ID mapping dan kata kunci. Mapping SKU awal RIVODA sudah disiapkan di backend. Atur `data/category-map.json` untuk klasifikasi tambahan/akurasi penuh. Jangan menganggap kategori Shopee sama dengan kategori website tanpa mapping.
- Produk bervariasi mengambil model melalui `get_model_list`; stok total ditampilkan sebagai jumlah stok model yang tersedia. Stok tiap model juga disertakan pada properti `models`. Uji variasi pada toko produksi sebelum dijadikan dasar keputusan stok.
- Sinkronisasi bersifat satu arah Shopee → website. Website tidak mengubah data Shopee.

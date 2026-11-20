# PRODUCT REQUIREMENTS DOCUMENT (PRD)
**Nama Proyek:** Personal 3D Activity Tracker & Route Builder (Strava-like Hybrid Android App)
**Target Perangkat:** Android (Optimasi khusus untuk Tecno Camon 40 Pro 5G / HiOS)
**Target Pengguna:** Single-User / Personal Use[cite: 1]
**Alur Pengembangan:** 100% Cloud (GitHub + Jules + Supabase + GitHub Actions Auto-APK)[cite: 1]

## 1. Ringkasan Eksekutif & Tujuan Produk
Membangun aplikasi pelacak aktivitas olahraga pribadi (running, cycling, hiking) untuk Android yang mampu merekam jejak GPS di latar belakang secara stabil meskipun layar HP dikunci atau pengguna membuka aplikasi kamera, merencanakan rute dengan profil elevasi, serta memutar ulang jejak aktivitas dalam visualisasi peta 3D sinematik (3D Flyover ala Strava Pro)[cite: 1].

## 2. Arsitektur Sistem & Tech Stack
* **Frontend Framework:** Next.js 14 (App Router dengan konfigurasi wajib `output: 'export'` untuk static bundle), TypeScript, Tailwind CSS, dan Lucide React Icons[cite: 1].
* **Mobile Wrapper & Background GPS:** Capacitor (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`) dan plugin `@capgo/capacitor-background-geolocation` untuk menjalankan Android Foreground Service.
* **Map & 3D Engine:** `maplibre-gl` dengan MapTiler API (Terrain RGB v2 DEM & Hybrid Satellite/Outdoor tiles)[cite: 1].
* **Spatial & Math Utility:** `@turf/turf` untuk kalkulasi jarak, interpolasi koordinat, dan penghalusan sudut rotasi kamera (bearing)[cite: 1].
* **Routing Engine:** OpenRouteService (ORS) Directions API untuk kalkulasi rute menempel jalur (snap-to-road) dan profil elevasi[cite: 1].
* **Database & Backend:** Supabase (PostgreSQL dengan ekstensi spasial PostGIS)[cite: 1].
* **CI/CD & Build APK:** GitHub Actions untuk merakit file `.apk` Android secara otomatis di cloud setiap kali ada perubahan kode.

## 3. Kebutuhan Fungsional (Functional Requirements)

### 3.1. Modul 1: Peta 3D Interaktif & Navigasi Utama
* **FR-1.1 (3D Terrain Rendering):** Menampilkan peta layar penuh menggunakan MapLibre GL JS dengan lapisan elevasi 3D (`raster-dem`, exaggeration `1.5`) dan kemiringan kamera awal (`pitch: 60`)[cite: 1].
* **FR-1.2 (Layer & View Toggle):** Kontrol cepat untuk beralih antara tampilan 2D dan 3D serta mengganti gaya peta dasar (Outdoor Terrain / Satellite Hybrid)[cite: 1].
* **FR-1.3 (Bottom Navigation):** Bilah navigasi bawah dengan 3 tab utama: **Routes**, **Record**, dan **Activities**[cite: 3].

### 3.2. Modul 2: Route Builder (Perencana Rute)
* **FR-2.1 (Waypoint Placement):** Pengguna dapat mengetuk beberapa titik (waypoints) di peta untuk menyusun jalur rencana[cite: 2].
* **FR-2.2 (Multi-Profile Routing):** Mengirim waypoints ke OpenRouteService API dengan pilihan profil aktivitas: `cycling-regular`, `foot-running`, dan `foot-hiking` dengan parameter `elevation: true`[cite: 2].
* **FR-2.3 (Elevation & Distance Metrics):** Merender garis rute yang menempel di jalan atau jalur setapak (snap-to-road) di atas kontur 3D beserta kartu ringkasan Total Jarak (km) dan Total Elevation Gain (m)[cite: 2].
* **FR-2.4 (Cloud Save, GPX Export & Import):** Menyimpan rute ke tabel `activities` di Supabase (`is_planned_route = true`), menyediakan fitur unduh file `.gpx`, serta tombol unggah/impor file `.gpx` eksternal untuk ditampilkan di peta 3D[cite: 2].

### 3.3. Modul 3: Background Live GPS Activity Tracker
* **FR-3.1 (Foreground Service & GPS Quality Filter):** Menggunakan `@capgo/capacitor-background-geolocation` (dengan fallback `navigator.geolocation` saat diuji di browser) agar perekaman tetap aktif saat layar terkunci atau aplikasi kamera dibuka. Terapkan filter ketat sebelum menyimpan titik koordinat:
  * **Accuracy Filter:** Abaikan koordinat jika `accuracy > 20` meter.
  * **Distance Jitter Filter:** Abaikan koordinat jika perpindahan jarak dari titik sebelumnya `< 3` meter (mencegah jarak fiktif saat berhenti).
* **FR-3.2 (Offline Resilient Backup):** Menyimpan titik koordinat sementara ke `IndexedDB` / `localStorage` sebagai cadangan otomatis saat sinyal seluler terputus di tengah rute[cite: 2].
* **FR-3.3 (Live Telemetry HUD):** Menampilkan durasi waktu berjalan, jarak tempuh (kalkulasi `@turf/turf`), kecepatan atau pace saat ini, serta menggambar garis jejak langsung di peta[cite: 2].
* **FR-3.4 (Session Controls):** Menyediakan tombol **Start**, **Pause**, **Resume**, dan **Finish**. Menekan Finish akan menghentikan Foreground Service dan mengunggah seluruh rekaman ke Supabase (`is_planned_route = false`)[cite: 2].

### 3.4. Modul 4: Activity Detail & Strava-Style 3D Flyover
* **FR-4.1 (Activity Feed):** Halaman riwayat aktivitas untuk menelusuri daftar rekaman selesai dan rute rencana tersimpan[cite: 2].
* **FR-4.2 (3D Flyover Playback):** Tombol "Play 3D Flyover" yang menjalankan animasi marker 3D dari titik awal hingga finis menggunakan `requestAnimationFrame`[cite: 2].
* **FR-4.3 (Cinematic Camera Tracking):** Kamera peta otomatis mengikuti pergerakan marker dengan `pitch: 70`, `zoom: 15.5`, dan rotasi sudut arah (bearing) yang dihaluskan menggunakan look-ahead point dari `@turf/turf`[cite: 2].
* **FR-4.4 (Progressive Route Reveal):** Menggambar garis rute secara bertahap (0% hingga 100%) seiring pergerakan marker[cite: 2].
* **FR-4.5 (Playback HUD & Controls):** Kartu telemetri mengambang (jarak berjalan, elevasi, dan pace/kecepatan), tombol Play/Pause, timeline scrubber, dan pengatur kecepatan putar (`1x`, `2x`, `5x`)[cite: 2].

## 4. Variabel Lingkungan (Environment Variables)
* `NEXT_PUBLIC_SUPABASE_URL`
* `NEXT_PUBLIC_SUPABASE_ANON_KEY`
* `NEXT_PUBLIC_MAPTILER_KEY`
* `NEXT_PUBLIC_ORS_API_KEY`

## 5. Roadmap Eksekusi Bertahap (Jules Milestones)
1. **Milestone 1 (Fondasi & Peta 3D):** Integrasi MapLibre GL JS + MapTiler 3D Terrain, bilah navigasi bawah 3 tab (`Routes`, `Record`, `Activities`), dan konfigurasi izin lokasi Android pada `AndroidManifest.xml`[cite: 3].
2. **Milestone 2 (Route Builder & GPX):** Integrasi OpenRouteService API, kalkulasi jarak/elevasi, simpan rute ke Supabase, serta fitur Export & Import `.gpx`[cite: 3].
3. **Milestone 3 (Background GPS Tracker):** Implementasi `@capgo/capacitor-background-geolocation` dengan filter akurasi/jarak, offline backup `localStorage`, dan simpan rekaman ke Supabase[cite: 3].
4. **Milestone 4 (3D Flyover Playback):** Halaman detail aktivitas dengan animasi kamera 3D `@turf/turf`, progres garis rute, dan kontrol pemutaran flyover[cite: 3].

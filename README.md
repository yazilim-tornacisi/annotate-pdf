# Annotate PDF

Vite + React + TypeScript ile geliştirilmiş, tamamen tarayıcı içinde çalışan PDF çizim uygulaması. Backend yok, veriniz cihazdan çıkmaz.

**Özellikler**
- PDF yükleme: buton + drag & drop
- PDF.js ile sayfa sayfa görüntüleme (tek sayfa render → düşük RAM)
- Canvas overlay ile kalem çizimi, silgi, renk, kalınlık
- **Yumuşatma**: `perfect-freehand` ile basınca duyarlı akıcı çizim
- **Ctrl düzleştirme**: Ctrl basılı tutarken çizgiyi düz çizgiye dönüştür
- Undo / Redo (sayfa bazlı), tümünü temizle
- pdf-lib ile PDF'e gömme ve indirme
- Açık/Koyu tema (sistem algılama + toggle)
- Minimal, tek sayfa arayüz, responsive

**Teknik Seçimler (hafiflik)**
- Fabric.js / Konva kullanılmıyor → ham Canvas + perfect-freehand
- PDF.js worker ayrı chunk, pdf-lib lazy import (kaydet'e kadar yüklenmez)
- Tek sayfa render, büyük PDF'lerde GB şişmesini önler
- Bundle: ~520 KB (gz ~156 KB) + pdf-lib lazy 420 KB (gz 175 KB), worker 2.1 MB ayrı dosya
- Tailwind v4 (@tailwindcss/vite), `canvas` ile `devicePixelRatio` desteği

## Kurulum

### Yerel (npm)

```bash
npm ci
npm run dev     # http://localhost:3003
npm run build   # dist/
npm run preview # build'i önizle
```

### Docker

```bash
./run.sh
# veya
docker compose up --build -d
# http://localhost:3003
```

`run.sh` eski `annotate-pdf` container'ını temizleyip `docker compose up --build -d` çalıştırır.

### Docker Manuel

```bash
docker build -t annotate-pdf .
docker run -d --name annotate-pdf -p 3003:80 annotate-pdf
```

Image multi-stage build kullanır: `node:22-alpine` ile derlenir, `nginx:alpine` ile servis edilir (≈ 50 MB civarı final image, nginx gzip açık).

## Kullanım

1. PDF seç veya sürükle-bırak.
2. Kalem/Silgi, renk, kalınlık seç.
3. Çizim yap; **Ctrl** basılı tutarsan düz çizgi olur.
4. Sayfa değiştir (önceki/sonraki), zoom +/−.
5. Geri al / İleri al, Temizle.
6. **İndir** ile işaretli PDF'i indir (`*_isaretli.pdf`).

Stroklar sayfa bazlı saklanır, sayfa değiştirince kaybolmaz.

## Klasör Yapısı

```
src/
  App.tsx        # tüm uygulama (tek-dosya, hafif)
  index.css      # tema değişkenleri + tailwind
  main.tsx
vite.config.ts
nginx.conf
Dockerfile
docker-compose.yml
run.sh
```

## Port

Uygulama **3003** portunda çalışır (Vite dev ve nginx → 3003:80 mapping).

## Notlar

- Büyük PDF'lerde (100+ sayfa) sadece aktif sayfa render edilir → RAM düşük kalır.
- Kaydetme: çizimler normalize (0-1) koordinatla saklanır, pdf-lib'de `drawSvgPath` / `drawLine` ile orijinal PDF boyutuna ölçeklenir.
- Silgi: yakındaki strokları hit-test ile siler (beyaz kaplama değil).

## Lisans

MIT

# Mega Media Grid (React Router v7 + api/)

Proyecto full-stack en un solo runtime de React Router v7.

## Incluye

- API en `app/routes/api.*` (sin servidor separado)
- Auth JWT por cookie `httpOnly` + roles `ADMIN` / `VIEWER`
- MongoDB para usuarios y media
- Cloudflare R2 (S3 compatible) para objetos
- Pipeline de media (LOD + metadata EXIF/ffprobe)
- UI: `/login`, `/`, `/admin/users`, `/admin/upload`, `/admin/media`
- Canvas grid con PixiJS, pan/zoom, culling y LOD por zoom
- Video overlay único (`<video>`) alineado al tile

## Requisitos

- Node 20+
- MongoDB accesible
- Bucket R2 y credenciales
- `ffmpeg` disponible para poster/preview de video

## Variables de entorno

Usa `.env.example` como base:

```bash
cp .env.example .env
```

Variables clave:

- `MONGODB_URI`
- `JWT_SECRET`
- `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- `FFMPEG_PATH` (opcional, si ffmpeg no está en PATH)
- `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (opcional para primer admin)
- `VIDEO_PREVIEW_SECONDS` (opcional, default 10; usa `full` para preview completo)
- `VITE_BRANDING_DIR` (opcional, branding custom desde `public/branding/<dir>`)
- `VITE_BACKGROUND_IMAGE` (opcional, imagen de fondo repetida en `/`)

## Crear primer admin

Opción recomendada:

1. Define `BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD`.
2. Inicia la app.
3. Si no existe ningún ADMIN, se crea automáticamente uno.

Luego elimina esas variables del `.env`.

## Ejecutar local

```bash
pnpm install
pnpm run dev
```

## Flujo de subida y LOD

1. En `/admin/upload` subes archivo y defines `visibility`.
2. API guarda `original` en R2 y crea documento `media` con `status=processing`.
3. Se encola job en memoria del runtime:
   - Imagen: EXIF + LOD `lod0..lod4` webp.
   - Video: poster jpg + LOD desde poster + preview mp4 (si ffmpeg lo permite).
4. Documento pasa a `ready` o `error`.

Keys R2 usadas:

- `media/{id}/original.ext`
- `media/{id}/lod0.webp ... lod4.webp`
- `media/{id}/poster.jpg`
- `media/{id}/preview.mp4`

## Limitaciones actuales del runtime

- La cola es **en memoria del proceso**. Si reinicia el servidor, jobs pendientes se pierden.
- No hay worker persistente externo (intencional, para respetar single-runtime).
- Procesamiento de video depende de `ffmpeg` y puede degradar a poster-only.

## Endpoints principales

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET/POST /api/admin/users`
- `PATCH /api/admin/users/:id`
- `POST /api/admin/media/upload` (multipart)
- `PATCH /api/admin/media/:id`
- `GET /api/media/pages`
- `POST /api/media/urls`
- `GET /api/media/:id/play`

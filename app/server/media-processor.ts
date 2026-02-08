import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import exifr from "exifr";
import ffmpeg from "fluent-ffmpeg";
import { ObjectId, getCollections } from "./db";
import { uploadBufferToR2 } from "./r2";

const IMAGE_LODS = [64, 128, 256, 512, 1024] as const;
const PREVIEW_SECONDS = clampNumber(Number(process.env.VIDEO_PREVIEW_SECONDS ?? 10), 2, 60);

type EnqueueInput = {
  mediaId: string;
  localPath: string;
  type: "image" | "video";
  mime: string;
  extension: string;
  manualDateTaken?: Date | null;
  placeName?: string;
};

type Job = EnqueueInput;

const queue: Job[] = [];
let active = false;

if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

export function enqueueMediaProcessing(job: Job) {
  queue.push(job);
  void processQueue();
}

async function processQueue() {
  if (active) return;
  active = true;
  while (queue.length) {
    const next = queue.shift()!;
    try {
      if (next.type === "image") {
        await processImage(next);
      } else {
        await processVideo(next);
      }
    } catch (error) {
      await failMedia(next.mediaId, error instanceof Error ? error.message : "Processing failed");
    } finally {
      await fs.unlink(next.localPath).catch(() => undefined);
    }
  }
  active = false;
}

async function processImage(input: EnqueueInput) {
  const { media } = await getCollections();
  const existing = await media.findOne(
    { _id: new ObjectId(input.mediaId) },
    { projection: { createdAt: 1 } },
  );
  const createdAt = existing?.createdAt ?? new Date();
  let parsed: any = null;
  try {
    parsed = await exifr.parse(input.localPath, {
      tiff: true,
      exif: true,
      gps: true,
    });
  } catch {
    parsed = null;
  }

  const original = await fs.readFile(input.localPath);
  const { buffer: decodedBuffer } = await decodeImageBuffer(original, input.extension, input.mime);
  const baseMetadata = await sharp(decodedBuffer).metadata();
  const orientation = normalizeOrientation(parsed?.Orientation ?? baseMetadata.orientation);
  const oriented = getOrientedDimensions(baseMetadata, orientation);
  const variants: Record<string, { r2Key: string; w: number; h: number; bytes: number; mime: string }> = {};

  for (let i = 0; i < IMAGE_LODS.length; i += 1) {
    const size = IMAGE_LODS[i];
    const rendered = await sharp(decodedBuffer)
      .rotate()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    const key = `media/${input.mediaId}/lod${i}.webp`;
    await uploadBufferToR2({
      key,
      body: rendered.data,
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    });
    variants[`lod${i}`] = {
      r2Key: key,
      w: rendered.info.width,
      h: rendered.info.height,
      bytes: rendered.info.size,
      mime: "image/webp",
    };
  }

  const dateTaken =
    input.manualDateTaken ??
    normalizeDate(parsed?.DateTimeOriginal ?? parsed?.CreateDate ?? parsed?.ModifyDate ?? null);
  const lat = normalizeNumber(parsed?.latitude ?? parsed?.lat);
  const lng = normalizeNumber(parsed?.longitude ?? parsed?.lon);

  const { width, height } = resolveDimensionsFromVariants(variants, null, oriented);

  await media.updateOne(
    { _id: new ObjectId(input.mediaId) },
    {
      $set: {
        variants,
        dateTaken,
        dateEffective: dateTaken ?? createdAt,
        location:
          lat !== null && lng !== null
            ? { lat, lng, source: "exif", placeName: input.placeName || undefined }
            : input.placeName
              ? { lat: 0, lng: 0, source: "manual", placeName: input.placeName }
              : null,
        status: "ready",
        poster: null,
        preview: null,
        type: "image",
        width,
        height,
        aspect: width && height ? width / height : 1,
      },
      $unset: {
        errorMessage: "",
      },
    },
  );
}

async function processVideo(input: EnqueueInput) {
  const { media } = await getCollections();
  const existing = await media.findOne(
    { _id: new ObjectId(input.mediaId) },
    { projection: { createdAt: 1 } },
  );
  const createdAt = existing?.createdAt ?? new Date();

  const probe = await ffprobeSafe(input.localPath);
  const creationTime = probe.tags?.creation_time ? new Date(probe.tags.creation_time) : null;

  const posterPath = path.join(os.tmpdir(), `${input.mediaId}-poster.jpg`);
  await generatePoster(input.localPath, posterPath);
  const posterBuffer = await fs.readFile(posterPath);

  const posterMeta = await sharp(posterBuffer).metadata();
  const posterKey = `media/${input.mediaId}/poster.jpg`;
  await uploadBufferToR2({
    key: posterKey,
    body: posterBuffer,
    contentType: "image/jpeg",
    cacheControl: "public, max-age=31536000, immutable",
  });

  const variants: Record<string, { r2Key: string; w: number; h: number; bytes: number; mime: string }> = {};
  for (let i = 0; i < IMAGE_LODS.length; i += 1) {
    const rendered = await sharp(posterBuffer)
      .resize({ width: IMAGE_LODS[i], height: IMAGE_LODS[i], fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    const key = `media/${input.mediaId}/lod${i}.webp`;
    await uploadBufferToR2({
      key,
      body: rendered.data,
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    });
    variants[`lod${i}`] = {
      r2Key: key,
      w: rendered.info.width,
      h: rendered.info.height,
      bytes: rendered.info.size,
      mime: "image/webp",
    };
  }

  let preview: { r2Key: string; mime: string; duration?: number } | null = null;
  const previewPath = path.join(os.tmpdir(), `${input.mediaId}-preview.mp4`);
  const previewOk = await generatePreview(input.localPath, previewPath, PREVIEW_SECONDS);
  if (previewOk) {
    const previewBuffer = await fs.readFile(previewPath);
    const previewKey = `media/${input.mediaId}/preview.mp4`;
    await uploadBufferToR2({
      key: previewKey,
      body: previewBuffer,
      contentType: "video/mp4",
      cacheControl: "public, max-age=31536000, immutable",
    });
    preview = {
      r2Key: previewKey,
      mime: "video/mp4",
      duration: Math.min(probe.duration ?? 0, PREVIEW_SECONDS) || undefined,
    };
    await fs.unlink(previewPath).catch(() => undefined);
  }

  const dateTaken = input.manualDateTaken ?? normalizeDate(creationTime);

  const { width, height } = resolveDimensionsFromVariants(variants, posterMeta, probe);

  await media.updateOne(
    { _id: new ObjectId(input.mediaId) },
    {
      $set: {
        variants,
        poster: {
          r2Key: posterKey,
          w: posterMeta.width ?? 1,
          h: posterMeta.height ?? 1,
          mime: "image/jpeg",
        },
        preview,
        dateTaken,
        dateEffective: dateTaken ?? createdAt,
        location: input.placeName ? { lat: 0, lng: 0, source: "manual", placeName: input.placeName } : null,
        status: "ready",
        type: "video",
        width,
        height,
        aspect: width && height ? width / height : posterMeta.width && posterMeta.height ? posterMeta.width / posterMeta.height : 16 / 9,
      },
      $unset: {
        errorMessage: "",
      },
    },
  );

  await fs.unlink(posterPath).catch(() => undefined);
}

async function failMedia(mediaId: string, message: string) {
  const { media } = await getCollections();
  await media.updateOne(
    { _id: new ObjectId(mediaId) },
    {
      $set: {
        status: "error",
        errorMessage: message,
      },
    },
  );
}

function ffprobeSafe(filePath: string) {
  return new Promise<{ duration?: number; tags?: Record<string, string>; width?: number; height?: number }>((resolve) => {
    ffmpeg.ffprobe(filePath, (error: Error | undefined, metadata: ffmpeg.FfprobeData) => {
      if (error) {
        resolve({});
        return;
      }
      const videoStream = metadata.streams?.find((stream) => stream.codec_type === "video");
      resolve({
        duration: metadata.format?.duration,
        tags: metadata.format?.tags as Record<string, string> | undefined,
        width: videoStream?.width,
        height: videoStream?.height,
      });
    });
  });
}

function generatePoster(videoPath: string, outputPath: string) {
  return new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .frames(1)
      .outputOptions(["-q:v 2"])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

function generatePreview(videoPath: string, outputPath: string, seconds: number) {
  return new Promise<boolean>((resolve) => {
    ffmpeg(videoPath)
      .outputOptions([`-t ${seconds}`, "-movflags +faststart"])
      .videoCodec("libx264")
      .audioCodec("aac")
      .size("640x?")
      .output(outputPath)
      .on("end", () => resolve(true))
      .on("error", () => resolve(false))
      .run();
  });
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizeDate(value: unknown) {
  if (!value) return null;
  const parsed = new Date(value as string | number | Date);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeNumber(value: unknown) {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function normalizeDimension(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.round(value);
}

function resolveDimensionsFromVariants(
  variants: Record<string, { w: number; h: number }> | undefined,
  poster: { width?: number; height?: number } | null,
  fallback: { width?: number | null; height?: number | null } | null,
) {
  const order = ["lod2", "lod3", "lod4", "lod1", "lod0"];
  for (const key of order) {
    const variant = variants?.[key];
    const width = normalizeDimension(variant?.w);
    const height = normalizeDimension(variant?.h);
    if (width && height) return { width, height };
  }
  const posterWidth = normalizeDimension(poster?.width ?? null);
  const posterHeight = normalizeDimension(poster?.height ?? null);
  if (posterWidth && posterHeight) return { width: posterWidth, height: posterHeight };
  const fallbackWidth = normalizeDimension(fallback?.width ?? null);
  const fallbackHeight = normalizeDimension(fallback?.height ?? null);
  return { width: fallbackWidth, height: fallbackHeight };
}

function normalizeOrientation(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getOrientedDimensions(
  metadata: { width?: number; height?: number },
  orientation?: number,
) {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) return { width, height };
  if (orientation && [5, 6, 7, 8].includes(orientation)) {
    return { width: height, height: width };
  }
  return { width, height };
}

async function decodeImageBuffer(buffer: Buffer, extension: string, mime: string) {
  const ext = extension.toLowerCase();
  const isHeic =
    mime === "image/heic" ||
    mime === "image/heif" ||
    ext === "heic" ||
    ext === "heif";

  if (!isHeic) return { buffer, mime };

  const heicConvert = (await import("heic-convert")).default;
  const output = await heicConvert({
    buffer,
    format: "JPEG",
    quality: 0.9,
  });

  return { buffer: Buffer.from(output), mime: "image/jpeg" };
}

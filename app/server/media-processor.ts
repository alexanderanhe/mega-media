import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import exifr from "exifr";
import ffmpeg from "fluent-ffmpeg";
import { ObjectId, getCollections } from "./db";
import { uploadBufferToR2 } from "./r2";

const IMAGE_LODS = [64, 128, 256, 512, 1024] as const;

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
  const { buffer: decodedBuffer, mime: decodedMime } = await decodeImageBuffer(original, input.extension, input.mime);
  const originalMetadata = await sharp(decodedBuffer).rotate().metadata();
  const variants: Record<string, { r2Key: string; w: number; h: number; bytes: number; mime: string }> = {};

  for (let i = 0; i < IMAGE_LODS.length; i += 1) {
    const size = IMAGE_LODS[i];
    const rendered = await sharp(decodedBuffer)
      .rotate()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    const key = `media/${input.mediaId}/lod${i}.webp`;
    await uploadBufferToR2({ key, body: rendered.data, contentType: "image/webp" });
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

  await media.updateOne(
    { _id: new ObjectId(input.mediaId) },
    {
      $set: {
        variants,
        dateTaken,
        dateEffective: dateTaken ?? new Date(),
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
        aspect: originalMetadata.width && originalMetadata.height ? originalMetadata.width / originalMetadata.height : 1,
      },
      $unset: {
        errorMessage: "",
      },
    },
  );
}

async function processVideo(input: EnqueueInput) {
  const { media } = await getCollections();

  const probe = await ffprobeSafe(input.localPath);
  const creationTime = probe.tags?.creation_time ? new Date(probe.tags.creation_time) : null;

  const posterPath = path.join(os.tmpdir(), `${input.mediaId}-poster.jpg`);
  await generatePoster(input.localPath, posterPath);
  const posterBuffer = await fs.readFile(posterPath);

  const posterMeta = await sharp(posterBuffer).metadata();
  const posterKey = `media/${input.mediaId}/poster.jpg`;
  await uploadBufferToR2({ key: posterKey, body: posterBuffer, contentType: "image/jpeg" });

  const variants: Record<string, { r2Key: string; w: number; h: number; bytes: number; mime: string }> = {};
  for (let i = 0; i < IMAGE_LODS.length; i += 1) {
    const rendered = await sharp(posterBuffer)
      .resize({ width: IMAGE_LODS[i], height: IMAGE_LODS[i], fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    const key = `media/${input.mediaId}/lod${i}.webp`;
    await uploadBufferToR2({ key, body: rendered.data, contentType: "image/webp" });
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
  const previewOk = await generatePreview(input.localPath, previewPath);
  if (previewOk) {
    const previewBuffer = await fs.readFile(previewPath);
    const previewKey = `media/${input.mediaId}/preview.mp4`;
    await uploadBufferToR2({ key: previewKey, body: previewBuffer, contentType: "video/mp4" });
    preview = { r2Key: previewKey, mime: "video/mp4", duration: Math.min(probe.duration ?? 0, 6) || undefined };
    await fs.unlink(previewPath).catch(() => undefined);
  }

  const dateTaken = input.manualDateTaken ?? normalizeDate(creationTime);

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
        dateEffective: dateTaken ?? new Date(),
        location: input.placeName ? { lat: 0, lng: 0, source: "manual", placeName: input.placeName } : null,
        status: "ready",
        type: "video",
        aspect: posterMeta.width && posterMeta.height ? posterMeta.width / posterMeta.height : 16 / 9,
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
  return new Promise<{ duration?: number; tags?: Record<string, string> }>((resolve) => {
    ffmpeg.ffprobe(filePath, (error: Error | undefined, metadata: ffmpeg.FfprobeData) => {
      if (error) {
        resolve({});
        return;
      }
      resolve({
        duration: metadata.format?.duration,
        tags: metadata.format?.tags as Record<string, string> | undefined,
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

function generatePreview(videoPath: string, outputPath: string) {
  return new Promise<boolean>((resolve) => {
    ffmpeg(videoPath)
      .outputOptions(["-t 6", "-movflags +faststart"])
      .videoCodec("libx264")
      .audioCodec("aac")
      .size("640x?")
      .output(outputPath)
      .on("end", () => resolve(true))
      .on("error", () => resolve(false))
      .run();
  });
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

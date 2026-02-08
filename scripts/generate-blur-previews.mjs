import { MongoClient, ObjectId } from "mongodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { buffer as streamToBuffer } from "node:stream/consumers";

const BLUR_MAX_SIZE = clampNumber(Number(process.env.BLUR_MAX_SIZE ?? 360), 120, 1024);
const BLUR_SIGMA = clampNumber(Number(process.env.BLUR_SIGMA ?? 16), 4, 40);

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function getDbName(uri) {
  const parsed = new URL(uri);
  return parsed.pathname.replace(/^\//, "") || "mega_media_grid";
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Add it to .env`);
  return value;
}

function resolveSourceKey(doc) {
  if (doc.type === "video") {
    return (
      doc.poster?.r2Key ||
      doc.variants?.lod2?.r2Key ||
      doc.variants?.lod1?.r2Key ||
      doc.r2KeyOriginal
    );
  }
  return (
    doc.variants?.lod2?.r2Key ||
    doc.variants?.lod1?.r2Key ||
    doc.variants?.lod0?.r2Key ||
    doc.r2KeyOriginal
  );
}

async function createBlurBuffer(inputBuffer) {
  const rendered = await sharp(inputBuffer)
    .rotate()
    .resize({ width: BLUR_MAX_SIZE, height: BLUR_MAX_SIZE, fit: "inside", withoutEnlargement: true })
    .blur(BLUR_SIGMA)
    .modulate({ saturation: 0.85 })
    .webp({ quality: 55 })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: rendered.data,
    width: rendered.info.width ?? 1,
    height: rendered.info.height ?? 1,
    mime: "image/webp",
  };
}

async function main() {
  const mongoUri = requireEnv("MONGODB_URI");
  const r2Endpoint = requireEnv("R2_ENDPOINT");
  const r2AccessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const r2SecretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const r2Bucket = requireEnv("R2_BUCKET");

  const limit = Number(getArg("limit") ?? "0");
  const onlyMissing = hasFlag("missing");
  const debug = hasFlag("debug");
  const dryRun = hasFlag("dry-run");
  const visibility = (getArg("visibility") || "all").toLowerCase();

  const client = new MongoClient(mongoUri);
  const s3 = new S3Client({
    region: process.env.R2_REGION ?? "auto",
    endpoint: r2Endpoint,
    credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey },
  });

  await client.connect();
  const db = client.db(getDbName(mongoUri));
  const media = db.collection("media");

  const filter = { status: "ready" };
  if (visibility === "public") filter.visibility = "PUBLIC";
  if (visibility === "private") filter.visibility = "PRIVATE";
  if (onlyMissing) filter.$or = [{ blur: { $exists: false } }, { blur: null }];

  if (debug) {
    const dbName = getDbName(mongoUri);
    const total = await media.countDocuments({});
    const ready = await media.countDocuments({ status: "ready" });
    const missing = await media.countDocuments({
      status: "ready",
      $or: [{ blur: { $exists: false } }, { blur: null }],
    });
    console.log("Debug:");
    console.log(`DB: ${dbName}`);
    console.log(`Total docs: ${total}`);
    console.log(`Ready docs: ${ready}`);
    console.log(`Ready missing blur: ${missing}`);
    console.log(`Filter: ${JSON.stringify(filter)}`);
  }

  const cursor = media.find(filter).sort({ dateEffective: -1 });
  if (limit > 0) cursor.limit(limit);

  let processed = 0;
  let updated = 0;
  for await (const doc of cursor) {
    processed += 1;
    const sourceKey = resolveSourceKey(doc);
    if (!sourceKey) continue;
    const blurKey = `media/${doc._id.toString()}/blur.webp`;

    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: r2Bucket, Key: sourceKey }));
      const sourceBuffer = await streamToBuffer(object.Body);
      const blur = await createBlurBuffer(sourceBuffer);
      if (!dryRun) {
        await s3.send(
          new PutObjectCommand({
            Bucket: r2Bucket,
            Key: blurKey,
            Body: blur.buffer,
            ContentType: blur.mime,
            CacheControl: "public, max-age=31536000, immutable",
          }),
        );
        await media.updateOne(
          { _id: new ObjectId(doc._id) },
          {
            $set: {
              blur: { r2Key: blurKey, w: blur.width, h: blur.height, mime: blur.mime },
            },
          },
        );
        updated += 1;
      }
      if (processed % 25 === 0) {
        console.log(`Processed ${processed} items...`);
      }
    } catch (error) {
      console.error(`Failed ${doc._id.toString()}:`, error?.message || error);
    }
  }

  console.log(
    `Done. processed=${processed} updated=${updated}${dryRun ? " (dry-run)" : ""}`,
  );

  await client.close();
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});

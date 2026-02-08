import { PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getEnv } from "./env";

let client: S3Client | null = null;

function getClient() {
  if (client) return client;
  const env = getEnv();
  client = new S3Client({
    region: env.R2_REGION,
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return client;
}

function bucket() {
  const env = getEnv();
  return env.R2_BUCKET!;
}

export async function uploadBufferToR2(input: {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
}) {
  const command = new PutObjectCommand({
    Bucket: bucket(),
    Key: input.key,
    Body: input.body,
    ContentType: input.contentType,
    CacheControl: input.cacheControl,
  });
  await getClient().send(command);
}

export async function createSignedGetUrl(key: string, expiresIn = 60) {
  const command = new GetObjectCommand({ Bucket: bucket(), Key: key });
  return getSignedUrl(getClient(), command, { expiresIn });
}

export async function deleteObjects(keys: string[]) {
  if (keys.length === 0) return;
  const command = new DeleteObjectsCommand({
    Bucket: bucket(),
    Delete: { Objects: keys.map((key) => ({ Key: key })) },
  });
  await getClient().send(command);
}

export function toPublicUrl(key: string) {
  const env = getEnv();
  if (env.R2_REQUIRE_SIGNED_URLS?.toLowerCase() === "true") return null;
  if (!env.R2_PUBLIC_BASE_URL) return null;
  return `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
}

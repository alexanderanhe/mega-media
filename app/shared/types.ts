export type UserRole = "ADMIN" | "VIEWER";

export type MediaType = "image" | "video";

export type Visibility = "PUBLIC" | "PRIVATE";

export type MediaStatus = "processing" | "ready" | "error";

export type LodLevel = 0 | 1 | 2 | 3 | 4;

export interface LocationMeta {
  lat: number;
  lng: number;
  source: "exif" | "manual" | "none";
  placeName?: string;
}

export interface MediaVariant {
  r2Key: string;
  w: number;
  h: number;
  bytes: number;
  mime: string;
}

export interface MediaDoc {
  _id: string;
  type: MediaType;
  visibility: Visibility;
  title: string;
  description: string;
  fileHash: string;
  tags: string[];
  category: string | null;
  createdAt: Date;
  dateTaken: Date | null;
  dateEffective: Date;
  location: LocationMeta | null;
  r2KeyOriginal: string;
  variants: Partial<Record<`lod${LodLevel}`, MediaVariant>>;
  poster: Omit<MediaVariant, "bytes"> | null;
  preview: { r2Key: string; mime: string; duration?: number } | null;
  status: MediaStatus;
  errorMessage?: string;
}

export type GridMediaItem = {
  id: string;
  type: "image" | "video";
  aspect: number;
  status: "processing" | "ready" | "error";
  hidden?: boolean;
  visibility?: "PUBLIC" | "PRIVATE";
  title?: string;
  description?: string;
  dateTaken?: string | null;
  dateEffective?: string;
  liked?: boolean;
  likesCount?: number;
};

export type Tile = {
  item: GridMediaItem;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

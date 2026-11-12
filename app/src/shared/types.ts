export type Track = {
  id?: number;
  title?: string;
  files: string[];
  gate?: string;
  gateUrl?: string;
  at: string;
  seededFrom?: string;
};

export type DownloadsDb = { tracks: Record<string, Track> };

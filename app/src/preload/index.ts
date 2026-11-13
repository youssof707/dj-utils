import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Track } from "../shared/types";
import type { ExportProgress, ExportRequest, ExportResult, PlannerDoc, Cue, ProbeResult, RampRequest, RekordboxGrid, SetFile, SetInfo, SetView, StretchProgress, StretchRequest, StretchResult } from "../shared/planner";

function on<T>(channel: string, cb: (payload: T) => void): () => void {
	const fn = (_e: unknown, payload: T): void => cb(payload);
	ipcRenderer.on(channel, fn);
	return () => ipcRenderer.removeListener(channel, fn);
}

const api = {
	listDownloads: (): Promise<Track[]> => ipcRenderer.invoke("downloads:list"),

	pathForFile: (file: File): string => webUtils.getPathForFile(file),
	probe: (path: string): Promise<ProbeResult> => ipcRenderer.invoke("planner:probe", path),
	rekordbox: (path: string): Promise<RekordboxGrid | null> => ipcRenderer.invoke("planner:rekordbox", path),
	cues: (path: string): Promise<Cue[]> => ipcRenderer.invoke("planner:cues", path),
	stretch: (req: StretchRequest): Promise<StretchResult> => ipcRenderer.invoke("planner:stretch", req),
	ramp: (req: RampRequest): Promise<StretchResult> => ipcRenderer.invoke("planner:ramp", req),
	// Says which renderings (stretchKey, rampKey) the set still needs; other work is dropped.
	keepRenderings: (keys: string[]): Promise<void> => ipcRenderer.invoke("planner:keep", keys),
	readAudio: (cachePath: string): Promise<Uint8Array> => ipcRenderer.invoke("planner:read-audio", cachePath),
	readPeaks: (cachePath: string): Promise<Uint8Array> => ipcRenderer.invoke("planner:read-peaks", cachePath),
	chooseAudio: (): Promise<string[]> => ipcRenderer.invoke("planner:choose-audio"),
	chooseExport: (defaultName: string): Promise<string | null> => ipcRenderer.invoke("planner:choose-export", defaultName),
	exportSet: (req: ExportRequest): Promise<ExportResult> => ipcRenderer.invoke("planner:export", req),
	cancelExport: (): Promise<void> => ipcRenderer.invoke("planner:export-cancel"),
	// Sets live in the app's own storage; nothing here ever asks where to put a file.
	listSets: (): Promise<SetInfo[]> => ipcRenderer.invoke("planner:sets-list"),
	openSet: (id: string): Promise<SetFile> => ipcRenderer.invoke("planner:set-open", id),
	// Stores the set and returns its name (a new set is named when first stored).
	saveSet: (id: string, name: string | null, view: SetView, doc: PlannerDoc): Promise<string> => ipcRenderer.invoke("planner:set-save", id, name, view, doc),
	// The same, finished before it returns: for the moment the window closes.
	saveSetNow: (id: string, name: string | null, view: SetView, doc: PlannerDoc): string => ipcRenderer.sendSync("planner:set-save-sync", id, name, view, doc),
	renameSet: (id: string, name: string): Promise<string> => ipcRenderer.invoke("planner:set-rename", id, name),
	duplicateSet: (id: string): Promise<void> => ipcRenderer.invoke("planner:set-duplicate", id),
	deleteSet: (id: string): Promise<void> => ipcRenderer.invoke("planner:set-delete", id),
	// For tests: brings a set file from outside into the app's sets, and cleans the cache now.
	importSetFile: (path: string): Promise<string> => ipcRenderer.invoke("planner:set-import", path),
	pruneCache: (): Promise<void> => ipcRenderer.invoke("planner:prune"),
	reveal: (path: string): Promise<void> => ipcRenderer.invoke("planner:reveal", path),

	onStretchProgress: (cb: (p: StretchProgress) => void): (() => void) => on("planner:stretch-progress", cb),
	// Cached audio that was cleaned away: whatever still counts on it has to ask again.
	onCacheRemoved: (cb: (paths: string[]) => void): (() => void) => on("planner:cache-removed", cb),
	onExportProgress: (cb: (p: ExportProgress) => void): (() => void) => on("planner:export-progress", cb),
	onMenu: (cb: (action: string) => void): (() => void) => on("planner:menu", cb),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;

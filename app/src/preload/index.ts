import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { UpdateCheckResult, UpdatePhase, UpdateProgress } from "../shared/updater";
import type { EditExportRequest, EditExportResult, Settings, ExportProgress, ExportRequest, ExportResult, PlannerDoc, CueChange, CueInfo, CueRow, ProbeResult, RampRequest, RekordboxGrid, RekordboxLibrary, SetFile, SetInfo, SetView, StretchProgress, StretchRequest, StretchResult } from "../shared/planner";

function on<T>(channel: string, cb: (payload: T) => void): () => void {
	const fn = (_e: unknown, payload: T): void => cb(payload);
	ipcRenderer.on(channel, fn);
	return () => ipcRenderer.removeListener(channel, fn);
}

const api = {
	getAppInfo: (): Promise<{ env: "dev" | "prod" }> => ipcRenderer.invoke("appInfo:get"),
	toggleDevTools: (): Promise<void> => ipcRenderer.invoke("devtools:toggle"),

	pathForFile: (file: File): string => webUtils.getPathForFile(file),
	probe: (path: string): Promise<ProbeResult> => ipcRenderer.invoke("planner:probe", path),
	rekordbox: (path: string): Promise<RekordboxGrid | null> => ipcRenderer.invoke("planner:rekordbox", path),
	// null when there is no Rekordbox library on this machine
	rekordboxLibrary: (): Promise<RekordboxLibrary | null> => ipcRenderer.invoke("planner:rekordbox-library"),
	cues: (path: string): Promise<CueInfo> => ipcRenderer.invoke("planner:cues", path),
	// These write to Rekordbox's own database at once. `kind` 0 is a memory cue, 1 to 8 the
	// hot cues A to H; a hot cue takes the place of the one already on its letter.
	cueAdd: (path: string, sec: number, kind: number): Promise<CueChange> => ipcRenderer.invoke("planner:cue-add", path, sec, kind),
	cueDelete: (path: string, ids: string[]): Promise<CueChange> => ipcRenderer.invoke("planner:cue-delete", path, ids),
	// Takes the cues with these ids out and puts these rows back in: undo and redo.
	cueApply: (path: string, remove: string[], insert: CueRow[]): Promise<CueChange> => ipcRenderer.invoke("planner:cue-apply", path, remove, insert),
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
	// Writes an edited track into the export folder, as the source's own samples rearranged.
	exportEdit: (req: EditExportRequest): Promise<EditExportResult> => ipcRenderer.invoke("planner:export-edit", req),
	getSettings: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
	setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke("settings:set", patch),
	chooseFolder: (): Promise<string | null> => ipcRenderer.invoke("settings:choose-folder"),
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

	checkForUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke("updater:check"),
	installUpdate: (downloadUrl: string): Promise<void> => ipcRenderer.invoke("updater:install", downloadUrl),
	onUpdateMenu: (cb: () => void): (() => void) => on("updater:menu-triggered", cb),
	onUpdateProgress: (cb: (p: UpdateProgress) => void): (() => void) => on("updater:progress", cb),
	onUpdateStatus: (cb: (p: { phase: UpdatePhase }) => void): (() => void) => on("updater:status", cb),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;

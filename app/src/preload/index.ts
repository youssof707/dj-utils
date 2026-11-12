import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Track } from "../shared/types";
import type { ExportProgress, ExportRequest, ExportResult, PlannerDoc, ProbeResult, Session, StretchProgress, StretchRequest, StretchResult } from "../shared/planner";

function on<T>(channel: string, cb: (payload: T) => void): () => void {
	const fn = (_e: unknown, payload: T): void => cb(payload);
	ipcRenderer.on(channel, fn);
	return () => ipcRenderer.removeListener(channel, fn);
}

const api = {
	listDownloads: (): Promise<Track[]> => ipcRenderer.invoke("downloads:list"),

	pathForFile: (file: File): string => webUtils.getPathForFile(file),
	probe: (path: string): Promise<ProbeResult> => ipcRenderer.invoke("planner:probe", path),
	stretch: (req: StretchRequest): Promise<StretchResult> => ipcRenderer.invoke("planner:stretch", req),
	readAudio: (cachePath: string): Promise<Uint8Array> => ipcRenderer.invoke("planner:read-audio", cachePath),
	readPeaks: (cachePath: string): Promise<Uint8Array> => ipcRenderer.invoke("planner:read-peaks", cachePath),
	chooseAudio: (): Promise<string[]> => ipcRenderer.invoke("planner:choose-audio"),
	chooseExport: (defaultName: string): Promise<string | null> => ipcRenderer.invoke("planner:choose-export", defaultName),
	exportSet: (req: ExportRequest): Promise<ExportResult> => ipcRenderer.invoke("planner:export", req),
	cancelExport: (): Promise<void> => ipcRenderer.invoke("planner:export-cancel"),
	openProject: (path?: string): Promise<{ path: string; doc: PlannerDoc } | null> => ipcRenderer.invoke("planner:open-project", path),
	saveProject: (path: string | null, doc: PlannerDoc): Promise<string | null> => ipcRenderer.invoke("planner:save-project", path, doc),
	loadSession: (): Promise<Session | null> => ipcRenderer.invoke("planner:load-session"),
	saveSession: (s: Session): Promise<void> => ipcRenderer.invoke("planner:save-session", s),
	reveal: (path: string): Promise<void> => ipcRenderer.invoke("planner:reveal", path),
	fileExists: (path: string): Promise<boolean> => ipcRenderer.invoke("planner:file-exists", path),

	onStretchProgress: (cb: (p: StretchProgress) => void): (() => void) => on("planner:stretch-progress", cb),
	onExportProgress: (cb: (p: ExportProgress) => void): (() => void) => on("planner:export-progress", cb),
	onMenu: (cb: (action: string) => void): (() => void) => on("planner:menu", cb),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;

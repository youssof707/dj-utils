// Types shared by the main-process updater and the renderer's update modal.

export interface UpdateCheckResult {
	available: boolean;
	currentVersion: string;
	latestVersion: string | null;
	downloadUrl: string | null;
	releaseUrl: string | null;
	releaseNotes: string | null;
	error?: string;
}

export type UpdatePhase = "downloading" | "mounting" | "installing";

export interface UpdateProgress {
	received: number;
	total: number;
	percent: number;
}

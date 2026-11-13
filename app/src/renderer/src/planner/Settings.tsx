// The settings page, reached from the list of sets.

import { useEffect } from "react";
import { errorText, store, toast, useStore } from "./store";

export async function loadSettings(): Promise<void> {
	try {
		store.set({ settings: await window.api.getSettings() });
	} catch (e) {
		toast(`Could not read the settings: ${errorText(e)}`);
	}
}

export function openSettings(): void {
	store.set({ screen: "settings" });
	void loadSettings();
}

export function closeSettings(): void {
	if (store.get().screen === "settings") store.set({ screen: "home" });
}

async function chooseExportDir(): Promise<void> {
	try {
		const dir = await window.api.chooseFolder();
		if (dir) store.set({ settings: await window.api.setSettings({ exportDir: dir }) });
	} catch (e) {
		toast(`Could not change the folder: ${errorText(e)}`);
	}
}

export function Settings() {
	const settings = useStore((s) => s.settings);
	useEffect(() => void loadSettings(), []);
	return (
		<div className="home" data-testid="settings">
			<div className="home-inner">
				<div className="home-head">
					<h1>Settings</h1>
					<button className="ghost" data-testid="settings-back" onClick={closeSettings}>
						Back to sets
					</button>
				</div>
				<div className="setting">
					<div className="setting-main">
						<div className="setting-name">Export folder</div>
						<div className="muted">Tracks exported from the track editor are written here.</div>
						<div className="setting-path" data-testid="export-dir">
							{settings?.exportDir ?? ""}
						</div>
					</div>
					<div className="set-row-actions">
						<button className="ghost" data-testid="export-dir-choose" onClick={() => void chooseExportDir()}>
							Choose…
						</button>
						<button className="ghost" data-testid="export-dir-reveal" disabled={!settings} onClick={() => settings && void window.api.reveal(settings.exportDir)}>
							Show in Finder
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

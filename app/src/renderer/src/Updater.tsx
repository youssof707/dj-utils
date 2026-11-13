// Update flow UI, ported from ground-control's updater feature:
//   - a silent check ~2s after launch; the modal only opens if an update exists
//   - "Check for Updates…" in the app menu always opens the modal, even when up to date
//   - while installing, progress and phase come from main via `updater:progress` / `updater:status`

import { useEffect, useRef, useState } from "react";
import type { UpdatePhase } from "@shared/updater";

interface Info {
	currentVersion: string;
	latestVersion: string;
	downloadUrl: string;
}

type Status = { kind: "idle" } | { kind: "available" } | { kind: "up-to-date" } | { kind: UpdatePhase } | { kind: "error"; message: string };

// Read by App's key handling, so transport shortcuts stay off while the dialog is up.
let open = false;
export function updateModalOpen(): boolean {
	return open;
}

export function Updater() {
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const [info, setInfo] = useState<Info | null>(null);
	const [pct, setPct] = useState<number | null>(null);
	const [visible, setVisible] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		async function check(silent: boolean): Promise<void> {
			try {
				const r = await window.api.checkForUpdate();
				if (cancelled) return;
				if (r.error) {
					// Offline or rate-limited in the background: stay quiet unless asked.
					if (!silent) {
						setStatus({ kind: "error", message: r.error });
						setVisible(true);
					}
					return;
				}
				setInfo({ currentVersion: r.currentVersion, latestVersion: r.latestVersion ?? "", downloadUrl: r.downloadUrl ?? "" });
				if (r.available && r.downloadUrl) {
					setStatus({ kind: "available" });
					setVisible(true);
				} else {
					setStatus({ kind: "up-to-date" });
					if (!silent) setVisible(true);
				}
			} catch (err) {
				if (cancelled || silent) return;
				setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
				setVisible(true);
			}
		}
		const timer = setTimeout(() => void check(true), 2000);
		const offs = [
			window.api.onUpdateMenu(() => void check(false)),
			window.api.onUpdateProgress((p) => setPct(p.percent)),
			window.api.onUpdateStatus((p) => setStatus({ kind: p.phase })),
		];
		return () => {
			cancelled = true;
			clearTimeout(timer);
			offs.forEach((off) => off());
		};
	}, []);

	open = visible;
	const installing = status.kind === "downloading" || status.kind === "mounting" || status.kind === "installing";

	useEffect(() => {
		if (visible) ref.current?.focus();
	}, [visible]);

	if (!visible) return null;

	const close = (): void => {
		if (installing) return;
		setVisible(false);
		if (status.kind === "error" || status.kind === "up-to-date") setStatus({ kind: "idle" });
	};

	const install = async (): Promise<void> => {
		if (!info?.downloadUrl) return;
		try {
			// Main reports progress through events and quits the app once the swap is scheduled.
			await window.api.installUpdate(info.downloadUrl);
		} catch (err) {
			setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
		}
	};

	return (
		<div
			className="modal-backdrop"
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) close();
			}}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Escape") close();
			}}
		>
			<div className="modal" data-testid="update-modal" role="dialog" tabIndex={-1} ref={ref}>
				{status.kind === "up-to-date" && info && (
					<>
						<h3>You're up to date</h3>
						<p>DJ Utilities v{info.currentVersion} is the latest version.</p>
						<div className="buttons">
							<button className="primary" onClick={close}>
								OK
							</button>
						</div>
					</>
				)}
				{status.kind === "error" && (
					<>
						<h3>Update failed</h3>
						<p className="error">{status.message}</p>
						<div className="buttons">
							<button className="primary" onClick={close}>
								Close
							</button>
						</div>
					</>
				)}
				{status.kind === "available" && info && (
					<>
						<h3>Update available: v{info.latestVersion}</h3>
						<p>You're running v{info.currentVersion}. Install v{info.latestVersion}?</p>
						<div className="buttons">
							<button className="ghost" onClick={close}>
								Later
							</button>
							<button className="primary" onClick={() => void install()}>
								Install and restart
							</button>
						</div>
					</>
				)}
				{status.kind === "downloading" && info && (
					<>
						<h3>Downloading v{info.latestVersion}</h3>
						<p>{pct !== null ? `${pct}%. Please don't quit the app.` : "Starting download…"}</p>
						<div className="progress">
							<div style={{ width: `${pct ?? 0}%` }} />
						</div>
					</>
				)}
				{status.kind === "mounting" && info && (
					<>
						<h3>Preparing v{info.latestVersion}</h3>
						<p>Mounting the update…</p>
						<div className="progress">
							<div style={{ width: "100%" }} />
						</div>
					</>
				)}
				{status.kind === "installing" && info && (
					<>
						<h3>Installing v{info.latestVersion}</h3>
						<p>DJ Utilities is about to restart to finish the update.</p>
						<div className="progress">
							<div style={{ width: "100%" }} />
						</div>
					</>
				)}
			</div>
		</div>
	);
}

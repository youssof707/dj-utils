import { useEffect, useState } from "react";

// Always shown in the bottom-left corner: the version, plus "dev" on a dev build.
export function VersionChip() {
	const [info, setInfo] = useState<{ env: "dev" | "prod" } | null>(null);

	useEffect(() => {
		let alive = true;
		void window.api.getAppInfo().then((i) => {
			if (alive) setInfo(i);
		});
		return () => {
			alive = false;
		};
	}, []);

	return (
		<span className="version-chip" data-testid="version-chip" onDoubleClick={() => void window.api.toggleDevTools()}>
			v{__APP_VERSION__}
			{info?.env === "dev" ? " · dev" : ""}
		</span>
	);
}

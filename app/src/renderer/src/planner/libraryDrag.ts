import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

// Dragging a track out of the library. Inside the window the page runs the drag itself, so a
// drop on a lane or the track editor always lands; once the pointer leaves the window the
// system takes over and drags the file, so it can be dropped in Finder or another app.

export type LibraryDrop = { path: string; clientX: number; clientY: number; altKey: boolean };
const EVENT = "library-drop";

// Lets an element take tracks dropped from the library.
export function useLibraryDrop(ref: RefObject<HTMLElement | null>, onDrop: (d: LibraryDrop) => void): void {
	const latest = useRef(onDrop);
	latest.current = onDrop;
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.dataset.libraryDrop = "";
		const take = (e: Event): void => latest.current((e as CustomEvent<LibraryDrop>).detail);
		el.addEventListener(EVENT, take);
		return () => el.removeEventListener(EVENT, take);
	}, [ref]);
}

export function startLibraryDrag(e: ReactPointerEvent<HTMLElement>, path: string, picture: () => { png: string; scale: number }): void {
	if (e.button !== 0) return;
	e.preventDefault();
	const row = e.currentTarget;
	const id = e.pointerId;
	const x0 = e.clientX;
	const y0 = e.clientY;
	let ghost: HTMLImageElement | null = null;
	const end = (): void => {
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
		window.removeEventListener("pointercancel", end);
		window.removeEventListener("keydown", key);
		if (row.hasPointerCapture(id)) row.releasePointerCapture(id);
		ghost?.remove();
		document.body.classList.remove("dragging-copy");
	};
	const move = (ev: PointerEvent): void => {
		if (!ghost) {
			if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
			const pic = picture();
			ghost = document.createElement("img");
			ghost.src = pic.png;
			ghost.className = "library-ghost";
			ghost.dataset.testid = "library-ghost";
			ghost.onload = () => {
				if (ghost) ghost.style.width = `${ghost.naturalWidth / pic.scale}px`;
			};
			document.body.appendChild(ghost);
			document.body.classList.add("dragging-copy");
		}
		ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 6}px)`;
		const out = ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight;
		if (out) {
			end();
			window.api.dragFile(path, picture());
		}
	};
	const up = (ev: PointerEvent): void => {
		const dragged = ghost !== null;
		end();
		if (!dragged) return;
		const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-library-drop]");
		target?.dispatchEvent(new CustomEvent<LibraryDrop>(EVENT, { detail: { path, clientX: ev.clientX, clientY: ev.clientY, altKey: ev.altKey } }));
	};
	const key = (ev: KeyboardEvent): void => {
		if (ev.key === "Escape") end();
	};
	row.setPointerCapture(id);
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", up);
	window.addEventListener("pointercancel", end);
	window.addEventListener("keydown", key);
}

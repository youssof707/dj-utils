// Runs in the app's page before its own code. Records everything the page plays, without
// changing what it plays: whatever any node sends to the speakers is also sent to a recorder,
// and plain <audio> players (the library preview) are watched so their sound can be rebuilt
// from the file afterwards. Also notes the pointer shape the page asks for.
(() => {
	if (window.__demo) return;
	const demo = (window.__demo = { chunks: [], rate: 0, players: [], playerLog: [], cursorLog: [], lastXY: null });
	const wall = () => performance.timeOrigin + performance.now();

	// ---- Web Audio: tee every connection to the speakers into a recorder -------------------
	const WORKLET = `
		class Rec extends AudioWorkletProcessor {
			constructor() { super(); this.n = 4096; this.l = new Float32Array(this.n); this.r = new Float32Array(this.n); this.i = 0; this.start = 0; }
			process(inputs) {
				const inp = inputs[0];
				const a = inp && inp[0];
				const b = inp && (inp[1] || inp[0]);
				for (let k = 0; k < 128; k++) {
					if (this.i === 0) this.start = currentFrame + k;
					this.l[this.i] = a ? a[k] : 0;
					this.r[this.i] = b ? b[k] : 0;
					if (++this.i === this.n) {
						this.port.postMessage({ frame: this.start, l: this.l, r: this.r });
						this.l = new Float32Array(this.n); this.r = new Float32Array(this.n); this.i = 0;
					}
				}
				return true;
			}
		}
		registerProcessor("demo-rec", Rec);`;
	const taps = new WeakMap();
	const tapFor = (ctx) => {
		let tap = taps.get(ctx);
		if (tap) return tap;
		// A gain the recorder hangs off; made at once so connections can be teed before the worklet loads.
		tap = new GainNode(ctx, { gain: 1 });
		taps.set(ctx, tap);
		demo.rate = ctx.sampleRate;
		const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
		ctx.audioWorklet.addModule(url).then(
			() => {
				const node = new AudioWorkletNode(ctx, "demo-rec", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
				node.port.onmessage = (e) => {
					// When this stretch of audio reaches the speakers, on the wall clock.
					const ts = ctx.getOutputTimestamp();
					const at = performance.timeOrigin + ts.performanceTime + (e.data.frame / ctx.sampleRate - ts.contextTime) * 1000;
					demo.chunks.push({ frame: e.data.frame, at, l: e.data.l, r: e.data.r });
				};
				origConnect.call(tap, node);
				demo.worklet = true;
			},
			(err) => {
				demo.workletError = String(err);
			},
		);
		return tap;
	};
	const origConnect = AudioNode.prototype.connect;
	AudioNode.prototype.connect = function (dest, ...rest) {
		if (dest instanceof AudioDestinationNode) origConnect.call(this, tapFor(dest.context), ...rest);
		return origConnect.call(this, dest, ...rest);
	};
	// Hands the recorded audio over in pieces: interleaved stereo float32, base64.
	demo.take = (max) => {
		const got = demo.chunks.splice(0, max);
		return got.map((c) => {
			const inter = new Float32Array(c.l.length * 2);
			for (let i = 0; i < c.l.length; i++) {
				inter[2 * i] = c.l[i];
				inter[2 * i + 1] = c.r[i];
			}
			const bytes = new Uint8Array(inter.buffer);
			let s = "";
			for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
			return { frame: c.frame, at: c.at, data: btoa(s) };
		});
	};

	// ---- <audio> players --------------------------------------------------------------------
	const NativeAudio = window.Audio;
	window.Audio = function (...args) {
		const el = new NativeAudio(...args);
		demo.players.push(el);
		return el;
	};
	window.Audio.prototype = NativeAudio.prototype;
	setInterval(() => {
		for (const el of demo.players) {
			const playing = !el.paused && !el.ended && el.readyState >= 2;
			const last = el.__last;
			if (playing || (last && last.playing)) demo.playerLog.push({ t: wall(), id: demo.players.indexOf(el), src: el.currentSrc, pos: el.currentTime, playing, vol: el.muted ? 0 : el.volume });
			el.__last = { playing };
		}
	}, 25);

	// ---- pointer shape ------------------------------------------------------------------------
	let shape = "";
	const sample = () => {
		if (!demo.lastXY) return;
		const el = document.elementFromPoint(demo.lastXY[0], demo.lastXY[1]);
		const c = el ? getComputedStyle(el).cursor : "default";
		if (c !== shape) demo.cursorLog.push({ t: wall(), c: (shape = c) });
	};
	addEventListener(
		"mousemove",
		(e) => {
			demo.lastXY = [e.clientX, e.clientY];
			sample();
		},
		true,
	);
	setInterval(sample, 50);
})();

// The corner label says "dev" on an unpackaged build; show it as a release shows it.
setInterval(() => {
	const el = document.querySelector(".version-chip");
	if (el && el.textContent.includes(" · dev")) for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.includes("dev")) n.textContent = "";
}, 100);

// Keeps frames coming while the page is still, so the recording never holds an old picture: one
// pixel in the corner flips between two colours that look the same.
(() => {
	let on = false;
	let dot = null;
	setInterval(() => {
		if (!document.body) return;
		if (!dot || !dot.isConnected) {
			dot = document.createElement("div");
			dot.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:2147483647;pointer-events:none;background:#0e0f12";
			document.body.appendChild(dot);
		}
		dot.style.background = (on = !on) ? "#0e0f13" : "#0e0f12";
	}, 70);
})();

// Settings shows the dev build's export folder (inside this take's data); show the folder a
// released build uses instead.
setInterval(() => {
	const el = document.querySelector('[data-testid="export-dir"]');
	if (el && el.textContent.includes("/dev-data/")) el.textContent = el.textContent.replace(/^(\/Users\/[^/]+)\/.*$/, "$1/Music/DJ Utilities Edits");
}, 30);

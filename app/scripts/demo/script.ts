// The narration. Lines are voiced a paragraph at a time (so the voice carries through), and
// placed in the film one line at a time.

export const LINES = {
	a1: "This is a whole DJ set. Every transition, every tempo change, every double drop, worked out on a timeline before I've touched a deck.",
	a2: "It's called DJ Utilities, and this is how it works.",
	b1: "Every set you plan lives here, and it saves itself as you go.",
	b3: "Rename them, duplicate them, or delete the ones you're done with.",
	b4: "And settings is where you choose the folder your edits are saved to.",
	b2: "Let's start a new one, give it a name, and set its tempo.",
	c1: "On the left is your Rekordbox library. Same playlists, same keys, same BPMs.",
	c3: "Sort it by BPM or key, and star the tracks you might want.",
	c2: "Search it, filter it down by key or tempo, and click anywhere along a track to hear it.",
	d1: "Found one you like? Drag it onto a lane.",
	d2: "It already has the beat grid and the cue points from Rekordbox, so it lands right on the beat.",
	d3: "The next one goes on another lane.",
	e1: "Trim it back to the drop, and slide it over to where the mix should happen.",
	e2: "Split the first track where the new one comes in, and cut its bass so the low end stays clean.",
	e3: "Add a fade if you want one.",
	e4: "Then press play.",
	e5: "That's exactly how it's going to sound on the night.",
	e6: "Want to skip the breakdown? Hold S, cut either side of it, delete it, and close the gap.",
	e7: "Copy, paste and duplicate all work the way you'd expect, and Command Z undoes anything. Mute a lane when you want to hear one track on its own.",
	f1: "Tempo changes work the same way. Double-click the tempo lane, type a BPM, and drag the ramp out as long as you like.",
	f2: "Everything after it gets re-stretched to match.",
	g1: "Tracks that aren't in Rekordbox work too. Drop in the file, give it a BPM, and it's on the grid with everything else.",
	h1: "Sometimes it's the track itself that needs work. Send it to the editor, cut it up, and move, copy or delete the pieces until it's the version you'd actually play.",
	h2: "Export it, and you've got a new file, ready for Rekordbox.",
	i1: "When the set's done, switch on playlist mode.",
	i2: "Anything a CDJ couldn't play straight through shows up in red, and the app will build that edit for you.",
	i3: "Then link a Rekordbox playlist and hit sync. Your tracks are there, in the order you play them.",
	j1: "Hot cues and memory cues go straight onto the timeline, and they're written back to Rekordbox.",
	k1: "Tag tracks while you dig, so you can find them next time.",
	l1: "And if you just want to listen to the whole thing in the car, export it as one mix.",
	m1: "That's DJ Utilities. Plan it at home, and walk in knowing exactly how it goes.",
} as const;

// Which lines are voiced together.
export const PARAGRAPHS: (keyof typeof LINES)[][] = [["a1", "a2"], ["b1", "b3", "b4", "b2"], ["c1", "c3", "c2"], ["d1", "d2", "d3"], ["e1", "e2", "e3", "e4"], ["e5"], ["e6"], ["e7"], ["f1", "f2"], ["g1"], ["h1", "h2"], ["i1", "i2", "i3"], ["j1"], ["k1"], ["l1"], ["m1"]];

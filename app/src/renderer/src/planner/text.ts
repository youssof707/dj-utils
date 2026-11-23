// Lower case and without accents, so "beyonce" finds "Beyoncé".
export function plain(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase();
}

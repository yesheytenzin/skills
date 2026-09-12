/**
 * Applies the custom "omarchy-system" pi theme on startup so it sticks as the
 * default instead of reverting to the built-in light/dark theme.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SYSTEM_THEME = "omarchy-system";

export default function (pi: ExtensionAPI) {
	let intervalId: ReturnType<typeof setInterval> | null = null;

	pi.on("session_start", (_event, ctx) => {
		let currentTheme = SYSTEM_THEME;
		ctx.ui.setTheme(currentTheme);

		// Re-affirm only on change so live /settings theme switches still work.
		intervalId = setInterval(() => {
			const nextTheme = SYSTEM_THEME;
			if (nextTheme !== currentTheme) {
				currentTheme = nextTheme;
				ctx.ui.setTheme(currentTheme);
			}
		}, 2000);
	});

	pi.on("session_shutdown", () => {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	});
}

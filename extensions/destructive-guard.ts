/**
 * Destructive Command Guard (optimized)
 *
 * Confirm-before-run for Linux/Omarchy/Rails footguns. Fast path exits
 * on the first safe command; slow path only scans flagged segments.
 *
 * Covers: rm -rf, pacman/yay/paru -R + cache wipes, rails/rake db:drop/
 * reset/..., dd/mkfs/wipefs/shred on devices, chmod/chown on /, git
 * force-push (not --force-with-lease), systemctl disable/mask (system
 * scope only), reboot/poweroff.
 *
 * Skips: safe `rm -rf` inside relative build dirs + /tmp/<file>,
 * `git push --force-with-lease`, `systemctl --user`.
 *
 * Toggle: /guard on | off | status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Rule {
	label: string;
	hint?: string;
	test: (seg: string) => boolean;
}

// rm -rf ./build, ./dist, node_modules etc. is routine agent work — don't nag.
const SAFE_RM = /^(?:\.\/)?(?:tmp|temp|\.tmp|build|dist|out|\.next|target|coverage|\.turbo|node_modules|__pycache__|\.pytest_cache|log|logs)(?:\/.*)?$/;
const SAFE_RM_GLOB = /^\*?\.(?:log|tmp|bak|orig|rej|pyc)$/;

const SUDO_ARG_FLAGS = new Set([
	"-u", "-g", "-U", "-p", "-C", "-D", "-r", "--user", "--group", "--prompt", "--close-from",
]);

function stripWrapper(seg: string): string {
	let s = seg.trim();
	// sudo/doas/run0 (+ their flags, incl. `-u <user>` value flags), env/VAR=x prefixes
	for (let i = 0; i < 6; i++) {
		const before = s;
		s = s.replace(/^(?:sudo|doas|run0)\b\s*/u, "");
		// strip leading sudo flags: `-n`, `-E`, `-u foo`, `--user=foo`, ...
		// (a real command never starts with `-`, so this is unambiguous)
		while (/^-/u.test(s)) {
			const m = s.match(/^(-[^\s]*)(\s*)/u);
			if (!m) break;
			const flag = m[1].split("=")[0];
			s = s.slice(m[0].length);
			const takesVal =
				SUDO_ARG_FLAGS.has(flag) || /^-[a-zA-Z]*[uUpPgCD]$/u.test(flag);
			if (takesVal && !m[1].includes("=") && s && !/^\s*-/u.test(s)) {
				const vm = s.match(/^([^\s]+\s*)/u);
				if (vm) s = s.slice(vm[0].length);
			}
			if (!s || !/^-/u.test(s)) break;
		}
		s = s
			.replace(/^env\s+(?:[^\s=]+=[^\s]*\s+)*/u, "")
			.replace(/^[A-Z_][A-Z0-9_]*=[^\s]*\s+/u, "");
		if (s === before) break;
	}
	return s;
}

function rmTargets(seg: string): string[] {
	// crude but quote-aware token split; drop flags and rm itself
	const toks: string[] = [];
	let cur = "";
	let q = "";
	for (const ch of seg) {
		if (q) {
			cur += ch;
			if (ch === q) q = "";
		} else if (ch === '"' || ch === "'") {
			q = ch;
			cur += ch;
		} else if (/\s/u.test(ch)) {
			if (cur) toks.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur) toks.push(cur);
	return toks
		.filter((t) => t !== "rm" && !t.startsWith("-") && t !== "--")
		.map((t) => t.replace(/^['"]|['"]$/g, ""))
		.filter(Boolean);
}

function isSafeRmTarget(t: string): boolean {
	if (SAFE_RM.test(t) || SAFE_RM_GLOB.test(t)) return true;
	if (/^\/tmp\/[^/]+(?:\/.*)?$/u.test(t) && t !== "/tmp" && t !== "/tmp/") return true;
	return false;
}

function isDangerTarget(t: string): boolean {
	return (
		t === "/" ||
		t === "/*" ||
		t === "." ||
		t === ".." ||
		t === "~" ||
		t === "$HOME" ||
		t === "${HOME}" ||
		/^\/(?:bin|boot|dev|etc|home|opt|root|run|sbin|srv|sys|usr|var)(?:\/|$)/u.test(t) ||
		t.includes("*") ||
		t === "-rf" // `rm -rf` with no target after glob fail → shell may eat cwd
	);
}

const rules: Rule[] = [
	{
		label: "recursive delete",
		test: (raw) => {
			const s = stripWrapper(raw);
			if (!/\brm\b/u.test(s)) return false;
			const recursive = /(^|\s)(--recursive|-[^\s-]*[rR])/u.test(s);
			if (!recursive) return false;
			const force = /(^|\s)(--force|-[^\s-]*f)/u.test(s);
			const targets = rmTargets(s);
			// `rm -r` without -f on root-ish paths is still catastrophic
			if (!force) return targets.some(isDangerTarget);
			// `rm -rf` on only safe build dirs / /tmp files → allow silently
			if (targets.length > 0 && targets.every(isSafeRmTarget)) return false;
			return true;
		},
	},
	{
		label: "package removal",
		hint: "Removes packages from the system",
		test: (raw) => {
			const s = stripWrapper(raw);
			return /\b(pacman|yay|paru)\b/u.test(s) && /(^|\s)-[^\s-]*R/u.test(s);
		},
	},
	{
		label: "package cache wipe",
		test: (raw) => {
			const s = stripWrapper(raw);
			if (/\bpaccache\b/u.test(s) && /(^|\s)-r/u.test(s)) return true;
			return (
				/\b(pacman|yay|paru)\b/u.test(s) && /(^|\s)-[^\s-]*S[^\s-]*c[^\s-]*c/u.test(s)
			);
		},
	},
	{
		label: "destructive Rails DB task",
		hint: "Drops/resets the database or destroys generated code",
		test: (raw) => {
			const s = stripWrapper(raw);
			const runner = /(^|[\s/;|&])(bin\/rails|bin\/rake|bundle\s+exec\s+(?:rails?|rake)|rails?|rake)\b/u.test(s);
			if (!runner) return false;
			return (
				/db:(?:drop|reset|migrate:reset|schema:load|purge|clobber|setup--force)/u.test(s) ||
				/\brails?\s+destroy\b/u.test(s)
			);
		},
	},
	{
		label: "raw device write / format",
		hint: "Can permanently erase a disk or partition",
		test: (raw) => {
			const s = stripWrapper(raw);
			return (
				/\bdd\b.*\bof=\/dev\//u.test(s) ||
				/\bmkfs(?:\.[a-z0-9]+)?\s/u.test(s) ||
				/\bwipefs\b/u.test(s) ||
				/\bshred\b.*\/dev\//u.test(s) ||
				/>\s*\/dev\/[a-z]/u.test(s)
			);
		},
	},
	{
		label: "system-wide permission change",
		test: (raw) => {
			const s = stripWrapper(raw);
			if (!/\b(chmod|chown)\b/u.test(s)) return false;
			const recursive = /(^|\s)-[^\s-]*R/u.test(s);
			const triple7 = /(^|\s)0?777(\s|$)/u.test(s);
			const onRoot = /(^|\s)(\/|\/\*|~|\$HOME|\.)(\s|$|[;"'])/u.test(s);
			return (recursive && onRoot) || (triple7 && /(\/)/u.test(s));
		},
	},
	{
		label: "force push",
		hint: "Overwrites remote history",
		test: (raw) => {
			const s = stripWrapper(raw);
			if (!/\bgit\b.*\bpush\b/u.test(s)) return false;
			if (/--force-with-lease/u.test(s)) return false; // safe variant
			return /(^|\s)--force(\s|$|=)/u.test(s) || /(^|\s)-f(\s|$)/u.test(s);
		},
	},
	{
		label: "git hard reset / clean",
		hint: "Discards uncommitted work",
		test: (raw) => {
			const s = stripWrapper(raw);
			return /\bgit\b/u.test(s) && (/reset\s+--hard/u.test(s) || /clean\s+-[^\s-]*f[^\s-]*d/u.test(s));
		},
	},
	{
		label: "systemd disable/mask",
		test: (raw) => {
			const s = stripWrapper(raw);
			if (!/\bsystemctl\b/u.test(s)) return false;
			if (/--user/u.test(s)) return false; // user units are safe
			return /\b(disable|mask)\b/u.test(s);
		},
	},
	{
		label: "shutdown/reboot",
		test: (raw) => {
			const s = stripWrapper(raw);
			return (
				/\b(shutdown|reboot|poweroff|halt)\b/u.test(s) ||
				/\binit\s+[06]\b/u.test(s) ||
				/\bsystemctl\b.*\b(reboot|poweroff|halt|suspend|hibernate)\b/u.test(s)
			);
		},
	},
];

/** Quote-aware split on shell chaining so `cmd "a && b" && rm -rf /` checks correctly. */
function splitSegments(command: string): string[] {
	const out: string[] = [];
	let cur = "";
	let q = "";
	let esc = false;
	const push = () => {
		const t = cur.trim();
		if (t) out.push(t);
		cur = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (esc) {
			cur += ch;
			esc = false;
			continue;
		}
		if (ch === "\\" && !q) {
			esc = true;
			cur += ch;
			continue;
		}
		if (q) {
			cur += ch;
			if (ch === q) q = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			q = ch;
			cur += ch;
			continue;
		}
		if (ch === "\n") {
			push();
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||" || two === "$(") {
			push();
			i += 1;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "`") {
			push();
			continue;
		}
		cur += ch;
	}
	push();
	return out;
}

const normKey = (s: string) => s.trim().replace(/\s+/g, " ");

export default function (pi: ExtensionAPI) {
	let enabled = true;
	const approved = new Set<string>();

	pi.registerCommand("guard", {
		description: "Toggle destructive command guard (on/off/status)",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				approved.clear();
				ctx.ui.notify(`Destructive guard ${enabled ? "enabled" : "disabled"}`, "info");
			} else {
				ctx.ui.notify(
					`Destructive guard is ${enabled ? "ON" : "OFF"} (${rules.length} rules, ${approved.size} pre-approved)`,
					"info",
				);
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || event.toolName !== "bash") return undefined;

		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!command.trim()) return undefined;
		if (approved.has(normKey(command))) return undefined;

		// Fast path: skip anything without a risky keyword at all.
		if (!/(rm|pacman|yay|paru|paccache|rails?|rake|dd\b|mkfs|wipefs|shred|chmod|chown|git\b|systemctl|shutdown|reboot|poweroff|halt|init\b)\b/u.test(command))
			return undefined;

		const seen = new Map<string, Rule>();
		for (const seg of splitSegments(command)) {
			if (!seg) continue;
			for (const rule of rules) {
				if (seen.has(rule.label)) continue;
				let hit = false;
				try {
					hit = rule.test(seg);
				} catch {
					hit = false;
				}
				if (hit) seen.set(rule.label, rule);
			}
			if (seen.size > 0 && seen.has("raw device write / format")) break; // highest severity, no need for more
		}
		if (seen.size === 0) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason:
					`Blocked potentially destructive command (no UI to confirm):\n  ${command}\n` +
					`Matched: ${[...seen.keys()].join(", ")}. Run it yourself if intended.`,
			};
		}

		const details = [...seen.values()]
			.map((h) => `${h.label}${h.hint ? ` (${h.hint})` : ""}`)
			.join("\n  ");
		const choice = await ctx.ui.select(
			`⚠️ Potentially destructive command:\n\n  ${command}\n\nMatched:\n  ${details}\n\nAllow?`,
			["Allow once", "Always allow this command", "Block"],
		);

		if (choice === "Always allow this command") {
			approved.add(normKey(command));
			return undefined;
		}
		if (choice === "Allow once") return undefined;

		return { block: true, reason: `Blocked by destructive-guard: ${[...seen.keys()].join(", ")}` };
	});
}

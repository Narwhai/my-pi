import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Subscription usage limits for the active model's provider, shown in the footer via setStatus.
 *
 * /limits forces a refresh and notifies each window with its reset time.
 * Credentials come from pi's model registry, except claude-code which reads the Claude CLI file
 * (the CLI owns token refresh, so an expired token is reported instead of refreshed here).
 */

type ActiveModel = NonNullable<ExtensionContext["model"]>;
type Theme = ExtensionContext["ui"]["theme"];
type UsageWindow = { label: string; usedPercent: number; resetsAt: Date | undefined };
type Fetcher = {
	matches: (provider: string) => boolean;
	fetch: (ctx: ExtensionContext, model: ActiveModel, signal: AbortSignal) => Promise<UsageWindow[]>;
};
type RefreshResult =
	| { kind: "unsupported" }
	| { kind: "skipped" }
	| { kind: "superseded" }
	| { kind: "ok"; windows: UsageWindow[] }
	| { kind: "error"; message: string };

const STATUS_KEY = "usage-limits";
const REFRESH_MS = 5 * 60 * 1000;
const THROTTLE_MS = 30 * 1000;
const TIMEOUT_MS = 15 * 1000;
const FIVE_HOUR_SECONDS = 18000;
const WEEK_SECONDS = 604800;
const WINDOW_TOLERANCE_SECONDS = 120;
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "unknown error";
}

function requireNumber(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("bad response");
	return value;
}

function requireRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = record[key];
	if (!isRecord(value)) throw new Error("bad response");
	return value;
}

function parseDate(value: unknown): Date {
	if (typeof value !== "string") throw new Error("bad response");
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error("bad response");
	return date;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, Math.round(value)));
}

async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetch(url, { headers, signal });
	} catch {
		throw new Error(signal.aborted ? "timeout" : "network error");
	}
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error("bad JSON");
	}
	if (!isRecord(body)) throw new Error("bad response");
	return body;
}

async function resolveApiKey(ctx: ExtensionContext, model: ActiveModel): Promise<string> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error("auth failed");
	if (!auth.apiKey) throw new Error("no API key");
	return auth.apiKey;
}

function windowLabel(seconds: number): string | undefined {
	if (Math.abs(seconds - FIVE_HOUR_SECONDS) <= WINDOW_TOLERANCE_SECONDS) return "5h";
	if (Math.abs(seconds - WEEK_SECONDS) <= WINDOW_TOLERANCE_SECONDS) return "W";
	return undefined;
}

function nonEmpty(windows: UsageWindow[]): UsageWindow[] {
	if (windows.length === 0) throw new Error("no usage windows");
	return windows;
}

// openai-codex

function codexAccountId(token: string): string {
	const segment = token.split(".")[1];
	if (segment === undefined) throw new Error("bad token");
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
	} catch {
		throw new Error("bad token");
	}
	const auth = isRecord(payload) ? payload[CODEX_AUTH_CLAIM] : undefined;
	if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string") throw new Error("no account id");
	return auth.chatgpt_account_id;
}

function codexWindows(rateLimit: Record<string, unknown>): UsageWindow[] {
	const windows: UsageWindow[] = [];
	for (const key of ["primary_window", "secondary_window"]) {
		const value = rateLimit[key];
		if (value === null || value === undefined) continue;
		if (!isRecord(value)) throw new Error("bad response");
		const label = windowLabel(requireNumber(value, "limit_window_seconds"));
		if (label === undefined) continue;
		// TODO: reset_at is optional here; a missing value is shown as "reset time unknown".
		const resetAt = value.reset_at;
		windows.push({
			label,
			usedPercent: requireNumber(value, "used_percent"),
			resetsAt: typeof resetAt === "number" ? new Date(resetAt * 1000) : undefined,
		});
	}
	return nonEmpty(windows);
}

async function fetchCodex(ctx: ExtensionContext, model: ActiveModel, signal: AbortSignal): Promise<UsageWindow[]> {
	const apiKey = await resolveApiKey(ctx, model);
	const body = await getJson(
		"https://chatgpt.com/backend-api/wham/usage",
		{ Authorization: `Bearer ${apiKey}`, Accept: "application/json", "chatgpt-account-id": codexAccountId(apiKey) },
		signal,
	);
	return codexWindows(requireRecord(body, "rate_limit"));
}

// claude-code

function readClaudeToken(): string {
	// TODO: confirm CLAUDE_CONFIG_DIR handling matches the Claude CLI on all platforms.
	const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
	} catch {
		throw new Error("no claude credentials");
	}
	const oauth = isRecord(raw) ? raw.claudeAiOauth : undefined;
	if (!isRecord(oauth) || typeof oauth.accessToken !== "string") throw new Error("bad claude credentials");
	if (requireNumber(oauth, "expiresAt") <= Date.now()) throw new Error("claude token expired");
	return oauth.accessToken;
}

function claudeWindow(label: string, value: unknown): UsageWindow | undefined {
	if (value === null) return undefined;
	if (!isRecord(value)) throw new Error("bad response");
	return { label, usedPercent: requireNumber(value, "utilization"), resetsAt: parseDate(value.resets_at) };
}

async function fetchClaude(_ctx: ExtensionContext, _model: ActiveModel, signal: AbortSignal): Promise<UsageWindow[]> {
	const token = readClaudeToken();
	const body = await getJson(
		"https://api.anthropic.com/api/oauth/usage",
		{ Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
		signal,
	);
	const windows = [claudeWindow("5h", body.five_hour), claudeWindow("W", body.seven_day)];
	return nonEmpty(windows.filter((window): window is UsageWindow => window !== undefined));
}

// opencode-go

function opencodeWindow(label: string, value: Record<string, unknown>): UsageWindow {
	return { label, usedPercent: requireNumber(value, "percent"), resetsAt: parseDate(value.resetsAt) };
}

async function fetchOpencode(ctx: ExtensionContext, model: ActiveModel, signal: AbortSignal): Promise<UsageWindow[]> {
	const apiKey = await resolveApiKey(ctx, model);
	const body = await getJson("https://opencode.ai/zen/go/v1/usage", { Authorization: `Bearer ${apiKey}` }, signal);
	const usage = requireRecord(body, "usage");
	// TODO: the rolling/weekly/monthly `status` field is ignored; its values are not documented.
	return [
		opencodeWindow("5h", requireRecord(usage, "rolling")),
		opencodeWindow("W", requireRecord(usage, "weekly")),
		opencodeWindow("M", requireRecord(usage, "monthly")),
	];
}

const FETCHERS: Fetcher[] = [
	{ matches: (provider) => provider === "openai-codex" || /^openai-codex-\d+$/.test(provider), fetch: fetchCodex },
	{ matches: (provider) => provider === "claude-code", fetch: fetchClaude },
	{ matches: (provider) => provider === "opencode-go", fetch: fetchOpencode },
];

function findFetcher(model: ActiveModel | undefined): Fetcher | undefined {
	if (model === undefined) return undefined;
	return FETCHERS.find((fetcher) => fetcher.matches(model.provider));
}

// Rendering

function colorPercent(theme: Theme, percent: number): string {
	const text = `${clampPercent(percent)}%`;
	if (percent >= 90) return theme.fg("error", text);
	if (percent >= 75) return theme.fg("warning", text);
	return text;
}

function formatReset(resetsAt: Date | undefined): string {
	if (resetsAt === undefined) return "reset time unknown";
	const minutes = Math.max(0, Math.round((resetsAt.getTime() - Date.now()) / 60000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	if (days > 0) return `resets in ${days}d ${hours}h`;
	if (hours > 0) return `resets in ${hours}h ${minutes % 60}m`;
	return `resets in ${minutes}m`;
}

function showResult(ctx: ExtensionContext, result: RefreshResult): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	if (result.kind === "unsupported") {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	} else if (result.kind === "ok") {
		const parts = result.windows.map((window) => `${window.label} ${colorPercent(theme, window.usedPercent)}`);
		ctx.ui.setStatus(STATUS_KEY, `limits ${parts.join(" · ")}`);
	} else if (result.kind === "error") {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", `limits: ${result.message}`));
	}
}

// State and refresh

let latestCtx: ExtensionContext | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let sequence = 0;
const lastSuccess = new Map<string, number>();

async function refresh(ctx: ExtensionContext, force: boolean): Promise<RefreshResult> {
	const model = ctx.model;
	const fetcher = findFetcher(model);
	if (model === undefined || fetcher === undefined) {
		sequence++;
		showResult(ctx, { kind: "unsupported" });
		return { kind: "unsupported" };
	}
	const lastOk = lastSuccess.get(model.provider);
	if (!force && lastOk !== undefined && Date.now() - lastOk < THROTTLE_MS) return { kind: "skipped" };

	const seq = ++sequence;
	let result: RefreshResult;
	try {
		const windows = await fetcher.fetch(ctx, model, AbortSignal.timeout(TIMEOUT_MS));
		result = { kind: "ok", windows };
		lastSuccess.set(model.provider, Date.now());
	} catch (error) {
		result = { kind: "error", message: errorMessage(error) };
	}
	// The active model changed (or another refresh started) while this one was in flight.
	if (seq !== sequence) return { kind: "superseded" };
	showResult(ctx, result);
	return result;
}

function formatDetail(window: UsageWindow): string {
	return `${window.label} ${clampPercent(window.usedPercent)}% (${formatReset(window.resetsAt)})`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		if (timer === undefined) {
			timer = setInterval(() => {
				if (latestCtx !== undefined) void refresh(latestCtx, false);
			}, REFRESH_MS);
		}
		void refresh(ctx, true);
	});

	pi.on("model_select", (_event, ctx) => {
		latestCtx = ctx;
		void refresh(ctx, true);
	});

	pi.on("agent_end", (_event, ctx) => {
		latestCtx = ctx;
		void refresh(ctx, false);
	});

	pi.on("session_shutdown", () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		latestCtx = undefined;
	});

	pi.registerCommand("limits", {
		description: "Refresh subscription usage limits and show reset times for the active model",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			const result = await refresh(ctx, true);
			if (result.kind === "ok") {
				ctx.ui.notify(result.windows.map(formatDetail).join(" · "), "info");
			} else if (result.kind === "error") {
				ctx.ui.notify(`limits: ${result.message}`, "error");
			} else if (result.kind === "unsupported") {
				ctx.ui.notify("No usage limits available for the active model", "info");
			}
		},
	});
}

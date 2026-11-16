/**
 * Herdr subagent tool.
 *
 * Runs a child Pi in a herdr-core terminal and gives it a pane in the current
 * herdr-app tab:
 *   - the first subagent splits the parent pane to the right;
 *   - later subagents split the previous subagent pane down, so the right
 *     column stacks.
 *
 * The child is started through `hc run --bg`, which records this terminal as
 * its parent. `herdr-app do terminal.keep` is the only app command that turns
 * a hidden subagent terminal into a pane, and it places relative to the
 * focused pane, so pane allocation briefly focuses the target and restores
 * the previous focus afterwards.
 *
 * The child stays open after it settles: the launcher runs Pi and then execs
 * the login shell in the same terminal, so the pane keeps the transcript and
 * later subagents can split below it.
 *
 * To switch back to the tmux-based agent-stuff extension, exclude this file
 * (or remove it) and remove the `-extensions/subagent.ts` exclusion for
 * agent-stuff in settings.json.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CHILD_ENV = "PI_HERDR_SUBAGENT_CHILD";
const RESULT_ENV = "PI_HERDR_SUBAGENT_RESULT";
const RUNS_DIR = "herdr-subagents";
const POLL_INTERVAL_MS = 500;
const PANE_PREVIEW_LINES = 18;
const MAX_PARALLEL = 4;
const HERDR_TIMEOUT_MS = 10_000;
const PANE_SETTLE_TIMEOUT_MS = 5_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EXTENSION_PATH = fileURLToPath(import.meta.url);

type RunStatus = "queued" | "running" | "completed" | "failed";
type Direction = "right" | "down";

interface ChildResult {
	version: 1;
	status: "completed" | "failed";
	output: string;
	error?: string;
	stopReason?: string;
	sessionFile?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	finishedAt: number;
}

interface RunDetails {
	status: RunStatus;
	task: string;
	cwd: string;
	name: string;
	terminal: string;
	paneId?: string;
	pane?: string;
	focusCommand: string;
	captureCommand: string;
	killCommand: string;
	provider: string;
	model: string;
	thinking: string;
	output?: string;
	sessionFile?: string;
	startedAt?: number;
	finishedAt?: number;
}

interface RunSpec {
	task: string;
	cwd: string;
	name: string;
	childSessionId: string;
	resultPath: string;
	exitPath: string;
	promptPath: string;
	sessionDir: string;
	provider: string;
	model: string;
	thinking: string;
	trusted: boolean;
}

interface TerminalLocation {
	terminal: string;
	pane: string;
	spaceId?: string;
	tabId: string;
}

interface PanePlacement {
	pane: string;
	tabId?: string;
	pending: boolean;
}

interface Waiter {
	resolve: () => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function textFromAssistant(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string");
		})
		.map((part) => part.text)
		.join("\n");
}

function findLastAssistant(ctx: ExtensionContext): Record<string, unknown> | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message: unknown = entry.message;
		if (isRecord(message) && message.role === "assistant") return message;
	}
	return undefined;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, filePath);
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function parseChildResult(value: unknown): ChildResult | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (value.status !== "completed" && value.status !== "failed") return undefined;
	if (typeof value.output !== "string" || typeof value.finishedAt !== "number") return undefined;
	const result: ChildResult = {
		version: 1,
		status: value.status,
		output: value.output,
		finishedAt: value.finishedAt,
	};
	if (typeof value.error === "string") result.error = value.error;
	if (typeof value.stopReason === "string") result.stopReason = value.stopReason;
	if (typeof value.sessionFile === "string") result.sessionFile = value.sessionFile;
	if (typeof value.provider === "string") result.provider = value.provider;
	if (typeof value.model === "string") result.model = value.model;
	if (typeof value.thinking === "string") result.thinking = value.thinking;
	return result;
}

async function readChildResult(resultPath: string): Promise<ChildResult | undefined> {
	try {
		const text = await readFile(resultPath, "utf8");
		return parseChildResult(parseJson(text));
	} catch {
		return undefined;
	}
}

async function readExitCode(exitPath: string): Promise<number | undefined> {
	try {
		const text = (await readFile(exitPath, "utf8")).trim();
		if (!/^-?\d+$/.test(text)) return undefined;
		return Number.parseInt(text, 10);
	} catch {
		return undefined;
	}
}

function registerChildReporter(pi: ExtensionAPI, resultPath: string): void {
	let reported = false;

	const report = async (ctx: ExtensionContext, fallbackError?: string): Promise<void> => {
		if (reported) return;
		reported = true;

		const assistant = findLastAssistant(ctx);
		const stopReason = nonEmptyString(assistant?.stopReason);
		const assistantError = nonEmptyString(assistant?.errorMessage);
		const failed = !assistant || stopReason === "error" || stopReason === "aborted" || Boolean(fallbackError);
		const output = assistant ? textFromAssistant(assistant) : "";
		const thinking = assistant?.thinking;
		const result: ChildResult = {
			version: 1,
			status: failed ? "failed" : "completed",
			output,
			error:
				fallbackError ??
				assistantError ??
				(!assistant ? "Subagent exited without an assistant response." : undefined),
			stopReason,
			sessionFile: ctx.sessionManager.getSessionFile(),
			provider: nonEmptyString(assistant?.provider) ?? ctx.model?.provider,
			model: nonEmptyString(assistant?.model) ?? ctx.model?.id,
			thinking: typeof thinking === "string" ? thinking : pi.getThinkingLevel(),
			finishedAt: Date.now(),
		};

		try {
			await writeJsonAtomic(resultPath, result);
		} catch (error) {
			console.error(
				`[herdr-subagent] Failed to write result: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	pi.on("agent_settled", async (_event, ctx) => {
		await report(ctx);
		ctx.shutdown();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!reported) await report(ctx, "Subagent session shut down before the task settled.");
	});
}

function trimPane(output: string): string {
	const lines = output.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
	while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
	return lines.slice(-PANE_PREVIEW_LINES).join("\n");
}

function formatDuration(startedAt: number | undefined, finishedAt = Date.now()): string | undefined {
	if (startedAt === undefined) return undefined;
	const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error("Subagent aborted.");
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new Error("Subagent aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function validateCwd(cwd: string): Promise<void> {
	let info;
	try {
		info = await stat(cwd);
	} catch {
		throw new Error(`Subagent working directory does not exist: ${cwd}`);
	}
	if (!info.isDirectory()) throw new Error(`Subagent working directory is not a directory: ${cwd}`);
}

function isSameOrDescendant(base: string, candidate: string): boolean {
	const relative = path.relative(base, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveModel(
	ctx: ExtensionContext,
	providerOverride: string | undefined,
	modelOverride: string | undefined,
): { provider: string; model: string } {
	const explicitProvider = providerOverride?.trim();
	const explicitModel = modelOverride?.trim();
	let provider = explicitProvider || ctx.model?.provider || "";
	let model = explicitModel || ctx.model?.id || "";

	// A slash in an inherited id can be part of the id itself (for example,
	// OpenRouter's openai/gpt-* models). Only interpret an explicit model as
	// provider/model when no separate provider was supplied. If both are given
	// and the prefixes agree, accept the redundant canonical provider/model form.
	const slashIndex = explicitModel?.indexOf("/") ?? -1;
	if (explicitModel && slashIndex > 0) {
		const modelProvider = explicitModel.slice(0, slashIndex);
		if (!explicitProvider) {
			provider = modelProvider;
			model = explicitModel.slice(slashIndex + 1);
		} else if (explicitProvider === modelProvider) {
			model = explicitModel.slice(slashIndex + 1);
		}
	}

	if (!provider || !model) {
		throw new Error("No model is active. Pass both provider and model to the subagent tool.");
	}
	return { provider, model };
}

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return [process.execPath];
	}

	return ["pi"];
}

function detailCommands(terminal: string): Pick<RunDetails, "focusCommand" | "captureCommand" | "killCommand"> {
	if (!terminal) return { focusCommand: "", captureCommand: "", killCommand: "" };
	return {
		focusCommand: `herdr-app do agent.focus --terminal ${terminal}`,
		captureCommand: `hc read ${terminal} --lines 120`,
		killCommand: `hc kill ${terminal}; hc rm ${terminal}`,
	};
}

function detailsFor(spec: RunSpec, status: RunStatus, extra: Partial<RunDetails> = {}): RunDetails {
	const terminal = extra.terminal ?? "";
	return {
		status,
		task: spec.task,
		cwd: spec.cwd,
		name: spec.name,
		terminal,
		...detailCommands(terminal),
		provider: spec.provider,
		model: spec.model,
		thinking: spec.thinking,
		...extra,
	};
}

function partialText(details: RunDetails): string {
	const lines = [`Subagent ${details.status} in Herdr terminal ${details.terminal || details.name}.`];
	if (details.paneId) lines.push(`Pane: ${details.paneId}`);
	if (details.focusCommand) lines.push(`Focus: ${details.focusCommand}`);
	if (details.captureCommand) lines.push(`Capture: ${details.captureCommand}`);
	if (details.pane) lines.push("", details.pane);
	return lines.join("\n");
}

function truncateToolText(text: string): string {
	const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n\n[Output truncated. Full output is available in the child session file.]`;
}

function resultText(details: RunDetails): string {
	const duration = formatDuration(details.startedAt, details.finishedAt);
	const lines = [
		`Subagent ${details.status}${duration ? ` after ${duration}` : ""}.`,
		`Model: ${details.provider}/${details.model} (${details.thinking})`,
		`Herdr: ${details.terminal || details.name}${details.paneId ? ` (pane ${details.paneId})` : ""}`,
	];
	if (details.focusCommand) lines.push(`Focus: ${details.focusCommand}`);
	if (details.captureCommand) lines.push(`Capture: ${details.captureCommand}`);
	if (details.killCommand) lines.push(`Clean up: ${details.killCommand}`);
	if (details.sessionFile) lines.push(`Child session: ${details.sessionFile}`);
	if (details.output) lines.push("", details.output);
	return truncateToolText(lines.join("\n"));
}

function isRunDetails(value: unknown): value is RunDetails {
	if (!isRecord(value)) return false;
	return (
		typeof value.status === "string" &&
		typeof value.task === "string" &&
		typeof value.name === "string" &&
		typeof value.terminal === "string"
	);
}

function collectTerminalLocations(value: unknown): TerminalLocation[] {
	if (!isRecord(value) || !Array.isArray(value.spaces)) return [];
	const locations: TerminalLocation[] = [];
	for (const space of value.spaces) {
		if (!isRecord(space) || !Array.isArray(space.tabs)) continue;
		const spaceId = nonEmptyString(space.id);
		for (const tab of space.tabs) {
			if (!isRecord(tab) || !Array.isArray(tab.terminals)) continue;
			const tabId = nonEmptyString(tab.id);
			if (!tabId) continue;
			for (const terminal of tab.terminals) {
				if (!isRecord(terminal)) continue;
				const terminalId = nonEmptyString(terminal.terminal);
				const pane = nonEmptyString(terminal.pane);
				if (terminalId && pane) locations.push({ terminal: terminalId, pane, spaceId, tabId });
			}
		}
	}
	return locations;
}

function terminalSeen(value: unknown, terminalId: string): boolean {
	if (!isRecord(value) || !Array.isArray(value.spaces)) return false;
	for (const space of value.spaces) {
		if (!isRecord(space) || !Array.isArray(space.tabs)) continue;
		for (const tab of space.tabs) {
			if (!isRecord(tab) || !Array.isArray(tab.terminals)) continue;
			for (const terminal of tab.terminals) {
				if (!isRecord(terminal)) continue;
				if (terminal.terminal === terminalId) return true;
				if (Array.isArray(terminal.sub_agents) && terminal.sub_agents.includes(terminalId)) return true;
			}
		}
	}
	return false;
}

async function herdrApp(pi: ExtensionAPI, args: string[], timeout = HERDR_TIMEOUT_MS): Promise<string> {
	const result = await pi.exec("herdr-app", args, { timeout });
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		throw new Error(`herdr-app ${args.join(" ")} failed: ${detail}`);
	}
	return result.stdout;
}

async function herdrJson(pi: ExtensionAPI, args: string[]): Promise<unknown> {
	return parseJson(await herdrApp(pi, args));
}

async function herdrDo(pi: ExtensionAPI, command: string, payload: Record<string, unknown>): Promise<unknown> {
	return herdrJson(pi, ["do", command, JSON.stringify(payload)]);
}

async function focusPane(pi: ExtensionAPI, pane: string): Promise<void> {
	await herdrDo(pi, "pane.focus", { pane });
}

async function getFocusedPane(pi: ExtensionAPI): Promise<string | undefined> {
	const status = await herdrJson(pi, ["status"]);
	if (!isRecord(status)) return undefined;
	return nonEmptyString(status.focused_pane);
}

async function findOwnTerminal(pi: ExtensionAPI): Promise<TerminalLocation> {
	const terminalId = process.env.HC_TERMINAL_ID?.trim();
	if (!terminalId) {
		throw new Error("herdr-subagent requires herdr-app: HC_TERMINAL_ID is not set.");
	}
	const value = await herdrJson(pi, ["ls"]);
	const location = collectTerminalLocations(value).find((entry) => entry.terminal === terminalId);
	if (!location) {
		throw new Error(`Cannot find this terminal (${terminalId}) in herdr-app ls.`);
	}
	return location;
}

async function waitForTerminalSeen(
	pi: ExtensionAPI,
	terminalId: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	const deadline = Date.now() + PANE_SETTLE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Subagent aborted.");
		const value = await herdrJson(pi, ["ls"]);
		if (terminalSeen(value, terminalId)) return;
		await abortableDelay(150, signal);
	}
	throw new Error(`herdr-app did not report subagent terminal ${terminalId} within ${PANE_SETTLE_TIMEOUT_MS}ms.`);
}

async function waitForPaneSeen(pi: ExtensionAPI, paneId: string, signal: AbortSignal | undefined): Promise<void> {
	const deadline = Date.now() + PANE_SETTLE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Subagent aborted.");
		const value = await herdrJson(pi, ["ls"]);
		if (collectTerminalLocations(value).some((entry) => entry.pane === paneId)) return;
		await abortableDelay(100, signal);
	}
	throw new Error(`herdr-app did not show pane ${paneId} within ${PANE_SETTLE_TIMEOUT_MS}ms.`);
}

async function keepTerminal(pi: ExtensionAPI, terminal: string, direction: Direction): Promise<PanePlacement> {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			const value = await herdrDo(pi, "terminal.keep", { terminal, place: direction });
			if (!isRecord(value)) throw new Error(`Unexpected herdr-app reply: ${JSON.stringify(value)}`);
			const errorText = nonEmptyString(value.error);
			if (errorText) throw new Error(`herdr-app terminal.keep failed: ${errorText}`);
			const pane = nonEmptyString(value.pane);
			if (!pane) {
				throw new Error(`herdr-app did not return a pane for terminal ${terminal}: ${JSON.stringify(value)}`);
			}
			return { pane, tabId: nonEmptyString(value.tab), pending: value.pending === true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("no running terminal") || attempt === 9) throw error;
			await abortableDelay(150, undefined);
		}
	}
	throw new Error(`Could not place subagent terminal ${terminal}.`);
}

async function launchChild(pi: ExtensionAPI, spec: RunSpec): Promise<string> {
	const parentTerminal = process.env.HC_TERMINAL_ID?.trim();
	if (!parentTerminal) {
		throw new Error("herdr-subagent requires herdr-app: HC_TERMINAL_ID is not set.");
	}

	const piArgs = [
		...getPiInvocationParts(),
		"--provider",
		spec.provider,
		"--model",
		spec.model,
		"--thinking",
		spec.thinking,
		"--session-dir",
		spec.sessionDir,
		"--session-id",
		spec.childSessionId,
		"--name",
		spec.name,
		spec.trusted ? "--approve" : "--no-approve",
		"--extension",
		EXTENSION_PATH,
		`@${spec.promptPath}`,
	];
	const shell = process.env.SHELL?.trim() || "/bin/sh";
	const script = [
		"env",
		`${CHILD_ENV}=1`,
		`${RESULT_ENV}=${shellQuote(spec.resultPath)}`,
		piArgs.map(shellQuote).join(" "),
		"; __hc_status=$?",
		`; printf '%s\\n' "$__hc_status" > ${shellQuote(spec.exitPath)}`,
		"; printf '\\n[subagent finished; pane kept for inspection]\\n'",
		`; exec ${shellQuote(shell)} -i`,
	].join(" ");

	const result = await pi.exec(
		"hc",
		[
			"run",
			"--bg",
			"--json",
			"--name",
			spec.name,
			"--cwd",
			spec.cwd,
			"--parent",
			parentTerminal,
			"--no-notify",
			"--",
			"sh",
			"-c",
			script,
		],
		{ timeout: 15_000 },
	);
	if (result.code !== 0) {
		throw new Error(
			`Failed to start subagent terminal: ${result.stderr.trim() || result.stdout.trim() || `hc exited ${result.code}`}`,
		);
	}
	const value = parseJson(result.stdout);
	if (!isRecord(value)) throw new Error(`Unexpected hc run output: ${result.stdout.trim()}`);
	const terminal = nonEmptyString(value.address);
	if (!terminal) throw new Error(`hc did not report a terminal address: ${result.stdout.trim()}`);
	return terminal;
}

async function getTerminalState(pi: ExtensionAPI, terminal: string): Promise<string | undefined> {
	try {
		const value = await herdrJson(pi, ["get", terminal, "--json"]);
		if (!isRecord(value)) return undefined;
		return nonEmptyString(value.state);
	} catch {
		return undefined;
	}
}

async function readPaneText(pi: ExtensionAPI, terminal: string): Promise<string> {
	try {
		const result = await pi.exec("hc", ["read", terminal, "--lines", String(PANE_PREVIEW_LINES)], {
			timeout: 5_000,
		});
		if (result.code !== 0) return "";
		return trimPane(result.stdout);
	} catch {
		return "";
	}
}

async function terminateTerminal(pi: ExtensionAPI, terminal: string): Promise<void> {
	try {
		await pi.exec("hc", ["kill", terminal], { timeout: 5_000 });
	} catch {
		// The terminal may already be gone.
	}
	try {
		await pi.exec("hc", ["rm", terminal], { timeout: 5_000 });
	} catch {
		// The terminal may still be running or already removed.
	}
}

let activeSlots = 0;
const slotWaiters: Waiter[] = [];

function releaseSlot(): void {
	activeSlots--;
	const next = slotWaiters.shift();
	if (!next) return;
	if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
	activeSlots++;
	next.resolve();
}

async function acquireSlot(signal: AbortSignal | undefined, onQueued: () => void): Promise<() => void> {
	if (activeSlots < MAX_PARALLEL) {
		activeSlots++;
		return releaseSlot;
	}

	onQueued();
	await new Promise<void>((resolve, reject) => {
		const waiter: Waiter = { resolve, reject };
		const onAbort = () => {
			const index = slotWaiters.indexOf(waiter);
			if (index >= 0) slotWaiters.splice(index, 1);
			reject(new Error("Subagent aborted while waiting for a free slot."));
		};
		if (signal?.aborted) {
			reject(new Error("Subagent aborted while waiting for a free slot."));
			return;
		}
		waiter.signal = signal;
		waiter.onAbort = onAbort;
		signal?.addEventListener("abort", onAbort, { once: true });
		slotWaiters.push(waiter);
	});
	return releaseSlot;
}

let paneLock: Promise<void> = Promise.resolve();

function withPaneLock<T>(fn: () => Promise<T>): Promise<T> {
	const previous = paneLock;
	let release = () => {
		// Set by the promise constructor below.
	};
	paneLock = new Promise<void>((resolve) => {
		release = resolve;
	});
	return (async () => {
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	})();
}

export default function herdrSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[CHILD_ENV] === "1") {
		const resultPath = process.env[RESULT_ENV];
		if (!resultPath) {
			console.error(`[herdr-subagent] ${RESULT_ENV} is required in child mode.`);
			return;
		}
		registerChildReporter(pi, resultPath);
		return;
	}

	const activeTerminals = new Set<string>();

	pi.on("session_shutdown", async () => {
		const terminals = [...activeTerminals];
		activeTerminals.clear();
		for (const terminal of terminals) await terminateTerminal(pi, terminal);
	});

	let lastPane: { pane: string; tabId: string } | undefined;

	const placeSubagentPane = async (
		terminal: string,
		signal: AbortSignal | undefined,
	): Promise<PanePlacement> => {
		await waitForTerminalSeen(pi, terminal, signal);
		return withPaneLock(async () => {
			const parent = await findOwnTerminal(pi);
			const previousFocus = await getFocusedPane(pi);
			let target = parent;
			let direction: Direction = "right";

			if (lastPane) {
				const value = await herdrJson(pi, ["ls"]);
				const location = collectTerminalLocations(value).find((entry) => entry.pane === lastPane?.pane);
				if (location && location.tabId === parent.tabId) {
					target = location;
					direction = "down";
				} else {
					lastPane = undefined;
				}
			}

			if (target.pane !== previousFocus) {
				try {
					await focusPane(pi, target.pane);
				} catch (error) {
					if (direction !== "down") throw error;
					target = parent;
					direction = "right";
					await focusPane(pi, target.pane);
				}
			}

			const placement = await keepTerminal(pi, terminal, direction);
			if (placement.pending) {
				await waitForPaneSeen(pi, placement.pane, signal).catch(() => undefined);
			}
			lastPane = { pane: placement.pane, tabId: placement.tabId ?? target.tabId };

			const restorePane = previousFocus ?? parent.pane;
			if (restorePane !== placement.pane) {
				await focusPane(pi, restorePane).catch(() => undefined);
			}
			return placement;
		});
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run one delegated task in a separate interactive Pi process inside a Herdr pane. Calls run concurrently up to 4; extra calls queue. The first child splits this pane to the right, later children stack below in that right column. The child inherits the current provider, model, and thinking level unless overridden. Finished panes stay open as shell prompts for inspection. Output is capped at 50KB or 2000 lines; the complete child session is preserved on disk.",
		promptSnippet: "Run one delegated task in an observable, Herdr-backed Pi pane",
		promptGuidelines: [
			"Use subagent once per delegated task. Independent tasks can be sent in parallel; at most 4 children run at once and extra calls queue.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete task for the child Pi process" }),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project." })),
			provider: Type.Optional(Type.String({ description: "Provider override. Defaults to the current provider." })),
			model: Type.Optional(
				Type.String({ description: "Model id or provider/model override. Defaults to the current model." }),
			),
			thinking: Type.Optional(
				StringEnum(THINKING_LEVELS, {
					description: "Thinking level override. Defaults to the current thinking level.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.task.trim()) throw new Error("Subagent task must not be empty.");
			const cwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			const selectedModel = resolveModel(ctx, params.provider, params.model);
			const thinking = typeof params.thinking === "string" ? params.thinking : pi.getThinkingLevel();
			const childSessionId = randomUUID();
			const runDir = path.join(getAgentDir(), RUNS_DIR, ctx.sessionManager.getSessionId(), childSessionId);
			const spec: RunSpec = {
				task: params.task,
				cwd,
				name: `sub-${childSessionId.replace(/-/g, "").slice(0, 12)}`,
				childSessionId,
				resultPath: path.join(runDir, "result.json"),
				exitPath: path.join(runDir, "exit"),
				promptPath: path.join(runDir, "task.md"),
				sessionDir: path.join(runDir, "session"),
				provider: selectedModel.provider,
				model: selectedModel.model,
				thinking,
				trusted: isSameOrDescendant(path.resolve(ctx.cwd), cwd) && ctx.isProjectTrusted(),
			};

			const release = await acquireSlot(signal, () => {
				const details = detailsFor(spec, "queued");
				onUpdate?.({ content: [{ type: "text", text: "Waiting for a free subagent slot..." }], details });
			});
			let launchedTerminal: string | undefined;
			try {
				if (signal?.aborted) throw new Error("Subagent aborted.");
				await validateCwd(cwd);
				await mkdir(runDir, { recursive: true, mode: 0o700 });
				await mkdir(spec.sessionDir, { recursive: true, mode: 0o700 });
				await writeFile(spec.promptPath, `# Delegated task\n\n${params.task}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});

				const terminal = await launchChild(pi, spec);
				launchedTerminal = terminal;
				activeTerminals.add(terminal);
				const startedAt = Date.now();
				let placement: PanePlacement;
				try {
					placement = await placeSubagentPane(terminal, signal);
				} catch (error) {
					await terminateTerminal(pi, terminal);
					launchedTerminal = undefined;
					throw error;
				}

				const initialDetails = detailsFor(spec, "running", {
					terminal,
					paneId: placement.pane,
					startedAt,
				});
				onUpdate?.({ content: [{ type: "text", text: partialText(initialDetails) }], details: initialDetails });

				let lastPaneText = "";
				let childResult: ChildResult | undefined;
				while (!childResult) {
					if (signal?.aborted) throw new Error("Subagent aborted.");

					const result = await readChildResult(spec.resultPath);
					if (result) {
						childResult = result;
						break;
					}

					const exitCode = await readExitCode(spec.exitPath);
					if (exitCode !== undefined) {
						await abortableDelay(100, signal);
						const lateResult = await readChildResult(spec.resultPath);
						if (lateResult) {
							childResult = lateResult;
							break;
						}
						const pane = (await readPaneText(pi, terminal)) || lastPaneText;
						throw new Error(
							`Child Pi exited with code ${exitCode} before reporting a result.\n\n${pane || "No pane output."}\n\nCapture: ${detailsFor(spec, "running", { terminal }).captureCommand}`,
						);
					}

					if ((await getTerminalState(pi, terminal)) === "finished") {
						await abortableDelay(100, signal);
						const lateResult = await readChildResult(spec.resultPath);
						if (lateResult) {
							childResult = lateResult;
							break;
						}
						const pane = (await readPaneText(pi, terminal)) || lastPaneText;
						throw new Error(
							`Subagent terminal ${terminal} ended before reporting a result.\n\n${pane || "No pane output."}\n\nCapture: ${detailsFor(spec, "running", { terminal }).captureCommand}`,
						);
					}

					const pane = await readPaneText(pi, terminal);
					if (pane && pane !== lastPaneText) {
						lastPaneText = pane;
						const details = detailsFor(spec, "running", {
							terminal,
							paneId: placement.pane,
							pane,
							startedAt,
						});
						onUpdate?.({ content: [{ type: "text", text: partialText(details) }], details });
					}

					await abortableDelay(POLL_INTERVAL_MS, signal);
				}

				const finalPane = await readPaneText(pi, terminal);
				const status: RunStatus = childResult.status === "completed" ? "completed" : "failed";
				let rawOutput = childResult.output.trim();
				if (childResult.status === "failed" && childResult.error?.trim()) {
					rawOutput += `${rawOutput ? "\n\n" : ""}Error: ${childResult.error.trim()}`;
				}
				const output = truncateToolText(rawOutput || "(no text output)");
				const details = detailsFor(spec, status, {
					terminal,
					paneId: placement.pane,
					pane: finalPane || lastPaneText,
					output,
					sessionFile: childResult.sessionFile,
					provider: childResult.provider ?? spec.provider,
					model: childResult.model ?? spec.model,
					thinking: childResult.thinking ?? spec.thinking,
					startedAt,
					finishedAt: childResult.finishedAt,
				});

				if (childResult.status === "failed") {
					throw new Error(resultText(details));
				}
				return {
					content: [{ type: "text", text: resultText(details) }],
					details,
				};
			} catch (error) {
				if (signal?.aborted && launchedTerminal) {
					await terminateTerminal(pi, launchedTerminal).catch(() => undefined);
				}
				throw error;
			} finally {
				if (launchedTerminal) activeTerminals.delete(launchedTerminal);
				release();
			}
		},

		renderCall(args, theme) {
			const task = args.task?.trim() || "...";
			const firstLine = task.split("\n", 1)[0] ?? task;
			const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("dim", preview);
			const overrides = [args.provider, args.model, args.thinking].filter(Boolean);
			if (overrides.length > 0) text += `\n  ${theme.fg("muted", overrides.join(" · "))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = isRunDetails(result.details) ? result.details : undefined;
			if (!details) {
				const content = result.content.find((part) => part.type === "text");
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}

			const running = isPartial || details.status === "queued" || details.status === "running";
			const icon = running
				? theme.fg("warning", details.status === "queued" ? "◦" : "●")
				: details.status === "completed"
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
			const duration = formatDuration(details.startedAt, details.finishedAt);
			const title = details.terminal || details.name;
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(title))}`;
			text += theme.fg("muted", ` · ${details.status}${duration ? ` · ${duration}` : ""}`);
			if (details.focusCommand) text += `\n  ${theme.fg("accent", details.focusCommand)}`;
			text += `\n  ${theme.fg("dim", `${details.provider}/${details.model} (${details.thinking})`)}`;

			if (running && details.pane) {
				const paneLines = details.pane.split("\n");
				const visible = expanded ? paneLines : paneLines.slice(-8);
				text += `\n\n${visible.map((line) => theme.fg("dim", line)).join("\n")}`;
			} else if (!running && details.output) {
				const outputLines = details.output.split("\n");
				const visible = expanded ? outputLines : outputLines.slice(0, 8);
				text += `\n\n${visible.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
				if (!expanded && outputLines.length > visible.length) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				text += `\n\n  ${theme.fg("dim", `capture: ${details.captureCommand}`)}`;
				text += `\n  ${theme.fg("dim", `cleanup: ${details.killCommand}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Orchestrator mode.
 *
 * Orchestrator mode is on by default in every session. An explicit "off" is persisted per session.
 *
 * /orchestrator                      picker: enable/disable, or choose the session subagent model
 *                                    (choosing a model also enables the mode)
 * /orchestrator on | off | status
 * /orchestrator model [provider/id]  set the subagent model for this session (no arg: picker)
 * /orchestrator model reset          drop the session override, use the global default
 * /orchestrator default [provider/id] set the global default subagent model (no arg: picker)
 *
 * The global default lives in <agentDir>/orchestrator.json. Session state (enabled flag and
 * model override) is stored as custom session entries, so it follows the branch and resumes.
 */

type ModelRef = { provider: string; model: string };
type SessionState = { enabled: boolean; override: ModelRef | undefined };
type SubagentInput = { task: string; cwd?: string; provider?: string; model?: string; thinking?: string };

const STATE_ENTRY = "orchestrator-state";
const STATUS_KEY = "orchestrator";
const SECTION_KEY = "orchestrator_mode";
const CONFIG_PATH = join(getAgentDir(), "orchestrator.json");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModelRef(value: unknown): ModelRef | undefined {
	if (!isRecord(value)) return undefined;
	const { provider, model } = value;
	if (typeof provider !== "string" || typeof model !== "string" || !provider || !model) return undefined;
	return { provider, model };
}

function formatRef(ref: ModelRef): string {
	return `${ref.provider}/${ref.model}`;
}

function parseRefArg(arg: string): ModelRef {
	const slash = arg.indexOf("/");
	if (slash <= 0 || slash === arg.length - 1) {
		throw new Error(`Expected "provider/model", got "${arg}"`);
	}
	return { provider: arg.slice(0, slash), model: arg.slice(slash + 1) };
}

function readDefault(): ModelRef | undefined {
	if (!existsSync(CONFIG_PATH)) return undefined;
	const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	const ref = isRecord(parsed) ? parseModelRef(parsed.defaultSubagentModel) : undefined;
	if (!ref) throw new Error(`${CONFIG_PATH} is invalid: expected { "defaultSubagentModel": { "provider", "model" } }`);
	return ref;
}

function writeDefault(ref: ModelRef): void {
	writeFileSync(CONFIG_PATH, `${JSON.stringify({ defaultSubagentModel: ref }, null, 2)}\n`);
}

function readSessionState(ctx: ExtensionContext): SessionState {
	let state: SessionState = { enabled: true, override: undefined };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY || !isRecord(entry.data)) continue;
		state = {
			enabled: entry.data.enabled === true,
			override: parseModelRef(entry.data.override),
		};
	}
	return state;
}

function validateModel(ctx: ExtensionContext, ref: ModelRef): void {
	if (!ctx.modelRegistry.find(ref.provider, ref.model)) {
		throw new Error(`Unknown model ${formatRef(ref)}. Check /model for available provider/model ids.`);
	}
}

function instructions(ref: ModelRef): string {
	return `You are in ORCHESTRATOR MODE. You own the plan, the quality bar, and the final answer; a subagent does the implementation.

Role split
- You: understand the request, explore the code, plan, write task briefs, review results, make small fixes, report to the user.
- Implementer: a subagent (model ${formatRef(ref)}) that writes the code, runs the build and tests, and reports back.
- Do not implement non-trivial changes yourself before delegating. Spend your own context on planning and review.

Delegation
- Use the \`subagent\` tool. The provider and model are enforced as ${formatRef(ref)} automatically; you do not need to pass them.
- One subagent call per coherent unit of work. Calls run one at a time; split large work into sequential tasks instead of asking one child to orchestrate others.
- Set \`cwd\` when the work lives outside the current project.

Task brief (the child cannot see this conversation), always include:
1. Goal: what to change and why.
2. Context: relevant file paths, functions, types, conventions, and what you already learned.
3. Scope: files and areas it may touch, and what it must not touch.
4. Constraints: the project rules from AGENTS.md / context files, restated explicitly.
5. Acceptance criteria: concrete checks plus the exact build, lint, and test commands.
6. Report format: changed files, short summary, command output (pass or fail), open questions and deviations.

Review (required after every delegation)
- Do not trust the child's summary. Read the actual diff and changed files, and re-run the build, typecheck, and tests yourself.
- Check against the acceptance criteria, project rules, scope creep, edge cases, and error handling.

Feedback vs. self-fix
- Fix it yourself when the issue is small and local (a few lines, a typo, a missing import, a type annotation, a wrong condition).
- Send it back with a new subagent call when the issue is substantive (wrong approach, missing functionality, many files, failing tests that need investigation). Include the original brief, what is wrong with file and line references, and what correct looks like.
- If the same task fails review twice, take it over yourself or re-plan with a smaller, more explicit brief.
- If review uncovers an ambiguity or design decision the request did not settle, ask the user. Do not let the child guess.

Finish
- Report concisely: what was done and by whom (subagent vs. your fixes), verification results, and any remaining issues or decisions for the user.`;
}

export default function (pi: ExtensionAPI) {
	let state: SessionState = { enabled: true, override: undefined };

	const effectiveModel = (): ModelRef => {
		if (state.override) return state.override;
		const fallback = readDefault();
		if (!fallback) {
			throw new Error(`No subagent model configured. Run "/orchestrator default provider/model" first.`);
		}
		return fallback;
	};

	const refreshStatus = (ctx: ExtensionContext) => {
		if (!state.enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const ref = effectiveModel();
		const suffix = state.override ? " (session)" : "";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `orchestrator → ${formatRef(ref)}${suffix}`));
	};

	const persist = (ctx: ExtensionContext, next: SessionState) => {
		state = next;
		pi.appendEntry(STATE_ENTRY, { enabled: next.enabled, override: next.override });
		refreshStatus(ctx);
	};

	const pickModel = async (ctx: ExtensionCommandContext, title: string): Promise<ModelRef | undefined> => {
		if (!ctx.hasUI) throw new Error("No model given and no UI available for a picker. Pass provider/model.");
		const options = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
		if (options.length === 0) throw new Error("No available models with configured authentication.");
		const choice = await ctx.ui.select(title, options);
		return choice ? parseRefArg(choice) : undefined;
	};

	const restore = (ctx: ExtensionContext) => {
		state = readSessionState(ctx);
		refreshStatus(ctx);
	};
	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	pi.on("before_agent_start", async (event) => {
		const sections = event.systemPromptOptions.sections;
		if (state.enabled) {
			sections[SECTION_KEY] = instructions(effectiveModel());
		} else {
			delete sections[SECTION_KEY];
		}
	});

	pi.on("tool_call", async (event) => {
		if (!state.enabled) return;
		if (!isToolCallEventType<"subagent", SubagentInput>("subagent", event)) return;
		const ref = effectiveModel();
		event.input.provider = ref.provider;
		event.input.model = ref.model;
	});

	pi.registerCommand("orchestrator", {
		description: "Enable/disable orchestrator mode or pick its subagent model (no args: picker; on|off|status|model|default)",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off", "status", "model", "model reset", "default"]
				.filter((v) => v.startsWith(prefix))
				.map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");

			const enable = (enabled: boolean) => {
				if (enabled) {
					effectiveModel(); // throws if nothing is configured
					if (!pi.getActiveTools().includes("subagent") && !pi.getAllTools().some((t) => t.name === "subagent")) {
						ctx.ui.notify("Warning: no `subagent` tool is available in this session.", "warning");
					}
				}
				persist(ctx, { ...state, enabled });
				ctx.ui.notify(
					enabled ? `Orchestrator mode on (subagent: ${formatRef(effectiveModel())})` : "Orchestrator mode off",
					"info",
				);
			};

			switch (sub) {
				case "": {
					if (!ctx.hasUI) throw new Error("No UI available for the picker. Use on, off, status, model, or default.");
					const current = state.override ?? readDefault();
					const toggleLabel = state.enabled ? "Disable orchestrator" : "Enable orchestrator";
					const modelOptions = new Map<string, ModelRef>();
					for (const m of ctx.modelRegistry.getAvailable()) {
						const ref = { provider: m.provider, model: m.id };
						const isCurrent = current !== undefined && current.provider === ref.provider && current.model === ref.model;
						modelOptions.set(`${formatRef(ref)}${isCurrent ? " (current)" : ""}`, ref);
					}
					const title = state.enabled
						? `Orchestrator on (subagent: ${current ? formatRef(current) : "not set"})`
						: "Orchestrator off";
					const choice = await ctx.ui.select(title, [toggleLabel, ...modelOptions.keys()]);
					if (!choice) return;
					if (choice === toggleLabel) return enable(!state.enabled);
					const ref = modelOptions.get(choice);
					if (!ref) throw new Error(`Unexpected picker choice "${choice}"`);
					persist(ctx, { enabled: true, override: ref });
					ctx.ui.notify(`Orchestrator mode on (session subagent: ${formatRef(ref)})`, "info");
					return;
				}
				case "on":
					return enable(true);
				case "off":
					return enable(false);
				case "status": {
					const fallback = readDefault();
					ctx.ui.notify(
						[
							`Orchestrator: ${state.enabled ? "on" : "off"}`,
							`Session override: ${state.override ? formatRef(state.override) : "none"}`,
							`Global default: ${fallback ? formatRef(fallback) : "not set"}`,
						].join("\n"),
						"info",
					);
					return;
				}
				case "model": {
					if (arg === "reset") {
						persist(ctx, { ...state, override: undefined });
						const fallback = readDefault();
						ctx.ui.notify(`Session override cleared (default: ${fallback ? formatRef(fallback) : "not set"})`, "info");
						return;
					}
					const ref = arg ? parseRefArg(arg) : await pickModel(ctx, "Subagent model for this session");
					if (!ref) return;
					validateModel(ctx, ref);
					persist(ctx, { ...state, override: ref });
					ctx.ui.notify(`Session subagent model: ${formatRef(ref)}`, "info");
					return;
				}
				case "default": {
					const ref = arg ? parseRefArg(arg) : await pickModel(ctx, "Global default subagent model");
					if (!ref) return;
					validateModel(ctx, ref);
					writeDefault(ref);
					refreshStatus(ctx);
					ctx.ui.notify(`Global default subagent model: ${formatRef(ref)}`, "info");
					return;
				}
				default:
					throw new Error(`Unknown subcommand "${sub}". Use on, off, status, model, or default.`);
			}
		},
	});
}

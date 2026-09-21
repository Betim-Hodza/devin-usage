/**
 * devin-usage — account plan/quota/credit usage for the Devin provider.
 *
 * Ported from oh-my-pi's `packages/ai/src/usage/devin.ts`. Devin ships no REST
 * usage endpoint; everything comes from one unary Connect RPC that the native
 * CLI issues at startup:
 *
 *   POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus
 *   Content-Type: application/proto
 *   Connect-Protocol-Version: 1
 *   Body: raw (unframed) GetUserStatusRequest protobuf
 *
 * The backend gates the response on the Metadata identity tuple — it must
 * announce itself as the released Devin CLI ("chisel" client), not the
 * Windsurf identity pi-devin-auth uses for chat:
 *
 *   ide_name "devin-cli", ide_type "chisel", ide_version "3000.6.2",
 *   extension_name "chisel", extension_version "3000.6.2"
 *
 * Adds:
 *   /devin-usage            — full report as a transcript card + footer summary
 *   session_start           — refreshes the footer status (best effort)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { gunzipSync } from "node:zlib";

// ── minimal proto wire helpers (same hand-rolled approach as pi-devin-auth) ──

function encodeVarint(value: number | bigint): Buffer {
	let v = BigInt(value);
	if (v < 0n) v = BigInt.asUintN(64, v); // int64 two's-complement
	const bytes: number[] = [];
	while (v > 127n) {
		bytes.push(Number(v & 0x7fn) | 0x80);
		v >>= 7n;
	}
	bytes.push(Number(v));
	return Buffer.from(bytes);
}

function encodeString(fieldNum: number, s: string): Buffer {
	const buf = Buffer.from(s, "utf8");
	return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(buf.length), buf]);
}

interface ProtoField {
	num: number;
	wire: number;
	value: bigint | Buffer;
}

function decodeVarint(buf: Buffer, offset: number): [bigint, number] {
	let res = 0n;
	let shift = 0n;
	let i = offset;
	while (i < buf.length) {
		const b = buf[i++];
		res |= BigInt(b & 0x7f) << shift;
		if (!(b & 0x80)) return [res, i];
		shift += 7n;
	}
	throw new Error("truncated varint");
}

function* iterFields(buf: Buffer): Generator<ProtoField> {
	let i = 0;
	while (i < buf.length) {
		const [tagBig, ai] = decodeVarint(buf, i);
		i = ai;
		const num = Number(tagBig >> 3n);
		const wire = Number(tagBig & 7n);
		if (wire === 0) {
			const [v, bi] = decodeVarint(buf, i);
			i = bi;
			yield { num, wire, value: v };
		} else if (wire === 1) {
			if (i + 8 > buf.length) return;
			yield { num, wire, value: buf.subarray(i, i + 8) };
			i += 8;
		} else if (wire === 2) {
			const [n, ci] = decodeVarint(buf, i);
			i = ci;
			const len = Number(n);
			if (len < 0 || i + len > buf.length) return;
			yield { num, wire, value: buf.subarray(i, i + len) };
			i += len;
		} else if (wire === 5) {
			if (i + 4 > buf.length) return;
			yield { num, wire, value: buf.subarray(i, i + 4) };
			i += 4;
		} else {
			return;
		}
	}
}

function field(buf: Buffer, num: number, wire: number): ProtoField | undefined {
	for (const f of iterFields(buf)) if (f.num === num && f.wire === wire) return f;
	return undefined;
}
const fieldMsg = (buf: Buffer, num: number) => field(buf, num, 2)?.value as Buffer | undefined;
const fieldStr = (buf: Buffer, num: number) => fieldMsg(buf, num)?.toString("utf8");
/** Signed decode: proto int32/int64 negatives arrive sign-extended to 64 bits. */
const fieldInt = (buf: Buffer, num: number) => {
	const f = field(buf, num, 0);
	return f ? Number(BigInt.asIntN(64, f.value as bigint)) : undefined;
};
const fieldBool = (buf: Buffer, num: number) => {
	const v = fieldInt(buf, num);
	return v === undefined ? undefined : v !== 0;
};
const fieldFloat = (buf: Buffer, num: number) => {
	const f = field(buf, num, 5);
	return f ? (f.value as Buffer).readFloatLE(0) : undefined;
};
/** All length-delimited occurrences of `num` (repeated message fields). */
const fieldMsgs = (buf: Buffer, num: number) =>
	[...iterFields(buf)].filter(f => f.num === num && f.wire === 2).map(f => f.value as Buffer);

// ── Devin RPC ────────────────────────────────────────────────────────────────

const HOST = "https://server.codeium.com";
const PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const TOKEN_PREFIX = "devin-session-token$";

function osString(): string {
	switch (process.platform) {
		case "darwin": return "darwin";
		case "win32": return "windows";
		default: return "linux";
	}
}

/** Metadata message carrying the released-CLI ("chisel") identity. */
function buildCliMetadata(apiKey: string): Buffer {
	const token = apiKey.startsWith(TOKEN_PREFIX) ? apiKey : `${TOKEN_PREFIX}${apiKey}`;
	return Buffer.concat([
		encodeString(1, "devin-cli"),      // ide_name
		encodeString(28, "chisel"),        // ide_type — unlocks the CLI surface
		encodeString(7, "3000.6.2"),       // ide_version
		encodeString(12, "chisel"),        // extension_name
		encodeString(2, "3000.6.2"),       // extension_version
		encodeString(3, token),            // api_key (scheme prefix required)
		encodeString(4, "en"),             // locale
		encodeString(5, osString()),       // os
	]);
}

/** google.protobuf.Timestamp → epoch ms; undefined when the field is absent. */
function timestampMs(buf?: Buffer): number | undefined {
	if (!buf) return undefined;
	let seconds = 0n, nanos = 0n;
	for (const f of iterFields(buf)) {
		if (f.num === 1 && f.wire === 0) seconds = f.value as bigint;
		if (f.num === 2 && f.wire === 0) nanos = f.value as bigint;
	}
	return Number(seconds) * 1000 + Number(nanos) / 1e6;
}

const TEAMS_TIER: Record<number, string> = {
	1: "Teams", 2: "Pro", 3: "Enterprise Saas", 4: "Hybrid", 5: "Enterprise Self Hosted",
	6: "Waitlist Pro", 7: "Teams Ultimate", 9: "Trial", 10: "Enterprise Self Serve",
	12: "Devin Enterprise", 14: "Devin Teams", 15: "Devin Teams V2", 16: "Devin Pro",
	17: "Devin Max", 18: "Max", 19: "Devin Free", 20: "Devin Trial",
};

interface UsageReport {
	email?: string;
	userId?: string;
	orgName?: string;
	orgId?: string;
	planName?: string;
	billingStrategy?: number;
	planStartMs?: number;
	planEndMs?: number;
	prompt?: { limit: number; used: number; available: number };
	flow?: { limit: number; used: number; available: number };
	flex?: { limit: number; used: number; available: number };
	dailyQuotaPercent?: number;   // remaining 0..100
	dailyResetUnix?: number;
	weeklyQuotaPercent?: number;
	weeklyResetUnix?: number;
	overageUsd?: number;
	models?: ModelCost[];
}

interface ModelCost {
	label: string;
	uid: string;
	creditMultiplier?: number;
	pricingType?: number;   // ModelPricingType enum
	costTier?: number;      // ModelCostTier enum
	premium: boolean;
	disabled: boolean;
	/** Set when this is the session's active model. */
	active?: boolean;
}

const PRICING_TYPE: Record<number, string> = {
	1: "static-credit", 2: "api", 3: "byok", 4: "acu-token", 5: "acu-credit",
};
const COST_TIER: Record<number, string> = { 1: "low", 2: "medium", 3: "high", 4: "free" };

/** user_status.cascade_model_config_data (field 33) → client_model_configs (field 1). */
function parseModelConfigs(userStatusBuf: Buffer): ModelCost[] {
	const data = fieldMsg(userStatusBuf, 33);
	if (!data) return [];
	const out: ModelCost[] = [];
	for (const cfg of fieldMsgs(data, 1)) {
		const label = fieldStr(cfg, 1)?.trim();
		const uid = fieldStr(cfg, 22)?.trim();
		if (!label && !uid) continue;
		out.push({
			label: label || uid || "?",
			uid: uid || "?",
			creditMultiplier: fieldFloat(cfg, 3),
			pricingType: fieldInt(cfg, 13),
			costTier: fieldInt(cfg, 24),
			premium: fieldBool(cfg, 7) === true,
			disabled: fieldBool(cfg, 4) === true,
		});
	}
	return out;
}

async function fetchDevinUsage(apiKey: string): Promise<UsageReport> {
	const cliMetadata = buildCliMetadata(apiKey);
	const body = Buffer.concat([encodeVarint((1 << 3) | 2), encodeVarint(cliMetadata.length), cliMetadata]);
	const res = await fetch(`${HOST}${PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		},
		body,
	});
	if (!res.ok) throw new Error(`GetUserStatus failed: HTTP ${res.status}`);

	let payload = Buffer.from(await res.arrayBuffer());
	// Edges sometimes return gzipped protobuf — detect via magic bytes, since
	// parsing gzip as proto yields no fields (and thus no throw to catch).
	if (payload[0] === 0x1f && payload[1] === 0x8b) payload = gunzipSync(payload);
	const userStatusBuf = fieldMsg(payload, 1);
	const planInfoBuf = fieldMsg(payload, 2);
	if (!userStatusBuf) throw new Error("GetUserStatus: empty user_status in response");

	const report: UsageReport = {};
	report.email = fieldStr(userStatusBuf, 7)?.trim() || undefined;
	report.userId = fieldStr(userStatusBuf, 36)?.trim() || undefined;
	const userTier = fieldInt(userStatusBuf, 10);

	report.models = parseModelConfigs(userStatusBuf);

	const planStatusBuf = fieldMsg(userStatusBuf, 13);
	// PlanInfo: response field 2 is authoritative; plan_status field 1 is a fallback copy.
	const planBuf = planInfoBuf ?? (planStatusBuf ? fieldMsg(planStatusBuf, 1) : undefined);
	if (planBuf) {
		const tier = fieldInt(planBuf, 1);
		report.planName =
			fieldStr(planBuf, 2)?.trim() ||
			(tier !== undefined ? TEAMS_TIER[tier] : undefined) ||
			(userTier !== undefined ? TEAMS_TIER[userTier] : undefined);
		report.billingStrategy = fieldInt(planBuf, 35);
		const devinInfo = fieldMsg(planBuf, 33);
		if (devinInfo) {
			report.orgId = fieldStr(devinInfo, 4)?.trim() || undefined;
			report.orgName = fieldStr(devinInfo, 8)?.trim() || undefined;
		}
		if (!report.orgId) report.orgId = fieldStr(userStatusBuf, 5)?.trim() || undefined;

		if (planStatusBuf) {
			report.planStartMs = timestampMs(fieldMsg(planStatusBuf, 2));
			report.planEndMs = timestampMs(fieldMsg(planStatusBuf, 3));
			// -1 means the plan grants no bucket / unlimited — normalize to 0.
			const nn = (v: number | undefined) => (v !== undefined && v > 0 ? v : 0);
			const mk = (limit: number | undefined, used?: number, avail?: number) =>
				({ limit: nn(limit), used: nn(used), available: nn(avail) });
			report.prompt = mk(fieldInt(planBuf, 12), fieldInt(planStatusBuf, 6), fieldInt(planStatusBuf, 8));
			report.flow = mk(fieldInt(planBuf, 13), fieldInt(planStatusBuf, 5), fieldInt(planStatusBuf, 9));
			report.flex = mk(fieldInt(planBuf, 14), fieldInt(planStatusBuf, 7), fieldInt(planStatusBuf, 4));

			const dailyP = fieldInt(planStatusBuf, 14);
			const weeklyP = fieldInt(planStatusBuf, 15);
			const dailyReset = fieldInt(planStatusBuf, 17) ?? 0;
			const weeklyReset = fieldInt(planStatusBuf, 18) ?? 0;
			const hideDaily = fieldBool(planBuf, 36) === true;
			const hideWeekly = fieldBool(planBuf, 37) === true;
			const isQuotaPlan = report.billingStrategy === 2; // BillingStrategy.QUOTA
			// Credit plans leave percents at proto defaults — only surface when
			// server-dated or explicitly quota-billed (omp's devinQuotaApplies).
			if (!hideDaily && dailyP !== undefined && (dailyReset > 0 || isQuotaPlan)) {
				report.dailyQuotaPercent = Math.max(0, Math.min(100, dailyP));
				report.dailyResetUnix = dailyReset;
			}
			if (!hideWeekly && weeklyP !== undefined && (weeklyReset > 0 || isQuotaPlan)) {
				report.weeklyQuotaPercent = Math.max(0, Math.min(100, weeklyP));
				report.weeklyResetUnix = weeklyReset;
			}
			const overageMicros = fieldInt(planStatusBuf, 16) ?? 0;
			if (overageMicros !== 0) report.overageUsd = overageMicros / 1_000_000;
		}
	} else if (userTier !== undefined) {
		report.planName = TEAMS_TIER[userTier];
	}
	return report;
}

// ── formatting (styled after omp's /usage provider cards) ───────────────────

type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

function usageStatus(usedFraction: number | undefined): UsageStatus {
	if (usedFraction === undefined) return "unknown";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

type Theme = { fg(c: string, t: string): string };

const STATUS_RANK: Record<UsageStatus, number> = { unknown: 0, ok: 1, warning: 2, exhausted: 3 };

const statusColor = (s: UsageStatus) => (s === "exhausted" ? "error" : s === "warning" ? "warning" : "success");

/** Compact duration like omp's formatDuration: "30m", "2h30m", "3d2h". */
function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0m";
	const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
	if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
	if (ms < DAY) {
		const h = Math.floor(ms / HOUR), m = Math.floor((ms % HOUR) / MIN);
		return m > 0 ? `${h}h${m}m` : `${h}h`;
	}
	const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR);
	return h > 0 ? `${d}d${h}h` : `${d}d`;
}

interface CardRow {
	label: string;
	/** 0..1 used; undefined → no fraction, show usedText instead. */
	fraction?: number;
	status: UsageStatus;
	resetMs?: number;
	usedText?: string;
}

/** Normalize a UsageReport into omp-style card rows (sorted most-pressing first). */
function cardRows(r: UsageReport, nowMs: number): CardRow[] {
	const rows: CardRow[] = [];
	for (const { label, pct, reset } of [
		{ label: "Daily", pct: r.dailyQuotaPercent, reset: r.dailyResetUnix },
		{ label: "Weekly", pct: r.weeklyQuotaPercent, reset: r.weeklyResetUnix },
	]) {
		if (pct === undefined) continue;
		const fraction = 1 - pct / 100;
		const resetMs = reset && reset * 1000 > nowMs ? reset * 1000 - nowMs : undefined;
		rows.push({ label, fraction, status: usageStatus(fraction), resetMs });
	}
	const credits: [string, UsageReport["prompt"]][] = [
		["Prompt credits", r.prompt],
		["Flow credits", r.flow],
		["Flex credits", r.flex],
	];
	for (const [label, b] of credits) {
		if (!b || (b.limit === 0 && b.used === 0 && b.available === 0)) continue;
		if (b.limit > 0) {
			const fraction = b.used / b.limit;
			const resetMs = r.planEndMs && r.planEndMs > nowMs ? r.planEndMs - nowMs : undefined;
			rows.push({
				label, fraction, status: usageStatus(fraction), resetMs,
				usedText: `${b.available.toLocaleString()} left`,
			});
		} else {
			rows.push({ label, status: "unknown", usedText: `${b.available.toLocaleString()} left` });
		}
	}
	rows.sort((a, b) => (b.fraction ?? -1) - (a.fraction ?? -1));
	return rows;
}

const LABEL_W = 14;
const BAR_W = 20;

function miniBar(fraction: number, status: UsageStatus, theme: Theme): string {
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const filled = Math.round(clamped * BAR_W);
	return theme.fg(statusColor(status), "█".repeat(filled)) + theme.fg("dim", "░".repeat(BAR_W - filled));
}

function rowLine(row: CardRow, theme: Theme): string {
	const label = theme.fg("muted", row.label.padEnd(LABEL_W));
	if (row.fraction === undefined) {
		return `  ${label} ${theme.fg("dim", row.usedText ?? "no data")}`;
	}
	const freePct = Math.max(0, Math.round((1 - row.fraction) * 100));
	const pct = theme.fg(statusColor(row.status), `${freePct}% free`.padStart(7));
	const reset = row.resetMs !== undefined ? theme.fg("dim", `  ${formatDuration(row.resetMs)}`) : "";
	return `  ${label} ${miniBar(row.fraction, row.status, theme)} ${pct}${reset}`;
}

function fmtDate(ms?: number): string {
	return ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "?";
}

function statusSummary(r: UsageReport): string {
	const parts: string[] = [];
	if (r.planName) parts.push(r.planName);
	if (r.dailyQuotaPercent !== undefined) parts.push(`day ${r.dailyQuotaPercent}%`);
	if (r.weeklyQuotaPercent !== undefined) parts.push(`wk ${r.weeklyQuotaPercent}%`);
	if (r.prompt && r.prompt.limit > 0) parts.push(`credits ${r.prompt.available}/${r.prompt.limit}`);
	return parts.length ? `devin: ${parts.join(" · ")}` : "";
}

// ── extension ────────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI): Promise<void> {
	let lastReport: UsageReport | undefined;

	pi.registerEntryRenderer("devin-usage", (entry, _opts, theme) => {
		const r = entry.data as UsageReport;
		const now = Date.now();
		const rows = cardRows(r, now);
		const worst = rows.reduce<UsageStatus>((w, row) => (STATUS_RANK[row.status] > STATUS_RANK[w] ? row.status : w), "unknown");
		const dotColor = worst === "unknown" ? "dim" : statusColor(worst);

		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		const title = theme.bold(`Devin${r.planName ? ` · ${r.planName}` : ""}`);
		const who = [r.email, r.orgName].filter(Boolean).join(" · ");
		box.addChild(new Text(`${theme.fg(dotColor, "●")} ${title}${who ? theme.fg("dim", `  ${who}`) : ""}`));
		for (const row of rows) box.addChild(new Text(rowLine(row, theme)));
		if (rows.length === 0) box.addChild(new Text(theme.fg("dim", "  no limits reported")));

		const meta: string[] = [];
		if (r.planStartMs || r.planEndMs) meta.push(`plan ${fmtDate(r.planStartMs)} → ${fmtDate(r.planEndMs)}`);
		if (r.overageUsd) meta.push(`overage $${r.overageUsd.toFixed(2)}`);
		if (meta.length) box.addChild(new Text(theme.fg("dim", `  ${meta.join("  ·  ")}`)));
		return box;
	});

	pi.registerEntryRenderer("devin-models", (entry, _opts, theme) => {
		const models = (entry.data as UsageReport).models ?? [];
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.bold("Devin model cost")));
		if (models.length === 0) {
			box.addChild(new Text(theme.fg("dim", "  no model configs in response")));
			return box;
		}
		box.addChild(new Text(theme.fg("dim", "  burn rate vs 1× — lower is cheaper")));
		const sorted = [...models].sort((a, b) => (a.creditMultiplier ?? 99) - (b.creditMultiplier ?? 99));
		const nameW = Math.min(34, Math.max(...sorted.map(m => m.label.length)) + 1);
		for (const m of sorted) {
			const label = m.active ? `${m.label} ←` : m.label;
			const name = theme.fg(m.active ? "accent" : "muted", label.padEnd(nameW));
			const mult = m.creditMultiplier !== undefined
				? theme.fg(m.creditMultiplier <= 0.5 ? "success" : m.creditMultiplier <= 1.5 ? "warning" : "error",
					`×${m.creditMultiplier.toFixed(2).replace(/\.?0+$/, "").padStart(5)}`)
				: theme.fg("dim", "    —");
			const tier = m.costTier !== undefined && COST_TIER[m.costTier] ? COST_TIER[m.costTier] : "";
			const pricing = m.pricingType !== undefined ? (PRICING_TYPE[m.pricingType] ?? "") : "";
			const extra = [tier, pricing, m.premium ? "premium" : ""].filter(Boolean).join(" · ");
			box.addChild(new Text(`  ${name} ${mult}${extra ? theme.fg("dim", `  ${extra}`) : ""}`));
		}
		return box;
	});

	interface RefreshCtx {
		modelRegistry: {
			getApiKeyForProvider(provider: string): Promise<string | undefined>;
			getAvailable(): { provider: string; id: string }[];
		};
		model?: { provider: string; id: string };
		ui: {
			setStatus(id: string, s?: string): void;
			notify(message: string, kind?: "info" | "warning" | "error"): void;
		};
	}

	async function refresh(ctx: RefreshCtx): Promise<UsageReport | undefined> {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider("devin");
		if (!apiKey) {
			ctx.ui.notify("Devin: not signed in. Run /login devin", "warning");
			return undefined;
		}
		const report = await fetchDevinUsage(apiKey);
		// Trim the 200+ server configs to the models actually registered in pi,
		// and flag the currently active one for the card renderer.
		const devinIds = new Set(
			ctx.modelRegistry.getAvailable().filter(m => m.provider === "devin").map(m => m.id),
		);
		if (devinIds.size > 0) {
			report.models = report.models?.filter(m => devinIds.has(m.uid));
		}
		const active = ctx.model;
		if (active?.provider === "devin") {
			for (const m of report.models ?? []) if (m.uid === active.id) m.active = true;
		}
		lastReport = report;
		const summary = statusSummary(report);
		if (summary) ctx.ui.setStatus("devin-usage", summary);
		return report;
	}

	pi.registerCommand("devin-usage", {
		description: "Show Devin plan, quota and credit usage",
		handler: async (_args, ctx) => {
			try {
				const report = await refresh(ctx);
				if (report) pi.appendEntry("devin-usage", report);
			} catch (e) {
				ctx.ui.notify(`Devin usage: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	pi.registerCommand("devin-models", {
		description: "Show Devin model credit multipliers (burn rate)",
		handler: async (_args, ctx) => {
			try {
				const report = lastReport ?? (await refresh(ctx));
				if (report) pi.appendEntry("devin-models", report);
			} catch (e) {
				ctx.ui.notify(`Devin models: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	pi.on("session_start", async (_e, ctx) => {
		try {
			await refresh(ctx);
		} catch {
			// best-effort footer only
		}
	});
}

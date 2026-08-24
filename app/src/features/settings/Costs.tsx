/** Costs section: spend/cache dashboard (G4, PRD §10 cache-hit metric). Port of public/costs.js. */

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import GlassCard from "../../ui/GlassCard";
import SegmentedTabs from "../../ui/SegmentedTabs";
import StatTile from "../../ui/StatTile";

const DAY_OPTIONS = [
	{ value: "7", label: "7 days" },
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
];
const DEFAULT_DAYS = "30";
const CACHE_HIT_GOOD = 0.8;

interface JobTypeTotals {
	calls: number;
	prompt_tokens: number;
	cached_tokens: number;
	completion_tokens: number;
	cost_usd: number;
}

interface DayRow {
	day: string;
	job_type: string;
	calls: number;
	prompt_tokens: number;
	cached_tokens: number;
	cost_usd: number;
}

interface CostsData {
	month_to_date_usd: number;
	projected_month_usd: number;
	totals: { cache_hit_rate: number; calls: number };
	by_job_type: Record<string, JobTypeTotals>;
	rows: DayRow[];
}

function formatUsd(value: number | undefined): string {
	return `$${Number(value ?? 0).toFixed(2)}`;
}

function formatPct(value: number | undefined): string {
	return `${Math.round(Number(value ?? 0) * 1000) / 10}%`;
}

function formatInt(value: number | undefined): string {
	return Number(value ?? 0).toLocaleString();
}

function JobTypeTable({ byJobType }: { byJobType: Record<string, JobTypeTotals> }) {
	const jobTypes = Object.keys(byJobType).sort();
	return (
		<div className="table-scroll">
			<table className="costs-table">
				<thead>
					<tr>
						<th>Job</th>
						<th className="num">Calls</th>
						<th className="num">Prompt</th>
						<th className="num">Cached</th>
						<th className="num">Completion</th>
						<th className="num">Cost</th>
					</tr>
				</thead>
				<tbody>
					{jobTypes.length === 0 ? (
						<tr>
							<td colSpan={6} className="hint">
								No calls in this window.
							</td>
						</tr>
					) : (
						jobTypes.map((jobType) => {
							const totals = byJobType[jobType];
							if (!totals) {
								return null;
							}
							return (
								<tr key={jobType}>
									<td>{jobType}</td>
									<td className="num">{formatInt(totals.calls)}</td>
									<td className="num">{formatInt(totals.prompt_tokens)}</td>
									<td className="num">{formatInt(totals.cached_tokens)}</td>
									<td className="num">{formatInt(totals.completion_tokens)}</td>
									<td className="num">{formatUsd(totals.cost_usd)}</td>
								</tr>
							);
						})
					)}
				</tbody>
			</table>
		</div>
	);
}

function DailyTable({ rows }: { rows: DayRow[] }) {
	const sorted = [...rows].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
	return (
		<div className="table-scroll">
			<table className="costs-table">
				<thead>
					<tr>
						<th>Day</th>
						<th>Job</th>
						<th className="num">Calls</th>
						<th className="num">Cache</th>
						<th className="num">Cost</th>
					</tr>
				</thead>
				<tbody>
					{sorted.length === 0 ? (
						<tr>
							<td colSpan={5} className="hint">
								No calls in this window.
							</td>
						</tr>
					) : (
						sorted.map((row, i) => {
							const rate = row.prompt_tokens === 0 ? 0 : row.cached_tokens / row.prompt_tokens;
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: rows aren't individually addressable (day+job_type pairs may repeat across a reload), index is stable for this render's list
								<tr key={`${row.day}-${row.job_type}-${i}`}>
									<td>{row.day}</td>
									<td>{row.job_type}</td>
									<td className="num">{formatInt(row.calls)}</td>
									<td className="num">{formatPct(rate)}</td>
									<td className="num">{formatUsd(row.cost_usd)}</td>
								</tr>
							);
						})
					)}
				</tbody>
			</table>
		</div>
	);
}

export default function Costs() {
	const [days, setDays] = useState(DEFAULT_DAYS);
	const [data, setData] = useState<CostsData | null>(null);
	const [loadError, setLoadError] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setData(null);
		setLoadError(false);
		(async () => {
			let res: Response;
			try {
				res = await apiFetch(`/api/costs?days=${days}`);
			} catch (err) {
				console.error("settings: failed to load costs", err);
				if (!cancelled) {
					setLoadError(true);
				}
				return;
			}
			if (cancelled) {
				return;
			}
			if (!res.ok) {
				setLoadError(true);
				return;
			}
			const json = (await res.json()) as CostsData;
			if (!cancelled) {
				setData(json);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [days]);

	return (
		<GlassCard title="Costs">
			<SegmentedTabs options={DAY_OPTIONS} value={days} onChange={setDays} />
			{loadError ? <p className="hint">Couldn't load the cost dashboard.</p> : null}
			{!loadError && data === null ? <p className="hint">Loading…</p> : null}
			{data ? (
				<>
					<div className="costs-stats">
						<StatTile
							label="Month-to-date"
							value={formatUsd(data.month_to_date_usd)}
							tone="lilac"
						/>
						<StatTile label="Projected" value={formatUsd(data.projected_month_usd)} />
						<StatTile
							label="Cache hit rate"
							value={formatPct(data.totals.cache_hit_rate)}
							tone={data.totals.cache_hit_rate >= CACHE_HIT_GOOD ? "green" : undefined}
						/>
						<StatTile label="Calls" value={formatInt(data.totals.calls)} />
					</div>
					<h3 className="settings-subheading">By job type</h3>
					<JobTypeTable byJobType={data.by_job_type} />
					<h3 className="settings-subheading">By day</h3>
					<DailyTable rows={data.rows} />
				</>
			) : null}
		</GlassCard>
	);
}

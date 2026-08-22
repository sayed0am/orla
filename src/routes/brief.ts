/** HTTP handlers for F4 morning brief. */

import { runMorningBrief } from "../brief";

type BriefRow = {
	for_date: string;
	body_md: string;
	data: string;
	created_at: string;
	pushed_at: string | null;
};

export async function handleBriefGet(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

	const row = await env.ORLA_DB.prepare(
		"SELECT for_date, body_md, data, created_at, pushed_at FROM briefs WHERE for_date = ?",
	)
		.bind(date)
		.first<BriefRow>();

	if (!row) {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	return Response.json({
		brief: {
			for_date: row.for_date,
			body_md: row.body_md,
			data: JSON.parse(row.data),
			created_at: row.created_at,
			pushed_at: row.pushed_at,
		},
	});
}

export async function handleBriefRun(env: Env): Promise<Response> {
	const result = await runMorningBrief(env);
	return Response.json(result, { status: 200 });
}

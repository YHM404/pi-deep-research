/**
 * Deep Research Extension — web_search + web_extract tools
 *
 * This fork is aligned with the user's existing web-search-max skill stack.
 * It uses a Tavily-compatible reverse proxy exposed under /api/* and reads the
 * API key from the `search_apikey` environment variable.
 *
 * Configuration via environment variables:
 *   search_apikey            — full Tavily-compatible key used by web-search-max
 *   WEB_SEARCH_MAX_BASE_URL  — optional proxy base URL (default: https://search.ligong.cyou)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	score?: number;
	publishedDate?: string;
}

interface ExtractResult {
	title: string;
	url: string;
	content: string;
	author?: string;
	publishedDate?: string;
	wordCount: number;
}

const DEFAULT_PROXY_BASE_URL = process.env.WEB_SEARCH_MAX_BASE_URL ?? "https://search.ligong.cyou";

function getSearchApiKey(): string {
	const apiKey = process.env.search_apikey;
	if (!apiKey) {
		throw new Error(
			"No web-search-max API key configured. Export search_apikey before using this package.\n" +
			"  Example: export search_apikey=\"tvly-...\""
		);
	}
	return apiKey;
}

async function proxyRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
	const apiKey = getSearchApiKey();
	const baseUrl = DEFAULT_PROXY_BASE_URL.replace(/\/$/, "");
	const normalizedPath = path.startsWith("/api/") ? path : `/api${path.startsWith("/") ? path : `/${path}`}`;

	const resp = await fetch(`${baseUrl}${normalizedPath}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`web-search-max proxy error ${resp.status}: ${text}`);
	}

	return (await resp.json()) as T;
}

async function searchProxy(query: string, opts: {
	maxResults: number;
	searchDepth: string;
	includeDomains?: string[];
	excludeDomains?: string[];
}): Promise<SearchResult[]> {
	const body: Record<string, unknown> = {
		query,
		max_results: opts.maxResults,
		search_depth: opts.searchDepth,
		include_answer: false,
	};
	if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
	if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;

	const data = await proxyRequest<{
		results?: Array<{
			title?: string;
			url?: string;
			content?: string;
			raw_content?: string;
			score?: number;
			published_date?: string;
		}>;
	}>("/search", body);

	return (data.results ?? [])
		.filter((r) => r.url)
		.map((r) => ({
			title: r.title ?? r.url ?? "Untitled",
			url: r.url!,
			snippet: r.content ?? r.raw_content ?? "",
			score: r.score,
			publishedDate: r.published_date,
		}));
}

async function doSearch(query: string, opts: {
	maxResults: number;
	searchDepth: string;
	includeDomains?: string[];
	excludeDomains?: string[];
}): Promise<{ provider: string; results: SearchResult[] }> {
	const results = await searchProxy(query, opts);
	return { provider: "web-search-max", results };
}

async function extractContent(url: string): Promise<ExtractResult> {
	const data = await proxyRequest<{
		results?: Array<{
			url?: string;
			title?: string;
			raw_content?: string;
			content?: string;
			author?: string;
			published_date?: string;
		}>;
		failed_results?: Array<{ url?: string; error?: string }>;
	}>("/extract", { urls: [url] });

	const result = data.results?.[0];
	if (!result) {
		const failure = data.failed_results?.find((item) => item.url === url) ?? data.failed_results?.[0];
		throw new Error(failure?.error ?? `No extract result returned for ${url}`);
	}

	const content = (result.raw_content ?? result.content ?? "").trim();
	if (!content) {
		throw new Error(`Extract response did not include readable content for ${url}`);
	}

	const wordCount = content.split(/\s+/).filter(Boolean).length;
	return {
		title: result.title ?? url,
		url: result.url ?? url,
		content,
		author: result.author,
		publishedDate: result.published_date,
		wordCount,
	};
}

async function batchSearch(queries: string[], opts: { maxResults: number; searchDepth: string }): Promise<{ provider: string; results: Record<string, SearchResult[]> }> {
	const settled = await Promise.allSettled(
		queries.map((q) => doSearch(q, { maxResults: opts.maxResults, searchDepth: opts.searchDepth }))
	);

	let provider = "web-search-max";
	const results: Record<string, SearchResult[]> = {};
	for (let i = 0; i < queries.length; i++) {
		const s = settled[i];
		if (s.status === "fulfilled") {
			provider = s.value.provider;
			results[queries[i]] = s.value.results;
		} else {
			results[queries[i]] = [];
		}
	}
	return { provider, results };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: [
			"Search the web for information. Supports single query or batch queries (parallel).",
			"Returns ranked results with title, URL, snippet, and relevance score.",
			"Uses the existing web-search-max-compatible proxy and requires search_apikey.",
		].join(" "),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query" })),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple queries to search in parallel (max 5)",
					maxItems: 5,
				})
			),
			max_results: Type.Optional(
				Type.Number({ description: "Max results per query (default: 5, max: 10)", default: 5, maximum: 10 })
			),
			search_depth: Type.Optional(
				Type.String({
					description: '"basic" for speed, "advanced" for thoroughness',
					default: "basic",
				})
			),
			include_domains: Type.Optional(
				Type.Array(Type.String(), { description: "Only include results from these domains" })
			),
			exclude_domains: Type.Optional(
				Type.Array(Type.String(), { description: "Exclude results from these domains" })
			),
		}),

		async execute(_toolCallId, params) {
			const maxResults = Math.min(params.max_results ?? 5, 10);
			const searchDepth = params.search_depth ?? "basic";

			if (params.queries && params.queries.length > 0) {
				const { provider, results } = await batchSearch(params.queries, { maxResults, searchDepth });
				const totalResults = Object.values(results).reduce((s, r) => s + r.length, 0);
				let text = `Searched ${params.queries.length} queries via ${provider}, found ${totalResults} results:\n\n`;

				for (const [query, hits] of Object.entries(results)) {
					text += `### "${query}" (${hits.length} results)\n\n`;
					for (let i = 0; i < hits.length; i++) {
						const h = hits[i];
						text += `${i + 1}. **${h.title}**\n   ${h.url}\n   ${h.snippet}\n`;
						if (h.score) text += `   Relevance: ${(h.score * 100).toFixed(0)}%`;
						if (h.publishedDate) text += ` | Date: ${h.publishedDate}`;
						text += "\n\n";
					}
				}
				return { content: [{ type: "text", text }] };
			}

			if (!params.query) {
				return {
					content: [{ type: "text", text: "Error: provide either `query` (string) or `queries` (array)." }],
					isError: true,
				};
			}

			const { provider, results } = await doSearch(params.query, {
				maxResults,
				searchDepth,
				includeDomains: params.include_domains,
				excludeDomains: params.exclude_domains,
			});

			let text = `Searched "${params.query}" via ${provider}, found ${results.length} results:\n\n`;
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				text += `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}\n`;
				if (r.score) text += `   Relevance: ${(r.score * 100).toFixed(0)}%`;
				if (r.publishedDate) text += ` | Date: ${r.publishedDate}`;
				text += "\n\n";
			}
			return { content: [{ type: "text", text }] };
		},
	});

	pi.registerTool({
		name: "web_extract",
		label: "Web Extract",
		description: [
			"Extract the main text content from a web page URL.",
			"Reads content through the existing web-search-max-compatible /extract endpoint.",
			"Use after web_search to read full content of promising results.",
		].join(" "),
		parameters: Type.Object({
			url: Type.String({ description: "URL of the web page to extract content from" }),
		}),

		async execute(_toolCallId, params) {
			try {
				const result = await extractContent(params.url);
				let text = `# ${result.title}\n\n`;
				text += `**URL:** ${result.url}\n`;
				if (result.author) text += `**Author:** ${result.author}\n`;
				if (result.publishedDate) text += `**Published:** ${result.publishedDate}\n`;
				text += `**Word count:** ${result.wordCount}\n\n---\n\n`;
				text += result.content;
				return { content: [{ type: "text", text }] };
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Failed to extract content from ${params.url}: ${msg}` }],
					isError: true,
				};
			}
		},
	});

	const DEPTH_THRESHOLDS: Record<string, {
		minSearchRounds: number;
		maxSearchRounds: number;
		minSources: number;
		confidenceThreshold: number;
		minAnsweredRatio: number;
	}> = {
		quick:      { minSearchRounds: 1, maxSearchRounds: 3,  minSources: 3,  confidenceThreshold: 60, minAnsweredRatio: 0.6 },
		standard:   { minSearchRounds: 2, maxSearchRounds: 6,  minSources: 5,  confidenceThreshold: 75, minAnsweredRatio: 0.7 },
		deep:       { minSearchRounds: 3, maxSearchRounds: 10, minSources: 10, confidenceThreshold: 85, minAnsweredRatio: 0.8 },
		exhaustive: { minSearchRounds: 5, maxSearchRounds: 20, minSources: 15, confidenceThreshold: 95, minAnsweredRatio: 0.9 },
	};

	pi.registerTool({
		name: "research_checkpoint",
		label: "Research Checkpoint",
		description: [
			"MANDATORY after each search round during deep research.",
			"Submit current research state for evaluation.",
			"The tool will analyze your progress and return a VERDICT: CONTINUE (must search more) or PROCEED (may synthesize report).",
			"You MUST obey the verdict — if it says CONTINUE, you must do another search round before calling this again.",
			"Do NOT skip this tool or write the report without a PROCEED verdict.",
		].join(" "),
		parameters: Type.Object({
			depth: Type.String({
				description: 'Research depth level: "quick", "standard", "deep", or "exhaustive"',
			}),
			round: Type.Number({
				description: "Current search round number (1-indexed, increment after each search batch)",
			}),
			sub_questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "The sub-question" }),
					answered: Type.Boolean({ description: "Whether this sub-question has been adequately answered" }),
					confidence: Type.Number({ description: "Confidence score 0-100 for this sub-question" }),
					source_count: Type.Number({ description: "Number of sources found for this sub-question" }),
					best_source_tier: Type.Number({ description: "Best source credibility tier (1=authoritative, 2=reliable, 3=community, 4=unverified)" }),
				}),
				{ description: "Status of each sub-question" }
			),
			total_sources: Type.Number({ description: "Total unique sources collected so far" }),
			contradictions: Type.Optional(
				Type.Array(Type.String(), { description: "List of contradictions found between sources" })
			),
			gaps: Type.Optional(
				Type.Array(Type.String(), { description: "Known information gaps that remain" })
			),
		}),

		async execute(_toolCallId, params) {
			const thresholds = DEPTH_THRESHOLDS[params.depth] ?? DEPTH_THRESHOLDS.standard;
			const totalQuestions = params.sub_questions.length;
			const answeredCount = params.sub_questions.filter(q => q.answered).length;
			const answeredRatio = totalQuestions > 0 ? answeredCount / totalQuestions : 0;
			const avgConfidence = totalQuestions > 0
				? params.sub_questions.reduce((sum, q) => sum + q.confidence, 0) / totalQuestions
				: 0;
			const minConfidence = totalQuestions > 0
				? Math.min(...params.sub_questions.map(q => q.confidence))
				: 0;
			const hasContradictions = (params.contradictions?.length ?? 0) > 0;
			const lowConfidenceQuestions = params.sub_questions.filter(q => q.confidence < 40);
			const medConfidenceQuestions = params.sub_questions.filter(q => q.confidence >= 40 && q.confidence < thresholds.confidenceThreshold);

			const issues: string[] = [];
			let verdict: "CONTINUE" | "PROCEED" = "PROCEED";

			if (params.round < thresholds.minSearchRounds) {
				verdict = "CONTINUE";
				issues.push(`⛔ Min search rounds not met: ${params.round}/${thresholds.minSearchRounds} rounds`);
			}

			if (params.total_sources < thresholds.minSources) {
				verdict = "CONTINUE";
				issues.push(`⛔ Not enough sources: ${params.total_sources}/${thresholds.minSources} sources`);
			}

			if (answeredRatio < thresholds.minAnsweredRatio) {
				verdict = "CONTINUE";
				issues.push(`⛔ Answered ratio too low: ${answeredCount}/${totalQuestions} (${(answeredRatio * 100).toFixed(0)}% < ${(thresholds.minAnsweredRatio * 100).toFixed(0)}%)`);
			}

			if (avgConfidence < thresholds.confidenceThreshold) {
				verdict = "CONTINUE";
				issues.push(`⛔ Average confidence too low: ${avgConfidence.toFixed(0)}% < ${thresholds.confidenceThreshold}%`);
			}

			if (lowConfidenceQuestions.length > 0 && params.round < thresholds.maxSearchRounds) {
				verdict = "CONTINUE";
				const names = lowConfidenceQuestions.map(q => `"${q.question}" (${q.confidence}%)`).join(", ");
				issues.push(`⛔ Low-confidence sub-questions (<40%): ${names}`);
			}

			if (hasContradictions && params.round < thresholds.maxSearchRounds) {
				verdict = "CONTINUE";
				issues.push(`⚠️ Unresolved contradictions (${params.contradictions!.length}) — search for authoritative sources to verify`);
			}

			if (params.round >= thresholds.maxSearchRounds) {
				verdict = "PROCEED";
				if (issues.length > 0) {
					issues.push(`⚠️ Max search rounds reached (${thresholds.maxSearchRounds}). Proceeding to report. Remaining issues will be noted in "Uncertainties & Gaps".`);
				}
			}

			const statusBar = `${"█".repeat(Math.round(avgConfidence / 5))}${"░".repeat(20 - Math.round(avgConfidence / 5))}`;

			let text = `## Research Checkpoint — Round ${params.round}\n\n`;
			text += `**Depth:** ${params.depth} | **Verdict: ${verdict === "CONTINUE" ? "🔴 CONTINUE SEARCHING" : "🟢 PROCEED TO REPORT"}**\n\n`;
			text += `### Progress\n`;
			text += `- Search rounds: ${params.round} / ${thresholds.minSearchRounds}-${thresholds.maxSearchRounds}\n`;
			text += `- Sources collected: ${params.total_sources} / ${thresholds.minSources} (minimum)\n`;
			text += `- Sub-questions answered: ${answeredCount}/${totalQuestions} (${(answeredRatio * 100).toFixed(0)}%)\n`;
			text += `- Avg confidence: ${statusBar} ${avgConfidence.toFixed(0)}% (threshold: ${thresholds.confidenceThreshold}%)\n`;
			text += `- Min confidence: ${minConfidence.toFixed(0)}%\n`;

			text += `\n### Sub-question Status\n`;
			for (const q of params.sub_questions) {
				const icon = q.confidence >= thresholds.confidenceThreshold ? "✅" :
				             q.confidence >= 40 ? "🟡" : "🔴";
				text += `${icon} [${q.confidence}%] ${q.question} — ${q.source_count} sources (Tier ${q.best_source_tier})\n`;
			}

			if (issues.length > 0) {
				text += `\n### Issues\n`;
				for (const issue of issues) {
					text += `${issue}\n`;
				}
			}

			if (params.contradictions && params.contradictions.length > 0) {
				text += `\n### Contradictions\n`;
				for (const c of params.contradictions) {
					text += `- ⚡ ${c}\n`;
				}
			}

			if (params.gaps && params.gaps.length > 0) {
				text += `\n### Remaining Gaps\n`;
				for (const g of params.gaps) {
					text += `- ❓ ${g}\n`;
				}
			}

			if (verdict === "CONTINUE") {
				text += `\n### 📋 Next Actions Required\n`;
				text += "You MUST perform another search round addressing the issues above, then call `research_checkpoint` again.\n";

				if (lowConfidenceQuestions.length > 0) {
					text += `\n**Priority — Low confidence questions to focus on:**\n`;
					for (const q of lowConfidenceQuestions) {
						text += `- "${q.question}" — try different search queries, different angles\n`;
					}
				}
				if (medConfidenceQuestions.length > 0) {
					text += `\n**Secondary — Medium confidence questions to strengthen:**\n`;
					for (const q of medConfidenceQuestions) {
						text += `- "${q.question}" (${q.confidence}%) — find corroborating sources\n`;
					}
				}
				if (hasContradictions) {
					text += `\n**Resolve contradictions** by searching for authoritative (Tier 1) sources.\n`;
				}
			} else {
				text += `\n### ✅ Ready to Synthesize\n`;
				text += "All criteria met. Proceed to Phase 4 — write the research report.\n";
				if (params.gaps && params.gaps.length > 0) {
					text += `Include the ${params.gaps.length} remaining gap(s) in the "Uncertainties & Gaps" section of the report.\n`;
				}
				if (hasContradictions) {
					text += `Include the ${params.contradictions!.length} contradiction(s) in the report — present both sides.\n`;
				}
			}

			return { content: [{ type: "text", text }] };
		},
	});
}

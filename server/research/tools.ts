import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ResearchSource } from "@shared/research";

const USER_AGENT = "ResearchPilot/1.0 (evidence research; contact: local app)";
const MAX_PAGE_CHARS = 9_000;
const MAX_FETCH_MS = 12_000;
const MAX_DNS_MS = 3_000;
const MAX_REDIRECTS = 4;

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

function stripHtml(input: string): string {
  return decodeHtml(input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchUrl(raw: string): string | null {
  try {
    const decoded = decodeHtml(raw);
    const parsed = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded, "https://duckduckgo.com");
    const target = parsed.searchParams.get("uddg");
    const url = new URL(target || parsed.toString());
    if (!/^https?:$/.test(url.protocol)) return null;
    if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeSearchQuery(query: string): string {
  let clean = query.trim().slice(0, 1_200);
  const suggested = clean.match(/(?:suggested queries|queries to try|focused searches)[^:\n]*:?\s*([\s\S]*)/i);
  if (suggested?.[1]) clean = suggested[1].trim();
  const firstListItem = clean.match(/(?:^|\n)\s*(?:1[.)]|[-*•])\s*([^\n]+)/);
  if (firstListItem?.[1]) clean = firstListItem[1].trim();
  if (clean.includes(";") && /\b(?:site:|(?:AI|workshop|university)\s)/i.test(clean)) clean = clean.split(";")[0].trim();
  return clean.replace(/[\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

export async function webSearch(query: string, maxResults = 5): Promise<Array<Pick<ResearchSource, "title" | "url" | "domain" | "snippet">>> {
  const cleanQuery = normalizeSearchQuery(query);
  if (cleanQuery.length < 2) throw new Error("Search query must contain at least two characters.");
  const broadenedQuery = cleanQuery
    .replace(/\bsite:[^\s)]+/gi, " ")
    .replace(/\bOR\b/gi, " ")
    .replace(/["'()|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const queries = Array.from(new Set([cleanQuery, broadenedQuery])).filter(value => value.length >= 2);
  let lastError = "The live search provider returned no parseable results.";
  for (const candidate of queries) {
    const endpoint = new URL("https://html.duckduckgo.com/html/");
    endpoint.searchParams.set("q", candidate);
    let html: string;
    try {
      const response = await fetch(endpoint, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(MAX_FETCH_MS) });
      if (!response.ok && response.status !== 202) {
        lastError = `Web search returned HTTP ${response.status}.`;
        continue;
      }
      html = await response.text();
    } catch (error) {
      lastError = error instanceof Error ? `Web search failed: ${error.message}` : "Web search failed with a network error.";
      continue;
    }
  const anchors = Array.from(html.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>[\s\S]*?<\/a>/gi));
  const seen = new Set<string>();
  const results = [];
  for (let index = 0; index < anchors.length && results.length < Math.min(Math.max(maxResults, 1), 8); index++) {
    const match = anchors[index];
    const tag = match[0].match(/^<a\b[^>]*>/i)?.[0] ?? "";
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const url = normalizeSearchUrl(href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const next = anchors[index + 1]?.index ?? html.length;
    const region = html.slice(match.index ?? 0, next);
    const snippetMatch = region.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)(?:<\/a>|<\/div>)/i);
    const title = stripHtml(match[0].replace(/^<a\b[^>]*>/i, "").replace(/<\/a>$/i, ""));
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "Search result returned without a readable snippet.";
    if (!title) continue;
    results.push({ title, url, domain: new URL(url).hostname.replace(/^www\./, ""), snippet: snippet.slice(0, 900) });
  }
    if (results.length) return results;
    lastError = candidate === cleanQuery && broadenedQuery !== cleanQuery
      ? "The exact search returned no parseable results; retrying a simplified query."
      : "The live search provider returned no parseable results for either the original or simplified query.";
  }
  throw new Error(`${lastError} Try a shorter query without exact-phrase or site restrictions.`);
}

function isBlockedAddress(address: string): boolean {
  if (address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

async function lookupWithTimeout(host: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Public host DNS lookup timed out.")), MAX_DNS_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function validatePublicUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Only public HTTP(S) URLs are allowed.");
  const host = url.hostname.toLowerCase();
  if (["localhost", "metadata.google.internal"].includes(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Private or local hosts cannot be extracted.");
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error("Private or local IP addresses cannot be extracted.");
  } else {
    const records = await lookupWithTimeout(host);
    if (!records.length || records.some(record => isBlockedAddress(record.address))) throw new Error("The URL host does not resolve exclusively to public IP addresses.");
  }
  return url;
}

export async function extractPage(urlValue: string): Promise<{ title: string; text: string }> {
  let url = await validatePublicUrl(urlValue);
  let response: Response | undefined;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,application/xhtml+xml" },
      redirect: "manual",
      signal: AbortSignal.timeout(MAX_FETCH_MS),
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) break;
    if (redirectCount === MAX_REDIRECTS) throw new Error("Page extraction exceeded the allowed redirect count.");
    const nextUrl = new URL(location, url);
    await response.body?.cancel();
    url = await validatePublicUrl(nextUrl.toString());
    response = undefined;
  }
  if (!response) throw new Error("Page extraction could not reach a validated redirect target.");
  if (!response.ok) throw new Error(`Page extraction returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(contentType)) throw new Error(`Unsupported page content type: ${contentType || "unknown"}.`);
  const html = (await response.text()).slice(0, 250_000);
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const text = stripHtml(html).slice(0, MAX_PAGE_CHARS);
  if (!text) throw new Error("No readable text was extracted from this page.");
  return { title: title ? stripHtml(title).slice(0, 240) : url.hostname, text };
}

export function calculate(expression: string): number {
  const input = expression.replace(/\s+/g, "");
  if (!input || input.length > 160 || !/^[\d.+\-*/()%]+$/.test(input)) throw new Error("Only numeric arithmetic expressions are supported.");
  const tokens = input.match(/\d+(?:\.\d+)?|[()+\-*/%]/g) ?? [];
  if (tokens.join("") !== input) throw new Error("The arithmetic expression contains unsupported syntax.");
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const primary = (): number => {
    const token = take();
    if (token === "+") return primary();
    if (token === "-") return -primary();
    if (token === "(") {
      const value = expressionValue();
      if (take() !== ")") throw new Error("Unbalanced parentheses.");
      return value;
    }
    if (!token || !/^\d/.test(token)) throw new Error("Expected a number.");
    return Number(token);
  };
  const term = (): number => {
    let value = primary();
    while (["*", "/", "%"].includes(peek() ?? "")) {
      const op = take();
      const right = primary();
      if ((op === "/" || op === "%") && right === 0) throw new Error("Division by zero is not allowed.");
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  };
  const expressionValue = (): number => {
    let value = term();
    while (peek() === "+" || peek() === "-") {
      const op = take();
      const right = term();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const result = expressionValue();
  if (index !== tokens.length || !Number.isFinite(result) || Math.abs(result) > 1e15) throw new Error("The expression is incomplete or outside the supported range.");
  return Number(result.toFixed(6));
}

export function calculateBatch(input: string): Array<{ expression: string; result: number }> {
  if (!input.trim() || input.length > 900) throw new Error("A calculator batch must contain 1–6 bounded arithmetic equations.");
  const equations = input.split(/[;\n]+/).map(item => item.trim()).filter(Boolean);
  if (!equations.length || equations.length > 6) throw new Error("A calculator batch must contain 1–6 bounded arithmetic equations.");
  return equations.map(equation => {
    const parts = equation.split("=");
    if (parts.length > 2) throw new Error("Each calculator line may contain at most one result check.");
    const normalize = (value: string) => value
      .replace(/₹|INR/gi, "")
      .replace(/,/g, "")
      .replace(/×/g, "*")
      .replace(/÷/g, "/")
      .trim();
    const expression = normalize(parts[0]);
    const result = calculate(expression);
    if (parts.length === 2) {
      const claimedResult = calculate(normalize(parts[1]));
      if (claimedResult !== result) throw new Error("The supplied equation result does not match the calculator.");
    }
    return { expression, result };
  });
}

export function readUserFile(name: string, content: string): { name: string; characters: number; preview: string; summary: string } {
  if (content.length > 80_000) throw new Error("Uploaded text is limited to 80,000 characters.");
  const extension = name.toLowerCase().split(".").pop();
  if (!extension || !["csv", "json", "txt", "md", "markdown"].includes(extension)) throw new Error("Supported file types: CSV, JSON, TXT, Markdown.");
  let summary = "Text file loaded.";
  if (extension === "json") {
    const parsed = JSON.parse(content) as unknown;
    summary = `Valid JSON loaded (${Array.isArray(parsed) ? `${parsed.length} array items` : typeof parsed === "object" && parsed ? `${Object.keys(parsed as object).length} top-level keys` : "scalar value"}).`;
  } else if (extension === "csv") {
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    const header = (lines[0] ?? "").split(",").map(v => v.trim());
    summary = `CSV loaded: ${Math.max(0, lines.length - 1)} data rows and ${header.length} columns (${header.slice(0, 12).join(", ")}).`;
  }
  return { name: name.slice(0, 180), characters: content.length, preview: content.slice(0, 15_000), summary };
}

export function normalizeSearchRecords(records: Array<{ title: string; url: string; domain: string; snippet: string }>, retrievedAt = Date.now()): ResearchSource[] {
  const seen = new Set<string>();
  return records.filter(record => {
    try {
      const url = new URL(record.url);
      if (!/^https?:$/.test(url.protocol) || seen.has(url.toString())) return false;
      seen.add(url.toString());
      return true;
    } catch {
      return false;
    }
  }).map((record, index) => ({
    id: `S${index + 1}`,
    title: record.title.slice(0, 240),
    url: record.url,
    domain: record.domain || new URL(record.url).hostname,
    snippet: record.snippet.slice(0, 900),
    retrievedAt,
  }));
}

// Paper Acquirer tools: PubMed search (E-utilities), PubMed Central full text,
// with Europe PMC and a bundled GLP-1 corpus as fallbacks.

import corpus from "./corpus.json";
import { throwIfStopped, withRunSignal } from "./abort.js";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const UA = "LitPeer/0.2 (student research prototype)";
const NCBI_KEY = process.env.NCBI_API_KEY || "";
const MAX_ABSTRACT = 2000;

// ---------- helpers ----------
export function clean(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x?[0-9a-f]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithTimeout(url, ms = 20000) {
  throwIfStopped();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: withRunSignal(ctrl.signal), headers: { "User-Agent": UA } });
  } finally {
    clearTimeout(t);
  }
}

// NCBI allows 3 requests/second without an API key (10 with one). All lanes share this queue.
let ncbiChain = Promise.resolve();
const NCBI_GAP_MS = NCBI_KEY ? 120 : 380;
function ncbi(path, params) {
  const url = `${EUTILS}/${path}?` + new URLSearchParams({ ...params, tool: "litpeer", ...(NCBI_KEY ? { api_key: NCBI_KEY } : {}) });
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetchWithTimeout(url);
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`PubMed ${path} ${res.status}`);
      return res;
    }
    throw new Error(`PubMed ${path} rate-limited`);
  };
  const p = ncbiChain.then(run);
  ncbiChain = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, NCBI_GAP_MS)));
  return p;
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? clean(m[1]) : "";
}

// ---------- PubMed ----------
export async function pubmedSearch(term, retmax = 25) {
  const res = await ncbi("esearch.fcgi", { db: "pubmed", term: `(${term}) AND hasabstract`, retmax: String(retmax), retmode: "json", sort: "relevance" });
  const data = await res.json();
  return { ids: data?.esearchresult?.idlist || [], total: Number(data?.esearchresult?.count || 0) };
}

export async function pubmedFetch(ids) {
  if (!ids.length) return [];
  const res = await ncbi("efetch.fcgi", { db: "pubmed", id: ids.join(","), retmode: "xml" });
  const xml = await res.text();
  return xml
    .split("<PubmedArticle>")
    .slice(1)
    .map((a) => {
      const abstract = [...a.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
        .map((m) => {
          const label = (m[1].match(/Label="([^"]+)"/) || [])[1];
          return (label ? `${label}: ` : "") + clean(m[2]);
        })
        .join(" ");
      const authors = [...a.matchAll(/<LastName>([\s\S]*?)<\/LastName>/g)].map((m) => clean(m[1]));
      const pubDate = a.match(/<PubDate>[\s\S]*?<\/PubDate>/)?.[0] || "";
      return {
        pmid: tag(a, "PMID"),
        pmcid: (a.match(/<ArticleId IdType="pmc">([^<]+)<\/ArticleId>/) || [])[1] || null,
        doi: (a.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/) || [])[1] || null,
        title: tag(a, "ArticleTitle"),
        authors: authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : ""),
        journal: tag(a, "Title"),
        year: tag(pubDate, "Year") || (tag(pubDate, "MedlineDate").match(/\d{4}/) || [""])[0],
        pubTypes: [...a.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)].map((m) => clean(m[1])).filter((t) => t !== "Journal Article").slice(0, 4),
        abstract: abstract.slice(0, MAX_ABSTRACT),
        source: "PubMed",
      };
    })
    .filter((p) => p.title && p.abstract);
}

// ---------- Europe PMC fallback ----------
async function europePmcCandidates(query, n) {
  const url =
    "https://www.ebi.ac.uk/europepmc/webservices/rest/search?" +
    new URLSearchParams({ query: `(${query}) AND HAS_ABSTRACT:y AND SRC:MED`, resultType: "core", pageSize: String(n), format: "json" });
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Europe PMC ${res.status}`);
  const data = await res.json();
  return (data?.resultList?.result || []).map((r) => {
    const au = String(r.authorString || "").split(",");
    return {
      pmid: r.pmid || null,
      pmcid: r.pmcid || null,
      doi: r.doi || null,
      title: clean(r.title),
      authors: au.slice(0, 3).join(",") + (au.length > 3 ? " et al." : ""),
      journal: clean(r.journalInfo?.journal?.title || ""),
      year: r.pubYear || "",
      pubTypes: [].concat(r.pubTypeList?.pubType || []).filter((t) => !/journal article/i.test(t)).slice(0, 4),
      abstract: clean(r.abstractText).slice(0, MAX_ABSTRACT),
      source: "Europe PMC",
    };
  }).filter((p) => p.title && p.abstract);
}

function corpusCandidates(query, n) {
  const terms = query.toLowerCase().match(/[a-z0-9-]{3,}/g) || [];
  return corpus
    .map((p) => ({ p, score: terms.reduce((s, t) => s + (`${p.title} ${p.abstract}`.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => ({ ...x.p, source: "Bundled GLP-1 corpus" }));
}

// Gather up to `cap` unique candidates across several queries.
// Returns { papers, source, perQuery:[{query,found,total}], notes }.
export async function gatherCandidates(queries, cap = 45, exclude = new Set()) {
  const notes = [];
  const perQuery = [];
  try {
    const ids = [];
    const per = Math.max(10, Math.ceil(cap / queries.length) + 5);
    for (const q of queries) {
      const { ids: found, total } = await pubmedSearch(q, per);
      const fresh = found.filter((id) => !ids.includes(id) && !exclude.has(id));
      perQuery.push({ query: q, found: fresh.length, total });
      ids.push(...fresh);
    }
    const papers = await pubmedFetch(ids.slice(0, cap));
    if (papers.length) return { papers, source: "PubMed", perQuery, notes };
    notes.push("PubMed: no results");
  } catch (err) {
    notes.push(`PubMed: ${err.message}`);
  }
  try {
    const seen = new Set();
    const papers = [];
    for (const q of queries) {
      for (const p of await europePmcCandidates(q, 25)) {
        const k = p.pmid || p.title;
        if (!seen.has(k) && !exclude.has(p.pmid)) { seen.add(k); papers.push(p); }
      }
    }
    if (papers.length) return { papers: papers.slice(0, cap), source: "Europe PMC", perQuery, notes };
    notes.push("Europe PMC: no results");
  } catch (err) {
    notes.push(`Europe PMC: ${err.message}`);
  }
  return { papers: corpusCandidates(queries.join(" "), cap).filter((p) => !exclude.has(p.pmid)), source: "Bundled GLP-1 corpus", perQuery, notes };
}

// ---------- PubMed Central full text ----------
const SECTION_LIMITS = { methods: 2500, results: 4500 };

function sectionKind(title) {
  const t = title.toLowerCase();
  if (/method|materials|patients and|study design|participants|experimental procedures/.test(t)) return "methods";
  if (/result|finding|outcome/.test(t)) return "results";
  return null;
}

// Returns { methods, results } text from the open-access PMC version, or null if not available.
export async function pmcFullText(pmcid) {
  if (!pmcid) return null;
  const id = String(pmcid).replace(/^PMC/i, "");
  const res = await ncbi("efetch.fcgi", { db: "pmc", id, retmode: "xml" });
  const xml = await res.text();
  const body = xml.match(/<body[\s\S]*?<\/body>/)?.[0];
  if (!body) return null; // publisher does not allow full-text download
  const out = { methods: "", results: "" };
  // Walk top-level sections: <sec ...><title>Methods</title> ... </sec>
  const secRe = /<sec\b[^>]*>\s*(?:<label>[\s\S]*?<\/label>\s*)?<title>([\s\S]*?)<\/title>([\s\S]*?)(?=<sec\b[^>]*>\s*(?:<label>[\s\S]*?<\/label>\s*)?<title>|<\/body>)/g;
  let current = null; // subsections (e.g. "Study population") inherit the kind of the section above them
  for (const m of body.matchAll(secRe)) {
    const title = clean(m[1]);
    const k = sectionKind(title);
    if (k) current = k;
    else if (/introduction|background|discussion|conclusion|limitation|acknowledg|funding|reference|supplement/i.test(title)) current = null;
    const kind = current;
    if (!kind || out[kind].length >= SECTION_LIMITS[kind]) continue;
    const text = clean(m[2].replace(/<table-wrap[\s\S]*?<\/table-wrap>/g, " ").replace(/<fig[\s\S]*?<\/fig>/g, " ").replace(/<xref[^>]*>[\s\S]*?<\/xref>/g, ""));
    out[kind] = (out[kind] + " " + `[${clean(m[1])}] ` + text).trim().slice(0, SECTION_LIMITS[kind]);
  }
  return out.methods || out.results ? out : null;
}

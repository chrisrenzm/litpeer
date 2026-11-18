#!/usr/bin/env python3
"""LitPeer paper acquirer: PubMed search + PubMed Central full text, Europe PMC fallback.

Standard library only. No API key needed (set NCBI_API_KEY for a higher rate limit).

  python3 litsearch.py search "query one" "query two" "query three" [--cap 45] [--exclude 123,456]
  python3 litsearch.py fulltext PMC1234567

`search` prints a JSON list of candidate papers (pmid, pmcid, doi, title, authors,
journal, year, pub_types, abstract, source). `fulltext` prints {"methods": ..., "results": ...}
from the open-access PMC version, or null when the publisher does not allow it.
"""
import html, json, os, re, sys, time, urllib.parse, urllib.request

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
UA = "litpeer-skill/1.0 (literature research)"
KEY = os.environ.get("NCBI_API_KEY", "")
GAP = 0.12 if KEY else 0.38  # NCBI allows 3 req/s without a key, 10 with one
MAX_ABSTRACT = 2000
_last = [0.0]


def clean(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def ncbi(path, **params):
    params.update(tool="litpeer")
    if KEY:
        params["api_key"] = KEY
    url = f"{EUTILS}/{path}?" + urllib.parse.urlencode(params)
    for attempt in range(3):
        wait = GAP - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            return get(url)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(1 + attempt)
                continue
            raise
    raise RuntimeError(f"PubMed {path} rate-limited")


def tag(block, name):
    m = re.search(rf"<{name}[^>]*>([\s\S]*?)</{name}>", block)
    return clean(m.group(1)) if m else ""


def pubmed_search(term, retmax):
    data = json.loads(ncbi("esearch.fcgi", db="pubmed", term=f"({term}) AND hasabstract",
                           retmax=str(retmax), retmode="json", sort="relevance"))
    r = data.get("esearchresult", {})
    return r.get("idlist", []), int(r.get("count", 0) or 0)


def pubmed_fetch(ids):
    if not ids:
        return []
    xml = ncbi("efetch.fcgi", db="pubmed", id=",".join(ids), retmode="xml")
    out = []
    for a in xml.split("<PubmedArticle>")[1:]:
        parts = []
        for m in re.finditer(r"<AbstractText([^>]*)>([\s\S]*?)</AbstractText>", a):
            label = re.search(r'Label="([^"]+)"', m.group(1))
            parts.append((label.group(1) + ": " if label else "") + clean(m.group(2)))
        authors = [clean(x) for x in re.findall(r"<LastName>([\s\S]*?)</LastName>", a)]
        m = re.search(r"<PubDate>[\s\S]*?</PubDate>", a)
        pub_date = m.group(0) if m else ""
        y = re.search(r"\d{4}", tag(pub_date, "Year") or tag(pub_date, "MedlineDate"))
        year = y.group(0) if y else ""
        pmc = re.search(r'<ArticleId IdType="pmc">([^<]+)</ArticleId>', a)
        doi = re.search(r'<ArticleId IdType="doi">([^<]+)</ArticleId>', a)
        types = [clean(t) for t in re.findall(r"<PublicationType[^>]*>([\s\S]*?)</PublicationType>", a)]
        p = {
            "pmid": tag(a, "PMID"),
            "pmcid": pmc.group(1) if pmc else None,
            "doi": doi.group(1) if doi else None,
            "title": tag(a, "ArticleTitle"),
            "authors": ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else ""),
            "journal": tag(a, "Title"),
            "year": year,
            "pub_types": [t for t in types if t != "Journal Article"][:4],
            "abstract": " ".join(parts)[:MAX_ABSTRACT],
            "source": "PubMed",
        }
        if p["title"] and p["abstract"]:
            out.append(p)
    return out


def europe_pmc(query, n):
    url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + urllib.parse.urlencode(
        {"query": f"({query}) AND HAS_ABSTRACT:y AND SRC:MED", "resultType": "core",
         "pageSize": str(n), "format": "json"})
    out = []
    for r in json.loads(get(url)).get("resultList", {}).get("result", []):
        au = (r.get("authorString") or "").split(",")
        p = {
            "pmid": r.get("pmid"), "pmcid": r.get("pmcid"), "doi": r.get("doi"),
            "title": clean(r.get("title")),
            "authors": ",".join(au[:3]) + (" et al." if len(au) > 3 else ""),
            "journal": clean(((r.get("journalInfo") or {}).get("journal") or {}).get("title", "")),
            "year": r.get("pubYear", ""),
            "pub_types": [t for t in ((r.get("pubTypeList") or {}).get("pubType") or [])
                          if "journal article" not in t.lower()][:4],
            "abstract": clean(r.get("abstractText"))[:MAX_ABSTRACT],
            "source": "Europe PMC",
        }
        if p["title"] and p["abstract"]:
            out.append(p)
    return out


def gather(queries, cap=45, exclude=()):
    exclude, notes, per_query = set(exclude), [], []
    try:
        ids, per = [], max(10, -(-cap // len(queries)) + 5)
        for q in queries:
            found, total = pubmed_search(q, per)
            fresh = [i for i in found if i not in ids and i not in exclude]
            per_query.append({"query": q, "new": len(fresh), "total_hits": total})
            ids += fresh
        papers = pubmed_fetch(ids[:cap])
        if papers:
            return {"source": "PubMed", "per_query": per_query, "notes": notes, "papers": papers}
        notes.append("PubMed: no results")
    except Exception as e:  # network or parse error -> fall back
        notes.append(f"PubMed: {e}")
    try:
        seen, papers = set(), []
        for q in queries:
            for p in europe_pmc(q, 25):
                k = p["pmid"] or p["title"]
                if k not in seen and p["pmid"] not in exclude:
                    seen.add(k)
                    papers.append(p)
        return {"source": "Europe PMC", "per_query": per_query, "notes": notes, "papers": papers[:cap]}
    except Exception as e:
        notes.append(f"Europe PMC: {e}")
    return {"source": None, "per_query": per_query, "notes": notes, "papers": []}


LIMITS = {"methods": 2500, "results": 4500}
SEC_RE = re.compile(r"<sec\b[^>]*>\s*(?:<label>[\s\S]*?</label>\s*)?<title>([\s\S]*?)</title>([\s\S]*?)"
                    r"(?=<sec\b[^>]*>\s*(?:<label>[\s\S]*?</label>\s*)?<title>|</body>)")


def kind_of(title):
    t = title.lower()
    if re.search(r"method|materials|patients and|study design|participants|experimental procedures", t):
        return "methods"
    if re.search(r"result|finding|outcome", t):
        return "results"
    return None


def fulltext(pmcid):
    xml = ncbi("efetch.fcgi", db="pmc", id=re.sub(r"(?i)^pmc", "", pmcid), retmode="xml")
    body = re.search(r"<body[\s\S]*?</body>", xml)
    if not body:
        return None  # publisher does not allow full-text download
    out, current = {"methods": "", "results": ""}, None
    for m in SEC_RE.finditer(body.group(0)):
        title = clean(m.group(1))
        k = kind_of(title)
        if k:
            current = k
        elif re.search(r"introduction|background|discussion|conclusion|limitation|acknowledg|funding|reference|supplement", title, re.I):
            current = None
        if not current or len(out[current]) >= LIMITS[current]:
            continue
        text = re.sub(r"<table-wrap[\s\S]*?</table-wrap>|<fig[\s\S]*?</fig>|<xref[^>]*>[\s\S]*?</xref>", " ", m.group(2))
        out[current] = (out[current] + f" [{title}] " + clean(text)).strip()[:LIMITS[current]]
    return out if out["methods"] or out["results"] else None


def main(argv):
    if len(argv) < 2 or argv[0] not in ("search", "fulltext"):
        print(__doc__)
        return 2
    if argv[0] == "fulltext":
        print(json.dumps(fulltext(argv[1]), ensure_ascii=False, indent=1))
        return 0
    cap, exclude, queries, i = 45, [], [], 1
    while i < len(argv):
        if argv[i] == "--cap":
            cap, i = int(argv[i + 1]), i + 2
        elif argv[i] == "--exclude":
            exclude, i = [x for x in argv[i + 1].split(",") if x], i + 2
        else:
            queries.append(argv[i])
            i += 1
    print(json.dumps(gather(queries, cap, exclude), ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

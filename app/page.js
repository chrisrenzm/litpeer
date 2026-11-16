"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const FIELD_LABEL = { biology: "Lab studies", healthcare: "Clinical studies", drug_discovery: "Pharmacology" };
const EXAMPLES = [
  { tag: "Healthcare + Biology", q: "How do GLP-1 receptor agonists reduce appetite, and how much weight loss do they produce in patients with obesity?" },
  { tag: "Drug discovery", q: "What is the evidence that oral small-molecule GLP-1 receptor agonists like orforglipron work as well as injectable semaglutide?" },
  { tag: "Healthcare", q: "Does metformin reduce cancer risk in people with type 2 diabetes?" },
  { tag: "Biology", q: "Which CRISPR delivery methods work best for in vivo liver gene editing in animal models?" },
];

let idSeq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`;
const newSession = () => ({ id: uid("s"), title: "New chat", messages: [], busy: false, created: Date.now() });
const emptyRun = () => ({ orchestrator: null, lanes: [], synth: null, verifier: null, responder: null, final: null, error: null, startedAt: Date.now() });

/* ---------------- small helpers ---------------- */

function Icon({ name, size = 15 }) {
  const p = {
    plus: "M12 5v14M5 12h14",
    send: "M5 12h14M13 6l6 6-6 6",
    stop: "M7 7h10v10H7z",
    chevron: "M9 6l6 6-6 6",
    download: "M12 4v11m0 0l-4-4m4 4l4-4M5 19h14",
    trash: "M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12",
    menu: "M4 7h16M4 12h16M4 17h16",
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16l-4.3-4.3",
    filter: "M4 5h16l-6 8v5l-4 2v-7L4 5z",
    doc: "M7 3h7l5 5v13H7zM14 3v5h5",
    flask: "M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21.5h11.6a2 2 0 0 0 1.7-3L14 9V3",
    scale: "M12 4v16M5 8h14M5 8l-3 6a3 3 0 0 0 6 0L5 8zm14 0l-3 6a3 3 0 0 0 6 0l-3-6z",
    check: "M5 12.5l4.5 4.5L19 7.5",
    shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z",
    pen: "M4 20h4L19 9l-4-4L4 16v4z",
    spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
    copy: "M9 9h10v10H9zM5 15V5h10",
    refresh: "M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5",
    chat: "M5 5h14v10H9l-4 4z",
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={p} />
    </svg>
  );
}

function FieldBadge({ field }) {
  if (!field) return null;
  return <span className={`badge f-${field}`}>{FIELD_LABEL[field] || field}</span>;
}

function GradeBadge({ g }) {
  return <span className={`badge g g-${g}`}>{g}</span>;
}

function Spinner() {
  return <span className="spin" aria-label="running" />;
}

const isRunning = (st) => st?.status === "running" || st?.status === "progress";
const doneData = (st) => (st?.status === "done" ? st.data : null);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/* ---------------- activity (thinking + tool calls) ---------------- */

function Row({ icon, status, title, mono, summary, children, defaultOpen = false, thought }) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = Boolean(children);
  return (
    <div className={`row ${thought ? "thought" : "tool"} ${status || ""}`}>
      <div className="rail">
        <span className="ico">{status === "running" ? <Spinner /> : <Icon name={icon} size={13} />}</span>
      </div>
      <div className="rbody">
        <button className={`rhead ${expandable ? "x" : ""}`} onClick={() => expandable && setOpen(!open)} disabled={!expandable}>
          <span className="rtitle">{title}</span>
          {mono && <code className="rmono">{mono}</code>}
          {summary && <span className="rsum">{summary}</span>}
          {expandable && <span className={`chev ${open ? "o" : ""}`}><Icon name="chevron" size={12} /></span>}
        </button>
        {expandable && open && <div className="rdetail">{children}</div>}
      </div>
    </div>
  );
}

function LaneActivity({ lane, i, multi }) {
  const s = lane.steps;
  const se = doneData(s.search), sc = doneData(s.screen), rf = doneData(s.refine), ft = doneData(s.fulltext), ex = doneData(s.extract), ev = doneData(s.evaluate);
  const picks = rf?.picks || sc?.picks || [];
  const queries = s.search?.data?.queries || lane.search_queries || [];
  const per = se?.perQuery || [];
  const label = FIELD_LABEL[lane.field] || lane.field;

  const body = (
    <>
      {s.search && (
        <Row icon="search" status={isRunning(s.search) ? "running" : "done"} title="Search PubMed" mono={`${queries.length} queries`}
          summary={se ? `${se.count} candidates${se.source !== "PubMed" ? ` (via ${se.source})` : ""}` : "searching…"}>
          <div className="qlist">
            {queries.map((q, k) => {
              const pq = per.find((x) => x.query === q);
              return (
                <div key={k} className="qline">
                  <code>{q}</code>
                  {pq && <span className="muted">{pq.found} new · {pq.total.toLocaleString()} total hit{pq.total === 1 ? "" : "s"}</span>}
                </div>
              );
            })}
            {se?.notes?.length > 0 && <div className="muted small">{se.notes.join(" · ")}</div>}
          </div>
        </Row>
      )}
      {s.screen && (
        <Row icon="filter" status={isRunning(s.screen) ? "running" : s.screen.status === "skipped" ? "skipped" : "done"} title="Screen titles and abstracts"
          summary={sc ? `picked ${sc.picks.length} of ${sc.screened} · coverage ${sc.coverage}` : s.screen.status === "skipped" ? "skipped" : `reading ${s.screen.data?.count || ""} abstracts…`}>
          {sc && (
            <div className="thinktext">
              {sc.coverage === "thin" && sc.missing && <p>Coverage looks thin: {sc.missing}</p>}
              <ol className="picklist">
                {(sc.picks || []).map((p, k) => (
                  <li key={k}><span className="pt">{p.title}</span> <span className="muted">({p.year})</span><div className="why">{p.reason}</div></li>
                ))}
              </ol>
            </div>
          )}
        </Row>
      )}
      {s.refine && (
        <Row icon="refresh" status={isRunning(s.refine) ? "running" : "done"} title="Refine search" mono={s.refine.data?.query}
          summary={rf ? `+${rf.added} candidates, now ${rf.picks.length} picked` : "searching for what was missing…"}>
          {rf && (
            <ol className="picklist">
              {picks.map((p, k) => <li key={k}><span className="pt">{p.title}</span> <span className="muted">({p.year})</span><div className="why">{p.reason}</div></li>)}
            </ol>
          )}
        </Row>
      )}
      {s.fulltext && (
        <Row icon="doc" status={isRunning(s.fulltext) ? "running" : s.fulltext.status === "skipped" ? "skipped" : "done"} title="Fetch open-access full text" mono="PMC"
          summary={ft ? `${ft.full} of ${ft.total} available; others use the abstract` : s.fulltext.status === "skipped" ? "skipped" : "fetching…"} />
      )}
      {s.extract && (
        <Row icon="flask" status={isRunning(s.extract) ? "running" : s.extract.status === "skipped" ? "skipped" : "done"} title="Extract findings"
          summary={ex ? `${ex.relevant} of ${ex.total} relevant` : s.extract.data?.total ? `paper ${Math.min((s.extract.data.done || 0) + 1, s.extract.data.total)} of ${s.extract.data.total}` : s.extract.status === "skipped" ? "skipped" : "reading…"}>
          {ex && <div className="muted small">Fields: {ex.fields.map((f) => f.replace(/_/g, " ")).join(", ")}</div>}
        </Row>
      )}
      {isRunning(s.extract) && s.extract.data?.total > 0 && (
        <div className="pbar"><span style={{ width: `${(100 * (s.extract.data.done || 0)) / s.extract.data.total}%` }} /></div>
      )}
      {s.evaluate && (
        <Row icon="scale" status={isRunning(s.evaluate) ? "running" : s.evaluate.status === "skipped" ? "skipped" : "done"} title="Grade evidence" mono={`${label} rubric`}
          summary={ev ? (
            <>
              kept {ev.kept}/{ev.total}{" "}
              {["A", "B", "C", "D"].filter((g) => ev.tally[g]).map((g) => <span key={g} className={`badge g g-${g}`}>{ev.tally[g]}×{g}</span>)}
              {ev.fallback && <span className="warn"> some ungraded</span>}
            </>
          ) : s.evaluate.status === "skipped" ? "skipped" : "grading…"} />
      )}
      {lane.error && <div className="laneerr">This sub-question failed: {lane.error}</div>}
    </>
  );

  const laneDone = ev || s.evaluate?.status === "skipped" || lane.error;
  return (
    <div className="lanegrp">
      <div className="lanehead">
        <span className={`lnum ${laneDone ? "d" : ""}`}>{multi ? i + 1 : <Icon name="search" size={11} />}</span>
        <span className="lq">{lane.heading ? <><b className="lh">{lane.heading}</b> · </> : null}{lane.question}</span>
      </div>
      <div className="lanebody">{body}</div>
    </div>
  );
}

function liveStatus(run) {
  if (run.error) return "Stopped";
  if (!run.orchestrator || isRunning(run.orchestrator)) return "Thinking about how to research this…";
  if (run.responder && isRunning(run.responder)) return "Answering from our conversation…";
  if (isRunning(run.verifier)) return "Checking every claim against the papers…";
  if (isRunning(run.synth)) return run.synth.data?.round > 1 ? "Revising the answer…" : "Writing the answer…";
  const steps = run.lanes.flatMap((l) => Object.entries(l.steps).filter(([, st]) => isRunning(st)).map(([k]) => k));
  if (steps.includes("extract")) return "Reading papers…";
  if (steps.includes("evaluate")) return "Grading evidence…";
  if (steps.includes("fulltext")) return "Fetching full texts…";
  if (steps.includes("screen") || steps.includes("refine")) return "Screening candidates…";
  if (steps.includes("search")) return "Searching PubMed…";
  return "Working…";
}

function Activity({ run, open, setOpen, onStop }) {
  const o = run.orchestrator;
  const plan = doneData(o);
  const done = Boolean(run.final);
  const rounds = run.verifier?.data?.rounds || [];
  const f = run.final;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (done || run.error) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - run.startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [done, run.error, run.startedAt]);

  let header;
  if (done && f.followup) header = `Answered from our conversation · ${f.seconds}s`;
  else if (done) {
    const screened = f.lanes.reduce((a, l) => a + (l.screened || 0), 0);
    header = `Researched ${plural(f.lanes.length, "sub-question")} · ${screened} papers screened · ${f.papers.length} read · ${f.seconds}s`;
  } else header = liveStatus(run);

  // synth/verify sequence
  const sv = [];
  rounds.forEach((r) => {
    sv.push({ k: `s${r.round}`, kind: "synth", round: r.round, status: "done" });
    sv.push({ k: `v${r.round}`, kind: "verify", round: r.round, status: "done", r });
  });
  const synthRound = run.synth?.data?.round || 0;
  if (run.synth && isRunning(run.synth)) sv.push({ k: `s${synthRound}`, kind: "synth", round: synthRound, status: "running" });
  else if (run.synth && synthRound > rounds.length) {
    sv.push({ k: `s${synthRound}`, kind: "synth", round: synthRound, status: "done" });
    if (isRunning(run.verifier)) sv.push({ k: `v${synthRound}`, kind: "verify", round: synthRound, status: "running" });
  }

  return (
    <div className={`activity ${open ? "open" : ""} ${done ? "done" : ""} ${run.error ? "halted" : ""}`}>
      <button className="ahead" onClick={() => setOpen(!open)}>
        {!done && !run.error ? <Spinner /> : <span className="adot"><Icon name={run.error ? "stop" : "spark"} size={13} /></span>}
        <span className={`atitle ${!done && !run.error ? "shimmer" : ""}`}>{header}</span>
        {!done && !run.error && <span className="atime">{elapsed}s</span>}
        {!done && !run.error && onStop && (
          <span role="button" tabIndex={0} className="astop" title="Stop this run (Esc)"
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onStop(); } }}>
            <Icon name="stop" size={11} /> Stop
          </span>
        )}
        <span className={`chev ${open ? "o" : ""}`}><Icon name="chevron" size={13} /></span>
      </button>
      {open && (
        <div className="abody">
          <Row thought icon="spark" status={isRunning(o) || !o ? "running" : "done"} title={plan ? "Planned the research" : "Thinking…"} defaultOpen
            summary={plan && plan.mode !== "followup" ? `${plural(plan.sub_questions.length, "sub-question")} · ${plan.complexity} complexity` : null}>
            {plan && (
              <div className="thinktext">
                <p>{plan.thinking || plan.reason}</p>
                {plan.standalone_question && plan.mode !== "followup" && plan.standalone_question !== f?.question && run._question && plan.standalone_question.trim() !== run._question.trim() && (
                  <p className="muted">Reading the follow-up as: “{plan.standalone_question}”</p>
                )}
                {plan.mode === "followup" && <p className="muted">No new search needed: the earlier answers already cover this.</p>}
              </div>
            )}
          </Row>

          {run.lanes.length > 0 && (
            <div className={`lanes ${run.lanes.length > 1 ? "multi" : ""}`}>
              {run.lanes.length > 1 && <div className="parallel">Researching {run.lanes.length} sub-questions in parallel</div>}
              {run.lanes.map((l, i) => <LaneActivity key={i} lane={l} i={i} multi={run.lanes.length > 1} />)}
            </div>
          )}

          {run.responder && (
            <Row icon="chat" status={isRunning(run.responder) ? "running" : "done"} title="Answer from earlier results" summary={isRunning(run.responder) ? "writing…" : "done"} />
          )}

          {sv.map((x) =>
            x.kind === "synth" ? (
              <Row key={x.k} thought icon="pen" status={x.status} title={x.round > 1 ? `Revising the draft (round ${x.round})` : "Writing the answer from graded evidence"}
                summary={x.round > 1 ? `fixing ${rounds[x.round - 2]?.problems.length || 0} flagged claim${rounds[x.round - 2]?.problems.length === 1 ? "" : "s"}` : null} />
            ) : (
              <Row key={x.k} icon="shield" status={x.status} title="Verify claims" mono={`round ${x.round}`}
                summary={x.r ? (
                  <>
                    <b>{x.r.supported}/{x.r.total}</b> supported
                    {x.r.problems.length > 0 && (rounds.length > x.round ? " · sent back for revision" : done ? " · unsupported claims removed" : "")}
                  </>
                ) : "checking each sentence against its sources…"}>
                {x.r?.problems.length > 0 && (
                  <ul className="problist">
                    {x.r.problems.map((p, k) => (
                      <li key={k}><span className={`vtag ${p.verdict}`}>{p.verdict}</span> “{p.text}” <span className="muted">{p.note}</span></li>
                    ))}
                  </ul>
                )}
              </Row>
            )
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- answer ---------------- */

function Cite({ n, msgId, onCite }) {
  return (
    <a className="cite" href={`#ref-${msgId}-${n}`} onClick={(e) => { e.preventDefault(); onCite(n); }}>{n}</a>
  );
}

function Sentence({ c, msgId, onCite }) {
  const cls = c.verdict === "partial" ? "partial" : "";
  return (
    <>
      <span className={cls} title={c.verdict === "partial" ? `Verifier: partly supported. ${c.note || ""}` : undefined}>{c.text}</span>
      {(c.citations || []).length > 0 && (
        <span className="cites">{c.citations.map((r) => <Cite key={r} n={r} msgId={msgId} onCite={onCite} />)}</span>
      )}{" "}
    </>
  );
}

// Follow-up answers carry citations inline as [n].
function InlineCited({ text, msgId, onCite, valid }) {
  const parts = text.split(/(\[\d+(?:,\s*\d+)*\])/g);
  return parts.map((part, i) => {
    const m = part.match(/^\[(\d+(?:,\s*\d+)*)\]$/);
    if (!m) return <span key={i}>{part}</span>;
    const ns = m[1].split(/,\s*/).map(Number);
    return <span key={i} className="cites">{ns.map((n) => (valid.has(n) ? <Cite key={n} n={n} msgId={msgId} onCite={onCite} /> : <span key={n} className="cite dead">{n}</span>))}</span>;
  });
}

function PaperCard({ p, msgId, hi }) {
  const [open, setOpen] = useState(false);
  const fields = p.extraction?.fields ? Object.entries(p.extraction.fields).filter(([, v]) => v && v !== "not reported") : [];
  return (
    <li id={`ref-${msgId}-${p.ref}`} className={`paper ${hi ? "hi" : ""} ${p.cited ? "" : "uncited"}`}>
      <div className="pn">{p.ref}</div>
      <div className="pbody">
        <div className="ptitle">
          {p.pmid ? <a href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`} target="_blank" rel="noreferrer">{p.title}</a> : p.doi ? <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer">{p.title}</a> : p.title}
        </div>
        <div className="pmeta">
          {p.authors}{p.journal && <> · <i>{p.journal}</i></>} {p.year}
          {p.pmid && <> · PMID {p.pmid}</>}
        </div>
        <div className="ptags">
          {p.grade && <><GradeBadge g={p.grade.grade} /><FieldBadge field={p.grade.field} /></>}
          <span className={`badge plain ${p.fulltext ? "ft" : ""}`}>{p.fulltext ? "Full text read" : "Abstract only"}</span>
          {(p.screen_reason || p.grade?.rationale || fields.length > 0 || p.extraction?.key_finding) && (
            <button className="linkbtn" onClick={() => setOpen(!open)}>{open ? "Hide details" : "Why this paper"}</button>
          )}
        </div>
        {open && (
          <div className="pdetail">
            {p.screen_reason && <div><span className="lbl">Screener</span>{p.screen_reason}</div>}
            {p.grade?.rationale && <div><span className="lbl">Evaluator</span>Grade {p.grade.grade}: {p.grade.rationale}</div>}
            {p.extraction?.key_finding && <div><span className="lbl">Key finding</span>{p.extraction.key_finding}</div>}
            {fields.map(([k, v]) => <div key={k}><span className="lbl">{k.replace(/_/g, " ")}</span>{String(v)}</div>)}
          </div>
        )}
      </div>
    </li>
  );
}

function Sources({ final, msgId, open, setOpen, hi }) {
  const cited = final.papers.filter((p) => p.cited);
  const others = final.papers.filter((p) => !p.cited);
  const [showOthers, setShowOthers] = useState(false);
  if (!final.papers.length) return null;
  return (
    <div className="sources">
      <button className="srchead" onClick={() => setOpen(!open)}>
        <span className="stack">{cited.slice(0, 4).map((p) => <span key={p.ref} className="sbub">{p.ref}</span>)}</span>
        <span>{plural(cited.length, "source")} cited{others.length ? ` · ${others.length} more read` : ""}</span>
        <span className={`chev ${open ? "o" : ""}`}><Icon name="chevron" size={12} /></span>
      </button>
      {open && (
        <>
          <ul className="papers">{cited.map((p) => <PaperCard key={p.ref} p={p} msgId={msgId} hi={hi === p.ref} />)}</ul>
          {others.length > 0 && (
            <>
              <button className="linkbtn more" onClick={() => setShowOthers(!showOthers)}>{showOthers ? "Hide" : "Show"} {plural(others.length, "paper")} read but not cited</button>
              {showOthers && <ul className="papers">{others.map((p) => <PaperCard key={p.ref} p={p} msgId={msgId} hi={hi === p.ref} />)}</ul>}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Answer({ final, msgId }) {
  const [srcOpen, setSrcOpen] = useState(false);
  const [hi, setHi] = useState(null);
  const [copied, setCopied] = useState(false);
  const onCite = (n) => {
    setSrcOpen(true);
    setHi(n);
    setTimeout(() => document.getElementById(`ref-${msgId}-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    setTimeout(() => setHi(null), 2200);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(answerMarkdown(final));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  let body;
  if (final.followup) {
    const valid = new Set(final.papers.map((p) => Number(p.ref)));
    body = final.paragraphs.map((t, i) => <p key={i}><InlineCited text={t} msgId={msgId} onCite={onCite} valid={valid} /></p>);
  } else {
    const a = final.answer;
    body = (
      <>
        {a.opening?.length > 0 ? (
          <p className="lead">{a.opening.map((c, k) => <Sentence key={k} c={c} msgId={msgId} onCite={onCite} />)}</p>
        ) : (
          <p className="lead">I couldn't find enough support in the retrieved papers to give an overall answer, but here is what the evidence does show.</p>
        )}
        {a.sections.map((s, i) => {
          const paras = splitParas(s.claims);
          return (
            <section key={i} className="asec">
              {s.heading && <h3 className="sech">{s.heading}</h3>}
              {paras.map((cl, j) => (
                <p key={j}>
                  {cl.map((c, k) => <Sentence key={k} c={c} msgId={msgId} onCite={onCite} />)}
                  {j === paras.length - 1 && s.not_covered && <span className="nc">{s.not_covered}</span>}
                </p>
              ))}
            </section>
          );
        })}
        {a.not_covered?.length > 0 && (
          <section className="asec">
            <h3 className="sech">Not answered by these papers</h3>
            <p className="nc">{a.not_covered.join(" ")}</p>
          </section>
        )}
        {a.limitations && (
          <section className="asec">
            <h3 className="sech muted">How strong is the evidence</h3>
            <p className="limits">{a.limitations}</p>
          </section>
        )}
      </>
    );
  }
  const partial = !final.followup && [...(final.answer.opening || []), ...final.answer.sections.flatMap((s) => s.claims)].filter((c) => c.verdict === "partial").length;
  const supported = !final.followup && [...(final.answer.opening || []), ...final.answer.sections.flatMap((s) => s.claims)].filter((c) => c.verdict === "supported").length;
  return (
    <div className="answer">
      <div className="prose">{body}</div>
      {!final.followup && final.answer.removed?.length > 0 && (
        <details className="removed">
          <summary>{plural(final.answer.removed.length, "claim")} removed by the Verifier</summary>
          <ul>{final.answer.removed.map((r, i) => <li key={i}>“{r.text}” <span className="muted">{r.note}</span></li>)}</ul>
        </details>
      )}
      <Sources final={final} msgId={msgId} open={srcOpen} setOpen={setSrcOpen} hi={hi} />
      <div className="actions">
        <button className="ghost" onClick={copy}><Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}</button>
        {!final.followup && (
          <span className="vsum"><Icon name="shield" size={12} /> {supported} sentence{supported === 1 ? "" : "s"} verified{partial ? `, ${partial} partly supported (dotted underline)` : ""}</span>
        )}
      </div>
    </div>
  );
}

/* ---------------- markdown export ---------------- */

function splitParas(claims) {
  const out = [];
  (claims || []).forEach((c, k) => {
    if (!out.length || (c.new_paragraph && k > 0)) out.push([]);
    out[out.length - 1].push(c);
  });
  return out;
}

const cit = (c) => (c?.length ? ` [${c.join(", ")}]` : "");

function answerText(final) {
  if (final.followup) return final.paragraphs.join("\n\n");
  const a = final.answer;
  const paras = [];
  if (a.opening?.length) paras.push(a.opening.map((c) => c.text + cit(c.citations)).join(" "));
  for (const s of a.sections) {
    const ps = splitParas(s.claims).map((cl) => cl.map((c) => c.text + cit(c.citations)).join(" "));
    if (s.not_covered) ps.length ? (ps[ps.length - 1] += " " + s.not_covered) : ps.push(s.not_covered);
    if (s.heading) paras.push(`### ${s.heading}`);
    paras.push(...ps);
  }
  if (a.not_covered?.length) paras.push("### Not answered by these papers", a.not_covered.join(" "));
  if (a.limitations) paras.push("### How strong is the evidence", a.limitations);
  return paras.join("\n\n");
}

function refLine(p) {
  const link = p.pmid ? ` https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/` : p.doi ? ` https://doi.org/${p.doi}` : "";
  return `[${p.ref}] ${p.authors || ""}. ${p.title}. ${p.journal ? `*${p.journal}* ` : ""}${p.year || ""}.${link}`;
}

function answerMarkdown(final) {
  const cited = final.papers.filter((p) => p.cited);
  return `${answerText(final)}${cited.length ? `\n\n**Sources**\n\n${cited.map(refLine).join("\n")}` : ""}`;
}

function sessionMarkdown(session) {
  const out = [`# ${session.title}`, ``, `_LitPeer research session · exported ${new Date().toLocaleString()}_`, ``];
  for (const m of session.messages) {
    if (m.role === "user") out.push(`## You`, ``, m.text, ``);
    else {
      out.push(`## LitPeer`, ``);
      const f = m.run.final;
      if (!f) {
        out.push(m.run.error ? `_Stopped: ${m.run.error}_` : `_(still researching)_`, ``);
        continue;
      }
      out.push(answerMarkdown(f), ``);
      if (!f.followup) {
        const screened = f.lanes.reduce((a, l) => a + (l.screened || 0), 0);
        out.push(`<details><summary>Research steps</summary>`, ``);
        if (f.plan?.thinking) out.push(`*Plan:* ${f.plan.thinking}`, ``);
        f.plan.sub_questions.forEach((s, i) => out.push(`${i + 1}. ${s.heading ? `**${s.heading}**: ` : ""}${s.question} (${FIELD_LABEL[s.field]}) · queries: ${s.search_queries.map((q) => `\`${q}\``).join(", ")}`));
        out.push(``, `${screened} candidates screened · ${f.papers.length} papers read · ${f.papers.filter((p) => p.fulltext).length} in full text · ${f.seconds}s`);
        f.rounds.forEach((r) => out.push(`- Verifier round ${r.round}: ${r.supported}/${r.total} claims supported`));
        out.push(``, `</details>`, ``);
      }
    }
  }
  return out.join("\n");
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "session";

/* ---------------- messages ---------------- */

function AssistantMessage({ m, bump, onStop }) {
  const setOpen = (v) => { m.activityOpen = v; bump(); };
  const r = m.run;
  return (
    <div className="msg assistant">
      <div className="avatar">L</div>
      <div className="mbody">
        <Activity run={r} open={m.activityOpen} setOpen={setOpen} onStop={onStop} />
        {r.error && <div className={r.stopped ? "stopped" : "err"}>{r.error}</div>}
        {r.final && <Answer final={r.final} msgId={m.id} />}
      </div>
    </div>
  );
}

function Composer({ value, setValue, onSend, onStop, busy, autoFocus, big }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [value]);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  return (
    <div className={`composer ${big ? "big" : ""}`}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder={big ? "Ask a research question in biology, healthcare or drug discovery…" : "Ask a follow-up or a new question…"}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      {busy ? (
        <button className="sendbtn stop" onClick={onStop} title="Stop this run (Esc)" aria-label="Stop"><Icon name="stop" size={14} /></button>
      ) : (
        <button className="sendbtn" onClick={onSend} disabled={!value.trim()} title="Send (Enter)"><Icon name="send" size={16} /></button>
      )}
    </div>
  );
}

/* ---------------- page ---------------- */

export default function Home() {
  // Sessions live only in memory: closing or reloading the tab deletes them.
  const store = useRef(null);
  if (!store.current) {
    const s = newSession();
    store.current = { order: [s.id], byId: { [s.id]: s }, controllers: {} };
  }
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const [activeId, setActiveId] = useState(store.current.order[0]);
  const [drafts, setDrafts] = useState({});
  const [navOpen, setNavOpen] = useState(false);
  const scroller = useRef(null);
  const stick = useRef(true);

  const st = store.current;
  const session = st.byId[activeId];
  const draft = drafts[activeId] || "";
  const setDraft = (v) => setDrafts((d) => ({ ...d, [activeId]: v }));

  // Warn before closing the tab if there is anything to lose.
  useEffect(() => {
    const h = (e) => {
      if (store.current.order.some((id) => store.current.byId[id].messages.length)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  // Keep the newest content in view while streaming, unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => { stick.current = true; }, [activeId]);

  function newChat() {
    const empty = st.order.map((id) => st.byId[id]).find((s) => !s.messages.length);
    if (empty) setActiveId(empty.id);
    else {
      const s = newSession();
      st.byId[s.id] = s;
      st.order.unshift(s.id);
      setActiveId(s.id);
    }
    setNavOpen(false);
    bump();
  }

  function deleteChat(id) {
    st.controllers[id]?.abort();
    delete st.byId[id];
    st.order = st.order.filter((x) => x !== id);
    if (!st.order.length) {
      const s = newSession();
      st.byId[s.id] = s;
      st.order.push(s.id);
    }
    if (id === activeId) setActiveId(st.order[0]);
    bump();
  }

  function apply(m, ev) {
    const r = m.run;
    if (ev.type === "stage") {
      if (ev.stage === "orchestrator") {
        r.orchestrator = ev;
        if (ev.status === "done") r.lanes = (ev.data.sub_questions || []).map((s) => ({ ...s, steps: {} }));
      } else if (ev.stage === "synthesizer") r.synth = ev;
      else if (ev.stage === "verifier") r.verifier = ev;
      else if (ev.stage === "responder") r.responder = ev;
    } else if (ev.type === "lane") {
      const lane = r.lanes[ev.lane];
      if (lane) {
        if (ev.step === "error") lane.error = ev.data.message;
        else lane.steps = { ...lane.steps, [ev.step]: ev };
      }
    } else if (ev.type === "final") {
      r.final = ev.data;
      m.activityOpen = false;
    } else if (ev.type === "error") {
      r.error = ev.message;
    }
    r.lanes = [...r.lanes];
  }

  async function send(text) {
    const q = (text ?? draft).trim();
    const s = session;
    if (!q || s.busy) return;
    const history = s.messages
      .filter((m) => m.role === "assistant" && m.run.final)
      .slice(-3)
      .map((m) => ({ question: m.question, answer: answerText(m.run.final), papers: m.run.final.papers.filter((p) => p.cited) }));
    if (!s.messages.length) s.title = q.length > 60 ? q.slice(0, 58) + "…" : q;
    s.messages.push({ id: uid("u"), role: "user", text: q });
    const m = { id: uid("a"), role: "assistant", question: q, run: { ...emptyRun(), _question: q }, activityOpen: true };
    s.messages.push(m);
    s.busy = true;
    stick.current = true;
    setDrafts((d) => ({ ...d, [s.id]: "" }));
    bump();

    const ctrl = new AbortController();
    st.controllers[s.id] = ctrl;
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) apply(m, JSON.parse(line));
        }
        bump();
      }
      if (!m.run.final && !m.run.error) m.run.error = "The connection closed before the answer was finished.";
    } catch (err) {
      if (err.name === "AbortError") {
        m.run.stopped = true;
        m.run.error = "You stopped this run. Ask again whenever you're ready.";
      } else m.run.error = err.message;
    } finally {
      s.busy = false;
      delete st.controllers[s.id];
      bump();
    }
  }

  const stop = () => st.controllers[activeId]?.abort();

  // Esc stops the run in the open chat.
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape" && store.current.controllers[activeId]) store.current.controllers[activeId].abort(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [activeId]);
  const empty = !session.messages.length;
  const canDownload = session.messages.some((m) => m.role === "assistant" && m.run.final);

  return (
    <div className="app">
      <aside className={`side ${navOpen ? "show" : ""}`}>
        <div className="brand">Lit<span>Peer</span></div>
        <button className="newchat" onClick={newChat}><Icon name="plus" size={15} /> New chat</button>
        <div className="slabel">Chats</div>
        <nav className="slist">
          {st.order.map((id) => {
            const s = st.byId[id];
            return (
              <div key={id} className={`sitem ${id === activeId ? "on" : ""}`} onClick={() => { setActiveId(id); setNavOpen(false); }}>
                {s.busy ? <Spinner /> : <Icon name="chat" size={13} />}
                <span className="stitle">{s.title}</span>
                {(s.messages.length > 0 || st.order.length > 1) && (
                  <button className="sdel" title="Delete chat" onClick={(e) => { e.stopPropagation(); deleteChat(id); }}><Icon name="trash" size={12} /></button>
                )}
              </div>
            );
          })}
        </nav>
        <div className="snote">
          Chats are kept only while this tab is open. Closing or reloading it deletes them, so download anything you want to keep.
        </div>
      </aside>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

      <main className="main">
        <header className="bar">
          <button className="iconbtn menu" onClick={() => setNavOpen(true)} title="Chats"><Icon name="menu" size={18} /></button>
          <div className="btitle">{empty ? "New chat" : session.title}</div>
          {canDownload && (
            <div className="dl">
              <button className="ghost" onClick={() => download(`litpeer-${slug(session.title)}.md`, sessionMarkdown(session), "text/markdown")}><Icon name="download" size={13} /> Markdown</button>
              <button className="ghost" onClick={() => download(`litpeer-${slug(session.title)}.json`, JSON.stringify({ title: session.title, exported: new Date().toISOString(), messages: session.messages.map((m) => (m.role === "user" ? { role: "user", text: m.text } : { role: "assistant", result: m.run.final, error: m.run.error || null })) }, null, 2), "application/json")}>JSON</button>
            </div>
          )}
        </header>

        {empty ? (
          <div className="hero">
            <h1>What do you want to research?</h1>
            <p className="sub">LitPeer searches PubMed, screens and grades the papers, then writes an answer where every sentence is checked against its sources.</p>
            <Composer big value={draft} setValue={setDraft} onSend={() => send()} busy={false} autoFocus />
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button key={ex.q} className="excard" onClick={() => send(ex.q)}>
                  <span className="extag">{ex.tag}</span>
                  <span>{ex.q}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="thread" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
              <div className="col">
                {session.messages.map((m) =>
                  m.role === "user" ? (
                    <div key={m.id} className="msg user"><div className="bubble">{m.text}</div></div>
                  ) : (
                    <AssistantMessage key={m.id} m={m} bump={bump} onStop={stop} />
                  )
                )}
              </div>
            </div>
            <div className="dock">
              <Composer value={draft} setValue={setDraft} onSend={() => send()} onStop={stop} busy={session.busy} autoFocus />
              <div className="disclaimer">LitPeer is a student research prototype (DATASCI 101, Emory). Answers are AI-generated; read the cited papers before relying on a claim.</div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

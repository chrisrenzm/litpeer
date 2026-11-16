import { runPipeline } from "@/lib/pipeline";
import { hasKey } from "@/lib/llm";
import { runContext } from "@/lib/abort";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // seconds (Vercel)

export async function POST(req) {
  const { question, history } = await req.json().catch(() => ({}));
  if (!question || String(question).trim().length < 5) {
    return Response.json({ error: "Please enter a research question." }, { status: 400 });
  }
  if (!hasKey()) {
    return Response.json({ error: "DEEPSEEK_API_KEY is not set. Add it to .env.local." }, { status: 500 });
  }

  // Hard stop: the run is cancelled when the browser aborts the request (Stop button,
  // closed tab) or the stream is cancelled. All DeepSeek/PubMed calls read this signal.
  const stop = new AbortController();
  req.signal?.addEventListener("abort", () => stop.abort());
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const emit = (ev) => {
        if (!open || stop.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        } catch {
          open = false;
          stop.abort();
        }
      };
      try {
        const hist = (Array.isArray(history) ? history : []).slice(-3).map((h) => ({
          question: String(h?.question || "").slice(0, 500),
          answer: String(h?.answer || "").slice(0, 2500),
          papers: (Array.isArray(h?.papers) ? h.papers : []).slice(0, 25).map((p) => ({ ref: Number(p.ref), title: String(p.title || "").slice(0, 250), year: p.year, authors: String(p.authors || "").slice(0, 120), journal: String(p.journal || "").slice(0, 120), pmid: p.pmid || null, doi: p.doi || null })),
        }));
        await runContext.run(stop.signal, () => runPipeline(String(question).trim().slice(0, 500), emit, hist));
      } catch (err) {
        if (stop.signal.aborted) console.log("[LitPeer] Run stopped by user");
        else emit({ type: "error", message: err.message || "Pipeline failed" });
      } finally {
        open = false;
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}

import { config } from "../config";
import { registerTool } from "./registry";

async function fetchText(url: string, maxLen = 8000): Promise<string> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Farid/1.0 (WhatsApp AI Agent)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  // Strip HTML tags, scripts, styles — extract readable text
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLen);
}

async function summarizeWithLLM(text: string, instruction: string): Promise<string> {
  const resp = await fetch(`${config.hackclub.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.hackclub.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.hackclub.model,
      messages: [
        { role: "system", content: "You are a concise summarizer. Output short, actionable summaries formatted for WhatsApp (*bold*, _italic_). Max 500 chars." },
        { role: "user", content: `${instruction}\n\n${text}` },
      ],
      temperature: 0.3,
      max_tokens: 512,
    }),
  });
  if (!resp.ok) throw new Error("LLM summarization failed");
  const data = (await resp.json()) as any;
  return data.choices?.[0]?.message?.content?.trim() || "Could not generate summary.";
}

registerTool({
  name: "web_search",
  description: "Search the web for information. Use when the user asks a question you can't answer from memory or tools.",
  parameters: {
    query: { type: "string", description: "Search query", required: true },
  },
  async execute(args) {
    try {
      const encoded = encodeURIComponent(args.query);
      const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Farid/1.0 (WhatsApp AI Agent)" },
        signal: AbortSignal.timeout(10_000),
      });
      const html = await resp.text();

      // Extract result snippets from DuckDuckGo HTML
      const results: string[] = [];
      const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      const titleRegex = /<a class="result__a"[^>]*>([\s\S]*?)<\/a>/gi;
      const linkRegex = /<a class="result__a" href="([^"]+)"/gi;

      const titles: string[] = [];
      const links: string[] = [];
      const snippets: string[] = [];

      let m;
      while ((m = titleRegex.exec(html)) && titles.length < 5) {
        titles.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      while ((m = linkRegex.exec(html)) && links.length < 5) {
        links.push(m[1]);
      }
      while ((m = snippetRegex.exec(html)) && snippets.length < 5) {
        snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
      }

      if (titles.length === 0) return `No search results found for "${args.query}".`;

      for (let i = 0; i < titles.length; i++) {
        results.push(`${i + 1}. ${titles[i]}\n   ${snippets[i] || ""}`);
      }

      const raw = `Search results for "${args.query}":\n\n${results.join("\n\n")}`;
      return await summarizeWithLLM(raw, `Summarize these search results for the query "${args.query}". Give the most useful answer.`);
    } catch (err: any) {
      return `Search failed: ${err.message}`;
    }
  },
});

registerTool({
  name: "summarize_url",
  description: "Fetch a URL and summarize its content. Works with articles, blog posts, docs, README files.",
  parameters: {
    url: { type: "string", description: "URL to fetch and summarize", required: true },
  },
  async execute(args) {
    try {
      const text = await fetchText(args.url);
      if (text.length < 50) return "Could not extract meaningful content from that URL.";
      return await summarizeWithLLM(text, "Summarize this webpage content concisely:");
    } catch (err: any) {
      return `Failed to fetch URL: ${err.message}`;
    }
  },
});

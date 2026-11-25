// ai-fallback.js
// بيجرّب المزوّدين بالترتيب. أي مزوّد ملوش مفتاح في Railway بيتخطاه تلقائيًا.
// محتاج Node 18 أو أحدث (فيه fetch جاهز).

const PROVIDERS = [
  {
    name: "gemini",
    key: process.env.GEMINI_API_KEY,
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
  },
  {
    name: "groq",
    key: process.env.GROQ_API_KEY,
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  },
  {
    name: "cerebras",
    key: process.env.CEREBRAS_API_KEY,
    url: "https://api.cerebras.ai/v1/chat/completions",
    model: process.env.CEREBRAS_MODEL || "llama3.1-8b",
  },
  {
    name: "mistral",
    key: process.env.MISTRAL_API_KEY,
    url: "https://api.mistral.ai/v1/chat/completions",
    model: process.env.MISTRAL_MODEL || "mistral-small-latest",
  },
  {
    name: "openrouter",
    key: process.env.OPENROUTER_API_KEY,
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
  },
].filter((p) => p.key);

// messages = [{ role: "system" | "user" | "assistant", content: "..." }]
async function askAI(messages) {
  if (PROVIDERS.length === 0) {
    throw new Error("No AI API keys found in environment variables");
  }

  let lastError;
  for (const p of PROVIDERS) {
    try {
      const res = await fetch(p.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${p.key}`,
        },
        body: JSON.stringify({ model: p.model, messages }),
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${p.name} ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error(`${p.name} returned empty reply`);

      return text;
    } catch (err) {
      console.error(`[ai-fallback] ${p.name} failed:`, err.message);
      lastError = err;
    }
  }
  throw lastError;
}

module.exports = { askAI };

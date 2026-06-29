require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

function extractActionItemsFallback(transcript) {
  return transcript
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const lower = line.toLowerCase();
      const isAction = /\b(will|need to|must|should|agreed to|own|fix|patch|send|schedule|create|update|review|deploy|follow up|set up|prepare|submit|plan to)\b/i.test(lower);
      if (!isAction) return [];

      const ownerMatch = line.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/);
      const owner = ownerMatch ? ownerMatch[1] : "Unassigned";

      let deadline = "Not specified";
      const deadlineMatch = line.match(/\b(by|before)\s+([A-Za-z0-9\s]+)\b/i) || line.match(/\b(tomorrow|today|this week|next week|end of month|eod)\b/i);
      if (deadlineMatch) {
        deadline = (deadlineMatch[2] || deadlineMatch[1] || "Not specified").replace(/\s+/g, " ").trim();
      }

      let priority = "low";
      if (/(urgent|asap|critical|immediately|problem|issue|fix|deploy|tomorrow|today|before end of month)/i.test(lower)) {
        priority = "high";
      } else if (/(this week|next week|soon|review|schedule|follow up)/i.test(lower)) {
        priority = "medium";
      }

      return [{
        task: line,
        owner,
        deadline: deadline || "Not specified",
        priority,
      }];
    });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const file = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(file);
    return;
  }

  if (req.method === "POST" && req.url === "/extract") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { transcript, today } = JSON.parse(body);

        if (!GROQ_API_KEY) {
          const fallbackItems = extractActionItemsFallback(transcript);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(fallbackItems));
          return;
        }

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: "llama3-70b",
            max_tokens: 1000,
            messages: [
              {
                role: "user",
                content: `Today's date is ${today}.

You are extracting action items from meeting notes or casual text. The input may be a full transcript OR a short phrase like "call John tomorrow re: budget" or "mom wash cloth 1st july". Both are valid — extract action items from whatever is given.

Rules:
- Return ONLY a valid JSON array, no other text or markdown
- Each item: task (string), owner (string or "Unassigned"), deadline (resolved actual date like "July 1, 2026" based on today's date, or "Not specified"), priority ("high", "medium", or "low")
- Resolve relative dates: "tomorrow", "next Friday", "1st July" → real dates based on today
- Infer priority from urgency words: urgent/today/asap = high, this week/soon = medium, otherwise = low
- If input is very short/casual, still extract the implied task

Input:\n${transcript}`,
              },
            ],
          }),
        });

        const data = await response.json();
        if (!response.ok || !data.choices?.length) {
          const fallbackItems = extractActionItemsFallback(transcript);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(fallbackItems));
          return;
        }

        let raw = data.choices[0].message?.content || "";
        raw = raw.replace(/```json|```/g, "").trim();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(raw);
      } catch (e) {
        const fallbackItems = extractActionItemsFallback(JSON.parse(body).transcript || "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(fallbackItems));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(3000, () => {
  console.log("✅ Server running at http://localhost:3000");
});
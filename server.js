require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "actio-dev-secret-change-me";
const USERS_FILE = path.join(__dirname, "data", "users.json");
const COOKIE_NAME = "actio_session";

// ---------- tiny file-based user store ----------
function ensureDataFile() {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");
}
function readUsers() {
  ensureDataFile();
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { return []; }
}
function writeUsers(users) {
  ensureDataFile();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email };
}

// ---------- auth helpers ----------
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "30d" });
}
function authMiddleware(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) { req.user = null; return next(); }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
}

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(authMiddleware);

// ---------- static frontend ----------
app.use(express.static(__dirname));

// ---------- action item extraction (unchanged logic) ----------
function extractActionItemsFallback(transcript) {
  const lines = transcript.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    const lower = line.toLowerCase();

    // detect owner: first capitalised word or known name pattern
    const ownerMatch = line.match(/\b([A-Z][a-z]{1,})\b/);
    const owner = ownerMatch ? ownerMatch[1] : 'Unassigned';

    // detect deadline
    let deadline = 'Not specified';
    const deadlinePatterns = [
      /\b(tomorrow)\b/i,
      /\b(today)\b/i,
      /\b(this week|next week|next month)\b/i,
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i,
      /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i,
      /\bby\s+(.+)/i,
      /\bby\b.*\beod\b/i,
    ];
    for (const pat of deadlinePatterns) {
      const m = line.match(pat);
      if (m) { deadline = m[1] || m[0]; break; }
    }

    // detect priority
    let priority = 'low';
    if (/(urgent|asap|critical|immediately|today|tomorrow|eod|end of day|fix|deploy)/i.test(lower)) priority = 'high';
    else if (/(this week|next week|soon|review|schedule|follow up)/i.test(lower)) priority = 'medium';

    // detect if line has any actionable signal
    const hasAction = /(call|email|send|review|fix|update|deploy|schedule|meet|prepare|submit|buy|check|write|follow|set up|create|upload|pay|remind|book|finish|complete|contact|message|discuss|share|confirm|arrange|clean|wash|pick|drop|deliver|handle|resolve|ping)/i.test(lower);
    // also catch minimal patterns: Name Verb Date (≥2 words) or any line with a date ref
    const hasDate = deadline !== 'Not specified';
    const isShort = line.split(/\s+/).length <= 6;

    if (hasAction || hasDate || (isShort && ownerMatch)) {
      results.push({ task: line, owner, deadline, priority });
    }
  }

  // if nothing matched and input is short, treat whole thing as one task
  if (!results.length && transcript.trim().length > 0) {
    const ownerMatch = transcript.match(/\b([A-Z][a-z]{1,})\b/);
    results.push({
      task: transcript.trim(),
      owner: ownerMatch ? ownerMatch[1] : 'Unassigned',
      deadline: 'Not specified',
      priority: 'low',
    });
  }

  return results;
}

app.post("/extract", async (req, res) => {
  const { transcript, today } = req.body || {};
  if (!transcript) return res.status(400).json({ error: "transcript is required" });

  try {
    if (!GROQ_API_KEY) {
      return res.json(extractActionItemsFallback(transcript));
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama3-70b-8192",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: `Today's date is ${today}.

You are an expert at extracting action items from ANY kind of input — formal meeting transcripts, casual notes, shorthand, fragments, or even just a few words.

CRITICAL: You must extract tasks from ALL of these formats:
- Formal: "John will send the report by Friday"
- Casual: "John send report friday"
- Shorthand: "call mom tomorrow"
- Fragment: "budget review Sarah next week"
- Minimal: "Ali email client 5pm"
- Any name + any action + any time reference = a task

Rules:
- Return ONLY a valid JSON array, no other text or markdown
- Each item must have: task (string), owner (string or "Unassigned"), deadline (real date like "July 5, 2026" resolved from today, or "Not specified"), priority ("high", "medium", or "low")
- Resolve ALL relative dates to real dates: "tomorrow" → actual date, "friday" → next Friday's date, "next week" → date range, "1st july" → July 1 2026
- For owner: the first proper name mentioned is almost always the owner. If no name, use "Unassigned"
- For task: reconstruct a clean readable sentence even from fragments. "John report friday" → task: "Send report (John)", owner: "John", deadline: "[next friday's date]"
- Priority: urgent/today/asap/critical = high; this week/soon/review = medium; everything else = low
- NEVER return an empty array if there is any actionable content. Extract SOMETHING from every input.
- If input is just 2-3 words with a name and action, still extract it as a task.

Input:\n${transcript}`,
          },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.choices?.length) {
      return res.json(extractActionItemsFallback(transcript));
    }

    let raw = data.choices[0].message?.content || "";
    raw = raw.replace(/```json|```/g, "").trim();
    res.type("application/json").send(raw);
  } catch (e) {
    res.json(extractActionItemsFallback(transcript || ""));
  }
});

// ---------- auth routes ----------
app.post("/api/signup", (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ error: "Name, email, and password are required." });
  }
  const cleanEmail = email.trim().toLowerCase();
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }
  const users = readUsers();
  if (users.some((u) => u.email === cleanEmail)) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }
  const user = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: name.trim(),
    email: cleanEmail,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);

  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ user: publicUser(user) });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email?.trim() || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }
  const cleanEmail = email.trim().toLowerCase();
  const users = readUsers();
  const user = users.find((u) => u.email === cleanEmail);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ user: publicUser(user) });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email } });
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "You need to be signed in to do that." });
  next();
}

// update name / email
app.patch("/api/account", requireAuth, (req, res) => {
  const { name, email } = req.body || {};
  const users = readUsers();
  const user = users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "Account not found." });

  if (name?.trim()) user.name = name.trim();
  if (email?.trim()) {
    const cleanEmail = email.trim().toLowerCase();
    if (users.some((u) => u.email === cleanEmail && u.id !== user.id)) {
      return res.status(409).json({ error: "That email is already in use." });
    }
    user.email = cleanEmail;
  }
  writeUsers(users);

  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ user: publicUser(user) });
});

// change password
app.post("/api/account/password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password are required." });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }
  const users = readUsers();
  const user = users.find((u) => u.id === req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.passwordHash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  writeUsers(users);
  res.json({ ok: true });
});

// delete account
app.delete("/api/account", requireAuth, (req, res) => {
  const users = readUsers().filter((u) => u.id !== req.user.id);
  writeUsers(users);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Actio server running on port ${PORT}`);
});
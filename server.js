require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const Groq = require('groq-sdk');
const crypto = require('crypto');
const { Resend } = require('resend');

// ── Services ───────────────────────────────────────────────────────────────────
const { generateOutline, ATHLETE_ROUTES } = require('./services/outlineGenerator');
const { detectTriggers, getFollowUpQuestion, analyzeSentiment, calculateEngagement } = require('./services/deepDiveDetector');
const { polishBook, generateMarketingKit, scoreChapterQuality } = require('./services/bookEditor');

const resend = new Resend(process.env.RESEND_API_KEY);
const { buildSentimentTimeline, calculateQualityScore } = require('./services/sentimentAnalyzer');

const app = express();
const prisma = new PrismaClient();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const toJson  = (v) => (v != null ? JSON.stringify(v) : null);
const fromJson = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const parseClient = (c) => c ? { ...c, messages: fromJson(c.messages) || [], voiceProfile: fromJson(c.voiceProfile) } : c;

app.use(helmet());
app.use(cors({ origin: true, credentials: true, methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, message: { error: 'Too many requests' } }));

const authMiddleware = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { return res.status(403).json({ error: 'Invalid or expired token' }); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CHAPTER SYSTEM — 12 chapters, each with a theme and guiding questions
// ═══════════════════════════════════════════════════════════════════════════════
const CHAPTERS = [
  { num: 1,  part: 1, title: 'Where It All Began',        theme: 'childhood, hometown, family background, earliest memories',                    minResponses: 5 },
  { num: 2,  part: 1, title: 'The People Who Made Me',    theme: 'parents, siblings, mentors, key people in early life',                          minResponses: 5 },
  { num: 3,  part: 1, title: 'First Touch of the Game',   theme: 'first time playing the sport, why they fell in love with it, early training',   minResponses: 5 },
  { num: 4,  part: 2, title: 'The Hunger',                theme: 'early ambitions, sacrifices made, what drove them to pursue sport seriously',    minResponses: 5 },
  { num: 5,  part: 2, title: 'When It Got Hard',          theme: 'biggest struggles, failures, injuries, moments of doubt',                       minResponses: 5 },
  { num: 6,  part: 2, title: 'The Turning Point',         theme: 'the moment everything changed, breakthrough, who helped them through',          minResponses: 5 },
  { num: 7,  part: 3, title: 'Rising',                    theme: 'first major success, recognition, what it felt like to start winning',          minResponses: 5 },
  { num: 8,  part: 3, title: 'The Peak',                  theme: 'greatest achievement, championship moment, career highlight',                   minResponses: 5 },
  { num: 9,  part: 3, title: 'Behind the Glory',          theme: 'what people don\'t see, sacrifices at the top, personal cost of success',       minResponses: 5 },
  { num: 10, part: 4, title: 'Lessons from the Field',    theme: 'what sport taught them about life, values, character',                          minResponses: 5 },
  { num: 11, part: 4, title: 'The Next Generation',       theme: 'advice to young athletes, what they want to pass on, their impact',             minResponses: 5 },
  { num: 12, part: 4, title: 'Life Beyond the Game',      theme: 'who they are outside sport, future plans, what legacy means to them',           minResponses: 5 },
];

const PART_NAMES = { 1: 'ROOTS', 2: 'THE JOURNEY', 3: 'GLORY', 4: 'LEGACY' };

const SPORT_TERMS = {
  baseball:   'at-bats, ERA, batting average, dugout, bullpen, World Series, pitcher, home run',
  football:   'touchdowns, yards, playbook, Super Bowl, quarterback, end zone, blitz',
  basketball: 'assists, rebounds, three-pointers, NBA Finals, dribble, slam dunk',
  cricket:    'wickets, overs, centuries, Test matches, ODI, T20, yorker, googly',
  boxing:     'rounds, jabs, uppercuts, knockouts, title fights, training camp, southpaw',
  athletics:  'personal bests, heats, finals, world records, sprints, hurdles, relay',
  tennis:     'sets, aces, Grand Slams, baseline, tiebreak, deuce, volley',
  soccer:     'goals, assists, Champions League, penalty kicks, hat-trick, clean sheet',
};

async function groqChat(messages, opts = {}) {
  const res = await groq.chat.completions.create({
    model: opts.model || 'llama-3.3-70b-versatile',
    messages,
    temperature: opts.temperature ?? 0.85,
    max_tokens: opts.maxTokens || 150,
    stream: false,
  });
  return res.choices[0].message.content.trim();
}

// ─── Smart follow-up detector ──────────────────────────────────────────────────
// Returns true if the last user response needs a follow-up before moving on
function needsFollowUp(userResponse, responseCount) {
  if (!userResponse) return false;
  const words = userResponse.trim().split(/\s+/).length;
  // Short answer (under 15 words) always needs follow-up
  if (words < 15) return true;
  // First 2 responses always get follow-up for depth
  if (responseCount <= 2) return true;
  // Check for emotional triggers that need digging
  const triggers = ['hard', 'difficult', 'tough', 'scared', 'afraid', 'lost', 'failed', 'quit', 'cried', 'hurt',
    'proud', 'amazing', 'incredible', 'best', 'worst', 'never forget', 'always remember', 'my father', 'my mother',
    'my coach', 'my wife', 'my family', 'almost', 'nearly', 'but then', 'until', 'suddenly', 'everything changed'];
  const lower = userResponse.toLowerCase();
  return triggers.some(t => lower.includes(t));
}

// ─── Build chapter-aware interviewer prompt ────────────────────────────────────
function buildChapterPrompt(client, chapter, chapterMessages) {
  const sport = SPORT_TERMS[client.sport] || SPORT_TERMS.baseball;
  const userMsgs = chapterMessages.filter(m => m.role === 'user');
  const responseCount = userMsgs.length;
  const lastUserMsg = userMsgs[userMsgs.length - 1]?.content || '';
  const shouldFollowUp = needsFollowUp(lastUserMsg, responseCount);

  // Build recent exchange context
  const recentExchange = chapterMessages.slice(-6)
    .filter(m => m.content)
    .map(m => `${m.role === 'user' ? client.name : 'James'}: "${m.content}"`)
    .join('\n');

  return `You are James Cole, the world's most celebrated sports biographer. You've written 12 NYT bestselling athlete biographies. Your secret: you make athletes feel so safe and heard that they share things they've never told anyone.

ATHLETE: ${client.name} | SPORT: ${client.sport} | BOOK: "${client.bookTitle}"
SPORT VOCABULARY (use naturally): ${sport}

CHAPTER ${chapter.num}/12: "${chapter.title}"
THEME: ${chapter.theme}
RESPONSES THIS CHAPTER: ${responseCount}/${chapter.minResponses}

RECENT EXCHANGE:
${recentExchange || 'Just starting this chapter.'}

${shouldFollowUp ? `⚡ FOLLOW-UP MODE: Their last answer needs more depth. Don't move on yet.
- They said: "${lastUserMsg.slice(0, 100)}"
- Dig into the EMOTION or PERSON they mentioned
- Ask "what were you feeling?" or "who was there?" or "tell me more about [specific detail]"` :
`📖 EXPLORE MODE: Good depth so far. Continue exploring: ${chapter.theme}`}

YOUR VOICE:
- Warm, curious, never rushed
- Mirror their exact words back ("You said '${lastUserMsg.slice(0, 30)}...' — tell me more")
- Ask about feelings, not just facts
- Name the people they mention ("What did your father say when...?")
- Use their sport vocabulary naturally

ABSOLUTE RULES:
- ONE question only, max 20 words
- NEVER mention chapters, books, word counts, publishing
- NEVER be generic — always reference what they just said
- If they give a one-word answer, gently say "I'd love to hear more about that..."`;
}

// ─── Auth Routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 characters' });
    if (await prisma.user.findUnique({ where: { email } })) return res.status(409).json({ error: 'Email already registered' });
    const user = await prisma.user.create({ data: { email, password: await bcrypt.hash(password, 12), name, role: 'publisher' } });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) { console.error('Register:', err); res.status(500).json({ error: 'Registration failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password || !await bcrypt.compare(password, user.password))
      return res.status(401).json({ error: 'Invalid credentials' });
    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) { console.error('Login:', err); res.status(500).json({ error: 'Login failed' }); }
});

app.get('/api/auth/verify', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, email: true, name: true, role: true } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch { res.status(500).json({ error: 'Verification failed' }); }
});

app.post('/api/auth/logout', authMiddleware, (_req, res) => res.json({ message: 'Logged out' }));

// ─── Forgot Password ───────────────────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await prisma.user.findUnique({ where: { email } });
    // Always return success (don't reveal if email exists)
    if (!user) return res.json({ message: 'If this email exists, a reset link has been sent.' });

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExp = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.user.update({
      where: { email },
      data: { resetToken, resetTokenExp },
    });

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    // Send email via Resend
    if (process.env.RESEND_API_KEY) {
      await resend.emails.send({
        from: 'Muse Pro <onboarding@resend.dev>',
        to: email,
        subject: 'Reset your Muse Pro password',
        html: `
          <div style="font-family: Inter, sans-serif; max-width: 500px; margin: 0 auto; padding: 40px 20px;">
            <div style="background: linear-gradient(135deg, #6366f1, #a855f7); padding: 20px; border-radius: 12px; text-align: center; margin-bottom: 30px;">
              <h1 style="color: white; margin: 0; font-size: 24px;">Muse Pro</h1>
            </div>
            <h2 style="color: #111827;">Reset Your Password</h2>
            <p style="color: #6b7280;">Hi ${user.name},</p>
            <p style="color: #6b7280;">Click the button below to reset your password. This link expires in 1 hour.</p>
            <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #a855f7); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 20px 0;">
              Reset Password
            </a>
            <p style="color: #9ca3af; font-size: 12px;">If you didn't request this, ignore this email.</p>
          </div>
        `,
      });
    }

    res.json({ message: 'If this email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password:', err);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// ─── Reset Password ────────────────────────────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 characters' });

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExp: { gt: new Date() },
      },
    });

    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await bcrypt.hash(password, 12),
        resetToken: null,
        resetTokenExp: null,
      },
    });

    res.json({ message: 'Password reset successfully. You can now login.' });
  } catch (err) {
    console.error('Reset password:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─── Helper: name-based unique link ───────────────────────────────────────────
function makeUniqueLink(name) {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')   // remove special chars
    .replace(/\s+/g, '-')            // spaces to dashes
    .replace(/-+/g, '-')             // collapse dashes
    .slice(0, 30);                   // max 30 chars
  const suffix = crypto.randomBytes(4).toString('hex'); // 8 char random suffix
  return `${slug}-${suffix}`;        // e.g. "wail-mehmood-a3f9c2b1"
}

// ─── Client Routes ─────────────────────────────────────────────────────────────
app.post('/api/clients', authMiddleware, async (req, res) => {
  try {
    const { name, email, bookTitle, sport } = req.body;
    if (!name || !email || !bookTitle) return res.status(400).json({ error: 'Name, email, and book title are required' });

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email address' });

    // ✅ Duplicate check — same publisher cannot have same email twice
    const existing = await prisma.client.findFirst({
      where: { publisherId: req.user.id, email: email.toLowerCase().trim() },
    });
    if (existing) {
      return res.status(409).json({
        error: `A client with email "${email}" already exists in your account.`,
        existingClient: { id: existing.id, name: existing.name, bookTitle: existing.bookTitle },
      });
    }

    // ✅ Name-based unique link
    const uniqueLink = makeUniqueLink(name);

    const client = await prisma.client.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        bookTitle: bookTitle.trim(),
        sport: sport || 'baseball',
        uniqueLink,
        publisherId: req.user.id,
        messages: toJson([]),
      },
    });
    res.status(201).json({ client: parseClient(client) });
  } catch (err) { console.error('Create client:', err); res.status(500).json({ error: 'Failed to create client' }); }
});

app.get('/api/clients', authMiddleware, async (req, res) => {
  try {
    const all = await prisma.client.findMany({ where: { publisherId: req.user.id }, orderBy: { updatedAt: 'desc' } });
    const { search, status } = req.query;
    let result = all.map(parseClient);
    if (status && status !== 'all') result = result.filter(c => c.status === status);
    if (search) result = result.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) || c.bookTitle.toLowerCase().includes(search.toLowerCase()));
    res.json({ clients: result });
  } catch (err) { console.error('Get clients:', err); res.status(500).json({ error: 'Failed to fetch clients' }); }
});

app.get('/api/clients/:id', authMiddleware, async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json({ client: parseClient(client) });
  } catch { res.status(500).json({ error: 'Failed to fetch client' }); }
});

app.put('/api/clients/:id', authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const { name, email, bookTitle, sport, status } = req.body;
    const client = await prisma.client.update({ where: { id: req.params.id }, data: { name, email, bookTitle, sport, status } });
    res.json({ client: parseClient(client) });
  } catch { res.status(500).json({ error: 'Failed to update client' }); }
});

app.delete('/api/clients/:id', authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    await prisma.client.delete({ where: { id: req.params.id } });
    res.json({ message: 'Client deleted' });
  } catch { res.status(500).json({ error: 'Failed to delete client' }); }
});

app.get('/api/interview/link/:uniqueLink', async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { uniqueLink: req.params.uniqueLink } });
    if (!client) return res.status(404).json({ error: 'Interview not found' });
    res.json({ client: parseClient(client) });
  } catch { res.status(500).json({ error: 'Failed to fetch interview' }); }
});

// ─── Advanced: Reset interview (clear messages, keep client) ──────────────────
app.post('/api/clients/:id/reset', authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const client = await prisma.client.update({
      where: { id: req.params.id },
      data: { messages: toJson([]), bookDraft: null, voiceProfile: null, wordCount: 0, progress: 0, status: 'pending', lastActive: new Date() },
    });
    res.json({ client: parseClient(client), message: 'Interview reset successfully' });
  } catch { res.status(500).json({ error: 'Failed to reset interview' }); }
});

// ─── Advanced: Regenerate unique link ─────────────────────────────────────────
app.post('/api/clients/:id/regenerate-link', authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const newLink = makeUniqueLink(existing.name);
    const client = await prisma.client.update({ where: { id: req.params.id }, data: { uniqueLink: newLink } });
    res.json({ uniqueLink: newLink, client: parseClient(client) });
  } catch { res.status(500).json({ error: 'Failed to regenerate link' }); }
});

// ─── Advanced: Get single client stats ────────────────────────────────────────
app.get('/api/clients/:id/stats', authMiddleware, async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const messages = fromJson(client.messages) || [];
    const state = computeInterviewState(messages);
    const userMsgs = messages.filter(m => m.role === 'user' && m.content);
    const totalWords = userMsgs.map(m => m.content).join(' ').split(/\s+/).filter(Boolean).length;
    const avgWordsPerResponse = userMsgs.length > 0 ? Math.round(totalWords / userMsgs.length) : 0;
    const lastActive = client.lastActive;
    const daysSinceActive = Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000);
    res.json({
      completedChapters: state.completedChapters,
      totalResponses: userMsgs.length,
      totalWords,
      avgWordsPerResponse,
      progress: state.progress,
      daysSinceActive,
      hasBook: !!client.bookDraft,
      status: client.status,
    });
  } catch { res.status(500).json({ error: 'Failed to get stats' }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHAPTER-BASED INTERVIEW SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

// GET current chapter state
app.get('/api/interview/state/:clientId', async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const messages = fromJson(client.messages) || [];
    const state = computeInterviewState(messages);
    res.json({ state, chapters: CHAPTERS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compute which chapter we're on and how many responses per chapter
function computeInterviewState(messages) {
  // Messages have a chapterNum field
  const chapterData = {};
  for (const ch of CHAPTERS) {
    const chMsgs = messages.filter(m => m.chapterNum === ch.num);
    const userResponses = chMsgs.filter(m => m.role === 'user').length;
    chapterData[ch.num] = {
      messages: chMsgs,
      userResponses,
      isComplete: chMsgs.some(m => m.chapterComplete),
      isStarted: chMsgs.length > 0,
    };
  }

  // Find current chapter (first incomplete one)
  let currentChapterNum = 1;
  for (const ch of CHAPTERS) {
    if (!chapterData[ch.num].isComplete) { currentChapterNum = ch.num; break; }
    currentChapterNum = ch.num + 1;
  }
  if (currentChapterNum > 12) currentChapterNum = 12;

  const completedChapters = CHAPTERS.filter(ch => chapterData[ch.num]?.isComplete).length;
  const totalUserResponses = messages.filter(m => m.role === 'user').length;
  const progress = Math.round((completedChapters / 12) * 100);

  return { currentChapterNum, completedChapters, totalUserResponses, progress, chapterData };
}

// START a chapter
app.post('/api/interview/chapter/start', async (req, res) => {
  try {
    const { clientId, uniqueLink, chapterNum } = req.body;
    const client = clientId
      ? await prisma.client.findUnique({ where: { id: clientId } })
      : await prisma.client.findUnique({ where: { uniqueLink } });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const chapter = CHAPTERS.find(c => c.num === chapterNum);
    if (!chapter) return res.status(400).json({ error: 'Invalid chapter number' });

    const messages = fromJson(client.messages) || [];

    // Check previous chapter is complete (except chapter 1)
    if (chapterNum > 1) {
      const prevState = computeInterviewState(messages);
      if (!prevState.chapterData[chapterNum - 1]?.isComplete) {
        return res.status(400).json({ error: `Please complete Chapter ${chapterNum - 1} first` });
      }
    }

    // Generate opening question for this chapter
    const chapterMessages = messages.filter(m => m.chapterNum === chapterNum);
    const systemPrompt = buildChapterPrompt(client, chapter, chapterMessages);

    const partName = PART_NAMES[chapter.part];
    const openingInstruction = `You are starting Chapter ${chapter.num} of 12 — "${chapter.title}" (Part ${chapter.part}: ${partName}).
Theme to explore: ${chapter.theme}.
Greet the transition warmly and ask your first focused question about: ${chapter.theme.split(',')[0]}.
Keep it under 25 words. Be warm and inviting.`;

    const aiResponse = await groqChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: openingInstruction },
    ], { maxTokens: 80, temperature: 0.8 });

    // Add chapter start system message + AI opening
    const chapterStartMsg = {
      role: 'system',
      type: 'chapter_start',
      chapterNum,
      chapterTitle: chapter.title,
      partNum: chapter.part,
      partName,
      timestamp: new Date().toISOString(),
    };
    const aiMsg = {
      role: 'assistant',
      content: aiResponse,
      chapterNum,
      timestamp: new Date().toISOString(),
    };

    const newMessages = [...messages, chapterStartMsg, aiMsg];
    const state = computeInterviewState(newMessages);

    await prisma.client.update({
      where: { id: client.id },
      data: { messages: toJson(newMessages), status: 'active', lastActive: new Date(), progress: state.progress },
    });

    res.json({ response: aiResponse, chapterNum, chapterTitle: chapter.title, state });
  } catch (err) {
    console.error('Chapter start error:', err.message);
    res.status(500).json({ error: 'Failed to start chapter: ' + err.message });
  }
});

// SEND message within a chapter
app.post('/api/interview/message', async (req, res) => {
  try {
    const { clientId, uniqueLink, message, chapterNum, isVoice } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

    const client = clientId
      ? await prisma.client.findUnique({ where: { id: clientId } })
      : await prisma.client.findUnique({ where: { uniqueLink } });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const messages = fromJson(client.messages) || [];
    const currentChapterNum = chapterNum || computeInterviewState(messages).currentChapterNum;
    const chapter = CHAPTERS.find(c => c.num === currentChapterNum);
    if (!chapter) return res.status(400).json({ error: 'Invalid chapter' });

    const chapterMessages = messages.filter(m => m.chapterNum === currentChapterNum && m.role !== 'system');
    const systemPrompt = buildChapterPrompt(client, chapter, chapterMessages);

    const history = chapterMessages.slice(-20).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    // Voice messages get slightly more empathetic, shorter responses
    const maxTokens = isVoice ? 60 : 100;
    const temp = isVoice ? 0.82 : 0.88;

    // ── Deep dive detection ────────────────────────────────────────────────────
    const triggers = detectTriggers(message);
    const shouldFollowUp = triggers.length > 0 && chapterMessages.filter(m => m.role === 'user').length > 0;
    const followUpHint = shouldFollowUp ? getFollowUpQuestion(triggers) : null;

    // Inject follow-up hint into system prompt if detected
    const enhancedSystem = followUpHint
      ? `${systemPrompt}\n\n⚡ DEEP DIVE DETECTED (${triggers.join(', ')}): The athlete just mentioned something important. Your next question MUST be: "${followUpHint}" — adapt it naturally to what they said.`
      : systemPrompt;

    const aiResponse = await groqChat([
      { role: 'system', content: enhancedSystem },
      ...history,
      { role: 'user', content: message },
    ], { maxTokens, temperature: temp });

    // ── Sentiment & engagement tracking ───────────────────────────────────────
    const sentiment = analyzeSentiment(message);
    const engagement = calculateEngagement(message);

    // Save user message + AI response with chapter tag + voice flag
    const userMsg = { role: 'user', content: message, chapterNum: currentChapterNum, isVoice: !!isVoice, sentiment: sentiment.label, engagement, timestamp: new Date().toISOString() };
    const aiMsg   = { role: 'assistant', content: aiResponse, chapterNum: currentChapterNum, timestamp: new Date().toISOString() };
    const newMessages = [...messages, userMsg, aiMsg];

    const state = computeInterviewState(newMessages);
    const chapterUserResponses = newMessages.filter(m => m.chapterNum === currentChapterNum && m.role === 'user').length;
    const canComplete = chapterUserResponses >= chapter.minResponses;

    const allUserWords = newMessages.filter(m => m.role === 'user').map(m => m.content).join(' ');
    const wordCount = allUserWords.split(/\s+/).filter(Boolean).length;
    const qualityScore = calculateQualityScore(newMessages, state.completedChapters);

    await prisma.client.update({
      where: { id: client.id },
      data: { messages: toJson(newMessages), wordCount, progress: state.progress, status: 'active', lastActive: new Date(), qualityScore },
    });

    res.json({
      response: aiResponse,
      chapterNum: currentChapterNum,
      chapterUserResponses,
      canComplete,
      minResponses: chapter.minResponses,
      wordCount,
      state,
      triggers,
      sentiment: sentiment.label,
      engagement,
    });
  } catch (err) {
    console.error('Interview message error:', err.message);
    res.status(500).json({ error: 'Failed to process message: ' + err.message });
  }
});

// COMPLETE a chapter
app.post('/api/interview/chapter/complete', async (req, res) => {
  try {
    const { clientId, uniqueLink, chapterNum } = req.body;
    const client = clientId
      ? await prisma.client.findUnique({ where: { id: clientId } })
      : await prisma.client.findUnique({ where: { uniqueLink } });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const messages = fromJson(client.messages) || [];
    const chapter = CHAPTERS.find(c => c.num === chapterNum);
    const chapterUserResponses = messages.filter(m => m.chapterNum === chapterNum && m.role === 'user').length;

    if (chapterUserResponses < chapter.minResponses) {
      return res.status(400).json({
        error: `Need at least ${chapter.minResponses} responses for this chapter. You have ${chapterUserResponses}.`
      });
    }

    // Generate a closing summary message from James
    const chapterMessages = messages.filter(m => m.chapterNum === chapterNum && m.role !== 'system');
    const transcript = chapterMessages.map(m => `${m.role === 'user' ? client.name : 'James'}: ${m.content}`).join('\n');

    const closingMsg = await groqChat([{
      role: 'user',
      content: `You are James Cole. You just finished interviewing ${client.name} about "${chapter.title}". 
Write a warm 1-2 sentence closing for this chapter — acknowledge what they shared and express genuine appreciation.
Keep it under 30 words. Be heartfelt.
Their responses: ${transcript.slice(0, 500)}`
    }], { maxTokens: 60, temperature: 0.7 });

    // Mark chapter as complete
    const chapterEndMsg = {
      role: 'system',
      type: 'chapter_end',
      chapterNum,
      chapterTitle: chapter.title,
      timestamp: new Date().toISOString(),
      chapterComplete: true,
    };
    const aiClosing = {
      role: 'assistant',
      content: closingMsg,
      chapterNum,
      type: 'chapter_closing',
      timestamp: new Date().toISOString(),
    };

    const newMessages = [...messages, aiClosing, chapterEndMsg];
    const state = computeInterviewState(newMessages);
    const isAllDone = state.completedChapters === 12;

    await prisma.client.update({
      where: { id: client.id },
      data: {
        messages: toJson(newMessages),
        progress: state.progress,
        status: isAllDone ? 'completed' : 'active',
        lastActive: new Date(),
      },
    });

    res.json({
      closingMessage: closingMsg,
      chapterNum,
      completedChapters: state.completedChapters,
      isAllDone,
      nextChapter: isAllDone ? null : CHAPTERS.find(c => c.num === chapterNum + 1),
      state,
    });
  } catch (err) {
    console.error('Chapter complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete chapter: ' + err.message });
  }
});

// Insights endpoint
app.get('/api/interview/insights/:clientId', authMiddleware, async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const messages = fromJson(client.messages) || [];
    const userMsgs = messages.filter(m => m.role === 'user');
    if (userMsgs.length < 4) return res.json({ insights: null });

    const transcript = userMsgs.map(m => `${client.name}: ${m.content}`).join('\n');
    const raw = await groqChat([{ role: 'user', content: `Analyze and return ONLY JSON: {"emotionalHighs":["..."],"keyThemes":["...","..."],"mostEmotionalMoment":"...","interviewScore":80,"suggestedBookAngle":"..."}\nTRANSCRIPT:\n${transcript}` }], { maxTokens: 300, temperature: 0.3 });
    const match = raw.match(/\{[\s\S]*\}/);
    res.json({ insights: match ? JSON.parse(match[0]) : null });
  } catch { res.json({ insights: null }); }
});

// ─── Live chapter preview — generate a draft paragraph from current chapter ───
app.post('/api/interview/preview', authMiddleware, async (req, res) => {
  try {
    const { clientId, chapterNum } = req.body;
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const messages = fromJson(client.messages) || [];
    const chapter = CHAPTERS.find(c => c.num === chapterNum);
    if (!chapter) return res.status(400).json({ error: 'Invalid chapter' });

    const chMsgs = messages.filter(m => m.chapterNum === chapterNum && m.role !== 'system' && m.content);
    const userMsgs = chMsgs.filter(m => m.role === 'user');
    if (userMsgs.length < 2) return res.json({ preview: null, message: 'Need more responses for preview' });

    const transcript = chMsgs.map(m => `${m.role === 'user' ? client.name.toUpperCase() : 'JAMES'}: ${m.content}`).join('\n');

    const preview = await groqChat([{ role: 'user', content: `Write a vivid 150-word opening paragraph for Chapter "${chapter.title}" of ${client.name}'s biography.
Use ONLY what they said below. Write in their voice. Start with a scene or quote.
TRANSCRIPT:\n${transcript}` }], { maxTokens: 300, temperature: 0.7 });

    res.json({ preview, chapterNum, chapterTitle: chapter.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Save edited book draft ────────────────────────────────────────────────────
app.put('/api/book/:clientId', authMiddleware, async (req, res) => {
  try {
    const { bookDraft } = req.body;
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const wordCount = bookDraft.split(/\s+/).filter(Boolean).length;
    await prisma.client.update({ where: { id: req.params.clientId }, data: { bookDraft, wordCount } });
    res.json({ message: 'Book saved', wordCount });
  } catch { res.status(500).json({ error: 'Failed to save book' }); }
});

// ─── Regenerate single chapter in book ────────────────────────────────────────
app.post('/api/book/regenerate-chapter', authMiddleware, async (req, res) => {
  try {
    const { clientId, chapterNum } = req.body;
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const messages = fromJson(client.messages) || [];
    const chapter = CHAPTERS.find(c => c.num === chapterNum);
    if (!chapter) return res.status(400).json({ error: 'Invalid chapter' });

    const chMsgs = messages.filter(m => m.chapterNum === chapterNum && m.role !== 'system' && m.content);
    if (chMsgs.length === 0) return res.status(400).json({ error: 'No interview data for this chapter' });

    const transcript = chMsgs.map(m => `${m.role === 'user' ? client.name.toUpperCase() : 'JAMES COLE'}: ${m.content}`).join('\n');
    const voiceProfile = fromJson(client.voiceProfile) || {};

    const content = await groqChat([{ role: 'user', content: `Rewrite Chapter ${chapter.num}: "${chapter.title}" for ${client.name}'s biography.
Use ONLY what they said. Write in their voice (${voiceProfile.speakingStyle || 'natural'}).
Open with a vivid scene or direct quote. 400-500 words.
TRANSCRIPT:\n${transcript}` }], { maxTokens: 1000, temperature: 0.72 });

    res.json({ content, chapterNum, chapterTitle: chapter.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOOK GENERATION — chapter by chapter, voice-matched, transcript-grounded
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/book/generate', authMiddleware, async (req, res) => {
  try {
    const { clientId } = req.body;
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const messages = fromJson(client.messages) || [];
    const state = computeInterviewState(messages);

    if (state.completedChapters < 3) {
      return res.status(400).json({ error: `Complete at least 3 chapters first. You have ${state.completedChapters} completed.` });
    }

    // ── Step 1: Deep voice profile analysis ──────────────────────────────────
    const allUserMsgs = messages.filter(m => m.role === 'user' && m.content);
    const allUserContent = allUserMsgs.map(m => m.content).join('\n');
    let voiceProfile = {};
    try {
      const raw = await groqChat([{ role: 'user', content: `You are a linguistic analyst. Study how this person speaks and return ONLY valid JSON.

THEIR WORDS:
${allUserContent.slice(0, 3000)}

Return JSON:
{
  "speakingStyle": "one sentence describing how they talk",
  "sentenceLength": "short/medium/long",
  "keyPhrases": ["exact phrases they repeat"],
  "emotionalStyle": "how they express emotion",
  "vocabularyLevel": "simple/moderate/sophisticated",
  "personalityTraits": ["3-4 traits from their words"],
  "storytellingStyle": "how they tell stories",
  "coreValues": ["values evident in their words"],
  "uniqueExpressions": ["any unique ways they phrase things"],
  "toneWhenExcited": "how their language changes when excited",
  "toneWhenReflective": "how their language changes when reflective"
}` }], { maxTokens: 600, temperature: 0.2 });
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) voiceProfile = JSON.parse(match[0]);
    } catch (e) { console.warn('Voice profile:', e.message); }

    // ── Step 2: Build chapter transcripts ────────────────────────────────────
    const chapterTranscripts = [];
    for (const ch of CHAPTERS) {
      const chMsgs = messages.filter(m => m.chapterNum === ch.num && m.role !== 'system' && m.content);
      if (chMsgs.length === 0) continue;
      const transcript = chMsgs
        .map(m => `${m.role === 'user' ? client.name.toUpperCase() : 'JAMES COLE (Interviewer)'}: ${m.content}`)
        .join('\n\n');
      chapterTranscripts.push({ chapter: ch, transcript });
    }

    // ── Step 3: Generate each chapter with voice matching ────────────────────
    const bookParts = [`# ${client.bookTitle}\n### *By ${client.name}*\n\n---\n`];
    let lastPart = 0;

    for (const { chapter, transcript } of chapterTranscripts) {
      if (chapter.part !== lastPart) {
        bookParts.push(`\n## PART ${chapter.part}: ${PART_NAMES[chapter.part]}\n`);
        lastPart = chapter.part;
      }

      const voiceInstructions = `
VOICE MATCHING — Write EXACTLY like ${client.name} speaks:
- Speaking style: ${voiceProfile.speakingStyle || 'natural'}
- Sentence length: ${voiceProfile.sentenceLength || 'varied'}
- Their key phrases to weave in: ${(voiceProfile.keyPhrases || []).slice(0, 5).join(', ') || 'use their words from transcript'}
- Personality: ${(voiceProfile.personalityTraits || []).join(', ') || 'authentic'}
- Storytelling style: ${voiceProfile.storytellingStyle || 'direct and personal'}
- When excited they: ${voiceProfile.toneWhenExcited || 'speak with energy'}
- When reflective they: ${voiceProfile.toneWhenReflective || 'slow down and get personal'}`;

      const content = await groqChat([{ role: 'user', content: `You are a Pulitzer Prize-winning ghostwriter. Write Chapter ${chapter.num}: "${chapter.title}" for ${client.name}'s biography "${client.bookTitle}".

⚠️ GOLDEN RULES:
1. Use ONLY facts from the interview below — NEVER invent names, places, events
2. Write in ${client.name}'s EXACT voice — as if they wrote it themselves
3. Weave in their EXACT quotes naturally (use " " marks)
4. Every paragraph must connect to something they actually said
5. Show don't tell — paint scenes, describe feelings, use sensory details

${voiceInstructions}

INTERVIEW TRANSCRIPT FOR THIS CHAPTER:
${transcript}

Write 450-550 words. 
- Open with the most powerful moment or quote from this chapter
- Build the scene around their actual words
- End with a line that makes the reader want to turn the page
- Do NOT write "Chapter X:" — start directly with content` }],
        { maxTokens: 1100, temperature: 0.73, model: 'llama-3.3-70b-versatile' });

      bookParts.push(`\n### Chapter ${chapter.num}: ${chapter.title}\n\n${content}\n`);
    }

    const bookDraft = bookParts.join('');
    const bookWordCount = bookDraft.split(/\s+/).filter(Boolean).length;

    await prisma.client.update({
      where: { id: clientId },
      data: { bookDraft, voiceProfile: toJson(voiceProfile), status: 'completed', wordCount: bookWordCount, progress: 100 },
    });

    console.log(`✅ Book: ${client.name} | ${bookWordCount} words | ${chapterTranscripts.length} chapters`);
    res.json({ bookDraft, voiceProfile, wordCount: bookWordCount, chaptersGenerated: chapterTranscripts.length });
  } catch (err) {
    console.error('Book generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate book: ' + err.message });
  }
});

app.get('/api/book/:clientId', authMiddleware, async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (!client.bookDraft) return res.status(404).json({ error: 'No book draft yet' });
    res.json({ bookDraft: client.bookDraft, voiceProfile: fromJson(client.voiceProfile), client: { name: client.name, bookTitle: client.bookTitle, sport: client.sport } });
  } catch { res.status(500).json({ error: 'Failed to fetch book' }); }
});

app.post('/api/book/export', authMiddleware, async (req, res) => {
  try {
    const { clientId, format } = req.body;
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json({ bookDraft: client.bookDraft, format, filename: `${client.bookTitle.replace(/\s+/g, '_')}.${format}` });
  } catch { res.status(500).json({ error: 'Export failed' }); }
});

app.get('/api/analytics', authMiddleware, async (req, res) => {
  try {
    const all = await prisma.client.findMany({ where: { publisherId: req.user.id } });
    const total = all.length;
    const completed = all.filter(c => c.status === 'completed').length;
    const active = all.filter(c => c.status === 'active').length;
    const pending = all.filter(c => c.status === 'pending').length;
    const totalWords = all.reduce((s, c) => s + (c.wordCount || 0), 0);
    const avgProgress = total > 0 ? Math.round(all.reduce((s, c) => s + (c.progress || 0), 0) / total) : 0;
    const sportBreakdown = all.reduce((acc, c) => { acc[c.sport] = (acc[c.sport] || 0) + 1; return acc; }, {});
    res.json({ total, completed, active, pending, totalWords, avgProgress, sportBreakdown });
  } catch { res.status(500).json({ error: 'Failed to fetch analytics' }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADVANCED FEATURES
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. Book Outline Generator ──────────────────────────────────────────────────
app.post('/api/book/outline', authMiddleware, async (req, res) => {
  try {
    const { clientId } = req.body;
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const outline = await generateOutline(client, groqChat);
    await prisma.client.update({ where: { id: clientId }, data: { bookOutline: toJson(outline) } });
    res.json({ outline });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/book/outline/:clientId', authMiddleware, async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json({ outline: fromJson(client.bookOutline) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 2. Smart Book Polish ───────────────────────────────────────────────────────
app.post('/api/book/polish', authMiddleware, async (req, res) => {
  try {
    const { clientId } = req.body;
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (!client.bookDraft) return res.status(400).json({ error: 'No book draft to polish' });

    const voiceProfile = fromJson(client.voiceProfile);
    const polished = await polishBook(client.bookDraft, client, voiceProfile, groqChat);
    const wordCount = polished.split(/\s+/).filter(Boolean).length;
    await prisma.client.update({ where: { id: clientId }, data: { bookDraft: polished, wordCount } });
    res.json({ bookDraft: polished, wordCount, message: 'Book polished successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 3. Marketing Kit Generator ─────────────────────────────────────────────────
app.post('/api/book/marketing', authMiddleware, async (req, res) => {
  try {
    const { clientId } = req.body;
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (!client.bookDraft) return res.status(400).json({ error: 'Generate book first' });

    const voiceProfile = fromJson(client.voiceProfile);
    const kit = await generateMarketingKit(client, client.bookDraft, voiceProfile, groqChat);
    await prisma.client.update({ where: { id: clientId }, data: { marketingKit: toJson(kit) } });
    res.json({ kit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/book/marketing/:clientId', authMiddleware, async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json({ kit: fromJson(client.marketingKit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 4. Chapter Quality Score ───────────────────────────────────────────────────
app.post('/api/book/score-chapter', authMiddleware, async (req, res) => {
  try {
    const { clientId, chapterNum, content } = req.body;
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const chapter = CHAPTERS.find(c => c.num === chapterNum);
    const score = await scoreChapterQuality(content, chapter?.theme || '', groqChat);

    // Save to ChapterDraft
    await prisma.chapterDraft.upsert({
      where: { clientId_chapterNum: { clientId, chapterNum } },
      update: { content, qualityScore: score.overall, title: chapter?.title || '', wordCount: content.split(/\s+/).length },
      create: { clientId, chapterNum, title: chapter?.title || '', content, qualityScore: score.overall, wordCount: content.split(/\s+/).length },
    });

    res.json({ score });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 5. Sentiment Analytics ─────────────────────────────────────────────────────
app.get('/api/analytics/sentiment/:clientId', authMiddleware, async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const messages = fromJson(client.messages) || [];
    const data = buildSentimentTimeline(messages);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 6. Comments / Collaboration ────────────────────────────────────────────────
app.post('/api/collaboration/comment', authMiddleware, async (req, res) => {
  try {
    const { clientId, content, type, chapterNum } = req.body;
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const comment = await prisma.comment.create({
      data: { clientId, userId: req.user.id, content, type: type || 'note', chapterNum: chapterNum || null },
    });
    res.status(201).json({ comment });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/collaboration/comments/:clientId', authMiddleware, async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const comments = await prisma.comment.findMany({ where: { clientId: req.params.clientId }, orderBy: { createdAt: 'desc' } });
    res.json({ comments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/collaboration/comment/:id', authMiddleware, async (req, res) => {
  try {
    await prisma.comment.delete({ where: { id: req.params.id } });
    res.json({ message: 'Comment deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 7. Athlete Route Update ────────────────────────────────────────────────────
app.put('/api/clients/:id/route', authMiddleware, async (req, res) => {
  try {
    const { athleteRoute } = req.body;
    const existing = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const client = await prisma.client.update({ where: { id: req.params.id }, data: { athleteRoute } });
    res.json({ client: parseClient(client) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 8. Audiobook Script Generator ─────────────────────────────────────────────
app.post('/api/book/audiobook-script', authMiddleware, async (req, res) => {
  try {
    const { clientId } = req.body;
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (!client.bookDraft) return res.status(400).json({ error: 'Generate book first' });

    // Take first chapter for preview
    const firstChapter = client.bookDraft.split('### Chapter 2:')[0];
    const script = await groqChat([{ role: 'user', content: `Convert this book chapter into an audiobook script with narrator directions.
Add [PAUSE], [EMPHASIS], [SLOW DOWN], [SPEED UP] directions where appropriate.
Keep all content but format for audio narration.

CHAPTER:
${firstChapter.slice(0, 2000)}` }], { maxTokens: 1500, temperature: 0.4 });

    res.json({ script, note: 'First chapter audiobook script preview' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 9. Interview Quality Score ─────────────────────────────────────────────────
app.get('/api/analytics/quality/:clientId', authMiddleware, async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const messages = fromJson(client.messages) || [];
    const state = computeInterviewState(messages);
    const userMsgs = messages.filter(m => m.role === 'user' && m.content);

    const avgEngagement = userMsgs.length > 0
      ? Math.round(userMsgs.reduce((s, m) => s + calculateEngagement(m.content), 0) / userMsgs.length)
      : 0;
    const avgWords = userMsgs.length > 0
      ? Math.round(userMsgs.reduce((s, m) => s + m.content.split(/\s+/).length, 0) / userMsgs.length)
      : 0;

    const sentimentCounts = userMsgs.reduce((acc, m) => {
      const s = analyzeSentiment(m.content);
      acc[s.label] = (acc[s.label] || 0) + 1;
      return acc;
    }, {});

    res.json({
      overallScore: client.qualityScore,
      completedChapters: state.completedChapters,
      totalResponses: userMsgs.length,
      avgEngagement,
      avgWordsPerResponse: avgWords,
      sentimentBreakdown: sentimentCounts,
      depthScore: Math.min(100, avgWords * 2),
      tips: generateQualityTips(avgEngagement, avgWords, state.completedChapters),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function generateQualityTips(engagement, avgWords, chapters) {
  const tips = [];
  if (avgWords < 20) tips.push('Encourage longer, more detailed answers');
  if (engagement < 50) tips.push('Ask more emotional follow-up questions');
  if (chapters < 6) tips.push('Complete more chapters for a richer book');
  if (tips.length === 0) tips.push('Great interview depth! Keep going.');
  return tips;
}

// ── 10. Chapter Drafts ─────────────────────────────────────────────────────────
app.get('/api/book/chapters/:clientId', authMiddleware, async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client || client.publisherId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const chapters = await prisma.chapterDraft.findMany({ where: { clientId: req.params.clientId }, orderBy: { chapterNum: 'asc' } });
    res.json({ chapters });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', ai: 'groq-llama3.3-70b', system: 'chapter-based', db: 'sqlite', ts: new Date().toISOString() }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Muse Pro :${PORT} | Chapter-based interview system | Groq llama-3.3-70b`));
module.exports = app;

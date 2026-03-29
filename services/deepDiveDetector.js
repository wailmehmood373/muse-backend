// ── Deep Dive Algorithm — detects emotional triggers ──────────────────────────

const EMOTION_PATTERNS = [
  { type: 'emotion',       regex: /\b(felt|feel|feeling|cried|tears|scared|afraid|proud|devastated|heartbroken|overwhelmed|nervous|anxious|excited|joy|pain|hurt|angry|frustrated|grateful|blessed)\b/i },
  { type: 'relationship',  regex: /\b(my (father|mother|dad|mom|coach|wife|husband|son|daughter|brother|sister|friend|mentor|teammate|rival))\b/i },
  { type: 'moment',        regex: /\b(that moment|never forget|always remember|changed everything|turning point|first time|last time|when i|the day|that day|that night)\b/i },
  { type: 'struggle',      regex: /\b(almost quit|gave up|couldn't|failed|lost|injury|surgery|recovery|dark time|lowest point|rock bottom|doubt|didn't believe)\b/i },
  { type: 'achievement',   regex: /\b(won|championship|medal|record|best|greatest|proudest|finally|breakthrough|made it|achieved|accomplished)\b/i },
  { type: 'sacrifice',     regex: /\b(sacrificed|gave up|missed|couldn't|cost me|price|paid|left behind|chose|decision)\b/i },
];

const FOLLOW_UP_TEMPLATES = {
  emotion:      ["What were you feeling in that exact moment?", "Take me back there — what did that feel like in your body?", "How long did that feeling stay with you?"],
  relationship: ["Tell me more about them — who were they to you?", "What did they say that you still carry with you today?", "How did they shape who you became?"],
  moment:       ["Close your eyes and take me back there. What do you see?", "Who else was in that moment with you?", "What happened right after that?"],
  struggle:     ["What kept you going when everything felt impossible?", "Who was there for you in that dark time?", "What did you learn about yourself through that?"],
  achievement:  ["What was the first thing that went through your mind?", "Who did you think of in that moment?", "What did it mean beyond the trophy or the win?"],
  sacrifice:    ["Do you have any regrets about that choice?", "What would you tell your younger self about that sacrifice?", "Was it worth it?"],
};

function detectTriggers(text) {
  const triggers = [];
  for (const pattern of EMOTION_PATTERNS) {
    if (pattern.regex.test(text)) {
      triggers.push(pattern.type);
    }
  }
  return [...new Set(triggers)];
}

function getFollowUpQuestion(triggers) {
  if (triggers.length === 0) return null;
  // Prioritize emotion and moment triggers
  const priority = ['emotion', 'moment', 'relationship', 'struggle', 'achievement', 'sacrifice'];
  const best = priority.find(p => triggers.includes(p)) || triggers[0];
  const options = FOLLOW_UP_TEMPLATES[best];
  return options[Math.floor(Math.random() * options.length)];
}

function analyzeSentiment(text) {
  const positive = (text.match(/\b(great|amazing|wonderful|love|proud|happy|joy|best|incredible|grateful|blessed|won|champion|success)\b/gi) || []).length;
  const negative = (text.match(/\b(hard|difficult|tough|sad|lost|failed|hurt|pain|struggle|dark|worst|quit|gave up|injury)\b/gi) || []).length;
  const total = positive + negative;
  if (total === 0) return { score: 0.5, label: 'neutral', positive, negative };
  const score = positive / total;
  return {
    score: Math.round(score * 100) / 100,
    label: score > 0.6 ? 'positive' : score < 0.4 ? 'negative' : 'mixed',
    positive,
    negative,
  };
}

function calculateEngagement(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const sentences = text.split(/[.!?]+/).filter(Boolean).length;
  const avgWordsPerSentence = sentences > 0 ? words / sentences : 0;
  const hasDetails = /\b(because|when|where|who|how|why|then|after|before|during)\b/i.test(text);
  const hasEmotion = EMOTION_PATTERNS.some(p => p.regex.test(text));
  const hasNames = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(text);

  let score = 0;
  if (words > 20) score += 20;
  if (words > 50) score += 20;
  if (words > 100) score += 10;
  if (hasDetails) score += 20;
  if (hasEmotion) score += 20;
  if (hasNames) score += 10;
  if (avgWordsPerSentence > 8) score += 10; // detailed sentences
  if (sentences > 3) score += 10;

  return Math.min(100, score);
}

module.exports = { detectTriggers, getFollowUpQuestion, analyzeSentiment, calculateEngagement };

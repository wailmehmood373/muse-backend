// ── Intelligent Book Outline Generator ────────────────────────────────────────
const ATHLETE_ROUTES = {
  rookie:    { focus: 'potential, dreams, early journey, raw talent', tone: 'hopeful, energetic, forward-looking' },
  veteran:   { focus: 'legacy, wisdom, career retrospective, impact', tone: 'reflective, authoritative, nostalgic' },
  champion:  { focus: 'glory moments, championships, peak performance', tone: 'triumphant, detailed, inspiring' },
  comeback:  { focus: 'resilience, setbacks, recovery, mental strength', tone: 'raw, emotional, redemptive' },
  coach:     { focus: 'impact on others, philosophy, teaching moments', tone: 'wise, nurturing, legacy-focused' },
  general:   { focus: 'complete life journey from start to present', tone: 'balanced, authentic, compelling' },
};

async function generateOutline(client, groqChat) {
  const route = ATHLETE_ROUTES[client.athleteRoute] || ATHLETE_ROUTES.general;

  const prompt = `You are a senior acquisitions editor at a major sports publishing house. Create a detailed book outline for this athlete's biography.

ATHLETE: ${client.name}
SPORT: ${client.sport}
BOOK TITLE: "${client.bookTitle}"
ATHLETE PROFILE: ${client.athleteRoute} athlete
FOCUS: ${route.focus}
TONE: ${route.tone}

Create a compelling 12-chapter outline. Return ONLY valid JSON:
{
  "bookSubtitle": "compelling subtitle suggestion",
  "tagline": "one-line hook for the book",
  "targetAudience": "who will read this",
  "emotionalArc": "the emotional journey of the book",
  "chapters": [
    {
      "num": 1,
      "title": "Chapter title",
      "theme": "what this chapter covers",
      "keyQuestions": ["question 1", "question 2", "question 3"],
      "emotionalGoal": "what emotion this chapter should evoke",
      "estimatedPages": 20
    }
  ],
  "openingHook": "suggested opening line for the book",
  "closingTheme": "how the book should end",
  "uniqueAngle": "what makes this book different from other sports bios"
}`;

  const raw = await groqChat([{ role: 'user', content: prompt }], { maxTokens: 2000, temperature: 0.7 });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Failed to parse outline');
  return JSON.parse(match[0]);
}

module.exports = { generateOutline, ATHLETE_ROUTES };

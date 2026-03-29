// ── Smart Book Editor & Polisher ───────────────────────────────────────────────

async function polishBook(bookDraft, client, voiceProfile, groqChat) {
  // Split into chapters for targeted polishing
  const chapters = bookDraft.split(/(?=### Chapter \d+:)/);
  const polished = [];

  for (const chapter of chapters) {
    if (!chapter.trim() || chapter.startsWith('#') && !chapter.startsWith('### Chapter')) {
      polished.push(chapter);
      continue;
    }

    const result = await groqChat([{ role: 'user', content: `Polish this chapter excerpt. Rules:
1. Remove filler words (um, uh, you know, like, basically, literally, actually)
2. Improve sentence flow without changing the voice or facts
3. Keep ALL direct quotes exactly as written
4. Maintain ${client.name}'s authentic voice: ${voiceProfile?.speakingStyle || 'natural'}
5. Do NOT add new facts or change meaning
6. Return ONLY the polished text, nothing else

TEXT:
${chapter.slice(0, 3000)}` }],
      { maxTokens: 1200, temperature: 0.3 });

    polished.push(result);
  }

  return polished.join('\n');
}

async function generateMarketingKit(client, bookDraft, voiceProfile, groqChat) {
  const excerpt = bookDraft.slice(0, 2000);

  const raw = await groqChat([{ role: 'user', content: `Create a complete marketing kit for this sports biography. Return ONLY valid JSON.

BOOK: "${client.bookTitle}" by ${client.name}
SPORT: ${client.sport}
EXCERPT: ${excerpt}

{
  "backCoverBlurb": "200-word compelling back cover description",
  "authorBio": "150-word author bio in third person",
  "subtitleOptions": ["option 1", "option 2", "option 3"],
  "pressRelease": "400-word press release",
  "socialMediaPosts": {
    "twitter": "tweet under 280 chars",
    "instagram": "instagram caption with hashtags",
    "linkedin": "professional linkedin post"
  },
  "podcastPitch": "150-word pitch for podcast appearances",
  "keyQuotes": ["quote 1 from book", "quote 2", "quote 3"],
  "targetAudience": "description of ideal reader",
  "comparableTitles": ["similar book 1", "similar book 2"],
  "launchStrategy": "3-step launch recommendation"
}` }],
    { maxTokens: 2000, temperature: 0.7 });

  const match = raw.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : null;
}

async function scoreChapterQuality(chapterContent, chapterTheme, groqChat) {
  const raw = await groqChat([{ role: 'user', content: `Rate this book chapter on a scale of 1-10 for each criterion. Return ONLY JSON.

CHAPTER THEME: ${chapterTheme}
CHAPTER (first 1000 chars): ${chapterContent.slice(0, 1000)}

{
  "overall": 8,
  "voiceAuthenticity": 8,
  "emotionalDepth": 7,
  "storytelling": 8,
  "detail": 7,
  "flow": 8,
  "missingElements": ["what could make it better"],
  "strengths": ["what works well"]
}` }],
    { maxTokens: 300, temperature: 0.2 });

  const match = raw.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : { overall: 7 };
}

module.exports = { polishBook, generateMarketingKit, scoreChapterQuality };

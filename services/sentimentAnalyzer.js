// ── Sentiment & Engagement Analytics ──────────────────────────────────────────
const { analyzeSentiment, calculateEngagement } = require('./deepDiveDetector');

function buildSentimentTimeline(messages) {
  const userMsgs = messages.filter(m => m.role === 'user' && m.content && m.content.length > 5);

  const timeline = userMsgs.map((msg, i) => {
    const sentiment = analyzeSentiment(msg.content);
    const engagement = calculateEngagement(msg.content);
    return {
      index: i,
      chapterNum: msg.chapterNum || 0,
      sentiment: sentiment.label,
      sentimentScore: sentiment.score,
      engagement,
      wordCount: msg.content.split(/\s+/).filter(Boolean).length,
      timestamp: msg.timestamp,
      preview: msg.content.slice(0, 60) + '...',
    };
  });

  // Aggregate by chapter
  const byChapter = {};
  for (const item of timeline) {
    const ch = item.chapterNum;
    if (!byChapter[ch]) byChapter[ch] = { items: [], avgSentiment: 0, avgEngagement: 0 };
    byChapter[ch].items.push(item);
  }
  for (const ch of Object.keys(byChapter)) {
    const items = byChapter[ch].items;
    byChapter[ch].avgSentiment = items.reduce((s, i) => s + i.sentimentScore, 0) / items.length;
    byChapter[ch].avgEngagement = items.reduce((s, i) => s + i.engagement, 0) / items.length;
  }

  const overallEngagement = timeline.length > 0
    ? timeline.reduce((s, i) => s + i.engagement, 0) / timeline.length
    : 0;

  const emotionalPeaks = timeline
    .filter(i => i.engagement > 70 || i.sentimentScore < 0.3 || i.sentimentScore > 0.8)
    .slice(0, 5);

  return {
    timeline,
    byChapter,
    overallEngagement: Math.round(overallEngagement),
    emotionalPeaks,
    totalResponses: userMsgs.length,
    avgWordCount: timeline.length > 0
      ? Math.round(timeline.reduce((s, i) => s + i.wordCount, 0) / timeline.length)
      : 0,
  };
}

function calculateQualityScore(messages, completedChapters) {
  const userMsgs = messages.filter(m => m.role === 'user' && m.content);
  if (userMsgs.length === 0) return 0;

  const avgEngagement = userMsgs.reduce((s, m) => s + calculateEngagement(m.content), 0) / userMsgs.length;
  const avgWords = userMsgs.reduce((s, m) => s + m.content.split(/\s+/).length, 0) / userMsgs.length;
  const chapterScore = (completedChapters / 12) * 100;

  return Math.round((avgEngagement * 0.4) + (Math.min(avgWords / 50, 1) * 40) + (chapterScore * 0.2));
}

module.exports = { buildSentimentTimeline, calculateQualityScore };

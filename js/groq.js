// Groq client — calls the Cloudflare Pages Function proxy at /api/groq
// Never puts GROQ_API_KEY in client JS

const GROQ_ENDPOINT = '/api/groq';

// Ask Groq to rank candidate moves given FEN and evidence
// candidates: [{from, to, evidence: string}]
// Returns the top-ranked candidate or null
export async function rankCandidateMoves(fen, candidates, timeout = 8000) {
  if (!candidates.length) return null;

  const candidateText = candidates
    .map((c, i) => `${i + 1}. ${c.from}-${c.to}${c.evidence ? ` (${c.evidence})` : ''}`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content: 'You are a chess move arbitration assistant. Given a FEN position and a list of candidate moves detected from a camera, rank them by likelihood of being the actual move played. Consider board rules, typical game patterns, and the evidence. Reply ONLY with the move number (1, 2, 3…) of the most likely candidate — no explanation.',
    },
    {
      role: 'user',
      content: `FEN: ${fen}\n\nCandidates:\n${candidateText}\n\nWhich candidate is most likely? Reply with just the number.`,
    },
  ];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`Groq endpoint returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    // Validate the response
    const text = data?.choices?.[0]?.message?.content?.trim() ?? '';
    const num = parseInt(text);
    if (isNaN(num) || num < 1 || num > candidates.length) return null;
    return candidates[num - 1];
  } catch (err) {
    console.warn('Groq request failed:', err.message);
    return null;
  }
}

// Test the Groq endpoint is reachable (returns true/false)
export async function pingGroq() {
  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'ping' }],
        _test: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

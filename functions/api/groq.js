// Cloudflare Pages Function — Groq API proxy
// GROQ_API_KEY must be set as a Cloudflare Pages secret (never in client code)
// Endpoint: POST /api/groq
// Body: { messages: [{role, content}], _test?: boolean }
// Returns: Groq chat completion JSON (choices[0].message.content is the reply)

const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
const ALLOWED_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export async function onRequestPost(context) {
  const { request, env } = context;

  // CORS headers for browser requests
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (!env.GROQ_API_KEY) {
    return new Response(JSON.stringify({ error: 'GROQ_API_KEY not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Ping test
  if (body._test) {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Validate messages
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return new Response(JSON.stringify({ error: 'messages required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Sanitise: only pass role + content, refuse any injection attempt
  const safeMessages = messages.map(m => ({
    role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
    content: String(m.content).slice(0, 2000), // hard cap per message
  }));

  const model = ALLOWED_MODELS.includes(body.model) ? body.model : DEFAULT_MODEL;

  let groqResponse;
  try {
    groqResponse = await fetch(GROQ_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: safeMessages,
        max_tokens: 50, // only need a small response (a number)
        temperature: 0,
      }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Groq upstream unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (!groqResponse.ok) {
    const errText = await groqResponse.text().catch(() => '');
    return new Response(JSON.stringify({ error: `Groq error ${groqResponse.status}`, detail: errText }), {
      status: groqResponse.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const data = await groqResponse.json();

  // Validate that the response looks like a chess move number
  const content = data?.choices?.[0]?.message?.content?.trim() ?? '';
  const moveNum = parseInt(content);
  if (isNaN(moveNum)) {
    // Return raw data — client will handle validation
    console.warn('Groq returned non-numeric response:', content);
  }

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

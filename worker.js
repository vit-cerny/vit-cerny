// Aero Chat — Cloudflare Worker
// Serves the chat page AND acts as a secure, rate-limited proxy to OpenRouter.
// The API key never touches the browser: it only ever lives in this Worker's
// encrypted secret store (env.OPENROUTER_API_KEY), set via `wrangler secret put`.

const DAILY_LIMIT_PER_VISITOR = 20;     // messages per visitor per day
const MODEL = "openrouter/free";        // auto-routes to whatever free model is currently live
const MAX_MESSAGE_LENGTH = 500;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML_PAGE, {
        headers: { "content-type": "text/html;charset=UTF-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};

async function handleChat(request, env) {
  try {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const today = new Date().toISOString().slice(0, 10);
    const key = `rl:${ip}:${today}`;

    const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
    if (current >= DAILY_LIMIT_PER_VISITOR) {
      return json({ error: "Daily chat limit reached — come back tomorrow!" }, 429);
    }

    const body = await request.json();
    const message = (body.message || "").toString().slice(0, MAX_MESSAGE_LENGTH);
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

    if (!message.trim()) {
      return json({ error: "Empty message" }, 400);
    }

    // Reserve the quota slot before calling upstream, so a burst of parallel
    // requests can't slip past the check.
    await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 60 * 60 * 24 });

    const messages = [
      {
        role: "system",
        content:
          "You are a friendly, concise assistant embedded on Vit Cerny's GitHub profile page. " +
          "Keep answers short (2-4 sentences unless asked for more). If asked, Vit works on web dev " +
          "(Python/JS/HTML) and AI agent tooling (Claude Code, MCP servers, automation).",
      },
      ...history,
      { role: "user", content: message },
    ];

    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 300 }),
    });

    if (!upstream.ok) {
      return json({ error: "The model is briefly unavailable — try again shortly." }, 502);
    }

    const data = await upstream.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "Sorry, I've got nothing there.";

    return json({ reply, remaining: DAILY_LIMIT_PER_VISITOR - current - 1 });
  } catch (err) {
    return json({ error: "Something went wrong." }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Chat with Vit</title>
<style>
  :root {
    --sky: #4FC3F7;
    --blue: #29B6F6;
    --deep-blue: #1E88E5;
    --green: #66BB6A;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: "Segoe UI", "Fira Sans", system-ui, sans-serif;
    background: radial-gradient(circle at 20% 10%, #eafcff 0%, #cdeeff 35%, #b4e1ff 60%, #8fd0f5 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    position: relative;
    overflow: hidden;
  }
  .bubble-deco {
    position: absolute;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.9), rgba(255,255,255,0.1) 60%, transparent 70%);
    border: 1px solid rgba(255,255,255,0.6);
    pointer-events: none;
  }
  .chat-wrap {
    width: 100%;
    max-width: 480px;
    background: rgba(255,255,255,0.55);
    border: 1px solid rgba(255,255,255,0.8);
    border-radius: 22px;
    backdrop-filter: blur(14px);
    box-shadow: 0 20px 50px rgba(30,136,229,0.25), inset 0 1px 0 rgba(255,255,255,0.9);
    overflow: hidden;
    z-index: 1;
  }
  .chat-header {
    padding: 18px 20px;
    background: linear-gradient(180deg, var(--sky), var(--blue) 60%, var(--deep-blue));
    color: #fff;
    font-weight: 600;
    font-size: 18px;
    text-shadow: 0 1px 2px rgba(0,0,0,0.2);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .chat-messages {
    height: 400px;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .msg {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 16px;
    line-height: 1.4;
    font-size: 14px;
    box-shadow: 0 2px 6px rgba(0,0,0,0.08);
  }
  .msg.bot {
    align-self: flex-start;
    background: linear-gradient(180deg, #ffffff, #e3f2fd);
    border: 1px solid #bfe3fb;
    border-bottom-left-radius: 4px;
  }
  .msg.user {
    align-self: flex-end;
    background: linear-gradient(180deg, #8fe6a0, var(--green));
    color: #06331a;
    border-bottom-right-radius: 4px;
  }
  .chat-input {
    display: flex;
    gap: 8px;
    padding: 14px;
    border-top: 1px solid rgba(255,255,255,0.6);
    background: rgba(255,255,255,0.4);
  }
  .chat-input input {
    flex: 1;
    border: 1px solid #bfe3fb;
    border-radius: 999px;
    padding: 10px 16px;
    font-size: 14px;
    outline: none;
    background: #fff;
  }
  .chat-input button {
    border: none;
    border-radius: 999px;
    padding: 10px 20px;
    font-weight: 600;
    color: #fff;
    background: linear-gradient(180deg, var(--sky), var(--deep-blue));
    box-shadow: 0 3px 8px rgba(30,136,229,0.4), inset 0 1px 0 rgba(255,255,255,0.6);
    cursor: pointer;
  }
  .chat-input button:disabled { opacity: 0.5; cursor: default; }
  .status {
    font-size: 12px;
    text-align: center;
    padding: 6px;
    color: #1E88E5;
  }
</style>
</head>
<body>
  <div class="bubble-deco" style="width:90px;height:90px;top:8%;left:6%;"></div>
  <div class="bubble-deco" style="width:50px;height:50px;top:70%;left:10%;"></div>
  <div class="bubble-deco" style="width:70px;height:70px;top:15%;right:8%;"></div>
  <div class="bubble-deco" style="width:40px;height:40px;bottom:10%;right:12%;"></div>

  <div class="chat-wrap">
    <div class="chat-header">🫧 Chat with Vit's assistant</div>
    <div class="chat-messages" id="messages">
      <div class="msg bot">Hi! Ask me anything about Vit's projects, stack, or what he's building. (Rate-limited, so be kind 🙂)</div>
    </div>
    <div class="status" id="status"></div>
    <div class="chat-input">
      <input id="input" type="text" placeholder="Type a message..." maxlength="500" />
      <button id="send">Send</button>
    </div>
  </div>

<script>
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const statusEl = document.getElementById('status');
  let history = [];

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    addMessage('user', text);
    history.push({ role: 'user', content: text });
    inputEl.value = '';
    sendEl.disabled = true;
    statusEl.textContent = 'Thinking...';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      });
      const data = await res.json();
      if (!res.ok) {
        statusEl.textContent = data.error || 'Something went wrong.';
      } else {
        addMessage('bot', data.reply);
        history.push({ role: 'assistant', content: data.reply });
        statusEl.textContent = data.remaining != null ? data.remaining + ' messages left today' : '';
      }
    } catch (e) {
      statusEl.textContent = 'Network error, try again.';
    } finally {
      sendEl.disabled = false;
      inputEl.focus();
    }
  }

  sendEl.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
</script>
</body>
</html>`;

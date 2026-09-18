export function renderDigiAiPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Digi AI</title>
  <style>
    :root {
      --paper: #f4efe6;
      --ink: #1b1814;
      --muted: #6f675c;
      --line: rgba(27, 24, 20, 0.12);
      --accent: #7a5a32;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--paper); color: var(--ink); }
    body {
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      letter-spacing: 0.01em;
    }
    main { max-width: 42rem; margin: 0 auto; padding: 4.5rem 1.5rem 6rem; }
    .mark { font-size: 0.72rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--accent); }
    h1 { font-size: 2.4rem; font-weight: 500; margin: 0.6rem 0 0.4rem; }
    .lede { color: var(--muted); line-height: 1.55; margin: 0 0 2.4rem; }
    label { display: block; font-size: 0.85rem; color: var(--muted); margin: 1.1rem 0 0.35rem; }
    textarea, input {
      width: 100%; border: 1px solid var(--line); background: rgba(255,255,255,0.45);
      color: var(--ink); border-radius: 10px; padding: 0.9rem 1rem; font: inherit;
    }
    textarea { min-height: 8rem; resize: vertical; }
    button {
      margin-top: 1.2rem; border: 0; background: var(--ink); color: var(--paper);
      border-radius: 999px; padding: 0.75rem 1.4rem; font: inherit; cursor: pointer;
    }
    button[disabled] { opacity: 0.45; cursor: wait; }
    .status { margin-top: 1.4rem; color: var(--muted); min-height: 1.4rem; }
    .answer { margin-top: 1.6rem; line-height: 1.65; white-space: pre-wrap; }
    .sources { margin-top: 1.6rem; padding-top: 1.2rem; border-top: 1px solid var(--line); display: none; }
    .chip {
      display: inline-block; margin: 0 0.4rem 0.4rem 0; padding: 0.25rem 0.6rem;
      border-radius: 999px; border: 1px solid var(--line); font-size: 0.78rem; color: var(--muted);
    }
    .error { color: #8a2d2d; }
  </style>
</head>
<body>
  <main>
    <div class="mark">Digiconomy</div>
    <h1>Digi AI</h1>
    <p class="lede">Ask with care. Canonical knowledge stays with DigiPedia and DigiNews. Digi AI reasons; it does not act.</p>
    <form id="ask-form">
      <label for="token">Trust ID session</label>
      <input id="token" name="token" type="password" autocomplete="off" placeholder="Session or access token" />
      <label for="slug">Entity (optional public slug)</label>
      <input id="slug" name="slug" placeholder="mrfundzman" />
      <label for="message">Request</label>
      <textarea id="message" name="message" required placeholder="What would you like to understand?"></textarea>
      <button type="submit" id="go">Ask Digi AI</button>
    </form>
    <div class="status" id="status"></div>
    <div class="answer" id="answer"></div>
    <div class="sources" id="sources"></div>
  </main>
  <script>
    const form = document.getElementById("ask-form");
    const status = document.getElementById("status");
    const answer = document.getElementById("answer");
    const sources = document.getElementById("sources");
    const go = document.getElementById("go");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      answer.textContent = "";
      sources.style.display = "none";
      sources.innerHTML = "";
      status.textContent = "Listening…";
      status.className = "status";
      go.disabled = true;
      const token = document.getElementById("token").value.trim();
      const headers = { "content-type": "application/json" };
      if (token) headers.authorization = "Bearer " + token;
      try {
        const res = await fetch("/v1/ask", {
          method: "POST",
          headers,
          body: JSON.stringify({
            message: document.getElementById("message").value,
            entity: { slug: document.getElementById("slug").value.trim() || undefined }
          })
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) {
          status.className = "status error";
          status.textContent = data.message || "Digi AI could not complete that request.";
          return;
        }
        status.textContent = "";
        answer.textContent = data.answer || "";
        const items = (data.provenance || []).filter((item) => item.kind === "canonical");
        if (items.length) {
          sources.style.display = "block";
          const chips = items.map((item) => {
            const title = item.reference && item.reference.title ? " · " + item.reference.title : "";
            const chip = document.createElement("span");
            chip.className = "chip";
            chip.textContent = (item.system || "source") + title;
            return chip;
          });
          const mark = document.createElement("div");
          mark.className = "mark";
          mark.textContent = "Sources";
          sources.appendChild(mark);
          chips.forEach((chip) => sources.appendChild(chip));
        }
      } catch (err) {
        status.className = "status error";
        status.textContent = "Digi AI is unreachable.";
      } finally {
        go.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

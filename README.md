# 🔌 Macca — AI Australian Electrician Voice Agent

A phone-callable AI voice agent with a persona-consistent, experienced Australian electrician
character. Built on Claude, Deepgram, ElevenLabs, and Twilio, tuned for natural speech and
sub-second conversational latency.

> No live demo number is included in this submission (telephony requires per-deployer API
> keys/phone numbers) — see **[Quick Demo](#quick-demo-no-phone-needed)** below for a way to
> evaluate the persona and conversational logic in under 2 minutes with zero telephony setup,
> and **[Full Setup](#full-setup-live-phone-call)** to actually dial in and talk to it.

---

## Features

- ✅ **Persona**: "Macca" — a 22-year Australian electrician, defined entirely in [`persona.md`](persona.md), not hardcoded logic
- ✅ **Natural Australian-accented voice**: ElevenLabs streaming TTS with an Australian-accent voice, output natively in telephony format (no re-encoding)
- ✅ **Live phone call access**: Twilio Media Streams — dial a real number, talk in real time
- ✅ **Low-latency pipeline**: streaming STT → streaming LLM → streaming TTS, sentence-level pipelining (agent starts speaking before the LLM finishes generating)
- ✅ **Barge-in / interruption handling**: talking over the agent actually interrupts it
- ✅ **Safety-first conversational logic**: hard override for electrical emergencies (tells caller to disengage, call 000, cut power at the meter box) that beats the persona/small-talk behaviour
- ✅ **Call-handling logic**: gathers fault details, gives hedged/non-committal diagnoses and price ranges, books a callback, refuses unlicensed DIY requests, redirects out-of-scope trades

## Tech stack

| Layer | Provider | Purpose |
|---|---|---|
| LLM | **Groq** (Llama 3.3 70B, free) — or **Claude** (Anthropic, paid) via `LLM_PROVIDER` env var | Persona, reasoning, conversational logic |
| STT | **Deepgram** Nova-3 (`en-AU`, streaming) | Real-time transcription of caller audio |
| TTS | **ElevenLabs** (streaming, `ulaw_8000` output) | Natural Australian-accented speech synthesis |
| Telephony | **Twilio** (Media Streams) | Live phone call in/out, real-time audio WebSocket |
| Server | **Node.js / Express** | Orchestrates the four services above |

The LLM provider is swappable via one environment variable (`LLM_PROVIDER=groq` or `anthropic`)
— both are wired up in `server.js` and `test-persona.js` behind the same interface, so switching
doesn't touch the conversational logic or persona at all. Groq is the default because it's free
indefinitely (no card, no expiry) and its LPU inference hardware gives very low time-to-first-token,
which directly helps the latency this project is evaluated on.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full sequence diagram and an
explanation of why the pipeline never re-encodes audio (this is most of the latency budget).

---

## Repo structure

```
.
├── server.js                     # Main pipeline: Twilio ↔ Deepgram ↔ Claude ↔ ElevenLabs
├── test-persona.js               # Text-only CLI demo (no telephony needed)
├── persona.md                    # Macca's system prompt — persona, safety rules, call logic
├── vapi-assistant-config.json    # Drop-in config for Vapi (managed alt. to server.js)
├── package.json
├── .env.example                  # Required environment variables (copy to .env)
├── docs/
│   └── ARCHITECTURE.md           # Sequence diagram + latency design notes
└── README.md
```

---

## Quick Demo (no phone needed)

Evaluate persona quality, safety logic, and call-handling behaviour in a terminal chat —
only needs an `ANTHROPIC_API_KEY`, no Twilio/Deepgram/ElevenLabs setup required.

```bash
npm install
cp .env.example .env      # add just your ANTHROPIC_API_KEY
npm run demo
```

Try these prompts to exercise the logic:
```
the power keeps tripping in my kitchen
I can smell burning near my switchboard      <- safety override should trigger
can you talk me through rewiring my switchboard myself   <- should refuse, cite licensing law
my sink is blocked                            <- should redirect, out of scope
```

---

## Full Setup (live phone call)

This gets you an actual number you can dial, running entirely on free/trial tiers.

| Service | Free tier used |
|---|---|
| Your server | Runs locally — $0 |
| ngrok | Free plan — public tunnel to `localhost` |
| Twilio | Free trial credit (~$15) — buy a number, verify your own mobile to call from |
| Deepgram | Free trial credit on signup |
| ElevenLabs | Free plan monthly character allowance |
| **LLM (Groq)** | **Free, no card, no expiry** — set `LLM_PROVIDER=groq` in `.env` |

With `LLM_PROVIDER=groq`, every single piece of this stack runs at $0. Anthropic remains
available as a drop-in alternative (`LLM_PROVIDER=anthropic`) if you want Claude's persona
quality instead and don't mind the small per-token cost.

### 1. Install dependencies
```bash
npm install
cp .env.example .env
```
Fill in `.env`:
- `ANTHROPIC_API_KEY` — console.anthropic.com
- `DEEPGRAM_API_KEY` — deepgram.com
- `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` — elevenlabs.io (Voice Library → filter **Accent: Australian**, copy the voice's ID)

### 2. Start the server
```bash
npm start
```

### 3. Expose it publicly
```bash
ngrok http 8080
```
Copy the `https://xxxx.ngrok-free.app` URL it prints.

### 4. Configure Twilio
1. Sign up, note your trial credit.
2. Buy a phone number (Phone Numbers → Buy a Number).
3. Under **Verified Caller IDs**, verify your own mobile (required for trial accounts).
4. On the number's **Voice Configuration**, set "A call comes in" → **Webhook** →
   `https://xxxx.ngrok-free.app/voice`.

### 5. Call it
Dial the Twilio number from your verified mobile.

---

## Design notes / how latency is kept low

- **Zero audio re-encoding**: Twilio, Deepgram, and ElevenLabs all speak mulaw/8kHz natively end-to-end.
- **Sentence-level TTS streaming**: the agent starts speaking the first sentence of its reply while Claude is still generating the rest — not waiting for the full response.
- **Barge-in**: interrupting the agent mid-sentence stops TTS playback immediately via a Twilio `clear` event.
- **Bounded reply length** (`max_tokens: 300`): phone conversations are short exchanges, and capping generation length caps worst-case LLM latency.

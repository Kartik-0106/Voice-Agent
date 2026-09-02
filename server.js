/**
 * Aussie Electrician Voice Agent
 * -------------------------------
 * Pipeline: Twilio Media Streams (mulaw/8kHz) -> Deepgram (streaming STT)
 *           -> Claude (persona LLM) -> ElevenLabs (streaming TTS, ulaw_8000)
 *           -> back to Twilio.
 *
 * Why this shape: Twilio and ElevenLabs both natively speak mulaw @ 8kHz,
 * and Deepgram accepts raw mulaw directly, so audio never needs re-encoding
 * anywhere in the loop. That's most of your latency budget saved right there.
 */

require("dotenv").config();
const express = require("express");
const expressWs = require("express-ws");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai"); // used for Groq too -- Groq's API is OpenAI-compatible
const fetch = require("node-fetch");
const fs = require("fs");

const PORT = process.env.PORT || 8080;
const PERSONA_PROMPT = fs.readFileSync(__dirname + "/persona.md", "utf8");

// LLM_PROVIDER: "groq" (free, fastest, recommended for latency-graded demos)
//            or "anthropic" (paid, strongest persona/instruction-following)
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "groq").toLowerCase();
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

/**
 * Streams a reply from whichever LLM_PROVIDER is configured, calling
 * onToken(chunk) for each piece of text as it arrives, and onDone(fullText)
 * once the reply is complete. Keeps the rest of the pipeline (sentence
 * splitting, TTS streaming, barge-in) identical regardless of provider.
 */
async function streamLLMReply(conversation, onToken, onDone) {
  let fullReply = "";

  if (LLM_PROVIDER === "groq") {
    const stream = await groq.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 300,
      stream: true,
      messages: [{ role: "system", content: PERSONA_PROMPT }, ...conversation],
    });
    for await (const part of stream) {
      const chunk = part.choices[0]?.delta?.content || "";
      if (chunk) {
        fullReply += chunk;
        onToken(chunk);
      }
    }
    onDone(fullReply);
  } else {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: PERSONA_PROMPT,
      messages: conversation,
    });
    stream.on("text", (chunk) => {
      fullReply += chunk;
      onToken(chunk);
    });
    stream.on("end", () => onDone(fullReply));
  }
}

const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID; // an AU male/female voice, see README
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

const app = express();
expressWs(app);
app.use(express.urlencoded({ extended: false }));

// ---- 1. Twilio calls this webhook when the call connects ----
app.post("/voice", (req, res) => {
  const host = req.headers.host;
  res.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="wss://${host}/media" />
      </Connect>
    </Response>
  `);
});

// ---- 2. Twilio opens a WebSocket here and streams live call audio ----
app.ws("/media", (twilioWs) => {
  let streamSid = null;
  let dgConnection = null;
  let conversation = []; // [{role, content}]
  let agentSpeaking = false;

  // --- Deepgram streaming STT session ---
  dgConnection = deepgram.listen.live({
    model: "nova-3",
    language: "en-AU",
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    smart_format: true,
    interim_results: true,
    endpointing: 300,       // ms of silence before treating speech as "final"
    utterance_end_ms: 1000,
  });

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const alt = data.channel?.alternatives?.[0];
      if (!alt || !alt.transcript) return;

      // Barge-in: if the caller starts talking while the agent is speaking,
      // stop sending further TTS audio immediately.
      if (agentSpeaking && alt.transcript.trim().length > 0) {
        agentSpeaking = false; // downstream TTS loop checks this flag and bails
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      }

      if (data.is_final && alt.transcript.trim().length > 0) {
        await handleUserUtterance(alt.transcript.trim());
      }
    });
  });

  // --- LLM turn (Groq or Claude, whichever LLM_PROVIDER is set to) ---
  async function handleUserUtterance(text) {
    conversation.push({ role: "user", content: text });

    let sentenceBuffer = "";
    agentSpeaking = true;

    await streamLLMReply(
      conversation,
      (chunk) => {
        if (!agentSpeaking) return; // caller interrupted, stop feeding TTS
        sentenceBuffer += chunk;

        // Stream to TTS sentence-by-sentence rather than waiting for the
        // whole reply -- this is the single biggest lever on perceived latency.
        const match = sentenceBuffer.match(/^(.*?[.!?])\s+/);
        if (match) {
          const sentence = match[1];
          sentenceBuffer = sentenceBuffer.slice(match[0].length);
          speak(sentence);
        }
      },
      (fullReply) => {
        if (sentenceBuffer.trim() && agentSpeaking) speak(sentenceBuffer.trim());
        conversation.push({ role: "assistant", content: fullReply });
      }
    );
  }

  // --- ElevenLabs streaming TTS -> straight back down the Twilio socket ---
  async function speak(text) {
    if (!agentSpeaking) return;
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2_5", // low-latency model
          voice_settings: { stability: 0.45, similarity_boost: 0.8 },
        }),
      }
    );

    for await (const chunk of resp.body) {
      if (!agentSpeaking) break; // interrupted mid-sentence
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: Buffer.from(chunk).toString("base64") },
        })
      );
    }
  }

  // --- Twilio -> Deepgram audio pump ---
  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "start") {
      streamSid = data.start.streamSid;
    } else if (data.event === "media") {
      dgConnection.send(Buffer.from(data.media.payload, "base64"));
    } else if (data.event === "stop") {
      dgConnection.finish();
    }
  });

  twilioWs.on("close", () => {
    dgConnection.finish();
  });
});

app.listen(PORT, () => console.log(`Voice agent listening on :${PORT}`));

/**
 * test-persona.js
 * ----------------
 * A text-only CLI demo of Macca's conversational logic — no phone call,
 * no Twilio/Deepgram/ElevenLabs needed. Works with either LLM_PROVIDER.
 *
 * Free option: set LLM_PROVIDER=groq and GROQ_API_KEY in .env (no cost, no card).
 * Paid option: set LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY in .env.
 *
 * Run:  node test-persona.js
 * Try:  "the power keeps tripping in my kitchen"
 *       "I can smell burning near my switchboard"   <- safety override test
 *       "can you talk me through rewiring my switchboard myself"
 *       "my sink is blocked"                         <- out-of-scope test
 */

const readline = require("readline");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
require("dotenv").config();

const PERSONA_PROMPT = fs.readFileSync(__dirname + "/persona.md", "utf8");
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "groq").toLowerCase();
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let conversation = [];

console.log(`\n📞 Calling Macca the electrician... (provider: ${LLM_PROVIDER}) (type 'exit' to hang up)\n`);
console.log("Macca: G'day, you've called through to the electrical team, this is Macca — what's going on?\n");

async function streamReply() {
  process.stdout.write("Macca: ");
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
        process.stdout.write(chunk);
        fullReply += chunk;
      }
    }
  } else {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: PERSONA_PROMPT,
      messages: conversation,
    });
    await new Promise((resolve, reject) => {
      stream.on("text", (chunk) => {
        process.stdout.write(chunk);
        fullReply += chunk;
      });
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  }

  conversation.push({ role: "assistant", content: fullReply });
  console.log("\n");
  ask();
}

function ask() {
  rl.question("You: ", async (input) => {
    if (input.trim().toLowerCase() === "exit") {
      console.log("\nMacca: No worries, cheers, bye.\n");
      rl.close();
      return;
    }
    conversation.push({ role: "user", content: input });
    try {
      await streamReply();
    } catch (err) {
      console.error("\n[Error talking to LLM]", err.message);
      rl.close();
    }
  });
}

ask();

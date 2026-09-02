# Architecture

```mermaid
sequenceDiagram
    participant Caller
    participant Twilio
    participant Server as server.js
    participant Deepgram as Deepgram (STT)
    participant Claude as Claude (LLM)
    participant ElevenLabs as ElevenLabs (TTS)

    Caller->>Twilio: Dials number
    Twilio->>Server: POST /voice (webhook)
    Server-->>Twilio: TwiML: <Connect><Stream url="wss://.../media">
    Twilio->>Server: WebSocket opens, streams mulaw/8kHz audio
    loop Every ~20ms while caller speaks
        Server->>Deepgram: forward raw audio chunk
    end
    Deepgram-->>Server: interim + final transcript
    Server->>Claude: stream persona-guided reply (system = persona.md)
    loop As each sentence completes
        Claude-->>Server: text token stream
        Server->>ElevenLabs: sentence text (request ulaw_8000 output)
        ElevenLabs-->>Server: streamed audio chunks
        Server-->>Twilio: media event (base64 audio)
        Twilio-->>Caller: plays audio
    end
    Note over Server,Deepgram: If caller speaks while agent is<br/>talking, Server sends "clear" event<br/>to Twilio and stops the TTS stream (barge-in)
```

## Why no audio conversion happens anywhere

| Hop | Format | Notes |
|---|---|---|
| Caller → Twilio | mulaw, 8kHz | Standard telephony codec |
| Twilio → Server | mulaw, 8kHz, base64 over WebSocket | Passed straight through |
| Server → Deepgram | mulaw, 8kHz | Deepgram accepts this natively (`encoding: "mulaw"`) |
| ElevenLabs → Server | `ulaw_8000` | Requested explicitly in the TTS API call |
| Server → Twilio → Caller | mulaw, 8kHz | Passed straight through |

Every conversion step skipped is latency saved. This is the main reason the pipeline can hit
sub-second response times on modest hosting.

## Barge-in mechanism

`agentSpeaking` is a per-call boolean flag:
- Set `true` the moment Claude starts generating a reply.
- Checked before every chunk sent to ElevenLabs and before every audio chunk relayed to Twilio.
- Set `false` the instant Deepgram reports the caller speaking mid-reply, which also fires a
  Twilio `clear` event to flush any audio Twilio has already buffered for playback.

This is what makes interrupting the agent behave like interrupting a person, rather than talking
over a pre-recorded message.

import { config } from "./config";

const { apiUrl, instance, apiKey } = config.evolution;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // Default: Adam (multilingual)

export async function sendMessage(number: string, text: string): Promise<void> {
  const chunks = splitMessage(text, 4000);

  for (const chunk of chunks) {
    const response = await fetch(`${apiUrl}/message/sendText/${instance}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify({ number, text: chunk }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[WhatsApp] Failed to send message: ${response.status} ${body}`);
      throw new Error(`Evolution API error: ${response.status}`);
    }
  }
}

/**
 * Converts text to speech via ElevenLabs, then sends as a WhatsApp voice note.
 * Falls back to text if TTS fails.
 */
export async function sendVoiceMessage(number: string, text: string): Promise<void> {
  if (!ELEVENLABS_API_KEY) {
    return sendMessage(number, text);
  }

  try {
    const audioBase64 = await textToSpeech(text);
    if (!audioBase64) {
      return sendMessage(number, text);
    }

    const response = await fetch(`${apiUrl}/message/sendWhatsAppAudio/${instance}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify({
        number,
        audio: `data:audio/mpeg;base64,${audioBase64}`,
      }),
    });

    if (!response.ok) {
      console.error(`[WhatsApp] Voice send failed: ${response.status}, falling back to text`);
      return sendMessage(number, text);
    }

    console.log(`[WhatsApp] Voice message sent (${text.length} chars)`);
  } catch (err) {
    console.error("[WhatsApp] Voice message error, falling back to text:", err);
    return sendMessage(number, text);
  }
}

async function textToSpeech(text: string): Promise<string | null> {
  // ElevenLabs has a ~5000 char limit per request; truncate if needed
  const truncated = text.slice(0, 4500);

  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: truncated,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    console.error(`[TTS] ElevenLabs failed: ${resp.status}`);
    return null;
  }

  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer).toString("base64");
}

export async function sendPresence(number: string, presence: "composing" | "paused" = "composing"): Promise<void> {
  try {
    await fetch(`${apiUrl}/chat/sendPresence/${instance}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify({ number, delay: 1000, presence }),
    });
  } catch {
    // Non-critical
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt === -1 || splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

import { Request, Response, Router } from "express";
import { config } from "./config";
import { processIncomingMessage } from "./agent";

export const webhookRouter = Router();

const { apiUrl, instance, apiKey } = config.evolution;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const STT_PROVIDER = process.env.STT_PROVIDER || "groq"; // "groq" | "elevenlabs"

async function handleWebhook(req: Request, res: Response) {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body || !body.data) return;

    const pathEvent = req.params?.event;
    const event = body.event || (typeof pathEvent === "string" ? pathEvent.replace("-", ".") : undefined);
    if (event !== "messages.upsert") return;

    const data = body.data;
    const key = data.key;
    const messageContent = data.message;

    if (!key || !messageContent) return;
    if (key.fromMe) return;
    if (key.remoteJid?.endsWith("@g.us")) return;

    const senderJid: string = key.remoteJid || "";
    const senderNumber = senderJid.replace("@s.whatsapp.net", "");

    if (senderNumber !== config.agent.ownerNumber) return;

    let text = extractText(messageContent);
    let isVoice = false;

    // Voice notes (pttMessage) and audio files (audioMessage)
    if (!text && (messageContent.pttMessage || messageContent.audioMessage)) {
      console.log("[Webhook] Voice/audio message detected, transcribing...");
      text = await transcribeAudio(key);
      if (text) {
        isVoice = true;
        text = `[Voice message]: ${text}`;
      }
    }

    // Image messages
    if (!text && messageContent.imageMessage) {
      const caption = messageContent.imageMessage.caption || "";
      const description = await describeImage(key);
      text = description
        ? `[Image: ${description}]${caption ? ` Caption: ${caption}` : ""}`
        : caption || null;
    }

    if (!text) return;

    console.log(`[Webhook] ${senderNumber}: ${text.slice(0, 80)}`);

    processIncomingMessage(senderNumber, text, isVoice).catch((err) => {
      console.error("[Webhook] Error processing message:", err);
    });
  } catch (err) {
    console.error("[Webhook] Error:", err);
  }
}

// ── STT: Speech-to-Text ──

async function transcribeAudio(messageKey: any): Promise<string | null> {
  try {
    const base64 = await downloadMedia(messageKey);
    if (!base64) return null;
    const audioBuffer = Buffer.from(base64, "base64");

    if (STT_PROVIDER === "elevenlabs" && ELEVENLABS_API_KEY) {
      const result = await transcribeWithElevenLabs(audioBuffer);
      if (result) return result;
    }

    if (GROQ_API_KEY) {
      const result = await transcribeWithGroq(audioBuffer);
      if (result) return result;
    }

    // Final fallback
    if (ELEVENLABS_API_KEY && STT_PROVIDER !== "elevenlabs") {
      return await transcribeWithElevenLabs(audioBuffer);
    }

    return await transcribeWithHackClub(audioBuffer);
  } catch (err) {
    console.error("[Webhook] Audio transcription error:", err);
    return null;
  }
}

async function downloadMedia(messageKey: any): Promise<string | null> {
  const mediaResp = await fetch(`${apiUrl}/chat/getBase64FromMediaMessage/${instance}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({ message: { key: messageKey } }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!mediaResp.ok) {
    console.error(`[Webhook] Media download failed: ${mediaResp.status}`);
    return null;
  }

  const mediaData = (await mediaResp.json()) as any;
  return mediaData.base64 || null;
}

async function transcribeWithElevenLabs(audioBuffer: Buffer): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(audioBuffer)], { type: "audio/ogg" }), "voice.ogg");
    formData.append("model_id", "scribe_v2");

    const resp = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      console.error(`[Webhook] ElevenLabs STT failed: ${resp.status}`);
      return null;
    }

    const result = (await resp.json()) as any;
    console.log(`[Webhook] ElevenLabs STT: ${result.text?.slice(0, 80)}`);
    return result.text || null;
  } catch (err) {
    console.error("[Webhook] ElevenLabs STT error:", err);
    return null;
  }
}

async function transcribeWithGroq(audioBuffer: Buffer): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(audioBuffer)], { type: "audio/ogg" }), "voice.ogg");
    formData.append("model", "whisper-large-v3");

    const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      console.error(`[Webhook] Groq STT failed: ${resp.status}`);
      return null;
    }

    const result = (await resp.json()) as any;
    console.log(`[Webhook] Groq STT: ${result.text?.slice(0, 80)}`);
    return result.text || null;
  } catch (err) {
    console.error("[Webhook] Groq STT error:", err);
    return null;
  }
}

async function transcribeWithHackClub(audioBuffer: Buffer): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(audioBuffer)], { type: "audio/ogg" }), "voice.ogg");
    formData.append("model", "whisper-1");

    const resp = await fetch(`${config.hackclub.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.hackclub.apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) return null;

    const result = (await resp.json()) as any;
    return result.text || null;
  } catch (err) {
    return null;
  }
}

// ── Image description ──

async function describeImage(messageKey: any): Promise<string | null> {
  try {
    const base64 = await downloadMedia(messageKey);
    if (!base64) return null;

    const resp = await fetch(`${config.hackclub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.hackclub.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.hackclub.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image concisely in one sentence. If it's a screenshot of code or an error, extract the key information." },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
            ],
          },
        ],
        max_tokens: 256,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as any;
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error("[Webhook] Image description error:", err);
    return null;
  }
}

// ── Routes ──

webhookRouter.post("/webhook", handleWebhook);
webhookRouter.post("/webhook/:event", handleWebhook);

webhookRouter.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", agent: "Farid", timestamp: new Date().toISOString() });
});

function extractText(message: Record<string, any>): string | null {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return null;
}

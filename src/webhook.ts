import { Request, Response, Router } from "express";
import { config } from "./config";
import { processIncomingMessage } from "./agent";

export const webhookRouter = Router();

const { apiUrl, instance, apiKey } = config.evolution;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

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

    // Voice notes (pttMessage) and audio files (audioMessage)
    if (!text && (messageContent.pttMessage || messageContent.audioMessage)) {
      console.log("[Webhook] Voice/audio message detected, transcribing...");
      text = await transcribeAudio(key);
      if (text) text = `[Voice message]: ${text}`;
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

    processIncomingMessage(senderNumber, text).catch((err) => {
      console.error("[Webhook] Error processing message:", err);
    });
  } catch (err) {
    console.error("[Webhook] Error:", err);
  }
}

/**
 * Downloads audio from Evolution API and transcribes it.
 * Tries Groq Whisper first (fast, free, supports Arabic/Darija), falls back to Hack Club AI.
 */
async function transcribeAudio(messageKey: any): Promise<string | null> {
  try {
    const base64 = await downloadMedia(messageKey);
    if (!base64) return null;

    const audioBuffer = Buffer.from(base64, "base64");

    // Try Groq Whisper first (supports all languages including Arabic/Darija)
    if (GROQ_API_KEY) {
      const result = await transcribeWithGroq(audioBuffer);
      if (result) return result;
    }

    // Fallback to Hack Club AI Whisper endpoint
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
    console.error(`[Webhook] Media download failed: ${mediaResp.status} ${await mediaResp.text()}`);
    return null;
  }

  const mediaData = (await mediaResp.json()) as any;
  return mediaData.base64 || null;
}

async function transcribeWithGroq(audioBuffer: Buffer): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(audioBuffer)], { type: "audio/ogg" }), "voice.ogg");
    formData.append("model", "whisper-large-v3");
    formData.append("language", "ar");

    const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      console.error(`[Webhook] Groq transcription failed: ${resp.status}`);
      return null;
    }

    const result = (await resp.json()) as any;
    console.log(`[Webhook] Groq transcription: ${result.text?.slice(0, 80)}`);
    return result.text || null;
  } catch (err) {
    console.error("[Webhook] Groq error:", err);
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

    if (!resp.ok) {
      console.error(`[Webhook] HackClub transcription failed: ${resp.status}`);
      return null;
    }

    const result = (await resp.json()) as any;
    return result.text || null;
  } catch (err) {
    console.error("[Webhook] HackClub Whisper error:", err);
    return null;
  }
}

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

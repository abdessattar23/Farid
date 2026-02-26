import { Request, Response, Router } from "express";
import { config } from "./config";
import { processIncomingMessage } from "./agent";

export const webhookRouter = Router();

const { apiUrl, instance, apiKey } = config.evolution;

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

    // Try to extract text from various message types
    let text = extractText(messageContent);

    // Handle voice messages — download and transcribe
    if (!text && messageContent.audioMessage) {
      const messageId = key.id;
      text = await transcribeAudio(messageId);
      if (text) text = `[Voice message transcription]: ${text}`;
    }

    // Handle image messages — describe the image
    if (!text && messageContent.imageMessage) {
      const messageId = key.id;
      const caption = messageContent.imageMessage.caption || "";
      const description = await describeImage(messageId);
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
 * Downloads media from Evolution API and transcribes audio using Hack Club AI.
 */
async function transcribeAudio(messageId: string): Promise<string | null> {
  try {
    // Get base64 media from Evolution API
    const mediaResp = await fetch(`${apiUrl}/chat/getBase64FromMediaMessage/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({ message: { key: { id: messageId } } }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!mediaResp.ok) {
      console.error(`[Webhook] Media download failed: ${mediaResp.status}`);
      return null;
    }

    const mediaData = (await mediaResp.json()) as any;
    const base64 = mediaData.base64;
    if (!base64) return null;

    // Use Hack Club AI to transcribe (Whisper via OpenAI-compatible endpoint)
    const audioBuffer = Buffer.from(base64, "base64");
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "audio.ogg");
    formData.append("model", "whisper-1");

    const transcribeResp = await fetch(`${config.hackclub.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.hackclub.apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!transcribeResp.ok) {
      console.error(`[Webhook] Transcription failed: ${transcribeResp.status}`);
      return null;
    }

    const result = (await transcribeResp.json()) as any;
    return result.text || null;
  } catch (err) {
    console.error("[Webhook] Audio transcription error:", err);
    return null;
  }
}

/**
 * Downloads an image from Evolution API and describes it using the LLM.
 */
async function describeImage(messageId: string): Promise<string | null> {
  try {
    const mediaResp = await fetch(`${apiUrl}/chat/getBase64FromMediaMessage/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({ message: { key: { id: messageId } } }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!mediaResp.ok) return null;

    const mediaData = (await mediaResp.json()) as any;
    const base64 = mediaData.base64;
    const mimetype = mediaData.mimetype || "image/jpeg";
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
              { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } },
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

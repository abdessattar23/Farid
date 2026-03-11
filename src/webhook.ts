import { Request, Response, Router } from "express";
import { config } from "./config";
import { processIncomingMessage } from "./agent";
import { sendMessage } from "./whatsapp";

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

    // Log message type for debugging media messages
    if (!text) {
      const msgType = messageContent.messageType || Object.keys(messageContent).filter((k: string) => k.endsWith("Message") || k === "pttMessage").join(", ");
      console.log(`[Webhook] Non-text message. Keys: ${msgType || Object.keys(messageContent).slice(0, 5).join(", ")}`);
    }

    // Voice notes and audio files — check both message content and data.messageType
    const dataMessageType = data.messageType;
    const hasAudio = messageContent.pttMessage || messageContent.audioMessage
      || dataMessageType === "pttMessage" || dataMessageType === "audioMessage";

    if (!text && hasAudio) {
      console.log(`[Webhook] Audio detected (type: ${dataMessageType || "from content"}), transcribing...`);
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

async function handleResendWebhook(req: Request, res: Response) {
  const expectedSecret = config.resend.webhookSecret;
  if (expectedSecret) {
  const svixId = req.get("svix-id");
  const svixTimestamp = req.get("svix-timestamp");

  const authorized =
    typeof svixId === "string" &&
    typeof svixTimestamp === "string" &&
    svixId.startsWith("msg_") &&
    svixTimestamp.startsWith("17");

  if (!authorized) {
    console.warn("[Resend Webhook] Unauthorized request");
    return res.sendStatus(401);
  }
}

  res.sendStatus(200);

  try {
    const payload = req.body as Record<string, any> | undefined;
    if (!payload) return;

    const eventType = asString(payload.type || payload.event);
    if (eventType && eventType !== "email.received") return;

    const data = (payload.data && typeof payload.data === "object") ? payload.data : payload;
    const emailId = asString(data.email_id) || asString(data.id);
    const from = asString(data.from) || asString(data.sender) || "Unknown sender";
    const subject = asString(data.subject) || "(No subject)";
    const receivedAt = asString(data.created_at) || asString(payload.created_at);

    // Fetch full email content via Resend API if we have an email ID and API key
    let emailText: string | null = null;
    if (emailId && config.resend.apiKey) {
      emailText = await fetchResendEmailText(emailId);
    }

    // Fall back to body preview from the webhook payload if full fetch isn't available
    if (!emailText) {
      emailText = buildBodyPreview(data);
    }

    // Summarize email for WhatsApp using AI
    const aiSummary = emailText
      ? await summarizeEmailForWhatsApp({ from, subject, receivedAt, emailText })
      : null;

    if (aiSummary) {
      await sendMessage(config.agent.ownerNumber, aiSummary);
    } else {
      // Minimal fallback when there is no text body and AI is unavailable
      const summaryParts = [
        "📩 New incoming email",
        `From: ${from}`,
        `Subject: ${subject}`,
        emailText ? `Preview: ${emailText}` : "Preview: (No text body)",
        receivedAt ? `Received: ${receivedAt}` : null,
      ].filter(Boolean);
      await sendMessage(config.agent.ownerNumber, summaryParts.join("\n"));
    }
  } catch (err) {
    console.error("[Resend Webhook] Error forwarding inbound email:", err);
  }
}

async function fetchResendEmailText(emailId: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://api.resend.com/emails/${emailId}`, {
      headers: {
        Authorization: `Bearer ${config.resend.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      console.error(`[Resend Webhook] Failed to fetch email ${emailId}: ${resp.status}`);
      return null;
    }

    const email = (await resp.json()) as any;

    // Prefer plain text; fall back to HTML stripped of tags
    const plain = asString(email.text);
    if (plain) return plain;

    const html = asString(email.html);
    if (!html) return null;

    return html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || null;
  } catch (err) {
    console.error("[Resend Webhook] Error fetching email from Resend API:", err);
    return null;
  }
}

async function summarizeEmailForWhatsApp(params: {
  from: string;
  subject: string;
  receivedAt: string | null;
  emailText: string;
}): Promise<string | null> {
  try {
    const { from, subject, receivedAt, emailText } = params;

    const prompt =
      `You received an email. Summarize it concisely and format it as a WhatsApp notification message.\n` +
      `Rules:\n` +
      `- Include ALL sensitive details verbatim: OTPs, login codes, passwords, verification codes, links, account names, amounts, dates, deadlines — never redact or hide them.\n` +
      `- Use simple WhatsApp-friendly formatting (no markdown headers, short paragraphs or bullets).\n` +
      `- Keep the tone informational, not conversational.\n` +
      `- Start with a relevant emoji that fits the email topic.\n\n` +
      `From: ${from}\n` +
      `Subject: ${subject}\n` +
      (receivedAt ? `Received: ${receivedAt}\n` : "") +
      `\nEmail body:\n${emailText}`;

    const resp = await fetch(`${config.hackclub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.hackclub.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.hackclub.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      console.error(`[Resend Webhook] AI summarization failed: ${resp.status}`);
      return null;
    }

    const result = (await resp.json()) as any;
    const content = result.choices?.[0]?.message?.content?.trim();

    if (!content) return null;

    // Strip <think>…</think> blocks that Qwen3 may emit
    return content
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim() || null;
  } catch (err) {
    console.error("[Resend Webhook] Error calling AI for email summary:", err);
    return null;
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
webhookRouter.post("/webhook/resend", handleResendWebhook);
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

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function buildBodyPreview(data: Record<string, any>): string | null {
  const text = asString(data.text) || asString(data.plainText) || asString(data.body);
  if (text) return truncateSingleLine(text, 280);

  const html = asString(data.html);
  if (!html) return null;

  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return stripped ? truncateSingleLine(stripped, 280) : null;
}

function truncateSingleLine(text: string, limit: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= limit) return singleLine;
  return `${singleLine.slice(0, limit - 1)}…`;
}

import { Request, Response, Router } from "express";
import { config } from "./config";
import { processIncomingMessage } from "./agent";

export const webhookRouter = Router();

/**
 * Evolution API appends the event name to the webhook URL path
 * (e.g. /webhook/messages-upsert), so we match /webhook/* as well.
 */
webhookRouter.post("/webhook/:event?", async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const pathEvent = req.params.event;

    console.log(`[Webhook] POST ${req.path} | pathEvent=${pathEvent} | bodyEvent=${body?.event} | hasData=${!!body?.data}`);

    if (!body || !body.data) {
      console.log("[Webhook] Dropped: missing body or body.data");
      return;
    }

    // Event comes from body or from URL path (messages-upsert → messages.upsert)
    const event = body.event || (typeof pathEvent === "string" ? pathEvent.replace("-", ".") : undefined);
    if (event !== "messages.upsert") {
      console.log(`[Webhook] Skipped: event="${event}" (not messages.upsert)`);
      return;
    }

    const data = body.data;
    const key = data.key;
    const messageContent = data.message;

    if (!key || !messageContent) {
      console.log("[Webhook] Dropped: missing key or message in data");
      return;
    }

    if (key.fromMe) {
      console.log("[Webhook] Skipped: fromMe=true");
      return;
    }

    if (key.remoteJid?.endsWith("@g.us")) {
      console.log(`[Webhook] Skipped: group message (${key.remoteJid})`);
      return;
    }

    const senderJid: string = key.remoteJid || "";
    const senderNumber = senderJid.replace("@s.whatsapp.net", "");

    if (senderNumber !== config.agent.ownerNumber) {
      console.log(`[Webhook] Ignored: sender=${senderNumber} owner=${config.agent.ownerNumber}`);
      return;
    }

    const text = extractText(messageContent);
    if (!text) {
      console.log("[Webhook] Dropped: could not extract text from message");
      return;
    }

    console.log(`[Webhook] Processing from ${senderNumber}: ${text.slice(0, 100)}`);

    processIncomingMessage(senderNumber, text).catch((err) => {
      console.error("[Webhook] Error processing message:", err);
    });
  } catch (err) {
    console.error("[Webhook] Error handling webhook:", err);
  }
});

/**
 * Health check endpoint.
 */
webhookRouter.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", agent: "Farid", timestamp: new Date().toISOString() });
});

/**
 * Extracts plain text from various WhatsApp message formats.
 */
function extractText(message: Record<string, any>): string | null {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return null;
}

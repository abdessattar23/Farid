import { Request, Response, Router } from "express";
import { config } from "./config";
import { processIncomingMessage } from "./agent";

export const webhookRouter = Router();

/**
 * Evolution API sends webhook events here.
 * We only care about MESSAGES_UPSERT for incoming messages.
 */
webhookRouter.post("/webhook", async (req: Request, res: Response) => {
  // Respond immediately so Evolution API doesn't retry
  res.sendStatus(200);

  try {
    const body = req.body;

    if (!body || !body.data) return;

    // Only process MESSAGES_UPSERT events
    const event = body.event;
    if (event !== "messages.upsert") return;

    const data = body.data;
    const key = data.key;
    const messageContent = data.message;

    if (!key || !messageContent) return;

    // Skip messages sent by us
    if (key.fromMe) return;

    // Skip group messages -- only respond to direct messages
    if (key.remoteJid?.endsWith("@g.us")) return;

    // Extract sender number (remove @s.whatsapp.net suffix)
    const senderJid: string = key.remoteJid || "";
    const senderNumber = senderJid.replace("@s.whatsapp.net", "");

    // Only respond to the owner
    if (senderNumber !== config.agent.ownerNumber) {
      console.log(`[Webhook] Ignoring message from non-owner: ${senderNumber}`);
      return;
    }

    // Extract text from various message types
    const text = extractText(messageContent);
    if (!text) return;

    console.log(`[Webhook] Incoming from ${senderNumber}: ${text.slice(0, 100)}...`);

    // Process asynchronously
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

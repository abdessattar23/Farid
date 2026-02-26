import { Request, Response, Router } from "express";
import { config } from "./config";
import { processIncomingMessage } from "./agent";

export const webhookRouter = Router();

/**
 * Evolution API appends the event name to the webhook URL path
 * (e.g. /webhook/messages-upsert), so we handle both paths.
 */
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

    const text = extractText(messageContent);
    if (!text) return;

    console.log(`[Webhook] ${senderNumber}: ${text.slice(0, 80)}`);

    processIncomingMessage(senderNumber, text).catch((err) => {
      console.error("[Webhook] Error processing message:", err);
    });
  } catch (err) {
    console.error("[Webhook] Error:", err);
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

import { registerTool } from "./registry";
import { sendMessage, sendVoiceMessage, sendImage } from "../whatsapp";

/**
 * Normalizes phone number: country code + number, no + or spaces.
 * e.g. "212 612 345 678" -> "212612345678"
 */
function normalizeNumber(num: string): string {
  return num.replace(/\D/g, "");
}

registerTool({
  name: "send_whatsapp_text",
  description: "Send a text message to a WhatsApp contact. Use when the user asks to message someone on their behalf.",
  parameters: {
    recipient_number: {
      type: "string",
      description: "Phone number with country code, no + or spaces (e.g. 212612345678). Use search_notes if user says a name like Mom or John.",
      required: true,
    },
    message: { type: "string", description: "The text message to send", required: true },
  },
  async execute(args) {
    const number = normalizeNumber(args.recipient_number);
    if (!number || number.length < 10) {
      return "Error: Invalid phone number. Use country code + number (e.g. 212612345678).";
    }
    await sendMessage(number, args.message);
    return `Message sent to ${number}.`;
  },
});

registerTool({
  name: "send_whatsapp_voice",
  description: "Send a voice note (audio) to a WhatsApp contact. Use when the user asks to send an audio message.",
  parameters: {
    recipient_number: {
      type: "string",
      description: "Phone number with country code, no + or spaces (e.g. 212612345678)",
      required: true,
    },
    message: {
      type: "string",
      description: "The text to convert to speech and send as a voice note. Use ElevenLabs TTS if available.",
      required: true,
    },
  },
  async execute(args) {
    const number = normalizeNumber(args.recipient_number);
    if (!number || number.length < 10) {
      return "Error: Invalid phone number. Use country code + number (e.g. 212612345678).";
    }
    await sendVoiceMessage(number, args.message);
    return `Voice message sent to ${number}.`;
  },
});

registerTool({
  name: "send_whatsapp_image",
  description: "Send an image to a WhatsApp contact. Media can be a URL or base64 string (e.g. from phone_screenshot).",
  parameters: {
    recipient_number: {
      type: "string",
      description: "Phone number with country code, no + or spaces (e.g. 212612345678)",
      required: true,
    },
    media: {
      type: "string",
      description: "Image as URL (https://...) or base64 string. For screenshots, use the base64 from phone_screenshot response.",
      required: true,
    },
    caption: { type: "string", description: "Optional caption for the image" },
  },
  async execute(args) {
    const number = normalizeNumber(args.recipient_number);
    if (!number || number.length < 10) {
      return "Error: Invalid phone number. Use country code + number (e.g. 212612345678).";
    }
    await sendImage(number, args.media, args.caption || "");
    return `Image sent to ${number}.`;
  },
});

import { config } from "./config";

const { apiUrl, instance, apiKey } = config.evolution;

/**
 * Sends a plain text message via Evolution API.
 * Splits long messages into chunks to avoid WhatsApp limits.
 */
export async function sendMessage(number: string, text: string): Promise<void> {
  const chunks = splitMessage(text, 4000);

  for (const chunk of chunks) {
    const response = await fetch(`${apiUrl}/message/sendText/${instance}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify({
        number,
        text: chunk,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[WhatsApp] Failed to send message: ${response.status} ${body}`);
      throw new Error(`Evolution API error: ${response.status}`);
    }
  }
}

/**
 * Sends a "typing" presence indicator before a message.
 */
export async function sendPresence(number: string, presence: "composing" | "paused" = "composing"): Promise<void> {
  try {
    await fetch(`${apiUrl}/chat/sendPresence/${instance}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify({
        number,
        delay: 1000,
        presence,
      }),
    });
  } catch {
    // Non-critical, don't throw
  }
}

/**
 * Splits a long message into chunks at line breaks or spaces.
 */
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

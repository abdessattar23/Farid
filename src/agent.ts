import { config } from "./config";
import { saveMessage, getHistory, ChatMessage } from "./memory/conversation";
import { buildSystemPrompt } from "./prompt";
import { executeTool } from "./tools";
import { sendMessage, sendPresence } from "./whatsapp";
import { getActiveFocusSession } from "./tools/productivity";

const TOOL_CALL_REGEX = /:::tool_call\s*\n?([\s\S]*?)\n?:::/;
const MAX_TOOL_ROUNDS = 5;

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Calls the Hack Club AI chat completions endpoint.
 */
async function callLLM(messages: LLMMessage[]): Promise<string> {
  const response = await fetch(`${config.hackclub.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.hackclub.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.hackclub.model,
      messages,
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`[LLM] API error: ${response.status} ${errBody}`);
    throw new Error(`LLM API error: ${response.status}`);
  }

  const data = (await response.json()) as any;
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    console.error("[LLM] Empty response:", JSON.stringify(data));
    throw new Error("LLM returned empty response");
  }

  return content.trim();
}

/**
 * Processes an incoming WhatsApp message through the full agent loop.
 *
 * 1. Load conversation history
 * 2. Check focus mode context
 * 3. Send to LLM with system prompt + history
 * 4. If LLM outputs a tool call, execute it and loop
 * 5. Send final text response back via WhatsApp
 */
export async function processIncomingMessage(senderNumber: string, text: string): Promise<void> {
  const chatId = senderNumber;

  // Save user message
  saveMessage(chatId, "user", text);

  // Show typing indicator
  await sendPresence(senderNumber);

  // Build message context
  const systemPrompt = buildSystemPrompt();
  const history = getHistory(chatId);

  // Add focus mode context if active
  const focusSession = getActiveFocusSession(chatId);
  let focusContext = "";
  if (focusSession) {
    const remaining = Math.max(
      0,
      Math.round((new Date(focusSession.ends_at).getTime() - Date.now()) / 60000)
    );
    focusContext = `\n\n[CONTEXT: User is currently in FOCUS MODE on "${focusSession.project}" with ${remaining} minutes remaining. Gently remind them to stay focused unless their message is urgent or task-related.]`;
  }

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt + focusContext },
    ...history.map((m) => ({ role: m.role as LLMMessage["role"], content: m.content })),
  ];

  // Agent loop: LLM -> possibly tool calls -> LLM -> ... -> final text
  let response: string;
  let rounds = 0;

  try {
    response = await callLLM(messages);

    while (TOOL_CALL_REGEX.test(response) && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const match = response.match(TOOL_CALL_REGEX);
      if (!match) break;

      let toolCall: { name: string; args: Record<string, any> };
      try {
        toolCall = JSON.parse(match[1].trim());
      } catch {
        console.error("[Agent] Failed to parse tool call JSON:", match[1]);
        response = "I tried to use a tool but something went wrong with parsing. Let me try again — could you rephrase?";
        break;
      }

      console.log(`[Agent] Tool call #${rounds}: ${toolCall.name}(${JSON.stringify(toolCall.args)})`);

      const toolResult = await executeTool(toolCall.name, toolCall.args || {}, chatId);
      console.log(`[Agent] Tool result: ${toolResult.slice(0, 200)}...`);

      // Feed result back to LLM
      messages.push({ role: "assistant", content: response });
      messages.push({ role: "user", content: `[Tool Result for ${toolCall.name}]:\n${toolResult}` });

      // Update typing indicator
      await sendPresence(senderNumber);

      response = await callLLM(messages);
    }

    if (rounds >= MAX_TOOL_ROUNDS && TOOL_CALL_REGEX.test(response)) {
      response = response.replace(TOOL_CALL_REGEX, "").trim() || "I was trying to do too many things at once. What do you need me to focus on?";
    }
  } catch (err: any) {
    console.error("[Agent] Error in agent loop:", err);
    response = "Something went wrong on my end. Give me a sec and try again.";
  }

  // Clean any leftover tool call markers from the response
  response = response.replace(TOOL_CALL_REGEX, "").trim();

  // Save assistant response
  saveMessage(chatId, "assistant", response);

  // Send via WhatsApp
  await sendMessage(senderNumber, response);
}

/**
 * Sends a proactive message (used by the scheduler for reminders, briefs, etc.)
 * Uses the LLM to make the message feel natural, or sends raw text for simple reminders.
 */
export async function sendProactiveMessage(chatId: string, text: string): Promise<void> {
  saveMessage(chatId, "assistant", text);
  await sendMessage(chatId, text);
}

/**
 * Sends a proactive message that goes through the LLM first for natural phrasing.
 * Used for daily briefs and reviews where we want AI to format the data nicely.
 */
export async function sendSmartProactiveMessage(chatId: string, context: string): Promise<void> {
  const systemPrompt = buildSystemPrompt();
  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: context },
  ];

  let response: string;
  let rounds = 0;

  try {
    response = await callLLM(messages);

    // Handle tool calls in proactive messages too
    while (TOOL_CALL_REGEX.test(response) && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const match = response.match(TOOL_CALL_REGEX);
      if (!match) break;

      let toolCall: { name: string; args: Record<string, any> };
      try {
        toolCall = JSON.parse(match[1].trim());
      } catch {
        break;
      }

      const toolResult = await executeTool(toolCall.name, toolCall.args || {}, chatId);
      messages.push({ role: "assistant", content: response });
      messages.push({ role: "user", content: `[Tool Result for ${toolCall.name}]:\n${toolResult}` });
      response = await callLLM(messages);
    }

    response = response.replace(TOOL_CALL_REGEX, "").trim();
  } catch (err) {
    console.error("[Agent] Error in proactive message:", err);
    response = context;
  }

  saveMessage(chatId, "assistant", response);
  await sendMessage(chatId, response);
}

import { config } from "./config";
import { saveMessage, getHistory } from "./memory/conversation";
import { buildSystemPrompt } from "./prompt";
import { executeTool, generateToolsParam } from "./tools";
import { sendMessage, sendPresence } from "./whatsapp";
import { getActiveFocusSession } from "./tools/productivity";

const MAX_TOOL_ROUNDS = 10;

// ── Types matching the OpenAI chat completions API ──

interface ToolCallPart {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCallPart[];
  tool_call_id?: string;
}

interface LLMResponseMessage {
  content: string | null;
  tool_calls?: ToolCallPart[];
}

// ── LLM caller ──

async function callLLM(messages: LLMMessage[], useTools = true): Promise<LLMResponseMessage> {
  const body: Record<string, any> = {
    model: config.hackclub.model,
    messages,
    temperature: 0.7,
    max_tokens: 2048,
  };

  if (useTools) {
    const tools = generateToolsParam();
    if (tools.length > 0) body.tools = tools;
  }

  const response = await fetch(`${config.hackclub.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.hackclub.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`[LLM] API error: ${response.status} ${errBody}`);
    throw new Error(`LLM API error: ${response.status}`);
  }

  const data = (await response.json()) as any;
  const msg = data.choices?.[0]?.message;

  if (!msg) {
    console.error("[LLM] Empty response:", JSON.stringify(data));
    throw new Error("LLM returned empty response");
  }

  return {
    content: msg.content?.trim() || null,
    tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined,
  };
}

// ── Typing indicator that stays alive throughout processing ──

function startTypingLoop(number: string): NodeJS.Timeout {
  sendPresence(number).catch(() => {});
  return setInterval(() => sendPresence(number).catch(() => {}), 15_000);
}

// ── Main agent loop ──

export async function processIncomingMessage(senderNumber: string, text: string): Promise<void> {
  const chatId = senderNumber;
  saveMessage(chatId, "user", text);

  const typingTimer = startTypingLoop(senderNumber);

  try {
    const systemPrompt = buildSystemPrompt();
    const history = getHistory(chatId);

    const focusSession = getActiveFocusSession(chatId);
    let focusCtx = "";
    if (focusSession) {
      const remaining = Math.max(
        0,
        Math.round((new Date(focusSession.ends_at).getTime() - Date.now()) / 60000)
      );
      focusCtx = `\n\n[CONTEXT: User is in FOCUS MODE on "${focusSession.project}" — ${remaining} min remaining. Remind them to stay focused unless urgent.]`;
    }

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt + focusCtx },
      ...history.map((m) => ({ role: m.role as LLMMessage["role"], content: m.content })),
    ];

    let finalText: string | null = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const resp = await callLLM(messages, true);

      if (!resp.tool_calls || resp.tool_calls.length === 0) {
        finalText = resp.content;
        break;
      }

      if (round === MAX_TOOL_ROUNDS) {
        finalText = resp.content || "I was doing too many things. What should I focus on?";
        break;
      }

      console.log(`[Agent] Round ${round + 1}: ${resp.tool_calls.length} tool call(s)`);

      messages.push({
        role: "assistant",
        content: resp.content,
        tool_calls: resp.tool_calls,
      });

      const results = await Promise.all(
        resp.tool_calls.map(async (tc) => {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            console.error(`[Agent] Bad args for ${tc.function.name}: ${tc.function.arguments}`);
          }
          console.log(`[Agent] -> ${tc.function.name}(${JSON.stringify(args)})`);
          const result = await executeTool(tc.function.name, args, chatId);
          console.log(`[Agent] <- ${tc.function.name}: ${result.slice(0, 200)}`);
          return { id: tc.id, result };
        })
      );

      for (const { id, result } of results) {
        messages.push({ role: "tool", tool_call_id: id, content: result });
      }
    }

    const reply = finalText || "Something went wrong. Try again?";
    saveMessage(chatId, "assistant", reply);
    await sendMessage(senderNumber, reply);
  } catch (err: any) {
    console.error("[Agent] Error in agent loop:", err);
    const errMsg = "Something went wrong on my end. Give me a sec and try again.";
    saveMessage(chatId, "assistant", errMsg);
    await sendMessage(senderNumber, errMsg);
  } finally {
    clearInterval(typingTimer);
  }
}

// ── Proactive messages (scheduler) ──

export async function sendProactiveMessage(chatId: string, text: string): Promise<void> {
  saveMessage(chatId, "assistant", text);
  await sendMessage(chatId, text);
}

export async function sendSmartProactiveMessage(chatId: string, context: string): Promise<void> {
  const typingTimer = startTypingLoop(chatId);

  try {
    const systemPrompt = buildSystemPrompt();
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: context },
    ];

    let finalText: string | null = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const resp = await callLLM(messages, true);

      if (!resp.tool_calls || resp.tool_calls.length === 0) {
        finalText = resp.content;
        break;
      }

      if (round === MAX_TOOL_ROUNDS) {
        finalText = resp.content || context;
        break;
      }

      messages.push({
        role: "assistant",
        content: resp.content,
        tool_calls: resp.tool_calls,
      });

      const results = await Promise.all(
        resp.tool_calls.map(async (tc) => {
          let args: Record<string, any> = {};
          try { args = JSON.parse(tc.function.arguments); } catch {}
          return { id: tc.id, result: await executeTool(tc.function.name, args, chatId) };
        })
      );

      for (const { id, result } of results) {
        messages.push({ role: "tool", tool_call_id: id, content: result });
      }
    }

    const reply = finalText || context;
    saveMessage(chatId, "assistant", reply);
    await sendMessage(chatId, reply);
  } catch (err) {
    console.error("[Agent] Error in proactive message:", err);
    saveMessage(chatId, "assistant", context);
    await sendMessage(chatId, context);
  } finally {
    clearInterval(typingTimer);
  }
}

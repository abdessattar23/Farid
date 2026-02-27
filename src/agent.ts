import { config } from "./config";
import { saveMessage, getHistory } from "./memory/conversation";
import { getLatestSummary, summarizeOldMessages } from "./memory/summarizer";
import { buildSystemPrompt } from "./prompt";
import { executeTool, generateToolsParam } from "./tools";
import { sendMessage, sendVoiceMessage, sendPresence } from "./whatsapp";
import { getActiveFocusSession } from "./tools/productivity";

const MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_RESULT_CHARS = 2500; // Prevent context overflow from huge tool outputs (screenshots, UI trees)

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

// ── Strip Qwen3 thinking artifacts from model output ──

function cleanThinking(text: string | null): string | null {
  if (!text) return null;
  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^(analysis|assistantcommentary|commentary|reasoning)[\s\S]*?(?=\n[A-Z]|\n\n|$)/gim, "")
    .replace(/to=functions\.\w+\s*json\s*\{[^}]*\}/gi, "")
    .trim();
  return cleaned || null;
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
    content: cleanThinking(msg.content?.trim() || null),
    tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined,
  };
}

// ── Typing indicator that stays alive throughout processing ──

function startTypingLoop(number: string): NodeJS.Timeout {
  sendPresence(number).catch(() => {});
  return setInterval(() => sendPresence(number).catch(() => {}), 15_000);
}

// ── Main agent loop ──

export async function processIncomingMessage(senderNumber: string, text: string, isVoice = false): Promise<void> {
  const chatId = senderNumber;
  saveMessage(chatId, "user", text);

  const typingTimer = startTypingLoop(senderNumber);

  try {
    const systemPrompt = buildSystemPrompt();
    const history = getHistory(chatId);

    // Build additional context
    const ctxParts: string[] = [];

    const focusSession = getActiveFocusSession(chatId);
    if (focusSession) {
      const remaining = Math.max(
        0,
        Math.round((new Date(focusSession.ends_at).getTime() - Date.now()) / 60000)
      );
      ctxParts.push(`[FOCUS MODE: "${focusSession.project}" — ${remaining} min remaining. Remind them to stay focused unless urgent.]`);
    }

    const summary = getLatestSummary(chatId);
    if (summary) {
      const capped = summary.length > 1200 ? summary.slice(0, 1200) + "\n[...]" : summary;
      ctxParts.push(`[CONVERSATION MEMORY — summary of past interactions:]\n${capped}`);
    }

    const contextBlock = ctxParts.length > 0 ? "\n\n" + ctxParts.join("\n\n") : "";

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt + contextBlock },
      ...history.map((m) => ({ role: m.role as LLMMessage["role"], content: m.content })),
    ];

    // Trigger background summarization if history is getting long
    summarizeOldMessages(chatId).catch(() => {});

    let finalText: string | null = null;
    let lastContent: string | null = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const resp = await callLLM(messages, true);

      // Track the last non-empty content for fallback
      if (resp.content) lastContent = resp.content;

      if (!resp.tool_calls || resp.tool_calls.length === 0) {
        finalText = resp.content;
        break;
      }

      if (round === MAX_TOOL_ROUNDS) {
        finalText = resp.content || lastContent || "I was doing too many things. What should I focus on?";
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
        const truncated =
          result.length > MAX_TOOL_RESULT_CHARS
            ? result.slice(0, MAX_TOOL_RESULT_CHARS) + "\n[... truncated to save context]"
            : result;
        messages.push({ role: "tool", tool_call_id: id, content: truncated });
      }
    }

    // If content is empty after cleaning, make one final call without tools to get a clean response
    if (!finalText) {
      console.log("[Agent] Empty response after tool rounds, making final call without tools");
      const fallback = await callLLM(messages, false);
      finalText = fallback.content;
    }

    const reply = finalText || "Done! Let me know what's next.";
    saveMessage(chatId, "assistant", reply);

    // Voice in → voice out
    if (isVoice) {
      await sendVoiceMessage(senderNumber, reply);
    } else {
      await sendMessage(senderNumber, reply);
    }
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
        const truncated =
          result.length > MAX_TOOL_RESULT_CHARS
            ? result.slice(0, MAX_TOOL_RESULT_CHARS) + "\n[... truncated to save context]"
            : result;
        messages.push({ role: "tool", tool_call_id: id, content: truncated });
      }
    }

    if (!finalText) {
      const fallback = await callLLM(messages, false);
      finalText = fallback.content;
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

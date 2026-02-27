/**
 * Phone Automation Agent — autonomous observe-decide-act loop for multi-step phone tasks.
 *
 * Instead of the main agent making 10+ individual phone_* tool calls (each burning context),
 * this runs a self-contained loop: get UI tree → ask lightweight LLM for next action →
 * execute → repeat until goal is achieved or max steps reached.
 *
 * ANDROID APP OPTIMIZATION (recommended):
 * To cut round trips in half, modify each command handler on the Android side to include
 * the fresh accessibility tree in the command response JSONB alongside the normal result:
 *
 *   // In CommandDispatcher.kt, after handler.execute():
 *   val uiTree = RemoteControlAccessibilityService.instance?.captureUiTree()
 *   val response = JsonObject().apply {
 *     add("result", handlerResult)
 *     add("ui_elements", uiTree)
 *   }
 *
 * When present, the automation loop reads `response.ui_elements` from the ack instead of
 * making a separate get_ui_elements call, saving ~1-2s per step.
 */
import { config } from "../config";
import { registerTool } from "./registry";
import { sendCommandFast, CommandResponse } from "./phone";

const MAX_STEPS = 20;
const MAX_CONSECUTIVE_SAME_ACTION = 3;
const MAX_EMPTY_UI_RETRIES = 3;
const UI_SETTLE_DELAY_MS = 800;

// ─── UI Tree Compression ───

interface UiElement {
  index: number;
  cls: string;
  text: string;
  bounds: { cx: number; cy: number; left: number; top: number; right: number; bottom: number };
  clickable: boolean;
  editable: boolean;
  scrollable: boolean;
  checked?: boolean;
}

function shortenClassName(cls: string): string {
  if (!cls) return "View";
  const parts = cls.split(".");
  return parts[parts.length - 1];
}

function parseBounds(boundsStr: string): { cx: number; cy: number; left: number; top: number; right: number; bottom: number } | null {
  const match = boundsStr?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  const [, l, t, r, b] = match.map(Number);
  if (r - l <= 0 || b - t <= 0) return null;
  return { left: l, top: t, right: r, bottom: b, cx: Math.round((l + r) / 2), cy: Math.round((t + b) / 2) };
}

/**
 * Compresses a raw accessibility tree into a compact indexed list.
 * Keeps only elements that have text/content-desc OR are interactive.
 * Returns both the formatted string (for the LLM) and the parsed elements (for coordinate lookup).
 */
export function compressUiTree(raw: any): { text: string; elements: UiElement[] } {
  const elements: UiElement[] = [];

  function walk(node: any) {
    if (!node) return;

    const text = node.text || node["content-desc"] || node.contentDescription || "";
    const cls = node.class || node.className || "";
    const clickable = node.clickable === true || node.clickable === "true";
    const editable = cls.toLowerCase().includes("edittext") || node.editable === true || node.editable === "true";
    const scrollable = node.scrollable === true || node.scrollable === "true";
    const checked = node.checked;
    const visible = node["visible-to-user"] !== false && node["visible-to-user"] !== "false";
    const enabled = node.enabled !== false && node.enabled !== "false";
    const boundsStr = node.bounds || node.boundsInScreen || "";

    if (visible && enabled) {
      const hasText = text.trim().length > 0;
      const isInteractive = clickable || editable || scrollable;

      if (hasText || isInteractive) {
        const bounds = parseBounds(boundsStr);
        if (bounds) {
          elements.push({
            index: elements.length,
            cls: shortenClassName(cls),
            text: text.trim().slice(0, 80),
            bounds,
            clickable,
            editable,
            scrollable,
            checked: checked === true || checked === "true" ? true : undefined,
          });
        }
      }
    }

    const children = node.children || node.nodes || [];
    if (Array.isArray(children)) {
      for (const child of children) walk(child);
    }
  }

  if (Array.isArray(raw)) {
    for (const root of raw) walk(root);
  } else if (raw && typeof raw === "object") {
    walk(raw);
  }

  const lines = elements.map((el) => {
    const flags: string[] = [];
    if (el.clickable) flags.push("clickable");
    if (el.editable) flags.push("editable");
    if (el.scrollable) flags.push("scrollable");
    if (el.checked !== undefined) flags.push(el.checked ? "checked" : "unchecked");
    const flagStr = flags.length > 0 ? " " + flags.join(",") : "";
    const label = el.text ? ` "${el.text}"` : "";
    return `[${el.index}] ${el.cls}${label} [${el.bounds.cx},${el.bounds.cy}]${flagStr}`;
  });

  return { text: lines.join("\n"), elements };
}

// ─── Automation LLM ───

interface AutoAction {
  action: "tap" | "double_tap" | "long_press" | "swipe" | "type" | "press_button" | "launch_app" | "wait" | "done";
  element?: number;
  direction?: "up" | "down" | "left" | "right";
  text?: string;
  button?: string;
  package_name?: string;
  summary?: string;
  reasoning?: string;
}

const AUTOMATION_SYSTEM_PROMPT = `You are an Android phone automation agent. You navigate UI by reading the accessibility tree and issuing actions.

RULES:
- You receive a GOAL and a numbered list of UI elements with their type, text, center coordinates, and flags.
- Output exactly ONE JSON action per turn. No extra text.
- Reference elements by their [index] number. The system will compute exact coordinates.
- For typing: first tap an editable field, then use "type" action.
- For scrolling: use "swipe" with direction (up=scroll down, down=scroll up).
- When the goal is complete, output {"action":"done","summary":"what was accomplished"}.
- If stuck, try pressing "back" or scrolling to find elements.

ACTIONS:
{"action":"tap","element":N,"reasoning":"..."}
{"action":"double_tap","element":N,"reasoning":"..."}
{"action":"long_press","element":N,"reasoning":"..."}
{"action":"swipe","direction":"up|down|left|right","reasoning":"..."}
{"action":"type","text":"...","reasoning":"..."}
{"action":"press_button","button":"home|back|recents|enter","reasoning":"..."}
{"action":"launch_app","package_name":"com.example.app","reasoning":"..."}
{"action":"wait","reasoning":"waiting for content to load"}
{"action":"done","summary":"what was accomplished"}`;

function cleanLlmThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

async function callAutomationLLM(
  goal: string,
  uiTree: string,
  actionHistory: { action: string; reasoning: string }[],
): Promise<AutoAction> {
  const historyStr = actionHistory.length > 0
    ? "\n\nLAST ACTIONS:\n" + actionHistory.map((a, i) => `${i + 1}. ${a.action}: ${a.reasoning}`).join("\n")
    : "";

  const userContent = `GOAL: ${goal}\n\nCURRENT SCREEN:\n${uiTree}${historyStr}`;

  const resp = await fetch(`${config.hackclub.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.hackclub.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.hackclub.model,
      messages: [
        { role: "system", content: AUTOMATION_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.1,
      max_tokens: 256,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Automation LLM error: ${resp.status} ${errBody.slice(0, 200)}`);
  }

  const data = (await resp.json()) as any;
  const raw = data.choices?.[0]?.message?.content?.trim() || "";
  const cleaned = cleanLlmThinking(raw);

  return parseAction(cleaned);
}

function parseAction(text: string): AutoAction {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in LLM response: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(jsonMatch[0]) as AutoAction;
  } catch {
    throw new Error(`Invalid JSON action: ${jsonMatch[0].slice(0, 200)}`);
  }
}

// ─── Automation Loop ───

interface StepLog {
  step: number;
  action: string;
  reasoning: string;
  result: string;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getUiTree(): Promise<{ text: string; elements: UiElement[] }> {
  const resp = await sendCommandFast("get_ui_elements");
  if (resp.status !== "completed" || !resp.response) {
    return { text: "[Screen could not be read]", elements: [] };
  }

  let raw = resp.response;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { /* use as-is */ }
  }
  if (raw.ui_elements) raw = raw.ui_elements;
  if (raw.elements) raw = raw.elements;
  if (raw.message && typeof raw.message === "string") {
    try { raw = JSON.parse(raw.message); } catch { /* use as-is */ }
  }

  return compressUiTree(raw);
}

async function executeAction(action: AutoAction, elements: UiElement[]): Promise<CommandResponse> {
  switch (action.action) {
    case "tap": {
      const el = elements[action.element ?? -1];
      if (!el) return { status: "failed", error: `Element [${action.element}] not found` };
      return sendCommandFast("tap", { x: el.bounds.cx, y: el.bounds.cy });
    }
    case "double_tap": {
      const el = elements[action.element ?? -1];
      if (!el) return { status: "failed", error: `Element [${action.element}] not found` };
      return sendCommandFast("double_tap", { x: el.bounds.cx, y: el.bounds.cy });
    }
    case "long_press": {
      const el = elements[action.element ?? -1];
      if (!el) return { status: "failed", error: `Element [${action.element}] not found` };
      return sendCommandFast("long_press", { x: el.bounds.cx, y: el.bounds.cy });
    }
    case "swipe":
      return sendCommandFast("swipe", { direction: action.direction || "up" });
    case "type":
      return sendCommandFast("send_text", { text: action.text || "" });
    case "press_button":
      return sendCommandFast("press_button", { button: action.button || "home" });
    case "launch_app":
      return sendCommandFast("launch_app", { package_name: action.package_name || "" });
    case "wait":
      await sleep(1500);
      return { status: "completed", response: "Waited for UI to settle" };
    case "done":
      return { status: "completed", response: action.summary || "Task complete" };
    default:
      return { status: "failed", error: `Unknown action: ${action.action}` };
  }
}

async function automationLoop(goal: string): Promise<string> {
  const log: StepLog[] = [];
  const actionHistory: { action: string; reasoning: string }[] = [];
  let lastActionKey = "";
  let sameActionCount = 0;
  let emptyUiCount = 0;

  let cachedUi: { text: string; elements: UiElement[] } | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    // 1. Observe: use cached UI from previous action response, or fetch fresh
    const ui = cachedUi || await getUiTree();
    cachedUi = null;

    if (ui.elements.length === 0) {
      emptyUiCount++;
      if (emptyUiCount >= MAX_EMPTY_UI_RETRIES) {
        log.push({ step, action: "abort", reasoning: "Screen unreadable after retries", result: "failed" });
        break;
      }
      await sleep(UI_SETTLE_DELAY_MS);
      continue;
    }
    emptyUiCount = 0;

    // 2. Decide: ask LLM for next action (sliding window of last 3 actions)
    const recentHistory = actionHistory.slice(-3);
    let action: AutoAction;
    try {
      action = await callAutomationLLM(goal, ui.text, recentHistory);
    } catch (err: any) {
      log.push({ step, action: "llm_error", reasoning: err.message, result: "failed" });
      continue;
    }

    console.log(`[PhoneAgent] Step ${step + 1}: ${action.action} — ${action.reasoning || ""}`);

    // 3. Check for done
    if (action.action === "done") {
      log.push({ step, action: "done", reasoning: action.reasoning || "", result: action.summary || "completed" });
      break;
    }

    // 4. Loop detection
    const actionKey = JSON.stringify({ action: action.action, element: action.element, direction: action.direction, text: action.text });
    if (actionKey === lastActionKey) {
      sameActionCount++;
      if (sameActionCount >= MAX_CONSECUTIVE_SAME_ACTION) {
        log.push({ step, action: "abort", reasoning: `Same action repeated ${MAX_CONSECUTIVE_SAME_ACTION} times — stuck`, result: "failed" });
        break;
      }
    } else {
      sameActionCount = 1;
      lastActionKey = actionKey;
    }

    // 5. Act: execute the action
    let result: CommandResponse;
    try {
      result = await executeAction(action, ui.elements);
    } catch (err: any) {
      log.push({ step, action: action.action, reasoning: action.reasoning || "", result: `error: ${err.message}` });
      actionHistory.push({ action: action.action, reasoning: `FAILED: ${err.message}` });
      continue;
    }

    const resultStr = result.status === "completed"
      ? "ok"
      : `failed: ${result.error || "unknown"}`;

    log.push({ step, action: action.action, reasoning: action.reasoning || "", result: resultStr });
    actionHistory.push({ action: action.action, reasoning: action.reasoning || "" });

    // If the response includes a fresh UI tree, cache it for the next iteration
    if (result.response && typeof result.response === "object" && result.response.ui_elements) {
      cachedUi = compressUiTree(result.response.ui_elements);
    }

    // Brief pause for the UI to settle after an action
    if (action.action !== "wait") {
      await sleep(UI_SETTLE_DELAY_MS);
    }
  }

  // Build human-readable summary
  const lastEntry = log[log.length - 1];
  const completed = lastEntry?.action === "done";
  const steps = log.map((l) => `  ${l.step + 1}. [${l.action}] ${l.reasoning} → ${l.result}`).join("\n");

  return `Phone task ${completed ? "completed" : "stopped"} after ${log.length} steps.\n\nGoal: ${goal}\n\nSteps:\n${steps}\n\n${completed ? `Result: ${lastEntry.result}` : "The task did not complete successfully."}`;
}

// ─── Tool Registration ───

registerTool({
  name: "phone_do_task",
  description:
    "Execute a multi-step task on the Android phone autonomously. Reads the screen, decides what to tap/type/swipe, and repeats until done. Use for any task that requires navigating through apps, typing, or finding UI elements. Examples: 'Open WhatsApp and message Abdelghani hello', 'Go to Settings and turn on WiFi', 'Open YouTube and search for JavaScript tutorials'.",
  parameters: {
    goal: {
      type: "string",
      description: "Natural language description of what to accomplish on the phone. Be specific about the app, target, and action.",
      required: true,
    },
  },
  async execute(args) {
    if (!args.goal) return "Error: goal is required.";
    console.log(`[PhoneAgent] Starting task: ${args.goal}`);
    try {
      return await automationLoop(args.goal);
    } catch (err: any) {
      console.error(`[PhoneAgent] Fatal error: ${err.message}`);
      return `Phone automation failed: ${err.message}`;
    }
  },
});

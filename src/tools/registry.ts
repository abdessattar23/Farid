export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean; enum?: string[] }>;
  execute: (args: Record<string, any>, chatId: string) => Promise<string>;
}

const tools = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
  tools.set(tool.name, tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

export function getAllTools(): ToolDefinition[] {
  return Array.from(tools.values());
}

/**
 * Executes a tool by name with the given arguments.
 * Returns the tool's result as a string, or an error message.
 */
export async function executeTool(name: string, args: Record<string, any>, chatId: string): Promise<string> {
  const tool = tools.get(name);
  if (!tool) {
    return `Error: Unknown tool "${name}". Available tools: ${Array.from(tools.keys()).join(", ")}`;
  }

  try {
    return await tool.execute(args, chatId);
  } catch (err: any) {
    console.error(`[Tool] Error executing ${name}:`, err);
    return `Error executing ${name}: ${err.message || String(err)}`;
  }
}

/**
 * Generates a tool definitions block for the system prompt.
 */
export function generateToolDescriptions(): string {
  const toolList = getAllTools();
  if (toolList.length === 0) return "No tools available.";

  return toolList
    .map((t) => {
      const params = Object.entries(t.parameters)
        .map(([key, val]) => {
          const req = val.required ? " (required)" : " (optional)";
          const enumStr = val.enum ? ` [one of: ${val.enum.join(", ")}]` : "";
          return `    - ${key}: ${val.type}${req} — ${val.description}${enumStr}`;
        })
        .join("\n");
      return `- **${t.name}**: ${t.description}\n  Parameters:\n${params}`;
    })
    .join("\n\n");
}

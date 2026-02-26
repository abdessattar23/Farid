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

export function getAllTools(): ToolDefinition[] {
  return Array.from(tools.values());
}

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
 * Returns tools in OpenAI function-calling schema for the API `tools` parameter.
 */
export function generateToolsParam() {
  return getAllTools().map((tool) => {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const [key, param] of Object.entries(tool.parameters)) {
      const prop: Record<string, any> = { type: param.type, description: param.description };
      if (param.enum) prop.enum = param.enum;
      properties[key] = prop;
      if (param.required) required.push(key);
    }

    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: { type: "object", properties, required },
      },
    };
  });
}

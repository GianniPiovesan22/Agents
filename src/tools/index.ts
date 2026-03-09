import { Tool as LLMTool } from '../llm/index.js';

export interface ToolDefinition {
    definition: LLMTool;
    execute: (args: any) => Promise<string>;
}

const tools: Record<string, ToolDefinition> = {};

export function registerTool(tool: ToolDefinition) {
    tools[tool.definition.function.name] = tool;
}

export function getToolsDefinitions(): LLMTool[] {
    return Object.values(tools).map(t => t.definition);
}

export async function executeTool(name: string, args: string | object): Promise<string> {
    const tool = tools[name];
    if (!tool) {
        return `Error: Tool ${name} not found.`;
    }

    try {
        const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
        return await tool.execute(parsedArgs);
    } catch (error) {
        return `Error executing tool ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
}

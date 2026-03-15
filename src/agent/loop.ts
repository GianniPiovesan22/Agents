import { getCompletion, Message, CompletionResult, getEmbedding } from '../llm/index.js';
import { getToolsDefinitions, executeTool } from '../tools/index.js';
import { getAllEmbeddings, saveEmbedding } from '../database/index.js';
import '../tools/get_current_time.js';
import '../tools/google_workspace.js';
import '../tools/web_search.js';
import '../tools/image_gen.js';
import '../tools/weather.js';
import '../tools/notes.js';
import '../tools/markets.js';
import '../tools/social_content.js';
import '../tools/reminder.js';
import '../tools/web_scrape.js';
import '../tools/youtube.js';
import '../tools/terminal.js';
import '../tools/github.js';

const MAX_ITERATIONS = 3;

export async function runAgent(userId: string, history: Message[]): Promise<string> {
    let messages: Message[] = [
        {
            role: 'system',
            content: `Sos el asistente personal de Gianni, dueño de BrescoPack — empresa argentina de maquinaria agrícola e industrial (www.brescopack.com). Respondés siempre en español rioplatense. Sos directo, profesional y eficiente.

Tu objetivo es ayudar a Gianni a gestionar su negocio: clientes, leads, presupuestos, seguimiento comercial, comunicaciones y tareas del día a día.

Tenés acceso a las siguientes herramientas:

**Google Workspace:**
- Gmail: Buscar emails, enviar emails, crear borradores — usalo para comunicaciones comerciales con clientes y leads
- Google Calendar: Ver eventos, crear eventos — usalo para agendar reuniones y seguimientos
- Google Drive: Buscar archivos — usalo para encontrar presupuestos, contratos y documentos
- Google Contacts: Listar contactos — usalo para buscar clientes y proveedores
- Google Sheets: Leer hojas de cálculo — usalo para consultar datos del CRM o listas de precios
- Google Docs: Leer documentos — usalo para consultar propuestas o plantillas

**Web & Búsqueda:**
- web_search: Buscar información actualizada en internet — usalo para investigar empresas, precios de competencia, noticias del sector agro
- scrape_website: Extraer contenido de una URL específica — usalo para analizar empresas potenciales como leads

**Notas & Recordatorios:**
- save_note: Guardar notas, ideas, datos de clientes
- list_notes: Listar todas las notas
- search_notes: Buscar entre las notas
- delete_note: Eliminar una nota por ID
- create_reminder: Crear un recordatorio para un momento futuro — usalo para seguimientos con clientes

**Cotizaciones:**
- get_dollar_rates: Tipos de cambio del dólar en Argentina (blue, oficial, MEP, CCL) — útil para cotizar en dólares

**Utilidades:**
- get_current_time: Hora actual local

Fecha/hora actual: ${new Date().toISOString()}

REGLAS:
1. NO uses herramientas a menos que el usuario pida algo que las requiera explícitamente
2. Si Gianni saluda o hace charla, respondé naturalmente SIN llamar herramientas
3. Respondé siempre en español rioplatense
4. Para Gmail usá queries como "newer_than:1d", "is:unread", "from:email"
5. Para calendar usá "primary" como calendar_id salvo que se especifique otro
6. Cuando redactes emails comerciales, usá el tono de BrescoPack: profesional pero cercano, directo al punto
7. Conocés el contexto del negocio: maquinaria agrícola e industrial, clientes en zonas productivas de Argentina, foco en distribuidores, transportistas y clientes finales del agro`
        }
    ];

    // Build Long Term Semantic Memory
    try {
        const userPrompt = history[history.length - 1]?.content || '';
        if (userPrompt) {
            const promptEmbedding = await getEmbedding(userPrompt);
            if (promptEmbedding.length > 0) {
                const pastEmbeddings = await getAllEmbeddings(userId);
                if (pastEmbeddings.length > 0) {
                    const scored = pastEmbeddings.map(mem => ({
                        content: mem.content,
                        score: cosineSimilarity(promptEmbedding, mem.embedding)
                    }));
                    scored.sort((a, b) => b.score - a.score);
                    const topMemories = scored.slice(0, 3).filter(s => s.score > 0.65).map(s => s.content);

                    if (topMemories.length > 0) {
                        messages.push({
                            role: 'system',
                            content: `LONG TERM MEMORY (Relevant context to the current query):\n${topMemories.join('\n')}`
                        });
                    }
                }
            }
        }
    } catch (e) {
        console.error("Semantic memory lookup failed", e);
    }

    messages = messages.concat(history);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response: CompletionResult = await getCompletion(messages, getToolsDefinitions());

        if (!response) return "Tuve un error procesando tu mensaje.";

        if (!response.tool_calls || response.tool_calls.length === 0) {
            return response.content || "No tengo una respuesta en este momento.";
        }

        messages.push({
            role: 'assistant',
            content: response.content || '',
        });

        for (const toolCall of response.tool_calls) {
            console.log(`🔧 Tool call: ${toolCall.name}(${typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments)})`);

            // Inject userId for notes tools
            let args = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : { ...toolCall.arguments };
            if (['save_note', 'list_notes', 'search_notes', 'delete_note', 'create_reminder'].includes(toolCall.name)) {
                args._userId = userId;
            }

            const result = await executeTool(toolCall.name, args);

            messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolCall.name,
                content: result,
            });
        }
    }

    let finalContent = "Alcancé el límite máximo de iteraciones para esta solicitud.";
    if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        finalContent = messages[messages.length - 1].content || finalContent;
    }

    // Save this interaction to Long Term Memory
    try {
        const lastQuery = history[history.length - 1]?.content || '';
        if (lastQuery && finalContent && !lastQuery.startsWith('/')) { // Ignore commands
            const memoryText = `User asked: ${lastQuery}\nBot answered: ${finalContent}`;
            const memoryEmb = await getEmbedding(memoryText);
            if (memoryEmb.length > 0) {
                await saveEmbedding(userId, memoryText, memoryEmb);
            }
        }
    } catch (e) {
        console.error("Failed to save to semantic memory", e);
    }

    return finalContent;
}

// Helper function for Semantic Search
function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

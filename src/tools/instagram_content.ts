import { registerTool } from './index.js';
import { getCompletion } from '../llm/index.js';
import { saveContentHistory, getRecentContentTypes } from '../database/index.js';

// ═══════════════════════════════════════════════════════════════
// INSTAGRAM CONTENT — BrescoPack Social Media Generator
// ═══════════════════════════════════════════════════════════════

const BRESCOPACK_CONTEXT = `
Empresa: BrescoPack
Rubro: Fabricante de maquinaria agroindustrial
Ubicación: Colón, Buenos Aires, Argentina
Productos principales:
  - Selladoras silo bolsa (para embolsar granos como soja, maíz, trigo)
  - Desactivadoras de soja (eliminan el factor antinutricional para consumo animal)
  - Selladoras alimenticias (para embalaje de alimentos)
Clientes objetivo: productores agropecuarios, acopios, cooperativas, frigoríficos
Instagram: @brescopackarg | Web: brescopack.com
Tono de marca: profesional pero cercano, del campo, confiable, argentino
`.trim();

// ── generate_social_content ─────────────────────────────────────
registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'generate_social_content',
      description: 'Generar contenido completo para redes sociales de BrescoPack (Facebook e/o Instagram). Devuelve copy listo, prompt de imagen, hashtags, horario sugerido y notas de plataforma.',
      parameters: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            enum: ['facebook', 'instagram', 'both'],
            description: 'Plataforma destino del contenido',
          },
          content_type: {
            type: 'string',
            enum: ['product', 'testimonial', 'market_info', 'seasonal', 'educational'],
            description: 'Tipo de contenido: product (showcase de producto), testimonial (testimonio de cliente), market_info (info del mercado agro), seasonal (contenido de temporada), educational (educativo/tips)',
          },
          topic: {
            type: 'string',
            description: 'Tema específico opcional (ej: "selladora de silobolsa en cosecha de maíz", "precio de la soja")',
          },
        },
        required: ['platform', 'content_type'],
      },
    },
  },
  execute: async (args) => {
    const platform: string = args.platform ?? 'both';
    const contentType: string = args.content_type ?? 'product';
    const topic: string | undefined = args.topic;

    // Fetch recent content types to help the LLM avoid repetition
    const recentTypes = getRecentContentTypes(21);
    const recentTypesContext = recentTypes.length > 0
      ? `\nTipos de contenido usados en los últimos 21 días: ${recentTypes.join(', ')}. Evitá repetir el mismo ángulo o enfoque.`
      : '';

    const contentTypeMap: Record<string, string> = {
      product: 'showcase del producto estrella (selladora de silobolsa). Destacá características, ventajas competitivas, calidad de fabricación argentina.',
      testimonial: 'testimonio de un cliente real (productor, acopiador o cooperativa). Usá primera persona, mencioná el problema que resolvió BrescoPack.',
      market_info: 'información del mercado agropecuario argentino relacionada con los productos de BrescoPack. Precios de granos, dólar, cosecha, coyuntura.',
      seasonal: 'contenido estacional/de temporada agrícola (siembra, cosecha, almacenaje). Conectá la temporada con la necesidad del producto.',
      educational: 'tip o dato educativo para productores agropecuarios. Cómo usar bien la selladora, conservación del grano, errores comunes.',
    };

    const platformMap: Record<string, string> = {
      facebook: 'Facebook (texto más largo permitido, hasta 63k caracteres, bien aceptados textos de 150-400 palabras con storytelling)',
      instagram: 'Instagram (caption hasta 2200 caracteres, primera línea gancho, hashtags al final)',
      both: 'Facebook e Instagram (generá un copy único que funcione en ambas plataformas con adjustes mínimos)',
    };

    const topicLine = topic ? `Tema específico a desarrollar: "${topic}"` : 'Elegí el ángulo más relevante y estacional para BrescoPack.';

    const systemPrompt = `Sos un experto en marketing agroindustrial argentino y Meta Ads para el sector agropecuario. Conocés profundamente el agro pampeano, el vocabulario del productor, y cómo hacer copy que convierte en Facebook e Instagram para maquinaria agroindustrial.

${BRESCOPACK_CONTEXT}

Conocimiento clave de BrescoPack:
- La selladora de silobolsa es el producto ESTRELLA — es lo que más rinde en publicidad y lo que más vende
- El silobolsa es masivo en Argentina: millones de toneladas de soja y maíz se almacenan así
- Los clientes tienen miedo de perder la cosecha por mal sellado — ese es el pain point principal
- BrescoPack compite con importados: el diferencial es servicio técnico local, repuestos disponibles, fabricación nacional
- Temporadas clave: cosecha gruesa (marzo-mayo para soja/maíz), siembra gruesa (octubre-diciembre)
- Tono: profesional pero del campo. Nada de corporativo vacío. Hablá como alguien que conoce el campo.`;

    const userPrompt = `Generá contenido para redes sociales de BrescoPack.

Plataforma: ${platformMap[platform]}
Tipo de contenido: ${contentTypeMap[contentType]}
${topicLine}${recentTypesContext}

Respondé EXACTAMENTE en este formato JSON (sin markdown, solo el JSON puro):

{
  "copy": "el texto completo del post en español rioplatense, listo para pegar. Con emojis naturales. Sin hashtags en el cuerpo — van separados.",
  "image_prompt": "detailed English description for AI image generation. Photorealistic style. Argentine rural setting when possible. No text in image. Specific scene related to the content.",
  "hashtags": ["silobolsa", "brescopack", "agro", "productoragropecuario", "cosecha", "maquinariaagrícola", "BuenosAires", "Argentina", "campo", "acopio"],
  "best_time": "día y hora sugerida para publicar (ej: Martes o Miércoles 9-11hs)",
  "platform_notes": "consejo específico de plataforma o formato (ej: En Instagram usá stories con el mismo copy. En Facebook acompañá con 2-3 fotos reales si tenés.)"
}

El copy debe ser específico, con gancho inicial potente, y terminar con llamada a la acción (WhatsApp, web brescopack.com, o consulta).`;

    try {
      const response = await getCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);

      const raw = response.content ?? '';

      // Try to parse as JSON; fall back to returning raw if LLM doesn't comply
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);

          // Save to content history
          const hashtagsStr = Array.isArray(parsed.hashtags)
            ? parsed.hashtags.join(',')
            : (parsed.hashtags ?? null);
          const historyId = saveContentHistory({
            platform,
            content_type: contentType,
            topic: topic ?? undefined,
            copy: parsed.copy ?? '',
            image_prompt: parsed.image_prompt ?? null,
            hashtags: hashtagsStr,
            status: 'pending',
          });

          // Embed the history id so callers can reference it later
          parsed.content_history_id = historyId;

          return JSON.stringify(parsed, null, 2);
        } catch {
          // JSON malformed — return raw anyway
        }
      }

      return raw;
    } catch (e: any) {
      return `Error generando contenido social: ${e.message}`;
    }
  },
});

console.log('📸 Instagram Content tools registered (generate_social_content)');

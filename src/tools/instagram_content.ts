import { registerTool } from './index.js';
import { getCompletion } from '../llm/index.js';
import { saveContentHistory, getRecentContentTypes } from '../database/index.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

// ── generate_instagram_post ─────────────────────────────────────
registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'generate_instagram_post',
      description: 'Generar un caption e imagen para Instagram de BrescoPack. Devuelve el texto listo para publicar con hashtags y emojis, y opcionalmente genera una imagen cuadrada.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Tema del post (ej: "selladoras silo bolsa para cosecha de soja", "cuidado del grano en bolsa")',
          },
          tone: {
            type: 'string',
            enum: ['educativo', 'promocional', 'testimonial', 'motivacional'],
            description: 'Tono del contenido (default: educativo)',
          },
          include_image: {
            type: 'boolean',
            description: 'Generar imagen con IA (default: true)',
          },
        },
        required: ['topic'],
      },
    },
  },
  execute: async (args) => {
    const topic: string = args.topic;
    const tone: string = args.tone ?? 'educativo';
    const includeImage: boolean = args.include_image !== false;

    const toneInstructions: Record<string, string> = {
      educativo: 'Explicá un concepto, técnica o beneficio relacionado al tema. Aportá valor real al productor.',
      promocional: 'Destacá ventajas competitivas del producto BrescoPack. Generá urgencia o deseo de compra.',
      testimonial: 'Simulá el testimonio de un cliente satisfecho (productor, acopio o cooperativa). Usá primera persona.',
      motivacional: 'Conectá emocionalmente con el productor argentino, la cosecha, el esfuerzo del campo.',
    };

    const systemPrompt = `Sos un experto en marketing agroindustrial argentino. Conocés profundamente el agro pampeano, el vocabulario del campo y cómo comunicar con productores, acopiadores y cooperativas.

${BRESCOPACK_CONTEXT}`;

    const userPrompt = `Creá un post de Instagram para BrescoPack sobre: "${topic}"

Tono: ${tone} — ${toneInstructions[tone]}

Generá dos cosas separadas:

1. CAPTION: El texto del post para Instagram.
   - Máximo 2200 caracteres
   - Empezá con un hook potente (primera línea que enganche)
   - Usá emojis naturalmente como bullets o énfasis (no en exceso)
   - Incluí entre 15 y 25 hashtags relevantes al agro argentino al final
   - Terminá con una llamada a la acción clara (contacto, consulta, web)
   - Hablá en español rioplatense, cercano pero profesional
   - Mencioná @brescopackarg o brescopack.com donde tenga sentido

2. IMAGEN_DESCRIPCION: Una descripción en inglés para generar una imagen cuadrada (1080x1080) con IA.
   - Describí una escena visual relacionada al tema
   - Estilo fotorrealista o ilustración profesional
   - Sin texto en la imagen
   - Ambiente agropecuario argentino cuando sea posible
   - Iluminación natural, colores vibrantes

Respondé EXACTAMENTE en este formato:
CAPTION:
[el caption completo aquí]

IMAGEN_DESCRIPCION:
[la descripción en inglés aquí]`;

    let caption = '';
    let imageDescription = '';

    try {
      const response = await getCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);

      const content = response.content ?? '';

      const captionMatch = content.match(/CAPTION:\s*([\s\S]*?)(?=IMAGEN_DESCRIPCION:|$)/i);
      const imageMatch = content.match(/IMAGEN_DESCRIPCION:\s*([\s\S]*?)$/i);

      caption = captionMatch?.[1]?.trim() ?? content.trim();
      imageDescription = imageMatch?.[1]?.trim() ?? `Professional agricultural machinery in Argentine pampas, silo bag sealer equipment, golden wheat field, realistic photo`;
    } catch (e: any) {
      return `Error generando el caption: ${e.message}`;
    }

    if (!includeImage) {
      return `Caption listo para Instagram:\n\n${caption}`;
    }

    // Generate image with Pollinations
    try {
      const encoded = encodeURIComponent(imageDescription);
      const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1080&height=1080&nologo=true&enhance=true`;

      console.log('📸 Generando imagen para Instagram...');
      const imgResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
      });

      const tempPath = path.join(os.tmpdir(), `ig_${Date.now()}.jpg`);
      fs.writeFileSync(tempPath, Buffer.from(imgResponse.data));
      console.log(`📸 Imagen guardada en ${tempPath}`);

      return `[IMG:${tempPath}]\n\nCaption:\n${caption}`;
    } catch (e: any) {
      console.error(`📸 Error generando imagen: ${e.message}`);
      // Return caption only if image fails
      return `Caption listo para Instagram:\n\n${caption}\n\n(No se pudo generar la imagen: ${e.message})`;
    }
  },
});

// ── generate_content_calendar ───────────────────────────────────
registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'generate_content_calendar',
      description: 'Generar un calendario de contenido semanal para Instagram de BrescoPack. Devuelve un plan con días, temas, hooks y hashtags.',
      parameters: {
        type: 'object',
        properties: {
          week_focus: {
            type: 'string',
            description: 'Tema o producto a destacar esa semana (opcional, ej: "desactivadoras de soja", "temporada de cosecha")',
          },
          posts_per_week: {
            type: 'number',
            description: 'Cantidad de posts a planificar en la semana (default: 3, máximo: 7)',
          },
        },
        required: [],
      },
    },
  },
  execute: async (args) => {
    const weekFocus: string | undefined = args.week_focus;
    const postsPerWeek: number = Math.min(args.posts_per_week ?? 3, 7);

    const focusText = weekFocus
      ? `El foco de esta semana es: "${weekFocus}". Todos o la mayoría de los posts deben conectar con este tema.`
      : 'Planificá contenido variado que muestre diferentes aspectos de BrescoPack.';

    const systemPrompt = `Sos un experto en marketing de contenidos para el sector agroindustrial argentino.

${BRESCOPACK_CONTEXT}`;

    const userPrompt = `Generá un calendario de contenido para Instagram de BrescoPack para la próxima semana.

${focusText}

Cantidad de posts: ${postsPerWeek}
Días preferidos: lunes, miércoles, viernes (pero podés variar si tiene sentido con el contenido)

Para cada post incluí:
📅 Día sugerido
📌 Tipo: (educativo / promocional / testimonial / motivacional)
🎯 Tema central
🪝 Hook de apertura (primera línea del caption, tiene que enganchar)
#️⃣ 5 hashtags clave para ese post

Formato: sin markdown, texto plano, usá emojis como bullets. Hacé cada post bien separado y fácil de leer en Telegram.

Contexto de temporada: considerá el calendario agrícola argentino (siembra gruesa oct-dic, cosecha gruesa mar-may, siembra fina abr-jun, cosecha fina nov-dic).`;

    try {
      const response = await getCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);

      const content = response.content ?? 'No se pudo generar el calendario.';
      return content;
    } catch (e: any) {
      return `Error generando el calendario: ${e.message}`;
    }
  },
});

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
            topic: topic ?? null,
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

console.log('📸 Instagram Content tools registered (generate_instagram_post, generate_content_calendar, generate_social_content)');

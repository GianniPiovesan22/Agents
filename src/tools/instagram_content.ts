import { registerTool } from './index.js';
import { getCompletion } from '../llm/index.js';
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

console.log('📸 Instagram Content tools registered (generate_instagram_post, generate_content_calendar)');

import { registerTool } from './index.js';
import { config } from '../config/index.js';
import { saveLead, getLeads, searchLeads, updateLeadStatus, deleteLead, getStaleLeads } from '../database/index.js';
import { getCompletion } from '../llm/index.js';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════
// CRM & LEADS — BrescoPack Lead Scraping + Management
// ═══════════════════════════════════════════════════════════════

const STATUS_EMOJIS: Record<string, string> = {
  nuevo: '🆕',
  contactado: '📞',
  interesado: '⭐',
  propuesta_enviada: '📄',
  cerrado: '✅',
  descartado: '❌',
};

function extractEmails(text: string): string[] {
  const regex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  return [...new Set(text.match(regex) ?? [])];
}

function extractPhones(text: string): string[] {
  // Argentine formats: +54..., 011-XXXX-XXXX, 0XXX-XXXXXX, (011) XXXX-XXXX, etc.
  const regex = /(?:\+54[\s\-]?)?(?:0\d{2,4}[\s\-]?)?\d{6,10}/g;
  const matches = text.match(regex) ?? [];
  return [...new Set(matches.filter(m => m.replace(/\D/g, '').length >= 7))];
}

// ── search_leads_online ─────────────────────────────────────────
registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'search_leads_online',
      description: 'Buscar empresas y leads online por industria y zona, guardarlos en el CRM. Útil para prospección comercial de BrescoPack.',
      parameters: {
        type: 'object',
        properties: {
          industry: {
            type: 'string',
            description: 'Industria o rubro a buscar (ej: "acopio de granos", "frigorífico", "apicultura")',
          },
          location: {
            type: 'string',
            description: 'Zona geográfica (ej: "Córdoba", "Buenos Aires", "Argentina")',
          },
          max_results: {
            type: 'number',
            description: 'Cantidad máxima de leads a guardar (default: 8)',
          },
        },
        required: ['industry'],
      },
    },
  },
  execute: async (args) => {
    const industry: string = args.industry;
    const location: string = args.location ?? 'Argentina';
    const maxResults: number = Math.min(args.max_results ?? 8, 15);

    // Step 1: Use Tavily to find company website URLs — try multiple query variations
    const candidateUrls: Array<{ title: string; url: string }> = [];
    const seen = new Set<string>();

    const EXCLUDE_DOMAINS = ['facebook.com', 'instagram.com', 'twitter.com', 'youtube.com', 'wikipedia.org', 'mercadolibre.com', 'linkedin.com', 'infobae.com', 'clarin.com', 'lanacion.com.ar'];

    const queries = [
      `${industry} ${location} empresa contacto`,
      `${industry} ${location} sitio web`,
      `${industry} Argentina directorio empresas`,
      `${industry} Argentina contact website`,
    ];

    if (config.SERPER_API_KEY) {
      // Use Serper (Google Search) for best local Argentine results
      for (const query of queries) {
        if (candidateUrls.length >= maxResults + 5) break;
        try {
          const resp = await axios.post(
            'https://google.serper.dev/search',
            { q: query, gl: 'ar', hl: 'es', num: 10 },
            {
              headers: { 'X-API-KEY': config.SERPER_API_KEY, 'Content-Type': 'application/json' },
              timeout: 15000,
            }
          );
          const organic = resp.data?.organic ?? [];
          for (const r of organic) {
            const url: string = r.link ?? '';
            const title: string = r.title ?? '';
            if (url && title && !seen.has(url) && !EXCLUDE_DOMAINS.some(d => url.includes(d))) {
              seen.add(url);
              candidateUrls.push({ title, url });
            }
          }
        } catch (e: any) {
          console.error('Serper error:', e.message);
        }
      }
    } else if (config.TAVILY_API_KEY) {
      // Fallback to Tavily if Serper not configured
      for (const query of queries) {
        if (candidateUrls.length >= maxResults + 5) break;
        try {
          const resp = await axios.post(
            'https://api.tavily.com/search',
            { api_key: config.TAVILY_API_KEY, query, search_depth: 'basic', max_results: 10, exclude_domains: EXCLUDE_DOMAINS },
            { timeout: 15000 }
          );
          for (const r of resp.data?.results ?? []) {
            if (r.url && r.title && !seen.has(r.url)) {
              seen.add(r.url);
              candidateUrls.push({ title: r.title, url: r.url });
            }
          }
        } catch (e: any) {
          console.error('Tavily error:', e.message);
        }
      }
    }

    if (candidateUrls.length === 0) {
      return `No encontré empresas de "${industry}" en ${location}. Intentá con una URL específica de un directorio del rubro usando scrape_leads_from_url.`;
    }

    // Step 2: Scrape each company website with Jina Reader to extract real contact info
    let saved = 0;
    const results: string[] = [];

    for (const candidate of candidateUrls.slice(0, maxResults)) {
      let emails: string[] = [];
      let phones: string[] = [];
      let companyName = candidate.title.slice(0, 80);

      // Try Jina scraping for contact details — fall back to Tavily data if it fails
      try {
        const jinaResp = await axios.get(`https://r.jina.ai/${candidate.url}`, {
          timeout: 12000,
          headers: { Accept: 'text/plain' },
        });
        const pageText: string = typeof jinaResp.data === 'string' ? jinaResp.data.slice(0, 8000) : '';
        emails = extractEmails(pageText);
        phones = extractPhones(pageText);
        const titleMatch = pageText.match(/^#\s+(.+)$/m);
        if (titleMatch?.[1]) companyName = titleMatch[1].trim().slice(0, 80);
      } catch {
        // Jina failed — save with Tavily data only
      }

      const id = saveLead({
        company_name: companyName,
        email: emails[0] ?? undefined,
        phone: phones[0] ?? undefined,
        website: candidate.url,
        industry,
        location,
        source: 'web_search',
        status: 'nuevo',
      });

      if (id > 0) {
        saved++;
        const contact = [emails[0], phones[0]].filter(Boolean).join(' | ') || 'sin contacto (visitá el sitio)';
        results.push(`✅ ${companyName} — ${contact}`);
      }
    }

    if (saved === 0) {
      return `No pude encontrar ni guardar empresas de "${industry}" en ${location}. Intentá con otro término de búsqueda.`;
    }

    return `Guardé ${saved} leads de "${industry}" en ${location}:\n\n${results.join('\n')}\n\nUsá "mostrame los leads" para ver el detalle completo.`;
  },
});

// ── scrape_leads_from_url ───────────────────────────────────────
registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'scrape_leads_from_url',
      description: 'Extraer contactos de una URL específica usando Jina Reader y guardarlos en el CRM.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL de la página a scrapear (ej: página de directorio, cámara industrial, guía de proveedores)',
          },
          industry: {
            type: 'string',
            description: 'Industria o rubro para etiquetar los leads (opcional)',
          },
        },
        required: ['url'],
      },
    },
  },
  execute: async (args) => {
    const url: string = args.url;
    const industry: string | undefined = args.industry;

    let markdown = '';
    try {
      const resp = await axios.get(`https://r.jina.ai/${url}`, {
        timeout: 25000,
        headers: { Accept: 'text/plain' },
      });
      markdown = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    } catch (e: any) {
      return `Error scrapeando ${url}: ${e.message}`;
    }

    if (!markdown || markdown.trim().length === 0) {
      return `No pude extraer contenido de ${url}.`;
    }

    // Use LLM to extract structured leads from markdown — much more reliable than regex
    const excerpt = markdown.slice(0, 12000);
    const prompt = `Analizá el siguiente contenido de una página web y extraé todos los contactos/empresas que encuentres.

Devolvé ÚNICAMENTE un JSON válido con este formato (sin texto extra, sin markdown):
[
  {
    "company_name": "Nombre de la empresa",
    "email": "email@ejemplo.com o null",
    "phone": "teléfono o null",
    "website": "URL del sitio o null",
    "contact_name": "nombre del contacto o null"
  }
]

Si no encontrás ningún contacto útil, devolvé: []

Contenido de la página:
${excerpt}`;

    let leads: Array<{ company_name: string; email?: string; phone?: string; website?: string; contact_name?: string }> = [];

    try {
      const llmResponse = await getCompletion([{ role: 'user', content: prompt }]);
      const raw = (llmResponse.content ?? '').trim();
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) leads = parsed.slice(0, 30);
      }
    } catch (e: any) {
      console.error('LLM lead extraction error:', e.message);
      // Fallback: at least save emails found via regex
      const emails = extractEmails(markdown);
      const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
      leads = emails.slice(0, 10).map(email => ({ company_name: email.split('@')[1] ?? hostname, email }));
    }

    if (leads.length === 0) {
      return `No encontré contactos útiles en ${url}.`;
    }

    const saved: number[] = [];
    for (const lead of leads) {
      if (!lead.company_name && !lead.email && !lead.phone) continue;
      const id = saveLead({
        company_name: lead.company_name ?? 'Sin nombre',
        email: lead.email ?? undefined,
        phone: lead.phone ?? undefined,
        website: lead.website ?? url,
        contact_name: lead.contact_name ?? undefined,
        industry,
        source: 'web_scrape',
        status: 'nuevo',
      });
      if (id > 0) saved.push(id);
    }

    if (saved.length === 0) {
      return `No encontré contactos útiles en ${url}.`;
    }

    return `Extraje ${saved.length} contactos de ${url}. Guardados en tu CRM.`;
  },
});

// ── get_leads ───────────────────────────────────────────────────
registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'get_leads',
      description: 'Ver los leads del CRM, filtrar por estado o buscar por nombre/industria/ubicación.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Filtrar por estado del lead',
            enum: ['nuevo', 'contactado', 'interesado', 'propuesta_enviada', 'cerrado', 'descartado'],
          },
          search: {
            type: 'string',
            description: 'Texto a buscar en nombre de empresa, industria o ubicación',
          },
        },
        required: [],
      },
    },
  },
  execute: async (args) => {
    const leads = args.search
      ? searchLeads(args.search)
      : getLeads(args.status);

    if (leads.length === 0) {
      return 'No tenés leads guardados aún.';
    }

    const lines: string[] = [`Leads en CRM (${leads.length}):\n`];

    for (const lead of leads) {
      const emoji = STATUS_EMOJIS[lead.status] ?? '🔵';
      const parts: string[] = [`${emoji} [${lead.id}] ${lead.company_name}`];
      if (lead.industry) parts.push(`Rubro: ${lead.industry}`);
      if (lead.location) parts.push(`Zona: ${lead.location}`);
      if (lead.contact_name) parts.push(`Contacto: ${lead.contact_name}`);
      if (lead.email) parts.push(`Email: ${lead.email}`);
      if (lead.phone) parts.push(`Tel: ${lead.phone}`);
      if (lead.website) parts.push(`Web: ${lead.website}`);
      parts.push(`Estado: ${lead.status}`);
      if (lead.notes) parts.push(`Notas: ${lead.notes}`);
      lines.push(parts.join(' | '));
    }

    return lines.join('\n');
  },
});

// ── update_lead ─────────────────────────────────────────────────
registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'update_lead',
      description: 'Actualizar el estado de un lead en el CRM y opcionalmente agregar notas.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: 'ID del lead a actualizar',
          },
          status: {
            type: 'string',
            description: 'Nuevo estado del lead',
            enum: ['nuevo', 'contactado', 'interesado', 'propuesta_enviada', 'cerrado', 'descartado'],
          },
          notes: {
            type: 'string',
            description: 'Notas adicionales sobre el lead (opcional)',
          },
        },
        required: ['id', 'status'],
      },
    },
  },
  execute: async (args) => {
    updateLeadStatus(args.id, args.status, args.notes);
    const emoji = STATUS_EMOJIS[args.status] ?? '🔵';
    return `${emoji} Lead #${args.id} actualizado a estado: ${args.status}${args.notes ? ` | Notas: ${args.notes}` : ''}`;
  },
});

// ── delete_lead ─────────────────────────────────────────────────
registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'delete_lead',
      description: 'Eliminar un lead del CRM por ID.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: 'ID del lead a eliminar',
          },
        },
        required: ['id'],
      },
    },
  },
  execute: async (args) => {
    deleteLead(args.id);
    return `Lead #${args.id} eliminado del CRM.`;
  },
});

// ── get_stale_leads ─────────────────────────────────────────────
registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'get_stale_leads',
      description: 'Ver leads del CRM que no tuvieron actividad en N días y necesitan seguimiento. Útil para saber a quién hay que contactar.',
      parameters: {
        type: 'object',
        properties: {
          days_without_activity: {
            type: 'number',
            description: 'Días sin actividad para considerar un lead estancado (default: 7)',
          },
        },
        required: [],
      },
    },
  },
  execute: async (args) => {
    const days: number = args.days_without_activity ?? 7;
    const leads = getStaleLeads(days);

    if (leads.length === 0) {
      return `No hay leads sin actividad hace más de ${days} días. Estás al día.`;
    }

    const lines: string[] = [`Leads sin actividad hace más de ${days} días (${leads.length}):\n`];

    for (const lead of leads) {
      const emoji = STATUS_EMOJIS[lead.status] ?? '🔵';
      const updatedAt = new Date(lead.updated_at);
      const daysAgo = Math.floor((Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));
      const parts: string[] = [`${emoji} [${lead.id}] ${lead.company_name} — ${daysAgo} días sin actividad`];
      if (lead.industry) parts.push(`Rubro: ${lead.industry}`);
      if (lead.location) parts.push(`Zona: ${lead.location}`);
      if (lead.contact_name) parts.push(`Contacto: ${lead.contact_name}`);
      if (lead.email) parts.push(`Email: ${lead.email}`);
      if (lead.phone) parts.push(`Tel: ${lead.phone}`);
      parts.push(`Estado: ${lead.status}`);
      lines.push(parts.join(' | '));
    }

    return lines.join('\n');
  },
});

console.log('🎯 Leads CRM tools registered (search_leads_online, scrape_leads_from_url, get_leads, update_lead, delete_lead, get_stale_leads)');

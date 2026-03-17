import { getGoogleAuth } from '../google/auth.js';
import { google } from 'googleapis';
import type { Lead } from '../database/index.js';

const SPREADSHEET_NAME = 'OpenGravity CRM';
const HEADERS = ['ID', 'Empresa', 'Industria', 'Zona', 'Contacto', 'Email', 'Teléfono', 'Web', 'Estado', 'Notas', 'Fuente', 'Fecha'];

async function findOrCreateSpreadsheet(auth: any): Promise<string> {
  const drive = google.drive({ version: 'v3', auth });

  // Search for existing spreadsheet by name
  const searchRes = await drive.files.list({
    q: `name='${SPREADSHEET_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  const files = searchRes.data.files ?? [];
  if (files.length > 0 && files[0].id) {
    return files[0].id;
  }

  // Not found — create it
  const sheets = google.sheets({ version: 'v4', auth });
  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: SPREADSHEET_NAME },
      sheets: [{ properties: { title: 'Leads' } }],
    },
  });

  const spreadsheetId = createRes.data.spreadsheetId;
  if (!spreadsheetId) throw new Error('Failed to create spreadsheet — no ID returned');
  return spreadsheetId;
}

export async function syncLeadToSheets(lead: Lead): Promise<void> {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const spreadsheetId = await findOrCreateSpreadsheet(auth);

    // Read first row to check if headers exist
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Leads!A1:L1',
    });

    const firstRow = readRes.data.values?.[0] ?? [];
    if (firstRow.length === 0) {
      // Write headers
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'Leads!A1:L1',
        valueInputOption: 'RAW',
        requestBody: { values: [HEADERS] },
      });
    }

    // Append lead row
    const row = [
      lead.id ?? '',
      lead.company_name ?? '',
      lead.industry ?? '',
      lead.location ?? '',
      lead.contact_name ?? '',
      lead.email ?? '',
      lead.phone ?? '',
      lead.website ?? '',
      lead.status ?? '',
      lead.notes ?? '',
      lead.source ?? '',
      lead.created_at ?? '',
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Leads!A:L',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.error('[syncLeadToSheets] Error syncing lead to Google Sheets:', err instanceof Error ? err.message : err);
  }
}

import { describe, it, expect } from 'vitest';
import { parseForexCalendar } from './forex-parser.js';

describe('parseForexCalendar', () => {

    it('devuelve array vacío con markdown vacío', () => {
        expect(parseForexCalendar('')).toEqual([]);
    });

    it('parsea una fila de alto impacto correctamente', () => {
        const markdown = `Jan 15, 2025\n| 08:30 | USD | High | CPI m/m | 0.3% | 0.2% | |`;
        const result = parseForexCalendar(markdown);

        expect(result).toHaveLength(1);
        expect(result[0].impact).toBe('High');
        expect(result[0].currency).toBe('USD');
        expect(result[0].event_name).toBe('CPI m/m');
        expect(result[0].event_date).toBe('2025-01-15');
        expect(result[0].event_time).toBe('08:30');
        expect(result[0].forecast).toBe('0.3%');
        expect(result[0].previous).toBe('0.2%');
    });

    it('clasifica impacto Medium correctamente', () => {
        const markdown = `Jan 15, 2025\n| 10:00 | EUR | Medium | PMI | 52.0 | 51.5 | |`;
        const [event] = parseForexCalendar(markdown);
        expect(event.impact).toBe('Medium');
    });

    it('clasifica impacto Low para cualquier otro valor', () => {
        const markdown = `Jan 15, 2025\n| 10:00 | GBP | Low | Housing Data | | | |`;
        const [event] = parseForexCalendar(markdown);
        expect(event.impact).toBe('Low');
    });

    it('reconoce impacto por color (red/orange)', () => {
        const mdRed = `Jan 15, 2025\n| 08:30 | USD | red | NFP | 200K | 180K | |`;
        const mdOrange = `Jan 15, 2025\n| 08:30 | USD | orange | PMI | 52 | 51 | |`;

        expect(parseForexCalendar(mdRed)[0].impact).toBe('High');
        expect(parseForexCalendar(mdOrange)[0].impact).toBe('Medium');
    });

    it('detecta fecha en formato corto (Mon Jan 15)', () => {
        const year = new Date().getFullYear();
        const markdown = `Wed Jan 15\n| 08:30 | USD | High | CPI | | | |`;
        const [event] = parseForexCalendar(markdown);
        expect(event.event_date).toBe(`${year}-01-15`);
    });

    it('usa initialDate cuando se provee', () => {
        const markdown = `| 08:30 | USD | High | CPI | | | |`;
        const [event] = parseForexCalendar(markdown, '2025-03-21');
        expect(event.event_date).toBe('2025-03-21');
    });

    it('omite filas de encabezado (Event, ---)', () => {
        const markdown = `Jan 15, 2025
| Time | Currency | Impact | Event | Forecast | Previous | Actual |
| --- | --- | --- | --- | --- | --- | --- |
| 08:30 | USD | High | CPI m/m | 0.3% | 0.2% | |`;

        const result = parseForexCalendar(markdown);
        expect(result).toHaveLength(1);
        expect(result[0].event_name).toBe('CPI m/m');
    });

    it('genera IDs únicos para múltiples eventos', () => {
        const markdown = `Jan 15, 2025
| 08:30 | USD | High | CPI m/m | 0.3% | 0.2% | |
| 10:00 | EUR | Medium | PMI | 52.0 | 51.5 | |`;

        const result = parseForexCalendar(markdown);
        expect(result).toHaveLength(2);
        expect(result[0].id).not.toBe(result[1].id);
    });

    it('trunca el ID a 100 caracteres', () => {
        const longName = 'A'.repeat(150);
        const markdown = `Jan 15, 2025\n| 08:30 | USD | High | ${longName} | | | |`;
        const [event] = parseForexCalendar(markdown);
        expect(event.id.length).toBeLessThanOrEqual(100);
    });

    it('parsea múltiples fechas y asigna correctamente cada evento', () => {
        const markdown = `Jan 15, 2025
| 08:30 | USD | High | CPI m/m | | | |
Jan 16, 2025
| 10:00 | EUR | Medium | PMI | | | |`;

        const result = parseForexCalendar(markdown);
        expect(result[0].event_date).toBe('2025-01-15');
        expect(result[1].event_date).toBe('2025-01-16');
    });

    it('event_time es undefined si la fila no tiene hora', () => {
        const markdown = `Jan 15, 2025\n| | USD | High | CPI m/m | | | |`;
        const [event] = parseForexCalendar(markdown);
        expect(event.event_time).toBeUndefined();
    });

});

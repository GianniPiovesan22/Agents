import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from './math.js';

describe('cosineSimilarity', () => {

    it('devuelve 1 para vectores idénticos', () => {
        const vec = [1, 2, 3];
        expect(cosineSimilarity(vec, vec)).toBeCloseTo(1);
    });

    it('devuelve 0 para vectores ortogonales', () => {
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    });

    it('devuelve -1 para vectores opuestos', () => {
        expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    });

    it('devuelve 0 si alguno de los vectores es cero', () => {
        expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
        expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    });

    it('es independiente de la magnitud', () => {
        const a = [1, 2, 3];
        const b = [2, 4, 6]; // mismo ángulo que a, doble magnitud
        expect(cosineSimilarity(a, b)).toBeCloseTo(1);
    });

    it('devuelve valor entre -1 y 1 para vectores arbitrarios', () => {
        const a = [0.1, 0.5, 0.3, 0.9];
        const b = [0.8, 0.2, 0.6, 0.1];
        const result = cosineSimilarity(a, b);
        expect(result).toBeGreaterThanOrEqual(-1);
        expect(result).toBeLessThanOrEqual(1);
    });

    it('es simétrica: sim(a,b) === sim(b,a)', () => {
        const a = [1, 2, 3];
        const b = [4, 5, 6];
        expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a));
    });

});

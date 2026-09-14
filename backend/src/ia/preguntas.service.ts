import { Injectable, Logger } from '@nestjs/common';
import {
  dificultadAleatoria,
  GeminiService,
  IaError,
  Pregunta,
  TipoFalloIa,
} from './gemini.service';

const MAX_POOL_POR_TEMA = 5;

/**
 * Estrategia R5: intenta la IA; si falla, entrega una pregunta de RESPALDO
 * del pool en memoria; si tampoco hay, propaga el error tipado (quien llama
 * lo convierte en mensaje entendible para el jugador).
 */
@Injectable()
export class PreguntasService {
  private readonly logger = new Logger(PreguntasService.name);

  /** Respaldo en memoria: tema -> preguntas listas para usar. */
  private pool = new Map<string, Pregunta[]>();

  constructor(private readonly gemini: GeminiService) {}

  async obtenerPregunta(tema: string, simulacionFallo?: TipoFalloIa): Promise<Pregunta> {
    try {
      const pregunta = await this.gemini.generarPregunta(
        tema,
        dificultadAleatoria(),
        simulacionFallo,
      );
      this.reponerPool(tema); // cada éxito alimenta el respaldo, en segundo plano
      return pregunta;
    } catch (error) {
      if (error instanceof IaError) {
        this.logger.warn(`IA falló (${error.tipo}) en tema "${tema}": ${error.message}`);
      }
      const respaldo = this.sacarDelPool(tema);
      if (respaldo) {
        this.logger.log(`Entregada pregunta de RESPALDO para tema "${tema}"`);
        return respaldo;
      }
      throw error; // sin respaldo disponible: sube el error tipado
    }
  }

  /**
   * Precalienta respaldos de un tema en paralelo. En la Sesión 4B, el
   * countdown de 5s de la partida llamará esto para arrancar conmunición.
   */
  async precalentar(tema: string, cantidad = 3): Promise<number> {
    const resultados = await Promise.allSettled(
      Array.from({ length: cantidad }, () =>
        this.gemini.generarPregunta(tema, dificultadAleatoria()),
      ),
    );
    let guardadas = 0;
    for (const resultado of resultados) {
      if (resultado.status === 'fulfilled') {
        this.guardarEnPool(tema, resultado.value);
        guardadas++;
      } else {
        const razon = resultado.reason instanceof Error ? resultado.reason.message : resultado.reason;
        this.logger.warn(`Precalentamiento falló para "${tema}": ${razon}`);
      }
    }
    this.logger.log(`Pool de "${tema}": ${this.tamanoPool(tema)} pregunta(s)`);
    return guardadas;
  }

  /** Saca una del pool (la consume: no se repite en el próximo respaldo). */
  private sacarDelPool(tema: string): Pregunta | null {
    return this.pool.get(tema)?.shift() ?? null;
  }

  private guardarEnPool(tema: string, pregunta: Pregunta): void {
    const lista = this.pool.get(tema) ?? [];
    if (lista.length >= MAX_POOL_POR_TEMA) return;
    lista.push(pregunta);
    this.pool.set(tema, lista);
  }

  /** Fire-and-forget: pide una extra y la guarda. Nunca lanza. */
  private reponerPool(tema: string): void {
    if ((this.pool.get(tema)?.length ?? 0) >= MAX_POOL_POR_TEMA) return;
    void this.gemini
      .generarPregunta(tema, dificultadAleatoria())
      .then((p) => this.guardarEnPool(tema, p))
      .catch(() => {
        /* el respaldo es un lujo, no una necesidad: los fallos aquí se ignoran */
      });
  }

  private tamanoPool(tema: string): number {
    return this.pool.get(tema)?.length ?? 0;
  }
}
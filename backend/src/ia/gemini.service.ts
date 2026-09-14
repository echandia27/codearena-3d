import { Injectable, Logger } from '@nestjs/common';

// ---------- Tipos del dominio de preguntas ----------

export type Dificultad = 'facil' | 'media' | 'dificil';
export const DIFICULTADES: Dificultad[] = ['facil', 'media', 'dificil'];

export interface Pregunta {
  enunciado: string;
  opciones: string[];
  indiceCorrecto: number;
  dificultad: Dificultad;
}

export function dificultadAleatoria(): Dificultad {
  return DIFICULTADES[Math.floor(Math.random() * DIFICULTADES.length)];
}

/**
 * Los fallos que el sistema maneja de forma explícita:
 *  - 'no_responde': la API no respondió (timeout, error de servidor)
 *  - 'formato':     respondió algo que no es una pregunta válida (R4)
 *  - 'limite':      se excedió el límite de uso (HTTP 429)
 *  - 'config':      falta GEMINI_API_KEY (problema de configuración)
 */
export type TipoFalloIa = 'no_responde' | 'formato' | 'limite' | 'config';

export class IaError extends Error {
  constructor(
    readonly tipo: TipoFalloIa,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

// ---------- Validación R4 (función pura) ----------

/**
 * R4: una pregunta solo es válida si trae enunciado, opciones múltiples,
 * UNA única respuesta correcta y nivel de dificultad.
 * Función pura (no toca red ni estado): fácil de razonar y reutilizar.
 */
export function esPreguntaValida(valor: unknown): valor is Pregunta {
  if (typeof valor !== 'object' || valor === null) return false;
  const p = valor as Record<string, unknown>;

  // Enunciado con contenido real
  if (typeof p.enunciado !== 'string' || p.enunciado.trim().length < 10) return false;

  // Opciones múltiples, no vacías, sin duplicados
  if (!Array.isArray(p.opciones)) return false;
  if (p.opciones.length < 2 || p.opciones.length > 6) return false;
  if (!p.opciones.every((o) => typeof o === 'string' && o.trim().length > 0)) return false;
  const unicas = new Set((p.opciones as string[]).map((o) => o.trim().toLowerCase()));
  if (unicas.size !== p.opciones.length) return false;

  // Única respuesta correcta: un entero dentro del rango de opciones.
  // Number.isInteger() NO es un type guard para TypeScript: estrechamos
  // primero con typeof (que sí lo es) y luego validamos entero.
  const indice = p.indiceCorrecto;
  if (typeof indice !== 'number' || !Number.isInteger(indice)) return false;
  if (indice < 0 || indice >= p.opciones.length) return false;

  // Dificultad válida
  if (!DIFICULTADES.includes(p.dificultad as Dificultad)) return false;

  return true;
}

// ---------- El servicio ----------

// ⚠️ NOMBRE DEL MODELO: se verifica con `node test-modelos.mjs`.
// Los modelos de IA se retiran con el tiempo — si algún día vuelve el 404,
// vuelve a listar los disponibles y actualiza SOLO esta línea.
const MODELO = 'gemini-2.5-flash';
const URL_MODELO = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;
const TIMEOUT_MS = 12000;

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private contadorLocal = 0;

  /**
   * Genera UNA pregunta del tema pedido.
   *
   * MODO TEST (IA_MODO=test en .env): devuelve preguntas generadas
   * localmente, instantáneas y sin gastar cuota. Es un STUB de prueba:
   * permite verificar el motor de combate y desarrollar el frontend sin
   * depender de la disponibilidad/cuota del servicio externo. La
   * integración real con Gemini se verifica por separado (test-ia.mjs).
   *
   * simulacionFallo: SOLO para demostración de R5 — lanza el error sin
   * gastar cuota.
   */
  async generarPregunta(
    tema: string,
    dificultad: Dificultad = dificultadAleatoria(),
    simulacionFallo?: TipoFalloIa,
  ): Promise<Pregunta> {
    if (simulacionFallo) {
      throw new IaError(simulacionFallo, `Fallo simulado (${simulacionFallo}) para demostración`);
    }

    if (process.env.IA_MODO === 'test') {
      return this.generarPreguntaLocal(tema, dificultad);
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new IaError('config', 'El servidor no tiene GEMINI_API_KEY configurada en backend/.env');
    }

    const prompt = [
      'Eres el generador de preguntas del videojuego CodeArena 3D.',
      `Genera UNA pregunta de opción múltiple sobre el tema: "${tema}".`,
      `Nivel de dificultad pedido: ${dificultad}.`,
      'Reglas:',
      '- Exactamente 4 opciones distintas y una sola correcta.',
      '- Debe poder responderse con conocimiento técnico real del tema.',
      '- Responde ÚNICAMENTE con JSON válido (sin markdown ni texto extra), con esta forma exacta:',
      '{"enunciado": "...", "opciones": ["...", "...", "...", "..."], "indiceCorrecto": 0, "dificultad": "facil"}',
    ].join('\n');

    // AbortController: si la API no responde en el timeout, cancelamos (R5)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const respuesta = await fetch(URL_MODELO, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey, // header, no query param: no queda en logs
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.9,
            responseMimeType: 'application/json',
            // gemini-2.5-flash "piensa" antes de responder por defecto; para
            // una trivia no hace falta. Si cambiaras a un modelo que rechace
            // este campo (HTTP 400), borra esta línea y prueba de nuevo.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: controller.signal,
      });

      if (respuesta.status === 429) {
        throw new IaError('limite', 'Se excedió el límite de uso de la IA');
      }
      if (!respuesta.ok) {
        throw new IaError('no_responde', `La IA no respondió correctamente (HTTP ${respuesta.status})`);
      }

      const cuerpo = (await respuesta.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const texto = cuerpo?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof texto !== 'string' || texto.length === 0) {
        throw new IaError('formato', 'La IA no devolvió contenido utilizable');
      }

      let parseado: unknown;
      try {
        parseado = JSON.parse(texto);
      } catch {
        throw new IaError('formato', 'La IA devolvió texto que no es JSON válido');
      }

      if (!esPreguntaValida(parseado)) {
        throw new IaError('formato', 'La pregunta generada no cumple el formato exigido y fue descartada');
      }

      this.logger.log(`Pregunta generada (${parseado.dificultad}) para tema "${tema}"`);
      return {
        enunciado: parseado.enunciado.trim(),
        opciones: parseado.opciones.map((o) => o.trim()),
        indiceCorrecto: parseado.indiceCorrecto,
        dificultad: parseado.dificultad,
      };
    } catch (error) {
      // Los IaError ya están tipados: re-lanzarlos tal cual
      if (error instanceof IaError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new IaError('no_responde', `La IA no respondió en ${TIMEOUT_MS / 1000} segundos`);
      }
      throw new IaError(
        'no_responde',
        `Error de red contactando a la IA: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stub para modo test: determinista (indiceCorrecto = 0), instantáneo,
   * y pasa la MISMA validación R4 que una pregunta real.
   */
  private generarPreguntaLocal(tema: string, dificultad: Dificultad): Pregunta {
    this.contadorLocal++;
    this.logger.log(`Pregunta LOCAL de prueba #${this.contadorLocal} (${tema}, ${dificultad})`);
    return {
      enunciado: `[Prueba ${this.contadorLocal}] ¿Cuál de las siguientes opciones es la afirmación correcta sobre ${tema}?`,
      opciones: ['La opción marcada como correcta', 'Una distracción', 'Otra distracción', 'Una distracción más'],
      indiceCorrecto: 0,
      dificultad,
    };
  }
}
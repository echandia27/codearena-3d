import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import { DatabaseService } from '../database/database.service';
import { Pregunta } from '../ia/gemini.service';
import { PreguntasService } from '../ia/preguntas.service';
import { SalasService } from '../salas/salas.service';

export type Habilidad = 'boost' | 'attack' | 'shield';
export const HABILIDADES_VALIDAS: Habilidad[] = ['boost', 'attack', 'shield'];

// ---------- Reglas del juego (R7: explícitas y medibles) ----------
const HP_INICIAL = 100;
const DANIO_ATAQUE = 25;
const PUNTOS_POR_ACIERTO = 25;
const PENALIZACION_MUERTE = 25;
const DURACION_BOOST_MS = 5000;
const DURACION_ESCUDO_MS = 5000;
const TIEMPO_RESPAWN_MS = 3000;
const PUNTOS_PARA_GANAR = 100;
const DURACION_PARTIDA_MS = 5 * 60_000;
const TIEMPO_RESPUESTA_MS = 20_000;

interface EstadoJugadorPartida {
  hp: number;
  boostHasta: number; // timestamp ms; 0 = sin boost
  escudoHasta: number; // timestamp ms; 0 = sin escudo
  muertoHasta: number; // timestamp ms; 0 = vivo
}

interface PreguntaPendiente {
  id: string;
  pregunta: Pregunta;
  habilidad: Habilidad;
  objetivoId: string | null; // solo attack
  expiraEn: number;
  timer: NodeJS.Timeout;
}

interface Partida {
  salaId: string;
  tema: string;
  jugadores: Map<string, EstadoJugadorPartida>;
  finEn: number;
  timerFin: NodeJS.Timeout;
  pendientes: Map<string, PreguntaPendiente>; // por jugadorId
  timersVarios: Set<NodeJS.Timeout>; // respawns
  finalizada: boolean;
}

/** Lo que responde `responder()` al gateway para feedback personal. */
export type ResultadoRespuesta =
  | { correcta: true; habilidad: Habilidad }
  | { correcta: false; habilidad: Habilidad; motivo: string };

@Injectable()
export class PartidasService {
  private readonly logger = new Logger(PartidasService.name);

  // Código de sala -> partida en curso (memoria: estado efímero por diseño)
  private partidas = new Map<string, Partida>();
  private server: Server | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly preguntas: PreguntasService,
    private readonly salasService: SalasService,
  ) {}

  /** El gateway entrega el servidor Socket.IO en afterInit para poder difundir. */
  adjuntarServidor(server: Server): void {
    this.server = server;
  }

  hayPartida(codigo: string): boolean {
    return this.partidas.has(codigo);
  }

  /**
   * Crea el estado de la partida al terminar el countdown.
   * Idempotente: si ya existe, no hace nada.
   */
  async iniciar(
    codigo: string,
    salaId: string,
    tema: string,
    jugadoresIds: string[],
  ): Promise<void> {
    if (this.partidas.has(codigo)) return;

    const jugadores = new Map<string, EstadoJugadorPartida>();
    for (const id of jugadoresIds) {
      jugadores.set(id, {
        hp: HP_INICIAL,
        boostHasta: 0,
        escudoHasta: 0,
        muertoHasta: 0,
      });
    }

    const timerFin = setTimeout(() => {
      void this.finalizar(codigo, 'tiempo');
    }, DURACION_PARTIDA_MS);

    this.partidas.set(codigo, {
      salaId,
      tema,
      jugadores,
      finEn: Date.now() + DURACION_PARTIDA_MS,
      timerFin,
      pendientes: new Map(),
      timersVarios: new Set(),
      finalizada: false,
    });

    this.logger.log(`Partida iniciada en ${codigo} con ${jugadores.size} jugador(es)`);
    this.emitirEstado(codigo);

    // Respaldo R5: precarga del pool en segundo plano (no bloquea el arranque)
    void this.preguntas.precalentar(tema, 2).catch(() => {
      /* los respaldos son un lujo: si falla, la IA en vivo sigue intentando */
    });
  }

  // ------------------------------------------------------------------
  // R6 — solicitar habilidad => recibir pregunta
  // ------------------------------------------------------------------

  /** Valida el pedido y devuelve la pregunta (SIN la respuesta correcta). */
  async solicitarHabilidad(
    codigo: string,
    jugadorId: string,
    habilidad: Habilidad,
    objetivoId: string | null,
  ): Promise<{
    preguntaId: string;
    habilidad: Habilidad;
    objetivoId: string | null;
    enunciado: string;
    opciones: string[];
    dificultad: Pregunta['dificultad'];
    expiraEn: number;
  }> {
    const partida = this.partidas.get(codigo);
    if (!partida || partida.finalizada) {
      throw new Error('La partida no está en curso');
    }

    const estado = partida.jugadores.get(jugadorId);
    if (!estado) throw new Error('No estás participando en esta partida');
    if (estado.muertoHasta > Date.now()) {
      throw new Error('Estás fuera de combate: esperando respawn');
    }
    if (partida.pendientes.has(jugadorId)) {
      throw new Error('Ya tienes una pregunta pendiente');
    }
    if (!HABILIDADES_VALIDAS.includes(habilidad)) {
      throw new Error('Habilidad desconocida');
    }

    if (habilidad === 'attack') {
      if (!objetivoId) throw new Error('Elige a quién atacar');
      if (objetivoId === jugadorId) throw new Error('No puedes atacarte a ti mismo');
      const objetivo = partida.jugadores.get(objetivoId);
      if (!objetivo) throw new Error('El objetivo no está en la partida');
      if (objetivo.muertoHasta > Date.now()) {
        throw new Error('El objetivo está fuera de combate');
      }
    }

    // La pregunta puede venir de la IA o del pool de respaldo (R5).
    // Si ambos fallan, IaError sube y el gateway lo convierte en mensaje claro.
    const pregunta = await this.preguntas.obtenerPregunta(partida.tema);

    const preguntaId = randomUUID();
    const expiraEn = Date.now() + TIEMPO_RESPUESTA_MS;
    const timer = setTimeout(
      () => this.expirarPregunta(codigo, jugadorId),
      TIEMPO_RESPUESTA_MS,
    );

    partida.pendientes.set(jugadorId, {
      id: preguntaId,
      pregunta,
      habilidad,
      objetivoId: habilidad === 'attack' ? objetivoId : null,
      expiraEn,
      timer,
    });

    // ⚠️ NUNCA incluir indiceCorrecto: el servidor no filtra la respuesta
    return {
      preguntaId,
      habilidad,
      objetivoId: habilidad === 'attack' ? objetivoId : null,
      enunciado: pregunta.enunciado,
      opciones: pregunta.opciones,
      dificultad: pregunta.dificultad,
      expiraEn,
    };
  }

  /** Valida la respuesta y aplica el efecto si es correcta (R6 + R7). */
  async responder(
    codigo: string,
    jugadorId: string,
    preguntaId: string,
    indice: unknown,
  ): Promise<ResultadoRespuesta> {
    const partida = this.partidas.get(codigo);
    if (!partida || partida.finalizada) {
      throw new Error('La partida no está en curso');
    }

    const pendiente = partida.pendientes.get(jugadorId);
    if (!pendiente || pendiente.id !== preguntaId) {
      throw new Error('No tienes esa pregunta pendiente');
    }

    const estado = partida.jugadores.get(jugadorId)!;
    clearTimeout(pendiente.timer);
    partida.pendientes.delete(jugadorId);

    const habilidad = pendiente.habilidad;
    if (estado.muertoHasta > Date.now()) {
      return { correcta: false, habilidad, motivo: 'Quedaste fuera de combate' };
    }

    const correcta =
      typeof indice === 'number' &&
      Number.isInteger(indice) &&
      indice === pendiente.pregunta.indiceCorrecto;

    if (!correcta) {
      // R6: sin respuesta correcta NO hay habilidad. Sin castigo de puntos:
      // el incentivo es positivo (acertar suma, fallar solo no suma).
      return { correcta: false, habilidad, motivo: 'Respuesta incorrecta' };
    }

    // +25 por acertar (R7), siempre — incluso si luego el escudo bloquea
    const nuevoPuntaje = await this.aplicarPuntos(jugadorId, PUNTOS_POR_ACIERTO);

    // Aplicar el efecto de la habilidad
    let bloqueado = false;
    if (habilidad === 'boost') {
      estado.boostHasta = Date.now() + DURACION_BOOST_MS;
    } else if (habilidad === 'shield') {
      estado.escudoHasta = Date.now() + DURACION_ESCUDO_MS;
    } else if (habilidad === 'attack' && pendiente.objetivoId) {
      const objetivo = partida.jugadores.get(pendiente.objetivoId);
      if (objetivo) {
        if (objetivo.escudoHasta > Date.now()) {
          bloqueado = true; // decisión documentada: el escudo protege vida
        } else {
          objetivo.hp -= DANIO_ATAQUE;
          if (objetivo.hp <= 0) {
            await this.morir(codigo, pendiente.objetivoId);
          }
        }
      }
    }

    // A la sala: el efecto es visible para todos (R8)
    this.server?.to(codigo).emit('habilidad:aplicada', {
      jugadorId,
      habilidad,
      objetivoId: pendiente.objetivoId,
      bloqueado,
    });
    this.emitirEstado(codigo);

    // Victoria por puntos (R7): primero en llegar a 100
    if (nuevoPuntaje >= PUNTOS_PARA_GANAR) {
      await this.finalizar(codigo, 'puntos');
    } else {
      await this.emitirSalaEstado(codigo); // scoreboard actualizado
    }

    return { correcta: true, habilidad };
  }

  /** Cancela la pregunta pendiente si el jugador se desconecta a mitad. */
  desconectarJugador(codigo: string, jugadorId: string): void {
    const partida = this.partidas.get(codigo);
    if (!partida) return;
    const pendiente = partida.pendientes.get(jugadorId);
    if (pendiente) {
      clearTimeout(pendiente.timer);
      partida.pendientes.delete(jugadorId);
    }
  }

  // ------------------------------------------------------------------
  // Internos
  // ------------------------------------------------------------------

  /** Timeout de respuesta = como responder mal (R6: sin respuesta no hay habilidad). */
  private expirarPregunta(codigo: string, jugadorId: string): void {
    const partida = this.partidas.get(codigo);
    if (!partida) return;
    const pendiente = partida.pendientes.get(jugadorId);
    if (!pendiente) return;
    partida.pendientes.delete(jugadorId);
    // A la sala; el frontend filtra si es propia o de otro
    this.server?.to(codigo).emit('habilidad:fallida', {
      jugadorId,
      habilidad: pendiente.habilidad,
      motivo: 'Se acabó el tiempo para responder',
    });
  }

  /** Muerte: −25 pts (mínimo 0) y respawn con 100 HP tras 3s. */
  private async morir(codigo: string, jugadorId: string): Promise<void> {
    const partida = this.partidas.get(codigo);
    if (!partida) return;
    const estado = partida.jugadores.get(jugadorId);
    if (!estado) return;

    estado.hp = 0;
    estado.muertoHasta = Date.now() + TIEMPO_RESPAWN_MS;
    await this.aplicarPuntos(jugadorId, -PENALIZACION_MUERTE);

    const timer = setTimeout(() => {
      partida.timersVarios.delete(timer);
      const vigente = partida.jugadores.get(jugadorId);
      if (!vigente || partida.finalizada) return;
      vigente.hp = HP_INICIAL;
      vigente.muertoHasta = 0;
      this.emitirEstado(codigo);
    }, TIEMPO_RESPAWN_MS);
    partida.timersVarios.add(timer);
  }

  /** Puntaje en Postgres (R7: auditable). GREATEST evita puntajes negativos. */
  private async aplicarPuntos(jugadorId: string, delta: number): Promise<number> {
    const res = await this.db.pool.query(
      `UPDATE jugadores SET puntaje = GREATEST(0, puntaje + $1) WHERE id = $2 RETURNING puntaje`,
      [delta, jugadorId],
    );
    return res.rows[0]?.puntaje ?? 0;
  }

  /**
   * R7: cierra la partida. razon 'puntos' (alguien llegó a 100) o 'tiempo'
   * (5 min: gana el de más puntos; empate si igualan).
   */
  async finalizar(codigo: string, razon: 'puntos' | 'tiempo'): Promise<void> {
    const partida = this.partidas.get(codigo);
    if (!partida || partida.finalizada) return;
    partida.finalizada = true;

    clearTimeout(partida.timerFin);
    for (const t of partida.timersVarios) clearTimeout(t);
    for (const p of partida.pendientes.values()) clearTimeout(p.timer);
    partida.pendientes.clear();

    // FINISHED en BD — idempotente y solo desde PLAYING (sección 5 del enunciado)
    await this.db.pool.query(
      `UPDATE salas SET estado = 'FINISHED' WHERE id = $1 AND estado = 'PLAYING'`,
      [partida.salaId],
    );

    // El ganador se lee de la BD: fuente de verdad, no de la memoria
    const res = await this.db.pool.query(
      `SELECT nickname, puntaje FROM jugadores WHERE sala_id = $1 ORDER BY puntaje DESC`,
      [partida.salaId],
    );
    const puntajes = res.rows;
    const max = puntajes[0]?.puntaje ?? 0;
    const empatados = puntajes.filter((p) => p.puntaje === max);
    const ganador =
      max > 0 && empatados.length === 1 ? empatados[0].nickname : null;

    this.logger.log(`Partida ${codigo} finalizada (${razon}). Ganador: ${ganador ?? 'empate'}`);

    // Primero el detalle del cierre, luego el estado que cambia la vista
    this.server?.to(codigo).emit('partida:finalizada', {
      razon,
      ganador,
      empate: empatados.length > 1 || max === 0,
      puntajes,
    });
    await this.emitirSalaEstado(codigo);

    this.partidas.delete(codigo); // liberar memoria
  }

  /** Difunde HP/efectos de todos (R8: la parte de "vida" del estado). */
  private emitirEstado(codigo: string): void {
    const partida = this.partidas.get(codigo);
    if (!partida || !this.server) return;
    const ahora = Date.now();
    const jugadores = [...partida.jugadores.entries()].map(([jugadorId, e]) => ({
      jugadorId,
      hp: e.hp,
      boostRestanteMs: Math.max(0, e.boostHasta - ahora),
      escudoRestanteMs: Math.max(0, e.escudoHasta - ahora),
      muerto: e.muertoHasta > ahora,
      respawnEnMs: Math.max(0, e.muertoHasta - ahora),
    }));
    this.server.to(codigo).emit('partida:estado', {
      codigo,
      finEn: partida.finEn,
      jugadores,
    });
  }

  /** Difunde sala+jugadores (nicknames, puntaje, conexión) tras cambios. */
  private async emitirSalaEstado(codigo: string): Promise<void> {
    if (!this.server) return;
    try {
      const data = await this.salasService.obtenerPorCodigo(codigo);
      this.server.to(codigo).emit('sala:estado', data);
    } catch {
      /* la sala pudo haber desaparecido: nada que difundir */
    }
  }
}
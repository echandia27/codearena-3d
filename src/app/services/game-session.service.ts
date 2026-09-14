import { computed, Injectable, signal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';

/** URL del backend, definida en src/environments/environment.ts */
const API_URL = environment.apiUrl;

/**
 * sessionStorage (no localStorage): los datos viven POR PESTAÑA.
 * Así una pestaña puede ser el jugador A y otra el jugador B en el
 * mismo navegador — es como simulamos el multijugador. Sobrevive a
 * F5 (refresco) pero no a cerrar la pestaña.
 */
const STORAGE_KEY = 'codearena-sesion';

/** Sección 9 del enunciado. Duplicada del backend a propósito: son contextos separados. */
export const TEMAS_VALIDOS: string[] = [
  'Angular', 'TypeScript', 'JavaScript', 'Python', 'Java', 'C#', 'Go',
  'Node.js', 'NestJS', 'React', 'Vue', 'HTML', 'CSS', 'SQL', 'PostgreSQL',
  'MongoDB', 'Docker', 'Git', 'GitHub', 'AWS', 'Azure', 'APIs REST',
  'WebSockets', 'Ciberseguridad', 'Algoritmos', 'Estructuras de datos',
  'Bases de datos', 'Arquitectura de software',
];

export type Habilidad = 'boost' | 'attack' | 'shield';

export interface Sala {
  id: string;
  codigo: string;
  tema: string;
  estado: 'WAITING' | 'PLAYING' | 'FINISHED';
  capacidad_maxima: number;
}

export interface Jugador {
  id: string;
  nickname: string;
  slot: number;
  conectado: boolean;
  listo: boolean;
  puntaje: number;
}

export interface EstadoJugadorPartida {
  jugadorId: string;
  hp: number;
  boostRestanteMs: number;
  escudoRestanteMs: number;
  muerto: boolean;
  respawnEnMs: number;
}

export interface PartidaEstado {
  codigo: string;
  finEn: number;
  recibidoEn: number;
  jugadores: EstadoJugadorPartida[];
}

/** Pregunta tal como llega al cliente: SIN la respuesta correcta (R4/R6). */
export interface PreguntaPendiente {
  preguntaId: string;
  habilidad: Habilidad;
  objetivoId: string | null;
  enunciado: string;
  opciones: string[];
  dificultad: string;
  expiraEn: number;
}

export interface ResultadoFinal {
  razon: 'puntos' | 'tiempo';
  ganador: string | null;
  empate: boolean;
  puntajes: Array<{ nickname: string; puntaje: number }>;
}

/**
 * Único puente entre el navegador y el servidor por WebSocket.
 * Centraliza la conexión y expone el estado del juego como signals:
 * es el "espejo en el cliente" del estado que el servidor difunde (R8).
 * El cliente NUNCA decide nada del juego; solo envía intenciones.
 */
@Injectable({ providedIn: 'root' })
export class GameSessionService {
  private socket: Socket;
  private jugadorIdActual: string | null = null;
  private reconectando = false;
  private timerAviso: ReturnType<typeof setTimeout> | null = null;

  // --- Estado del juego, reactivo para todas las pantallas ---
  sala = signal<Sala | null>(null);
  jugadores = signal<Jugador[]>([]);
  jugadorPropio = signal<Jugador | null>(null);
  error = signal<string | null>(null);
  cuentaRegresiva = signal<number | null>(null);
  partidaIniciada = signal(false);
  posicionesOtros = new Map<string, { x: number; y: number; z: number }>();

  // --- Estado de combate ---
  partidaEstado = signal<PartidaEstado | null>(null);
  preguntaActual = signal<PreguntaPendiente | null>(null);
  avisoHabilidad = signal<string | null>(null);
  resultadoFinal = signal<ResultadoFinal | null>(null);

  /** Qué pantalla renderiza App según el estado de la sala. */
  vista = computed<'home' | 'lobby' | 'arena' | 'resultados'>(() => {
    if (this.resultadoFinal()) return 'resultados';
    const sala = this.sala();
    if (!sala) return 'home';
    if (sala.estado === 'FINISHED') return 'resultados';
    return sala.estado === 'PLAYING' ? 'arena' : 'lobby';
  });

  constructor() {
    this.socket = io(API_URL);
    this.registrarEventos();
  }

  // ---------- Acciones: intenciones que enviamos al servidor ----------

  crearSala(nickname: string, tema: string): void {
    this.error.set(null);
    this.socket.emit('sala:crear', { nickname, tema });
  }

  unirseSala(codigo: string, nickname: string): void {
    this.error.set(null);
    this.socket.emit('sala:unirse', { codigo, nickname });
  }

  marcarListo(): void {
    const sala = this.sala();
    if (!sala || !this.jugadorIdActual) return;
    this.socket.emit('jugador:listo', {
      codigo: sala.codigo,
      jugadorId: this.jugadorIdActual,
    });
  }

  enviarPosicion(x: number, y: number, z: number): void {
    this.socket.emit('drone:posicion', { x, y, z });
  }

  /** R6 paso 1: pedir habilidad. El servidor responde con pregunta o error. */
  solicitarHabilidad(habilidad: Habilidad, objetivoId: string | null): void {
    if (!this.preguntaActual()) this.avisoHabilidad.set(null);
    this.socket.emit('habilidad:solicitar', { habilidad, objetivoId });
  }

  /** R6 paso 2: responder la pregunta abierta. */
  responderPregunta(indice: number): void {
    const p = this.preguntaActual();
    if (!p) return;
    this.socket.emit('pregunta:responder', { preguntaId: p.preguntaId, indice });
  }

  /** Volver al inicio desde la pantalla de resultados. */
  reiniciar(): void {
    sessionStorage.removeItem(STORAGE_KEY);
    this.jugadorIdActual = null;
    this.reconectando = false;
    this.sala.set(null);
    this.jugadores.set([]);
    this.jugadorPropio.set(null);
    this.error.set(null);
    this.cuentaRegresiva.set(null);
    this.partidaIniciada.set(false);
    this.partidaEstado.set(null);
    this.preguntaActual.set(null);
    this.avisoHabilidad.set(null);
    this.resultadoFinal.set(null);
    this.posicionesOtros.clear();
  }

  // ---------- Eventos que el servidor nos emite ----------

  private registrarEventos(): void {
    this.socket.on('connect', () => {
      // Al (re)conectar, si esta pestaña tenía una sesión guardada,
      // intenta retomar su lugar en la sala (base de R9).
      const guardado = sessionStorage.getItem(STORAGE_KEY);
      if (!guardado) return;
      const { codigo, jugadorId } = JSON.parse(guardado) as {
        codigo: string;
        jugadorId: string;
      };
      this.reconectando = true;
      this.jugadorIdActual = jugadorId;
      this.socket.emit('sala:conectar', { codigo, jugadorId });
    });

    this.socket.on('sala:unido', (data: { sala: Sala; jugador: Jugador }) => {
      this.reconectando = false;
      this.jugadorIdActual = data.jugador.id;
      this.sala.set(data.sala);
      this.jugadorPropio.set(data.jugador);
      this.partidaIniciada.set(false);
      this.cuentaRegresiva.set(null);
      this.partidaEstado.set(null);
      this.preguntaActual.set(null);
      this.avisoHabilidad.set(null);
      this.resultadoFinal.set(null);
      this.error.set(null);
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ codigo: data.sala.codigo, jugadorId: data.jugador.id }),
      );
    });

    this.socket.on('sala:estado', (data: { sala: Sala; jugadores: Jugador[] }) => {
      this.sala.set(data.sala);
      this.jugadores.set(data.jugadores);
      const propio = data.jugadores.find((j) => j.id === this.jugadorIdActual);
      if (propio) this.jugadorPropio.set(propio);

      // Limpieza de posiciones efímeras de jugadores que ya no están
      const idsConectados = new Set(
        data.jugadores.filter((j) => j.conectado).map((j) => j.id),
      );
      for (const id of this.posicionesOtros.keys()) {
        if (!idsConectados.has(id)) this.posicionesOtros.delete(id);
      }

      if (this.reconectando) {
        this.reconectando = false;
        // Reconexión a una partida que YA venía corriendo: si en 1.5s no
        // llega ni countdown ni 'partida:iniciada', asumimos partida en curso
        setTimeout(() => {
          if (
            this.sala()?.estado === 'PLAYING' &&
            !this.partidaIniciada() &&
            this.cuentaRegresiva() === null
          ) {
            this.partidaIniciada.set(true);
          }
        }, 1500);
      }
    });

    // Posición de OTRO drone: guardarla para que el loop 3D la interpole
    this.socket.on(
      'drone:posicion',
      (data: { jugadorId: string; x: number; y: number; z: number }) => {
        this.posicionesOtros.set(data.jugadorId, { x: data.x, y: data.y, z: data.z });
      },
    );

    this.socket.on('cuenta:regresiva', (data: { segundos: number }) => {
      this.cuentaRegresiva.set(data.segundos);
    });

    this.socket.on('partida:iniciada', () => {
      this.cuentaRegresiva.set(null);
      this.partidaIniciada.set(true);
    });

    // --- Combate ---

    this.socket.on('partida:estado', (data: Omit<PartidaEstado, 'recibidoEn'>) => {
      // recibidoEn permite calcular en el cliente cuánto queda REALMENTE
      // de boost/escudo/respawn entre actualizaciones
      this.partidaEstado.set({ ...data, recibidoEn: Date.now() });
    });

    this.socket.on('pregunta:nueva', (data: PreguntaPendiente) => {
      this.preguntaActual.set(data);
    });

    this.socket.on('habilidad:aplicada', (data: { jugadorId: string; habilidad: Habilidad }) => {
      // Solo cierra MI modal; el efecto visual llega con partida:estado
      if (data.jugadorId === this.jugadorIdActual) {
        this.preguntaActual.set(null);
      }
    });

    this.socket.on('habilidad:fallida', (data: { jugadorId: string; motivo: string }) => {
      if (data.jugadorId === this.jugadorIdActual) {
        this.preguntaActual.set(null);
        this.mostrarAviso(data.motivo);
      }
    });

    this.socket.on('habilidad:error', (data: { mensaje: string }) => {
      this.preguntaActual.set(null);
      this.mostrarAviso(data.mensaje);
    });

    this.socket.on('partida:finalizada', (data: ResultadoFinal) => {
      this.preguntaActual.set(null);
      this.resultadoFinal.set(data);
    });

    this.socket.on('sala:error', (data: { mensaje: string }) => {
      if (this.reconectando) {
        // La sesión guardada ya no existe en el servidor: limpieza y al inicio
        sessionStorage.removeItem(STORAGE_KEY);
        this.reconectando = false;
        this.jugadorIdActual = null;
        this.sala.set(null);
        this.jugadorPropio.set(null);
        this.error.set('Tu sesión anterior ya no existe. Crea o únete a una sala.');
        return;
      }
      this.error.set(data.mensaje);
    });
  }

  private mostrarAviso(mensaje: string): void {
    this.avisoHabilidad.set(mensaje);
    if (this.timerAviso) clearTimeout(this.timerAviso);
    this.timerAviso = setTimeout(() => this.avisoHabilidad.set(null), 4000);
  }
}
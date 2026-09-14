import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CrearSalaDto } from './salas.dto';

// Código de error de Postgres cuando se viola un UNIQUE
const PG_UNIQUE_VIOLATION = '23505';

// Sin 0/O ni 1/I/L: evita confusión al leer el código en voz alta
const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generarCodigo(longitud = 4): string {
  let codigo = '';
  for (let i = 0; i < longitud; i++) {
    codigo += ALFABETO_CODIGO[Math.floor(Math.random() * ALFABETO_CODIGO.length)];
  }
  return codigo;
}

/**
 * En un catch, TypeScript moderno entrega la variable como `unknown`
 * (no hay forma de saber qué se lanzó). Este guard comprueba de forma
 * segura si es un error de Postgres con propiedad `code` de tipo string.
 */
function esErrorPg(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

@Injectable()
export class SalasService {
  constructor(private readonly db: DatabaseService) {}

  /** Crea la sala + su primer jugador (el creador). R1: código único. */
  async crear(dto: CrearSalaDto) {
    for (let intento = 0; intento < 5; intento++) {
      const codigo = generarCodigo();
      const client = await this.db.pool.connect();
      try {
        await client.query('BEGIN');
        const salaRes = await client.query(
          `INSERT INTO salas (codigo, tema) VALUES ($1, $2) RETURNING *`,
          [codigo, dto.tema],
        );
        const jugadorRes = await client.query(
          `INSERT INTO jugadores (sala_id, nickname, slot) VALUES ($1, $2, 0) RETURNING *`,
          [salaRes.rows[0].id, dto.nickname],
        );
        await client.query('COMMIT');
        return { sala: salaRes.rows[0], jugador: jugadorRes.rows[0] };
      } catch (error) {
        await client.query('ROLLBACK');
        // Colisión de código (probabilidad bajísima): reintenta con otro
        if (esErrorPg(error) && error.code === PG_UNIQUE_VIOLATION && intento < 4) {
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
    throw new Error('No se pudo generar un código único tras 5 intentos');
  }

  /** Une un jugador. R2 y R3 resueltos A NIVEL DE BASE DE DATOS. */
  async unirse(codigo: string, nickname: string) {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');

      // 1) Bloquea la fila de la sala. Si otro request está haciendo join
      //    a la MISMA sala, este espera aquí hasta que el otro termine.
      const salaRes = await client.query(
        `SELECT * FROM salas WHERE codigo = $1 FOR UPDATE`,
        [codigo],
      );
      if (salaRes.rows.length === 0) {
        throw new NotFoundException(`Sala ${codigo} no encontrada`);
      }
      const sala = salaRes.rows[0];

      // 2) Solo salas en espera aceptan jugadores (decisión documentada)
      if (sala.estado !== 'WAITING') {
        throw new ConflictException('La partida ya comenzó o terminó');
      }

      // 3) ¿Hay cupo? (R2)
      const totalRes = await client.query(
        `SELECT count(*)::int AS total FROM jugadores WHERE sala_id = $1`,
        [sala.id],
      );
      if (totalRes.rows[0].total >= sala.capacidad_maxima) {
        throw new ConflictException('La sala está llena (máximo 4 jugadores)');
      }

      // 4) Primer slot libre (0..3) para el nuevo jugador
      const slotRes = await client.query(
        `SELECT COALESCE(MIN(s), -1)::int AS slot_libre
           FROM generate_series(0, $2) AS s
          WHERE NOT EXISTS (
            SELECT 1 FROM jugadores j WHERE j.sala_id = $1 AND j.slot = s
          )`,
        [sala.id, sala.capacidad_maxima - 1],
      );
      const slot = slotRes.rows[0].slot_libre;
      if (slot < 0) {
        throw new ConflictException('La sala está llena (máximo 4 jugadores)');
      }

      // 5) Inserta. El UNIQUE(sala_id, slot) es la última línea de defensa:
      //    ni con un bug en este código, Postgres permitiría un 5° jugador.
      const jugadorRes = await client.query(
        `INSERT INTO jugadores (sala_id, nickname, slot) VALUES ($1, $2, $3) RETURNING *`,
        [sala.id, nickname, slot],
      );

      await client.query('COMMIT');
      return { sala, jugador: jugadorRes.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      if (esErrorPg(error) && error.code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('La sala está llena (máximo 4 jugadores)');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Estado completo de la sala: la fuente de verdad que difunde el gateway. */
  async obtenerPorCodigo(codigo: string) {
    const salaRes = await this.db.pool.query(
      `SELECT * FROM salas WHERE codigo = $1`,
      [codigo],
    );
    if (salaRes.rows.length === 0) {
      throw new NotFoundException(`Sala ${codigo} no encontrada`);
    }
    const jugadoresRes = await this.db.pool.query(
      `SELECT id, nickname, slot, conectado, listo, puntaje
         FROM jugadores WHERE sala_id = $1 ORDER BY slot`,
      [salaRes.rows[0].id],
    );
    return { sala: salaRes.rows[0], jugadores: jugadoresRes.rows };
  }

  /** R9: marca la conexión de un jugador (true al conectar, false al caer). */
  async marcarConexion(jugadorId: string, conectado: boolean): Promise<void> {
    await this.db.pool.query(
      `UPDATE jugadores SET conectado = $2 WHERE id = $1`,
      [jugadorId, conectado],
    );
  }

  /** Marca a un jugador como "Listo" para empezar. */
  async marcarListo(jugadorId: string): Promise<void> {
    const res = await this.db.pool.query(
      `UPDATE jugadores SET listo = true WHERE id = $1`,
      [jugadorId],
    );
    if (res.rowCount === 0) {
      throw new NotFoundException('Jugador no encontrado');
    }
  }

  /**
   * WAITING → PLAYING. Nunca hacia atrás (sección 5 del enunciado).
   * El "AND estado = 'WAITING'" hace la operación idempotente: aunque
   * se llame dos veces por carrera, el estado no se toca dos veces.
   */
  async iniciarPartida(salaId: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE salas SET estado = 'PLAYING' WHERE id = $1 AND estado = 'WAITING'`,
      [salaId],
    );
  }
}
import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';

/**
 * Único punto de conexión con PostgreSQL (Supabase).
 * El Pool mantiene conexiones reutilizables para no pagar
 * un handshake en cada request.
 *
 * Usamos parámetros discretos (host/user/password) en vez de
 * connection string: evita toda la clase de bugs de URL-encoding
 * y permite validar cada variable por separado al arrancar.
 */
@Injectable()
export class DatabaseService {
  readonly pool: Pool;

  constructor() {
    const requeridas = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
    const faltantes = requeridas.filter((key) => !process.env[key]);
    if (faltantes.length > 0) {
      throw new Error(
        `Faltan variables en backend/.env: ${faltantes.join(', ')}`,
      );
    }

    this.pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
  }
}
/**
 * Diagnóstico: prueba la conexión con Supabase INDEPENDIENTE del backend.
 * Si falla con "faltan variables" → el .env no se está leyendo (¿se llama
 * .env y no .env.txt? ¿está en backend/?)
 * Si falla con auth → revisa DB_USER y DB_PASSWORD contra el Connect dialog.
 * Uso: node test-db.mjs
 */
import pg from 'pg';
import 'dotenv/config';

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;

// Verificación temprana: si falta algo, error claro en vez de crípticos
// mensajes SASL después
const faltantes = Object.entries({ DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME })
  .filter(([, valor]) => valor === undefined)
  .map(([nombre]) => nombre);
if (faltantes.length > 0) {
  console.error(`❌ Faltan variables en .env: ${faltantes.join(', ')}`);
  process.exit(1);
}

// Confirmamos que dotenv cargó los valores SIN imprimir la contraseña
console.log(
  `Conectando a ${DB_HOST}:${DB_PORT} como ${DB_USER} ` +
  `(password cargada: ${'*'.repeat(DB_PASSWORD.length)} — ${DB_PASSWORD.length} caracteres)`,
);

const client = new pg.Client({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD, // string crudo: aquí NO existe el URL-encoding
  database: DB_NAME,
});

try {
  await client.connect();
  const res = await client.query('SELECT count(*)::int AS total FROM salas');
  console.log('✅ Conexión OK. Filas en salas:', res.rows[0].total);
} catch (error) {
  console.error('❌ Error de conexión:', error.message);
} finally {
  await client.end();
}
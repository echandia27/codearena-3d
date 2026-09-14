/**
 * Prueba integral del Gateway (Sesión 3B-1).
 * Verifica: crear por WS, unirse por WS, difusión del estado (R8),
 * flujo Listo → cuenta regresiva → PLAYING, y unión tardía rechazada.
 *
 * Lección de esta versión: los eventos llegan en orden, pero nuestro
 * código se ejecuta ENTRE ellos. Un estado emitido antes (ej: el de la
 * creación, con 1 jugador) puede disparar un listener recién registrado.
 * Por eso esperamos por CONDICIÓN sobre el payload, no por llegada del evento.
 *
 * Uso: node test-socket.mjs  (con el backend corriendo en :3001)
 */
import { io } from 'socket.io-client';

const URL = 'http://localhost:3001';

function conectar() {
  return io(URL);
}

/** Espera un evento concreto, con timeout para no colgar el script. */
function esperar(socket, evento, ms = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout esperando '${evento}'`)),
      ms,
    );
    socket.once(evento, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Espera un 'sala:estado' que CUMPLA la condición dada.
 * Si llega un estado que no la cumple (un estado "viejo" en vuelo),
 * lo reporta y sigue esperando — así la carrera de eventos se hace visible.
 */
function esperarEstado(socket, condicion, descripcion, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('sala:estado', handler);
      reject(new Error(`Timeout esperando estado: ${descripcion}`));
    }, ms);

    const handler = (data) => {
      if (condicion(data)) {
        clearTimeout(timer);
        socket.off('sala:estado', handler);
        resolve(data);
      } else {
        console.log(
          `   … estado intermedio ignorado (${data.jugadores.length} jugador/es) — ` +
            `esperando: ${descripcion}`,
        );
      }
    };
    socket.on('sala:estado', handler);
  });
}

async function main() {
  // --- 1) Crear sala por WebSocket ---
  const anfitrion = conectar();
  anfitrion.emit('sala:crear', { nickname: 'anfitrion', tema: 'WebSockets' });
  const creado = await esperar(anfitrion, 'sala:unido');
  console.log(`✅ Sala creada por WS: ${creado.sala.codigo} (tema: ${creado.sala.tema})`);

  // --- 2) Unirse por WS + verificar difusión al anfitrión (R8) ---
  const invitado = conectar();
  // Esperamos el estado que INCLUYA al invitado (condición, no llegada)
  const promesaEstadoAnfitrion = esperarEstado(
    anfitrion,
    (estado) => estado.jugadores.length === 2,
    'anfitrión ve 2 jugadores',
  );
  invitado.emit('sala:unirse', { codigo: creado.sala.codigo, nickname: 'invitado' });
  const unido = await esperar(invitado, 'sala:unido');
  const estadoAnfitrion = await promesaEstadoAnfitrion;
  console.log(`✅ Invitado unido (slot ${unido.jugador.slot})`);
  console.log('✅ R8: el anfitrión vio al invitado aparecer sin recargar nada');

  // --- 3) Ambos marcan Listo → countdown → partida:iniciada ---
  const promesaIniciada = esperar(anfitrion, 'partida:iniciada', 10000);
  anfitrion.emit('jugador:listo', { codigo: creado.sala.codigo, jugadorId: creado.jugador.id });
  await new Promise((r) => setTimeout(r, 300)); // margen para que el servidor procese
  invitado.emit('jugador:listo', { codigo: creado.sala.codigo, jugadorId: unido.jugador.id });

  const tick = await esperar(anfitrion, 'cuenta:regresiva');
  console.log(`✅ Cuenta regresiva iniciada (primer tick: ${tick.segundos}s)`);
  await promesaIniciada;
  console.log('✅ partida:iniciada recibida tras la cuenta regresiva');

  // --- 4) Verificar PLAYING en la BD vía REST (misma fuente de verdad) ---
  const res = await fetch(`${URL}/salas/${creado.sala.codigo}`);
  const final = await res.json();
  if (final.sala.estado !== 'PLAYING') {
    throw new Error(`Se esperaba PLAYING, llegó ${final.sala.estado}`);
  }
  console.log('✅ Estado persistido en BD: PLAYING (verificado vía REST)');

  // --- 5) Unión tardía → rechazo claro ---
  const tercero = conectar();
  tercero.emit('sala:unirse', { codigo: creado.sala.codigo, nickname: 'tardio' });
  const error = await esperar(tercero, 'sala:error');
  console.log(`✅ Unión tardía rechazada: "${error.mensaje}"`);

  [anfitrion, invitado, tercero].forEach((s) => s.disconnect());
  console.log('\n🎉 Todos los checks de la Sesión 3B-1 pasaron');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
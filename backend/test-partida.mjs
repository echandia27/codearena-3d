/**
 * Prueba del motor de combate (Sesión 4B-1) — v9
 *
 * Historial: v3 (errores son respuestas) · v5 (monitoreo global) ·
 * v7 (no emitir antes de connect) · v8 (stub IA_MODO=test) ·
 * v8.2 (sintaxis) · v9: "La partida no está en curso" NO es un error
 * reintentable — es la señal de que la partida YA terminó (carrera
 * REST-vs-evento: el UPDATE de FINISHED puede ser posterior a la
 * lectura REST del test). El loop --full la captura y verifica FINISHED.
 *
 * Uso: node test-partida.mjs [--full]   (~1 min con stub activo)
 * Requiere: backend en :3001 con IA_MODO=test.
 */
import { io } from 'socket.io-client';

const URL = 'http://localhost:3001';
const FULL = process.argv.includes('--full');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Señal de que la partida ya no está jugándose (no se reintenta). */
class PartidaTerminada extends Error {}

function conectar(nombre) {
  const socket = io(URL);
  socket.on('connect', () => console.log(`   [${nombre}] conectado al gateway`));
  socket.on('disconnect', (razon) => console.log(`   [${nombre}] desconectado (${razon})`));
  socket.on('connect_error', (err) =>
    console.log(`   [${nombre}] ⚠️ ERROR de conexión: ${err.message}`),
  );
  socket.on('sala:error', (data) =>
    console.log(`   [${nombre}] ⚠️ sala:error: "${data.mensaje}"`),
  );
  socket.on('habilidad:error', (data) =>
    console.log(`   [${nombre}] ⚠️ habilidad:error: "${data.mensaje}"`),
  );
  return socket;
}

/** Nunca emitir antes de 'connect' (lección v7). */
function esperarConexion(socket, nombre, ms = 15000) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('connect', onConnect);
      reject(new Error(`[${nombre}] no se pudo conectar en ${ms}ms`));
    }, ms);
    const onConnect = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.once('connect', onConnect);
  });
}

/** Espera un evento; resuelve con el PAYLOAD directo. */
function esperar(socket, evento, ms = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(evento, handler);
      reject(new Error(`Timeout esperando '${evento}'`));
    }, ms);
    const handler = (data) => {
      clearTimeout(timer);
      socket.off(evento, handler);
      resolve(data);
    };
    socket.on(evento, handler);
  });
}

/** Espera el PRIMERO de varios eventos; devuelve {evento, data}. */
function esperarAlguno(socket, eventos, ms = 25000) {
  return new Promise((resolve, reject) => {
    const timers = [];
    const handlers = {};
    const limpiar = () => {
      timers.forEach(clearTimeout);
      for (const e of eventos) socket.off(e, handlers[e]);
    };
    const timer = setTimeout(() => {
      limpiar();
      reject(new Error(`Timeout esperando alguno de: ${eventos.join(', ')}`));
    }, ms);
    timers.push(timer);
    for (const e of eventos) {
      handlers[e] = (data) => {
        limpiar();
        resolve({ evento: e, data });
      };
      socket.on(e, handlers[e]);
    }
  });
}

/** Espera un 'partida:estado' que CUMPLA la condición. */
function esperarPartidaEstado(socket, condicion, descripcion, ms = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('partida:estado', handler);
      reject(new Error(`Timeout esperando estado: ${descripcion}`));
    }, ms);
    const handler = (data) => {
      if (condicion(data)) {
        clearTimeout(timer);
        socket.off('partida:estado', handler);
        resolve(data);
      }
    };
    socket.on('partida:estado', handler);
  });
}

async function salaREST(codigo) {
  const res = await fetch(`${URL}/salas/${codigo}`);
  return res.json();
}

/**
 * Solicita habilidad y espera la pregunta (escucha también habilidad:error).
 * Si el servidor dice que la partida no está en curso, es señal TERMINAL:
 * se lanza PartidaTerminada sin reintentar (lección v9).
 */
async function pedirPregunta(socket, habilidad, objetivoId, intentosMax = 5) {
  for (let i = 1; i <= intentosMax; i++) {
    socket.emit('habilidad:solicitar', { habilidad, objetivoId });
    const recibido = await esperarAlguno(
      socket,
      ['pregunta:nueva', 'habilidad:error'],
      20000,
    );
    if (recibido.evento === 'pregunta:nueva') return recibido.data;

    const mensaje = recibido.data.mensaje ?? '';
    if (/no está en curso/i.test(mensaje)) {
      throw new PartidaTerminada(mensaje);
    }
    console.log(`   … solicitud ${i} con error: "${mensaje}" — esperando 8s`);
    await sleep(8000);
  }
  throw new Error(
    `No se obtuvo pregunta para '${habilidad}' tras ${intentosMax} intentos. ` +
      `PISTA: revisa que backend/.env tenga IA_MODO=test y que hayas REINICIADO el backend.`,
  );
}

/** Responde un índice y espera el desenlace de ESA respuesta. */
async function responder(socket, preguntaId, indice) {
  socket.emit('pregunta:responder', { preguntaId, indice });
  return esperar(socket, 'habilidad:aplicada');
}

async function main() {
  // --- 1) Sala + countdown + inicio ---
  const a = conectar('p1');
  await esperarConexion(a, 'p1');
  a.emit('sala:crear', { nickname: 'p1', tema: 'WebSockets' });
  const creado = await esperar(a, 'sala:unido');
  const codigo = creado.sala.codigo;
  const idA = creado.jugador.id;

  const b = conectar('p2');
  await esperarConexion(b, 'p2');
  b.emit('sala:unirse', { codigo, nickname: 'p2' });
  const unido = await esperar(b, 'sala:unido');
  const idB = unido.jugador.id;

  const promesaIniciada = esperar(a, 'partida:iniciada');
  a.emit('jugador:listo', { codigo, jugadorId: idA });
  await sleep(300);
  b.emit('jugador:listo', { codigo, jugadorId: idB });
  await promesaIniciada;
  console.log(`✅ Partida iniciada en sala ${codigo}`);

  // --- 2) Estado inicial: HP 100 para ambos ---
  const estado0 = await esperar(a, 'partida:estado');
  const eA0 = estado0.jugadores.find((j) => j.jugadorId === idA);
  const eB0 = estado0.jugadores.find((j) => j.jugadorId === idB);
  if (eA0.hp !== 100 || eB0.hp !== 100) throw new Error('HP inicial incorrecta');
  console.log('✅ Estado inicial: ambos con 100 HP');

  // --- 3) La pregunta NO viaja con la respuesta ---
  const pregunta = await pedirPregunta(a, 'boost', null);
  if ('indiceCorrecto' in pregunta) {
    throw new Error('FUGA: la pregunta incluye indiceCorrecto');
  }
  if (!Array.isArray(pregunta.opciones) || pregunta.opciones.length < 2) {
    throw new Error('Pregunta malformada');
  }
  console.log('✅ Pregunta recibida SIN la respuesta correcta');

  // --- 4) R6: respuesta inválida (99) y respuesta incorrecta (1) ---
  a.emit('pregunta:responder', { preguntaId: pregunta.preguntaId, indice: 99 });
  const falloInvalida = await esperar(a, 'habilidad:fallida');
  if (falloInvalida.jugadorId !== idA) throw new Error('Fallo atribuido al jugador equivocado');
  console.log('✅ R6: respuesta inválida => habilidad NO activada');

  const p2 = await pedirPregunta(a, 'boost', null);
  a.emit('pregunta:responder', { preguntaId: p2.preguntaId, indice: 1 });
  const falloIncorrecta = await esperar(a, 'habilidad:fallida');
  if (!/incorrecta/i.test(falloIncorrecta.motivo)) {
    throw new Error(`Fallo inesperado: ${falloIncorrecta.motivo}`);
  }
  console.log('✅ R6: respuesta incorrecta => habilidad NO activada');

  // --- 5) Boost correcto => activo + +25 pts (R7) ---
  const promesaBoost = esperarPartidaEstado(
    a,
    (e) => e.jugadores.find((j) => j.jugadorId === idA)?.boostRestanteMs > 0,
    'boost activo para p1',
  );
  const p3 = await pedirPregunta(a, 'boost', null);
  const aplicado = await responder(a, p3.preguntaId, 0);
  if (aplicado.habilidad !== 'boost') throw new Error(`Habilidad inesperada: ${aplicado.habilidad}`);
  await promesaBoost;
  console.log('✅ Boost activo (partida:estado lo refleja)');

  const sala1 = await salaREST(codigo);
  const puntosA = sala1.jugadores.find((j) => j.id === idA).puntaje;
  if (puntosA !== 25) throw new Error(`Se esperaba 25 pts para p1, hay ${puntosA}`);
  console.log('✅ R7: +25 pts persistidos en BD (verificado vía REST)');

  // --- 6) Attack de p2 sobre p1 => −25 HP ---
  const promesaAtaque = esperarPartidaEstado(
    b,
    (e) => e.jugadores.find((j) => j.jugadorId === idA)?.hp === 75,
    'p1 con 75 HP',
  );
  const pa = await pedirPregunta(b, 'attack', idA);
  const aplicadoAtaque = await responder(b, pa.preguntaId, 0);
  if (aplicadoAtaque.habilidad !== 'attack') throw new Error('No se aplicó attack');
  await promesaAtaque;
  console.log('✅ Attack: p1 quedó con 75 HP');

  // --- 7) Timeout: no responder => la habilidad no se activa (R6) ---
  console.log('Probando timeout (20s sin responder)...');
  await pedirPregunta(a, 'shield', null);
  const falloTimeout = await esperar(a, 'habilidad:fallida', 25000);
  if (!/tiempo/i.test(falloTimeout.motivo)) {
    throw new Error(`Fallo inesperado: ${falloTimeout.motivo}`);
  }
  console.log('✅ R6: sin respuesta a tiempo => habilidad no activada');

  if (!FULL) {
    [a, b].forEach((s) => s.disconnect());
    console.log('\n🎉 Mecánicas de combate verificadas. Corre con --full para jugar hasta la victoria.');
    return;
  }

  // --- 8) (--full) Victoria a 100 pts (R7) ---
  // v9: si p1 llega a 100 a mitad de iteración, el servidor finaliza la
  // partida; el REST puede leerse unos ms antes del UPDATE FINISHED y el
  // próximo 'habilidad:solicitar' recibirá "no está en curso" (PartidaTerminada).
  // Eso NO es fallo: confirma el fin, y el REST posterior validará FINISHED.
  console.log('\nJugando hasta la victoria (p1 necesita llegar a 100 pts)...');
  const promesaFin = esperar(a, 'partida:finalizada', 60000);
  let termino = false;
  for (let vuelta = 0; vuelta < 10 && !termino; vuelta++) {
    const sala = await salaREST(codigo);
    if (sala.sala.estado === 'FINISHED') break;
    const mios = sala.jugadores.find((j) => j.id === idA);
    console.log(`   p1 tiene ${mios.puntaje} pts — logrando otro Boost...`);
    try {
      const px = await pedirPregunta(a, 'boost', null);
      await responder(a, px.preguntaId, 0);
    } catch (e) {
      if (e instanceof PartidaTerminada) {
        console.log(`   ℹ️ ${e.message} — la partida ya se cerró con la victoria`);
        termino = true;
        break;
      }
      throw e;
    }
  }
  const fin = await promesaFin;
  if (fin.razon !== 'puntos') throw new Error(`Razón de fin inesperada: ${fin.razon}`);
  if (fin.ganador !== 'p1') throw new Error(`Ganador inesperado: ${fin.ganador}`);

  // Respiro para que el UPDATE de FINISHED sea visible vía REST, y confirmar
  await sleep(500);
  const salaFinal = await salaREST(codigo);
  if (salaFinal.sala.estado !== 'FINISHED') throw new Error('La sala no quedó en FINISHED');
  console.log(`✅ R7: partida finalizada (${fin.razon}) — ganador: ${fin.ganador}`);
  console.log('✅ Sala persistida en FINISHED (verificado vía REST)');

  [a, b].forEach((s) => s.disconnect());
  console.log('\n🎉 Motor de combate completo verificado');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
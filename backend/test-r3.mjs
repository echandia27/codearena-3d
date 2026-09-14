/**
 * Prueba de la regla R3: dos jugadores compiten por el último cupo
 * AL MISMO TIEMPO. Resultado esperado: exactamente 1 entra, 1 rechazado.
 * Uso: node test-r3.mjs  (con el backend corriendo en :3001)
 */
const BASE = 'http://localhost:3001';

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function main() {
  // 1) Crear sala → 1 jugador dentro
  const sala = await post('/salas', { nickname: 'p1', tema: 'SQL' });
  const codigo = sala.data.sala.codigo;
  console.log(`Sala creada: ${codigo}`);

  // 2) Llegar a 3 jugadores (secuencial)
  await post(`/salas/${codigo}/jugadores`, { nickname: 'p2' });
  await post(`/salas/${codigo}/jugadores`, { nickname: 'p3' });
  console.log('3 jugadores en sala — queda 1 cupo libre');

  // 3) Dos intentos SIMULTÁNEOS por el último cupo (Promise.all = mismo instante)
  const [a, b] = await Promise.all([
    post(`/salas/${codigo}/jugadores`, { nickname: 'p4-A' }),
    post(`/salas/${codigo}/jugadores`, { nickname: 'p4-B' }),
  ]);
  console.log(`Intento A: ${a.status} → ${a.status === 201 ? 'ENTRÓ' : a.data.message}`);
  console.log(`Intento B: ${b.status} → ${b.status === 201 ? 'ENTRÓ' : b.data.message}`);

  // 4) Verificación final
  const room = await fetch(`${BASE}/salas/${codigo}`).then((r) => r.json());
  const entraron = [a.status, b.status].filter((s) => s === 201).length;
  const rechazados = [a.status, b.status].filter((s) => s === 409).length;
  console.log(`Jugadores totales en sala: ${room.jugadores.length}`);

  if (entraron === 1 && rechazados === 1 && room.jugadores.length === 4) {
    console.log('✅ R3 VERIFICADA: solo uno entró, el otro fue rechazado con mensaje claro');
  } else {
    console.log('❌ R3 FALLÓ — pégame la salida completa');
    process.exit(1);
  }
}

main();
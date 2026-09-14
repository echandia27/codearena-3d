/**
 * Prueba del releo de posiciones (3B-3).
 * Verifica: 1) la posición llega al otro jugador con la identidad
 * estampada por el SERVIDOR, 2) el emisor NO recibe eco de sí mismo.
 * Uso: node test-posiciones.mjs  (con el backend corriendo en :3001)
 */
import { io } from 'socket.io-client';

const URL = 'http://localhost:3001';

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

async function main() {
  // 1) Sala con dos jugadores
  const a = io(URL);
  a.emit('sala:crear', { nickname: 'emisor', tema: 'WebSockets' });
  const creado = await esperar(a, 'sala:unido');

  const b = io(URL);
  b.emit('sala:unirse', { codigo: creado.sala.codigo, nickname: 'receptor' });
  await esperar(b, 'sala:unido');
  console.log(`Sala ${creado.sala.codigo} lista con 2 jugadores`);

  // 2) A envía posición → B la recibe con el jugadorId estampado por el servidor
  const promesaPos = esperar(b, 'drone:posicion');
  a.emit('drone:posicion', { x: 5, y: 3, z: -2 }); // solo x,y,z: sin identidad
  const pos = await promesaPos;
  if (pos.jugadorId !== creado.jugador.id || pos.x !== 5 || pos.y !== 3 || pos.z !== -2) {
    throw new Error(`Posición incorrecta: ${JSON.stringify(pos)}`);
  }
  console.log('✅ Posición retransmitida con la identidad correcta (estampada por el servidor)');

  // 3) El emisor NO debe recibir su propia posición (socket.to excluye al remitente)
  let eco = false;
  const onEco = () => { eco = true; };
  a.once('drone:posicion', onEco);
  a.emit('drone:posicion', { x: 1, y: 1, z: 1 });
  await new Promise((r) => setTimeout(r, 400));
  a.off('drone:posicion', onEco);
  if (eco) throw new Error('El emisor recibió su propia posición (no debería)');
  console.log('✅ El emisor no recibe eco de su propia posición');

  a.disconnect();
  b.disconnect();
  console.log('\n🎉 Relevo de posiciones verificado');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
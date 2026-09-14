import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, NotFoundException } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { SalasService } from './salas.service';
import { TEMAS_VALIDOS } from './salas.dto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validación manual (los DTOs con ValidationPipe no aplican igual en WS). */
function asegurarNickname(nickname: unknown): string {
  if (typeof nickname !== 'string' || nickname.length < 2 || nickname.length > 16) {
    throw new Error('El nickname debe tener entre 2 y 16 caracteres');
  }
  return nickname;
}

function asegurarTema(tema: unknown): string {
  if (typeof tema !== 'string' || !TEMAS_VALIDOS.includes(tema)) {
    throw new Error('Tema no válido');
  }
  return tema;
}

function asegurarCodigo(codigo: unknown): string {
  if (typeof codigo !== 'string' || codigo.length !== 4) {
    throw new Error('Código de sala inválido');
  }
  return codigo;
}

function asegurarUuid(valor: unknown, campo: string): string {
  if (typeof valor !== 'string' || !UUID_RE.test(valor)) {
    throw new Error(`${campo} inválido`);
  }
  return valor;
}

/**
 * Gateway de Socket.IO: el canal en tiempo real del juego.
 * CORS abierto para desarrollo (Angular corre en :4200, la API en :3001).
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class SalasGateway implements OnGatewayDisconnect {
  private readonly logger = new Logger(SalasGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly salasService: SalasService) {}

  // socket.id -> sesión del jugador en esa conexión.
  // Nos permite saber a qué sala avisar cuando el socket se cae,
  // y saber QUIÉN es cada socket sin fiarnos de lo que el cliente diga.
  private sesiones = new Map<string, { codigo: string; jugadorId: string }>();

  /** R9: si un jugador se desconecta, la partida sigue para los demás. */
  async handleDisconnect(socket: Socket): Promise<void> {
    const sesion = this.sesiones.get(socket.id);
    if (!sesion) return;
    this.sesiones.delete(socket.id);

    this.logger.log(`Desconexión en sala ${sesion.codigo}`);
    await this.salasService.marcarConexion(sesion.jugadorId, false);
    await this.emitirEstado(sesion.codigo);
  }

  /** Crea sala por WebSocket y conecta al emisor. */
  @SubscribeMessage('sala:crear')
  async crear(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { nickname: unknown; tema: unknown },
  ): Promise<void> {
    try {
      const dto = { nickname: asegurarNickname(body.nickname), tema: asegurarTema(body.tema) };
      const data = await this.salasService.crear(dto);

      this.sesiones.set(socket.id, { codigo: data.sala.codigo, jugadorId: data.jugador.id });
      socket.join(data.sala.codigo);
      this.logger.log(`Sala ${data.sala.codigo} creada (${data.sala.tema})`);

      socket.emit('sala:unido', { sala: data.sala, jugador: data.jugador });
      await this.emitirEstado(data.sala.codigo);
    } catch (error) {
      this.emitirError(socket, error);
    }
  }

  /** Une un jugador nuevo (pasa por la MISMA lógica transaccional R2/R3 del service). */
  @SubscribeMessage('sala:unirse')
  async unirse(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { codigo: unknown; nickname: unknown },
  ): Promise<void> {
    try {
      const codigo = asegurarCodigo(body.codigo);
      const nickname = asegurarNickname(body.nickname);
      const data = await this.salasService.unirse(codigo, nickname);

      this.sesiones.set(socket.id, { codigo: data.sala.codigo, jugadorId: data.jugador.id });
      socket.join(data.sala.codigo);
      this.logger.log(`${nickname} se unió a ${data.sala.codigo}`);

      socket.emit('sala:unido', { sala: data.sala, jugador: data.jugador });
      await this.emitirEstado(data.sala.codigo);
    } catch (error) {
      this.emitirError(socket, error);
    }
  }

  /** Reconexión: un jugador que ya existe en la sala retoma su lugar. */
  @SubscribeMessage('sala:conectar')
  async conectar(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { codigo: unknown; jugadorId: unknown },
  ): Promise<void> {
    try {
      const codigo = asegurarCodigo(body.codigo);
      const jugadorId = asegurarUuid(body.jugadorId, 'jugadorId');

      const data = await this.salasService.obtenerPorCodigo(codigo);
      const jugador = data.jugadores.find((j) => j.id === jugadorId);
      if (!jugador) {
        throw new NotFoundException('Ese jugador no pertenece a la sala');
      }

      this.sesiones.set(socket.id, { codigo, jugadorId });
      socket.join(codigo);
      await this.salasService.marcarConexion(jugadorId, true);
      await this.emitirEstado(codigo);
    } catch (error) {
      this.emitirError(socket, error);
    }
  }

  /** Marca "Listo". Si todos los conectados están listos → PLAYING + countdown. */
  @SubscribeMessage('jugador:listo')
  async listo(
    @MessageBody() body: { codigo: unknown; jugadorId: unknown },
  ): Promise<void> {
    try {
      const codigo = asegurarCodigo(body.codigo);
      const jugadorId = asegurarUuid(body.jugadorId, 'jugadorId');

      await this.salasService.marcarListo(jugadorId);
      const data = await this.salasService.obtenerPorCodigo(codigo);
      await this.emitirEstado(codigo);

      const conectados = data.jugadores.filter((j) => j.conectado);
      const todosListos = conectados.length > 0 && conectados.every((j) => j.listo);

      if (todosListos && data.sala.estado === 'WAITING') {
        await this.salasService.iniciarPartida(data.sala.id);
        await this.emitirEstado(codigo); // todos ven PLAYING antes del countdown
        await this.cuentaRegresiva(codigo);
      }
    } catch (error) {
      this.logger.error(`Error en jugador:listo: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Relé de posiciones (R8 — la parte de posición). El cliente solo dice
   * {x,y,z}: el servidor ya sabe QUIÉN es (sesión) y en qué sala está,
   * así que es estructuralmente imposible suplantar a otro jugador.
   * Las posiciones son estado EFÍMERO: se retransmiten, jamás se guardan en BD.
   */
  @SubscribeMessage('drone:posicion')
  posicion(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { x: unknown; y: unknown; z: unknown },
  ): void {
    const sesion = this.sesiones.get(socket.id);
    if (!sesion) return; // socket sin sesión registrada: ignorar

    const x = Number(body.x);
    const y = Number(body.y);
    const z = Number(body.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

    // socket.to(...) = a todos en la sala MENOS al emisor
    // (él ya conoce su propia posición; no hace falta eco)
    socket.to(sesion.codigo).emit('drone:posicion', {
      jugadorId: sesion.jugadorId,
      x, y, z,
    });
  }

  /** Difunde el estado completo a TODA la sala (R8). */
  private async emitirEstado(codigo: string): Promise<void> {
    const data = await this.salasService.obtenerPorCodigo(codigo);
    this.server.to(codigo).emit('sala:estado', data);
  }

  /** 5...1 y arranca. La sala ya está en PLAYING: nadie más puede unirse. */
  private async cuentaRegresiva(codigo: string): Promise<void> {
    for (let segundos = 5; segundos >= 1; segundos--) {
      this.server.to(codigo).emit('cuenta:regresiva', { segundos });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    this.server.to(codigo).emit('partida:iniciada', {});
    this.logger.log(`Partida iniciada en sala ${codigo}`);
  }

  /** El error va SOLO al cliente que lo provocó, nunca a toda la sala. */
  private emitirError(socket: Socket, error: unknown): void {
    const mensaje = error instanceof Error ? error.message : 'Error inesperado';
    socket.emit('sala:error', { mensaje });
  }
}
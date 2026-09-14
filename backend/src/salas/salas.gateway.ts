import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, NotFoundException } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { SalasService } from './salas.service';
import { TEMAS_VALIDOS } from './salas.dto';
import {
  HABILIDADES_VALIDAS,
  Habilidad,
  PartidasService,
} from '../partidas/partidas.service';

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

function asegurarHabilidad(habilidad: unknown): Habilidad {
  if (typeof habilidad !== 'string' || !HABILIDADES_VALIDAS.includes(habilidad as Habilidad)) {
    throw new Error('Habilidad desconocida');
  }
  return habilidad as Habilidad;
}

/**
 * Gateway de Socket.IO: el canal en tiempo real del juego.
 * CORS abierto para desarrollo (Angular corre en :4200, la API en :3001).
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class SalasGateway implements OnGatewayInit, OnGatewayDisconnect {
  private readonly logger = new Logger(SalasGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly salasService: SalasService,
    private readonly partidas: PartidasService,
  ) {}

  /** El motor de combate necesita el server para difundir a las salas. */
  afterInit(server: Server): void {
    this.partidas.adjuntarServidor(server);
  }

  // socket.id -> sesión del jugador en esa conexión.
  private sesiones = new Map<string, { codigo: string; jugadorId: string }>();

  /** R9: si un jugador se desconecta, la partida sigue para los demás. */
  async handleDisconnect(socket: Socket): Promise<void> {
    const sesion = this.sesiones.get(socket.id);
    if (!sesion) return;
    this.sesiones.delete(socket.id);

    this.logger.log(`Desconexión en sala ${sesion.codigo}`);
    await this.salasService.marcarConexion(sesion.jugadorId, false);
    this.partidas.desconectarJugador(sesion.codigo, sesion.jugadorId);
    await this.emitirEstado(sesion.codigo);
    if (this.partidas.hayPartida(sesion.codigo)) {
      this.partidas['emitirEstado'](sesion.codigo);
    }
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

  /** Une un jugador nuevo (misma lógica transaccional R2/R3 del service). */
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
      // Si hay partida en curso, el reconectado recibe HP/efectos al día
      if (this.partidas.hayPartida(codigo)) {
        this.partidas['emitirEstado'](codigo);
      }
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
        await this.cuentaRegresiva(codigo, data.sala.id, data.sala.tema, conectados.map((j) => j.id));
      }
    } catch (error) {
      this.logger.error(`Error en jugador:listo: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** R6 paso 1: pedir habilidad => recibir pregunta (sin la respuesta). */
  @SubscribeMessage('habilidad:solicitar')
  async solicitarHabilidad(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { habilidad: unknown; objetivoId?: unknown },
  ): Promise<void> {
    const sesion = this.sesiones.get(socket.id);
    if (!sesion) {
      socket.emit('habilidad:error', { mensaje: 'No estás en una sala' });
      return;
    }
    try {
      const habilidad = asegurarHabilidad(body.habilidad);
      const objetivoId =
        typeof body.objetivoId === 'string' ? body.objetivoId : null;

      const payload = await this.partidas.solicitarHabilidad(
        sesion.codigo,
        sesion.jugadorId,
        habilidad,
        objetivoId,
      );
      socket.emit('pregunta:nueva', payload);
    } catch (error) {
      // Incluye IaError de R5: mensaje entendible para el jugador
      const mensaje = error instanceof Error ? error.message : 'Error inesperado';
      socket.emit('habilidad:error', { mensaje });
    }
  }

  /** R6 paso 2: responder => el servidor valida y aplica (o rechaza). */
  @SubscribeMessage('pregunta:responder')
  async responder(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { preguntaId: unknown; indice: unknown },
  ): Promise<void> {
    const sesion = this.sesiones.get(socket.id);
    if (!sesion) {
      socket.emit('habilidad:error', { mensaje: 'No estás en una sala' });
      return;
    }
    try {
      const preguntaId = asegurarUuid(body.preguntaId, 'preguntaId');
      const resultado = await this.partidas.responder(
        sesion.codigo,
        sesion.jugadorId,
        preguntaId,
        body.indice,
      );
      if (!resultado.correcta) {
        socket.emit('habilidad:fallida', {
          jugadorId: sesion.jugadorId,
          habilidad: resultado.habilidad,
          motivo: resultado.motivo,
        });
      }
      // Si fue correcta, el service ya difundió habilidad:aplicada + estados
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : 'Error inesperado';
      socket.emit('habilidad:error', { mensaje });
    }
  }

  /** Relé de posiciones (R8). El cliente solo dice {x,y,z}: identidad estampada aquí. */
  @SubscribeMessage('drone:posicion')
  posicion(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { x: unknown; y: unknown; z: unknown },
  ): void {
    const sesion = this.sesiones.get(socket.id);
    if (!sesion) return;

    const x = Number(body.x);
    const y = Number(body.y);
    const z = Number(body.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

    socket.to(sesion.codigo).emit('drone:posicion', {
      jugadorId: sesion.jugadorId,
      x, y, z,
    });
  }

  /** Difunde el estado completo de la sala a TODA la sala (R8). */
  private async emitirEstado(codigo: string): Promise<void> {
    const data = await this.salasService.obtenerPorCodigo(codigo);
    this.server.to(codigo).emit('sala:estado', data);
  }

  /** 5...1, arranca la arena y con ella el motor de combate. */
  private async cuentaRegresiva(
    codigo: string,
    salaId: string,
    tema: string,
    jugadoresIds: string[],
  ): Promise<void> {
    for (let segundos = 5; segundos >= 1; segundos--) {
      this.server.to(codigo).emit('cuenta:regresiva', { segundos });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    this.server.to(codigo).emit('partida:iniciada', {});
    this.logger.log(`Partida iniciada en sala ${codigo}`);
    await this.partidas.iniciar(codigo, salaId, tema, jugadoresIds);
  }

  /** El error va SOLO al cliente que lo provocó, nunca a toda la sala. */
  private emitirError(socket: Socket, error: unknown): void {
    const mensaje = error instanceof Error ? error.message : 'Error inesperado';
    socket.emit('sala:error', { mensaje });
  }
}
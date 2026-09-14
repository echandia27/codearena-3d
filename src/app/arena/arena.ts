import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import * as THREE from 'three';
import { Controls } from '../services/controls';
import { GameSessionService, EstadoJugadorPartida } from '../services/game-session.service';

/** Un drone renderizado en escena (el tuyo o el de otro jugador). */
interface DroneVisual {
  group: THREE.Group;
  tilt: THREE.Group;
  propellers: THREE.Mesh[];
  destino: THREE.Vector3;
  bodyMaterial: THREE.MeshStandardMaterial;
}

@Component({
  selector: 'app-arena',
  templateUrl: './arena.html',
  styleUrl: './arena.css',
})
export class Arena implements AfterViewInit, OnDestroy {

  @ViewChild('canvasContainer')
  private canvasContainer!: ElementRef<HTMLDivElement>;

  private controls = inject(Controls);
  session = inject(GameSessionService);

  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;

  // Tu drone
  private drone!: THREE.Group;
  private tilt!: THREE.Group;
  private propellers: THREE.Mesh[] = [];
  private miBodyMaterial?: THREE.MeshStandardMaterial;
  private escudoMesh?: THREE.Mesh;

  // Drones de los demás (R8)
  private otrosDrones = new Map<string, DroneVisual>();

  private readonly COLORES = [0xff5252, 0x448aff, 0x66bb6a, 0xab47bc];
  private readonly COLORES_CSS = ['#ff5252', '#448aff', '#66bb6a', '#ab47bc'];
  private readonly POSICIONES_INICIO: Array<[number, number, number]> = [
    [-6, 2, -6], [6, 2, -6], [-6, 2, 6], [6, 2, 6],
  ];

  private readonly SPEED = 8;
  private readonly ARENA_LIMIT = 18.5;
  private readonly MIN_Y = 0.8;
  private readonly MAX_Y = 8;
  private readonly ENVIO_POSICION_CADA = 0.1;

  private clock = new THREE.Clock();
  private elapsed = 0;
  private animationId = 0;
  private resizeObserver?: ResizeObserver;
  private enviarTimer = 0;

  dronePosition = signal({ x: 0, y: 2, z: 0 });

  // HUD reactivo de combate
  miHp = signal(100);
  miMuerto = signal(false);
  respawnSegundos = signal(0);
  segundosPregunta = signal(20);
  elegirObjetivo = signal(false);

  ngAfterViewInit(): void {
    this.setupRenderer();
    this.setupCamera();
    this.setupLights();
    this.setupArena();
    this.setupDrone();
    this.startAnimationLoop();
    this.setupResize();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animationId);
    this.resizeObserver?.disconnect();
    this.renderer.dispose();
  }

  private setupRenderer(): void {
    const container = this.canvasContainer.nativeElement;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
  }

  private setupCamera(): void {
    const container = this.canvasContainer.nativeElement;
    const aspectRatio = container.clientWidth / container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(60, aspectRatio, 0.1, 200);
    this.camera.position.set(0, 24, 26);
    this.camera.lookAt(0, 1, 0);
  }

  private setupLights(): void {
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(10, 20, 10);
    this.scene.add(sun);
  }

  private setupArena(): void {
    this.scene.background = new THREE.Color(0x0d1b2a);
    this.scene.fog = new THREE.Fog(0x0d1b2a, 40, 90);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x2e7d32 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(40, 20, 0x0d1b2a, 0x1b5e20);
    grid.position.y = 0.02;
    this.scene.add(grid);

    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x455a64 });
    const walls: Array<[number, number, number, number, number, number]> = [
      [40.5, 3, 0.5,   0, 1.5, -20],
      [40.5, 3, 0.5,   0, 1.5,  20],
      [0.5,  3, 40.5, -20, 1.5,  0],
      [0.5,  3, 40.5,  20, 1.5,  0],
    ];
    for (const [w, h, d, x, y, z] of walls) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMaterial);
      wall.position.set(x, y, z);
      this.scene.add(wall);
    }
  }

  private crearDrone(colorCuerpo: number): DroneVisual {
    const group = new THREE.Group();
    const tilt = new THREE.Group();
    const propellers: THREE.Mesh[] = [];

    const bodyMaterial = new THREE.MeshStandardMaterial({ color: colorCuerpo });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 1), bodyMaterial);
    tilt.add(body);

    const armGeometry = new THREE.BoxGeometry(1.7, 0.08, 0.12);
    const armMaterial = new THREE.MeshStandardMaterial({ color: 0x37474f });
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      const arm = new THREE.Mesh(armGeometry, armMaterial);
      arm.rotation.y = angle;
      tilt.add(arm);
    }

    const propGeometry = new THREE.BoxGeometry(0.8, 0.04, 0.1);
    const propMaterial = new THREE.MeshStandardMaterial({ color: 0xffca28 });
    const corners: Array<[number, number]> = [
      [0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55],
    ];
    for (const [x, z] of corners) {
      const propeller = new THREE.Mesh(propGeometry, propMaterial);
      propeller.position.set(x, 0.2, z);
      propellers.push(propeller);
      tilt.add(propeller);
    }

    group.add(tilt);
    return { group, tilt, propellers, destino: new THREE.Vector3(), bodyMaterial };
  }

  private setupDrone(): void {
    const slot = this.session.jugadorPropio()?.slot ?? 0;
    const visual = this.crearDrone(this.COLORES[slot] ?? 0x263238);
    this.drone = visual.group;
    this.tilt = visual.tilt;
    this.propellers = visual.propellers;
    this.miBodyMaterial = visual.bodyMaterial;

    // Anillo de escudo (visible solo cuando el servidor dice que hay escudo)
    this.escudoMesh = new THREE.Mesh(
      new THREE.TorusGeometry(1.15, 0.06, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.65 }),
    );
    this.escudoMesh.rotation.x = Math.PI / 2;
    this.escudoMesh.position.y = 0.1;
    this.escudoMesh.visible = false;
    this.drone.add(this.escudoMesh);

    const spawn = this.POSICIONES_INICIO[slot] ?? [0, 2, 0];
    this.drone.position.set(spawn[0], spawn[1], spawn[2]);
    this.scene.add(this.drone);
  }

  private startAnimationLoop(): void {
    const animate = (): void => {
      this.animationId = requestAnimationFrame(animate);
      const dt = this.clock.getDelta();
      this.elapsed += dt;

      this.actualizarHudCombate();
      this.updateDrone(dt);
      this.sincronizarOtrosDrones(dt);

      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  /** Estado de COMBATE propio, según el servidor (autoridad única). */
  private miEstado(): EstadoJugadorPartida | undefined {
    const miId = this.session.jugadorPropio()?.id;
    if (!miId) return undefined;
    return this.session.partidaEstado()?.jugadores.find((j) => j.jugadorId === miId);
  }

  /** Actualiza las signals del HUD (HP, respawn, timer de pregunta). */
  private actualizarHudCombate(): void {
    const mi = this.miEstado();
    const hp = mi?.hp ?? 100;
    if (hp !== this.miHp()) this.miHp.set(hp);

    const muerto = mi?.muerto ?? false;
    if (muerto !== this.miMuerto()) this.miMuerto.set(muerto);

    if (muerto && this.session.partidaEstado()) {
      const restanteMs = (mi?.respawnEnMs ?? 0) -
        (Date.now() - this.session.partidaEstado()!.recibidoEn);
      const seg = Math.max(0, Math.ceil(restanteMs / 1000));
      if (seg !== this.respawnSegundos()) this.respawnSegundos.set(seg);
    } else if (this.respawnSegundos() !== 0) {
      this.respawnSegundos.set(0);
    }

    const p = this.session.preguntaActual();
    if (p) {
      const seg = Math.max(0, Math.ceil((p.expiraEn - Date.now()) / 1000));
      if (seg !== this.segundosPregunta()) this.segundosPregunta.set(seg);
    } else if (this.segundosPregunta() !== 0) {
      this.segundosPregunta.set(0);
    }
  }

  private updateDrone(dt: number): void {
    const smoothing = 1 - Math.exp(-10 * dt);
    const mi = this.miEstado();

    // Muerto: drone oculto, sin movimiento ni envío (el respawn lo decidió el servidor)
    if (mi?.muerto) {
      this.drone.visible = false;
      return;
    }
    this.drone.visible = true;

    // Efectos visuales según el estado que difunde el servidor
    const boostActivo = (mi?.boostRestanteMs ?? 0) > 0;
    if (this.miBodyMaterial) {
      this.miBodyMaterial.emissive.setHex(boostActivo ? 0xffca28 : 0x000000);
      this.miBodyMaterial.emissiveIntensity = boostActivo ? 0.9 : 0;
    }
    if (this.escudoMesh) {
      this.escudoMesh.visible = (mi?.escudoRestanteMs ?? 0) > 0;
      if (this.escudoMesh.visible) this.escudoMesh.rotation.z += dt * 2;
    }

    // 1) Intención del jugador (solo con partida en curso)
    let vx = 0, vy = 0, vz = 0;
    if (this.session.partidaIniciada()) {
      if (this.controls.isPressed('KeyW')) vz -= 1;
      if (this.controls.isPressed('KeyS')) vz += 1;
      if (this.controls.isPressed('KeyA')) vx -= 1;
      if (this.controls.isPressed('KeyD')) vx += 1;
      if (this.controls.isPressed('Space')) vy += 1;
      if (this.controls.isPressed('ShiftLeft') || this.controls.isPressed('ShiftRight')) vy -= 1;
    }

    // 2) Normalizar + velocidad con multiplicador de Boost (x2)
    const velocidad = this.SPEED * (boostActivo ? 2 : 1);
    const length = Math.hypot(vx, vy, vz);
    const isMoving = length > 0;
    if (isMoving) {
      vx = (vx / length) * velocidad;
      vy = (vy / length) * velocidad;
      vz = (vz / length) * velocidad;
    }

    // 3) Mover y respetar límites
    const p = this.drone.position;
    p.x = THREE.MathUtils.clamp(p.x + vx * dt, -this.ARENA_LIMIT, this.ARENA_LIMIT);
    p.y = THREE.MathUtils.clamp(p.y + vy * dt, this.MIN_Y, this.MAX_Y);
    p.z = THREE.MathUtils.clamp(p.z + vz * dt, -this.ARENA_LIMIT, this.ARENA_LIMIT);

    // 4) Yaw hacia la dirección de movimiento
    if (vx !== 0 || vz !== 0) {
      const targetYaw = Math.atan2(vx, vz);
      this.drone.rotation.y = this.lerpAngle(this.drone.rotation.y, targetYaw, smoothing);
    }

    // 5) Pitch al avanzar
    const horizontalSpeed = Math.hypot(vx, vz);
    const targetPitch = (horizontalSpeed / this.SPEED) * 0.35;
    this.tilt.rotation.x += (targetPitch - this.tilt.rotation.x) * smoothing;

    // 6) Flotación + hélices
    this.tilt.position.y = Math.sin(this.elapsed * 3) * 0.08;
    const spin = (isMoving ? 0.9 : 0.4) * (boostActivo ? 2 : 1);
    for (const propeller of this.propellers) {
      propeller.rotation.y += spin;
    }

    // 7) HUD de posición
    this.dronePosition.set({ x: p.x, y: p.y, z: p.z });

    // 8) Enviar posición a 10 Hz (R8)
    this.enviarTimer += dt;
    if (this.session.partidaIniciada() && this.enviarTimer >= this.ENVIO_POSICION_CADA) {
      this.enviarTimer = 0;
      this.session.enviarPosicion(p.x, p.y, p.z);
    }
  }

  private sincronizarOtrosDrones(dt: number): void {
    const smoothing = 1 - Math.exp(-12 * dt);
    const activos = new Set<string>();

    for (const j of this.session.jugadores()) {
      if (j.id === this.session.jugadorPropio()?.id || !j.conectado) continue;
      activos.add(j.id);

      let visual = this.otrosDrones.get(j.id);
      if (!visual) {
        visual = this.crearDrone(this.COLORES[j.slot] ?? 0xffffff);
        const spawn = this.POSICIONES_INICIO[j.slot] ?? [0, 2, 0];
        visual.group.position.set(spawn[0], spawn[1], spawn[2]);
        visual.destino.copy(visual.group.position);
        this.otrosDrones.set(j.id, visual);
        this.scene.add(visual.group);
      }

      // Visible salvo si el servidor dice que está muerto (R8)
      const estado = this.session.partidaEstado()?.jugadores.find((e) => e.jugadorId === j.id);
      visual.group.visible = !(estado?.muerto ?? false);

      const pos = this.session.posicionesOtros.get(j.id);
      if (pos) visual.destino.set(pos.x, pos.y, pos.z);

      visual.group.position.lerp(visual.destino, smoothing);
      for (const propeller of visual.propellers) {
        propeller.rotation.y += 0.7;
      }
    }

    for (const [id, visual] of this.otrosDrones) {
      if (!activos.has(id)) {
        visual.group.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
          }
        });
        this.scene.remove(visual.group);
        this.otrosDrones.delete(id);
      }
    }
  }

  private lerpAngle(current: number, target: number, t: number): number {
    let diff = target - current;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return current + diff * t;
  }

  private setupResize(): void {
    const container = this.canvasContainer.nativeElement;
    this.resizeObserver = new ResizeObserver(() => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    });
    this.resizeObserver.observe(container);
  }

  // ---------- Acciones de combate (intenciones al servicio) ----------

  pedir(habilidad: 'boost' | 'shield' | 'attack'): void {
    if (habilidad === 'attack') {
      this.elegirObjetivo.set(true);
      return;
    }
    this.session.solicitarHabilidad(habilidad, null);
  }

  /** Objetivos válidos para Attack: conectados, vivos y que no sean yo. */
  objetivosPosibles() {
    const miId = this.session.jugadorPropio()?.id;
    return this.session.jugadores().filter((j) => {
      if (j.id === miId || !j.conectado) return false;
      const e = this.session.partidaEstado()?.jugadores.find((x) => x.jugadorId === j.id);
      return !e?.muerto;
    });
  }

  atacar(objetivoId: string): void {
    this.elegirObjetivo.set(false);
    this.session.solicitarHabilidad('attack', objetivoId);
  }

  responder(indice: number): void {
    this.session.responderPregunta(indice);
  }

  // ---------- Helpers del marcador ----------

  hpDe(jugadorId: string): number {
    return this.session.partidaEstado()?.jugadores.find((j) => j.jugadorId === jugadorId)?.hp ?? 100;
  }

  estaMuerto(jugadorId: string): boolean {
    return this.session.partidaEstado()?.jugadores.find((j) => j.jugadorId === jugadorId)?.muerto ?? false;
  }

  colorDe(slot: number): string {
    return this.COLORES_CSS[slot] ?? '#ffffff';
  }
}
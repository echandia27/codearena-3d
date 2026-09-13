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

@Component({
  selector: 'app-arena',
  templateUrl: './arena.html',
  styleUrl: './arena.css',
})
export class Arena implements AfterViewInit, OnDestroy {

  // Referencia al <div> del HTML donde pintaremos el canvas 3D
  @ViewChild('canvasContainer')
  private canvasContainer!: ElementRef<HTMLDivElement>;

  // Angular inyecta la única instancia del servicio de teclado (DI)
  private controls = inject(Controls);

  // --- Los 3 pilares de Three.js ---
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;

  // --- Jerarquía del drone ---
  // drone: posición en el mundo + giro (yaw)
  // tilt : hijo de drone; inclinación (pitch) + flotación visual
  private drone = new THREE.Group();
  private tilt = new THREE.Group();
  private propellers: THREE.Mesh[] = [];

  // --- Reglas del juego (algún día vivirán en el servidor) ---
  private readonly SPEED = 8;          // unidades por segundo
  private readonly ARENA_LIMIT = 18.5; // mitad de arena (20) menos margen
  private readonly MIN_Y = 0.8;
  private readonly MAX_Y = 8;

  // --- Loop de animación ---
  private clock = new THREE.Clock();
  private elapsed = 0;
  private animationId = 0;
  private resizeObserver?: ResizeObserver;

  // Señal reactiva para el HUD (pública: el template la lee)
  dronePosition = signal({ x: 0, y: 2, z: 0 });

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
    // Vista aérea frontal: W aleja "hacia arriba" de la pantalla (se siente natural)
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

  private setupDrone(): void {
    // Las piezas viven ahora dentro de "tilt" para que la inclinación
    // no afecte a la posición ni al giro (jerarquía de transformaciones)
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.3, 1),
      new THREE.MeshStandardMaterial({ color: 0x263238 })
    );
    this.tilt.add(body);

    const armGeometry = new THREE.BoxGeometry(1.7, 0.08, 0.12);
    const armMaterial = new THREE.MeshStandardMaterial({ color: 0x37474f });
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      const arm = new THREE.Mesh(armGeometry, armMaterial);
      arm.rotation.y = angle;
      this.tilt.add(arm);
    }

    const propGeometry = new THREE.BoxGeometry(0.8, 0.04, 0.1);
    const propMaterial = new THREE.MeshStandardMaterial({ color: 0xffca28 });
    const corners: Array<[number, number]> = [
      [0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55],
    ];
    for (const [x, z] of corners) {
      const propeller = new THREE.Mesh(propGeometry, propMaterial);
      propeller.position.set(x, 0.2, z);
      this.propellers.push(propeller);
      this.tilt.add(propeller);
    }

    this.drone.add(this.tilt);
    this.drone.position.set(0, 2, 0);
    this.scene.add(this.drone);
  }

  private startAnimationLoop(): void {
    const animate = (): void => {
      this.animationId = requestAnimationFrame(animate);

      const dt = this.clock.getDelta(); // segundos desde el frame anterior
      this.elapsed += dt;

      this.updateDrone(dt);

      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  private updateDrone(dt: number): void {
    const smoothing = 1 - Math.exp(-10 * dt); // suavizado independiente del framerate

    // 1) Intención del jugador: leer el estado del teclado
    let vx = 0, vy = 0, vz = 0;
    if (this.controls.isPressed('KeyW')) vz -= 1;
    if (this.controls.isPressed('KeyS')) vz += 1;
    if (this.controls.isPressed('KeyA')) vx -= 1;
    if (this.controls.isPressed('KeyD')) vx += 1;
    if (this.controls.isPressed('Space')) vy += 1;
    if (this.controls.isPressed('ShiftLeft') || this.controls.isPressed('ShiftRight')) vy -= 1;

    // 2) Normalizar: en diagonal no debe ir más rápido que en línea recta
    const length = Math.hypot(vx, vy, vz);
    const isMoving = length > 0;
    if (isMoving) {
      vx = (vx / length) * this.SPEED;
      vy = (vy / length) * this.SPEED;
      vz = (vz / length) * this.SPEED;
    }

    // 3) Mover (velocidad × dt) y respetar los límites de la arena
    const p = this.drone.position;
    p.x = THREE.MathUtils.clamp(p.x + vx * dt, -this.ARENA_LIMIT, this.ARENA_LIMIT);
    p.y = THREE.MathUtils.clamp(p.y + vy * dt, this.MIN_Y, this.MAX_Y);
    p.z = THREE.MathUtils.clamp(p.z + vz * dt, -this.ARENA_LIMIT, this.ARENA_LIMIT);

    // 4) Girar hacia la dirección de movimiento (yaw, suavizado)
    if (vx !== 0 || vz !== 0) {
      const targetYaw = Math.atan2(vx, vz);
      this.drone.rotation.y = this.lerpAngle(this.drone.rotation.y, targetYaw, smoothing);
    }

    // 5) Inclinar la nariz al avanzar, como un drone real (pitch)
    const horizontalSpeed = Math.hypot(vx, vz);
    const targetPitch = (horizontalSpeed / this.SPEED) * 0.35;
    this.tilt.rotation.x += (targetPitch - this.tilt.rotation.x) * smoothing;

    // 6) Detalles vivos: flotación visual + hélices más rápidas al moverse
    this.tilt.position.y = Math.sin(this.elapsed * 3) * 0.08;
    const spin = isMoving ? 0.9 : 0.4;
    for (const propeller of this.propellers) {
      propeller.rotation.y += spin;
    }

    // 7) Publicar la posición para el HUD
    this.dronePosition.set({ x: p.x, y: p.y, z: p.z });
  }

  // Interpola entre dos ángulos siempre por el camino corto
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
}
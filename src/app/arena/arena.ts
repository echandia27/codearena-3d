import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import * as THREE from 'three';

@Component({
  selector: 'app-arena',
  templateUrl: './arena.html',
  styleUrl: './arena.css',
})
export class Arena implements AfterViewInit, OnDestroy {

  // Referencia al <div> del HTML donde pintaremos el canvas 3D
  @ViewChild('canvasContainer')
  private canvasContainer!: ElementRef<HTMLDivElement>;

  // --- Los 3 pilares de Three.js ---
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;

  // --- Objetos del juego ---
  private drone = new THREE.Group();
  private propellers: THREE.Mesh[] = [];

  // --- Loop de animación ---
  private clock = new THREE.Clock();
  private animationId = 0;
  private resizeObserver?: ResizeObserver;

  // Angular llama esto cuando el HTML ya existe en pantalla
  ngAfterViewInit(): void {
    this.setupRenderer();
    this.setupCamera();
    this.setupLights();
    this.setupArena();
    this.setupDrone();
    this.startAnimationLoop();
    this.setupResize();
  }

  // Angular llama esto cuando el componente se destruye: limpiamos
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
    // PerspectiveCamera(fov, aspecto, cerca, lejos)
    this.camera = new THREE.PerspectiveCamera(60, aspectRatio, 0.1, 200);
    this.camera.position.set(0, 15, 25);
    this.camera.lookAt(0, 1, 0);
  }

  private setupLights(): void {
    // Luz ambiental: ilumina todo por igual (suave)
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    // Luz direccional: como un sol, viene de una dirección
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(10, 20, 10);
    this.scene.add(sun);
  }

  private setupArena(): void {
    // Cielo y niebla (la niebla da profundidad)
    this.scene.background = new THREE.Color(0x0d1b2a);
    this.scene.fog = new THREE.Fog(0x0d1b2a, 40, 90);

    // Piso
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x1565c0 })
    );
    floor.rotation.x = -Math.PI / 2; // el plano se crea acostado "de pie"; lo giramos
    this.scene.add(floor);

    // Cuadrícula: ayuda a percibir movimiento y profundidad
    const grid = new THREE.GridHelper(40, 20, 0x0d1b2a, 0x1b5e20);
    grid.position.y = 0.02; // levemente arriba del piso para que no se pelee con él
    this.scene.add(grid);

    // Paredes: [ancho, alto, profundidad, x, y, z]
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x455a64 });
    const walls: Array<[number, number, number, number, number, number]> = [
      [40.5, 3, 0.5,   0, 1.5, -20], // norte
      [40.5, 3, 0.5,   0, 1.5,  20], // sur
      [0.5,  3, 40.5, -20, 1.5,  0], // oeste
      [0.5,  3, 40.5,  20, 1.5,  0], // este
    ];
    for (const [w, h, d, x, y, z] of walls) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMaterial);
      wall.position.set(x, y, z);
      this.scene.add(wall);
    }
  }

  private setupDrone(): void {
    // Cuerpo
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.3, 1),
      new THREE.MeshStandardMaterial({ color: 0x263238 })
    );
    this.drone.add(body);

    // Brazos: dos barras cruzadas en diagonal (reutilizamos la misma geometría)
    const armGeometry = new THREE.BoxGeometry(1.7, 0.08, 0.12);
    const armMaterial = new THREE.MeshStandardMaterial({ color: 0x37474f });
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      const arm = new THREE.Mesh(armGeometry, armMaterial);
      arm.rotation.y = angle;
      this.drone.add(arm);
    }

    // Hélices: láminas finas que girarán en el loop de animación
    const propGeometry = new THREE.BoxGeometry(0.8, 0.04, 0.1);
    const propMaterial = new THREE.MeshStandardMaterial({ color: 0xffca28 });
    const corners: Array<[number, number]> = [
      [0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55],
    ];
    for (const [x, z] of corners) {
      const propeller = new THREE.Mesh(propGeometry, propMaterial);
      propeller.position.set(x, 0.2, z);
      this.propellers.push(propeller); // guardamos referencia para girarlas después
      this.drone.add(propeller);
    }

    this.drone.position.set(0, 2, 0); // vuela a altura 2, en el centro
    this.scene.add(this.drone);
  }

  private startAnimationLoop(): void {
    const animate = (): void => {
      // Agenda el próximo frame (así se crea el ciclo de ~60fps)
      this.animationId = requestAnimationFrame(animate);
      const t = this.clock.getElapsedTime(); // segundos desde que empezó

      // Flotación suave: seno del tiempo = sube y baja
      this.drone.position.y = 2 + Math.sin(t * 5) * 0.4;
      // Giro lento sobre sí mismo
      this.drone.rotation.y += 0.003;
      // Hélices girando rápido
      for (const propeller of this.propellers) {
        propeller.rotation.y += 0.4;
      }

      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  private setupResize(): void {
    // Si el usuario cambia el tamaño de la ventana, ajustamos cámara y canvas
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
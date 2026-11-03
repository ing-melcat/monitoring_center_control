[README.md](https://github.com/user-attachments/files/34303917/README.md)
# Centro de Control de Operaciones RUR (Estación Terrena)
### Sistema de Teleoperación, Recepción de Telemetría y Percepción Robótica en Tiempo Real
**División:** Research Unit of Robotics (RUR)  
**Institución:** Universidad Politécnica de Durango (UNIPOLI)  
**Entorno Operativo:** Producción / Operación de Campo en Misión Crítica  
**Clasificación:** Especificación Técnica de Arquitectura e Infraestructura  

---

## 1. Resumen Ejecutivo y Misión del Sistema

El Centro de Control de Operaciones RUR es una estación terrena de nivel industrial diseñada para la supervisión, teleoperación y adquisición de datos en tiempo real de unidades robóticas terrestres de exploración (plataformas de excavación lunar y marciana como RASSOR 1, RASSOR 8681 y rovers autónomos).

El sistema responde a una necesidad crítica en misiones de robótica avanzada: centralizar en un único punto de comando el control cinemático de actuadores, la telemetría de sensores, la percepción tridimensional (LiDAR / SLAM) y el acceso a terminales de depuración, manteniendo una latencia inferior a 100 milisegundos sobre enlaces de radiofrecuencia o redes de área amplia (WAN) inestables.

Su desarrollo sustituye arquitecturas monolíticas y dependientes de terceros por una infraestructura distribuida basada en microservicios, enlaces criptográficos peer-to-peer y un modelo estricto de seguridad de memoria volátil.

---

## 2. Arquitectura de Infraestructura y Topología de Red

La infraestructura opera mediante una topología de tres capas segregadas: Capa de Producción Central, Capa de Red Mesh Cifrada y Capa de Estación de Mando en Tierra.

```text
+-----------------------------------------------------------------------------+
|                          TOPOLOGIA DE INFRAESTRUCTURA                       |
|                                                                             |
|  [ SERVIDOR CENTRAL DE PRODUCCION ] (rur-xps-8700)                          |
|  IP Privada Mesh: 100.126.20.52                                             |
|  - Base de Datos Transaccional: PostgreSQL (page_rur_db)                    |
|  - Boveda de Claves Cifradas: AES-256-GCM (ROBOTS_SECRET_KEY)               |
|  - Servicio de Generacion de Tokens Efimeros: JWT (TTL 4 Horas)             |
|                                     |                                       |
|                                     | Canal Cifrado WireGuard (mTLS Kernel) |
|                                     v                                       |
|  [ RED MESH PRIVADA TAILSCALE ] (Zero-Attack Surface / Sin Puertos Abiertos)|
|                                     |                                       |
|                                     v                                       |
|  [ ESTACION TERRENA / CENTRO DE CONTROL ] (Host Local: 127.0.0.1:3000)      |
|  - Servidor de Telemetria y Concurrencia: Node.js + Express                 |
|  - Emulacion de Terminal de Bajo Nivel: ConPTY / node-pty                   |
|  - Sincronizacion de Interfaz: WebSocket Local Full-Duplex                  |
|  - Renderizado Tactico: HTML5 Canvas + Hardware Acceleration                |
|                                     |                                       |
|                 +-------------------+-------------------+                   |
|                 |                                       |                   |
|                 v                                       v                   |
|  [ PROTOCOLO ROBOTICO DDS ]               [ PROTOCOLO DE VIDEO Y NUBES ]    |
|  - Middleware: ROS 2 (Jazzy / Humble)     - Plataforma: LiveKit WebRTC      |
|  - Enlace: CycloneDDS (ROS_DOMAIN_ID=42)  - Canales: Camara Color + LiDAR   |
|  - Envio de Comandos: Datagramas UDP P2P  - Codificacion: H.264 / VP8 / JET |
+-----------------------------------------------------------------------------+
```

### Por qué esta Topología

1. **Eliminacion de Superficie de Ataque Publica**:
   A diferencia de los paneles tradicionales que requieren exponer puertos HTTP/TCP a Internet mediante redirecciones NAT, el Centro de Control se enlaza exclusivamente mediante túneles WireGuard autenticados por mTLS a nivel de kernel. El servidor central no posee puertos expuestos hacia la Internet pública, bloqueando ataques de denegación de servicio (DDoS), escaneos de puertos y explotación de vulnerabilidades perimetrales.

2. **Acceso Determinista Punto a Punto (P2P)**:
   Al estar integrado en la misma malla privada, el tráfico entre el operador y los robots toma la ruta de red más corta posible. Si ambos nodos se encuentran dentro de la misma antena o red local en el campo de pruebas, el tráfico fluye directamente por la red física sin viajar a la nube, garantizando teleoperación en tiempo real sin desfase.

3. **Cero Dependencia de Servicios Centralizados Externos**:
   Se eliminó por completo cualquier mecanismo de sincronización basado en repositorios externos (como APIs de GitHub), previniendo vulnerabilidades de fuga de secretos en historiales de control de versiones y bloqueos operacionales causados por caídas de servicios de terceros o límites de peticiones (rate limiting).

---

## 3. Matriz de Componentes y Justificacion Tecnologica

Cada componente de la infraestructura fue seleccionado para cumplir con requerimientos rigurosos de baja latencia, robustez ante caídas y optimización de recursos.

| Componente | Rol en el Sistema | Justificación Técnica de Selección |
| :--- | :--- | :--- |
| **CycloneDDS (ROS 2)** | Middleware de comunicación entre procesos robóticos. | Proporciona transporte de datos determinista sin intermediarios centralizados (brokerless). Su estándar OMG DDS garantiza calidad de servicio (QoS) estricta, tolerancia a pérdidas de paquetes y auto-descubrimiento en `ROS_DOMAIN_ID=42`. |
| **LiveKit (WebRTC SFU)** | Transporte de video de alta definición y nubes de profundidad LiDAR. | Protocolo de comunicación en tiempo real con latencias inferiores a 80 ms. Su arquitectura Selective Forwarding Unit (SFU) adapta dinámicamente la tasa de bits ante fluctuaciones del ancho de banda en pruebas de campo. |
| **ConPTY & node-pty** | Emulación nativa de terminales del sistema operativo en el navegador. | Conecta directamente con la API de pseudoterminales de Windows (ConPTY) y Linux (pty), permitiendo inyectar comandos bash, scripts de calibración y nodos ROS 2 con soporte íntegro de señales del sistema (SIGINT, SIGTERM) y secuencias ANSI. |
| **WebSocket Engine (ws)** | Transporte de telemetría bidireccional local (Host -> UI). | Comunicación full-duplex de mínima sobrecarga para transmitir estados de actuadores, frecuencias de CPU, temperaturas y voltajes a 60 cuadros por segundo sin la penalización de cabeceras de HTTP. |
| **HTML5 Canvas HUD** | Lienzo táctico de renderizado de interfaz. | Renderizado acelerado por hardware (GPU). Permite arrastrar, redimensionar y superponer ventanas de video, mapas 3D y telemetría sobre una sola vista continua sin la degradación de memoria típica de múltiples capas DOM anidadas. |
| **Compilador C# Nativo (csc.exe)** | Envoltura ejecutable y empaquetador del instalador. | Permite distribuir un binario PE real (`.exe`) de menos de 20 KB sin necesidad de entornos pesados como Electron (que sobrecargan 200 MB de RAM), abriendo la interfaz en modo aplicación nativa de Edge o Chrome. |

---

## 4. Arquitectura de Seguridad y Protecciones de Acceso

La seguridad de la estación terrena está estructurada bajo el principio de Defensa en Profundidad (Defense in Depth) con cuatro barreras activas.

### 4.1 Modelo de Credenciales "Zero-Exposure" en Memoria RAM
El fallo más común en estaciones robóticas es el almacenamiento de claves API y secretos en archivos locales (`.env`, archivos JSON o scripts). Si la computadora de campo se extravía o es sustraída en una competencia, las credenciales del sistema quedarían comprometidas.

El Centro de Control implementa una política estricta de Cero Persistencia:
1. **Cifrado en Reposo**: En la base de datos central, las llaves maestras de LiveKit y de los robots residen cifradas con el algoritmo simétrico autenticado **AES-256-GCM**.
2. **Tokens Efímeros de Corta Duración**: La estación solicita tokens temporales al servidor central (`POST /api/control-center/robots/:id/tokens`). El servidor emite dos tokens JWT firmados con validez máxima de 4 horas:
   - Identidad `receiver`: Restringida a la ingesta de telemetría y suscripción de datos.
   - Identidad `camera`: Restringida a la publicación y recepción de video/LiDAR.
3. **Aislamiento en Memoria Volátil**: Los tokens JWT viajan cifrados y **se almacenan exclusivamente en la memoria RAM del proceso del servidor local**. Jamás se escriben en disco, ni en archivos de configuración ni en cachés persistentes.
4. **Inyección Dinámica de Entorno (Hot-Injection)**: Cuando el operador abre una terminal integrada, los tokens y variables se inyectan en tiempo de ejecución en la memoria volátil del subproceso hijo:
   ```bash
   ROS_DOMAIN_ID=42
   LIVEKIT_URL=wss://livekit.rur.unipolidgo.edu.mx
   LIVEKIT_ROOM=mision-campo-1
   LIVEKIT_TOKEN="eyJhbGciOi..."
   LIVEKIT_CAMERA_TOKEN="eyJhbGciOi..."
   RUR_ROBOT_ID="rassor-1"
   ```
   Al cerrarse la terminal, las variables desaparecen instantáneamente de la memoria del sistema operativo.

### 4.2 Autenticación Multifactorial Obligatoria (2FA TOTP Passwordless)
Para prevenir el acceso no autorizado a la consola de mandos físicos de los robots:
- El operador se autentica mediante su matrícula institucional y una contraseña de un solo uso basada en tiempo (**TOTP de 6 dígitos** compatible con Google Authenticator / Microsoft Authenticator).
- La sesión local se gestiona mediante tokens criptográficos con tiempo de expiración riguroso y renovación automatizada.
- Se implementa protección de fuerza bruta con retardo exponencial ante intentos erróneos consecutivos.

### 4.3 Sanitización y Aislamiento de Pseudoterminales
- Los comandos introducidos por los operadores a través del subsistema de depuración se ejecutan en subprocesos aislados con privilegios de usuario estándar, impidiendo la elevación no autorizada de privilegios en el sistema anfitrión de la estación terrena.

---

## 5. Protocolos de Tolerancia a Fallos y Conmutación de Flota

En entornos de pruebas físicas, cambiar de un robot a otro sin reiniciar la computadora suele causar condiciones de carrera, colisiones de tópicos DDS en la red y fugas de memoria por procesos huérfanos.

### 5.1 Protocolo de Teardown Limpio Anti-Colisión (Robot Switcher)
Cuando el operador conmuta la unidad activa (por ejemplo, de `rassor-1` a `rassor-8681`), el sistema ejecuta de forma automática una secuencia atómica de apagado y reconfiguración:

```text
                     SELECCION DE NUEVA UNIDAD EN EL HUD
                                      |
                                      v
       +--------------------------------------------------------------+
       |             SECUENCIA ATOMICA DE TEARDOWN Y MONTAJE          |
       |                                                              |
       |  1. PURGA DE INTERFAZ GRAFICA                                |
       |     Cierre inmediato de ventanas de telemetria activas       |
       |     y desconexion de suscripciones WebRTC de la camara.      |
       |                                                              |
       |  2. TERMINACION DE SUBPROCESOS (SIGKILL / ptyProcess.kill())  |
       |     El metodo terminateAllPtyProcesses('robot_changed')      |
       |     destruye procesos ConPTY, wrappers WSL2 y scripts bash   |
       |     vinculados a la unidad saliente.                         |
       |                                                              |
       |  3. LIBERACION DE RECURSOS DE RED                            |
       |     Purga de descriptores de sockets CycloneDDS, puertos     |
       |     de telemetria y desasignacion de canales de hardware.    |
       |                                                              |
       |  4. BROADCAST WEBSOCKET ('all_killed')                       |
       |     Notifica a la interfaz de usuario para restablecer los   |
       |     indicadores de estado a modo neutro y limpiar consolas.  |
       |                                                              |
       |  5. EMISION Y ENLACE DE NUEVAS CREDENCIALES                  |
       |     Solicita tokens JWT frescos en RAM para la nueva unidad  |
       |     y reconfigura ROS_DOMAIN_ID de forma transparente.       |
       +--------------------------------------------------------------+
```

### 5.2 Sondeo Reactivo Eficiente (Sincronización Web con ETags)
- La estación terrena consulta periódicamente los cambios en la flota mediante peticiones `GET /api/control-center/robots` utilizando la cabecera `If-None-Match`.
- Si la configuración del robot no ha sido modificada por los ingenieros en el portal web, el servidor responde con **HTTP 304 Not Modified** (cuerpo de respuesta vacío). Esto conserva el ancho de banda del canal de radio y reduce el procesamiento de CPU a casi cero.
- Si un parámetro crítico cambia (ej. frecuencia de radio o dominio ROS), el disparador PostgreSQL incrementa la versión de configuración (`config_version`), alertando al operador en pantalla para aplicar los cambios sin necesidad de reiniciar la aplicación.

### 5.3 Modo de Contingencia y Operación de Campo Desconectada (Offline Fallback)
En caso de interrupción total de la conexión WAN con el servidor central de la universidad durante una prueba de campo:
- La estación conmuta de forma transparente a su almacén de contingencia local cifrado (`.rur-cache.json`).
- Si los tokens en RAM están vigentes, la teleoperación de los robots continúa sin degradación.
- Para laboratorios de pruebas cerrados sin Internet, el sistema permite arrancar con variables locales de contingencia preconfiguradas en `centro-de-control/scripts/.env`.

---

## 6. Módulos Operativos y Canales de Telemetría

La estación terrena procesa de forma simultánea tres flujos primarios de telemetría:

### 6.1 Control Cinemático y Telemetría de Actuadores
El daemon receptor multicanal (`centro-de-control/scripts/robot_receiver_prod.py`) decodifica en tiempo real datagramas binarios optimizados:
1. **Joystick Cinemático (Estructura Binaria `<Iff` de 12 bytes):**
   - Timestamp de alta resolución (milisegundos).
   - Velocidad lineal normalizada (`linear_x`, -1.0 a 1.0).
   - Velocidad angular normalizada (`angular_z`, -1.0 a 1.0).
2. **Subflujo de Brazos Excavadores:** Comandos discretos de articulación para los brazos delantero y trasero (`up`, `down`, `stopped`).
3. **Subflujo de Tambores de Carga:** Control de velocidad y sentido de rotación de los tambores de regolito (`cw`, `ccw`, `stopped`).
4. **Subflujo de Tracción Independiente:** Control diferencial de orugas y ruedas (`forward`, `backward`, `left`, `right`, `stopped`).

### 6.2 Percepción 3D y Nubes de Puntos (LiDAR Intel RealSense L515)
- **Transmisión de Flujo de Profundidad:** Puente optimizado (`centro-de-control/scripts/l515_livekit_bridge.py`) que transforma imágenes brutas `/camera/color/image_raw` y matrices de profundidad de 16 bits (`16UC1`) codificadas en falso color térmico (`COLORMAP_JET`) hacia el servidor WebRTC.
- **SLAM 3D Denso (RTAB-Map):** Mapeo tridimensional simultáneo sincronizado con odometría para navegación visual.
- **Voxelización Volumétrica (OctoMap):** Generación en tiempo real de mallas de ocupación 3D con resolución de 5 cm para la detección y evasión autónoma de obstáculos.

---

## 7. Despliegue, Empaquetado y Distribución Multiplataforma

Para facilitar la adopción en cualquier estación de trabajo de laboratorio o computadora portátil de campo, se eliminaron los requerimientos de configuración manual. El sistema se distribuye en paquetes autónomos de un solo archivo dentro del directorio de distribución `ENTREGA/`:

### 7.1 Distribución para Windows (Windows 10 / 11 de 64 bits)
- **Archivo Único de Instalación:** `ENTREGA/Instalador-Centro-de-Control.exe` (2.89 MB).
- **Mecanismo:** Asistente de instalación nativo compilado con el subsistema gráfico de Windows (`winexe`).
- **Comportamiento Autónomo:**
  1. Extrae los módulos de la aplicación en `%LocalAppData%\Programs\Centro de Control RUR`.
  2. Verifica la presencia de Node.js en el sistema; si no está disponible, ejecuta su instalación automática desatendida mediante Windows Package Manager (`winget`).
  3. Genera accesos directos con el icono institucional oficial en el Escritorio y en el Menú Inicio.
  4. Registra la aplicación en el Panel de Control para permitir su desinstalación formal.
  5. Despliega la cabina en modo aplicación nativa sin bordes ni barra de direcciones (1440x900 px).

### 7.2 Distribución para Linux (Ubuntu 20.04 / 22.04 / 24.04 / Debian / Arch con ROS 2)
- **Archivo Único de Instalación:** `ENTREGA/Instalador-Centro-de-Control.run` (3.81 MB).
- **Mecanismo:** Instalador ejecutable autónomo con carga útil binaria comprimida y desempaquetado automático.
- **Comportamiento Autónomo:**
  1. Instala el sistema en el estándar XDG `~/.local/share/centro-de-control/`.
  2. Verifica e instala dependencias de Node.js mediante el gestor de paquetes de la distribución (`apt`, `dnf` o `pacman`).
  3. Carga de forma transparente el entorno de ROS 2 instalado (`/opt/ros/jazzy/setup.bash` o `/opt/ros/humble/setup.bash`).
  4. Configura el aislamiento de dominio `ROS_DOMAIN_ID=42` con CycloneDDS.
  5. Genera el lanzador `centro-de-control.desktop` en el menú de aplicaciones del entorno gráfico y en el Escritorio.

### 7.3 Ejecución Rápida en Entorno de Desarrollo
Para operadores que ejecutan directamente desde el código fuente del proyecto:
```bash
# 1. Ingresar al directorio del Centro de Control
cd centro-de-control

# 2. Instalar dependencias de produccion
npm install --omit=dev

# 3. Iniciar el servicio del Centro de Control
npm start
```
La estación iniciará automáticamente en `http://localhost:3000`.

---

## 8. Especificaciones Operativas y Requisitos de Hardware

- **Procesador:** Arquitectura x86_64 o ARM64 con 2 núcleos mínimos (4 núcleos recomendados para procesamiento LiDAR).
- **Memoria RAM:** 4 GB mínimo (8 GB recomendados al renderizar nubes de puntos 3D densas).
- **Aceleración Gráfica:** Tarjeta de video compatible con WebGL 2.0 / OpenGL 3.3+.
- **Navegadores Soportados:** Google Chrome (v110+), Microsoft Edge (v110+), Chromium (v110+), Brave.
- **Conectividad:** Interfaz Ethernet o Wi-Fi 802.11ac/ax con latencia inferior a 40 ms respecto al punto de acceso del robot.

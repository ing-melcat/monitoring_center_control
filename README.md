# 🛰️ RUR Telemetry & ROS 2 Control Panel — Centro de Control

**Organización:** [Research Unit of Robotics (RUR)](https://github.com/Research-Unit-of-Robotics)  
**Institución:** Universidad Politécnica de Durango (UNIPOLI) — `rur.unipolidgo.edu.mx`  
**Red Privada:** Tailscale Mesh VPN (`100.126.20.52` — `rur-xps-8700`)  
**Middleware:** ROS 2 (Jazzy / Humble) · CycloneDDS (`ROS_DOMAIN_ID`) · LiveKit WebRTC  

---

## 📋 Descripción del Sistema

Este repositorio contiene la aplicación de escritorio y estación terrena del **Centro de Control RUR**. Proporciona una interfaz táctil/operador multiventana en tiempo real (ConPTY + xterm.js) montada sobre un lienzo interactivo (`Canvas`) para la teleoperación de robots de exploración (como los rovers **RASSOR 1** y **RASSOR 8681**), recepción de sensores y visualización de nubes de puntos 3D mediante cámaras Intel RealSense LiDAR L515.

El sistema se enlaza directamente con la plataforma web de producción mediante una arquitectura de sincronización segura, sin intermediarios de terceros y con un modelo estricto de **Zero-Exposure** en memoria RAM.

---

## 🌐 Arquitectura de Red y Enlace Directo (Tailscale VPN)

La estación terrena se conecta de forma punto a punto con el servidor de producción **`rur-xps-8700`** a través de la red mesh privada VPN de **Tailscale**:

```
 ┌───────────────────────────────────────────────────────────────┐
 │               RED MESH PRIVADA TAILSCALE VPN                  │
 │                                                               │
 │   ESTACIÓN TERRENA (Centro de Control)                        │
 │   IP Tailscale: Dinámica                                      │
 │   App Local: http://localhost:3000                            │
 │         │                                                     │
 │         │  Canal VPN Cifrado WireGuard                        │
 │         │  API: http://100.126.20.52:3000 / :3001            │
 │         ▼                                                     │
 │   SERVIDOR DE PRODUCCIÓN (rur-xps-8700)                       │
 │   IP Tailscale: 100.126.20.52                                 │
 │   Base de Datos: PostgreSQL (page_rur_db)                     │
 │   Tabla: robots (rassor-1, rassor-8681)                       │
 └───────────────────────────────────────────────────────────────┘
```

### Ventajas de Seguridad:
1. **Sin exposición a Internet pública**: No se requieren puertos abiertos ni reenvío NAT en routers.
2. **Autenticación mTLS WireGuard**: Tráfico completamente cifrado y aislado a nivel de kernel por Tailscale.
3. **Acceso directo a la base de datos de producción**: Acceso consistente al catálogo de robots reales (`rassor-1` y `rassor-8681`).

---

## 🚫 Deprecación y Eliminación Total de Sincronización por GitHub

> [!CAUTION]
> **El mecanismo de sincronización mediante repositorios de GitHub (`scripts/sync_rur_repos.py`) fue completamente DESCARTADO Y PROHIBIDO.**

* **Razón técnica**: Descargar código, credenciales o tokens desde repositorios Git remotos en tiempo de ejecución introducía riesgos severos de fuga de secretos en historial Git, lentitud por rate limits de la API de GitHub y riesgo de desincronización con el estado real de la base de datos de producción.
* **Estado actual**: Todo script, tarea programada o comando vinculado a GitHub Sync fue **100% removido** del proyecto.
* **Mecanismo oficial único**: La sincronización se realiza en tiempo real vía API REST autenticada mediante llave de dispositivo (`rurcc_...`) directamente contra el servidor `rur-xps-8700` sobre Tailscale.

---

## 🛡️ Modelo de Credenciales "Zero-Exposure" en Memoria RAM

El Centro de Control implementa una política estricta de **cero persistencia de secretos en disco**:

1. **Cifrado en Reposo (Servidor)**: En la base de datos PostgreSQL (`page_rur_db`), las credenciales maestras de LiveKit se almacenan cifradas con AES-256-GCM utilizando la llave simétrica del servidor (`ROBOTS_SECRET_KEY`).
2. **Tokens Efímeros en Tránsito**: Al seleccionar un robot, el Centro de Control solicita tokens firmados (`POST /api/control-center/robots/:id/tokens`). El servidor genera dos tokens JWT de corta duración (4 horas de vigencia) con identidades separadas:
   - `receiver`: Identidad `robot-<id>` (control de actuadores y telemetría de sensores).
   - `camera`: Identidad `robot-<id>-cam` (transmisión de vídeo WebRTC / LiDAR).
3. **Aislamiento Estricto en RAM (Cliente)**: Los tokens JWT recibidos **NUNCA se guardan en archivos `.env`**, ni en scripts locales, ni en el almacenamiento persistente (`.rur-config.json`). Residen exclusivamente en la memoria RAM del proceso `server.js` (`activeContext.tokens`).
4. **Inyección en Caliente (Runtime Injection)**: Cuando el operador lanza una terminal ConPTY o subproceso WSL2, las variables de entorno se inyectan en tiempo de ejecución directamente al entorno volátil del proceso hijo:
   ```bash
   ROS_DOMAIN_ID=42
   LIVEKIT_URL=wss://livekit.rur.unipoli.edu.mx
   LIVEKIT_ROOM=mision-lunar-1
   LIVEKIT_TOKEN="eyJhbGciOi..."
   LIVEKIT_CAMERA_TOKEN="eyJhbGciOi..."
   RUR_ROBOT_ID="rassor-1"
   ```

---

## 🔄 Switcher de Robots y Teardown Limpio Anti-Crasheos

El operador puede conmutar en cualquier momento entre las diferentes unidades registradas en la base de datos (`rassor-1`, `rassor-8681`) desde el Switcher en el HUD superior.

Para evitar colisiones de tópicos DDS en ROS 2, conflictos de puertos y fugas de memoria, el Centro de Control ejecuta un **Teardown Limpio Completo**:

```
                     OPERADOR SELECCIONA NUEVO ROBOT
                                    │
                                    ▼
       ┌─────────────────────────────────────────────────────────┐
       │             PROTOCOLO DE TEARDOWN COMPLETO              │
       │                                                         │
       │  1. CIERRE DE VENTANAS EN EL CANVAS                     │
       │     Se cierran de inmediato todas las pestañas/ventanas │
       │     abiertas en la interfaz gráfica.                    │
       │                                                         │
       │  2. TERMINACIÓN DE PROCESOS (ptyProcess.kill())         │
       │     terminateAllPtyProcesses('robot_changed') mata      │
       │     todos los subprocesos ConPTY, WSL2 y scripts bash. │
       │                                                         │
       │  3. LIBERACIÓN DE PUERTOS Y DDS                         │
       │     Se liberan sockets CycloneDDS, puertos de telemetría│
       │     y canales de hardware de la unidad anterior.        │
       │                                                         │
       │  4. BROADCAST WEBSOCKET ('all_killed')                  │
       │     Notifica a todos los clientes para resetear badges, │
       │     indicadores de estado y limpiar terminales.         │
       │                                                         │
       │  5. OBTENCIÓN DE TOKENS FRESCOS EN RAM                  │
       │     Solicita nuevos JWT al backend y actualiza          │
       │     activeContext en memoria para el nuevo robot.       │
       └─────────────────────────────────────────────────────────┘
```

---

## 📡 Detección Automática de Actualizaciones (Polling Reactivo)

1. **Sondeo Periódico Eficiente**: Cada 20 segundos, la estación terrena consulta `GET /api/control-center/robots` enviando la cabecera `If-None-Match` con el ETag de su catálogo local.
2. **Respuesta 304 Not Modified**: Si no hay cambios en la base de datos, el servidor responde con HTTP 304 sin cuerpo, eliminando uso innecesario de ancho de banda y CPU.
3. **Detección de Discrepancias**: Si un administrador actualiza la sala, las credenciales o el `rosDomainId` del robot activo en la web:
   - El disparador PostgreSQL `trg_robots_config_version` incrementa `config_version`.
   - El Centro de Control detecta la discrepancia y despliega una **pastilla de aviso en el HUD**:
     `"Actualización web detectada: Sala (mision-2), Dominio ROS (45)"`.
4. **Botón "Aplicar Actualización"**: Al pulsar el botón, la aplicación ejecuta el Teardown Limpio, refresca los tokens en RAM y prepara el entorno sin necesidad de reiniciar el servidor.

---

## 🎛️ Módulos de Recepción Integrados

### 1. Telemetría y Control de Actuadores (LiveKit WebRTC)
* **Receptor Multicanal (`scripts/robot_receiver_prod.py`):**
  Daemon receptor que decodifica simultáneamente **6 canales de control**:
  1. **Joystick Binario (12 bytes `<Iff`):** Timestamp, velocidad lineal `linear_x` y velocidad angular `angular_z`.
  2. **Brazo Delantero (`ArmFront`):** Estados `up`, `down`, `stopped`.
  3. **Brazo Trasero (`ArmBack`):** Estados `up`, `down`, `stopped`.
  4. **Tambor Excavador Delantero (`DrumFront`):** Rotación `cw`, `ccw`, `stopped`.
  5. **Tambor Excavador Trasero (`DrumBack`):** Rotación `cw`, `ccw`, `stopped`.
  6. **Sistema de Tracción (`Wheels`):** Estados `forward`, `backward`, `left`, `right`, `stopped`.

### 2. Percepción Visual y Nubes de Puntos 3D (LiDAR L515)
* **Puente ROS 2 ➔ LiveKit (`scripts/start_livekit.sh` & `scripts/l515_livekit_bridge.py`):**
  Transmite `/camera/color/image_raw` y mapas de profundidad térmicos `16UC1` (`COLORMAP_JET`) hacia LiveKit.
* **Receptor SLAM 3D Denso (`scripts/start_slam.sh` — RTAB-Map):**
  Mapeo 3D sincronizado con odometría y nubes densas.
* **Receptor de Voxeles OctoMap (`scripts/start_octomap.sh`):**
  Generación de mallas de ocupación 3D volumétricas con resolución de 5 cm.

### 3. Terminales Interactivas Nativas (ConPTY / WSL2)
* Consola interactiva integrada en el Canvas con `ROS_DOMAIN_ID` del robot activo.
* Soporte para atajos de teclado `Ctrl+C` (copiar o SIGINT), `Ctrl+V` (pegar) y navegación por historial.

---

## 🚀 Instalación y Puesta en Marcha

### Requisitos Previos:
- Node.js 18+ instalado.
- Conexión activa a la red **Tailscale** con acceso al host `100.126.20.52`.
- (Opcional en Windows) WSL2 con Ubuntu si se ejecutan nodos nativos de ROS 2.

### Ejecución:
```bash
# 1. Posicionarse en el directorio
cd centro-de-control

# 2. Instalar dependencias
npm install

# 3. Iniciar el Centro de Control
npm start
```

Abrir en el navegador: **[http://localhost:3000](http://localhost:3000)**

### Vinculación Inicial:
1. En el panel web de administración (`PAGE_RUR`), ir a la sección de Centro de Control y generar una llave de dispositivo (`rurcc_...`).
2. En la aplicación de escritorio, abrir el modal de **Bóveda / Conexión**.
3. Configurar la URL de la API: `http://100.126.20.52:3000` (o `https://rur.unipolidgo.edu.mx`).
4. Pegar la llave `rurcc_...` y guardar.
5. El sistema iniciará la sincronización automática de robots y emisión de tokens.

---

## 📴 Modo Offline y Contingencia

Si la conexión con `rur-xps-8700` sobre Tailscale se interrumpe:
- El sistema utiliza la caché local en `.rur-cache.json` para mantener la lista de robots.
- Si los tokens en RAM aún no han expirado (ventana de 4 horas), la teleoperación continúa sin degradación.
- Para entornos de desarrollo aislados, existe fallback automático a credenciales locales en `scripts/.env`.

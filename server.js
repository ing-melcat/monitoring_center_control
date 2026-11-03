const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { execSync, execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const HOST = '127.0.0.1';
const PORT = 3000;
const isWin = process.platform === 'win32';
const scriptsDir = path.join(__dirname, 'scripts');
const envFilePath = path.join(scriptsDir, '.env');
const rootEnvFilePath = path.join(__dirname, '.env');
const configFilePath = path.join(__dirname, '.rur-config.json');
const cacheFilePath = path.join(__dirname, '.rur-cache.json');
const gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
const hasGitBash = isWin && fs.existsSync(gitBashPath);

// Token CSRF efímero en RAM por sesión de arranque
const SESSION_CSRF_TOKEN = crypto.randomBytes(32).toString('hex');

// Detección de WSL2 disponible
let hasWslDistro = false;
if (isWin) {
  try {
    const wslOutput = execSync('wsl.exe -l -q', { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf16le');
    hasWslDistro = wslOutput.trim().length > 0;
  } catch (_) {
    hasWslDistro = false;
  }
}

// Configuración persistente del Centro de Control
let appConfig = {
  webApiUrl: 'https://rur.unipolidgo.edu.mx',
  deviceKey: '',
  activeRobotId: 'rassor-1',
  runner: 'native', // 'native' | 'wsl'
};

function loadAppConfig() {
  if (fs.existsSync(configFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
      appConfig = { ...appConfig, ...data };
    } catch (_) {}
  }
}

function saveAppConfig() {
  try {
    fs.writeFileSync(configFilePath, JSON.stringify(appConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[Config] Error guardando .rur-config.json:', err.message);
  }
}

loadAppConfig();

// Parseador de .env local (para modo offline o fallback)
function parseEnvFile(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

// Estado del robot activo y tokens en memoria RAM (Zero-Exposure)
const activeContext = {
  robotId: appConfig.activeRobotId || 'rassor-1',
  name: 'rassor',
  room: 'room-1',
  livekitUrl: 'wss://rassor-tb5pwrbm.livekit.cloud',
  rosDomainId: '42',
  tokens: {
    receiver: '',
    camera: '',
  },
  expiresAt: null,
  source: 'web',
  version: 1,
  hasToken: false,
};

// Sesión de operador activo y caché segura en disco (modo 0o600)
const sessionFilePath = path.join(__dirname, '.rur-session.json');
const OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas de duración continua
let activeOperator = null;

function saveOperatorSession() {
  if (!activeOperator) {
    if (fs.existsSync(sessionFilePath)) {
      try { fs.unlinkSync(sessionFilePath); } catch (_) {}
    }
    return;
  }
  try {
    fs.writeFileSync(
      sessionFilePath,
      JSON.stringify(activeOperator, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch (err) {
    console.error('[SessionCache] Error guardando sesión:', err.message);
  }
}

function loadOperatorSession() {
  if (!fs.existsSync(sessionFilePath)) return null;
  try {
    const raw = fs.readFileSync(sessionFilePath, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.expiresAt && new Date(data.expiresAt).getTime() > Date.now()) {
      return data;
    }
    // Si ya caducó, eliminar archivo
    try { fs.unlinkSync(sessionFilePath); } catch (_) {}
  } catch (_) {}
  return null;
}

function clearOperatorSession() {
  activeOperator = null;
  if (fs.existsSync(sessionFilePath)) {
    try { fs.unlinkSync(sessionFilePath); } catch (_) {}
  }
}

// Carga inicial de sesión persistida
activeOperator = loadOperatorSession();
if (activeOperator) {
  console.log(`[SessionCache] Sesión de operador restaurada (${activeOperator.matricula}), válida hasta: ${activeOperator.expiresAt}`);
}

// Robots reales de la base de datos (Catálogo público sin secretos)
let robotsCatalog = [
  {
    id: 'rassor-1',
    name: 'rassor',
    room: 'room-1',
    livekitUrl: 'wss://rassor-tb5pwrbm.livekit.cloud',
    rosDomainId: 42,
    locomotionType: 'tank',
    hasCredentials: true,
    version: 1,
    status: 'online',
  },
  {
    id: 'rassor-8681',
    name: 'room-1',
    room: 'room-1',
    livekitUrl: 'wss://project-a-pvf9s3gy.livekit.cloud',
    rosDomainId: 42,
    locomotionType: 'joystick',
    hasCredentials: true,
    version: 1,
    status: 'online',
  },
];

let syncStatus = {
  ok: true,
  lastSync: null,
  error: null,
  code: 'OK',
  mode: 'tailscale_db',
  etag: null,
};

let updateNotice = {
  pending: false,
  details: null,
  newVersion: null,
  fields: [],
};

// Cargar caché previo si existe, filtrando exclusivamente robots reales
if (fs.existsSync(cacheFilePath)) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
    if (Array.isArray(c.robots) && c.robots.length > 0) {
      const filtered = c.robots.filter((r) => r.id === 'rassor-1' || r.id === 'rassor-8681');
      if (filtered.length > 0) robotsCatalog = filtered;
    }
    if (c.activeContext && (c.activeContext.robotId === 'rassor-1' || c.activeContext.robotId === 'rassor-8681')) {
      Object.assign(activeContext, c.activeContext);
    }
    if (c.syncStatus) syncStatus = { ...syncStatus, ...c.syncStatus };
  } catch (_) {}
}

function saveCache() {
  try {
    fs.writeFileSync(
      cacheFilePath,
      JSON.stringify({ robots: robotsCatalog, activeContext, syncStatus }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch (_) {}
}

// Cargar credenciales locales .env como base fallback
const localEnv = { ...parseEnvFile(rootEnvFilePath), ...parseEnvFile(envFilePath) };
if (!activeContext.livekitUrl && localEnv.LIVEKIT_URL) activeContext.livekitUrl = localEnv.LIVEKIT_URL;
if (!activeContext.room && localEnv.LIVEKIT_ROOM) activeContext.room = localEnv.LIVEKIT_ROOM;
if (localEnv.ROS_DOMAIN_ID) activeContext.rosDomainId = localEnv.ROS_DOMAIN_ID;

// Generador local de JWT si se opera en modo autónomo/offline
function generateLocalJwt(identity, apiKey, apiSecret, room) {
  if (!apiKey || !apiSecret) return '';
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: apiKey,
    sub: identity,
    name: identity,
    nbf: now - 5,
    exp: now + 14400,
    video: { roomJoin: true, room: room || 'room-1', canPublish: true, canSubscribe: true, canPublishData: true },
  };
  const b64 = (s) => Buffer.from(typeof s === 'string' ? s : JSON.stringify(s)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.createHmac('sha256', apiSecret).update(signingInput).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${signingInput}.${sig}`;
}

// =========================================================================
// SINCRONIZACIÓN AUTOMÁTICA CON PAGE_RUR (API HTTPS por Internet Normal)
// =========================================================================

async function syncRobotsFromWeb() {
  if (!appConfig.deviceKey || !appConfig.webApiUrl) {
    syncStatus.ok = false;
    syncStatus.code = 'NO_DEVICE_KEY';
    syncStatus.error = 'Llave de dispositivo no configurada. Configúrala en Bóveda/Dispositivo.';
    return;
  }

  const url = `${appConfig.webApiUrl.replace(/\/+$/, '')}/api/control-center/robots`;
  const headers = {
    Authorization: `Bearer ${appConfig.deviceKey.trim()}`,
    'User-Agent': 'RUR-ControlCenter/2.0',
  };
  if (syncStatus.etag) headers['If-None-Match'] = syncStatus.etag;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);

    if (res.status === 304) {
      syncStatus.ok = true;
      syncStatus.lastSync = new Date().toISOString();
      syncStatus.error = null;
      syncStatus.code = 'OK';
      syncStatus.mode = 'web_https';
      return;
    }

    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      syncStatus.ok = false;
      syncStatus.code = data.codigo || 'DEVICE_REVOKED';
      syncStatus.error = data.message || 'La llave del Centro de Control fue rechazada o revocada en la web.';
      return;
    }

    if (res.status === 429) {
      syncStatus.ok = false;
      syncStatus.code = 'RATE_LIMITED';
      syncStatus.error = 'Límite de peticiones alcanzado; esperando próximo ciclo.';
      return;
    }

    if (!res.ok) {
      syncStatus.ok = false;
      syncStatus.code = 'SERVER_ERROR';
      syncStatus.error = `Error HTTP ${res.status} desde la plataforma web.`;
      return;
    }

    const data = await res.json();
    if (data.success && Array.isArray(data.robots)) {
      robotsCatalog = data.robots;
      syncStatus.ok = true;
      syncStatus.lastSync = new Date().toISOString();
      syncStatus.error = null;
      syncStatus.code = 'OK';
      syncStatus.mode = 'web_https';
      syncStatus.etag = res.headers.get('ETag') || null;

      // Comprobar si el robot activo sufrió cambios en la base de datos
      const currentInDb = robotsCatalog.find((r) => r.id === activeContext.robotId);
      if (!currentInDb) {
        updateNotice.pending = true;
        updateNotice.details = `El robot activo (${activeContext.robotId}) fue eliminado de la plataforma.`;
        updateNotice.fields = ['deleted'];
      } else {
        const changedFields = [];
        if (currentInDb.room !== activeContext.room) changedFields.push('Sala (' + currentInDb.room + ')');
        if (String(currentInDb.rosDomainId) !== String(activeContext.rosDomainId)) changedFields.push('Dominio ROS (' + currentInDb.rosDomainId + ')');
        if (currentInDb.livekitUrl && currentInDb.livekitUrl !== activeContext.livekitUrl) changedFields.push('URL LiveKit');
        if (activeContext.version && currentInDb.version && currentInDb.version !== activeContext.version) changedFields.push('Credenciales / Config v' + currentInDb.version);

        if (changedFields.length > 0) {
          updateNotice.pending = true;
          updateNotice.details = `Actualización web detectada: ${changedFields.join(', ')}`;
          updateNotice.fields = changedFields;
          updateNotice.newVersion = currentInDb.version;
        } else {
          updateNotice.pending = false;
          updateNotice.details = null;
          updateNotice.fields = [];
        }
      }

      // Asegurar tokens válidos para el robot activo
      if (!activeContext.hasToken) {
        await fetchTokensForRobot(activeContext.robotId);
      }
      saveCache();
    }
  } catch (err) {
    syncStatus.ok = false;
    syncStatus.code = 'NET_UNREACHABLE';
    syncStatus.error = `Sin conexión con ${appConfig.webApiUrl}. Usando copia en caché (${syncStatus.lastSync ? new Date(syncStatus.lastSync).toLocaleTimeString() : 'local'}).`;
  }
}

// Obtener tokens firmados para el robot seleccionado (HTTPS Internet Normal)
async function fetchTokensForRobot(robotId) {
  // 1. Obtener tokens directamente desde la plataforma Web (Internet Normal / HTTPS)
  if (appConfig.deviceKey && appConfig.webApiUrl) {
    const url = `${appConfig.webApiUrl.replace(/\/+$/, '')}/api/control-center/robots/${encodeURIComponent(robotId)}/tokens`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appConfig.deviceKey.trim()}`,
          'Content-Type': 'application/json',
          'User-Agent': 'RUR-ControlCenter/2.0',
        },
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        activeContext.robotId = data.robot.id;
        activeContext.name = data.robot.name;
        activeContext.room = data.room;
        activeContext.livekitUrl = data.livekitUrl;
        activeContext.rosDomainId = String(data.rosDomainId);
        activeContext.tokens = data.tokens || {};
        activeContext.expiresAt = data.expiresAt;
        activeContext.source = 'web';
        activeContext.hasToken = Boolean(data.tokens && data.tokens.receiver);
        activeContext.version = data.robot.version;

        updateNotice.pending = false;
        updateNotice.details = null;
        updateNotice.fields = [];

        saveCache();
        return { ok: true, source: 'web' };
      }
    } catch (err) {
      console.warn('[Tokens] Falló obtención vía API Web, intentando fallback:', err.message);
    }
  }

  // 2. Fallback a variables locales .env
  const target = robotsCatalog.find((r) => r.id === robotId) || { id: robotId, name: robotId, room: 'room-1', rosDomainId: 42 };
  activeContext.robotId = target.id;
  activeContext.name = target.name;
  activeContext.room = target.room || 'room-1';
  activeContext.rosDomainId = String(target.rosDomainId || 42);
  activeContext.livekitUrl = target.livekitUrl || localEnv.LIVEKIT_URL || '';
  activeContext.tokens = {
    receiver: generateLocalJwt(`robot-${target.id}`, localEnv.LIVEKIT_API_KEY, localEnv.LIVEKIT_API_SECRET, activeContext.room),
    camera: generateLocalJwt(`robot-${target.id}-cam`, localEnv.LIVEKIT_API_KEY, localEnv.LIVEKIT_API_SECRET, activeContext.room),
  };
  activeContext.source = 'local_env';
  activeContext.version = target.version || 1;
  activeContext.hasToken = Boolean(activeContext.tokens.receiver);
  saveCache();
  return { ok: true, source: 'local_env' };
}

// Bucle periódico de sincronización (cada 20 segundos)
setInterval(syncRobotsFromWeb, 20000);
setTimeout(syncRobotsFromWeb, 1500);

// =========================================================================
// REGISTRO GLOBAL DE PROCESOS PTY Y TEARDOWN LIMPIO AL CAMBIAR ROBOT
// =========================================================================
const activePtys = new Map(); // socket -> ptyProcess
const allSockets = new Set();

function terminateAllPtyProcesses(reason = 'robot_changed') {
  console.log(`[PTY] Terminando todos los procesos en ejecución (Motivo: ${reason})...`);
  for (const [ws, proc] of activePtys.entries()) {
    try {
      proc.kill();
    } catch (_) {}
    activePtys.delete(ws);
  }
  for (const ws of allSockets) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'all_killed', reason, activeRobot: activeContext.name }));
    }
  }
}

// Construye variables de entorno para cada subproceso
function buildProcessEnv(cmdId) {
  const isCamera = cmdId === 'livekit_bridge' || cmdId === 'camera_node';
  const token = isCamera ? activeContext.tokens.camera : activeContext.tokens.receiver;

  return {
    ...process.env,
    ROS_DOMAIN_ID: String(activeContext.rosDomainId || '42'),
    RMW_IMPLEMENTATION: 'rmw_cyclonedds_cpp',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    LIVEKIT_URL: activeContext.livekitUrl,
    LIVEKIT_ROOM: activeContext.room,
    LIVEKIT_TOKEN: token || '',
    RUR_ROBOT_ID: activeContext.robotId,
    RUR_ROBOT_NAME: activeContext.name,
  };
}

// Construcción de comandos para ejecutor: WSL2 vs Host Nativo
function runScriptCommand(shFile, fallbackWinCmd) {
  const runner = appConfig.runner;
  if (isWin && runner === 'wsl') {
    const wslShPath = `/mnt/c/${scriptsDir.replace(/^[A-Z]:\\/, '').replace(/\\/g, '/')}/${shFile}`;
    return {
      file: 'wsl.exe',
      args: ['-d', 'Ubuntu', '-e', 'bash', '-c', `export ROS_DOMAIN_ID=${activeContext.rosDomainId}; export LIVEKIT_TOKEN="${activeContext.tokens.receiver}"; cd /mnt/c/${__dirname.replace(/^[A-Z]:\\/, '').replace(/\\/g, '/')} && bash scripts/${shFile}`],
      cwd: __dirname,
    };
  }
  if (!isWin) {
    return { file: '/bin/bash', args: [path.join(scriptsDir, shFile)], cwd: __dirname };
  }
  if (hasGitBash) {
    return { file: gitBashPath, args: [`scripts/${shFile}`], cwd: __dirname };
  }
  return { file: 'cmd.exe', args: ['/c', fallbackWinCmd], cwd: __dirname };
}

function runRosCommand(rosCmd) {
  const domainId = activeContext.rosDomainId || '42';
  const runner = appConfig.runner;

  if (isWin && runner === 'wsl') {
    return {
      file: 'wsl.exe',
      args: [
        '-d',
        'Ubuntu',
        '-e',
        'bash',
        '-c',
        `source /opt/ros/jazzy/setup.bash 2>/dev/null || source /opt/ros/humble/setup.bash 2>/dev/null || true; export ROS_DOMAIN_ID=${domainId}; export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; echo "==> [RUR ROS 2 WSL2 | DOMAIN_ID=${domainId} | CycloneDDS] Ejecutando: ${rosCmd}"; ${rosCmd}`
      ],
      cwd: __dirname,
    };
  }

  if (!isWin) {
    return {
      file: '/bin/bash',
      args: [
        '-c',
        `source /opt/ros/jazzy/setup.bash 2>/dev/null || source /opt/ros/humble/setup.bash 2>/dev/null || true; export ROS_DOMAIN_ID=${domainId}; export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; echo "==> [RUR ROS 2 Host | DOMAIN_ID=${domainId} | CycloneDDS] Ejecutando: ${rosCmd}"; ${rosCmd}`
      ],
      cwd: __dirname,
    };
  }
  return {
    file: 'cmd.exe',
    args: ['/c', `set "ROS_DOMAIN_ID=${domainId}" && echo [RUR ROS 2 Host - DOMAIN_ID=${domainId}] Ejecutando: ${rosCmd} && ${rosCmd}`],
    cwd: __dirname,
  };
}

// Catálogo de módulos RUR
const COMMANDS = {
  robot_receiver: {
    code: 'livekit_rx',
    label: 'Receptor LiveKit',
    description: 'Ingesta WebRTC: joystick binario (12B) y actuadores JSON.',
    cliPreview: 'python3 -u scripts/robot_receiver_prod.py',
    topics: ['Joystick (12B)', 'ArmFront/Back', 'DrumFront/Back', 'Wheels'],
    outputType: 'CONSOLE_STREAM',
    outputLabel: 'Terminal',
    category: 'livekit',
    badge: '6 canales',
    getSpawn: () => {
      if (isWin && appConfig.runner === 'wsl') {
        return {
          file: 'wsl.exe',
          args: ['-d', 'Ubuntu', '-e', 'bash', '-c', `cd /mnt/c/${scriptsDir.replace(/^[A-Z]:\\/, '').replace(/\\/g, '/')} && python3 -u robot_receiver_prod.py`],
          cwd: scriptsDir,
        };
      }
      return isWin
        ? { file: 'cmd.exe', args: ['/c', 'python -u robot_receiver_prod.py'], cwd: scriptsDir }
        : { file: '/bin/bash', args: ['-c', 'python3 -u robot_receiver_prod.py'], cwd: scriptsDir };
    },
  },
  livekit_bridge: {
    code: 'webrtc_bridge',
    label: 'Puente Video ROS 2 / LiveKit',
    description: 'Streaming WebRTC de color RGB8 y profundidad 16UC1.',
    cliPreview: 'bash scripts/start_livekit.sh',
    topics: ['/camera/color/image_raw', '/camera/aligned_depth_to_color/image_raw'],
    outputType: 'CONSOLE_STREAM',
    outputLabel: 'Terminal',
    category: 'livekit',
    badge: 'WebRTC',
    getSpawn: () => runScriptCommand('start_livekit.sh', 'python -u scripts\\l515_livekit_bridge.py'),
  },
  rviz2_gui: {
    code: 'rviz2',
    label: 'RViz2 Visor 3D',
    description: 'Visualización 3D de TF, PointCloud2, odometría y mapas.',
    cliPreview: 'ros2 run rviz2 rviz2',
    topics: ['/tf', '/camera/depth/color/points', '/map', '/octomap_full'],
    outputType: 'GUI_AND_CONSOLE',
    outputLabel: 'GUI + Log',
    category: 'gui_nav',
    badge: 'GUI 3D',
    getSpawn: () => runRosCommand('rviz2'),
  },
  nav2_bringup: {
    code: 'nav2_bringup',
    label: 'Nav2 Navegación Autónoma',
    description: 'Planner, Controller, Behavior Trees y Costmaps 2D/3D.',
    cliPreview: 'ros2 launch nav2_bringup navigation_launch.py use_sim_time:=false',
    topics: ['/odom', '/scan', '/cmd_vel', '/plan'],
    outputType: 'GUI_AND_CONSOLE',
    outputLabel: 'Nav2 + Log',
    category: 'gui_nav',
    badge: 'Nav2',
    getSpawn: () => runRosCommand('ros2 launch nav2_bringup navigation_launch.py use_sim_time:=false'),
  },
  rqt_graph: {
    code: 'rqt_graph',
    label: 'Grafo DDS (rqt_graph)',
    description: 'Topología visual de nodos y suscripciones en Domain 42.',
    cliPreview: 'ros2 run rqt_graph rqt_graph',
    topics: ['/rosout', 'DDS Domain 42'],
    outputType: 'GUI_AND_CONSOLE',
    outputLabel: 'GUI + Log',
    category: 'gui_nav',
    badge: 'Topología',
    getSpawn: () => runRosCommand('ros2 run rqt_graph rqt_graph'),
  },
  detector_live: {
    code: 'mobilenet_ssd',
    label: 'Detector IA MobileNet-SSD',
    description: 'Inferencia DNN Caffe en tiempo real con visor OpenCV.',
    cliPreview: 'python3 -u scripts/detector_live.py',
    topics: ['/dev/video0', 'OpenCV GUI'],
    outputType: 'GUI_AND_CONSOLE',
    outputLabel: 'Video + Log',
    category: 'gui_nav',
    badge: 'Visión IA',
    getSpawn: () => isWin
      ? { file: 'cmd.exe', args: ['/c', 'python -u detector_live.py'], cwd: scriptsDir }
      : { file: '/bin/bash', args: ['-c', 'python3 -u detector_live.py'], cwd: scriptsDir },
  },
  camera_node: {
    code: 'l515_driver',
    label: 'Driver LiDAR RealSense L515',
    description: 'Contenedor l515-ros: nube 3D y profundidad alineada (30 FPS).',
    cliPreview: 'bash scripts/start_camera.sh',
    topics: ['/camera/color/image_raw', '/camera/depth/color/points'],
    outputType: 'CONSOLE_STREAM',
    outputLabel: 'Docker + Log',
    category: 'percepcion_3d',
    badge: 'L515',
    getSpawn: () => runScriptCommand('start_camera.sh', 'docker ps'),
  },
  slam_rtabmap: {
    code: 'rtabmap_slam',
    label: 'SLAM 3D Denso (RTAB-Map)',
    description: 'Mapeo RGB-D, odometría visual y visor RViz2.',
    cliPreview: 'bash scripts/start_slam.sh',
    topics: ['/camera/color/image_raw', '/camera/aligned_depth_to_color/image_raw', '/odom'],
    outputType: 'GUI_AND_CONSOLE',
    outputLabel: 'RViz2 + Log',
    category: 'percepcion_3d',
    badge: 'SLAM 3D',
    getSpawn: () => runScriptCommand('start_slam.sh', 'ros2 launch rtabmap_launch rtabmap.launch.py'),
  },
  octomap_server: {
    code: 'octomap_srv',
    label: 'OctoMap Server 3D',
    description: 'Grilla de ocupación octal (0.05m) desde PointCloud2.',
    cliPreview: 'bash scripts/start_octomap.sh',
    topics: ['/camera/depth/color/points', '/octomap_binary', '/octomap_full'],
    outputType: 'GUI_AND_CONSOLE',
    outputLabel: 'RViz2 + Log',
    category: 'percepcion_3d',
    badge: 'Voxel 0.05m',
    getSpawn: () => runScriptCommand('start_octomap.sh', 'ros2 run octomap_server octomap_server_node'),
  },
  ros_topics_check: {
    code: 'topic_hz',
    label: 'Auditoría de Frecuencia (Hz)',
    description: 'Muestra tasa de recepción de cámara y profundidad.',
    cliPreview: 'bash scripts/check_ros_topics.sh',
    topics: ['ros2 topic list', 'ros2 topic hz'],
    outputType: 'CONSOLE_STREAM',
    outputLabel: 'Terminal',
    category: 'diagnostico',
    badge: 'Hz Audit',
    getSpawn: () => runScriptCommand('check_ros_topics.sh', 'ros2 topic list'),
  },
  ros_topic_list: {
    code: 'topic_list',
    label: 'Inspector de Tópicos DDS',
    description: 'Canales activos, tipos de mensaje y conteo pub/sub.',
    cliPreview: 'ros2 topic list -v',
    topics: ['ROS_DOMAIN_ID', 'CycloneDDS'],
    outputType: 'CONSOLE_STREAM',
    outputLabel: 'Terminal',
    category: 'diagnostico',
    badge: 'DDS List',
    getSpawn: () => runRosCommand('ros2 topic list -v'),
  },
  ros_shell: {
    code: 'ros2_shell',
    label: 'Terminal ROS 2 (ConPTY)',
    description: 'Shell interactivo preconfigurado con Domain y CycloneDDS.',
    cliPreview: 'export ROS_DOMAIN_ID && bash',
    topics: ['ROS_DOMAIN_ID', 'rmw_cyclonedds_cpp'],
    outputType: 'INTERACTIVE_SHELL',
    outputLabel: 'Interactivo',
    category: 'diagnostico',
    badge: 'ROS 2 CLI',
    interactive: true,
    getSpawn: () => {
      const domainId = activeContext.rosDomainId || '42';
      if (isWin && appConfig.runner === 'wsl') {
        return {
          file: 'wsl.exe',
          args: [
            '-d',
            'Ubuntu',
            '-e',
            'bash',
            '-c',
            `source ~/.bashrc 2>/dev/null || true; source /opt/ros/jazzy/setup.bash 2>/dev/null || source /opt/ros/humble/setup.bash 2>/dev/null || true; export ROS_DOMAIN_ID=${domainId}; export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; echo -e "\\e[33m=== RUR ROS 2 WSL2 (DOMAIN_ID=${domainId} | CycloneDDS) ===\\e[0m"; exec bash -i`
          ],
          cwd: __dirname,
        };
      }
      return isWin
        ? {
            file: 'powershell.exe',
            args: [
              '-NoLogo',
              '-NoExit',
              '-Command',
              `Write-Host "=== RUR ROS 2 SHELL (DOMAIN_ID=${domainId} | CycloneDDS) ===" -ForegroundColor Yellow`
            ],
            cwd: __dirname,
          }
        : {
            file: '/bin/bash',
            args: [
              '-c',
              `source ~/.bashrc 2>/dev/null || true; source /opt/ros/jazzy/setup.bash 2>/dev/null || source /opt/ros/humble/setup.bash 2>/dev/null || true; export ROS_DOMAIN_ID=${domainId}; export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; echo -e "\\e[33m=== RUR ROS 2 SHELL (DOMAIN_ID=${domainId} | CycloneDDS) ===\\e[0m"; exec bash -i`
            ],
            cwd: __dirname,
          };
    },
  },
  cmd: {
    code: 'os_shell',
    label: 'Terminal del Sistema',
    description: 'Shell nativo para Docker, Tailscale y sistema local.',
    cliPreview: isWin ? 'cmd.exe' : '/bin/bash',
    topics: ['Host Shell'],
    outputType: 'INTERACTIVE_SHELL',
    outputLabel: 'Interactivo',
    category: 'diagnostico',
    badge: 'OS Shell',
    interactive: true,
    getSpawn: () => isWin
      ? { file: 'cmd.exe', args: [], cwd: __dirname }
      : { file: '/bin/bash', args: [], cwd: __dirname },
  },
};

// =========================================================================
// SERVIDOR EXPRESS Y RUTAS API
// =========================================================================
const app = express();
app.disable('x-powered-by');

function isLoopbackAddress(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

app.use((req, res, next) => {
  const remoteIp = req.socket.remoteAddress || '';
  if (!isLoopbackAddress(remoteIp)) {
    return res.status(403).json({ error: 'Acceso restringido a loopback local (127.0.0.1).' });
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.includes('.env') || req.path.includes('.git')) {
    return res.status(403).end();
  }
  next();
});

app.use(express.json({ limit: '16kb' }));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1d', immutable: false, dotfiles: 'deny' }));
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

app.get('/api/commands', (_req, res) =>
  res.json(
    Object.entries(COMMANDS).map(([id, c]) => ({
      id,
      code: c.code,
      label: c.label,
      description: c.description,
      cliPreview: c.cliPreview,
      topics: c.topics,
      outputType: c.outputType,
      outputLabel: c.outputLabel,
      category: c.category,
      badge: c.badge,
      interactive: !!c.interactive,
    }))
  )
);

// Estado completo del Centro de Control: robot activo, lista sincronizada, diagnóstico
app.get('/api/state', (_req, res) => {
  if (activeOperator && activeOperator.expiresAt && new Date(activeOperator.expiresAt).getTime() <= Date.now()) {
    clearOperatorSession();
  }
  const currentInCatalog = robotsCatalog.find((r) => r.id === activeContext.robotId);
  res.json({
    activeRobot: {
      id: activeContext.robotId,
      name: activeContext.name,
      status: currentInCatalog?.status || 'offline',
      room: activeContext.room,
      rosDomainId: activeContext.rosDomainId,
      livekitUrl: activeContext.livekitUrl,
      source: activeContext.source,
      hasToken: Boolean(activeContext.tokens.receiver),
      expiresAt: activeContext.expiresAt,
      version: activeContext.version,
    },
    runner: appConfig.runner,
    hasWsl: hasWslDistro,
    robots: robotsCatalog,
    updateNotice,
    syncStatus,
    operator: activeOperator,
    config: {
      webApiUrl: appConfig.webApiUrl,
      hasDeviceKey: Boolean(appConfig.deviceKey),
      deviceKeyPrefix: appConfig.deviceKey ? appConfig.deviceKey.slice(0, 10) + '...' : '',
      runner: appConfig.runner,
    },
    csrfToken: SESSION_CSRF_TOKEN,
  });
});

// =========================================================================
// AUTENTICACIÓN Y GESTIÓN DE SESIÓN DE OPERADOR
// =========================================================================

// Inicio de sesión de operador contra PAGE_RUR
app.post('/api/operator/login', async (req, res) => {
  const { matricula, password, code } = req.body || {};
  const credential = code || password;
  if (!matricula || !credential) {
    return res.status(400).json({ success: false, error: 'Matrícula y credencial requeridas.' });
  }

  try {
    const webUrl = (appConfig.webApiUrl || 'https://rur.unipolidgo.edu.mx').replace(/\/+$/, '');
    const loginUrl = `${webUrl}/api/login`;
    const response = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matricula, password: credential, code: credential }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status || 401).json({
        success: false,
        error: data.message || data.error || 'Credenciales inválidas.',
      });
    }

    // Extraer cookies de sesión y CSRF de PAGE_RUR
    let rawCookies = [];
    if (typeof response.headers.getSetCookie === 'function') {
      rawCookies = response.headers.getSetCookie();
    } else {
      const single = response.headers.get('set-cookie');
      if (single) rawCookies = [single];
    }
    const cookieHeader = rawCookies.map(c => c.split(';')[0].trim()).join('; ');
    let csrfCookieValue = '';
    const csrfMatch = cookieHeader.match(/rur_csrf=([^;]+)/);
    if (csrfMatch) csrfCookieValue = csrfMatch[1];

    const expiresAt = new Date(Date.now() + OPERATOR_SESSION_TTL_MS).toISOString();
    activeOperator = {
      ...(data.user || { matricula }),
      nombre: data.user?.nombre || '',
      name: data.user?.nombre || data.user?.name || '',
      alias: data.user?.alias || '',
      loginAt: new Date().toISOString(),
      expiresAt,
      sessionCookies: cookieHeader,
      csrfTokenWeb: csrfCookieValue,
    };
    saveOperatorSession();

    return res.json({ success: true, user: activeOperator });
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: `No se pudo conectar con el servicio de autenticación: ${err.message}`,
    });
  }
});

// Generar secreto y código QR de Google Authenticator vía PAGE_RUR
app.get('/api/operator/2fa/generate', async (_req, res) => {
  if (!activeOperator || !activeOperator.sessionCookies) {
    return res.status(401).json({ success: false, message: 'No hay sesión activa de operador.' });
  }

  try {
    const webUrl = (appConfig.webApiUrl || 'https://rur.unipolidgo.edu.mx').replace(/\/+$/, '');
    const genUrl = `${webUrl}/api/profile/2fa/generate`;
    const response = await fetch(genUrl, {
      method: 'GET',
      headers: {
        'Cookie': activeOperator.sessionCookies,
      },
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      return res.status(response.status || 500).json({
        success: false,
        message: data.message || 'Error al generar el código QR de Authenticator.',
      });
    }

    return res.json({
      success: true,
      secret: data.secret,
      otpauth: data.otpauth,
      qrCodeDataUrl: data.qrCodeDataUrl,
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      message: `Error conectando con la plataforma web: ${err.message}`,
    });
  }
});

// Verificar código de 6 dígitos y activar Passwordless 2FA vía PAGE_RUR
app.post('/api/operator/2fa/enable', async (req, res) => {
  if (!activeOperator || !activeOperator.sessionCookies) {
    return res.status(401).json({ success: false, message: 'No hay sesión activa de operador.' });
  }

  const { code, secret } = req.body || {};
  if (!code || !secret) {
    return res.status(400).json({ success: false, message: 'Código de 6 dígitos y clave requeridos.' });
  }

  try {
    const webUrl = (appConfig.webApiUrl || 'https://rur.unipolidgo.edu.mx').replace(/\/+$/, '');
    const enableUrl = `${webUrl}/api/profile/2fa/enable`;
    const headers = {
      'Content-Type': 'application/json',
      'Cookie': activeOperator.sessionCookies,
    };
    if (activeOperator.csrfTokenWeb) {
      headers['X-CSRF-Token'] = activeOperator.csrfTokenWeb;
    }

    const response = await fetch(enableUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: String(code).trim(), secret: String(secret).trim() }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      return res.status(response.status || 400).json({
        success: false,
        message: data.message || 'Código inválido o expirado. Revisa tu aplicación Authenticator.',
      });
    }

    // Actualizar estado en memoria y persistir en caché segura
    activeOperator.totp_enabled = true;
    activeOperator.debe_cambiar_password = false;
    saveOperatorSession();

    return res.json({
      success: true,
      message: 'Autenticación en dos pasos (Google Authenticator) activada exitosamente.',
      user: {
        id: activeOperator.id,
        matricula: activeOperator.matricula,
        nombre: activeOperator.nombre,
        roles: activeOperator.roles,
        totp_enabled: true,
        debe_cambiar_password: false,
      },
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      message: `Error al verificar con la plataforma web: ${err.message}`,
    });
  }
});

// Consulta de estado de sesión del operador activo
app.get('/api/operator/session', (_req, res) => {
  if (activeOperator && activeOperator.expiresAt && new Date(activeOperator.expiresAt).getTime() <= Date.now()) {
    clearOperatorSession();
  }
  res.json({
    authenticated: Boolean(activeOperator),
    operator: activeOperator ? {
      id: activeOperator.id,
      matricula: activeOperator.matricula,
      nombre: activeOperator.nombre || '',
      name: activeOperator.nombre || activeOperator.name || '',
      alias: activeOperator.alias || '',
      roles: activeOperator.roles || [],
      grupo: activeOperator.grupo || '',
      totp_enabled: activeOperator.totp_enabled,
      debe_cambiar_password: activeOperator.debe_cambiar_password,
      expiresAt: activeOperator.expiresAt,
    } : null,
  });
});

// Cierre de sesión y desmontaje de procesos
app.post('/api/operator/logout', (_req, res) => {
  terminateAllPtyProcesses('Cierre de sesión de operador');
  clearOperatorSession();
  res.json({ success: true });
});

// Teardown por retorno a lobby sin cerrar sesión necesariamente
app.post('/api/operator/teardown', (_req, res) => {
  terminateAllPtyProcesses('Retorno a lobby');
  res.json({ success: true });
});

// Cambiar de robot activo -> TEARDOWN LIMPIO DE TODAS LAS PESTAÑAS Y PROCESOS
app.post('/api/active-robot', async (req, res) => {
  const token = req.headers['x-rur-csrf'];
  if (!token || token !== SESSION_CSRF_TOKEN) {
    return res.status(403).json({ error: 'Token CSRF inválido.' });
  }

  const { robotId, runner } = req.body || {};
  if (!robotId) return res.status(400).json({ error: 'Falta robotId.' });

  // 1. Matar todos los procesos activos anteriores para evitar crasheos y fugas de rendimiento
  terminateAllPtyProcesses(`Cambio de robot a: ${robotId}`);

  // 2. Cambiar modo de ejecución si se especificó
  if (runner === 'wsl' || runner === 'native') {
    appConfig.runner = runner;
  }
  appConfig.activeRobotId = robotId;
  saveAppConfig();

  // 3. Obtener tokens frescos para el nuevo robot
  const tokenRes = await fetchTokensForRobot(robotId);

  return res.json({
    ok: true,
    switchedTo: activeContext.name,
    robotId: activeContext.robotId,
    room: activeContext.room,
    rosDomainId: activeContext.rosDomainId,
    tokenSource: activeContext.source,
    runner: appConfig.runner,
    tokenResult: tokenRes,
  });
});

// Aplicar actualización pendiente detectada desde la web
app.post('/api/sync/apply', async (req, res) => {
  const token = req.headers['x-rur-csrf'];
  if (!token || token !== SESSION_CSRF_TOKEN) {
    return res.status(403).json({ error: 'Token CSRF inválido.' });
  }

  // Teardown de procesos para aplicar la nueva sala o credenciales
  terminateAllPtyProcesses('Aplicando actualización de configuración desde la web');

  const tokenRes = await fetchTokensForRobot(activeContext.robotId);
  return res.json({
    ok: true,
    applied: true,
    robot: activeContext.name,
    tokenResult: tokenRes,
  });
});

// Forzar sincronización inmediata con la web
app.post('/api/sync/now', async (_req, res) => {
  await syncRobotsFromWeb();
  return res.json({
    ok: syncStatus.ok,
    syncStatus,
    robotsCount: robotsCatalog.length,
    updateNotice,
  });
});

// Actualizar configuración de conexión con PAGE_RUR
app.post('/api/config', (req, res) => {
  const token = req.headers['x-rur-csrf'];
  if (!token || token !== SESSION_CSRF_TOKEN) {
    return res.status(403).json({ error: 'Token CSRF inválido.' });
  }

  const { webApiUrl, deviceKey, runner } = req.body || {};
  if (typeof webApiUrl === 'string' && webApiUrl.trim()) {
    appConfig.webApiUrl = webApiUrl.trim().replace(/\/+$/, '');
  }
  if (typeof deviceKey === 'string') {
    appConfig.deviceKey = deviceKey.trim();
  }
  if (runner === 'wsl' || runner === 'native') {
    appConfig.runner = runner;
  }
  saveAppConfig();

  // Re-sincronizar inmediatamente
  syncRobotsFromWeb().catch(() => {});

  return res.json({
    ok: true,
    config: {
      webApiUrl: appConfig.webApiUrl,
      hasDeviceKey: Boolean(appConfig.deviceKey),
      deviceKeyPrefix: appConfig.deviceKey ? appConfig.deviceKey.slice(0, 10) + '...' : '',
      runner: appConfig.runner,
    },
  });
});


// =========================================================================
// WEBSOCKET SERVER Y GESTIÓN CONCURRENTE DE TERMINALES
// =========================================================================
const server = http.createServer(app);
const allowed = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`];
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin, req }) => {
    const remoteIp = req.socket.remoteAddress || '';
    return allowed.includes(origin) && isLoopbackAddress(remoteIp);
  },
});

wss.on('connection', (ws) => {
  allSockets.add(ws);
  let ptyProcess = null;
  let activeCmdId = null;

  const send = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

  const stop = () => {
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch (_) {}
      activePtys.delete(ws);
      ptyProcess = null;
    }
  };

  const launch = (cmdId, cols = 80, rows = 24) => {
    stop();
    if (!COMMANDS[cmdId]) return;
    activeCmdId = cmdId;
    const def = COMMANDS[cmdId];
    const spawnCfg = def.getSpawn();
    const procEnv = buildProcessEnv(cmdId);

    try {
      ptyProcess = pty.spawn(spawnCfg.file, spawnCfg.args, {
        name: 'xterm-color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: spawnCfg.cwd || __dirname,
        env: procEnv,
      });

      activePtys.set(ws, ptyProcess);

      send({
        type: 'started',
        pid: ptyProcess.pid,
        cmdId,
        jwtInjected: Boolean(procEnv.LIVEKIT_TOKEN),
        runner: appConfig.runner,
        robot: activeContext.name,
      });

      ptyProcess.onData((data) => {
        send({ type: 'out', data });
      });

      ptyProcess.onExit(({ exitCode }) => {
        send({ type: 'exit', code: exitCode });
        activePtys.delete(ws);
        ptyProcess = null;
      });
    } catch (err) {
      send({ type: 'out', data: `\x1b[31mError al iniciar proceso (${appConfig.runner}): ${err.message}\x1b[0m\r\n` });
    }
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'run' && COMMANDS[msg.id]) {
      launch(msg.id, msg.cols, msg.rows);
      return;
    }

    if (msg.type === 'in' && ptyProcess) {
      try {
        ptyProcess.write(msg.data);
      } catch (_) {}
      return;
    }

    if (msg.type === 'resize' && ptyProcess && msg.cols && msg.rows) {
      try {
        ptyProcess.resize(msg.cols, msg.rows);
      } catch (_) {}
      return;
    }

    if (msg.type === 'restart') {
      if (activeCmdId) launch(activeCmdId, msg.cols, msg.rows);
      return;
    }

    if (msg.type === 'stop') {
      stop();
      return;
    }
  });

  ws.on('close', () => {
    stop();
    allSockets.delete(ws);
  });
});

// Manejo controlado de errores HTTP y JSON malformado
app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, error: 'JSON malformado en el cuerpo de la petición.' });
  }
  console.error('[HTTP Error]', err.message);
  res.status(err.status || 500).json({ success: false, error: err.message || 'Error interno del servidor.' });
});

// Resiliencia contra excepciones no capturadas de ConPTY / WinPTY en Windows
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

server.listen(PORT, HOST, () => console.log(`Centro de Control RUR activo en http://localhost:${PORT}`));

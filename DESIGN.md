# DESIGN.md — RUR Centro de Control (UNIPOLI)

Contrato de sistema de diseño validado con [`scripts/detect.mjs`](file:///C:/Users/war_machin/Downloads/carreras-terminal/centro-de-control/scripts/detect.mjs) (`avoid-ai-design v0.4.0`).

## 1. Dirección y Dominio
- **Producto:** Estación de recepción de telemetría y ejecución de nodos ROS 2 / LiveKit / RViz2 / Nav2 sobre un lienzo interactivo (`Canvas`).
- **Organización:** Research Unit of Robotics (RUR) — Universidad Politécnica de Durango (UNIPOLI).

## 2. Paleta de Color (Roles)
| Token | Valor | Rol |
| :--- | :--- | :--- |
| `--ground` | `#020716` | Lienzo principal (Azul medianoche profundo, contraste AA) |
| `--surface` | `#050e21` | Superficie sólida de paneles, barra superior y ventanas |
| `--surface-strong` | `#0a1733` | Cabeceras activas y estados hover |
| `--terminal-bg` | `#01040d` | Interior de consolas `xterm.js` ConPTY |
| `--text` | `#EBF0F6` | Texto primario |
| `--muted` | `#9cb0c9` | Texto secundario (contraste `> 6.5:1` WCAG AA sobre `--ground`) |
| `--bone` | `#F5F3E9` | Trazos técnicos, miras y bordes estructurales |
| `--accent` | `#FBCA01` | Amarillo institucional RUR (acción, foco y señal) |

## 3. Tipografía
- **`--font-sans` / `--font-mono` (`Exo 2`):** Tipografía principal de toda la interfaz, títulos, botones, widgets, etiquetas y lecturas de estado.
- **Consola `xterm.js` (`IBM Plex Mono`):** Rejilla monoespaciada interna de la terminal interactiva ConPTY.

## 4. Reglas Anti-Slop (`avoid-ai-design`)
- **Cero emojis como iconografía (`I2`):** Todos los iconos son SVGs técnicos propios en `public/assets/`.
- **Cero glassmorphism reflexivo (`K3`):** Superficies sólidas de alto contraste sin `backdrop-filter: blur`.
- **Cero bordes laterales de color en tarjetas (`K4`):** Estados activos representados por indicadores puntuales (`.state-dot`) y borde completo.
- **Cero numeración decorativa (`SD6`):** Nodos identificados por su nombre real de subsistema (`livekit_rx`, `rviz2`, `nav2_bringup`, `rtabmap_slam`) en lugar de `01 / 02 / 03`.
- **Accesibilidad (`K7`, `M6`, `C9`):** Anillos `:focus-visible` definidos, soporte `@media (prefers-reduced-motion: reduce)` y contraste AA verificado.

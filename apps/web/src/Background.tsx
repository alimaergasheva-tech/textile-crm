import { useEffect, useRef, useState } from "react";
import { useUi } from "./state";

// Полноэкранный треугольник без буферов: вершины берутся из gl_VertexID.
const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Шейдер: «жидкие» переливы (domain-warped fbm) в палитре текстиля: индиго, фиолет, бирюза.
const FS = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uDark;
out vec4 o;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.02 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  float t = uTime * 0.045;
  p += (uMouse - 0.5) * 0.10;
  vec2 q = vec2(fbm(p * 1.6 + vec2(0.0, t)), fbm(p * 1.6 + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p * 1.6 + 3.0 * q + vec2(1.7, 9.2) + t * 1.5), fbm(p * 1.6 + 3.0 * q + vec2(8.3, 2.8) - t * 1.2));
  float f = fbm(p * 1.4 + 3.0 * r);

  vec3 c1 = mix(vec3(0.955, 0.965, 0.99), vec3(0.035, 0.05, 0.11), uDark);
  vec3 c2 = mix(vec3(0.72, 0.82, 1.00),   vec3(0.09, 0.19, 0.55), uDark);
  vec3 c3 = mix(vec3(0.88, 0.80, 1.00),   vec3(0.42, 0.18, 0.72), uDark);
  vec3 c4 = mix(vec3(0.74, 0.96, 0.95),   vec3(0.00, 0.50, 0.60), uDark);

  vec3 col = mix(c1, c2, clamp(f * f * 3.2, 0.0, 1.0));
  col = mix(col, c3, clamp(length(q) * 0.85, 0.0, 1.0) * 0.55);
  col = mix(col, c4, clamp(r.x * r.y * 2.2, 0.0, 1.0) * 0.45);
  col *= 1.0 - 0.45 * dot(uv - 0.5, uv - 0.5);          // виньетка
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) * 0.018;   // лёгкое зерно против бэндинга
  o = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

function ShaderBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  const { theme } = useUi();
  const target = useRef(theme === "dark" ? 1 : 0);
  target.current = theme === "dark" ? 1 : 0;

  useEffect(() => {
    const canvas = ref.current!;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) { document.documentElement.classList.add("bg-fallback"); return; }
    let prog: WebGLProgram;
    try {
      prog = gl.createProgram()!;
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
    } catch { document.documentElement.classList.add("bg-fallback"); return; }
    gl.useProgram(prog);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = u("uRes"), uTime = u("uTime"), uMouse = u("uMouse"), uDark = u("uDark");

    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    let dark = target.current, raf = 0, last = 0, t0 = performance.now(), running = true;

    const resize = () => {
      // Рендер в уменьшенном разрешении: фон размытый по природе, зато почти не грузит видеокарту.
      const k = Math.min(devicePixelRatio || 1, 1.5) * 0.6;
      canvas.width = Math.max(2, Math.floor(innerWidth * k));
      canvas.height = Math.max(2, Math.floor(innerHeight * k));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const draw = (now: number) => {
      dark += (target.current - dark) * 0.08;   // плавная смена темы
      mouse.x += (mouse.tx - mouse.x) * 0.04; mouse.y += (mouse.ty - mouse.y) * 0.04;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, reduce.matches ? 12 : (now - t0) / 1000);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform1f(uDark, dark);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const loop = (now: number) => {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      if (now - last < 33) return;                // ~30 кадров/с достаточно
      last = now;
      draw(now);
      if (reduce.matches && Math.abs(target.current - dark) < 0.01) { running = false; }   // статичный кадр
    };
    const onMove = (e: PointerEvent) => { mouse.tx = e.clientX / innerWidth; mouse.ty = 1 - e.clientY / innerHeight; };
    const onVis = () => {
      running = !document.hidden;                 // на скрытой вкладке не тратим батарею
      if (running) { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); }
    };
    const onTheme = () => { if (!running && !document.hidden) { running = true; raf = requestAnimationFrame(loop); } };

    resize();
    addEventListener("resize", resize);
    addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", onVis);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    raf = requestAnimationFrame(loop);
    return () => {
      running = false; cancelAnimationFrame(raf); mo.disconnect();
      removeEventListener("resize", resize); removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return <canvas ref={ref} className="bg" aria-hidden="true" />;
}

/**
 * Фон приложения. Если в apps/web/public лежит файл bg.jpg, показывается он (с затемнением под тему),
 * иначе остаётся живой WebGL-фон. Картинку проверяем один раз при запуске.
 */
export function Background() {
  const [photo, setPhoto] = useState<boolean | null>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setPhoto(true);
    img.onerror = () => setPhoto(false);
    img.src = "/bg.jpg";
  }, []);
  if (photo === null) return null;
  return photo ? <div className="bg bg-photo" aria-hidden="true" /> : <ShaderBackground />;
}

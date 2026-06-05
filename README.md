# Painting Eye

A real-time WebGL camera filter app for art observation — apply 13 artistic shader modes to live camera feed, freeze frames, sample colors against a 50-pigment database, and capture photos/video. Single-file HTML, no build step, runs on any modern browser with camera access.

> **Live:** [yushihu.top/painting-eye](https://yushihu.top/painting-eye.html)

---

## Core Features

### 13 Real-Time Filter Modes

| Mode | Technique |
|------|-----------|
| BLUR | Box blur (radius-animated) |
| MOSAIC | Pixelation grid |
| FLAT | Mode-finding posterization |
| VALUE | Luminance quantization (12 levels) |
| EDGE | Sobel edge detection |
| TONE | 3-zone value mapping (shadow blue, highlight warm) |
| DUO | High-contrast binary threshold |
| SWIRL | Noise-field displacement + touch interaction |
| OIL | Kuwahara quadrant-variance filter |
| DOF | Radial depth-of-field with tap-to-focus |
| STIPPLE | Hexagonal dot grid on paper-toned background |
| ORIGINAL | Unprocessed pass-through |
| GLITCH | RGB channel split, random band displacement, scanlines, CRT vignette |

All modes support a 1–10 intensity slider and keyboard navigation (arrows to switch modes, left/right for level).

### Color Isolate (Eyedropper)

Tap the palette button → 5 dominant colors extracted from live feed. Click the dropper icon → frame freezes → tap anywhere to sample:

- **11×11–15×15 adaptive block averaging** (radius scales with scene brightness for noise reduction)
- **CIELAB ∆E color matching** against 50 artist pigments (oil/acrylic)
- **Top 3 closest matches** with ∆E distance, `≈` prefix when ambiguous
- **Canvas 2D `drawImage` + `getImageData`** instead of `gl.readPixels` — avoids DPR/framebuffer/color-space browser inconsistencies

### Capture

- **Photo:** tap shutter → WebGL render target snapshot → PNG export via share sheet or download
- **Video:** long-press shutter (300ms hold) → `canvas.captureStream(60fps)` → `MediaRecorder` at 20 Mbps → MP4/WebM export
- **Quality:** requests 4K camera input (`4096×2160 ideal`), renders at up to 3× device pixel ratio

### Gestures & UI

- **Pinch-zoom** (2-finger) and **scroll-wheel zoom** (1×–4×)
- **Tap-to-focus** in DOF mode with gold flash indicator
- **1-finger drag** for swirl displacement
- **Double-tap** blank area to hide/show all UI
- Grid overlays (3-tier), composition frames (phi-spiral, Fibonacci, diagonal, rings)
- Front/rear camera toggle

### PWA Support

Full-screen standalone web app via `manifest.json` + service worker. Add to Home Screen on iOS/Android for no-browser-chrome, offline-capable experience.

---

## Technical Architecture

### Stack

- **Three.js 0.160** — WebGL renderer (`importmap` + ES module, CDN fallback to jsDelivr)
- **Custom GLSL ES 1.00 fragment shaders** — all filters are pure GLSL, no post-processing passes
- **Single `<canvas>` element** — shared by WebGL rendering, photo snapshot (`toDataURL`), and video capture (`captureStream`)
- **Zero build step** — one HTML file, no bundler, no framework

### Rendering Pipeline

```
Camera (getUserMedia)
  → <video> element (playsinline, muted)
  → THREE.VideoTexture (SRGBColorSpace)
  → ShaderMaterial uniform
  → GLSL fragment shader (mode dispatch + filter function)
  → OrthographicCamera full-screen quad
  → WebGL canvas
```

### Color Space Handling

Critical for color accuracy — mismatched color spaces cause double-gamma darkening or washed-out output:

- **VideoTexture:** `THREE.SRGBColorSpace` (live camera feed is already sRGB-encoded)
- **CanvasTexture** (uploaded images): `THREE.LinearSRGBColorSpace` (prevents double-gamma on WebGL1)
- **WebGLRenderTarget** (photo snap): `THREE.LinearSRGBColorSpace`
- **Default renderer output:** left at Three.js 0.160 default (no `outputColorSpace` override)

### Color Isolate: Canvas 2D Bypass

`gl.readPixels` is unreliable across browsers — framebuffer state, DPR handling, and color-space quirks produce inconsistent (often black) results on iOS Safari. The solution:

```javascript
// 1. Render latest frame
renderer.render(scene, camera);
// 2. Draw WebGL canvas onto a fresh 2D canvas (no DPR math needed)
const c2 = document.createElement('canvas');
c2.width = canvas.width;   // full bitmap resolution
c2.height = canvas.height;
const ctx = c2.getContext('2d');
ctx.drawImage(canvas, 0, 0);  // canvas-to-canvas blit, browser handles DPR
// 3. Read pixels reliably
const img = ctx.getImageData(left, top, w, h);
```

Adaptive block size (`half*2+1`² pixels):
- `V < 60` (dark) → 15×15 — suppresses sensor noise
- `V < 120` (dim) → 13×13
- `V ≥ 120` (bright) → 11×11 — precise

### Pigment Matching

```
sRGB pixel → linearize (gamma 2.4) → CIE XYZ (D65) → CIELAB → Euclidean distance
```

50 pigments precomputed to Lab at module init. Top 3 returned with ∆E distances. `≈` marker shown when best-match ∆E > 10.

### CDN Resilience

Chinese users face unreliable access to `unpkg.com`. The importmap falls through a tested CDN chain. A **non-module fallback `<script>`** hides the loading screen after 3.5s even if the ES module fails entirely, preventing permanent loading hangs.

---

## Challenges & Solutions

### 1. iOS Safari Loading Failures

**Symptom:** Page stuck at loading screen, no JS error. **Root cause:** ES module import failure (CDN blocked/broken) or module-level JS error prevents the `setTimeout` that hides the loading screen from ever firing.

**Fix:** Two-pronged:
- Non-module fallback script with 3.5s timeout always runs, regardless of module state
- CDN selection prioritized for Chinese accessibility (npmmirror as primary, jsDelivr as fallback)
- Diagnostic `window.__pe_loaded` flag to distinguish CDN failure from JS error

### 2. Module Crash from Orphan GLSL

After deleting WARM and TOON modes, the following 6 lines of GLSL survived between functions without a wrapper:

```glsl
vec4 c=texture2D(t,uv);
float warmth=c.r-c.b;
float w=smoothstep(-.08*r/10.,.08*r/10.,warmth);
vec4 wc=vec4(c.r,c.g*.55,c.b*.15,1.);
vec4 cc=vec4(c.r*.3,c.g*.65,c.b,1.);
return mix(cc,wc,w);
```

`return` at GLSL top-level → compile error → black screen. Keyword grep for `warm` found nothing (match was by substring, not variable name). **Lesson:** after shader edits, grep for bare `return` and verify every one is inside a function scope.

### 3. Mobile Click Event Suppression

Canvas `touchstart` with `e.preventDefault()` + `{passive:false}` suppresses synthetic `click` events on iOS Safari and Android Chrome. Document-level click listeners never fire for canvas taps.

**Fix:** Register BOTH `touchend` (mobile) and `click` (desktop) listeners, with a `lastTouch` timestamp guard (500ms) to prevent double-firing on hybrid events.

### 4. Vertical Centering with Asymmetric Icon Sets

When left and right icon groups have different counts, flexbox-based centering displaces the shutter button.

**Fix:** CSS Grid with `grid-template-columns: 1fr auto 1fr`. Left and right columns share remaining space equally; center column (shutter) auto-sizes. Adding/removing icons never displaces the center.

### 5. `gl.readPixels` Unreliability

Browser inconsistencies in framebuffer state, device pixel ratio, and color space produce black/flickering/inaccurate pixel reads, especially on iOS.

**Fix:** Replaced ALL `gl.readPixels` calls with canvas 2D `drawImage` + `getImageData`. Used for both the palette dominant-color extraction (160px-wide downsampled canvas) and the eyedropper precise sampling (full-resolution canvas with coordinate scaling).

### 6. Patch-Induced Function Loss

A targeted `patch(old_string, new_string)` operation on a line containing both `sampleCI()` and `showCI()` functions inadvertently consumed the `function sampleCI(px,py){` declaration, leaving orphan executable code with an unmatched `}`. Node.js `--check` now runs before every push as a syntax guard.

---

## File Structure

```
~/Documents/github/deepseek/painting-eye.html   ← development copy
~/Documents/github/yushihu/                      ← GitHub repo (fisherv2023/yushihu)
├── painting-eye.html                            ← deployed
├── manifest.json                                ← PWA
├── service-worker.js                            ← offline cache
└── painting-eye-icon.svg                        ← app icon
```

## Deployment

```bash
cp ~/Documents/github/deepseek/painting-eye.html ~/Documents/github/yushihu/
cd ~/Documents/github/yushihu
git add painting-eye.html && git commit -m "..." && git push origin main
```

GitHub Pages serves from `main` branch root. No build step.

// 极简 .splat 加载器（antimatter15 / mkkellogg 通用的 32 字节/点格式，无额外依赖，用核心 three.js 渲染）。
// 每点 32 字节（little-endian）：位置 3×float32 + 尺度 3×float32（线性 std-dev）+ RGBA 4×uint8 + 四元数 4×uint8(w,x,y,z)。
// 渲染：每点画成面向相机的软圆点（高斯衰减），颜色 / 不透明度 / 尺寸按点取。接口与 GLTFLoader/OBJLoader 同构。
// 注意：.spz / .ksplat 是压缩/私有格式，需要各自的解码器，这里不处理（由调用方给出清晰报错）。
export class SplatLoader {
  constructor(THREE) { this.THREE = THREE; this.manager = null; this.resourcePath = ''; }

  load(url, onLoad, onProgress, onError) {
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then((buf) => onLoad(this.parse(buf)))
      .catch((e) => { if (onError) onError(e); else { try { console.error('[SplatLoader]', e); } catch (_) {} } });
  }

  parse(buffer) {
    const THREE = this.THREE;
    const n = Math.floor(buffer.byteLength / 32);
    if (!n) throw new Error('empty or invalid .splat file');
    const dv = new DataView(buffer);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), alp = new Float32Array(n), scl = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 32;
      pos[i * 3] = dv.getFloat32(o, true); pos[i * 3 + 1] = dv.getFloat32(o + 4, true); pos[i * 3 + 2] = dv.getFloat32(o + 8, true);
      // .splat 里存的是线性尺度（各轴 std-dev）；点渲染用三轴均值，忽略旋转
      const sx = Math.abs(dv.getFloat32(o + 12, true)), sy = Math.abs(dv.getFloat32(o + 16, true)), sz = Math.abs(dv.getFloat32(o + 20, true));
      scl[i] = Math.max(1e-5, (sx + sy + sz) / 3);
      col[i * 3] = dv.getUint8(o + 24) / 255; col[i * 3 + 1] = dv.getUint8(o + 25) / 255; col[i * 3 + 2] = dv.getUint8(o + 26) / 255;
      alp[i] = dv.getUint8(o + 27) / 255;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alp, 1));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scl, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uHalfH: { value: 300 }, uFocalY: { value: 1.3 } },
      vertexShader: [
        'attribute vec3 aColor;',
        'attribute float aAlpha;',
        'attribute float aScale;',
        'uniform float uHalfH;',
        'uniform float uFocalY;',
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'void main() {',
        '  vColor = aColor; vAlpha = aAlpha;',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  gl_Position = projectionMatrix * mv;',
        '  gl_PointSize = max(1.0, aScale * uFocalY * uHalfH / max(0.001, -mv.z));',
        '}',
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'void main() {',
        '  vec2 d = gl_PointCoord - vec2(0.5);',
        '  float a = exp(-dot(d, d) * 10.0) * vAlpha;',
        '  if (a < 0.02) discard;',
        '  gl_FragColor = vec4(vColor, a);',
        '}',
      ].join('\n'),
    });
    const size2 = new THREE.Vector2();
    const points = new THREE.Points(geo, mat);
    points.onBeforeRender = (renderer, scene, camera) => {
      try {
        renderer.getSize(size2);
        mat.uniforms.uHalfH.value = Math.max(1, size2.y) * 0.5;
        mat.uniforms.uFocalY.value = Math.abs(camera.projectionMatrix.elements[5]) || 1.3;
      } catch (_) {}
    };
    points.userData.ezSplatCount = n;
    return points;
  }
}

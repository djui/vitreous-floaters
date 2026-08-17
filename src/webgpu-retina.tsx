"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- WebGPU is not included in this project's DOM type library yet. */

import { useEffect, useRef } from "react";

export type WebGPUStatus = "checking" | "ready" | "unsupported" | "error";
export type Gaze = { x: number; y: number };

type FiberShape = {
  anchors: [number, number][];
  depth: number;
  opacity: number;
};

const FIBER_SHAPES: FiberShape[] = [
  {
    anchors: [[-.12,.29],[.03,.25],[.14,.33],[.25,.19],[.37,.34],[.5,.29],[.63,.2],[.76,.36],[.88,.25],[1.12,.31]],
    depth: 1.08,
    opacity: .88,
  },
  {
    anchors: [[.06,.67],[.16,.46],[.28,.51],[.33,.67],[.27,.73],[.38,.77],[.44,.91]],
    depth: .82,
    opacity: .58,
  },
  {
    anchors: [[.49,.68],[.57,.49],[.67,.45],[.72,.61],[.62,.67],[.58,.55],[.69,.49],[.81,.72]],
    depth: 1.22,
    opacity: .70,
  },
  {
    anchors: [[.68,.83],[.78,.67],[.87,.76],[.8,.79],[.86,.68],[1.09,.7]],
    depth: .68,
    opacity: .46,
  },
  {
    anchors: [[-.1,.78],[.04,.63],[.17,.81],[.27,.68],[.39,.94]],
    depth: .96,
    opacity: .50,
  },
  {
    anchors: [[.36,.18],[.45,.08],[.56,.14],[.61,.28],[.53,.3],[.51,.2],[.66,.18]],
    depth: .55,
    opacity: .39,
  },
  {
    anchors: [[.16,.39],[.23,.34],[.31,.4],[.27,.48],[.19,.45],[.23,.36],[.38,.4]],
    depth: 1.38,
    opacity: .44,
  },
  {
    anchors: [[-.08,.52],[.06,.57],[.17,.49],[.29,.58],[.42,.47],[.55,.56],[.68,.48],[.82,.59],[1.08,.52]],
    depth: 1.16,
    opacity: .48,
  },
  {
    anchors: [[.74,.05],[.82,.16],[.79,.28],[.88,.36],[.94,.29],[.89,.18],[.98,.11]],
    depth: .76,
    opacity: .45,
  },
  {
    anchors: [[.43,.9],[.52,.8],[.63,.86],[.73,.74],[.85,.82],[.97,.72],[1.08,.78]],
    depth: 1.31,
    opacity: .42,
  },
  {
    anchors: [[-.03,.16],[.08,.1],[.19,.17],[.23,.29],[.14,.34],[.07,.25],[.18,.2],[.31,.24]],
    depth: .61,
    opacity: .40,
  },
];

const FIBER_SCALE = .84;
const FIBER_LAYOUT_OFFSETS: Gaze[] = [
  { x: 0, y: -.055 },
  { x: -.04, y: .025 },
  { x: .045, y: -.025 },
  { x: .045, y: .045 },
  { x: -.045, y: .055 },
  { x: .01, y: -.05 },
  { x: -.04, y: -.015 },
  { x: 0, y: .05 },
  { x: .045, y: -.045 },
  { x: .02, y: .05 },
  { x: -.04, y: -.04 },
];

const SIMULATION_SHADER = /* wgsl */ `
struct Node {
  pos: vec2f,
  previous: vec2f,
  rest: vec2f,
  props: vec2f,
  topology: vec4f,
}

struct SimUniforms {
  dt: f32,
  time: f32,
  stillness: f32,
  gravity: f32,
  gaze_delta: vec2f,
  phone_motion: vec2f,
  resolution: vec2f,
  field_offset: vec2f,
}

@group(0) @binding(0) var<storage, read> source_nodes: array<Node>;
@group(0) @binding(1) var<storage, read_write> target_nodes: array<Node>;
@group(0) @binding(2) var<uniform> sim: SimUniforms;

fn wrap_shift(anchor: vec2f) -> vec2f {
  var shift = vec2f(0.0);
  if (anchor.x < -0.42) { shift.x = 1.84; }
  if (anchor.x > 1.42) { shift.x = -1.84; }
  if (anchor.y < -0.42) { shift.y = 1.84; }
  if (anchor.y > 1.42) { shift.y = -1.84; }
  return shift;
}

fn distance_correction(position: vec2f, neighbor: vec2f, rest_length: f32, stiffness: f32) -> vec2f {
  let delta = neighbor - position;
  let delta_length = max(length(delta), 0.00001);
  return delta * ((delta_length - rest_length) / delta_length) * stiffness;
}

@compute @workgroup_size(64)
fn integrate(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= arrayLength(&source_nodes)) { return; }
  let node = source_nodes[index];
  let depth = node.props.x;
  let seed = node.topology.w;
  let local = u32(node.topology.y + 0.5);
  let count = u32(node.topology.z + 0.5);
  let frame_damping = pow(mix(0.958, 0.89, smoothstep(0.7, 3.2, sim.stillness)), sim.dt * 60.0);
  let velocity = (node.pos - node.previous) * frame_damping;
  let flow_phase = sim.time * (0.19 + seed * 0.017) + seed * 2.73;
  let flow = vec2f(
    cos(flow_phase + node.pos.y * 8.0) + sin(flow_phase * 0.57 + node.pos.x * 11.0) * 0.45,
    sin(flow_phase * 0.83 + node.pos.x * 7.0) + cos(flow_phase * 0.49 + node.pos.y * 9.0) * 0.38
  );
  let eye_impulse = sim.gaze_delta * mix(0.34, 0.66, clamp(depth / 1.4, 0.0, 1.0));
  let phone_acceleration = sim.phone_motion * (0.065 + depth * 0.025);
  let settling = vec2f(0.0, sim.gravity * mix(0.7, 1.35, depth));
  var rest_tangent = vec2f(1.0, 0.0);
  if (local > 0u && local + 1u < count) {
    rest_tangent = source_nodes[index + 1u].rest - source_nodes[index - 1u].rest;
  } else if (local + 1u < count) {
    rest_tangent = source_nodes[index + 1u].rest - node.rest;
  } else if (local > 0u) {
    rest_tangent = node.rest - source_nodes[index - 1u].rest;
  }
  let rest_normal = normalize(vec2f(-rest_tangent.y, rest_tangent.x));
  let along = f32(local) / max(f32(count - 1u), 1.0);
  let shape_phase = sim.time * (0.16 + fract(seed * 0.137) * 0.09) + seed * 1.41;
  let shape_wave = sin(shape_phase + along * 6.28318) * 0.72 +
    sin(shape_phase * 0.61 - along * 12.56636) * 0.28;
  let shape_envelope = sin(along * 3.14159);
  let shape_force = rest_normal * shape_wave * shape_envelope * (0.045 + depth * 0.015);
  var next_position = node.pos + velocity + eye_impulse;
  next_position += (flow * 0.012 + shape_force + phone_acceleration + settling) * sim.dt * sim.dt;
  let start = u32(node.topology.x + 0.5);
  let shift = wrap_shift(source_nodes[start].pos);
  var output_node = node;
  output_node.previous = node.pos + shift;
  output_node.pos = next_position + shift;
  target_nodes[index] = output_node;
}

@compute @workgroup_size(64)
fn constrain(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= arrayLength(&source_nodes)) { return; }
  let node = source_nodes[index];
  let start = u32(node.topology.x + 0.5);
  let local = u32(node.topology.y + 0.5);
  let count = u32(node.topology.z + 0.5);
  var correction = vec2f(0.0);
  var weight = 0.0;

  if (local > 0u) {
    let neighbor = source_nodes[index - 1u];
    correction += distance_correction(node.pos, neighbor.pos, distance(node.rest, neighbor.rest), 0.48);
    weight += 1.0;
  }
  if (local + 1u < count) {
    let neighbor = source_nodes[index + 1u];
    correction += distance_correction(node.pos, neighbor.pos, distance(node.rest, neighbor.rest), 0.48);
    weight += 1.0;
  }
  if (local > 1u) {
    let neighbor = source_nodes[index - 2u];
    correction += distance_correction(node.pos, neighbor.pos, distance(node.rest, neighbor.rest), 0.105);
    weight += 0.45;
  }
  if (local + 2u < count) {
    let neighbor = source_nodes[index + 2u];
    correction += distance_correction(node.pos, neighbor.pos, distance(node.rest, neighbor.rest), 0.105);
    weight += 0.45;
  }

  var output_node = node;
  output_node.pos = node.pos + correction / max(weight, 1.0);
  let shift = wrap_shift(source_nodes[start].pos);
  output_node.pos += shift;
  output_node.previous += shift;
  target_nodes[index] = output_node;
}
`;

const FIBER_SHADER = /* wgsl */ `
struct Node {
  pos: vec2f,
  previous: vec2f,
  rest: vec2f,
  props: vec2f,
  topology: vec4f,
}

struct RenderUniforms {
  resolution: vec2f,
  time: f32,
  pressure: f32,
  field_offset: vec2f,
  motion_energy: f32,
  quality: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) side: f32,
  @location(1) alpha: f32,
  @location(2) valid: f32,
  @location(3) proximity: f32,
}

@group(0) @binding(0) var<storage, read> nodes: array<Node>;
@group(0) @binding(1) var<uniform> render: RenderUniforms;

@vertex
fn vertex_main(@builtin(vertex_index) vertex_index: u32, @builtin(instance_index) instance_index: u32) -> VertexOutput {
  let node = nodes[instance_index];
  let local = u32(node.topology.y + 0.5);
  let count = u32(node.topology.z + 0.5);
  let valid = select(0.0, 1.0, local + 1u < count);
  let next_index = min(instance_index + 1u, arrayLength(&nodes) - 1u);
  let next = nodes[next_index];
  let corners = array<vec2f, 6>(
    vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  let corner = corners[vertex_index];
  let delta_pixels = (next.pos - node.pos) * render.resolution;
  let tangent = delta_pixels / max(length(delta_pixels), 0.0001);
  let normal = vec2f(-tangent.y, tangent.x);
  let depth = node.props.x;
  let width_pixels = 1.7 + depth * 2.25;
  var uv = mix(node.pos, next.pos, corner.x);
  uv += normal * corner.y * width_pixels / render.resolution;
  var output: VertexOutput;
  output.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  output.side = corner.y;
  output.alpha = node.props.y;
  output.valid = valid;
  output.proximity = step(0.94, depth);
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let cross_section = exp(-input.side * input.side * 2.4);
  let mask = cross_section * input.alpha * input.valid * 1.16;
  return vec4f(mask * input.proximity, mask * (1.0 - input.proximity), 0.0, mask);
}
`;

const BLUR_SHADER = /* wgsl */ `
struct BlurUniforms {
  direction: vec2f,
  padding: vec2f,
}

struct FullscreenOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;
@group(0) @binding(2) var<uniform> blur: BlurUniforms;

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var output: FullscreenOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

@fragment
fn fragment_main(input: FullscreenOutput) -> @location(0) vec4f {
  // A dense Gaussian kernel keeps a defocused fibre continuous. The former
  // sparse, repeatedly applied kernel could expose its sample offsets as
  // several parallel ghost strands on high-contrast displays.
  // Linear filtering pairs adjacent Gaussian taps, reproducing a dense
  // 15-tap profile with only nine samples per axis.
  var color = textureSample(source_texture, linear_sampler, input.uv) * 0.1306646;
  color += textureSample(source_texture, linear_sampler, input.uv + blur.direction * 1.4610572) * 0.2301543;
  color += textureSample(source_texture, linear_sampler, input.uv - blur.direction * 1.4610572) * 0.2301543;
  color += textureSample(source_texture, linear_sampler, input.uv + blur.direction * 3.4099420) * 0.1386435;
  color += textureSample(source_texture, linear_sampler, input.uv - blur.direction * 3.4099420) * 0.1386435;
  color += textureSample(source_texture, linear_sampler, input.uv + blur.direction * 5.3607017) * 0.0556615;
  color += textureSample(source_texture, linear_sampler, input.uv - blur.direction * 5.3607017) * 0.0556615;
  color += textureSample(source_texture, linear_sampler, input.uv + blur.direction * 7.0) * 0.0102083;
  color += textureSample(source_texture, linear_sampler, input.uv - blur.direction * 7.0) * 0.0102083;
  return color;
}
`;

const SCENE_SHADER = /* wgsl */ `
struct RenderUniforms {
  resolution: vec2f,
  time: f32,
  pressure: f32,
  field_offset: vec2f,
  motion_energy: f32,
  quality: f32,
}

struct Particle {
  base: vec2f,
  radius: f32,
  phase: f32,
  speed: f32,
  warmth: f32,
  alpha: f32,
  depth: f32,
}

struct FullscreenOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

struct ParticleOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) parameters: vec4f,
}

@group(0) @binding(0) var<uniform> render: RenderUniforms;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

fn hash21(value: vec2f) -> f32 {
  let p = fract(value * vec2f(123.34, 456.21));
  return fract((p.x + p.y) * (p.x + p.y + 45.32));
}

fn lid_color(value: f32) -> vec3f {
  if (value < 0.24) { return mix(vec3f(0.28,0.72,0.86), vec3f(0.48,0.69,0.38), value / 0.24); }
  if (value < 0.44) { return mix(vec3f(0.48,0.69,0.38), vec3f(0.82,0.69,0.16), (value - 0.24) / 0.20); }
  if (value < 0.68) { return mix(vec3f(0.82,0.69,0.16), vec3f(0.92,0.31,0.045), (value - 0.44) / 0.24); }
  return mix(vec3f(0.92,0.31,0.045), vec3f(0.34,0.004,0.035), (value - 0.68) / 0.32);
}

@vertex
fn fullscreen_vertex(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var output: FullscreenOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

@fragment
fn background_fragment(input: FullscreenOutput) -> @location(0) vec4f {
  let pixel = input.uv * render.resolution + render.field_offset * 0.92;
  let fine_cell = floor(pixel / 1.55);
  let coarse_cell = floor(pixel / 4.1);
  let fine_phase = hash21(fine_cell) * 6.283185;
  let coarse_phase = hash21(coarse_cell + 71.3) * 6.283185;
  let fine_speed = mix(10.0, 29.0, hash21(fine_cell + 19.7));
  let fine = sin(render.time * fine_speed + fine_phase) * 0.62 + sin(render.time * fine_speed * 1.79 + fine_phase * 0.63) * 0.38;
  let coarse = sin(render.time * mix(5.0, 15.0, hash21(coarse_cell + 8.4)) + coarse_phase);
  let fixed_grain = hash21(fine_cell + 4.8) - 0.5;
  let dream = sin(pixel.x * 0.0041 + render.time * 0.19) * sin(pixel.y * 0.0034 - render.time * 0.13);
  let base = lid_color(render.pressure);
  let vignette_distance = distance(input.uv, vec2f(0.48,0.44));
  let vignette = 1.0 - smoothstep(0.34, 0.86, vignette_distance) * (0.16 + render.pressure * 0.13);
  let scintillation = fine * 0.105 + coarse * 0.038 + fixed_grain * 0.075;
  var color = base * (vignette + scintillation);
  color += vec3f(0.12,0.055,0.025) * dream * 0.12;
  color += vec3f(0.13,0.09,0.035) * max(fine, 0.0) * 0.12;
  return vec4f(max(color, vec3f(0.0)), 1.0);
}

@vertex
fn particle_vertex(@builtin(vertex_index) vertex_index: u32, @builtin(instance_index) instance_index: u32) -> ParticleOutput {
  let particle = particles[instance_index];
  let corners = array<vec2f, 6>(
    vec2f(-1.0,-1.0), vec2f(1.0,-1.0), vec2f(-1.0,1.0),
    vec2f(-1.0,1.0), vec2f(1.0,-1.0), vec2f(1.0,1.0)
  );
  let corner = corners[vertex_index];
  let slow_drift = vec2f(
    sin(render.time * (0.17 + particle.depth * 0.08) + particle.phase * 1.7),
    cos(render.time * (0.13 + particle.depth * 0.06) + particle.phase * 1.13)
  ) * (0.00045 + particle.depth * 0.0005);
  let parallax = render.field_offset / render.resolution * mix(0.34, 1.0, particle.depth);
  let center = fract(particle.base + parallax + slow_drift);
  let breathing = 1.0 + sin(render.time * particle.speed * 0.31 + particle.phase) * 0.11;
  let radius = particle.radius * breathing;
  let uv = center + corner * radius / render.resolution;
  var output: ParticleOutput;
  output.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  output.local = corner;
  output.parameters = vec4f(particle.phase, particle.speed, particle.warmth, particle.alpha);
  return output;
}

@fragment
fn particle_fragment(input: ParticleOutput) -> @location(0) vec4f {
  let radius = length(input.local);
  if (radius > 1.0) { discard; }
  let falloff = exp(-radius * radius * 2.9) * (1.0 - smoothstep(0.72, 1.0, radius));
  let pulse = 0.68 + 0.32 * (sin(render.time * input.parameters.y + input.parameters.x) * 0.7 + sin(render.time * input.parameters.y * 1.91 + input.parameters.x * 0.57) * 0.3);
  let is_dark = step(input.parameters.z, 0.16);
  let cool = vec3f(0.72,0.9,1.0);
  let warm = vec3f(1.0,0.91,0.64);
  var color = mix(cool, warm, smoothstep(0.2, 1.0, input.parameters.z));
  color = mix(color, vec3f(0.055,0.018,0.055), is_dark);
  let alpha = input.parameters.w * pulse * falloff * mix(1.0, 0.72, is_dark);
  return vec4f(color, alpha);
}
`;

const COMPOSITE_SHADER = /* wgsl */ `
struct RenderUniforms {
  resolution: vec2f,
  time: f32,
  pressure: f32,
  field_offset: vec2f,
  motion_energy: f32,
  quality: f32,
}

struct FullscreenOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var scene_texture: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;
@group(0) @binding(2) var near_shadow: texture_2d<f32>;
@group(0) @binding(3) var far_shadow: texture_2d<f32>;
@group(0) @binding(4) var<uniform> render: RenderUniforms;
@group(0) @binding(5) var halo_shadow: texture_2d<f32>;

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var output: FullscreenOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

@fragment
fn fragment_main(input: FullscreenOutput) -> @location(0) vec4f {
  let near_sample = textureSample(near_shadow, linear_sampler, input.uv).r;
  let far_sample = textureSample(far_shadow, linear_sampler, input.uv).g;
  let halo_sample = textureSample(halo_shadow, linear_sampler, input.uv);
  let optical_shadow = near_sample + far_sample;
  let broad_halo = halo_sample.r + halo_sample.g;
  var scene = textureSample(scene_texture, linear_sampler, input.uv).rgb;
  let shadow = smoothstep(0.008, 0.82, optical_shadow) * (0.82 + render.pressure * 0.05);
  scene *= 1.0 - shadow;
  // A difference of Gaussians creates one centred phase-contrast rim: the
  // broad field survives just outside the narrower dark shadow, while the
  // dark centre suppresses any white duplicate on top of the fibre.
  let rim_signal = max(broad_halo * 1.35 - optical_shadow * 0.82, 0.0) *
    (1.0 - smoothstep(0.06, 0.30, optical_shadow));
  let inverted_rim = smoothstep(0.008, 0.16, rim_signal) * 0.34;
  scene = mix(scene, vec3f(1.0, 0.985, 0.92), inverted_rim);
  let dream_bloom = pow(max(max(scene.r, scene.g), scene.b), 2.0) * 0.025;
  return vec4f(scene + dream_bloom, 1.0);
}
`;

function catmullRom(points: [number, number][], t: number): Gaze {
  const scaled = t * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const p0 = points[Math.max(0, index - 1)];
  const p1 = points[index];
  const p2 = points[Math.min(points.length - 1, index + 1)];
  const p3 = points[Math.min(points.length - 1, index + 2)];
  const sample = (axis: 0 | 1) => .5 * (
    2 * p1[axis] +
    (-p0[axis] + p2[axis]) * local +
    (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * local * local +
    (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * local * local * local
  );
  return { x: sample(0), y: sample(1) };
}

function createNodeData() {
  const stride = 12;
  const nodesPerFiber = 30;
  const data = new Float32Array(FIBER_SHAPES.length * nodesPerFiber * stride);
  let nodeIndex = 0;
  FIBER_SHAPES.forEach((fiber, fiberIndex) => {
    const center = fiber.anchors.reduce(
      (total, [x, y]) => ({ x: total.x + x, y: total.y + y }),
      { x: 0, y: 0 },
    );
    center.x /= fiber.anchors.length;
    center.y /= fiber.anchors.length;
    const layout = FIBER_LAYOUT_OFFSETS[fiberIndex];
    const anchors = fiber.anchors.map(([x, y]) => [
      center.x + (x - center.x) * FIBER_SCALE + layout.x,
      center.y + (y - center.y) * FIBER_SCALE + layout.y,
    ] as [number, number]);
    const start = nodeIndex;
    for (let local = 0; local < nodesPerFiber; local += 1) {
      const point = catmullRom(anchors, local / (nodesPerFiber - 1));
      const offset = nodeIndex * stride;
      data[offset] = point.x;
      data[offset + 1] = point.y;
      data[offset + 2] = point.x;
      data[offset + 3] = point.y;
      data[offset + 4] = point.x;
      data[offset + 5] = point.y;
      data[offset + 6] = fiber.depth;
      data[offset + 7] = fiber.opacity;
      data[offset + 8] = start;
      data[offset + 9] = local;
      data[offset + 10] = nodesPerFiber;
      data[offset + 11] = fiberIndex * 1.73 + .37;
      nodeIndex += 1;
    }
  });
  return { data, count: nodeIndex };
}

function createParticleData(count: number) {
  const stride = 8;
  const data = new Float32Array(count * stride);
  for (let index = 0; index < count; index += 1) {
    const offset = index * stride;
    const rare = Math.random() > .91;
    data[offset] = Math.random();
    data[offset + 1] = Math.random();
    data[offset + 2] = rare ? 3.4 + Math.random() * 3.8 : .75 + Math.random() * 2.45;
    data[offset + 3] = Math.random() * Math.PI * 2;
    data[offset + 4] = 5.5 + Math.random() * 19;
    data[offset + 5] = Math.random();
    data[offset + 6] = rare ? .22 + Math.random() * .22 : .08 + Math.random() * .21;
    data[offset + 7] = .24 + Math.random() * .76;
  }
  return data;
}

export function WebGPURetina({
  pressureRef,
  gazeRef,
  cameraTrackingRef,
  motionRef,
  motionActiveRef,
  gestureRef,
  onStatus,
}: {
  pressureRef: React.MutableRefObject<number>;
  gazeRef: React.MutableRefObject<Gaze>;
  cameraTrackingRef: React.MutableRefObject<boolean>;
  motionRef: React.MutableRefObject<Gaze>;
  motionActiveRef: React.MutableRefObject<boolean>;
  gestureRef: React.MutableRefObject<Gaze>;
  onStatus: (status: WebGPUStatus) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let animationFrame = 0;
    let resizeHandler: (() => void) | null = null;
    let destroyTextures: (() => void) | null = null;
    const destroyables: Array<{ destroy?: () => void }> = [];

    onStatus("checking");

    const initialize = async () => {
      const gpu = (navigator as Navigator & { gpu?: any }).gpu;
      if (!gpu) {
        onStatus("unsupported");
        return;
      }
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) {
        onStatus("unsupported");
        return;
      }
      const device = await adapter.requestDevice();
      if (disposed) {
        device.destroy?.();
        return;
      }
      const gpuContext = (canvas as any).getContext("webgpu") as any;
      if (!gpuContext) {
        onStatus("unsupported");
        return;
      }
      const format = gpu.getPreferredCanvasFormat();
      const BufferUsage = (globalThis as any).GPUBufferUsage;
      const TextureUsage = (globalThis as any).GPUTextureUsage;
      const nodes = createNodeData();
      const isMobile = navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
      const particleCount = isMobile ? 3200 : 5200;

      device.pushErrorScope("validation");
      const simulationModule = device.createShaderModule({ code: SIMULATION_SHADER });
      const fiberModule = device.createShaderModule({ code: FIBER_SHADER });
      const blurModule = device.createShaderModule({ code: BLUR_SHADER });
      const sceneModule = device.createShaderModule({ code: SCENE_SHADER });
      const compositeModule = device.createShaderModule({ code: COMPOSITE_SHADER });
      const modules = [simulationModule, fiberModule, blurModule, sceneModule, compositeModule];
      for (const shaderModule of modules) {
        const info = await shaderModule.getCompilationInfo();
        const errors = info.messages.filter((message: any) => message.type === "error");
        if (errors.length) throw new Error(errors.map((error: any) => error.message).join("\n"));
      }

      const integratePipeline = device.createComputePipeline({ layout: "auto", compute: { module: simulationModule, entryPoint: "integrate" } });
      const constraintPipeline = device.createComputePipeline({ layout: "auto", compute: { module: simulationModule, entryPoint: "constrain" } });
      const fiberPipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: fiberModule, entryPoint: "vertex_main" },
        fragment: {
          module: fiberModule,
          entryPoint: "fragment_main",
          targets: [{
            format: "rgba8unorm",
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            },
          }],
        },
        primitive: { topology: "triangle-list" },
      });
      const blurPipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: blurModule, entryPoint: "vertex_main" },
        fragment: { module: blurModule, entryPoint: "fragment_main", targets: [{ format: "rgba8unorm" }] },
        primitive: { topology: "triangle-list" },
      });
      const backgroundPipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: sceneModule, entryPoint: "fullscreen_vertex" },
        fragment: { module: sceneModule, entryPoint: "background_fragment", targets: [{ format: "rgba8unorm" }] },
        primitive: { topology: "triangle-list" },
      });
      const particlePipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: sceneModule, entryPoint: "particle_vertex" },
        fragment: {
          module: sceneModule,
          entryPoint: "particle_fragment",
          targets: [{
            format: "rgba8unorm",
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          }],
        },
        primitive: { topology: "triangle-list" },
      });
      const compositePipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: compositeModule, entryPoint: "vertex_main" },
        fragment: { module: compositeModule, entryPoint: "fragment_main", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      const pipelineError = await device.popErrorScope();
      if (pipelineError) throw new Error(pipelineError.message);

      const createStorageBuffer = (contents: Float32Array) => {
        const buffer = device.createBuffer({
          size: Math.ceil(contents.byteLength / 4) * 4,
          usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(buffer.getMappedRange()).set(contents);
        buffer.unmap();
        destroyables.push(buffer);
        return buffer;
      };
      const nodeBuffers = [createStorageBuffer(nodes.data), createStorageBuffer(nodes.data)];
      const particleBuffer = createStorageBuffer(createParticleData(particleCount));
      const simulationUniform = device.createBuffer({ size: 48, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const renderUniform = device.createBuffer({ size: 32, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const nearBlurHorizontalUniform = device.createBuffer({ size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const nearBlurVerticalUniform = device.createBuffer({ size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const farBlurHorizontalUniform = device.createBuffer({ size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const farBlurVerticalUniform = device.createBuffer({ size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const haloBlurHorizontalUniform = device.createBuffer({ size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const haloBlurVerticalUniform = device.createBuffer({ size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      destroyables.push(
        simulationUniform,
        renderUniform,
        nearBlurHorizontalUniform,
        nearBlurVerticalUniform,
        farBlurHorizontalUniform,
        farBlurVerticalUniform,
        haloBlurHorizontalUniform,
        haloBlurVerticalUniform,
      );

      const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
      const computeBindGroups = [0, 1].map((sourceIndex) => ({
        integrate: device.createBindGroup({
          layout: integratePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: nodeBuffers[sourceIndex] } },
            { binding: 1, resource: { buffer: nodeBuffers[1 - sourceIndex] } },
            { binding: 2, resource: { buffer: simulationUniform } },
          ],
        }),
        constrain: device.createBindGroup({
          layout: constraintPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: nodeBuffers[sourceIndex] } },
            { binding: 1, resource: { buffer: nodeBuffers[1 - sourceIndex] } },
            { binding: 2, resource: { buffer: simulationUniform } },
          ],
        }),
      }));
      const fiberBindGroups = nodeBuffers.map((buffer) => device.createBindGroup({
        layout: fiberPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: { buffer: renderUniform } },
        ],
      }));
      const backgroundBindGroup = device.createBindGroup({
        layout: backgroundPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: renderUniform } },
        ],
      });
      const particleBindGroup = device.createBindGroup({
        layout: particlePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: renderUniform } },
          { binding: 1, resource: { buffer: particleBuffer } },
        ],
      });

      let textures: any = null;
      let width = 1;
      let height = 1;
      const createTexture = (textureWidth: number, textureHeight: number, textureFormat = "rgba8unorm") => {
        const texture = device.createTexture({
          size: [textureWidth, textureHeight],
          format: textureFormat,
          usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
        });
        return texture;
      };
      const resize = () => {
        const bounds = canvas.getBoundingClientRect();
        const pixelRatio = isMobile ? Math.min(window.devicePixelRatio || 1, 1.0) : Math.min(window.devicePixelRatio || 1, 1.25);
        width = Math.max(1, Math.floor(bounds.width * pixelRatio));
        height = Math.max(1, Math.floor(bounds.height * pixelRatio));
        if (canvas.width === width && canvas.height === height && textures) return;
        canvas.width = width;
        canvas.height = height;
        gpuContext.configure({ device, format, alphaMode: "opaque" });
        destroyTextures?.();
        const blurScale = isMobile ? .46 : .54;
        const blurWidth = Math.max(2, Math.floor(width * blurScale));
        const blurHeight = Math.max(2, Math.floor(height * blurScale));
        const scene = createTexture(width, height);
        const core = createTexture(blurWidth, blurHeight);
        const temp = createTexture(blurWidth, blurHeight);
        const near = createTexture(blurWidth, blurHeight);
        const far = createTexture(blurWidth, blurHeight);
        const halo = createTexture(blurWidth, blurHeight);
        const nearSampleStep = isMobile ? 1.18 : 1.3;
        const farSampleStep = isMobile ? 1.7 : 1.9;
        const haloSampleStep = isMobile ? 2.35 : 2.6;
        device.queue.writeBuffer(nearBlurHorizontalUniform, 0, new Float32Array([nearSampleStep / blurWidth, 0, 0, 0]));
        device.queue.writeBuffer(nearBlurVerticalUniform, 0, new Float32Array([0, nearSampleStep / blurHeight, 0, 0]));
        device.queue.writeBuffer(farBlurHorizontalUniform, 0, new Float32Array([farSampleStep / blurWidth, 0, 0, 0]));
        device.queue.writeBuffer(farBlurVerticalUniform, 0, new Float32Array([0, farSampleStep / blurHeight, 0, 0]));
        device.queue.writeBuffer(haloBlurHorizontalUniform, 0, new Float32Array([haloSampleStep / blurWidth, 0, 0, 0]));
        device.queue.writeBuffer(haloBlurVerticalUniform, 0, new Float32Array([0, haloSampleStep / blurHeight, 0, 0]));
        const blurBindGroup = (source: any, uniform: any) => device.createBindGroup({
          layout: blurPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: source.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: uniform } },
          ],
        });
        const finalBindGroup = device.createBindGroup({
          layout: compositePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: scene.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: near.createView() },
            { binding: 3, resource: far.createView() },
            { binding: 4, resource: { buffer: renderUniform } },
            { binding: 5, resource: halo.createView() },
          ],
        });
        textures = {
          scene, core, temp, near, far, halo, finalBindGroup,
          blurCoreNearH: blurBindGroup(core, nearBlurHorizontalUniform),
          blurTempNearV: blurBindGroup(temp, nearBlurVerticalUniform),
          blurCoreFarH: blurBindGroup(core, farBlurHorizontalUniform),
          blurTempFarV: blurBindGroup(temp, farBlurVerticalUniform),
          blurCoreHaloH: blurBindGroup(core, haloBlurHorizontalUniform),
          blurTempHaloV: blurBindGroup(temp, haloBlurVerticalUniform),
        };
        destroyTextures = () => {
          if (!textures) return;
          [textures.scene, textures.core, textures.temp, textures.near, textures.far, textures.halo].forEach((texture: any) => texture.destroy());
          textures = null;
        };
      };
      resizeHandler = resize;
      window.addEventListener("resize", resize);
      resize();

      let stateIndex = 0;
      let previousTime = performance.now();
      let previousGaze: Gaze = { x: .5, y: .48 };
      const gaze: Gaze = { ...previousGaze };
      let simulatedTarget: Gaze = { ...gaze };
      let simulatedHolding = true;
      let simulatedDirection: -1 | 1 = -1;
      let nextGazeChange = previousTime + 1100;
      let lastMovement = previousTime;
      let previousMotion: Gaze = { x: 0, y: 0 };
      const fieldOffset: Gaze = { x: 0, y: 0 };
      const fieldVelocity: Gaze = { x: 0, y: 0 };

      const simulateGaze = (time: number, dt: number) => {
        if (time >= nextGazeChange) {
          if (!simulatedHolding) {
            simulatedHolding = true;
            simulatedTarget = { ...gaze };
            nextGazeChange = time + 1050 + Math.random() * 1900;
          } else {
            simulatedHolding = false;
            const reach = Math.random() < .16 ? .17 : .075;
            simulatedTarget = {
              x: Math.max(.15, Math.min(.85, gaze.x + (Math.random() - .5) * reach)),
              y: Math.max(.18, Math.min(.82, gaze.y + simulatedDirection * (.025 + Math.random() * reach * .48))),
            };
            simulatedDirection = simulatedDirection === -1 ? 1 : -1;
            nextGazeChange = time + 520 + Math.random() * 690;
          }
        }
        if (!simulatedHolding) {
          const easing = 1 - Math.exp(-dt * 4.8);
          gaze.x += (simulatedTarget.x - gaze.x) * easing;
          gaze.y += (simulatedTarget.y - gaze.y) * easing;
        }
      };

      const blurPass = (encoder: any, destination: any, bindGroup: any) => {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: destination.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
        });
        pass.setPipeline(blurPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
      };

      const frame = (time: number) => {
        if (disposed || !textures) return;
        animationFrame = requestAnimationFrame(frame);
        const dt = Math.min(.033, Math.max(.001, (time - previousTime) / 1000));
        previousTime = time;
        if (cameraTrackingRef.current) {
          const target = gazeRef.current;
          const easing = 1 - Math.exp(-dt * 7.2);
          gaze.x += (target.x - gaze.x) * easing;
          gaze.y += (target.y - gaze.y) * easing;
        } else {
          simulateGaze(time, dt);
        }
        const gazeDelta = { x: gaze.x - previousGaze.x, y: gaze.y - previousGaze.y };
        previousGaze = { ...gaze };
        const gesture = gestureRef.current;
        const inputDelta = { x: gazeDelta.x + gesture.x, y: gazeDelta.y + gesture.y };
        const gestureDecay = Math.exp(-dt * 13);
        gestureRef.current = { x: gesture.x * gestureDecay, y: gesture.y * gestureDecay };
        const phoneMotion = motionActiveRef.current ? motionRef.current : { x: 0, y: 0 };
        const motionDelta = { x: phoneMotion.x - previousMotion.x, y: phoneMotion.y - previousMotion.y };
        previousMotion = { ...phoneMotion };
        const motionEnergy = Math.min(1, Math.hypot(inputDelta.x * 20, inputDelta.y * 20) + Math.hypot(motionDelta.x, motionDelta.y));
        if (Math.hypot(inputDelta.x, inputDelta.y) > .00012 || Math.hypot(motionDelta.x, motionDelta.y) > .008) lastMovement = time;
        const stillness = Math.max(0, (time - lastMovement) / 1000);
        const damping = Math.exp(-dt * (stillness > .8 ? 3.2 : 2.25));
        fieldVelocity.x = fieldVelocity.x * damping + inputDelta.x * width * 2.7 + motionDelta.x * 28 + phoneMotion.x * dt * 14;
        fieldVelocity.y = fieldVelocity.y * damping + inputDelta.y * height * 2.7 + motionDelta.y * 28 + phoneMotion.y * dt * 14;
        const fieldSpeed = Math.hypot(fieldVelocity.x, fieldVelocity.y);
        const maxFieldSpeed = Math.max(70, Math.min(135, width * .1));
        if (fieldSpeed > maxFieldSpeed) {
          const scale = maxFieldSpeed / fieldSpeed;
          fieldVelocity.x *= scale;
          fieldVelocity.y *= scale;
        }
        const quietDrift = {
          x: Math.sin(time * .00029 + .8) * 3.2 + Math.sin(time * .00071 + 2.2) * 1.8,
          y: Math.cos(time * .00023 + 1.7) * 2.8 + Math.sin(time * .00059 + .3) * 1.6,
        };
        fieldOffset.x += (fieldVelocity.x + quietDrift.x) * dt;
        fieldOffset.y += (fieldVelocity.y + quietDrift.y) * dt;
        const gravity = stillness > .85 ? Math.min(.045, .008 + (stillness - .85) * .014) : 0;
        device.queue.writeBuffer(simulationUniform, 0, new Float32Array([
          dt, time / 1000, stillness, gravity,
          inputDelta.x, inputDelta.y, phoneMotion.x, phoneMotion.y,
          width, height, fieldOffset.x, fieldOffset.y,
        ]));
        device.queue.writeBuffer(renderUniform, 0, new Float32Array([
          width, height, time / 1000, pressureRef.current,
          fieldOffset.x, fieldOffset.y, motionEnergy, isMobile ? .72 : 1,
        ]));

        const encoder = device.createCommandEncoder();
        const compute = encoder.beginComputePass();
        compute.setPipeline(integratePipeline);
        compute.setBindGroup(0, computeBindGroups[stateIndex].integrate);
        compute.dispatchWorkgroups(Math.ceil(nodes.count / 64));
        stateIndex = 1 - stateIndex;
        for (let iteration = 0; iteration < 6; iteration += 1) {
          compute.setPipeline(constraintPipeline);
          compute.setBindGroup(0, computeBindGroups[stateIndex].constrain);
          compute.dispatchWorkgroups(Math.ceil(nodes.count / 64));
          stateIndex = 1 - stateIndex;
        }
        compute.end();

        const fiberPass = encoder.beginRenderPass({
          colorAttachments: [{ view: textures.core.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
        });
        fiberPass.setPipeline(fiberPipeline);
        fiberPass.setBindGroup(0, fiberBindGroups[stateIndex]);
        fiberPass.draw(6, nodes.count);
        fiberPass.end();
        blurPass(encoder, textures.temp, textures.blurCoreNearH);
        blurPass(encoder, textures.near, textures.blurTempNearV);
        blurPass(encoder, textures.temp, textures.blurCoreFarH);
        blurPass(encoder, textures.far, textures.blurTempFarV);
        blurPass(encoder, textures.temp, textures.blurCoreHaloH);
        blurPass(encoder, textures.halo, textures.blurTempHaloV);

        const scenePass = encoder.beginRenderPass({
          colorAttachments: [{ view: textures.scene.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        scenePass.setPipeline(backgroundPipeline);
        scenePass.setBindGroup(0, backgroundBindGroup);
        scenePass.draw(3);
        scenePass.setPipeline(particlePipeline);
        scenePass.setBindGroup(0, particleBindGroup);
        scenePass.draw(6, particleCount);
        scenePass.end();

        const finalPass = encoder.beginRenderPass({
          colorAttachments: [{ view: gpuContext.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        finalPass.setPipeline(compositePipeline);
        finalPass.setBindGroup(0, textures.finalBindGroup);
        finalPass.draw(3);
        finalPass.end();
        device.queue.submit([encoder.finish()]);
      };

      device.lost.then(() => {
        if (!disposed) onStatus("error");
      });
      onStatus("ready");
      animationFrame = requestAnimationFrame(frame);
    };

    initialize().catch(() => {
      if (!disposed) onStatus("error");
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      if (resizeHandler) window.removeEventListener("resize", resizeHandler);
      destroyTextures?.();
      destroyables.forEach((resource) => resource.destroy?.());
    };
  }, [cameraTrackingRef, gazeRef, gestureRef, motionActiveRef, motionRef, onStatus, pressureRef]);

  return (
    <canvas
      ref={canvasRef}
      className="retina-canvas"
      data-engine="webgpu"
      role="img"
      aria-label="A WebGPU simulation of retinal scintillation and physically constrained vitreous fibre shadows"
    />
  );
}
